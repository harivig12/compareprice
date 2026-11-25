/**
 * Instamart's coupons and payment offers (the cart's "View all coupons & offers" sheet).
 *
 * What was seen (2026-11-25, swiggy.com/instamart signed in, docs/diagnosis/2026-11-25-zepto-instamart-cart-offers.md):
 *   POST /api/instamart/checkout/v2/im-coupons?serviceLine=INSTAMART&lat&lng&userId&storeId&primaryStoreId&secondaryStoreId
 *        { cartItems: [{ itemPrice: "98.0", quantity, name, skuId, spinId }] }
 *     -> data.widgets: COUPON_APPLY, AVAILABLE_COUPONS, UNAVAILABLE_COUPONS; each coupon has couponCode,
 *        title, description, tnc.bulletTexts, isApplicable, couponPreValidationStatus { status, message }.
 *   The list is worked out from the SERVER's cart: for an empty cart it lists nothing, whatever items are
 *   sent. So, like Zepto:
 *     1. the cart already has items (the account's own basket): coupons are read for them, nothing changes;
 *     2. otherwise ONE cheap in-stock item goes in (POST /checkout/v2/cart, as the search page does),
 *        the coupons are read, and the cart is emptied again (POST /checkout/v2/cart/clear), always.
 *        "clear" empties the whole cart, so it is used only after the cart was seen EMPTY before the add,
 *        and never when anything but our item shows up in it.
 * Nothing is ever ordered, and no address, payment or coupon is touched.
 * All calls run inside the warm swiggy.com tab (pageFetch) with the page's own headers.
 */
import { SiteError } from '../errors.js';
import { minOrderFrom, shortfallFrom } from './_offers.js';

const ID = 'instamart';

/**
 * Pure: an im-coupons answer -> offers (available first, in the page's order).
 * @returns {Array<{ code: string|null, title: string, note: string|null, state: string, type: string|null,
 *                   minOrder: number|null, shortfall: number|null, description: string|null, terms: string[] }>}
 */
export function parseCoupons(json) {
  const widgets = json?.data?.widgets;
  if (!Array.isArray(widgets)) throw new SiteError('parse', `${ID}: unexpected coupons answer (no widgets)`, { site: ID });
  const out = [];
  const seen = new Set();
  for (const w of widgets) {
    const kind = w?.type ?? w?.widgetInfo?.widgetType;
    if (kind !== 'AVAILABLE_COUPONS' && kind !== 'UNAVAILABLE_COUPONS') continue;
    for (const c of Array.isArray(w.data) ? w.data : []) {
      const title = String(c?.title ?? '').trim();
      if (!title) continue;
      const code = String(c.couponCode ?? '').trim() || null;
      const key = code ?? title;
      if (seen.has(key)) continue;
      seen.add(key);
      const description = String(c.description ?? '').trim() || null;
      const msg = String(c.couponPreValidationStatus?.message ?? '').trim() || null;
      out.push({
        code,
        title,
        note: msg,
        state: kind === 'AVAILABLE_COUPONS' ? 'available' : 'locked',
        type: c.couponPreValidationStatus?.status ? String(c.couponPreValidationStatus.status) : null,
        minOrder: minOrderFrom(description) ?? minOrderFrom(title),
        shortfall: shortfallFrom(msg),
        description,
        terms: (c.tnc?.bulletTexts ?? []).map((t) => String(t).replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).slice(0, 8),
      });
    }
  }
  return out;
}

/**
 * Pure: a GET /checkout/v2/cart answer -> the cart's lines (empty when Instamart says "Cart not found").
 * @returns {{ items: Array<{ skuId: string, spinId: string|null, quantity: number, price: number|null, name: string }>, known: boolean }}
 *   known: false when the answer has a shape this code doesn't recognise
 */
export function cartLines(json) {
  const inner = json?.data;
  if (!inner || typeof inner !== 'object') return { items: [], known: false };
  // 101 "Cart not found for tid …": there is no cart, i.e. nothing in it.
  if (Number(inner.statusCode) === 101) return { items: [], known: true };
  const items = inner.data?.items;
  if (!Array.isArray(items)) return { items: [], known: Number(inner.statusCode) === 0 };
  return {
    known: true,
    items: items.filter((i) => i?.itemId && Number(i.quantity) > 0).map((i) => {
      const vars = (i.metadata?.variations ?? []).map((v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : v));
      const v = vars.find((x) => x?.id === i.itemId) ?? vars[0] ?? {};
      const price = Number(v.price?.offer_price ?? v.price?.store_price ?? v.price?.mrp);
      return { skuId: String(i.itemId), spinId: v.spin ? String(v.spin) : null, quantity: Number(i.quantity), price: price > 0 ? price : null, name: String(i.name ?? i.metadata?.display_name ?? '') };
    }),
  };
}

/** The im-coupons body for cart lines. */
export function couponsBody(lines) {
  return { cartItems: lines.map((l) => ({ itemPrice: Number(l.price ?? 0).toFixed(1), quantity: l.quantity, name: l.name, skuId: l.skuId, spinId: l.spinId })) };
}

