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
import { canonicalQuery, productsMatching } from './catalog.js';
import { parsePack, matchConfidence, CONFIDENCE_THRESHOLD, queryWords, addsKind } from './normalize.js';
import { categoryGroup, namedGroups } from './categories.js';

// Canonical pack unit (normalize.js) -> [base unit, divisor, family].
const BASE_UNITS = {
  g: ['kg', 1000, 'mass'],
  ml: ['L', 1000, 'volume'],
  piece: ['pc', 1, 'count'],
};
const FAMILY_UNIT = { mass: 'kg', volume: 'L', count: 'pc' };

const round2 = (n) => Math.round(n * 100) / 100;

/** Bump when matching/pack/price-check rules change, so saved rows are re-checked once. */
export const CLEANUP_VERSION = 3;
/**
 * Bump when only the matcher (normalize.js) changes: saved rows are re-checked
 * against it once, without re-running the outlier pass over all newer data.
 * 2: sweets (laddu/barfi/peda) and pooja items aren't the staple (2026-11-20).
 * 3: a saved site category of sweets / pooja isn't the staple either.
 */
export const MATCH_VERSION = 3;
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

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

/**
 * Hide rows an older, looser matcher accepted but the current one refuses
 * (e.g. "toor dal" saved as Moong Dal, "ghee" saved as Ghee Besan Laddu): they
 * would show as false lows and as the "previous record" in history-first search.
 * Never deleted: marked hidden with the reason, kept for reference and recovery.
 */
function hideRefused(db) {
  const hide = db.prepare("UPDATE prices SET hidden = 'no-match' WHERE hidden IS NULL AND query = ? AND product = ?");
  let pruned = 0;
  for (const { query, product } of db.prepare("SELECT DISTINCT query, product FROM prices WHERE hidden IS NULL AND product IS NOT NULL AND site != 'others'").all()) {
    const m = matchConfidence(query, { name: product });
    if (m.refused || m.score < CONFIDENCE_THRESHOLD) pruned += Number(hide.run(query, product).changes);
  }
  // A site that files the product under sweets or pooja (its own category) says
  // it isn't the staple a generic line asked for. AI labels never hide anything.
  const hideCat = db.prepare("UPDATE prices SET hidden = 'no-match' WHERE hidden IS NULL AND query = ? AND category = ?");
  for (const { query, category } of db.prepare("SELECT DISTINCT query, category FROM prices WHERE hidden IS NULL AND category IS NOT NULL AND site != 'others'").all()) {
    const g = categoryGroup(category);
    if ((g === 'sweets' || g === 'pooja') && !namedGroups(query).has(g)) pruned += Number(hideCat.run(query, category).changes);
  }
  if (pruned) console.warn(`store: set aside ${pruned} saved price(s) that no longer match their item`);
}

