import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropOutliers } from '../src/pricecheck.js';
import { scorePlatform } from '../src/score.js';
import { matchConfidence } from '../src/normalize.js';

const row = (name, packSize, packUnit, price) => ({ name, packSize, packUnit, price, mrp: null, inStock: true, url: 'https://x/' + name });
const basket = [{ raw: 'amul butter 500g', query: 'amul butter 500g', qty: 1 }];

test('a price per unit far from the other sites is dropped and the next candidate is used', () => {
  const byPlatform = {
    kpn: { 'amul butter 500g': [row('Amul Pasteurised Butter 500 g', 500, 'g', 309)] },
    blinkit: { 'amul butter 500g': [row('Amul Butter 500 g', 500, 'g', 325)] },
    instamart: { 'amul butter 500g': [row('Amul Butter Pasteurised 500 g', 500, 'g', 340)] },
    // 100 g block priced as if it were 500 g: ₹79 -> ₹15.8/100g vs ~₹65/100g elsewhere
    jiomart: { 'amul butter 500g': [row('Amul Butter Blisters 500 g', 500, 'g', 79), row('Amul Butter 500 g', 500, 'g', 330)] },
  };
  const { filtered, dropped } = dropOutliers(basket, byPlatform);
  assert.equal(dropped.jiomart['amul butter 500g'].length, 1);
  assert.equal(dropped.jiomart['amul butter 500g'][0].price, 79);
  assert.match(dropped.jiomart['amul butter 500g'][0].reason, /only \d+% of the median across 4 sites/);
  const line = scorePlatform('jiomart', basket, filtered.jiomart).lines[0];
  assert.equal(line.lineTotal, 330, 'falls back to its next candidate');
  assert.equal(dropped.kpn['amul butter 500g'], undefined, 'normal prices untouched');
});

test('too-high outliers are dropped as well', () => {
  const mk = (p) => ({ 'amul butter 500g': [row('Amul Butter 500 g', 500, 'g', p)] });
  const { dropped } = dropOutliers(basket, { a: mk(300), b: mk(310), c: mk(320), d: mk(1400) });
  assert.equal(dropped.d['amul butter 500g'].length, 1);
  assert.match(dropped.d['amul butter 500g'][0].reason, /× the median/);
});

test('with fewer than three sites there is nothing to compare, so nothing is dropped', () => {
  const mk = (p) => ({ 'amul butter 500g': [row('Amul Butter 500 g', 500, 'g', p)] });
  const { dropped } = dropOutliers(basket, { a: mk(100), b: mk(900) });
  assert.deepEqual(dropped.a, {});
  assert.deepEqual(dropped.b, {});
});

test('a site left with nothing after the check has no price for the item (not a made-up one)', () => {
  const mk = (p) => ({ 'amul butter 500g': [row('Amul Butter 500 g', 500, 'g', p)] });
  const { filtered } = dropOutliers(basket, { a: mk(300), b: mk(310), c: mk(320), d: mk(40) });
  const line = scorePlatform('d', basket, filtered.d).lines[0];
  assert.equal(line.lineTotal, null);
});

test('processed forms are refused: tomato powder is not a tomato', () => {
  const r = matchConfidence('tomato 500g', { name: 'Arshita Naturals Red Onion Powder, Tomato Powder & Garlic Powder Combo', packSize: 1500, packUnit: 'g' });
  assert.equal(r.refused, true);
  assert.match(r.reason, /powder/);
});
