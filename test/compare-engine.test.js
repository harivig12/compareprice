import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareBasket } from '../src/compare.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const row = (name, price, packSize = 1000, packUnit = 'g') => ({ name, packSize, packUnit, price, mrp: null, inStock: true, url: 'https://x/y' });
const config = { ...DEFAULT_CONFIG, sites: ['a1', 'a2'] };

function fakeSearch(resultsBySite) {
  return async ({ sites, queries, onProgress }) =>
    sites.map((site) => {
      queries.forEach((query, i) => onProgress?.({ type: 'query', site, query, index: i + 1, total: queries.length }));
      const r = resultsBySite[site];
      if (r instanceof Error) {
        return {
          platform: site, available: false, error: `${queries[0]}: ${r.message}`, errorKind: r.kind, partialFailures: [],
          resultsByQuery: Object.fromEntries(queries.map((q) => [q, []])), failures: queries.map((q) => ({ query: q, kind: r.kind, message: r.message })),
        };
      }
      return { platform: site, available: true, error: null, errorKind: null, partialFailures: [], failures: [], resultsByQuery: r };
    });
}

test('engine path: ranks, keeps a failed site in the table with its error kind, uses config location', async () => {
  const blocked = Object.assign(new Error('bigbasket: bot protection page "Access Denied"'), { kind: 'blocked' });
  const events = [];
  const res = await compareBasket({
    items: 'toor dal 1kg',
    platforms: ['instamart', 'zepto', 'bigbasket'],
    config,
    pool: {},
    onProgress: (e) => events.push(e),
    search: fakeSearch({
      instamart: { 'toor dal 1kg': [row('Fortune Toor Dal 1 kg', 195)] },
      zepto: { 'toor dal 1kg': [row('BestValue Toor Dal 1 kg', 154)] },
      bigbasket: blocked,
    }),
  });
  assert.equal(res.backend, 'engine');
  assert.equal(res.pincode, '600045');
  assert.equal(res.locationLabel, 'Marutham Prestige');
  assert.equal(res.winner.platform, 'zepto');
  assert.equal(res.winner.label, 'Zepto');
  assert.equal(res.runnerUp.platform, 'instamart');
  const bb = res.platforms.find((p) => p.platform === 'bigbasket');
  assert.ok(bb, 'failed site stays in the table');
  assert.equal(bb.failed, true);
  assert.equal(bb.errorKind, 'blocked');
  assert.match(bb.error, /Access Denied/);
  assert.deepEqual(res.unavailable.map((u) => [u.platform, u.errorKind]), [['bigbasket', 'blocked']]);
  assert.equal(res.labels.bigbasket, 'BigBasket');
  assert.equal(events.filter((e) => e.type === 'query').length, 3);
});

test('unknown platform names are rejected with the list of valid ones', async () => {
  await assert.rejects(
    () => compareBasket({ items: 'salt', platforms: ['nosuch'], config, pool: {}, search: fakeSearch({}) }),
    /Unknown platform\(s\): nosuch\. Available: .*instamart/,
  );
});

// ---- Instamart searched per account (spec 2026-11-19-accounts-deals) ----
function accountsFake(list) {
  return {
    signedIn: (site) => (site === 'instamart' ? list : []),
    labels: () => ({ names: Object.fromEntries(list.map((a) => [a.id, a.name])), hints: {} }),
  };
}
const poolSetFake = (log) => ({ with: async (site, acc, fn) => { log.push(`${site}:${acc.id}`); return fn({ account: acc.id }); } });

test('instamart rows from two accounts merge; the cheaper account wins the line; hover lists both', async () => {
  const used = [];
  const res = await compareBasket({
    items: 'toor dal 1kg',
    platforms: ['instamart', 'zepto'],
    config,
    pool: { account: 'main' },
    accounts: accountsFake([{ id: 'main', name: 'Main' }, { id: 'a2', name: 'Amma' }]),
    poolSet: poolSetFake(used),
    search: async ({ sites, queries, pool }) => sites.map((site) => ({
      platform: site, available: true, error: null, errorKind: null, partialFailures: [], failures: [],
      resultsByQuery: { [queries[0]]: [row('Basic Toor Dal 1 kg', site === 'zepto' ? 170 : pool.account === 'a2' ? 154 : 159)] },
    })),
  });
  assert.deepEqual(used, ['instamart:a2'], 'only the extra account needs its own browser; zepto is never searched per account');
  const im = res.platforms.find((p) => p.platform === 'instamart');
  assert.equal(im.lines[0].lineTotal, 154);
  assert.equal(im.lines[0].product.account, 'a2');
  assert.deepEqual(im.lines[0].accountPrices, [{ account: 'a2', name: 'Amma', price: 154 }, { account: 'main', name: 'Main', price: 159 }]);
  assert.equal(res.winner.platform, 'instamart');
});

