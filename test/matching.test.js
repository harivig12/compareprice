/**
 * Regression tests for the four refusal rules and pack scaling.
 *
 * Every case here is a bug this project actually shipped and then fixed
 * against live platform data — not hypotheticals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { matchConfidence, annotate, CONFIDENCE_THRESHOLD } from '../src/normalize.js';
import { pickBest, scorePlatform } from '../src/score.js';

const product = (name, packSize, packUnit, price, extra = {}) => ({
  name, packSize, packUnit, price, mrp: null, inStock: true, url: 'x', ...extra,
});

// ── Rule 1: unit family ─────────────────────────────────────────────────────

test('refuses mass against volume', () => {
  const r = matchConfidence('fortune sunflower oil 1L', product('Fortune Refined Soyabean Oil', 930, 'g', 159));
  assert.equal(r.refused, true);
  assert.match(r.reason, /unit family mismatch/);
});

// ── Rule 2: brand ───────────────────────────────────────────────────────────

test('refuses a different named brand', () => {
  const r = matchConfidence('amul butter 500g', product('Mother Dairy Pasteurized Butter', 500, 'g', 305));
  assert.equal(r.refused, true);
  assert.match(r.reason, /brand mismatch/);
  assert.match(r.reason, /mother dairy/);
});

test('penalises but does not refuse an unbranded product', () => {
  const r = matchConfidence('amul butter 500g', product('Mooz Unsalted White Butter', 150, 'g', 190));
  assert.equal(r.refused, false);
  assert.ok(r.score < 0.55, `expected below threshold, got ${r.score}`);
  assert.match(r.reason, /not found in name/);
});

test('accepts the right brand', () => {
  const r = matchConfidence('amul butter 500g', product('Amul Butter Pasteurised', 500, 'g', 230));
  assert.equal(r.refused, false);
  assert.ok(r.score > 0.55, `expected confident, got ${r.score}`);
});

// ── Rule 3: product type ────────────────────────────────────────────────────

test('refuses the right brand but the wrong food', () => {
  // Shipped bug: "amul butter" picked Amul Masti Dahi Cup because the brand
  // matched and it was cheap per unit.
  const r = matchConfidence('amul butter 500g', product('Amul Masti Dahi Cup', 400, 'g', 50));
  assert.equal(r.refused, true);
  assert.match(r.reason, /product type mismatch/);
});

// ── Rule 4: category containment ────────────────────────────────────────────

test('refuses a product that adds a category the query never asked for', () => {
  // Shipped bug: "amul butter 500g" bought 16 packs of Amul Butter Cookies.
  // The word "butter" is present, so presence-matching passed it.
  const r = matchConfidence('amul butter 500g', product('Amul Butter Cookies', 32, 'g', 10));
  assert.equal(r.refused, true);
  assert.match(r.reason, /different category/);
  assert.match(r.reason, /cookies/);
});

test('refuses milk chocolate for a milk query', () => {
  const r = matchConfidence('amul taaza toned milk 500ml', product('Cadbury Dairy Milk Chocolate Bar', 34, 'g', 36));
  assert.equal(r.refused, true);
});

test('a flavour word is not a category', () => {
  // "cream" in "full cream milk" is a variant, not a different food. If it were
  // treated as a category every flavour would look like a different product.
  const r = matchConfidence('amul toned milk 500ml', product('Amul Full Cream Milk', 500, 'ml', 36));
  assert.equal(r.refused, false, `should be flagged, not refused: ${r.reason}`);
  assert.match(r.reason, /variant mismatch/);
});

test('same category on both sides is fine', () => {
  const r = matchConfidence('brown bread 400g', product('Britannia Brown Bread', 400, 'g', 55));
  assert.equal(r.refused, false);
  assert.ok(r.score > 0.55);
});

// ── Pack scaling ────────────────────────────────────────────────────────────

test('buys the number of packs actually needed', () => {
  // Shipped bug: a 200g pack at ₹85 was totalled against a 500g pack at ₹310
  // as if they were the same purchase.
  const items = [{ raw: 'amul butter 500g', query: 'amul butter 500g', qty: 1 }];
  const score = scorePlatform('blinkit', items, {
    'amul butter 500g': [product('Amul Butter Pasteurised', 200, 'g', 85)],
  });
  const line = score.lines[0];
  assert.equal(line.product.packs, 3, 'ceil(500/200) = 3 packs');
  assert.equal(line.lineTotal, 255);
  assert.equal(line.product.covered, 600);
});

test('an exact pack match buys one', () => {
  const items = [{ raw: 'amul butter 500g', query: 'amul butter 500g', qty: 1 }];
  const score = scorePlatform('zepto', items, {
    'amul butter 500g': [product('Amul Butter Pasteurised', 500, 'g', 230)],
  });
  assert.equal(score.lines[0].product.packs, 1);
  assert.equal(score.lines[0].lineTotal, 230);
});

test('quantity folds into the amount needed, not on top of the packs', () => {
  // 2 × 500 g of butter from 200 g packs is 1000 g = 5 packs (the old maths bought 6).
  const items = [{ raw: '2x amul butter 500g', query: 'amul butter 500g', qty: 2 }];
  const score = scorePlatform('blinkit', items, {
    'amul butter 500g': [{ name: 'Amul Butter Pasteurised', packSize: 200, packUnit: 'g', price: 85, mrp: null, inStock: true, url: 'x' }],
  });
  assert.equal(score.lines[0].product.packs, 5);
  assert.equal(score.lines[0].lineTotal, 425, '5 packs × ₹85');
});

test('2 × 500 ml with a 1 L pack buys one pack, not two', () => {
  const items = [{ raw: '2x milk 500ml', query: 'amul taaza toned milk 500ml', qty: 2 }];
  const score = scorePlatform('bigbasket', items, {
    'amul taaza toned milk 500ml': [{ name: 'Amul Taaza Toned Milk 1 L', packSize: 1, packUnit: 'l', price: 75, mrp: null, inStock: true, url: 'x' }],
  });
  assert.equal(score.lines[0].product.packs, 1);
  assert.equal(score.lines[0].lineTotal, 75);
});

test('a bigger pack than asked for is shown with its rate but not totalled (5 L can for "1L")', () => {
  const items = [{ raw: 'fortune sunflower oil 1L', query: 'fortune sunflower oil 1l', qty: 1 }];
  const score = scorePlatform('flipkart_minutes', items, {
    'fortune sunflower oil 1l': [{ name: 'FORTUNE Sunlite Sunflower Oil 5 L', packSize: 5, packUnit: 'l', price: 869, mrp: null, inStock: true, url: 'x' }],
  });
  const line = score.lines[0];
  assert.equal(line.status, 'bigger-pack');
  assert.equal(line.lineTotal, null);
  assert.equal(line.product.packLabel, '5000ml');
  assert.match(line.product.pricePerUnitLabel, /17\.38/);
  assert.equal(score.subtotal, 0);
});

test('"6 eggs" does not take a 12-pack as its price, but a 6-pack does', () => {
  const rows = [
    { name: 'Kkp White Eggs 12 Pieces', packSize: 12, packUnit: 'pc', price: 105, mrp: null, inStock: true, url: 'a' },
    { name: 'Nila Eggs 6 pcs Fresh White Eggs 6 pcs', packSize: 6, packUnit: 'pc', price: 60, mrp: null, inStock: true, url: 'b' },
  ];
  assert.equal(pickBest('6 eggs', rows).chosen.price, 60);
  assert.equal(pickBest('6 eggs', [rows[0]]).status, 'bigger-pack');
});

// ── Basket-line tokens ──────────────────────────────────────────────────────

test('a bare count line stays comparable', () => {
  // "6 eggs" strips to nothing (number + unit word), which used to report
  // "no comparable tokens" on an ordinary basket line.
  const r = matchConfidence('6 eggs', product('Hen Fruit Eggs Brown 6 Pcs', 6, 'pcs', 100));
  assert.equal(r.refused, false, r.reason);
  assert.ok(r.score > 0.55, `expected confident, got ${r.score} (${r.reason})`);
});

// ── Selection ───────────────────────────────────────────────────────────────

test('a refused candidate never gets picked, however cheap', () => {
  const { chosen } = pickBest('amul butter 500g', [
    product('Amul Butter Cookies', 32, 'g', 10),        // refused: category
    product('Nandini Cooking Butter', 500, 'g', 198),   // refused: brand
    product('Amul Butter Pasteurised', 500, 'g', 230),  // the real answer
  ]);
  assert.equal(chosen.name, 'Amul Butter Pasteurised');
});

test('out-of-stock is skipped even when it is the best match', () => {
  const { chosen } = pickBest('amul butter 500g', [
    product('Amul Butter Pasteurised', 500, 'g', 200, { inStock: false }),
    product('Amul Butter Pasteurised', 500, 'g', 230),
  ]);
  assert.equal(chosen.price, 230);
});

test('annotate exposes the refusal to the caller', () => {
  const a = annotate('amul butter 500g', product('Amul Butter Cookies', 32, 'g', 10));
  assert.equal(a.refused, true);
  assert.equal(a.confident, false);
  assert.equal(a.confidence, 0);
});

// ── Generic queries: any brand, but not a snack variant ─────────────────────

test('a generic query accepts any branded staple', () => {
  for (const name of ['Fortune Unpolished Moong Dal 1 kg', 'Tata Sampann Unpolished Moong Dal 1 kg']) {
    const r = matchConfidence('moong dal 1kg', product(name, 1, 'kg', 150));
    assert.equal(r.refused, false, `${name}: ${r.reason}`);
    assert.ok(r.score >= CONFIDENCE_THRESHOLD, `${name}: expected confident, got ${r.score} (${r.reason})`);
  }
});

test('a generic dal query refuses snack variants', () => {
  for (const [name, size] of [
    ['Too Yumm! Moong Dal Namkeen 140 g', 140],
    ["Haldiram's Moong Dal Crispy Fried Lentil Snack 200 g", 200],
  ]) {
    const r = matchConfidence('moong dal', product(name, size, 'g', 50));
    assert.equal(r.refused, true, `${name} should be refused: ${r.reason}`);
    assert.equal(r.score, 0);
  }
});

test('a named brand still refuses a different named brand', () => {
  const r = matchConfidence('amul butter 100g', product('Britannia Butter 100g', 100, 'g', 56));
  assert.equal(r.refused, true);
  assert.equal(r.score, 0);
  assert.match(r.reason, /brand mismatch/);
});

test('a brand-less query takes an unlisted brand without the unknown-brand penalty', () => {
  const r = matchConfidence('toor dal 1kg', product('Udhaiyam Toor Dal 1 kg', 1, 'kg', 180));
  assert.equal(r.refused, false, r.reason);
  assert.ok(r.score >= CONFIDENCE_THRESHOLD, `expected confident, got ${r.score} (${r.reason})`);
  assert.doesNotMatch(r.reason, /not found in name/);
});

{
  const ok = (q, name) => {
    const r = matchConfidence(q, { name });
    assert.ok(!r.refused && r.score >= CONFIDENCE_THRESHOLD, `${q} ↔ ${name}: ${r.score} ${r.reason}`);
  };
  const no = (q, name) => assert.equal(matchConfidence(q, { name }).refused, true, `${q} must not match ${name}`);

  test('toor dal never matches moong dal, even though both are "dal"', () => {
    no('toor dal 1kg', 'Bb Popular Moong Dal/Payatham Parupu 1 kg');
    no('moong dal 500g', 'Tata Sampann Unpolished Toor Dal 500 g');
    no('sunflower oil 1 litre', 'Fortune Rice Bran Oil 1 L');
  });

  test('regional and spelling variants are the same dal', () => {
    for (const name of ['Fortune Unpolished Arhar Dal 1 kg', 'Udhaiyam Dhall - Toor 1 kg', 'Aashirvaad Organic Tur Dal 1 kg', 'bb Royal Thuvaram Paruppu 1 kg']) ok('toor dal 1kg', name);
    ok('moong dal 500g', 'Organic Mung Dal 500 g');
    ok('moong dal 500g', 'Hesaru Bele 500 g');
    ok('onion 1kg', 'Onion (Vengayam) 1 kg');
  });

  test('still refuses snack and category variants', () => {
    no('moong dal 500g', 'Too Yumm! Moong Dal Namkeen 140 g');
    no('amul butter 100g', 'Amul Butter Cookies 100 g');
  });
}

test('a refused product is never picked, not even as a flagged fallback (JioMart returned Tata Salt for "6 eggs")', () => {
  const salt = { name: 'Tata Iodised Salt 1 kg', packSize: 1000, packUnit: 'g', price: 29, inStock: true, url: 'x' };
  const r = pickBest('6 eggs', [salt]);
  assert.equal(r.chosen, null);
  assert.equal(r.status, 'no-match');
  const line = scorePlatform('jiomart', [{ raw: '6 eggs', query: '6 eggs', qty: 1 }], { '6 eggs': [salt] }).lines[0];
  assert.equal(line.lineTotal, null, 'not totalled');
  assert.equal(line.status, 'no-match');
});

test('"1 pack (6 pcs)" is 6 eggs, so "6 eggs" buys one pack, not six', () => {
  const eggs = { name: 'Fresh White Eggs 1 pack (6 pcs)', price: 52, inStock: true, url: 'x' };
  const line = scorePlatform('zepto', [{ raw: '6 eggs', query: '6 eggs', qty: 1 }], { '6 eggs': [eggs] }).lines[0];
  assert.equal(line.product.packs, 1);
  assert.equal(line.lineTotal, 52);
});

test('a different form of the same word is refused: ketchup, spring onion (seen in live JioMart and KPN results)', () => {
  assert.equal(matchConfidence('tomato 500g', { name: 'TOC Tomato Ketchup (500g.) pack of 1' }).refused, true);
  assert.equal(matchConfidence('onion 1kg', { name: 'Spring Onion (Vengaya Thaal) Whole bunch' }).refused, true);
  // …but not when the query asks for it.
  assert.equal(matchConfidence('tomato ketchup 500g', { name: 'Kissan Tomato Ketchup 500 g' }).refused, false);
  assert.equal(matchConfidence('orange juice 1L', { name: 'Tropicana Orange Juice 1 L' }).refused, false);
});

test('a sweet or a puja item made with the staple is not the staple (seen in saved KPN, Milkbasket and BigBasket rows, 2026-11-20)', () => {
  // "Laddu" is how KPN spells it; only "ladoo" was known, so this was taken for ghee at ₹37.5/100 g.
  assert.equal(matchConfidence('ghee', { name: 'Sweet Sanskriti Ghee Besan Laddu Pack 200 g' }).refused, true);
  assert.equal(matchConfidence('besan', { name: 'Sweet Sanskriti Ghee Besan Laddu Pack 200 g' }).refused, true);
  assert.equal(matchConfidence('hing', { name: 'Patanjali Pachak Hing - Peda 100 g' }).refused, true);
  assert.equal(matchConfidence('coconut', { name: 'Haldiram Coconut Burfi 250 g' }).refused, true);
  // Lamp ghee is not food.
  assert.equal(matchConfidence('ghee', { name: 'Shubhkart Darshana Puja Ghee Jar 500 ml' }).refused, true);
  assert.equal(matchConfidence('sesame oil', { name: 'Divya Maarg Pooja Oil (Mustard and Sesame Blend) 900 ml' }).refused, true);
  // …but asking for them still finds them, in either spelling.
  assert.equal(matchConfidence('besan laddu', { name: 'Haldiram Besan Laddu 400 g' }).refused, false);
  assert.equal(matchConfidence('besan ladoo', { name: 'Haldiram Besan Laddu 400 g' }).refused, false);
  assert.equal(matchConfidence('pooja oil', { name: 'Mr. Gold Nakshatra Pooja Oil 500 ml' }).refused, false);
  assert.equal(matchConfidence('puja ghee', { name: 'Shubhkart Darshana Puja Ghee Jar 500 ml' }).refused, false);
  assert.equal(matchConfidence('camphor', { name: 'Mangalam Pooja Camphor Tablets 100 g' }).refused, false);
  // Real ghee is untouched.
  assert.equal(matchConfidence('ghee', { name: 'Aavin Ghee 1 L (Carton)' }).refused, false);
  assert.equal(matchConfidence('ghee', { name: 'Desi Farms Cow Ghee 1 pc (1 L)' }).refused, false);
});

test('approximate and ranged weights count as the weight asked for', () => {
  const row = (name, price) => ({ name, price, inStock: true, url: 'x' });
  for (const name of ['Onion (Approx. 900 g - 1000 g)', 'Onion 0.95-1.05Kg', 'Local Onion 900-1100g']) {
    const l = scorePlatform('flipkart_minutes', [{ raw: 'onion 1kg', query: 'onion 1kg', qty: 1 }], { 'onion 1kg': [row(name, 67)] }).lines[0];
    assert.equal(l.status, 'ok', name);
    assert.equal(l.product.packs, 1, `${name}: one pack, not two`);
    assert.equal(l.lineTotal, 67);
  }
});

test('a product whose size is unreadable is only a weak match when the query names a size', () => {
  const bunch = { name: 'Onion Whole bunch', price: 18, inStock: true, url: 'a' };
  const kilo = { name: 'Onion 1 kg', packSize: 1000, packUnit: 'g', price: 69, inStock: true, url: 'b' };
  assert.equal(pickBest('onion 1kg', [bunch, kilo]).chosen.price, 69, 'the sized one wins even though it costs more');
  assert.equal(pickBest('onion 1kg', [bunch]).status, 'low-confidence', 'alone, it is shown as a weak match');
});
