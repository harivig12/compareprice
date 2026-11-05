/**
 * Ranking rules. The theme: a platform must never win by failing to stock things.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { rank, pickBest, scorePlatform } from '../src/score.js';

const item = (q) => ({ raw: q, query: q, qty: 1 });
const product = (name, packSize, packUnit, price) => ({
  name, packSize, packUnit, price, mrp: null, inStock: true, url: 'x',
});

test('a complete basket beats an incomplete cheaper one', () => {
  const r = rank([
    { platform: 'zepto', total: 100, fulfilledLines: 1, totalLines: 2, complete: false, lines: [] },
    { platform: 'blinkit', total: 180, fulfilledLines: 2, totalLines: 2, complete: true, lines: [] },
  ]);
  assert.equal(r.winner.platform, 'blinkit');
  assert.equal(r.likeForLike, true);
});

test('when nobody is complete, the verdict uses only items everyone priced', () => {
  // Shipped bug: Zepto "won" a 12-item basket with 7 items found, because it
  // simply failed to return results for five of them. Ranking on raw totals
  // rewards the platform that scraped worst.
  const lines = (priced) =>
    [
      ['milk', priced.milk],
      ['butter', priced.butter],
      ['bread', priced.bread],
    ].map(([q, total]) => ({ query: q, qty: 1, status: 'ok', product: {}, lineTotal: total }));

  const scores = [
    {
      platform: 'zepto',
      // only priced milk — a tiny, cheap, mostly-empty basket
      total: 30,
      fulfilledLines: 1,
      totalLines: 3,
      complete: false,
      lines: lines({ milk: 30, butter: null, bread: null }),
    },
    {
      platform: 'blinkit',
      total: 400,
      fulfilledLines: 3,
      totalLines: 3,
      complete: false, // pretend a 4th line failed everywhere
      lines: lines({ milk: 27, butter: 310, bread: 55 }),
    },
  ];
  // Make both incomplete relative to a 4-line basket.
  for (const s of scores) s.totalLines = 4;

  const r = rank(scores);
  assert.equal(r.likeForLike, false);
  // Only "milk" is priced by both, so the verdict compares milk alone.
  assert.deepEqual(r.commonItems, ['milk']);
  assert.equal(r.winner.platform, 'blinkit', 'blinkit priced milk at 27 vs zepto 30');
  assert.ok(r.comparedOn.includes('1 of 4'));
});

test('subset saving is computed on the subset, not the full basket', () => {
  const mk = (platform, milk, butter) => ({
    platform,
    total: milk + (butter ?? 0),
    fulfilledLines: butter == null ? 1 : 2,
    totalLines: 3,
    complete: false,
    lines: [
      { query: 'milk', qty: 1, status: 'ok', product: {}, lineTotal: milk },
      { query: 'butter', qty: 1, status: 'ok', product: {}, lineTotal: butter },
    ],
  });
  const r = rank([mk('a', 100, 200), mk('b', 120, 150)]);
  // Both priced both lines, so the subset is both: a = 300, b = 270.
  assert.equal(r.winner.platform, 'b');
  assert.equal(r.winner.subsetGoods, 270);
});

test('an absurdly oversized pack is not chosen when a sane one exists', () => {
  // Shipped bug: "onion 1kg" picked a 20kg sack at ₹340 because it was the
  // best price per unit.
  const { chosen } = pickBest('onion 1kg', [
    product('Onion Loose', 20000, 'g', 340),
    product('Onion', 1000, 'g', 41),
  ]);
  assert.equal(chosen.pack.size, 1000);
});

test('an oversized pack is still used when nothing else exists', () => {
  const { chosen } = pickBest('onion 1kg', [product('Onion Sack', 20000, 'g', 340)]);
  assert.equal(chosen.pack.size, 20000, 'better than reporting nothing found');
});

test('scorePlatform reports missing lines rather than dropping them', () => {
  const score = scorePlatform('blinkit', [item('milk'), item('caviar')], {
    milk: [product('Amul Milk', 500, 'ml', 30)],
    caviar: [],
  });
  assert.equal(score.fulfilledLines, 1);
  assert.equal(score.totalLines, 2);
  assert.equal(score.complete, false);
  assert.deepEqual(score.missing.map((m) => m.query), ['caviar']);
});

test('coverage warning names the platform that stocks the most', () => {
  const mk = (platform, lines, total) => ({
    platform, total,
    fulfilledLines: lines.filter((l) => l.lineTotal != null).length,
    totalLines: 4, complete: false, lines,
  });
  const L = (q, t) => ({ query: q, qty: 1, status: 'ok', product: {}, lineTotal: t });

  // "thin" is cheaper but stocks 1 item; "wide" stocks 3.
  const r = rank([
    mk('zepto', [L('milk', 30), L('butter', null), L('bread', null)], 30),
    mk('blinkit', [L('milk', 33), L('butter', 310), L('bread', 55)], 398),
  ]);

  assert.equal(r.winner.platform, 'zepto', 'cheaper on the common item');
  assert.ok(r.coverageWarning, 'must warn that the winner covers less');
  assert.equal(r.coverageWarning.platform, 'blinkit');
  assert.equal(r.coverageWarning.fulfilledLines, 3);
  assert.equal(r.coverageWarning.winnerMissing, 3, 'zepto missed 3 of 4 lines');
});

test('no coverage warning when the winner also has the best coverage', () => {
  const L = (q, t) => ({ query: q, qty: 1, status: 'ok', product: {}, lineTotal: t });
  const r = rank([
    { platform: 'a', total: 100, fulfilledLines: 2, totalLines: 3, complete: false, lines: [L('x', 40), L('y', 60)] },
    { platform: 'b', total: 200, fulfilledLines: 1, totalLines: 3, complete: false, lines: [L('x', 200), L('y', null)] },
  ]);
  assert.equal(r.winner.platform, 'a');
  assert.equal(r.coverageWarning, null);
});
