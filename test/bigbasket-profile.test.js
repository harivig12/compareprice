/**
 * BigBasket in a Chrome of its own (headless first, headed after two bot
 * walls in a row) and its deal storefronts. Offline: every browser is fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { BrowserMode, WALLS_BEFORE_HEADED } from '../src/engine/browser-mode.js';
import { BrowserPool, SitePools, OWN_PORTS } from '../src/engine/pool.js';
import { OWN_PROFILES, openAccounts, MAIN } from '../src/engine/accounts.js';
import { headedEnv, _resetDisplay } from '../src/engine/display.js';
import bigbasket, { storefrontSlugs, parseOffers, STOREFRONTS, STOREFRONT_MAX_PAGES } from '../src/engine/sites/bigbasket.js';
import { checkOffers, OFFER_SITES } from '../src/offers.js';
import { toDeal } from '../src/deals.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/sites/bigbasket-ok.json', import.meta.url), 'utf8'));

// ───────────────────────── headless / headed ─────────────────────────

test('BrowserMode: headless until two walls in a row, then headed and kept in the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jhola-mode-'));
  try {
    const file = join(dir, 'browser-mode.json');
    const m = new BrowserMode({ file, now: () => new Date('2026-11-24T10:00:00Z'), log: () => {} });
    assert.equal(WALLS_BEFORE_HEADED, 2);
    assert.equal(m.headless('bigbasket'), true);
    assert.equal(m.walled('bigbasket', 'Access Denied'), false);
    m.clear('bigbasket');
    assert.equal(m.walled('bigbasket', 'Access Denied'), false, 'a clean load in between resets the count');
    assert.equal(m.walled('bigbasket', 'Access Denied'), true, 'second wall in a row switches');
    assert.equal(m.headless('bigbasket'), false);
    assert.equal(m.walled('bigbasket', 'again'), false, 'already headed: nothing more to switch');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.bigbasket.mode, 'headed');
    assert.equal(saved.bigbasket.since, '2026-11-24T10:00:00.000Z');
    assert.match(saved.bigbasket.reason, /2 bot walls in a row/);
    assert.equal(new BrowserMode({ file, log: () => {} }).headless('bigbasket'), false, 'a restart keeps headed');
    writeFileSync(file, JSON.stringify({ bigbasket: { mode: 'headless' } }));
    assert.equal(new BrowserMode({ file, log: () => {} }).headless('bigbasket'), true, 'editing the file goes back');
    assert.equal(new BrowserMode({ file: join(dir, 'missing.json'), log: () => {} }).headless('zepto'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fakeTab({ walled = () => false } = {}) {
  return {
    alive: true, onCrash() {}, async setUserAgent() {}, async setCookies() {}, async goto() {}, async send() {},
    async evaluate() { return walled() ? { title: 'Access Denied', text: 'Reference #18.abc' } : { title: 'bigbasket', text: '' }; },
    async close() { this.alive = false; },
  };
}

test('pool: two walled page loads relaunch the site\'s Chrome headed', async () => {
  const mode = new BrowserMode({ log: () => {} });
  const launches = [];
  let wall = true;
  const pool = new BrowserPool({
    launch: async (o) => { launches.push(o); return { endpoint: 'x', userAgent: 'UA', close: async () => {} }; },
    openTab: async () => fakeTab({ walled: () => wall }),
    sites: { bigbasket: { id: 'bigbasket', origin: 'https://bb/' } },
    headless: () => mode.headless('bigbasket'),
    wallWatch: { walled: (s, msg) => mode.walled(s, msg), clear: (s) => mode.clear(s) },
  });
  await assert.rejects(pool.tab('bigbasket'), (e) => e.kind === 'blocked');
  await assert.rejects(pool.tab('bigbasket'), (e) => e.kind === 'blocked');
  assert.deepEqual(launches.map((o) => o.headless), [true], 'one headless Chrome so far');
  wall = false;
  await pool.tab('bigbasket');
  assert.deepEqual(launches.map((o) => o.headless), [true, false], 'relaunched headed');
  assert.equal(mode.status('bigbasket').mode, 'headed');
});

test('pool: a clean load between walls keeps it headless', async () => {
  const mode = new BrowserMode({ log: () => {} });
  const launches = [];
  const walls = [true, false, true];
  let tab;
  const pool = new BrowserPool({
    launch: async (o) => { launches.push(o); return { endpoint: 'x', userAgent: 'UA', close: async () => {} }; },
    openTab: async () => (tab = fakeTab({ walled: () => walls[0] })),
    sites: { bigbasket: { id: 'bigbasket', origin: 'https://bb/' } },
    headless: () => mode.headless('bigbasket'),
    wallWatch: { walled: (s, msg) => mode.walled(s, msg), clear: (s) => mode.clear(s) },
  });
  await assert.rejects(pool.tab('bigbasket'));
  walls.shift();
  await pool.tab('bigbasket');
  walls.shift();
  await assert.rejects(pool.refresh('bigbasket'), (e) => e.kind === 'blocked');
  assert.ok(tab);
  assert.equal(mode.headless('bigbasket'), true);
  assert.deepEqual(launches.map((o) => o.headless), [true]);
});

test('SitePools: BigBasket goes to its own Chrome, every other site to the main one', async () => {
  const calls = [];
  const fake = (name) => ({
    name, location: { pincode: '600045' }, profileDir: `/d/${name}`, blockMedia: true, ownLocation: null, open: name === 'own',
    isOpen() { return this.open; },
    async tab(s) { calls.push([name, 'tab', s]); return name; },
    async refresh(s) { calls.push([name, 'refresh', s]); },
    async loginTab(s) { calls.push([name, 'loginTab', s]); return name; },
    async releaseLoginTab(s) { calls.push([name, 'release', s]); },
    async clearSiteData(s) { calls.push([name, 'clear', s]); },
    async closeTab(s) { calls.push([name, 'close', s]); },
    setLocation(l) { calls.push([name, 'loc', l.pincode]); },
    async restart() { calls.push([name, 'restart']); },
    async close() { calls.push([name, 'shut']); },
  });
  const p = new SitePools({ main: fake('main'), own: { bigbasket: fake('own') } });
  assert.equal(await p.tab('bigbasket'), 'own');
  assert.equal(await p.tab('zepto'), 'main');
  assert.equal(await p.loginTab('bigbasket'), 'own');
  await p.refresh('instamart');
  await p.clearSiteData('bigbasket', ['https://www.bigbasket.com']);
  assert.deepEqual(calls.splice(0), [['own', 'tab', 'bigbasket'], ['main', 'tab', 'zepto'], ['own', 'loginTab', 'bigbasket'], ['main', 'refresh', 'instamart'], ['own', 'clear', 'bigbasket']]);
  assert.equal(p.isOpen(), true, 'open when any Chrome is');
  p.blockMedia = false;
  assert.equal(p.main.blockMedia, false);
  assert.equal(p.own.bigbasket.blockMedia, false);
  p.setLocation({ pincode: '560001' });
  await p.restart();
  assert.deepEqual(calls.map((c) => c.join(' ')).sort(), ['main loc 560001', 'main restart', 'own loc 560001', 'own restart']);
  assert.equal(p.profileDir, '/d/main');
});

test('BigBasket\'s main account lives in profiles/bigbasket, on its own port', () => {
  assert.deepEqual(OWN_PROFILES, { bigbasket: 'profiles/bigbasket' });
  assert.equal(OWN_PORTS.bigbasket, 9350);
  const dir = mkdtempSync(join(tmpdir(), 'jhola-acc-'));
  try {
    const acc = openAccounts(join(dir, 'accounts.json'));
    assert.equal(acc.get('bigbasket', MAIN).profile, 'profiles/bigbasket');
    assert.equal(acc.get('zepto', MAIN).profile, 'chrome-profile');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('headedEnv: a desktop or another OS needs nothing; a Linux server gets Xvfb on :99', async () => {
  _resetDisplay();
  const env = { PATH: '/bin' };
  assert.equal(await headedEnv({ platform: 'win32', env }), env);
  assert.equal(await headedEnv({ platform: 'linux', env: { DISPLAY: ':0' } }).then((e) => e.DISPLAY), ':0');
  const spawned = [];
  const spawn = (cmd, args) => { spawned.push([cmd, ...args]); const p = new EventEmitter(); p.kill = () => {}; return p; };
  const out = await headedEnv({ platform: 'linux', env, spawn, socketExists: () => true });
  assert.equal(out.DISPLAY, ':99');
  assert.equal(out.PATH, '/bin');
  await headedEnv({ platform: 'linux', env, spawn, socketExists: () => true });
  assert.equal(spawned.length, 1, 'started once per process');
  assert.equal(spawned[0][0], 'Xvfb');
  _resetDisplay();
});

test('headedEnv: a missing Xvfb says how to install it', async () => {
  _resetDisplay();
  const spawn = () => {
    const p = new EventEmitter();
    p.kill = () => {};
    setImmediate(() => p.emit('error', Object.assign(new Error('spawn Xvfb ENOENT'), { code: 'ENOENT' })));
    return p;
  };
  await assert.rejects(headedEnv({ platform: 'linux', env: {}, spawn, socketExists: () => false, waitMs: 2000 }), /apt-get install xvfb/);
  _resetDisplay();
});

// ───────────────────────── storefronts ─────────────────────────

test('storefrontSlugs: the known six, plus home-page links with a known name and a new id', () => {
  const base = storefrontSlugs([]);
  assert.equal(base.length, 6);
  assert.deepEqual(base.map((s) => s.slug), STOREFRONTS.map((s) => s.slug));
  const more = storefrontSlugs(['/sp/2399999-deals-week/', '/sp/2311728-deals-week/?nc=hp', '/sp/123-amul-brand-store/', 'https://www.bigbasket.com/sp/2400000-the-30-corner/', null]);
  assert.deepEqual(more.slice(6), [{ slug: '2399999-deals-week', title: 'Deals of the Week' }, { slug: '2400000-the-30-corner', title: 'The ₹30 Corner' }]);
  assert.ok(!more.some((s) => s.slug.includes('amul')), 'brand stores are not deal storefronts');
});

test('parseOffers: the buy limit and deal type come along; no limit (9999999) is left out', () => {
  const j = fixture();
  const [p0, p1] = j.tabs[0].product_info.products;
  p0.pricing.discount.camp_detail.narq = 3;
  p0.pricing.discount.deal_type = 'price_drop';
  p1.pricing.discount.camp_detail.narq = 9999999;
  const rows = parseOffers(j);
  assert.equal(rows[0].maxQty, 3);
  assert.equal(rows[0].dealType, 'price_drop');
  assert.equal(rows[1].maxQty, undefined);
  assert.equal(rows[1].dealType, undefined);
  assert.equal(rows.length, bigbasket.parse(fixture()).length, 'the same products as a search reads');
});

/** A tab whose fetches answer per storefront slug and page. */
function storefrontTab(pagesBySlug, hrefs = []) {
  const urls = [];
  return {
    urls,
    async evaluate(expr) {
      if (expr.includes('a[href*="/sp/"]')) return hrefs;
      const url = /"url":"([^"]+)"/.exec(expr)[1];
      urls.push(url);
      const u = new URL(url, 'https://www.bigbasket.com');
      const slug = u.searchParams.get('slug');
      const page = Number(u.searchParams.get('page'));
      const pages = pagesBySlug[slug];
      if (!pages) return { status: 204, contentType: '', text: '', ms: 1 };
      return { status: 200, contentType: 'application/json', text: JSON.stringify(pages(page)), ms: 1 };
    },
  };
}

