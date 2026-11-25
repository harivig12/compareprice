/**
 * Zepto's coupons and payment offers: parsing (real answers, scrubbed), the
 * cart safeguards (never touch a cart that has items, always put it back),
 * the store, and the offer check around it. No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { minOrderFrom, shortfallFrom, parseOfferCards, cheapestInStock, cartBody, listBody, readCartOffers } from '../src/engine/sites/zepto-offers.js';
import { checkOffers } from '../src/offers.js';
import { openStore } from '../src/store.js';
import { offerExtra } from '../src/deals.js';
import { validateConfig, DEFAULT_CONFIG } from '../src/config.js';
import { dealsMarkdown } from '../src/mcp/tools.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/sites/${n}.json`, import.meta.url), 'utf8'));

// ───────────────────────── parsing ─────────────────────────

test('minOrderFrom / shortfallFrom read the rupee figures', () => {
  assert.equal(minOrderFrom('Valid on orders above ₹99'), 99);
  assert.equal(minOrderFrom('Valid on transactions above ₹750 only on Sundays'), 750);
  assert.equal(minOrderFrom('Valid on orders above ₹1,999'), 1999);
  assert.equal(minOrderFrom('Valid on orders above Rs. 599.'), 599);
  assert.equal(minOrderFrom('Applicable once per card'), null);
  assert.equal(minOrderFrom(null), null);
  assert.equal(shortfallFrom('Shop for ₹81 more to unlock'), 81);
  assert.equal(shortfallFrom('Shop for ₹80000 more to unlock'), 80000);
  assert.equal(shortfallFrom('Locked'), null);
});

test('parseOfferCards: payment offers keep title, code, minimum, shortfall, state and terms', () => {
  const cards = parseOfferCards(fixture('zepto-offers-payment'));
  assert.equal(cards.length, 5);
  assert.deepEqual(
    { code: cards[0].code, title: cards[0].title, minOrder: cards[0].minOrder, shortfall: cards[0].shortfall, state: cards[0].state, type: cards[0].type },
    { code: 'TRYBHIM', title: 'Get up to ₹125 cashback with BHIM app', minOrder: 99, shortfall: 81, state: 'locked', type: 'BANK_OFFER' },
  );
  assert.ok(cards[0].terms.length >= 1 && cards[0].terms.every((t) => t.length <= 300));
  const dayLimited = cards.find((c) => /Tuesdays and Thursdays/.test(c.description));
  assert.equal(dayLimited.minOrder, 599, 'the day limit stays in the description');
  assert.equal(dayLimited.shortfall, null, 'no "Shop for" line on this one');
  const noMin = cards.find((c) => /Axis Bank Credit Card\./.test(c.title));
  assert.equal(noMin.minOrder, null);
  assert.ok(cards.every((c) => c.state === 'locked'));
});

test('parseOfferCards: coupons are the brand add-ons', () => {
  const cards = parseOfferCards(fixture('zepto-offers-coupons'));
  assert.equal(cards.length, 2, 'two different coupons, though both say "Coupon will be auto-applied"');
  assert.match(cards[0].title, /^Flat 5% Off on Baidyanath/);
  assert.match(cards[1].title, /^Flat ₹1000 Off on Fire TV Stick/);
  assert.equal(cards[0].shortfall, 1);
  assert.deepEqual([cards[0].code, cards[0].state], [null, 'auto-applied']);
});

test('parseOfferCards: an answer with no cards is an empty list, a wrong shape is a parse error', () => {
  assert.deepEqual(parseOfferCards({ pageLayout: { widgets: [{ widgetType: 'COUPON_PILLS_WIDGET', data: {} }] } }), []);
  assert.throws(() => parseOfferCards({ nope: 1 }), (e) => e.kind === 'parse' && /^zepto:/.test(e.message));
  // the same code twice is one offer
  const one = fixture('zepto-offers-payment').pageLayout.widgets[0];
  assert.equal(parseOfferCards({ pageLayout: { widgets: [one, one] } }).length, 1);
});

// ───────────────────────── the cart ─────────────────────────

const item = (name, paise, over = {}) => ({ id: `sp-${name}`, product: { name }, productVariant: { id: `pv-${name}` }, mrp: paise + 400, sellingPrice: paise, discountedSellingPrice: paise, availableQuantity: 5, outOfStock: false, ...over });

test('cheapestInStock: the cheapest buyable item, never an out-of-stock or incomplete one', () => {
  const items = [item('dear', 5000), item('gone', 100, { outOfStock: true }), item('none', 200, { availableQuantity: 0 }), item('cheap', 1800), { ...item('noid', 50), id: null }, item('free', 0)];
  assert.equal(cheapestInStock(items).product.name, 'cheap');
  assert.equal(cheapestInStock([item('x', 100, { outOfStock: true })]), null);
  assert.equal(cheapestInStock([]), null);
});

test('cartBody: one line for an item, none for an empty cart; listBody names the tab', () => {
  const base = { cartId: 'c1', storeId: 's1', latitude: 12.9, longitude: 80.1 };
  const one = cartBody({ ...base, item: item('salt', 1800) });
  assert.deepEqual(one.cartProducts, [{ storeProductId: 'sp-salt', productVariantId: 'pv-salt', mrp: 2200, quantity: 1, isDiscountApplicable: true, isAddedToGiftBag: false }]);
  assert.equal(one.cartProductsV2[0].cartProductId, 'pv-salt');
  const none = cartBody(base);
  assert.deepEqual([none.cartProducts, none.cartProductsV2], [[], []]);
  assert.equal(none.cartId, 'c1');
  assert.equal(listBody({ ...base, tab: 'PAYMENT_OFFERS_TAB' }).activeTab, 'PAYMENT_OFFERS_TAB');
  assert.equal(listBody({ ...base, tab: 'COUPONS_TAB' }).renderHeader, true);
});

function rig({ cartHas = false, putCounts = null, listFails = false, emptyFails = 0, picks = item('salt', 1800) } = {}) {
  const calls = [];
  const pay = fixture('zepto-offers-payment');
  const cpn = fixture('zepto-offers-coupons');
  const empty = { pageLayout: { widgets: [] } };
  let inCart = cartHas ? 3 : 0;
  let emptyTries = 0;
  return {
    calls,
    deps: {
      list: async (tab) => {
        calls.push(`list ${tab}`);
        if (listFails && inCart === 1) throw new Error('zepto: 500 boom');
        if (inCart === 0) return empty;
        return tab === 'PAYMENT_OFFERS_TAB' ? pay : cpn;
      },
      putCart: async (it) => {
        calls.push(it ? `put ${it.product.name}` : 'put empty');
        if (it) { inCart = putCounts ?? 1; return { cartId: 'c1', itemQuantityCount: inCart }; }
        if (emptyTries++ < emptyFails) return { cartId: 'c1', itemQuantityCount: inCart };
        inCart = 0;
        return { cartId: 'c1', itemQuantityCount: 0 };
      },
      pickItem: async () => { calls.push('pick'); return picks; },
    },
  };
}

test('a cart that already has items is only read: nothing is put in, nothing is taken out', async () => {
  const r = rig({ cartHas: true });
  const out = await readCartOffers(r.deps);
  assert.equal(out.cart, 'yours');
  assert.equal(out.payment.length, 5);
  assert.equal(out.coupons.length, 2);
  assert.ok(!r.calls.some((c) => c.startsWith('put') || c === 'pick'), r.calls.join(', '));
});

test('an empty cart: one item in, both lists read, the cart put back empty, in that order', async () => {
  const r = rig();
  const out = await readCartOffers(r.deps);
  assert.deepEqual(r.calls, ['list PAYMENT_OFFERS_TAB', 'pick', 'put salt', 'list PAYMENT_OFFERS_TAB', 'list COUPONS_TAB', 'put empty']);
  assert.equal(out.cart, 'probe');
  assert.equal(out.item, 'salt');
  assert.equal(out.payment.length, 5);
});

test('a read that fails still empties the cart, then reports the failure', async () => {
  const r = rig({ listFails: true });
  await assert.rejects(readCartOffers(r.deps), /boom/);
  assert.equal(r.calls.at(-1), 'put empty');
});

test('emptying is retried; if it never works the error names the item to remove', async () => {
  const retry = rig({ emptyFails: 2 });
  assert.equal((await readCartOffers(retry.deps)).cart, 'probe');
  assert.equal(retry.calls.filter((c) => c === 'put empty').length, 3);
  const stuck = rig({ emptyFails: 9 });
  await assert.rejects(readCartOffers(stuck.deps), (e) => e.kind === 'parse' && e.code === 'cart_not_empty' && /Remove "salt" in Zepto/.test(e.message));
});

test('if the cart holds anything but the one item after adding, nothing is "restored" over it', async () => {
  const r = rig({ putCounts: 2 });
  await assert.rejects(readCartOffers(r.deps), (e) => e.code === 'cart_changed');
  assert.ok(!r.calls.includes('put empty'));
});

test('no in-stock item to use: an error, and the cart is never touched', async () => {
  const r = rig({ picks: null });
  await assert.rejects(readCartOffers(r.deps), (e) => e.kind === 'not_found');
  assert.ok(!r.calls.some((c) => c.startsWith('put')));
});

// ───────────────────────── store ─────────────────────────

test('store: offer lists are replaced per check, ordered by minimum, and forgotten with the account', () => {
  const s = openStore(':memory:');
  try {
    const cards = parseOfferCards(fixture('zepto-offers-payment'));
    const t0 = '2026-11-25T01:30:00.000Z';
    s.recordOfferList({ site: 'zepto', kind: 'payment', offers: cards, checkedAt: t0, cart: 'probe', item: 'Salt 1 kg' });
    s.recordOfferList({ site: 'zepto', kind: 'coupons', offers: parseOfferCards(fixture('zepto-offers-coupons')), checkedAt: t0, cart: 'probe', item: 'Salt 1 kg' });
    let cur = s.currentDeals({ now: Date.parse(t0) + 60_000 });
    const pay = cur.offerLists.find((l) => l.kind === 'payment');
    assert.equal(pay.offers.length, 5);
    assert.deepEqual([pay.cart, pay.item, pay.checkedAt], ['probe', 'Salt 1 kg', t0]);
    const mins = pay.offers.map((o) => o.minOrder);
    assert.deepEqual(mins.filter((m) => m != null), [...mins.filter((m) => m != null)].sort((a, b) => a - b), 'smallest minimum first');
    assert.equal(mins.at(-1), null, 'no stated minimum goes last');
    assert.ok(pay.offers[0].terms.length >= 1);
    assert.equal(pay.offers.find((o) => /Tuesdays and Thursdays/.test(o.description)).extra, 'only on Tuesdays and Thursdays');
    assert.equal(pay.offers[0].extra, null);
    assert.ok(s.currentDeals({}).offerLists.find((l) => l.kind === 'coupons').offers.every((o) => o.extra === null), 'coupon descriptions only restate their titles');
    assert.equal(cur.offerLists.find((l) => l.kind === 'coupons').offers.length, 2);
    // a later check replaces the earlier rows
    s.recordOfferList({ site: 'zepto', kind: 'payment', offers: cards.slice(0, 2), checkedAt: '2026-11-25T12:30:00.000Z', cart: 'yours' });
    cur = s.currentDeals({});
    assert.equal(cur.offerLists.find((l) => l.kind === 'payment').offers.length, 2);
    assert.equal(cur.offerLists.find((l) => l.kind === 'payment').cart, 'yours');
    s.forgetAccountDeals('zepto', 'main');
    assert.deepEqual(s.currentDeals({}).offerLists, []);
  } finally {
    s.close();
  }
});

// ───────────────────────── the offer check ─────────────────────────

const zeptoImpl = (offers) => ({ id: 'zepto', offers });

test('checkOffers: Zepto\'s lists are recorded, the cart switch and sign-in reach the site module', async () => {
  const s = openStore(':memory:');
  try {
    const seen = [];
    const lists = { cart: 'probe', item: 'Salt 1 kg', payment: parseOfferCards(fixture('zepto-offers-payment')), coupons: parseOfferCards(fixture('zepto-offers-coupons')) };
    const impl = zeptoImpl(async (tab, ctx) => { seen.push({ cart: ctx.cart, signedIn: ctx.signedIn, acquire: typeof ctx.acquire }); return { rows: [], conditions: null, info: { freeDeliveryAbove: 99 }, lists }; });
    const main = { id: 'main', name: 'Main', profile: 'chrome-profile' };
    const accounts = { signedIn: () => [main], get: () => main };
    const poolSet = { with: async (site, acc, fn) => fn({ tab: async () => 'tab' }) };
    const out = await checkOffers({ poolSet, accounts, sitesImpl: { zepto: impl }, sites: ['zepto'], store: s, zeptoCart: true });
    assert.deepEqual(seen, [{ cart: true, signedIn: true, acquire: 'function' }]);
    assert.equal(out.offers[0].offers, 7);
    assert.equal(out.offers[0].cart, 'probe');
    const cur = s.currentDeals({});
    assert.equal(cur.offerLists.length, 2);
    assert.equal(s.siteInfo().zepto.freeDeliveryAbove, 99);
    // switched off in config: the site module is told
    await checkOffers({ poolSet, accounts, sitesImpl: { zepto: impl }, sites: ['zepto'], store: s, zeptoCart: false });
    assert.equal(seen[1].cart, false);
    // a guest is not signed in
    await checkOffers({ poolSet, accounts: { signedIn: () => [], get: () => main }, sitesImpl: { zepto: impl }, sites: ['zepto'], store: s });
    assert.equal(seen[2].signedIn, false);
  } finally {
    s.close();
  }
});

test('checkOffers: a failed offers part is shown as the check\'s error and the earlier lists stay', async () => {
  const s = openStore(':memory:');
  try {
    const main = { id: 'main', name: 'Main', profile: 'chrome-profile' };
    const accounts = { signedIn: () => [main], get: () => main };
    const poolSet = { with: async (site, acc, fn) => fn({ tab: async () => 'tab' }) };
    s.recordOfferList({ site: 'zepto', kind: 'payment', offers: parseOfferCards(fixture('zepto-offers-payment')), cart: 'probe' });
    const impl = zeptoImpl(async () => ({ rows: [], conditions: null, info: { freeDeliveryAbove: 99 }, warning: 'zepto: could not empty the cart after the offer check. Remove "Salt" in Zepto' }));
    const out = await checkOffers({ poolSet, accounts, sitesImpl: { zepto: impl }, sites: ['zepto'], store: s });
    assert.match(out.offers[0].warning, /Remove "Salt" in Zepto/);
    const cur = s.currentDeals({});
    assert.match(cur.errors[0].error, /Remove "Salt" in Zepto/);
    assert.equal(cur.offerLists[0].offers.length, 5, 'the last good list is kept');
    assert.equal(s.siteInfo().zepto.freeDeliveryAbove, 99, 'the free-delivery fact still counts');
  } finally {
    s.close();
  }
});

// ───────────────────────── config, MCP ─────────────────────────

test('config: deals.zeptoCart defaults on and must be a boolean', () => {
  assert.equal(DEFAULT_CONFIG.deals.zeptoCart, true);
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  assert.equal(validateConfig(base, ['zepto', 'instamart', 'bigbasket', 'blinkit', 'kpn', 'jiomart', 'flipkart_minutes', 'amazon', 'milkbasket']), null);
  base.deals.zeptoCart = 'yes';
  assert.equal(validateConfig(base, ['zepto', 'instamart', 'bigbasket', 'blinkit', 'kpn', 'jiomart', 'flipkart_minutes', 'amazon', 'milkbasket'])?.field, 'deals.zeptoCart');
});

test('offerExtra: a day limit is kept; a description that only restates the title, or the minimum, is not', () => {
  assert.equal(offerExtra({ title: 'Flat ₹150 off with Visa', description: 'Valid on orders above ₹750 only on Sundays' }), 'only on Sundays');
  assert.equal(offerExtra({ title: 'Get up to ₹125 cashback with BHIM app', description: 'Valid on orders above ₹99' }), null);
  assert.equal(offerExtra({ title: 'Flat 5% Off on Baidyanath products', description: 'Flat 5% Off on selected Baidyanath products' }), null);
  assert.match(offerExtra({ title: 'Flat ₹150 or ₹15 cashback with Jupiter UPI', description: 'Earn cashback in the form of Jewels on the Jupiter App on orders above ₹199' }), /^Earn cashback/);
  assert.equal(offerExtra({ title: 'x', description: null }), null);
});

test('the MCP deals text lists Zepto\'s cart offers, ten at a time', () => {
  const offers = Array.from({ length: 12 }, (_, i) => ({ code: `C${i}`, title: `Offer ${i}`, minOrder: 99 + i, extra: i === 0 ? 'only on Sundays' : null, terms: [] }));
  const t = dealsMarkdown({ minDiscountPct: 80, groups: [], fromSearches: [], errors: [], offerLists: [{ site: 'zepto', kind: 'payment', checkedAt: '2026-11-25T01:30:00.000Z', cart: 'probe', item: 'Salt', offers }] });
  assert.match(t, /\*\*zepto · payment offers\*\* \(12 cart offers, checked 07:00\)/);
  assert.match(t, /- Offer 0 \[C0\] · above ₹99\.00 · only on Sundays$/m);
  assert.match(t, /- Offer 1 \[C1\] · above ₹100\.00$/m);
  assert.match(t, /… and 2 more \(see the page\)/);
  assert.doesNotMatch(t, /No offer check has run yet/);
});
