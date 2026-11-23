/**
 * Price history and job store, on node:sqlite (built in, no native dep).
 *
 * History is keyed by (normalized query, site). Prices are compared per base
 * unit — ₹/kg, ₹/L, ₹/pc — and a result in a different unit family than the
 * one the history is in never becomes the low: ₹/L and ₹/kg share no scale.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './paths.js';
import { parsePack, matchConfidence, CONFIDENCE_THRESHOLD } from './normalize.js';
import { canonicalQuery, productsMatching } from './catalog.js';

// Canonical pack unit (normalize.js) -> [base unit, divisor, family].
const BASE_UNITS = {
  g: ['kg', 1000, 'mass'],
  ml: ['L', 1000, 'volume'],
  piece: ['pc', 1, 'count'],
};
const FAMILY_UNIT = { mass: 'kg', volume: 'L', count: 'pc' };

const round2 = (n) => Math.round(n * 100) / 100;
const EPSILON = 0.005; // half a paisa: equal after rounding to 2 dp

// Pack spellings folded into one form so "1 kg", "1kg" and "1 KG" share a history.
const UNIT_ALIASES = [
  [/^(kgs?|kilos?|kilograms?)$/, 'kg'],
  [/^(g|gm|gms|grams?)$/, 'g'],
  [/^(l|lt|ltrs?|litres?|liters?)$/, 'l'],
  [/^(ml|mls)$/, 'ml'],
  [/^(pcs?|pieces?)$/, 'pc'],
];

/**
 * The history key of a basket line. Synonyms fold to the catalogue's
 * canonical tag first (src/catalog.js), so "kismis", "kishmish" and
 * "raisins" share one history instead of three.
 */
export function normalizeQuery(query) {
  return canonicalQuery(String(query ?? '').toLowerCase().replace(/\s+/g, ' ').trim())
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(\d+(?:\.\d+)?)\s*([a-z]+)\b/g, (m, n, u) => {
      const hit = UNIT_ALIASES.find(([re]) => re.test(u));
      return hit ? `${n}${hit[1]}` : m;
    });
}

/** Per-base-unit price of a scored line's product, or null if not comparable. */
function unitPriceOf(product) {
  if (!product || !Number.isFinite(product.price)) return null;
  const base = BASE_UNITS[product.packUnit];
  const size = Number(product.packSize);
  if (!base || !(size > 0)) return null;
  const [unit, divisor, family] = base;
  return { unitPrice: product.price / (size / divisor), unit, family };
}

const JOB_FIELDS = {
  status: 'status',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  error: 'error',
  summary: 'summary',
};

