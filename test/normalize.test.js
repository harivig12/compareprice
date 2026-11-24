import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePack, matchConfidence, annotate } from '../src/normalize.js';
import { resolveBasket, parseLine } from '../src/resolver.js';
import { pickBest, scorePlatform, rank } from '../src/score.js';

test('pack parsing normalizes to g / ml / piece', () => {
  assert.deepEqual(pick(parsePack('500ml')), { size: 500, unit: 'ml' });
  assert.deepEqual(pick(parsePack('500 ML')), { size: 500, unit: 'ml' });
  assert.deepEqual(pick(parsePack('0.5 L')), { size: 500, unit: 'ml' });
  assert.deepEqual(pick(parsePack('1 litre')), { size: 1000, unit: 'ml' });
  assert.deepEqual(pick(parsePack('1kg')), { size: 1000, unit: 'g' });
  assert.deepEqual(pick(parsePack('250 gm')), { size: 250, unit: 'g' });
  assert.deepEqual(pick(parsePack('6 pcs')), { size: 6, unit: 'piece' });
  assert.deepEqual(pick(parsePack('1 dozen')), { size: 12, unit: 'piece' });
});

test('multipacks multiply out', () => {
  assert.deepEqual(pick(parsePack('2 x 250ml')), { size: 500, unit: 'ml' });
  assert.deepEqual(pick(parsePack('2x250ml')), { size: 500, unit: 'ml' });
  assert.deepEqual(pick(parsePack('6 x 1 L')), { size: 6000, unit: 'ml' });
  assert.deepEqual(pick(parsePack('4 × 100 g')), { size: 400, unit: 'g' });
});

test('kg beats g when both could match', () => {
  // Longest-first alternation: "1kg" must not parse as "1 g".
  assert.equal(parsePack('1kg').size, 1000);
  assert.equal(parsePack('1kg').unit, 'g');
});

test('no pack info returns null rather than guessing', () => {
  assert.equal(parsePack('brown bread'), null);
  assert.equal(parsePack(''), null);
  assert.equal(parsePack(null), null);
});

test('mass vs volume comparison is REFUSED, not scored', () => {
  const result = matchConfidence('amul butter 500g', {
    name: 'Amul Butter 500 ml',
    packSize: 500,
    packUnit: 'ml',
    price: 260,
  });
  assert.equal(result.refused, true);
  assert.equal(result.score, 0);
  assert.match(result.reason, /unit family mismatch/);
});

test('same product at a different pack size stays comparable', () => {
  // 450g vs 500g of the same thing is exactly what price-per-unit is for.
  const result = matchConfidence('amul taaza toned milk 500ml', {
    name: 'Amul Taaza Toned Milk 450 ml',
    packSize: 450,
    packUnit: 'ml',
    price: 25,
  });
  assert.equal(result.refused, false);
  assert.ok(result.score > 0.55, `expected confident match, got ${result.score}`);
});

test('variant mismatch drags confidence below threshold', () => {
  const toned = matchConfidence('amul toned milk 500ml', {
    name: 'Amul Full Cream Milk 500 ml',
    packSize: 500,
    packUnit: 'ml',
    price: 33,
  });
  const matching = matchConfidence('amul toned milk 500ml', {
    name: 'Amul Toned Milk 500 ml',
    packSize: 500,
    packUnit: 'ml',
    price: 27,
  });
  assert.ok(
    toned.score < matching.score,
    `variant mismatch (${toned.score}) should score below match (${matching.score})`,
  );
  assert.match(toned.reason, /variant mismatch/);
});

test('price per unit is computed on the normalized size', () => {
  const a = annotate('amul milk 1L', {
    name: 'Amul Milk 1 L',
    packSize: 1,
    packUnit: 'l',
    price: 60,
    inStock: true,
    url: 'x',
  });
  assert.equal(a.pack.size, 1000);
  assert.equal(a.pack.unit, 'ml');
  assert.equal(a.pricePerUnit, 0.06);
  assert.equal(a.pricePerUnitLabel, '₹6.00 / 100ml');
});