/**
 * The cart update the search page sends for one item (quantity 1). `item` is a search item
 * ({ productId, variation }), `storeId` the page's store.
 */
export function addBody({ productId, skuId, spinId, price, storeId }) {
  const store = Number(storeId);
  return {
    data: {
      items: [{ quantity: 1, productId, spin: spinId, itemId: skuId, meta: { type: 'structure', storeId: store }, serviceLine: 'INSTAMART' }],
      cartMetaData: {
        contactlessDelivery: false, deliveryType: 'INSTANT', owner: 'APP', preferredAddressId: null, ageConsentProvided: false,
        useGiftBagPackaging: false, useReusablePackaging: false, incognitoCart: false, includeConsents: ['PHARMA'],
        primaryStoreId: store, storeIds: [store],
      },
      cartType: 'INSTAMART',
    },
    source: 'userInitiated',
    cartAnalyticsMetaInfo: { actionType: 'ADD_ITEMS', itemInfo: { itemId: skuId, quantity: 1, spin: spinId, productId, itemPrice: price }, inventoryInfo: { total: 1 } },
  };
}

/** The cheapest in-stock variation in a search answer, as { productId, skuId, spinId, price, name, podId }, or null. */
export function cheapestVariation(searchJson) {
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.productId && Array.isArray(n.variations)) {
      for (const v of n.variations) {
        const price = Number(v.price?.offerPrice?.units ?? v.price?.mrp?.units);
        // podId is the store that sells it (the page's own cart and coupon calls use it as storeId).
        if (v.skuId && v.spinId && price > 0 && v.inventory?.inStock !== false) out.push({ productId: String(n.productId), skuId: String(v.skuId), spinId: String(v.spinId), price, name: String(v.displayName ?? n.displayName ?? ''), podId: v.podId != null ? String(v.podId) : null });
      }
      return;
    }
    Object.values(n).forEach(walk);
  })(searchJson);
  return out.sort((a, b) => a.price - b.price)[0] ?? null;
}

/**
 * The check itself, with the network behind injected functions (testable offline).
 * @param {object} deps
 * @param {() => Promise<object>} deps.getCart        GET /checkout/v2/cart answer
 * @param {(lines: object[]) => Promise<object>} deps.coupons   im-coupons answer for these lines
 * @param {(item: object) => Promise<void>} deps.addItem
 * @param {() => Promise<void>} deps.clearCart
 * @param {() => Promise<object|null>} deps.pickItem  cheapestVariation(...) of a search
 * @param {(msg: string) => void} [deps.log]
 * @returns {Promise<{ cart: 'yours'|'probe', item: string|null, coupons: object[] }>}
 */
export async function readInstamartCartOffers({ getCart, coupons, addItem, clearCart, pickItem, log = () => {} }) {
  const before = cartLines(await getCart());
  if (!before.known) throw new SiteError('parse', `${ID}: unexpected cart answer; the cart was not touched`, { site: ID });

  // 1. The account's own basket: read for it, change nothing.
  if (before.items.length) {
    const lines = before.items.filter((l) => l.spinId);
    if (!lines.length) throw new SiteError('parse', `${ID}: the cart's items carry no spin ids; coupons not read, the cart was not touched`, { site: ID });
    return { cart: 'yours', item: null, coupons: parseCoupons(await coupons(lines)) };
  }

  // 2. Empty cart: one cheap item in, read, and the cart emptied again.
  const item = await pickItem();
  if (!item) throw new SiteError('not_found', `${ID}: found no in-stock item to put in the cart for the offer check`, { site: ID });
  const name = item.name.slice(0, 60) || 'an item';
  let result = null;
  let failure = null;
  let foreign = false;
  try {
    await addItem(item);
    const after = cartLines(await getCart());
    // Anything but our one item: someone else is filling this cart right now. Read nothing, and
    // do not clear (that would remove their items too).
    foreign = after.items.some((l) => l.skuId !== item.skuId) || after.items.some((l) => l.quantity > 1);
    if (foreign) throw new SiteError('parse', `${ID}: other items appeared in the cart during the offer check; it was left as it is. Remove "${name}" in Instamart if you don't want it`, { site: ID, code: 'cart_changed' });
    const lines = after.items.length ? after.items : [{ skuId: item.skuId, spinId: item.spinId, quantity: 1, price: item.price, name: item.name }];
    result = parseCoupons(await coupons(lines));
  } catch (e) {
    failure = e;
  }
  if (!foreign) {
    // The cart was empty before the add, so clearing it removes only our item.
    let emptied = false;
    for (let i = 0; i < 3 && !emptied; i++) {
      try {
        await clearCart();
        emptied = cartLines(await getCart()).items.length === 0;
      } catch (e) {
        log(`instamart: emptying the cart failed (try ${i + 1}): ${e.message}`);
      }
    }
    if (!emptied) throw new SiteError('parse', `${ID}: could not empty the cart after the offer check. Remove "${name}" in Instamart`, { site: ID, code: 'cart_not_empty' });
  }
  if (failure) throw failure;
  return { cart: 'probe', item: name, coupons: result };
}