export function openStore(file = join(DATA_DIR, 'basket.db')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      site TEXT NOT NULL,
      family TEXT NOT NULL,
      unit TEXT NOT NULL,
      unit_price REAL NOT NULL,
      price REAL NOT NULL,
      product TEXT,
      pack TEXT,
      seen_at TEXT NOT NULL,
      job_id INTEGER,
      trigger TEXT
    );
    CREATE INDEX IF NOT EXISTS prices_key ON prices (query, site, family, unit_price);
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      trigger TEXT NOT NULL,
      sites TEXT NOT NULL,
      items TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error TEXT,
      summary TEXT
    );
    CREATE TABLE IF NOT EXISTS fired (
      key TEXT PRIMARY KEY,
      fired_at TEXT NOT NULL
    );
  `);

  // v2 columns: enough to rebuild a product row for history-first search.
  const cols = new Set(db.prepare('PRAGMA table_info(prices)').all().map((c) => c.name));
  for (const [name, type] of [['pack_size', 'REAL'], ['pack_unit', 'TEXT'], ['mrp', 'REAL'], ['url', 'TEXT']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE prices ADD COLUMN ${name} ${type}`);
  }
  // Re-key rows written with an older normalizeQuery, and fold synonyms into
  // one product ("kismis" rows join "raisins"). Runs on open, so a catalogue
  // change takes effect on restart; new rows are written canonical already.
  function regroup() {
    let moved = 0;
    for (const { query } of db.prepare('SELECT DISTINCT query FROM prices').all()) {
      const key = normalizeQuery(query);
      if (key !== query) moved += Number(db.prepare('UPDATE prices SET query = ? WHERE query = ?').run(key, query).changes);
    }
    return moved;
  }
  const regrouped = regroup();
  if (regrouped) console.warn(`store: regrouped ${regrouped} saved price(s) under their product's canonical name`);
  // Drop rows an older, looser matcher accepted but the current one refuses
  // (e.g. "toor dal" saved as Moong Dal): they would show as false lows and
  // as the "previous record" in history-first search.
  const del = db.prepare('DELETE FROM prices WHERE query = ? AND product = ?');
  let pruned = 0;
  for (const { query, product } of db.prepare('SELECT DISTINCT query, product FROM prices WHERE product IS NOT NULL').all()) {
    const m = matchConfidence(query, { name: product });
    if (m.refused || m.score < CONFIDENCE_THRESHOLD) pruned += Number(del.run(query, product).changes);
  }
  if (pruned) console.warn(`store: removed ${pruned} saved price(s) that no longer match their item`);
  // Rows saved before the price check existed can carry wrong packs (₹79 for a
  // "500 g" butter that was 100 g). Compare each site's latest unit price with
  // the median across sites for the same item and drop what is far off, so a
  // bad row never shows as a "new low" or as a lookup rate.
  let outliers = 0;
  const bounds = { low: 0.4, high: 2.5 };
  for (const { query, family } of db.prepare('SELECT DISTINCT query, family FROM prices').all()) {
    const bySite = db.prepare('SELECT site, id, unit_price FROM prices WHERE query = ? AND family = ?').all(query, family);
    const sites = [...new Set(bySite.map((r) => r.site))];
    if (sites.length < 3) continue;
    const mids = sites.map((site) => {
      const v = bySite.filter((r) => r.site === site).map((r) => r.unit_price).sort((a, b) => a - b);
      return v[v.length >> 1];
    }).sort((a, b) => a - b);
    const mid = mids[mids.length >> 1];
    for (const r of bySite) {
      if (r.unit_price < mid * bounds.low || r.unit_price > mid * bounds.high) {
        outliers += Number(db.prepare('DELETE FROM prices WHERE id = ?').run(r.id).changes);
      }
    }
  }
  if (outliers) console.warn(`store: removed ${outliers} saved price(s) far from what other sites charge`);

  const q = {
    insertPrice: db.prepare(`INSERT INTO prices
      (query, site, family, unit, unit_price, price, product, pack, seen_at, job_id, trigger, pack_size, pack_unit, mrp, url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    sites: db.prepare('SELECT DISTINCT site FROM prices WHERE query = ?'),
    firstFamily: db.prepare('SELECT family FROM prices WHERE query = ? AND site = ? ORDER BY id LIMIT 1'),
    low: db.prepare(`SELECT * FROM prices WHERE query = ? AND site = ? AND family = ?
      ORDER BY unit_price ASC, id ASC LIMIT 1`),
    last: db.prepare(`SELECT * FROM prices WHERE query = ? AND site = ? AND family = ?
      ORDER BY id DESC LIMIT 1`),
    lastAny: db.prepare('SELECT * FROM prices WHERE query = ? AND site = ? ORDER BY id DESC LIMIT 1'),
    createJob: db.prepare(`INSERT INTO jobs (status, trigger, sites, items, created_at)
      VALUES ('queued', ?, ?, ?, ?)`),
    getJob: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    listJobs: db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?'),
    interrupt: db.prepare(`UPDATE jobs SET status = 'interrupted', finished_at = ?
      WHERE status IN ('running', 'queued')`),
    markFired: db.prepare('INSERT OR IGNORE INTO fired (key, fired_at) VALUES (?, ?)'),
    hasFired: db.prepare('SELECT 1 FROM fired WHERE key = ?'),
  };

  /**
   * The unit family a (query, site) history lives in. A query that names a
   * pack ("toor dal 1kg") pins it; otherwise the first recorded result does.
   */
  function familyFor(query, site) {
    const pack = parsePack(query);
    if (pack) return pack.family;
    return q.firstFamily.get(query, site)?.family ?? null;
  }

  function siteHistory(query, site) {
    const family = familyFor(query, site);
    if (!family) return null;
    const low = q.low.get(query, site, family);
    if (!low) return null;
    const last = q.last.get(query, site, family);
    return {
      lowUnitPrice: round2(low.unit_price),
      unit: FAMILY_UNIT[family],
      lowPrice: low.price,
      product: low.product,
      pack: low.pack,
      seenAt: low.seen_at,
      lastUnitPrice: round2(last.unit_price),
      lastSeenAt: last.seen_at,
    };
  }

  function jobRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      trigger: row.trigger,
      sites: JSON.parse(row.sites),
      items: JSON.parse(row.items),
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      error: row.error,
      summary: row.summary == null ? null : JSON.parse(row.summary),
    };
  }

  return {
    db,

    /** Record every confidently matched line of a compareBasket() result. */
    recordResult(result, { jobId = null, trigger = 'manual' } = {}) {
      const seenAt = result?.generatedAt ?? new Date().toISOString();
      db.exec('BEGIN');
      try {
        for (const platform of result?.platforms ?? []) {
          for (const line of platform.lines ?? []) {
            // Low-confidence picks are shown to the user but never become a low.
            if (line.status !== 'ok') continue;
            const up = unitPriceOf(line.product);
            if (!up) continue;
            const query = normalizeQuery(line.query);
            // Pin the family on first sight; later off-family rows are kept
            // (they're real observations) but never compared.
            q.insertPrice.run(
              query, platform.platform, up.family, up.unit, up.unitPrice, line.product.price,
              line.product.name ?? null, line.product.packLabel ?? null, seenAt,
              jobId == null ? null : Number(jobId), trigger,
              Number(line.product.packSize) || null, line.product.packUnit ?? null,
              Number.isFinite(line.product.mrp) ? line.product.mrp : null, line.product.url ?? null,
            );
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /**
     * The most recent confident observation for (query, site): the "previous
     * record" shown by history-first search. Returned as an engine product row
     * plus `seenAt`, or null.
     */
    latestFor(query, site) {
      const key = normalizeQuery(query);
      const family = familyFor(key, site);
      const row = family ? q.last.get(key, site, family) : q.lastAny.get(key, site);
      if (!row) return null;
      let packSize = row.pack_size;
      let packUnit = row.pack_unit;
      if (!(packSize > 0)) {
        // Pre-v2 rows: derive the pack from price ÷ unit price.
        const [unitName, divisor] = { kg: ['g', 1000], L: ['ml', 1000], pc: ['piece', 1] }[row.unit] ?? [];
        if (unitName && row.unit_price > 0) {
          packSize = Math.round((row.price / row.unit_price) * divisor * 100) / 100;
          packUnit = unitName;
        }
      }
      return {
        name: row.product ?? key,
        packSize: packSize ?? null,
        packUnit: packUnit ?? null,
        price: row.price,
        mrp: row.mrp ?? null,
        inStock: true,
        url: row.url ?? '',
        seenAt: row.seen_at,
      };
    },

    /**
     * Items that have saved prices, for the search box: most recently seen
     * first. `q` matches anywhere in the item text ("onion" finds "onion 1kg").
     * @returns {Array<{ query: string, sites: number, seenAt: string }>}
     */
    suggest(q = '', limit = 8) {
      const needle = normalizeQuery(q).replace(/[%_]/g, '');
      // "kis" also finds "raisins": any catalogue product with a name starting
      // with the text contributes its canonical tag.
      const alts = [...new Set(productsMatching(q, 5).map((p) => p.canonical))].filter((c) => !c.includes(needle));
      const where = ['query LIKE ?', ...alts.map(() => 'query LIKE ?')].join(' OR ');
      return db
        .prepare(`SELECT query, COUNT(DISTINCT site) AS sites, MAX(seen_at) AS seenAt FROM prices
                  WHERE ${where} GROUP BY query ORDER BY (query LIKE ?) DESC, MAX(seen_at) DESC, query LIMIT ?`)
        .all(`%${needle}%`, ...alts.map((a) => `%${a}%`), `${needle}%`, Math.min(Number(limit) || 8, 25))
        .map((r) => ({ query: r.query, sites: Number(r.sites), seenAt: r.seenAt }));
    },

    /** Fold rows saved under a synonym into the product's canonical name. @returns {number} rows moved */
    regroup,

    /**
     * Where an item has saved prices: site -> newest seenAt. The catalogue
     * sweep (src/sweep.js) uses it to find products still missing.
     */
    coverage(query) {
      const rows = db.prepare('SELECT site, MAX(seen_at) AS seenAt FROM prices WHERE query = ? GROUP BY site').all(normalizeQuery(query));
      return Object.fromEntries(rows.map((r) => [r.site, r.seenAt]));
    },

    /**
     * What each site last charged for an item, as a rate ("₹6.9 per 100 g")
     * and as the pack it was, plus the lowest rate ever seen and when.
     * Rates are always per 100 g / 100 ml / piece so sites are comparable.
     * @returns {{ query: string, per: string, sites: object[] } | null}
     */
    lookup(query) {
      const key = normalizeQuery(query);
      const rows = [];
      let per = null;
      for (const { site } of q.sites.all(key)) {
        const h = siteHistory(key, site);
        const last = this.latestFor(key, site);
        if (!h || !last) continue;
        const div = h.unit === 'pc' ? 1 : 10; // ₹/kg -> ₹/100g
        per = h.unit === 'pc' ? 'piece' : h.unit === 'L' ? '100 ml' : '100 g';
        rows.push({
          site,
          lastPrice: last.price,
          // The pack of the latest price (not of the lowest one), so price and pack agree.
          pack: last.packSize ? `${last.packSize}${last.packUnit}` : h.pack ?? null,
          product: last.name,
          rate: round2(h.lastUnitPrice / div),
          seenAt: last.seenAt,
          lowRate: round2(h.lowUnitPrice / div),
          lowSeenAt: h.seenAt,
          url: last.url || null,
        });
      }
      if (!rows.length) return null;
      rows.sort((a, b) => a.rate - b.rate);
      return { query: key, per, sites: rows };
    },

    /** @returns {Record<string, object>} site -> history summary */
    historyFor(query) {
      const key = normalizeQuery(query);
      const out = {};
      for (const { site } of q.sites.all(key)) {
        const h = siteHistory(key, site);
        if (h) out[site] = h;
      }
      return out;
    },

    /**
     * Adds `history` to every platform line: { low, lowSeenAt, delta, tag }.
     * Compares against what is stored *before* this result is recorded.
     * `history` is null when the line has no per-unit price in the history's
     * unit family.
     */
    annotate(result) {
      for (const platform of result?.platforms ?? []) {
        for (const line of platform.lines ?? []) {
          line.history = null;
          const up = unitPriceOf(line.product);
          if (!up) continue;
          const query = normalizeQuery(line.query);
          const family = familyFor(query, platform.platform);
          if (family && family !== up.family) continue;
          const prior = family ? siteHistory(query, platform.platform) : null;
          const now = round2(up.unitPrice);
          if (!prior) {
            line.history = { low: null, lowSeenAt: null, delta: null, tag: 'new-low', unit: up.unit };
            continue;
          }
          const delta = round2(now - prior.lowUnitPrice);
          line.history = {
            low: prior.lowUnitPrice,
            lowSeenAt: prior.seenAt,
            unit: up.unit,
            delta,
            tag: Math.abs(delta) < EPSILON ? 'at-low' : delta < 0 ? 'new-low' : 'above-low',
          };
        }
      }
      return result;
    },

    createJob({ sites = [], items = '', trigger = 'manual' } = {}) {
      const info = q.createJob.run(trigger, JSON.stringify(sites ?? []), JSON.stringify(items ?? ''), new Date().toISOString());
      return Number(info.lastInsertRowid);
    },

    /** Patch keys: status, startedAt, finishedAt, error, summary. Others are ignored. */
    updateJob(id, patch = {}) {
      const sets = [];
      const values = [];
      for (const [key, column] of Object.entries(JOB_FIELDS)) {
        if (!(key in patch)) continue;
        let value = patch[key];
        if (key === 'summary' && value != null) value = JSON.stringify(value);
        if (key === 'error' && value instanceof Error) value = value.message;
        sets.push(`${column} = ?`);
        values.push(value ?? null);
      }
      if (sets.length === 0) return;
      db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, Number(id));
    },

    getJob(id) {
      return jobRow(q.getJob.get(Number(id)));
    },

    listJobs(limit = 50) {
      return q.listJobs.all(Number(limit)).map(jobRow);
    },

    /**
     * On boot: nothing is running yet, so any job still marked running (or
     * queued — the in-memory queue is gone) was cut off by a restart.
     * @returns {number} jobs flipped
     */
    markInterrupted() {
      return Number(q.interrupt.run(new Date().toISOString()).changes);
    },

    /** Scheduler fire-once keys. Returns true only the first time a key is marked. */
    markFired(key) {
      return Number(q.markFired.run(String(key), new Date().toISOString()).changes) > 0;
    },

    hasFired(key) {
      return Boolean(q.hasFired.get(String(key)));
    },

    close() {
      if (db.isOpen) db.close();
    },
  };
}