test('an extra account in cool-down is a partial failure naming it; the main account\'s prices count', async () => {
  const res = await compareBasket({
    items: 'toor dal 1kg',
    platforms: ['instamart'],
    config,
    pool: { account: 'main' },
    accounts: accountsFake([{ id: 'main', name: 'Main' }, { id: 'a2', name: 'Amma' }]),
    poolSet: poolSetFake([]),
    search: async ({ sites, queries, pool }) => sites.map((site) => (pool.account === 'a2'
      ? { platform: site, available: false, error: `${queries[0]}: instamart: rate limited`, errorKind: 'blocked', partialFailures: [], resultsByQuery: { [queries[0]]: [] }, failures: [{ query: queries[0], kind: 'blocked', message: 'instamart: rate limited' }] }
      : { platform: site, available: true, error: null, errorKind: null, partialFailures: [], failures: [], resultsByQuery: { [queries[0]]: [row('Basic Toor Dal 1 kg', 159)] } })),
  });
  const im = res.platforms[0];
  assert.equal(im.lines[0].lineTotal, 159);
  assert.equal(im.lines[0].product.account, 'main');
  assert.equal(im.failed, undefined);
  assert.match(im.partialFailures[0], /instamart: rate limited \(account "Amma"\)/);
});

test('an extra account signed out is a session error for that account only; a broken extra browser too', async () => {
  const res = await compareBasket({
    items: 'toor dal 1kg',
    platforms: ['instamart'],
    config,
    pool: { account: 'main' },
    accounts: accountsFake([{ id: 'main', name: 'Main' }, { id: 'a2', name: 'Amma' }]),
    poolSet: { with: async () => { const e = new Error('instamart: account is signed out, sign in again'); e.kind = 'session'; throw e; } },
    search: async ({ sites, queries }) => sites.map((site) => ({ platform: site, available: true, error: null, errorKind: null, partialFailures: [], failures: [], resultsByQuery: { [queries[0]]: [row('Basic Toor Dal 1 kg', 159)] } })),
  });
  assert.equal(res.platforms[0].lines[0].lineTotal, 159);
  assert.match(res.platforms[0].partialFailures[0], /signed out.*\(account "Amma"\)/);
});

test('milkbasket searches only the main account, even with extra accounts', async () => {
  const used = [];
  await compareBasket({
    items: 'toor dal 1kg',
    platforms: ['milkbasket'],
    config,
    pool: {},
    accounts: { signedIn: () => [{ id: 'main', name: 'Main' }, { id: 'a2', name: 'Amma' }], labels: () => ({ names: {}, hints: {} }) },
    poolSet: poolSetFake(used),
    search: async ({ sites, queries }) => sites.map((site) => ({ platform: site, available: true, error: null, errorKind: null, partialFailures: [], failures: [], resultsByQuery: { [queries[0]]: [] } })),
  });
  assert.deepEqual(used, []);
});

test('a ₹1 deal among the candidates becomes a deal and never lowers the total', async () => {
  const res = await compareBasket({
    items: 'tomato 1kg',
    platforms: ['instamart', 'zepto', 'bigbasket'],
    config,
    pool: {},
    search: fakeSearch({
      instamart: { 'tomato 1kg': [row('Tomato Hybrid 1 kg', 32), { ...row('Tomato Desi 1 kg', 1), mrp: 78 }] },
      zepto: { 'tomato 1kg': [row('Tomato Hybrid 1 kg', 34)] },
      bigbasket: { 'tomato 1kg': [row('Tomato Local 1 kg', 36)] },
    }),
  });
  assert.equal(res.platforms.find((p) => p.platform === 'instamart').lines[0].lineTotal, 32, 'the ₹1 row is left out by the price check');
  assert.deepEqual(res.deals.map((d) => [d.site, d.product, d.price, d.mrp, d.pct]), [['instamart', 'Tomato Desi 1 kg', 1, 78, 98.7]]);
});
