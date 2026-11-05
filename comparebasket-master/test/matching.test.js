/**
 * Regression tests for the four refusal rules and pack scaling.
 *
 * Every case here is a bug this project actually shipped and then fixed
 * against live platform data — not hypotheticals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { matchConfidence, annotate } from '../src/normalize.js';
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

test('quantity multiplies on top of packs needed', () => {
  const items = [{ raw: '2x amul butter 500g', query: 'amul butter 500g', qty: 2 }];
  const score = scorePlatform('blinkit', items, {
    'amul butter 500g': [product('Amul Butter Pasteurised', 200, 'g', 85)],
  });
  assert.equal(score.lines[0].lineTotal, 510, '3 packs × ₹85 × qty 2');
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