export function openStore(file = join(DATA_DIR, 'basket.db'), { timeZone = 'Asia/Kolkata' } = {}) {
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
    -- Deals (80%+ off MRP): from offer feeds per site+account, and from searches.
    -- Shown on their own; never part of a basket total.
    CREATE TABLE IF NOT EXISTS deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site TEXT NOT NULL,
      account TEXT NOT NULL,
      source TEXT NOT NULL,
      product TEXT NOT NULL,
      pack TEXT,
      price REAL NOT NULL,
      mrp REAL NOT NULL,
      pct REAL NOT NULL,
      conditions TEXT,
      url TEXT,
      seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deals_key ON deals (site, account, source, seen_at);
    -- Products the user marked as a wrong match for an item on a site (✕ on a cell):
    -- their saved prices are deleted and they're never picked for that item again.
    CREATE TABLE IF NOT EXISTS rejects (
      query TEXT NOT NULL,
      site TEXT NOT NULL,
      product TEXT NOT NULL,
      rejected_at TEXT NOT NULL,
      PRIMARY KEY (query, site, product)
    );
    -- Latest cheaper other-brand product per item+site (the "cheaper: …" hint). Not history.
    CREATE TABLE IF NOT EXISTS alternatives (
      query TEXT NOT NULL,
      site TEXT NOT NULL,
      product TEXT NOT NULL,
      price REAL NOT NULL,
      pack TEXT,
      unit_price REAL NOT NULL,
      unit TEXT,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (query, site)
    );
    -- What a site says about its own fees (e.g. free delivery above ₹99), read from its pages.
    CREATE TABLE IF NOT EXISTS site_info (
      site TEXT PRIMARY KEY,
      info TEXT NOT NULL,
      seen_at TEXT NOT NULL
    );
    -- What kind of product a title is (staple / packaged / sweets / pooja / nonfood),
    -- labelled by the optional AI labeller (src/ai/). Only ever demotes; never deleted.
    CREATE TABLE IF NOT EXISTS product_groups (
      product TEXT PRIMARY KEY,
      grp TEXT NOT NULL,
      source TEXT NOT NULL,
      model TEXT,
      labelled_at TEXT NOT NULL
    );
    -- Last offer check per site+account (also when it found nothing).
    CREATE TABLE IF NOT EXISTS deal_checks (
      site TEXT NOT NULL,
      account TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      error TEXT,
      PRIMARY KEY (site, account)
    );
  `);

  // v2 columns: enough to rebuild a product row for history-first search.
  const cols = new Set(db.prepare('PRAGMA table_info(prices)').all().map((c) => c.name));
  // `hidden`: null = in use; otherwise why it is set aside ('rejected' by ✕,
  // 'no-match' / 'outlier' by a clean-up). Rows are never deleted (2026-11-20).
  // `source`: where an "Others" price was bought (entered by the user).
  for (const [name, type] of [['pack_size', 'REAL'], ['pack_unit', 'TEXT'], ['mrp', 'REAL'], ['url', 'TEXT'], ['hidden', 'TEXT'], ['source', 'TEXT'], ['category', 'TEXT']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE prices ADD COLUMN ${name} ${type}`);
  }
  // The clean-ups below scan every row. They only need to run when the
  // matching or pack rules change, so they run once per CLEANUP_VERSION
  // (bump it when normalize.js / pricecheck.js rules change) instead of on
  // every start.
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  // Fold synonyms into one product ("kismis" rows join "raisins", src/catalog.js).
  // Only the item key changes, nothing is deleted; it runs on every start so a
  // catalogue change takes effect on restart. New rows are written canonical.
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
  const cleanupDone = db.prepare("SELECT value FROM meta WHERE key = 'cleanup_version'").get()?.value;
  if (cleanupDone !== String(CLEANUP_VERSION)) {
    // Re-key rows written with an older normalizeQuery.
    for (const { query } of db.prepare('SELECT DISTINCT query FROM prices').all()) {
      const key = normalizeQuery(query);
      if (key !== query) db.prepare('UPDATE prices SET query = ? WHERE query = ?').run(key, query);
    }
    hideRefused(db);
    // Rows saved before the price check existed can carry wrong packs (₹79 for a
    // "500 g" butter that was 100 g). Compare each site's latest unit price with
    // the median across sites for the same item and drop what is far off, so a
    // bad row never shows as a "new low" or as a lookup rate.
    let outliers = 0;
    const bounds = { low: 0.4, high: 2.5 };
    for (const { query, family } of db.prepare('SELECT DISTINCT query, family FROM prices WHERE hidden IS NULL').all()) {
      const bySite = db.prepare('SELECT site, id, unit_price FROM prices WHERE hidden IS NULL AND query = ? AND family = ?').all(query, family);
      const sites = [...new Set(bySite.map((r) => r.site))];
      if (sites.length < 3) continue;
      const mids = sites.map((site) => {
        const v = bySite.filter((r) => r.site === site).map((r) => r.unit_price).sort((a, b) => a - b);
        return v[v.length >> 1];
      }).sort((a, b) => a - b);
      const mid = mids[mids.length >> 1];
      for (const r of bySite) {
        if (r.unit_price < mid * bounds.low || r.unit_price > mid * bounds.high) {
          outliers += Number(db.prepare("UPDATE prices SET hidden = 'outlier' WHERE id = ?").run(r.id).changes);
        }
      }
    }
    if (outliers) console.warn(`store: removed ${outliers} saved price(s) far from what other sites charge`);
    db.prepare("INSERT INTO meta (key, value) VALUES ('cleanup_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(CLEANUP_VERSION));
    setMeta(db, 'match_version', MATCH_VERSION);
  }
  // A matcher-only change: re-check saved rows once, nothing else.
  if (db.prepare("SELECT value FROM meta WHERE key = 'match_version'").get()?.value !== String(MATCH_VERSION)) {
    hideRefused(db);
    setMeta(db, 'match_version', MATCH_VERSION);
  }

  const q = {
    insertPrice: db.prepare(`INSERT INTO prices
      (query, site, family, unit, unit_price, price, product, pack, seen_at, job_id, trigger, pack_size, pack_unit, mrp, url, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    sites: db.prepare('SELECT DISTINCT site FROM prices WHERE hidden IS NULL AND query = ?'),
    firstFamily: db.prepare('SELECT family FROM prices WHERE hidden IS NULL AND query = ? AND site = ? ORDER BY id LIMIT 1'),
    low: db.prepare(`SELECT * FROM prices WHERE hidden IS NULL AND query = ? AND site = ? AND family = ?
      ORDER BY unit_price ASC, id ASC LIMIT 1`),
    last: db.prepare(`SELECT * FROM prices WHERE hidden IS NULL AND query = ? AND site = ? AND family = ?
      ORDER BY id DESC LIMIT 1`),
    lastAny: db.prepare('SELECT * FROM prices WHERE hidden IS NULL AND query = ? AND site = ? ORDER BY id DESC LIMIT 1'),
    lastTwo: db.prepare(`SELECT * FROM prices WHERE hidden IS NULL AND query = ? AND site = ? AND family = ?
      ORDER BY id DESC LIMIT 2`),
    inFamily: db.prepare(`SELECT site, unit_price, price, product, pack, seen_at FROM prices
      WHERE hidden IS NULL AND query = ? AND family = ? ORDER BY id`),
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

  /** Below this relative change a price counts as unchanged ("="). */
  const SAME_PCT = 1;

  /** ▲/▼ of `nowUnitPrice` against an earlier saved row (any day). */
  function changeAgainst(nowUnitPrice, prev) {
    if (!prev) return { prev: null, change: null, changePct: null };
    const pct = ((nowUnitPrice - prev.unit_price) / prev.unit_price) * 100;
    return {
      prev: { unitPrice: round2(prev.unit_price), price: prev.price, seenAt: prev.seen_at, product: prev.product, pack: prev.pack },
      change: Math.abs(pct) < SAME_PCT ? 'same' : pct < 0 ? 'down' : 'up',
      changePct: Math.round(pct * 10) / 10,
    };
  }

  /** Calendar date of an ISO time in the service's time zone (dates are local, not UTC). */
  // One formatter for the store's life: building one per row made suggest()
  // (a trend lookup per suggestion, per keystroke) needlessly slow.
  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const localDate = (iso) => dateFmt.format(new Date(iso));

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
          // "Others" lines are the user's own entries, already stored.
          if (platform.others) continue;
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
              line.product.category ?? null,
            );
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      if (result?.alternatives?.length) this.recordAlternatives(result.alternatives, seenAt);
      // Deals seen while searching (computed by compareBasket); never in totals.
      if (result?.deals?.length) {
        const bySite = new Map();
        for (const d of result.deals) bySite.set(`${d.site}|${d.account}`, [...(bySite.get(`${d.site}|${d.account}`) ?? []), d]);
        for (const [key, list] of bySite) {
          const [site, account] = key.split('|');
          this.recordDeals(list, { site, account, source: 'search', checkedAt: seenAt });
        }
      }
    },

    /**
     * Store deals for one site+account. A `feed` check replaces that pair's
     * feed deals (what the feed no longer lists has ended); `search` deals add up.
     */
    recordDeals(deals, { site, account = 'main', source, checkedAt = new Date().toISOString(), error = null }) {
      db.exec('BEGIN');
      try {
        // Search deals are shown for 24 h; older ones aren't needed.
        db.prepare("DELETE FROM deals WHERE source = 'search' AND seen_at < ?").run(new Date(Date.parse(checkedAt) - 24 * 3_600_000).toISOString());
        if (source === 'feed') {
          // A failed check keeps the last good deals (one network blip mustn't empty the section).
          if (!error) db.prepare("DELETE FROM deals WHERE site = ? AND account = ? AND source = 'feed'").run(site, account);
          db.prepare('INSERT INTO deal_checks (site, account, checked_at, error) VALUES (?, ?, ?, ?) ON CONFLICT(site, account) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error')
            .run(site, account, checkedAt, error);
        }
        const ins = db.prepare('INSERT INTO deals (site, account, source, product, pack, price, mrp, pct, conditions, url, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const d of deals) {
          if (!(d.pct > 0) || !d.product) continue;
          ins.run(site, account, source, d.product, d.pack ?? null, d.price, d.mrp, d.pct, d.conditions ? JSON.stringify(d.conditions) : null, d.url ?? null, d.seenAt ?? checkedAt);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /**
     * The user says `product` is the wrong match for `query` on `site`: delete
     * its saved prices for that item and never pick it for that item again.
     * @returns {{ deleted: number }}
     */
    rejectMatch({ query, site, product }) {
      const key = normalizeQuery(query);
      const name = String(product ?? '').trim();
      if (!key || !site || !name) throw new Error('query, site and product are required');
      db.prepare('INSERT INTO rejects (query, site, product, rejected_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(key, site, name, new Date().toISOString());
      // Kept, marked hidden: it stops counting for this item but stays in the data.
      return { hidden: Number(db.prepare("UPDATE prices SET hidden = 'rejected' WHERE hidden IS NULL AND query = ? AND site = ? AND product = ?").run(key, site, name).changes) };
    },

    /**
     * A price the user bought or saw elsewhere (a local shop, a bill). Stored
     * as site 'others' so the table, colours, lookup trend and history treat
     * it like any saved price; `source` says where. Never searched, never a deal.
     * @returns {{ id: number }}
     */
    addManualPrice({ query, product, price, packSize, packUnit, pack, seenAt, source }) {
      const key = normalizeQuery(query);
      const p = Number(price);
      if (!key) throw new Error('Give the item, e.g. "tata salt 1kg"');
      if (!(p > 0 && p < 1e6)) throw new Error('Give the price paid in ₹');
      const when = seenAt ? new Date(seenAt) : new Date();
      if (Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 86_400_000) throw new Error('The date is not valid');
      // The pack: given, or read from the product name, or from the item ("… 1kg").
      const fromText = (pack && parsePack(String(pack))) || parsePack(`${product ?? ''}`) || parsePack(key);
      const size = Number(packSize) > 0 ? Number(packSize) : fromText?.size ?? null;
      const unit = packUnit || fromText?.unit || null;
      const row = { name: String(product || key).trim().slice(0, 160), price: p, packSize: size, packUnit: unit };
      const up = unitPriceOf(row);
      if (!up) throw new Error('Give the pack size (e.g. 1 kg, 500 g, 6 pcs), so a rate per 100 g can be worked out');
      const r = q.insertPrice.run(
        key, 'others', up.family, up.unit, up.unitPrice, p, row.name, `${size}${unit}`, when.toISOString(),
        null, 'entry', size, unit, null, null, null,
      );
      const id = Number(r.lastInsertRowid);
      db.prepare('UPDATE prices SET source = ? WHERE id = ?').run(String(source ?? '').trim().slice(0, 120) || null, id);
      return { id };
    },

    /** Entered prices, newest first (for the dialog's list). */
    listManualPrices(limit = 50) {
      return db.prepare("SELECT id, query, product, price, pack, seen_at AS seenAt, source FROM prices WHERE site = 'others' AND hidden IS NULL ORDER BY seen_at DESC, id DESC LIMIT ?").all(Math.min(Number(limit) || 50, 200));
    },

    /** Take an entered price out (kept, marked hidden). */
    removeManualPrice(id) {
      return { removed: Number(db.prepare("UPDATE prices SET hidden = 'removed' WHERE id = ? AND site = 'others' AND hidden IS NULL").run(Number(id)).changes) };
    },

    /** Latest entered price per item (with where it was bought), for the Others column. */
    manualFor(query) {
      const key = normalizeQuery(query);
      const r = db.prepare("SELECT * FROM prices WHERE site = 'others' AND hidden IS NULL AND query = ? ORDER BY seen_at DESC, id DESC LIMIT 1").get(key);
      return r ? { row: { name: r.product, price: r.price, mrp: null, packSize: r.pack_size, packUnit: r.pack_unit, inStock: true, url: '' }, seenAt: r.seen_at, source: r.source ?? null, id: r.id } : null;
    },

    /**
     * Cheaper products of another brand, seen by searches for this item on this
     * site (option A, 2026-11-20): never part of the history, only for the hint.
     */
    recordAlternatives(list, seenAt) {
      const ins = db.prepare(`INSERT INTO alternatives (query, site, product, price, pack, unit_price, unit, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(query, site) DO UPDATE SET product = excluded.product, price = excluded.price, pack = excluded.pack, unit_price = excluded.unit_price, unit = excluded.unit, seen_at = excluded.seen_at`);
      for (const a of list) ins.run(normalizeQuery(a.query), a.site, a.product, a.price, a.pack ?? null, a.unitPrice, a.unit ?? null, seenAt);
    },
    alternativeFor(query, site) {
      const r = db.prepare('SELECT * FROM alternatives WHERE query = ? AND site = ?').get(normalizeQuery(query), site);
      return r ? { product: r.product, price: r.price, pack: r.pack, pricePerUnit: r.unit_price, unit: r.unit, seenAt: r.seen_at } : null;
    },

    /** Product names rejected for this item on this site. */
    rejectedFor(query, site) {
      return new Set(db.prepare('SELECT product FROM rejects WHERE query = ? AND site = ?').all(normalizeQuery(query), site).map((r) => r.product));
    },

    /** Fee facts a site publishes (free-delivery minimum etc.), per site. */
    setSiteInfo(site, info, seenAt = new Date().toISOString()) {
      if (!info || !Object.keys(info).length) return;
      db.prepare('INSERT INTO site_info (site, info, seen_at) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET info = excluded.info, seen_at = excluded.seen_at').run(site, JSON.stringify(info), seenAt);
    },
    siteInfo() {
      return Object.fromEntries(db.prepare('SELECT site, info, seen_at FROM site_info').all().map((r) => [r.site, { ...JSON.parse(r.info), seenAt: r.seen_at }]));
    },

    /** An account signed out or removed: its deals and check rows go too. */
    forgetAccountDeals(site, account) {
      db.prepare('DELETE FROM deals WHERE site = ? AND account = ?').run(site, account);
      db.prepare('DELETE FROM deal_checks WHERE site = ? AND account = ?').run(site, account);
    },

    /**
     * What the Deals section shows: feed deals from each site+account's latest
     * check, grouped by site; search deals from the last 24 h. The same product
     * seen by several accounts is one row with `seenBy` (for the hover).
     * @param {{ now?: number, names?: Record<string,string>, hints?: Record<string,string> }} [opts]
     *   names/hints: account id -> display name / masked hint (from accounts.json)
     */
    currentDeals({ now = Date.now(), names = {}, hints = {} } = {}) {
      const merge = (rows) => {
        const out = new Map();
        for (const r of rows) {
          const key = `${r.site}|${r.product}|${r.pack ?? ''}|${r.price}`;
          const d = out.get(key) ?? {
            site: r.site, product: r.product, pack: r.pack, price: r.price, mrp: r.mrp, pct: r.pct,
            conditions: r.conditions ? JSON.parse(r.conditions) : null, url: r.url, source: r.source, seenAt: r.seen_at, seenBy: [],
          };
          if (!d.seenBy.some((x) => x.account === r.account)) {
            d.seenBy.push({ account: r.account, name: names[r.account] ?? (r.account === 'main' ? 'Main' : r.account), hint: hints[r.account] ?? null, seenAt: r.seen_at });
          }
          if (r.seen_at > d.seenAt) d.seenAt = r.seen_at;
          out.set(key, d);
        }
        return [...out.values()].sort((a, b) => b.pct - a.pct || a.price - b.price);
      };
      const feed = db.prepare("SELECT * FROM deals WHERE source = 'feed'").all();
      const checks = db.prepare('SELECT site, account, checked_at, error FROM deal_checks').all();
      const checkedAt = {};
      const errors = [];
      for (const c of checks) {
        if (!checkedAt[c.site] || c.checked_at > checkedAt[c.site]) checkedAt[c.site] = c.checked_at;
        if (c.error) errors.push({ site: c.site, account: c.account, name: names[c.account] ?? c.account, error: c.error, checkedAt: c.checked_at });
      }
      const sites = [...new Set([...feed.map((r) => r.site), ...Object.keys(checkedAt)])].sort();
      const groups = sites.map((site) => {
        const deals = merge(feed.filter((r) => r.site === site));
        // Conditions shared by every deal of the site go on its heading line.
        const shared = deals.length && deals.every((d) => JSON.stringify(d.conditions) === JSON.stringify(deals[0].conditions)) ? deals[0].conditions : null;
        return { site, checkedAt: checkedAt[site] ?? null, conditions: shared, deals };
      });
      const since = new Date(now - 24 * 3_600_000).toISOString();
      const fromSearches = merge(db.prepare("SELECT * FROM deals WHERE source = 'search' AND seen_at >= ?").all(since));
      return { checkedAt, groups, fromSearches, errors };
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
        category: row.category ?? null,
        ...(row.source ? { source: row.source } : {}),
      };
    },

    /**
     * A saved price for a line that has none of its own, from a more specific
     * saved line: "salt" and "tata salt" from "tata salt 1kg". The saved line
     * must hold every word of this one, add no kind word ("black salt" is not
     * salt), have the same pack when this line names one, and its product must
     * still match this line. A more specific line ("cow ghee 1l") never borrows
     * from a generic one ("ghee"): it has a word the saved line lacks.
     * Fewest extra words wins, then the newest. Only for "Find the cheapest".
     * @returns {object|null} a latestFor() row plus `savedFrom`
     */
    savedFor(query, site) {
      const key = normalizeQuery(query);
      const words = queryWords(key);
      if (!words.length) return null;
      const pack = parsePack(key);
      const picks = [];
      for (const { query: saved } of db.prepare('SELECT DISTINCT query FROM prices WHERE hidden IS NULL AND site = ? AND query != ?').all(site, key)) {
        const have = new Set(queryWords(saved));
        if (!words.every((w) => have.has(w))) continue;
        if (addsKind(key, key, saved)) continue;
        const sp = parsePack(saved);
        if (pack && !(sp && sp.family === pack.family && Math.abs(sp.size - pack.size) < 1e-9)) continue;
        const row = this.latestFor(saved, site);
        if (!row) continue;
        const m = matchConfidence(key, row);
        if (m.refused || m.score < CONFIDENCE_THRESHOLD) continue;
        picks.push({ row: { ...row, savedFrom: saved }, extra: have.size - words.length });
      }
      picks.sort((a, b) => a.extra - b.extra || String(b.row.seenAt).localeCompare(String(a.row.seenAt)));
      return picks[0]?.row ?? null;
    },

    /**
     * Per site and line, the site category its saved staple prices usually sit
     * in (at least 2 visible rows; ties go to the newest). pickBest prefers it.
     * Rows a ✕ hid don't count, so the learning follows the user's corrections.
     * @returns {Record<string, Record<string, { category: string }>>}
     */
    prefsFor(queries, sites) {
      const stmt = db.prepare(`SELECT category, COUNT(*) AS n, MAX(id) AS last FROM prices
        WHERE hidden IS NULL AND query = ? AND site = ? AND category IS NOT NULL GROUP BY category ORDER BY n DESC, last DESC`);
      // What kind of thing the line itself is, from the AI labels of its saved
      // products on every site (2+ products, most common wins). Seen 2026-11-20:
      // the AI calls every honey, garam masala and bread "packaged"; without this,
      // a labelled cheaper honey would lose to an unlabelled dearer one.
      const lineStmt = db.prepare(`SELECT g.grp, COUNT(DISTINCT p.product) AS n FROM prices p JOIN product_groups g ON g.product = p.product
        WHERE p.hidden IS NULL AND p.query = ? GROUP BY g.grp ORDER BY n DESC`);
      const namesStmt = db.prepare("SELECT DISTINCT product FROM prices WHERE hidden IS NULL AND query = ? AND product IS NOT NULL AND site != 'others'");
      const savedCache = new Map();
      const savedNames = (query) => {
        if (!savedCache.has(query)) savedCache.set(query, new Set(namesStmt.all(normalizeQuery(query)).map((r) => r.product)));
        return savedCache.get(query);
      };
      const lineGroups = Object.fromEntries(queries.map((query) => {
        const top = lineStmt.all(normalizeQuery(query))[0];
        const g = top && Number(top.n) >= 2 ? (top.grp === 'nonfood' ? 'packaged' : top.grp) : null;
        return [query, g];
      }));
      const out = {};
      for (const site of sites) {
        out[site] = {};
        for (const query of queries) {
          const named = namedGroups(query);
          const best = stmt.all(normalizeQuery(query), site).find((r) => {
            const g = categoryGroup(r.category);
            return g == null || named.has(g);
          });
          const pref = {
            ...(best && Number(best.n) >= 2 ? { category: best.category } : {}),
            ...(lineGroups[query] ? { lineGroup: lineGroups[query] } : {}),
            // Products already saved for this line were picked before and not ✕'d:
            // that beats an AI label (seen: one brown bread "packaged", the others "staple").
            ...(lineGroups[query] === 'staple' ? { saved: savedNames(query) } : {}),
          };
          if (Object.keys(pref).length) out[site][query] = pref;
        }
      }
      return out;
    },

    /** AI labels by product title (src/ai/). Only ever used to demote. */
    aiGroups() {
      return new Map(db.prepare('SELECT product, grp FROM product_groups').all().map((r) => [r.product, r.grp]));
    },

    /** Saved titles with no site category and no label yet, newest first. */
    unlabelled(limit = 100) {
      return db.prepare(`SELECT product FROM prices WHERE hidden IS NULL AND product IS NOT NULL AND site != 'others' AND category IS NULL
        AND product NOT IN (SELECT product FROM product_groups) GROUP BY product ORDER BY MAX(id) DESC LIMIT ?`).all(Number(limit) || 100).map((r) => r.product);
    },

    /** Add or re-tag labels. Never deletes. */
    setGroups(list, { model = null, source = 'ai', at = new Date().toISOString() } = {}) {
      const ins = db.prepare(`INSERT INTO product_groups (product, grp, source, model, labelled_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(product) DO UPDATE SET grp = excluded.grp, source = excluded.source, model = excluded.model, labelled_at = excluded.labelled_at`);
      let n = 0;
      for (const { product, group } of list) if (product && group) { ins.run(product, group, source, model, at); n++; }
      return n;
    },

    /** Small counters and markers (e.g. AI calls per day). */
    getMeta(key) {
      return db.prepare('SELECT value FROM meta WHERE key = ?').get(String(key))?.value ?? null;
    },
    setMeta(key, value) {
      setMeta(db, String(key), value);
    },

    /** How many saved titles have an AI label, and how many could get one. */
    labelCounts() {
      return {
        labelled: Number(db.prepare('SELECT COUNT(*) AS n FROM product_groups').get().n),
        waiting: Number(db.prepare(`SELECT COUNT(DISTINCT product) AS n FROM prices WHERE hidden IS NULL AND product IS NOT NULL AND site != 'others'
          AND category IS NULL AND product NOT IN (SELECT product FROM product_groups)`).get().n),
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
                  WHERE hidden IS NULL AND (${where}) GROUP BY query ORDER BY (query LIKE ?) DESC, MAX(seen_at) DESC, query LIMIT ?`)
        .all(`%${needle}%`, ...alts.map((a) => `%${a}%`), `${needle}%`, Math.min(Number(limit) || 8, 25))
        .map((r) => {
          // Best rate on the latest date with data, so the dropdown already answers "how much?".
          const rr = this.recentRates(r.query, { days: 1 });
          let best = null;
          for (const [site, cells] of Object.entries(rr?.sites ?? {})) {
            const c = cells.at(-1);
            if (c && (!best || c.rate < best.rate)) best = { site, rate: c.rate, per: rr.per, date: rr.dates.at(-1) };
          }
          return { query: r.query, sites: Number(r.sites), seenAt: r.seenAt, best };
        });
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
          // "Others" (entered by the user): where it was bought, for the hover.
          ...(last.source ? { source: last.source } : {}),
        });
      }
      if (!rows.length) return null;
      const recent = this.recentRates(key);
      for (const r of rows) {
        r.trend = recent?.sites[r.site] ?? null;
        const h = this.cachedHistory(key, r.site);
        r.change = h?.change ?? null;
        r.changePct = h?.changePct ?? null;
        r.prev = h?.prev ?? null;
      }
      rows.sort((a, b) => a.rate - b.rate);
      return { query: key, per, dates: recent?.dates ?? [], sites: rows };
    },

    /**
     * History for a line shown from saved prices (history-first view): the
     * latest saved row against the one saved before it, plus the lowest ever.
     * @returns {object|null} same shape as annotate()'s `line.history`
     */
    cachedHistory(query, site) {
      const key = normalizeQuery(query);
      const family = familyFor(key, site);
      if (!family) return null;
      const [last, prev] = q.lastTwo.all(key, site, family);
      const h = siteHistory(key, site);
      if (!last || !h) return null;
      const delta = round2(last.unit_price - h.lowUnitPrice);
      return {
        low: h.lowUnitPrice,
        lowSeenAt: h.seenAt,
        unit: h.unit,
        delta,
        tag: Math.abs(delta) < EPSILON ? 'at-low' : delta < 0 ? 'new-low' : 'above-low',
        ...changeAgainst(last.unit_price, prev),
      };
    },

    /**
     * Rates on the last `days` dates that have data for this item (any site),
     * per site, oldest -> newest. Each value is the LOWEST rate that site had
     * that date (the deal view), per 100 g / 100 ml / piece. `null` where a
     * site had no price that date.
     * @returns {{ dates: string[], per: string, sites: Record<string, Array<{ rate: number, price: number, product: string, pack: string, seenAt: string } | null>> } | null}
     */
    recentRates(query, { days = 3 } = {}) {
      const key = normalizeQuery(query);
      const fam = parsePack(key)?.family ?? q.firstFamily.get(key, q.sites.all(key)[0]?.site ?? '')?.family;
      if (!fam) return null;
      const rows = q.inFamily.all(key, fam);
      if (!rows.length) return null;
      const dates = [...new Set(rows.map((r) => localDate(r.seen_at)))].sort().slice(-days);
      const div = fam === 'count' ? 1 : 10; // ₹/kg -> ₹/100 g, ₹/L -> ₹/100 ml
      const sites = {};
      for (const r of rows) {
        const i = dates.indexOf(localDate(r.seen_at));
        if (i < 0) continue;
        const cell = (sites[r.site] ??= dates.map(() => null));
        if (!cell[i] || r.unit_price / div < cell[i].rate) {
          cell[i] = { rate: round2(r.unit_price / div), price: r.price, product: r.product, pack: r.pack, seenAt: r.seen_at };
        }
      }
      return { dates, per: fam === 'count' ? 'piece' : fam === 'volume' ? '100 ml' : '100 g', sites };
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
            line.history = { low: null, lowSeenAt: null, delta: null, tag: 'new-low', unit: up.unit, prev: null, change: null, changePct: null };
            continue;
          }
          const delta = round2(now - prior.lowUnitPrice);
          line.history = {
            low: prior.lowUnitPrice,
            lowSeenAt: prior.seenAt,
            unit: up.unit,
            delta,
            tag: Math.abs(delta) < EPSILON ? 'at-low' : delta < 0 ? 'new-low' : 'above-low',
            // vs the latest earlier saved price (decision 2026-11-19: latest available data)
            ...changeAgainst(up.unitPrice, q.last.get(query, platform.platform, family)),
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