function listing({ title, pages, products }) {
  return { screen_info: { title }, tabs: [{ product_info: { page: 1, number_of_pages: pages, total_count: products.length * pages, products } }] };
}

test('offers(): every page of every storefront, paced, grouped by storefront title', async () => {
  const prods = fixture().tabs[0].product_info.products.slice(0, 2);
  const tab = storefrontTab({
    '2311728-deals-week': () => listing({ title: 'Deals of the Week', pages: 3, products: prods }),
    '2310048-big-pack-discount': () => listing({ title: 'Big Pack Discount', pages: 1, products: prods.slice(0, 1) }),
  });
  let acquired = 0;
  const out = await bigbasket.offers(tab, { acquire: async () => { acquired++; } });
  const deals = tab.urls.filter((u) => u.includes('deals-week'));
  assert.deepEqual(deals.map((u) => new URL(u, 'https://x').searchParams.get('page')), ['1', '2', '3']);
  assert.ok(tab.urls.every((u) => u.startsWith('/listing-svc/v2/products?type=sis&slug=')));
  assert.equal(acquired, tab.urls.length, 'each call waits its turn');
  assert.equal(out.rows.length, 3 * 2 + 1);
  assert.deepEqual([...new Set(out.rows.map((r) => r.conditions.storefront))], ['Deals of the Week', 'Big Pack Discount']);
  assert.match(out.note, /Buy More Save More: nothing listed/);
});

