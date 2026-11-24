import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openStore, normalizeQuery } from '../src/store.js';
import { compareBasket } from '../src/compare.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { runSearch } from '../src/engine/run.js';
import { SITES } from '../src/engine/sites/index.js';

const config = { ...DEFAULT_CONFIG, sites: ['zepto', 'kpn', 'blinkit'] };

function liveResult(generatedAt, platform, query, product) {
  return {
    generatedAt,
    platforms: [{ platform, lines: [{ query, status: 'ok', product: { packLabel: `${product.packSize}${product.packUnit}`, ...product } }] }],
  };
}

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'basket-hist-'));
  return { dir, store: openStore(join(dir, 'basket.db')) };
}

test('normalizeQuery folds pack spellings so one item has one history', () => {
  assert.equal(normalizeQuery('Toor Dal 1 KG'), 'toor dal 1kg');
  assert.equal(normalizeQuery('toor dal 1kg'), 'toor dal 1kg');
  assert.equal(normalizeQuery('sunflower oil 1 litre'), 'sunflower oil 1l');
  assert.equal(normalizeQuery('biscuits 250 gms'), 'biscuits 250g');
  assert.equal(normalizeQuery('6 eggs'), '6 eggs');
});

test('latestFor returns the most recent record (not the lowest) as a product row with its date', () => {
  const { dir, store } = tmpStore();
  try {
    store.recordResult(liveResult('2026-11-17T01:30:00.000Z', 'zepto', 'toor dal 1kg', { name: 'BestValue Toor Dal 1 kg', price: 150, packSize: 1000, packUnit: 'g', mrp: 200, url: 'https://z/1' }));
    store.recordResult(liveResult('2026-11-18T01:30:00.000Z', 'zepto', 'toor dal 1kg', { name: 'BestValue Toor Dal 1 kg', price: 156, packSize: 1000, packUnit: 'g', mrp: 200, url: 'https://z/1' }));
    const row = store.latestFor('Toor Dal 1 kg', 'zepto');
    assert.deepEqual(row, { name: 'BestValue Toor Dal 1 kg', packSize: 1000, packUnit: 'g', price: 156, mrp: 200, inStock: true, url: 'https://z/1', seenAt: '2026-11-18T01:30:00.000Z', category: null });
    assert.equal(store.latestFor('toor dal 1kg', 'kpn'), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('old databases are migrated: new columns added, keys re-normalized, pack derived from unit price', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basket-mig-'));
  const file = join(dir, 'basket.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE prices (id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, site TEXT NOT NULL, family TEXT NOT NULL,
    unit TEXT NOT NULL, unit_price REAL NOT NULL, price REAL NOT NULL, product TEXT, pack TEXT, seen_at TEXT NOT NULL, job_id INTEGER, trigger TEXT)`);
  db.prepare(`INSERT INTO prices (query, site, family, unit, unit_price, price, product, pack, seen_at, trigger)
    VALUES ('toor dal 1 kg', 'kpn', 'mass', 'kg', 312, 156, 'Toor Dal Loose 500 g', '500g', '2026-11-16T10:00:00.000Z', 'manual')`).run();
  db.close();
  const store = openStore(file);
  try {
    const row = store.latestFor('toor dal 1kg', 'kpn');
    assert.equal(row.packSize, 500);
    assert.equal(row.packUnit, 'g');
    assert.equal(row.price, 156);
    assert.equal(row.url, '');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compareBasket({cached}) ranks saved prices, dates every line, marks gaps, and contacts nothing', async () => {
  const { dir, store } = tmpStore();
  try {
    store.recordResult(liveResult('2026-11-18T01:30:00.000Z', 'zepto', 'toor dal 1kg', { name: 'BestValue Toor Dal 1 kg', price: 156, packSize: 1000, packUnit: 'g', url: 'https://z' }));
    store.recordResult(liveResult('2026-11-17T06:30:00.000Z', 'kpn', 'toor dal 1kg', { name: 'Toor Dal Economy Loose 1 kg', price: 150, packSize: 1000, packUnit: 'g', url: 'https://k' }));
    let searched = false;
    const res = await compareBasket({
      items: '2x toor dal 1 kg\nmaida 1kg',
      config,
      cached: true,
      store,
      search: async () => { searched = true; return []; },
    });
    assert.equal(searched, false, 'no site contacted');
    assert.equal(res.source, 'history');
    assert.equal(res.backend, 'history');
    assert.deepEqual(res.cachedRange, { oldest: '2026-11-17T06:30:00.000Z', newest: '2026-11-18T01:30:00.000Z' });
    const kpn = res.platforms.find((p) => p.platform === 'kpn');
    const toor = kpn.lines.find((l) => l.query === 'toor dal 1 kg');
    assert.equal(toor.status, 'ok');
    assert.equal(toor.lineTotal, 300, '2 × ₹150');
    assert.equal(toor.cachedAt, '2026-11-17T06:30:00.000Z');
    assert.equal(kpn.lines.find((l) => l.query === 'maida 1kg').status, 'not-cached');
    assert.equal(res.platforms.find((p) => p.platform === 'blinkit').notCached, true);
    assert.equal(res.winner.platform, 'kpn');
    assert.ok(res.uncached.some((u) => u.platform === 'blinkit' && u.query === 'toor dal 1 kg'));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cached mode without a store is an error, not a live run', async () => {
  await assert.rejects(() => compareBasket({ items: 'salt', config, cached: true }), /needs the history store/);
});

test('a skipped site is reported with its reason and never opens a tab', async () => {
  let opened = false;
  const pool = { tab: async () => { opened = true; }, refresh: async () => {} };
  // Milkbasket was the skipped site until 2026-11-19; the behaviour stays for any site marked skip.
  const sitesImpl = { ...SITES, gone: { id: 'gone', label: 'Gone', skip: 'needs a login: guests see nothing' } };
  const [r] = await runSearch({ sites: ['gone'], queries: ['toor dal', 'sugar'], pool, sitesImpl });
  assert.equal(opened, false);
  assert.equal(r.available, false);
  assert.equal(r.errorKind, 'unserviceable');
  assert.match(r.error, /gone: skipped — needs a login/);
  assert.equal(r.failures.length, 2);
});

test('suggest finds items by any part of the text, newest first', () => {
  const { dir, store } = tmpStore();
  try {
    const add = (at, q, site, price, name) => store.recordResult(liveResult(at, site, q, { name, price, packSize: 1000, packUnit: 'g', url: 'u' }));
    add('2026-11-17T01:00:00.000Z', 'onion 1kg', 'zepto', 70, 'Onion 1 kg');
    add('2026-11-18T01:00:00.000Z', 'red onion 500g', 'zepto', 40, 'Red Onion 500 g');
    add('2026-11-18T02:00:00.000Z', 'toor dal 1kg', 'zepto', 150, 'Toor Dal 1 kg');
    assert.deepEqual(store.suggest('onion').map((r) => r.query), ['onion 1kg', 'red onion 500g'], 'prefix matches first, then others');
    assert.deepEqual(store.suggest('Toor Dal 1 kg').map((r) => r.query), ['toor dal 1kg'], 'pack spelling is folded');
    assert.deepEqual(store.suggest('zzz'), []);
    assert.equal(store.suggest('').length, 3);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('lookup answers "at what rate did I buy onion": per 100 g by site, plus the lowest rate and date', () => {
  const { dir, store } = tmpStore();
  try {
    const rec = (at, site, price, packSize) => store.recordResult(liveResult(at, site, 'onion 1kg', { name: `${site} Onion`, price, packSize, packUnit: 'g', url: `https://${site}/o` }));
    rec('2026-11-16T01:00:00.000Z', 'blinkit', 60, 1000);   // ₹6.0/100g (the low)
    rec('2026-11-18T01:00:00.000Z', 'blinkit', 69, 1000);   // ₹6.9/100g now
    rec('2026-11-18T01:00:00.000Z', 'kpn', 36, 500);        // ₹7.2/100g
    const r = store.lookup('Onion 1 kg');
    assert.equal(r.per, '100 g');
    assert.deepEqual(r.sites.map((x) => [x.site, x.rate]), [['blinkit', 6.9], ['kpn', 7.2]], 'cheapest rate first');
    const b = r.sites[0];
    assert.deepEqual([b.lastPrice, b.lowRate, b.lowSeenAt, b.seenAt], [69, 6, '2026-11-16T01:00:00.000Z', '2026-11-18T01:00:00.000Z']);
    assert.equal(store.lookup('never saved'), null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('rows far from what the other sites charge are pruned when the store opens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basket-prune-'));
  const file = join(dir, 'basket.db');
  let store = openStore(file);
  const rec = (site, price) => store.recordResult(liveResult('2026-11-18T01:00:00.000Z', site, 'amul butter 500g', { name: 'Amul Butter', price, packSize: 500, packUnit: 'g', url: 'u' }));
  rec('kpn', 309); rec('blinkit', 325); rec('instamart', 340); rec('jiomart', 79);
  store.close();
  // Pretend these rows were saved by an older version, before the price check.
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE meta SET value = '0' WHERE key = 'cleanup_version'").run();
  raw.close();
  store = openStore(file);
  try {
    assert.equal(store.latestFor('amul butter 500g', 'jiomart'), null, 'the ₹79 row is gone');
    assert.equal(store.latestFor('amul butter 500g', 'kpn').price, 309);
    assert.equal(store.historyFor('amul butter 500g').jiomart, undefined, 'and no longer a "low"');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the startup clean-up runs once per CLEANUP_VERSION, not on every open', async () => {
  const { CLEANUP_VERSION } = await import('../src/store.js');
  const dir = mkdtempSync(join(tmpdir(), 'basket-once-'));
  const file = join(dir, 'basket.db');
  let store = openStore(file);
  const rec = (site, price) => store.recordResult(liveResult('2026-11-18T01:00:00.000Z', site, 'amul butter 500g', { name: 'Amul Butter', price, packSize: 500, packUnit: 'g', url: 'u' }));
  rec('kpn', 309); rec('blinkit', 325); rec('instamart', 340); rec('jiomart', 79);
  store.close();
  store = openStore(file);
  try {
    assert.equal(store.latestFor('amul butter 500g', 'jiomart').price, 79, 'already at this version: not re-scanned');
    const v = store.db.prepare("SELECT value FROM meta WHERE key = 'cleanup_version'").get().value;
    assert.equal(v, String(CLEANUP_VERSION));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a matcher-only change (MATCH_VERSION) sets aside rows it now refuses, without re-running the outlier pass', async () => {
  const { MATCH_VERSION } = await import('../src/store.js');
  const dir = mkdtempSync(join(tmpdir(), 'basket-match-'));
  const file = join(dir, 'basket.db');
  let store = openStore(file);
  const rec = (site, name, price, packSize, packUnit) => store.recordResult(liveResult('2026-11-18T01:00:00.000Z', site, 'ghee', { name, price, packSize, packUnit, url: 'u' }));
  rec('zepto', 'Desi Farms Cow Ghee 1 L', 664, 1000, 'ml');
  rec('jiomart', 'Aavin Ghee 1 L', 690, 1000, 'ml');
  rec('instamart', 'Supreme Harvest Cow Ghee 1 ltr', 720, 1000, 'ml');
  rec('blinkit', 'Some Ghee 1 L', 200, 1000, 'ml'); // far below the others: an outlier, but not a wrong match
  store.close();
  // Rows saved by the older matcher that took KPN's laddu for ghee.
  const raw = new DatabaseSync(file);
  raw.prepare(`INSERT INTO prices (query, site, family, unit, unit_price, price, product, pack, seen_at, trigger)
    VALUES ('ghee', 'kpn', 'mass', 'g', 0.375, 75, 'Sweet Sanskriti Ghee Besan Laddu Pack 200 g', '200g', '2026-11-18T01:00:00.000Z', 'manual')`).run();
  raw.prepare("UPDATE meta SET value = '1' WHERE key = 'match_version'").run();
  raw.close();
  store = openStore(file);
  try {
    assert.equal(store.latestFor('ghee', 'kpn'), null, 'the laddu row is set aside');
    const kept = store.db.prepare("SELECT hidden FROM prices WHERE site = 'kpn' AND query = 'ghee'").get();
    assert.equal(kept.hidden, 'no-match', 'kept, marked, never deleted');
    assert.equal(store.latestFor('ghee', 'blinkit').price, 200, 'the outlier pass did not run');
    assert.equal(store.db.prepare("SELECT value FROM meta WHERE key = 'match_version'").get().value, String(MATCH_VERSION));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── Saved-item fallback and categories (2026-11-20) ─────────────────────────
const tata = (site, price) => liveResult('2026-11-20T06:00:00.000Z', site, 'tata salt 1kg', { name: 'Tata Iodised Crystal Salt 1 kg', price, packSize: 1000, packUnit: 'g', url: 'https://k/salt' });

test('"salt" and "tata salt" are answered from the saved "tata salt 1kg" (seen 2026-11-20: basket showed nothing)', async () => {
  const { dir, store } = tmpStore();
  try {
    store.recordResult(tata('kpn', 19));
    for (const items of ['salt', 'tata salt']) {
      const res = await compareBasket({ items, config: { ...config, sites: ['kpn'] }, cached: true, store });
      const line = res.platforms.find((p) => p.platform === 'kpn').lines[0];
      assert.equal(line.status, 'ok', items);
      assert.equal(line.lineTotal, 19, items);
      assert.equal(line.savedFrom, 'tata salt 1kg', items);
      assert.equal(line.cachedAt, '2026-11-20T06:00:00.000Z');
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the fallback never borrows a different kind, a different pack or a more generic line', () => {
  const { dir, store } = tmpStore();
  try {
    store.recordResult(liveResult('2026-11-20T06:00:00.000Z', 'kpn', 'black salt', { name: 'Kala Namak Black Salt 100 g', price: 30, packSize: 100, packUnit: 'g', url: 'u' }));
    assert.equal(store.savedFor('salt', 'kpn'), null, 'black salt is not salt');
    store.recordResult(tata('kpn', 19));
    assert.equal(store.savedFor('salt', 'kpn').name, 'Tata Iodised Crystal Salt 1 kg', 'the plain one, not black salt');
    assert.equal(store.savedFor('salt 2kg', 'kpn'), null, 'a different pack');
    store.recordResult(liveResult('2026-11-20T06:00:00.000Z', 'zepto', 'ghee', { name: 'Aavin Ghee 1 L', price: 690, packSize: 1000, packUnit: 'ml', url: 'u' }));
    assert.equal(store.savedFor('cow ghee 1l', 'zepto'), null, 'a more specific line gets a fresh search');
    assert.equal(store.savedFor('salt', 'zepto'), null, 'only the same site');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the site category is saved with the price and read back', () => {
  const { dir, store } = tmpStore();
  try {
    store.recordResult(liveResult('2026-11-20T06:00:00.000Z', 'bigbasket', 'toor dal 1kg', { name: 'bb Toor Dal 1 kg', price: 160, packSize: 1000, packUnit: 'g', url: 'u', category: 'Foodgrains, Oil & Masala › Dals & Pulses' }));
    assert.equal(store.latestFor('toor dal 1kg', 'bigbasket').category, 'Foodgrains, Oil & Masala › Dals & Pulses');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('prefsFor learns the usual staple category from 2+ saved rows, never a sweets one', () => {
  const { dir, store } = tmpStore();
  try {
    const rec = (at, cat, name = 'bb Toor Dal 1 kg') => store.recordResult(liveResult(at, 'bigbasket', 'toor dal 1kg', { name, price: 160, packSize: 1000, packUnit: 'g', url: 'u', category: cat }));
    rec('2026-11-18T06:00:00.000Z', 'F › Dals & Pulses');
    assert.deepEqual(store.prefsFor(['toor dal 1kg'], ['bigbasket']), { bigbasket: {} }, 'one row is not enough');
    rec('2026-11-19T06:00:00.000Z', 'F › Dals & Pulses');
    rec('2026-11-20T06:00:00.000Z', 'F › Organic Staples');
    assert.deepEqual(store.prefsFor(['toor dal 1kg'], ['bigbasket']), { bigbasket: { 'toor dal 1kg': { category: 'F › Dals & Pulses' } } });
    // What the line itself is, from the AI labels of its saved products (2+).
    store.recordResult(liveResult('2026-11-20T06:00:00.000Z', 'blinkit', 'honey', { name: 'Saffola Honey 1 kg', price: 299, packSize: 1000, packUnit: 'g', url: 'u' }));
    store.recordResult(liveResult('2026-11-20T06:00:00.000Z', 'zepto', 'honey', { name: 'Dabur Honey 1 kg', price: 320, packSize: 1000, packUnit: 'g', url: 'u' }));
    store.setGroups([{ product: 'Saffola Honey 1 kg', group: 'packaged' }]);
    assert.deepEqual(store.prefsFor(['honey'], ['blinkit']), { blinkit: {} }, 'one labelled product is not enough');
    store.setGroups([{ product: 'Dabur Honey 1 kg', group: 'packaged' }]);
    assert.deepEqual(store.prefsFor(['honey'], ['blinkit']), { blinkit: { honey: { lineGroup: 'packaged' } } });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a saved row its site files under sweets is set aside for a generic line, kept, never deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basket-cat-'));
  const file = join(dir, 'basket.db');
  let store = openStore(file);
  store.recordResult(liveResult('2026-11-19T06:00:00.000Z', 'bigbasket', 'ghee', { name: 'Ghee Mysore Delight 200 g', price: 120, packSize: 200, packUnit: 'g', url: 'u', category: 'Snacks & Branded Foods › Indian Mithai' }));
  store.recordResult(liveResult('2026-11-19T06:00:00.000Z', 'bigbasket', 'ghee', { name: 'Aavin Ghee 500 ml', price: 368, packSize: 500, packUnit: 'ml', url: 'u', category: 'Foodgrains › Edible Oils & Ghee' }));
  const before = store.db.prepare('SELECT COUNT(*) AS n FROM prices').get().n;
  store.close();
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE meta SET value = '2' WHERE key = 'match_version'").run();
  raw.close();
  store = openStore(file);
  try {
    assert.equal(store.db.prepare("SELECT hidden FROM prices WHERE product LIKE 'Ghee Mysore%'").get().hidden, 'no-match');
    assert.equal(store.db.prepare("SELECT hidden FROM prices WHERE product LIKE 'Aavin%'").get().hidden, null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM prices').get().n, before, 'row count unchanged');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
