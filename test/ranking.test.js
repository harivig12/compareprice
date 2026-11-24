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

// ── Category preference (2026-11-20): a generic line gets the raw product first ──
const withCat = (name, packSize, packUnit, price, category) => ({ ...product(name, packSize, packUnit, price), category });

test('"ghee" never picks a laddu filed under mithai, however cheap per 100 g', () => {
  const laddu = withCat('Sweet Sanskriti Ghee Delight 200 g', 200, 'g', 75, 'Snacks & Branded Foods › Indian Mithai');
  const aavin = withCat('Aavin Ghee 1 L (Carton)', 1000, 'ml', 690, 'Foodgrains, Oil & Masala › Edible Oils & Ghee › Ghee & Vanaspati');
  assert.equal(pickBest('ghee', [laddu, aavin]).chosen.name, 'Aavin Ghee 1 L (Carton)');
  // …but asking for the sweet gets it.
  const pak = withCat('Sri Krishna Ghee Mysore Pak 250 g', 250, 'g', 160, 'Snacks & Branded Foods › Indian Mithai');
  assert.equal(pickBest('ghee', [pak, aavin]).chosen.name, aavin.name);
  assert.equal(pickBest('ghee mysore pak', [pak, aavin]).chosen.name, pak.name);
});

test('a site with no category still refuses puja ghee for "ghee", by its name', () => {
  const puja = product('Shubhkart Darshana Puja Ghee Jar 500 ml', 500, 'ml', 179);
  const r = pickBest('ghee', [puja]);
  assert.equal(r.chosen, null);
  assert.equal(r.status, 'no-match');
  assert.equal(pickBest('pooja ghee', [puja]).chosen.name, puja.name);
});

test('packaged sorts after the staple, but is still returned when it is all there is', () => {
  const frozen = withCat('Daily Good Frozen Sweet Corn 500 g', 500, 'g', 60, 'Frozen Veg');
  const loose = withCat('Sweet Corn 2 pc', 700, 'g', 120, 'Fruits & Vegetables › Exotic Vegetables');
  assert.equal(pickBest('sweet corn', [frozen, loose]).chosen.name, 'Sweet Corn 2 pc');
  const only = pickBest('sweet corn', [frozen]);
  assert.equal(only.chosen.name, frozen.name);
  assert.equal(only.status, 'ok');
  // A line that names it ranks it with the staples, by price.
  assert.equal(pickBest('frozen sweet corn', [frozen, loose]).chosen.name, frozen.name);
});

test('the category this line usually lands in wins over a cheaper one elsewhere', () => {
  const organic = withCat('Organic Toor Dal 1 kg', 1000, 'g', 150, 'Foodgrains, Oil & Masala › Organic Staples › Organic Dals & Pulses');
  const usual = withCat('Tata Sampann Toor Dal 1 kg', 1000, 'g', 170, 'Foodgrains, Oil & Masala › Dals & Pulses › Toor, Channa & Moong Dal');
  assert.equal(pickBest('toor dal', [organic, usual]).chosen.name, organic.name, 'no preference: cheapest');
  assert.equal(pickBest('toor dal', [organic, usual], 1, { category: usual.category }).chosen.name, usual.name);
});

test('an AI label only demotes: the staple wins, and the demoted one stays when alone', () => {
  const masala = product('Ghee Roast Masala Mix 100 g', 100, 'g', 30);
  const ghee = product('Milky Mist Cow Ghee 1 ltr', 1000, 'ml', 724);
  const aiGroups = new Map([[masala.name, 'packaged']]);
  assert.equal(pickBest('ghee', [masala, ghee], 1, { aiGroups, lineGroup: 'staple' }).chosen.name, ghee.name);
  assert.equal(pickBest('ghee', [masala, ghee], 1, { aiGroups }).chosen.name, masala.name, 'line not known to be a staple: the AI label is ignored');
  // A product already saved for this line keeps its place, whatever the label says (brown bread, 2026-11-20).
  const britannia = product('Britannia Brown Bread 400 g', 400, 'g', 50);
  const modern = product('Modern Hi-Fiber Brown Bread 400 g', 400, 'g', 55);
  const breadAi = new Map([[britannia.name, 'packaged'], [modern.name, 'staple']]);
  assert.equal(pickBest('brown bread 400g', [britannia, modern], 1, { aiGroups: breadAi, lineGroup: 'staple', saved: new Set([britannia.name, modern.name]) }).chosen.name, britannia.name);
  assert.equal(pickBest('brown bread 400g', [britannia, modern], 1, { aiGroups: breadAi, lineGroup: 'staple', saved: new Set([modern.name]) }).chosen.name, modern.name, 'a new one is demoted');
  const sweetLime = product('Sweet Lime (Mosambi) 1 kg', 1000, 'g', 90);
  const r = pickBest('mosambi', [sweetLime], 1, { aiGroups: new Map([[sweetLime.name, 'sweets']]) });
  assert.equal(r.chosen?.name, sweetLime.name, 'a wrong AI label never refuses');
});

test('a kind that is normal for the line is not demoted: the cheaper labelled honey still wins (seen 2026-11-20)', () => {
  const saffola = product('Saffola Honey 1 kg', 1000, 'g', 299);
  const other = product('Brand X Honey 1 kg', 1000, 'g', 350);
  const aiGroups = new Map([[saffola.name, 'packaged']]);
  assert.equal(pickBest('honey', [saffola, other], 1, { aiGroups, lineGroup: 'staple' }).chosen.name, other.name, 'on a line known to be a staple: demoted');
  assert.equal(pickBest('honey', [saffola, other], 1, { aiGroups, lineGroup: 'packaged' }).chosen.name, saffola.name);
  assert.equal(pickBest('honey', [saffola, other], 1, { aiGroups }).chosen.name, saffola.name, 'line kind unknown: ignored');
  // It never lets a sweet through: refusal is by words and site category only.
  const laddu = product('Ghee Besan Laddu 200 g', 200, 'g', 75);
  assert.equal(pickBest('ghee', [laddu], 1, { lineGroup: 'sweets' }).chosen, null);
});

test('scorePlatform passes the learned category and keeps the product category', () => {
  const organic = withCat('Organic Toor Dal 1 kg', 1000, 'g', 150, 'X › Organic');
  const usual = withCat('Tata Toor Dal 1 kg', 1000, 'g', 170, 'X › Dals');
  const s = scorePlatform('bigbasket', [item('toor dal')], { 'toor dal': [organic, usual] }, {}, { prefs: { 'toor dal': { category: 'X › Dals' } } });
  assert.equal(s.lines[0].product.name, usual.name);
  assert.equal(s.lines[0].product.category, 'X › Dals');
});