test('offers(): a long storefront stops at the page cap and says so', async () => {
  const prods = fixture().tabs[0].product_info.products.slice(0, 1);
  const tab = storefrontTab({ '2306008-combos': () => listing({ title: 'Combos', pages: 25, products: prods }) });
  const out = await bigbasket.offers(tab);
  assert.equal(tab.urls.filter((u) => u.includes('2306008-combos')).length, STOREFRONT_MAX_PAGES);
  assert.match(out.note, new RegExp(`Combos: first ${STOREFRONT_MAX_PAGES} of 25 pages`));
});

test('offers(): a bot wall on a storefront is a blocked failure, not an empty list', async () => {
  const tab = { async evaluate(expr) { return expr.includes('a[href') ? [] : { status: 403, contentType: 'text/html', text: '<html>Access Denied</html>', ms: 1 }; } };
  await assert.rejects(bigbasket.offers(tab), (e) => e.kind === 'blocked' && /^bigbasket: 403/.test(e.message));
});

test('the offer check keeps every BigBasket discount (not just 80%+) with its storefront', async () => {
  assert.ok(OFFER_SITES.includes('bigbasket'));
  const rows = [
    { name: 'Diaper Pants 30 pcs', price: 299, mrp: 499, inStock: true, maxQty: 3, conditions: { storefront: 'Deals of the Week' } },
    { name: 'Baby Oil 500 ml', price: 389, mrp: 580, inStock: true, conditions: { storefront: 'Deals of the Week', dealType: 'price_drop' } },
    { name: 'No Discount Rice 5 kg', price: 400, mrp: null, inStock: true, conditions: { storefront: 'Big Pack Discount' } },
    { name: 'Sold Out Ghee 1 l', price: 500, mrp: 700, inStock: false, conditions: { storefront: 'Big Pack Discount' } },
  ];
  const recorded = [];
  const accounts = { signedIn: () => [], get: (site, id) => ({ id, name: 'Main', profile: 'profiles/bigbasket' }) };
  const poolSet = { with: async (site, acc, fn) => fn({ tab: async () => 'tab' }) };
  const sitesImpl = { bigbasket: { ...bigbasket, offers: async (tab, ctx) => { assert.equal(typeof ctx.acquire, 'function'); return { rows }; } } };
  const out = await checkOffers({ poolSet, accounts, sitesImpl, sites: ['bigbasket'], store: { recordDeals: (d, o) => recorded.push([d, o]) } });
  assert.equal(out.offers[0].deals, 2);
  const [deals, opts] = recorded[0];
  assert.equal(opts.source, 'feed');
  assert.deepEqual(deals.map((d) => [d.product, d.pct, d.conditions]), [
    ['Diaper Pants 30 pcs', 40.1, { storefront: 'Deals of the Week', maxQty: 3 }],
    ['Baby Oil 500 ml', 32.9, { storefront: 'Deals of the Week', dealType: 'price_drop' }],
  ]);
});