test('resolver reads quantities without eating pack sizes', () => {
  assert.deepEqual(strip(parseLine('2x amul milk 500ml')), { query: 'amul milk 500ml', qty: 2 });
  assert.deepEqual(strip(parseLine('2 x amul milk 500ml')), { query: 'amul milk 500ml', qty: 2 });
  assert.deepEqual(strip(parseLine('3 maggi noodles')), { query: 'maggi noodles', qty: 3 });
  assert.deepEqual(strip(parseLine('amul butter 500g')), { query: 'amul butter 500g', qty: 1 });
  // A leading number that is a pack size, not a quantity.
  assert.deepEqual(strip(parseLine('500 ml milk')), { query: '500 ml milk', qty: 1 });
  // Too large to be a basket quantity.
  assert.deepEqual(strip(parseLine('400 g bread')), { query: '400 g bread', qty: 1 });
});

test('resolver skips blanks and comments', () => {
  const items = resolveBasket('# a comment\n\namul milk 500ml\n   \nbread\n');
  assert.equal(items.length, 2);
  assert.equal(items[0].query, 'amul milk 500ml');
  assert.equal(items[1].query, 'bread');
});

test('pickBest prefers in-stock and the cheapest way to buy the amount asked for', () => {
  const { chosen } = pickBest('amul toned milk 500ml', [
    { name: 'Amul Toned Milk 500 ml', packSize: 500, packUnit: 'ml', price: 30, inStock: false, url: 'a' },
    { name: 'Amul Toned Milk 1 L', packSize: 1, packUnit: 'l', price: 54, inStock: true, url: 'b' },
    { name: 'Amul Toned Milk 500 ml', packSize: 500, packUnit: 'ml', price: 29, inStock: true, url: 'c' },
  ]);
  // Asked for 500 ml: ₹29 for 500 ml is the cheapest way to get that. The 1 L at
  // ₹54 is a cheaper rate but a bigger purchase (2×), so it is not the answer.
  assert.equal(chosen.url, 'c');
});

test('out-of-stock line is reported, not silently dropped', () => {
  const items = [{ raw: 'x', query: 'amul toned milk 500ml', qty: 1 }];
  const score = scorePlatform('blinkit', items, { 'amul toned milk 500ml': [] });
  assert.equal(score.fulfilledLines, 0);
  assert.equal(score.complete, false);
  assert.equal(score.missing.length, 1);
  assert.equal(score.missing[0].status, 'no-results');
});

test('an incomplete basket does not win on price alone', () => {
  const cheapButIncomplete = {
    platform: 'zepto', total: 100, fulfilledLines: 1, totalLines: 2, complete: false,
  };
  const dearerButComplete = {
    platform: 'blinkit', total: 180, fulfilledLines: 2, totalLines: 2, complete: true,
  };
  const result = rank([cheapButIncomplete, dearerButComplete]);
  assert.equal(result.winner.platform, 'blinkit');
});

function pick(p) {
  return p ? { size: p.size, unit: p.unit } : null;
}
function strip(p) {
  return p ? { query: p.query, qty: p.qty } : null;
}

test('size-first multipacks multiply: "80g x4" is 320 g, and the rate is per 100 g of the total', async () => {
  const { annotate } = await import('../src/normalize.js');
  for (const text of ['80g x4', '80 g x 4', '80gx4', '80g×4', '80g x 4 pcs', 'Pack of 4 (80 g each)']) {
    const p = parsePack(text);
    assert.equal(p.size, 320, text);
    assert.equal(p.unit, 'g', text);
  }
  assert.equal(parsePack('200 ml x 6').size, 1200);
  assert.equal(parsePack('500g x 2 kg').size, 500, 'a second measure is not a count');
  assert.equal(parsePack('1 pack (1 kg)').size, 1000, 'mass beats a pack count');
  assert.equal(parsePack('Pack of 6').unit, 'piece');
  // The measure is the total unless it is stated per piece.
  assert.equal(parsePack('Amul Butter School Pack (Pack of 10) 100 g').size, 100);
  assert.equal(parsePack('80 g (Pack of 4)').size, 80);
  assert.equal(parsePack('Onion Powder 500g Each | Pack of 3 | Total 1.5kg').size, 1500);

  const row = annotate('biscuits 320g', { name: 'Marie Biscuits 80g x4', price: 80, inStock: true, url: 'x' });
  assert.equal(row.pack.size, 320);
  assert.match(row.pricePerUnitLabel, /25\.00 \/ 100g/); // ₹80 / 320 g = ₹25 per 100 g
});
