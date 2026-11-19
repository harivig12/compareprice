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
