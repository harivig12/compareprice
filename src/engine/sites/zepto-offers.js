/**
 * Zepto's coupons and payment offers (the cart's "Coupons & offers" lists).
 *
 * What was seen (2026-11-25, docs/diagnosis/2026-11-25-zepto-instamart-cart-offers.md):
 *   POST bff-gateway.zepto.com/cfs/api/v1/cart/coupons/fetch-list
 *     { activeTab: 'PAYMENT_OFFERS_TAB' | 'COUPONS_TAB', cartId, storeId, latitude, longitude, ... }
 *   answers one COUPON_CARD_WIDGET per offer (heading, code, "Shop for ₹X more to unlock",
 *   state, terms). With an EMPTY cart it answers no offers at all, so the lists can only be
 *   read while something is in the cart.
 *
 * The check therefore:
 *   1. asks for the lists as they are. Offers back means the account's cart already has
 *      items (its own basket): they are read as they are and the cart is NOT touched.
 *   2. otherwise puts ONE cheap in-stock item in the cart (PUT /cfs/api/v1/cart), reads
 *      both lists, and puts the cart back to empty, always, even when a step fails.
 *      If it cannot be emptied the check fails loudly, naming the item to remove.
 * Nothing is ever ordered, and no address, payment or coupon is touched.
 */
import { SiteError } from '../errors.js';
import { minOrderFrom, shortfallFrom } from './_offers.js';

export { minOrderFrom, shortfallFrom };

const ID = 'zepto';

/**
 * Pure: a fetch-list answer -> offers, in the page's order.
 * @returns {Array<{ code: string|null, title: string, note: string|null, state: string, type: string|null,
 *                   minOrder: number|null, shortfall: number|null, description: string|null, terms: string[] }>}
 */
export function parseOfferCards(json) {
  const widgets = json?.pageLayout?.widgets;
  if (!Array.isArray(widgets)) throw new SiteError('parse', `${ID}: unexpected offers answer (no page layout)`, { site: ID });
  const out = [];
  const seen = new Set();
  for (const w of widgets) {
    if (w?.widgetType !== 'COUPON_CARD_WIDGET') continue;
    const it = w.data?.items;
    const title = String(it?.heading?.text ?? '').trim();
    if (!title) continue;
    const meta = it.couponButton?.action?.actionMeta ?? {};
    // The real code is in the button's action. The card's own code text is a label on auto-applied
    // coupons ("Coupon will be auto-applied" on all of them), so it only counts when it looks like a code.
    const label = String(it.couponCode?.text ?? '').trim();
    const code = String(meta.couponCode ?? '').trim() || (/^[A-Z0-9][A-Z0-9_-]{3,}$/.test(label) ? label : null);
    const key = code ?? title;
    if (seen.has(key)) continue;
    seen.add(key);
    const description = String(it.termsAndConditions?.description ?? '').trim() || null;
    const note = String(it.subheading?.text ?? '').trim() || null;
    out.push({
      code,
      title,
      note,
      state: String(it.couponButton?.couponState ?? it.couponButton?.state ?? '').toLowerCase() || (/auto-applied/i.test(label) ? 'auto-applied' : 'unknown'),
      type: meta.couponType ? String(meta.couponType) : null,
      minOrder: minOrderFrom(description),
      shortfall: shortfallFrom(note),
      description,
      terms: (it.termsAndConditions?.terms ?? []).map((t) => String(t).replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).slice(0, 8),
    });
  }
  return out;
}

/** The cheapest in-stock search result (a Zepto search item), or null. Prices are in paise. */
export function cheapestInStock(items) {
  const price = (x) => Number(x.discountedSellingPrice ?? x.sellingPrice);
  return (
    (items ?? [])
      .filter((x) => x?.id && x.productVariant?.id && x.outOfStock !== true && (x.availableQuantity ?? 1) > 0 && price(x) > 0 && Number(x.mrp) > 0)
      .sort((a, b) => price(a) - price(b))[0] ?? null
  );
}

const LEAVE = { leaveAtGate: false, doNotRingBell: false, bewareOfPets: false, returnPaperBag: false, returnCokePetBottle: false };

