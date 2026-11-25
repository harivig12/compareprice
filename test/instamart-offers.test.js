/**
 * Instamart's coupons and payment offers: parsing real answers (scrubbed), the cart safeguards
 * (an account's own basket is only read; "clear" only after the cart was seen empty; always put back),
 * and the offer check around it. No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseCoupons, cartLines, couponsBody, addBody, cheapestVariation, readInstamartCartOffers } from '../src/engine/sites/instamart-offers.js';
import { shortfallFrom } from '../src/engine/sites/_offers.js';
import { checkOffers } from '../src/offers.js';
import { openStore } from '../src/store.js';
import { validateConfig, DEFAULT_CONFIG } from '../src/config.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/sites/${n}.json`, import.meta.url), 'utf8'));

test('shortfallFrom reads both sites\' wording', () => {
  assert.equal(shortfallFrom('Add items worth ₹928 more to avail this offer.'), 928);
  assert.equal(shortfallFrom('Add Arata items worth ₹499 more to avail this offer.'), 499);
  assert.equal(shortfallFrom('Shop for ₹81 more to unlock'), 81);
});

test('parseCoupons: available first, locked after; code, minimum, shortfall and terms kept; duplicates dropped', () => {
  const list = parseCoupons(fixture('instamart-coupons'));
  assert.equal(list.length, 6, 'the duplicate at the end is dropped');
  assert.equal(list[0].state, 'available');
  assert.ok(list.slice(1).every((c) => c.state === 'locked'));
  const idfc = list.find((c) => c.code === 'IDFCDC175');
  assert.match(idfc.title, /20% OFF with IDFC FIRST Bank Debit Cards/);
  assert.equal(idfc.minOrder, 750);
  assert.ok(idfc.shortfall > 0);
  assert.equal(idfc.type, 'NOT_APPLICABLE_CART_MIN');
  assert.ok(idfc.terms.length >= 1 && idfc.terms.every((t) => t.length <= 300));
  assert.ok(list.find((c) => c.code === 'PAYTMUPI10').minOrder > 0);
  assert.deepEqual(parseCoupons({ data: { widgets: [{ type: 'COUPON_APPLY', data: [{}] }] } }), [], 'an empty cart lists nothing');
  assert.throws(() => parseCoupons({ nope: 1 }), (e) => e.kind === 'parse' && /^instamart:/.test(e.message));
});

test('cartLines: "Cart not found" is an empty cart; items carry sku, spin and price', () => {
  assert.deepEqual(cartLines(fixture('instamart-cart-none')), { items: [], known: true });
  const one = cartLines(fixture('instamart-cart-one'));
  assert.equal(one.known, true);
  assert.deepEqual(one.items.map(({ skuId, spinId, quantity, price }) => ({ skuId, spinId, quantity, price })), [{ skuId: 'SKU-1', spinId: 'SPIN-1', quantity: 1, price: 98 }]);
  assert.equal(cartLines({}).known, false);
  assert.equal(cartLines({ data: { statusCode: 7 } }).known, false, 'an answer this code does not know is not "empty"');
});

test('request bodies: coupons for cart lines; the add is the search page\'s own shape', () => {
  assert.deepEqual(couponsBody([{ skuId: 'S', spinId: 'P', quantity: 2, price: 16, name: 'Salt' }]), { cartItems: [{ itemPrice: '16.0', quantity: 2, name: 'Salt', skuId: 'S', spinId: 'P' }] });
  const b = addBody({ productId: 'PR', skuId: 'S', spinId: 'P', price: 16, storeId: '1400000' });
  assert.deepEqual(b.data.items, [{ quantity: 1, productId: 'PR', spin: 'P', itemId: 'S', meta: { type: 'structure', storeId: 1400000 }, serviceLine: 'INSTAMART' }]);
  assert.deepEqual(b.data.cartMetaData.storeIds, [1400000]);
  assert.equal(b.cartAnalyticsMetaInfo.actionType, 'ADD_ITEMS');
});

test('cheapestVariation: the cheapest in-stock variation with all its ids', () => {
  const v = cheapestVariation(fixture('instamart-ok'));
  assert.ok(v && v.productId && v.skuId && v.spinId && v.price > 0);
  const none = cheapestVariation({ data: { cards: [{ productId: 'X', variations: [{ skuId: 'a', spinId: 'b', price: { offerPrice: { units: 5 } }, inventory: { inStock: false } }] }] } });
  assert.equal(none, null);
});

// ───────────────────────── the cart safeguards ─────────────────────────

const ITEM = { productId: 'PR', skuId: 'SKU-P', spinId: 'SPIN-P', price: 16, name: 'Supreme Harvest Iodized Salt' };
const cartOf = (items) => (items.length ? { data: { data: { items: items.map((i) => ({ itemId: i.sku, quantity: i.q ?? 1, name: i.sku, metadata: { variations: [{ id: i.sku, spin: i.spin ?? `spin-${i.sku}`, price: { offer_price: 10 } }] } })) }, statusCode: 0 }, statusCode: 0 } : fixture('instamart-cart-none'));

function rig({ start = [], afterAdd = null, couponsFail = false, clearFails = 0, picks = ITEM, unknown = false } = {}) {
  const calls = [];
  let cart = [...start];
  let clears = 0;
  return {
    calls,
    deps: {
      getCart: async () => { calls.push('get'); return unknown ? { data: { statusCode: 9 } } : cartOf(cart); },
      coupons: async (lines) => { calls.push(`coupons ${lines.map((l) => l.skuId).join(',')}`); if (couponsFail) throw new Error('instamart: 500 boom'); return fixture('instamart-coupons'); },
      addItem: async (it) => { calls.push(`add ${it.skuId}`); cart = afterAdd ?? [...cart, { sku: it.skuId }]; },
      clearCart: async () => { calls.push('clear'); if (clears++ >= clearFails) cart = []; },
      pickItem: async () => { calls.push('pick'); return picks; },
    },
  };
}

test('the account\'s own basket is only read: no add, no clear', async () => {
  const r = rig({ start: [{ sku: 'A' }, { sku: 'B' }] });
  const out = await readInstamartCartOffers(r.deps);
  assert.equal(out.cart, 'yours');
  assert.equal(out.coupons.length, 6);
  assert.deepEqual(r.calls, ['get', 'coupons A,B']);
});

test('an empty cart: one item in, coupons read, the cart cleared and checked empty', async () => {
  const r = rig();
  const out = await readInstamartCartOffers(r.deps);
  assert.deepEqual(r.calls, ['get', 'pick', 'add SKU-P', 'get', 'coupons SKU-P', 'clear', 'get']);
  assert.equal(out.cart, 'probe');
  assert.equal(out.item, 'Supreme Harvest Iodized Salt');
});

test('a failing coupon read still clears the cart, then reports the failure', async () => {
  const r = rig({ couponsFail: true });
  await assert.rejects(readInstamartCartOffers(r.deps), /boom/);
  assert.deepEqual(r.calls.slice(-2), ['clear', 'get']);
});

test('clearing is retried; if the cart never empties the error names the item', async () => {
  const retry = rig({ clearFails: 2 });
  assert.equal((await readInstamartCartOffers(retry.deps)).cart, 'probe');
  assert.equal(retry.calls.filter((c) => c === 'clear').length, 3);
  const stuck = rig({ clearFails: 9 });
  await assert.rejects(readInstamartCartOffers(stuck.deps), (e) => e.code === 'cart_not_empty' && /Remove "Supreme Harvest Iodized Salt" in Instamart/.test(e.message));
});

test('other items appearing during the check: nothing is read and the cart is NOT cleared', async () => {
  const r = rig({ afterAdd: [{ sku: 'SKU-P' }, { sku: 'SOMEONE-ELSE' }] });
  await assert.rejects(readInstamartCartOffers(r.deps), (e) => e.code === 'cart_changed');
  assert.ok(!r.calls.includes('clear'));
  assert.ok(!r.calls.some((c) => c.startsWith('coupons')));
});

test('an add that does not show in the cart answer still reads with the item and still clears', async () => {
  const r = rig({ afterAdd: [] });
  const out = await readInstamartCartOffers(r.deps);
  assert.equal(out.cart, 'probe');
  assert.ok(r.calls.includes('coupons SKU-P'));
  assert.ok(r.calls.includes('clear'));
});

test('an unknown cart answer or no item to use: the cart is never touched', async () => {
  const u = rig({ unknown: true });
  await assert.rejects(readInstamartCartOffers(u.deps), (e) => e.kind === 'parse' && /not touched/.test(e.message));
  assert.deepEqual(u.calls, ['get']);
  const n = rig({ picks: null });
  await assert.rejects(readInstamartCartOffers(n.deps), (e) => e.kind === 'not_found');
  assert.ok(!n.calls.some((c) => /^(add|clear)/.test(c)));
});

// ───────────────────────── offer check, store, config ─────────────────────────

test('checkOffers: Instamart\'s coupons are recorded as one list; only the main account may use the cart', async () => {
  const s = openStore(':memory:');
  try {
    const seen = [];
    const coupons = parseCoupons(fixture('instamart-coupons'));
    const impl = { id: 'instamart', offers: async (tab, ctx) => { seen.push({ cart: ctx.cart, signedIn: ctx.signedIn }); return { rows: [], conditions: null, info: { freeDeliveryAbove: 99 }, lists: { cart: 'probe', item: 'Salt', coupons } }; } };
    const main = { id: 'main', name: 'Main', profile: 'chrome-profile' };
    const a2 = { id: 'a2', name: 'Amma', profile: 'profiles/instamart-a2' };
    const accounts = { signedIn: () => [main, a2], get: () => main };
    const poolSet = { with: async (site, acc, fn) => fn({ tab: async () => 'tab' }) };
    await checkOffers({ poolSet, accounts, sitesImpl: { instamart: impl }, sites: ['instamart'], store: s, cartOffers: { instamart: true } });
    assert.deepEqual(seen, [{ cart: true, signedIn: true }, { cart: false, signedIn: true }]);
    const lists = s.currentDeals({}).offerLists;
    assert.deepEqual(lists.map((l) => [l.site, l.kind, l.offers.length]), [['instamart', 'coupons', 6]], 'no empty payment list is made up');
    seen.length = 0;
    await checkOffers({ poolSet, accounts, sitesImpl: { instamart: impl }, sites: ['instamart'], store: s, cartOffers: { instamart: false } });
    assert.equal(seen[0].cart, false, 'deals.instamartCart: false');
  } finally {
    s.close();
  }
});

test('config: deals.instamartCart defaults on and must be a boolean', () => {
  assert.equal(DEFAULT_CONFIG.deals.instamartCart, true);
  const sites = ['zepto', 'instamart', 'bigbasket', 'blinkit', 'kpn', 'jiomart', 'flipkart_minutes', 'amazon', 'milkbasket'];
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  assert.equal(validateConfig(base, sites), null);
  base.deals.instamartCart = 1;
  assert.equal(validateConfig(base, sites)?.field, 'deals.instamartCart');
});
