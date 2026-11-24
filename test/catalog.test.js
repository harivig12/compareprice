import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalQuery, describeQuery, catalogConflicts, foldAliases, PRODUCTS, CATEGORIES, productsMatching } from '../src/catalog.js';
import { matchConfidence } from '../src/normalize.js';
import { resolveBasket } from '../src/resolver.js';
import { openStore, normalizeQuery } from '../src/store.js';

test('every catalogue phrase belongs to exactly one product, in a known category', () => {
  assert.deepEqual(catalogConflicts(), []);
  for (const p of PRODUCTS) {
    assert.ok(CATEGORIES.includes(p.category), `${p.name}: unknown category ${p.category}`);
    assert.ok(p.canonical, `${p.name}: no canonical tag`);
  }
});

test('raisins and every kismis spelling are one product', () => {
  for (const q of ['raisins', 'kismis', 'khismis', 'kishmis', 'kishmish', 'Kismis', 'dry grapes', 'manuka']) {
    assert.equal(canonicalQuery(q), 'raisins', q);
    assert.equal(describeQuery(q).category, 'dry-fruits');
  }
  assert.equal(canonicalQuery('Kishmish 500 g'), 'raisins 500 g');
  assert.equal(normalizeQuery('Kishmish 500 g'), 'raisins 500g');
  assert.equal(normalizeQuery('raisins 500g'), 'raisins 500g');
});

test('jaggery: regional names and misspellings fold to one tag', () => {
  for (const q of ['gud', 'gur', 'ghood', 'ghud', 'jagreey', 'jagrey', 'vellam', 'bellam', 'bella']) assert.equal(canonicalQuery(q), 'jaggery', q);
  assert.equal(canonicalQuery('gud powder'), 'jaggery powder');
  assert.equal(canonicalQuery('organic gud 1kg'), 'organic jaggery 1kg');
});

test('lines that are more than the product are left as typed', () => {
  for (const q of ['britannia good day cashew 200g', 'kishmish namkeen', 'amul taaza toned milk 500ml', 'maggi 2-minute noodles 280g', 'turmeric powder']) {
    assert.equal(canonicalQuery(q), q, q);
  }
  // Narrower names and brands identify the product but are not rewritten.
  assert.equal(canonicalQuery('salted butter'), 'salted butter');
  assert.equal(describeQuery('salted butter').id, 'butter');
  assert.equal(canonicalQuery('harpic'), 'harpic');
  assert.equal(describeQuery('harpic').id, 'toilet-cleaner');
  assert.equal(describeQuery('amul butter 500g').brand, 'amul');
});

test('a listing named by a synonym matches the canonical query', () => {
  assert.equal(foldAliases('raisins', 'Kishmish Green 250 g'), 'raisins green 250 g');
  for (const name of ['Kishmish Green 250 g', 'Happilo Premium Dry Grapes 250 g', 'Raisins 500 g', 'Khismis Seedless 200 g']) {
    const m = matchConfidence('kismis', { name });
    assert.equal(m.refused, false, `${name}: ${m.reason}`);
  }
  // Still refuses a different product.
  assert.equal(matchConfidence('kismis', { name: 'Manuka Honey 250 g' }).refused, true);
  assert.equal(matchConfidence('jaggery', { name: 'Organic Gud Powder 500 g' }).refused, true);
  assert.equal(matchConfidence('jaggery', { name: 'Organic Gud 1 kg' }).refused, false);
});

test('the basket merges synonyms into one line and keeps what was typed', () => {
  const items = resolveBasket('kismis 500g\n2x raisins 500g\nkishmish 500 g\ngud');
  assert.equal(items.length, 2);
  assert.equal(items[0].query, 'raisins 500g');
  assert.equal(items[0].qty, 4);
  assert.equal(items[0].typed, 'kismis 500g, kishmish 500 g');
  assert.equal(items[0].product.category, 'dry-fruits');
  assert.equal(items[1].query, 'jaggery');
  assert.equal(items[1].typed, 'gud');
});

test('saved prices under a synonym regroup under the canonical name', () => {
  const store = openStore(':memory:');
  try {
    store.db.prepare(`INSERT INTO prices (query, site, family, unit, unit_price, price, product, pack, seen_at)
      VALUES ('kismis', 'blinkit', 'mass', 'kg', 400, 100, 'Kishmish 250 g', '250 g', '2026-11-20T10:00:00Z')`).run();
    assert.equal(store.regroup(), 1);
    assert.deepEqual(Object.keys(store.coverage('raisins')), ['blinkit']);
    assert.equal(store.lookup('khismis').query, 'raisins');
    assert.equal(store.suggest('kish')[0]?.query, 'raisins');
  } finally {
    store.close();
  }
});

test('productsMatching finds products by any name', () => {
  assert.equal(productsMatching('kish')[0].id, 'raisins');
  assert.ok(productsMatching('vell').some((p) => p.id === 'jaggery'));
});