/** The cart update body for `lines` (empty = an empty cart). `item` is a Zepto search item. */
export function cartBody({ cartId, storeId, latitude, longitude, item = null }) {
  const lines = item
    ? [{ storeProductId: item.id, productVariantId: item.productVariant.id, mrp: Number(item.mrp), quantity: 1, isDiscountApplicable: true, isAddedToGiftBag: false }]
    : [];
  return {
    storeId, cartId,
    cartProducts: lines,
    cartProductsV2: lines.map((l) => ({ ...l, cartProductId: l.productVariantId, addOns: [] })),
    swappedPvIds: {}, removedCampaignProducts: [], availedCampaignProducts: [], availedCampaignProductIds: [],
    deliveryInstructions: LEAVE, oosProductMeta: [], riderTip: 0, latitude, longitude,
    useZeptoCash: true, userPreferences: {}, isLayoutRequired: true,
  };
}

/** The offer-list request body. */
export function listBody({ cartId, storeId, latitude, longitude, tab }) {
  return {
    activeTab: tab, filterKey: null, renderHeader: tab === 'COUPONS_TAB',
    cartId, storeId, latitude, longitude, userAddressId: '',
    useZCoins: false, useZeptoCash: true, removedCampaignProducts: [], installedUpiApps: [], isCredPayEligible: true,
    enableTabbedView: true, pageType: 'COUPON_REVAMP',
  };
}

/**
 * The check itself, with the network behind two injected functions (so it is testable offline).
 * @param {object} deps
 * @param {(tab: 'PAYMENT_OFFERS_TAB'|'COUPONS_TAB') => Promise<object>} deps.list   fetch-list answer (JSON)
 * @param {(item: object|null) => Promise<object>} deps.putCart   set the cart to `item` (null = empty); answers the cart JSON
 * @param {() => Promise<object|null>} deps.pickItem   the cheapest in-stock search item
 * @param {(msg: string) => void} [deps.log]
 * @returns {Promise<{ cart: 'yours'|'probe', item: string|null, payment: object[], coupons: object[] }>}
 */
export async function readCartOffers({ list, putCart, pickItem, log = () => {} }) {
  const read = async () => ({ payment: parseOfferCards(await list('PAYMENT_OFFERS_TAB')), coupons: parseOfferCards(await list('COUPONS_TAB')) });

  // 1. As things are. Offers back = the account's cart has items: read, never touch.
  const first = parseOfferCards(await list('PAYMENT_OFFERS_TAB'));
  if (first.length) return { cart: 'yours', item: null, payment: first, coupons: parseOfferCards(await list('COUPONS_TAB')) };

  // 2. Empty cart: one cheap item in, read, and out again.
  const item = await pickItem();
  if (!item) throw new SiteError('not_found', `${ID}: found no in-stock item to put in the cart for the offer check`, { site: ID });
  const name = String(item.product?.name ?? 'an item').slice(0, 60);
  let cart = await putCart(item);
  if (Number(cart?.itemQuantityCount) !== 1) {
    // Not the one item we put there: someone else's items are in. Do not "restore" over them.
    throw new SiteError('parse', `${ID}: the cart held ${cart?.itemQuantityCount ?? '?'} items after adding one; left as it is`, { site: ID, code: 'cart_changed' });
  }
  let result;
  let failure = null;
  try {
    result = await read();
  } catch (e) {
    failure = e;
  }
  // Always put the cart back, whatever happened above.
  let emptied = false;
  for (let i = 0; i < 3 && !emptied; i++) {
    try {
      cart = await putCart(null);
      emptied = Number(cart?.itemQuantityCount) === 0;
    } catch (e) {
      log(`zepto: emptying the cart failed (try ${i + 1}): ${e.message}`);
    }
  }
  if (!emptied) throw new SiteError('parse', `${ID}: could not empty the cart after the offer check. Remove "${name}" in Zepto`, { site: ID, code: 'cart_not_empty' });
  if (failure) throw failure;
  return { cart: 'probe', item: name, ...result };
}
