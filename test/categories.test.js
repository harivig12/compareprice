/**
 * Product groups (src/categories.js): sweets / pooja / packaged vs the staple.
 * Counterexamples come from the saved products (docs/diagnosis/2026-11-20-category-trigger-words.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { titleGroup, categoryGroup, namedGroups, groupOf } from '../src/categories.js';

test('title words: a laddu is a sweet, puja ghee is pooja, bhujia is packaged', () => {
  assert.equal(titleGroup('Sweet Sanskriti Ghee Besan Laddu Pack 200 g'), 'sweets');
  assert.equal(titleGroup('Shubhkart Darshana Puja Ghee Jar 500 ml'), 'pooja');
  assert.equal(titleGroup('Haldiram Aloo Bhujia 400 g'), 'packaged');
  assert.equal(titleGroup('Sri Balamurugan Cotton 365 Pooja Panju Wicks - 365 pcs'), 'pooja');
});

test('title words never catch produce, brands or staples (saved counterexamples)', () => {
  for (const name of [
    'Sweet Corn 2 pc (600 gm - 800 gm approx.)', 'Sweet Lime (Mosambi) (Sathukkudi) 1 kg',
    'Patanjali Pachak Hing - Peda 100 g', 'Frozen Green Peas 500 g',
    'BB Royal Organic Red Masoor Dal / Massor Paruppu / Mysore Paruppu 1 kg',
    'Gulab Filtered Groundnut Oil 1 L', 'Deepam Gingelly Oil 1 L', 'Aavin Ghee 1 L (Carton)',
    'Amul Masti Spiced Buttermilk 1 L (Tetra Pak)', 'Vijay Poha 0.5 kg', 'Phool Makhana 100 g',
  ]) assert.equal(titleGroup(name), null, name);
});

test('category path: read from the leaf up; the top level never refuses', () => {
  assert.equal(categoryGroup('Snacks & Branded Foods › Indian Mithai'), 'sweets');
  assert.equal(categoryGroup('Foodgrains, Oil & Masala › Edible Oils & Ghee › Ghee & Vanaspati'), null);
  assert.equal(categoryGroup('Fruits & Vegetables › Exotic › Sweet Corn'), null);
  assert.equal(categoryGroup('Pooja Needs › Agarbatti'), 'pooja');
  assert.equal(categoryGroup('Frozen Veg'), 'packaged');
  // BigBasket files milk under "Bakery, Cakes & Dairy": "cakes" there says nothing about milk.
  assert.equal(categoryGroup('Bakery, Cakes & Dairy › Dairy › Milk'), null);
  // A segment naming a sweet and a packaged food is only packaged, so a biscuit is never refused.
  assert.equal(categoryGroup('Snacks & Branded Foods › Chocolates & Biscuits'), 'packaged');
  assert.equal(categoryGroup(null), null);
  assert.equal(categoryGroup('Toor Dal'), null);
});

test('named groups: the line asks for the sweet or pooja item', () => {
  assert.ok(namedGroups('ghee laddu').has('sweets'));
  assert.ok(namedGroups('besan ladoo').has('sweets'));
  assert.ok(namedGroups('pooja oil').has('pooja'));
  assert.ok(namedGroups('puja ghee').has('pooja'));
  assert.ok(namedGroups('biscuits').has('packaged'));
  assert.equal(namedGroups('ghee').size, 0);
  assert.equal(namedGroups('tata salt 1kg').size, 0);
});

test('groupOf: title or category can refuse; an AI label only demotes', () => {
  assert.deepEqual(groupOf({ name: 'Aavin Ghee 1 L', category: null }), { group: 'staple', source: 'default', refusable: false });
  assert.deepEqual(groupOf({ name: 'Ghee Mysore Delight 200 g', category: 'Snacks & Branded Foods › Indian Mithai' }), { group: 'sweets', source: 'category', refusable: true });
  // A laddu filed under ghee by a site is still refused by its name.
  assert.equal(groupOf({ name: 'Ghee Besan Laddu', category: 'Foodgrains › Edible Oils & Ghee' }).refusable, true);
  assert.deepEqual(groupOf({ name: 'Sweet Lime 1 kg', aiGroup: 'sweets' }), { group: 'sweets', source: 'ai', refusable: false });
  assert.equal(groupOf({ name: 'Floor cleaner 1 L', aiGroup: 'nonfood' }).group, 'packaged');
  assert.deepEqual(groupOf({ name: 'Toor Dal 1 kg', aiGroup: 'staple' }), { group: 'staple', source: 'ai', refusable: false });
});