test('toDeal: a row\'s own conditions join the check\'s', () => {
  const d = toDeal({ name: 'x', price: 1, mrp: 10, maxQty: 2, conditions: { storefront: 'Combos' } }, { site: 'bigbasket', conditions: { minBasket: 99 } });
  assert.deepEqual(d.conditions, { minBasket: 99, storefront: 'Combos', maxQty: 2 });
});

test('store: BigBasket storefront deals come out as one group per storefront, any discount', async () => {
  const { openStore } = await import('../src/store.js');
  const s = openStore(':memory:');
  try {
    const t0 = '2026-11-24T01:30:00.000Z';
    const row = (name, price, mrp, conditions) => toDeal({ name, price, mrp, conditions }, { site: 'bigbasket', source: 'feed', seenAt: t0 });
    s.recordDeals([
      row('Diaper Pants 30 pcs', 299, 499, { storefront: 'Deals of the Week', maxQty: 3 }),
      row('Baby Oil 500 ml', 389, 580, { storefront: 'Deals of the Week', maxQty: 3 }),
      row('Rice 5 kg', 400, 520, { storefront: 'Big Pack Discount' }),
    ], { site: 'bigbasket', account: 'main', source: 'feed', checkedAt: t0 });
    s.recordDeals([toDeal({ name: 'Tomato', price: 1, mrp: 78 }, { site: 'milkbasket', source: 'feed', seenAt: t0 })], { site: 'milkbasket', account: 'main', source: 'feed', checkedAt: t0 });
    const cur = s.currentDeals({ now: Date.parse(t0) + 60_000 });
    const bb = cur.groups.filter((g) => g.site === 'bigbasket');
    assert.deepEqual(bb.map((g) => g.storefront), ['Deals of the Week', 'Big Pack Discount'], 'no empty plain group');
    assert.ok(bb.every((g) => g.anyDiscount === true));
    assert.deepEqual(bb[0].conditions, { maxQty: 3 }, 'shared limit on the heading; the storefront is the group');
    assert.deepEqual(bb[0].deals.map((d) => d.product), ['Diaper Pants 30 pcs', 'Baby Oil 500 ml'], 'biggest discount first');
    assert.equal(bb[1].conditions, null);
    const mb = cur.groups.find((g) => g.site === 'milkbasket');
    assert.equal(mb.storefront, undefined);
    assert.equal(mb.anyDiscount, undefined);
    // A check that found nothing still shows the site as checked.
    s.recordDeals([], { site: 'bigbasket', account: 'main', source: 'feed', checkedAt: '2026-11-24T12:30:00.000Z' });
    const empty = s.currentDeals({}).groups.filter((g) => g.site === 'bigbasket');
    assert.equal(empty.length, 1);
    assert.equal(empty[0].deals.length, 0);
  } finally {
    s.close();
  }
});

test('offers(): an ended storefront (a general listing titled "bigbasket") is skipped after one call', async () => {
  const prods = fixture().tabs[0].product_info.products.slice(0, 2);
  const tab = storefrontTab({
    '2310049-combos': () => listing({ title: 'bigbasket', pages: 60, products: prods }),
    '2306008-combos': () => listing({ title: 'Combos', pages: 1, products: prods }),
  });
  const out = await bigbasket.offers(tab);
  assert.equal(tab.urls.filter((u) => u.includes('2310049-combos')).length, 1);
  assert.ok(out.rows.every((r) => r.conditions.storefront === 'Combos'));
  assert.match(out.note, /2310049-combos: not a deal storefront any more/);
  assert.doesNotMatch(out.note, /bigbasket: first/);
});
