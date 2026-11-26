/**
 * Milkbasket: signed-in account only, GraphQL at consumerbff.milkbasket.com.
 *
 * Recon 2026-11-19 (docs/diagnosis/2026-11-19-account-offers-zepto-milkbasket.md):
 *   - Guests are pinned to the default city, so a session is required. The
 *     session headers (authorization, cityid, hubid, app versions) are copied
 *     from the page's own GraphQL calls, never stored.
 *   - The web app has no product-search query (its search box opens the
 *     membership page while the plan is expired), but the WHOLE catalogue is
 *     readable: getProductCategories (38 categories, 250 subcategories), then
 *     getCatalogProductList per subcategory. So "search" = read the catalogue
 *     once a day (paced, cached on disk), then match locally.
 *   - ₹1 deals: getMegaFlashDeal { id } (the id the home page asks for), then
 *     getMegaFlashDealProducts pages.
 *   - Calls answer directly from Node with the session (API first); a refusal
 *     falls back to fetch inside the tab (src/engine/direct.js).
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expectJson } from '../page-fetch.js';
import { apiFetch } from '../direct.js';
import { SiteError } from '../errors.js';
import { bestPack } from './_util.js';
import { categoryPath } from '../../categories.js';
import { CATEGORIES, CATALOG, MEGA_DEAL, MEGA_DEAL_PRODUCTS, FETCH_BASKET, ADD_TO_BASKET } from './milkbasket/queries.js';
import { collectResponses } from './_capture.js';
import { DATA_DIR } from '../../paths.js';

const ID = 'milkbasket';
const ORIGIN = 'https://www.milkbasket.com/';
const GQL = 'https://consumerbff.milkbasket.com/graphql';
const GQL_RE = /consumerbff\.milkbasket\.com\/graphql/;
/** Catalogue refresh: once a day is plenty for prices that change daily at most. */
export const CATALOG_MAX_AGE_MS = 20 * 3600_000;
const PAGE_LIMIT = 50;
/** Hard stop for any paged list (a feed that says hasNextPage forever). */
export const MAX_PAGES = 10;
/** Gap between catalogue calls: ~300 calls, about 4 minutes, once a day. */
const CATALOG_GAP_MS = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One Milkbasket product ({ product, variant } or a bare product) -> engine row. */
export function productRow(item) {
  const p = item?.product ?? item;
  if (!p?.name) return null;
  const price = Number(p.price?.price?.value);
  if (!(price > 0)) return null;
  const mrp = Number(p.price?.mrp?.value);
  const weight = p.weight?.text ?? '';
  const pack = bestPack(weight, p.name);
  const av = p.availability ?? {};
  return {
    name: weight && !p.name.includes(weight) ? `${p.name} ${weight.toLowerCase()}` : p.name,
    brand: null,
    packSize: pack ? pack.size : null,
    packUnit: pack ? pack.unit : null,
    price,
    mrp: mrp > price ? mrp : null,
    inStock: !(av.oos || av.isOos || av.forcedOos),
    url: `${ORIGIN}?product=${p.id}`,
    category: categoryPath(p.category?.name, p.category?.subCategory?.name, p.category?.subCategory?.type),
    ...(av.maxQuantity ? { maxQty: Number(av.maxQuantity) } : {}),
  };
}

/** A paged product list (catalogue or deal) -> { rows, hasNext }. */
export function parseList(list) {
  const products = list?.products ?? [];
  return { rows: products.map(productRow).filter(Boolean), hasNext: Boolean(list?.pages?.hasNextPage) && products.length > 0 };
}

/** Query words that pick candidates from the catalogue (the scorer then decides). */
export function queryWords(query) {
  return String(query).toLowerCase()
    .replace(/\d+(\.\d+)?\s*(kg|g|gm|gms|grams?|l|ltr|litres?|ml|pcs?|pieces?|x)\b/g, ' ')
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !['and', 'the', 'with', 'pack', 'fresh'].includes(w));
}

/**
 * Catalogue rows whose name has the query's words (as a word start), best
 * first: rows with every word, then rows with some. A word that only appears
 * negated ("Low Sugar Potato", "Sugar Free Chocolate", "sugarless") doesn't
 * count: a whole catalogue has those, a site's own search for "sugar" doesn't
 * (live run 2026-11-19 picked Low Sugar Potato for "sugar 1kg").
 */
export function matchCatalog(rows, query, limit = 60) {
  const words = queryWords(query);
  if (!words.length) return [];
  const hit = (name, w) => {
    const n = name.toLowerCase();
    if (!new RegExp(`\\b${w}`).test(n)) return false;
    const negated = new RegExp(`\\b(low|no|zero|less|without|reduced)[\\s-]+${w}|\\b${w}[\\s-]*(free|less)\\b`);
    return !negated.test(n);
  };
  const scored = [];
  for (const r of rows) {
    const n = words.filter((w) => hit(r.name, w)).length;
    if (n) scored.push([n, r]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, r]) => r);
}

const lower = (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
const SESSION_MAX_AGE_MS = 20 * 60_000;

/**
 * Keep the headers of the page's latest GraphQL call that carries a session
 * (`authorization` + `hubid`). Some of the app's calls (app config, theme) go
 * without one, so "the last call" is not enough (live run 2026-11-19).
 */
function watchSession(tab) {
  if (tab._mbSession) return tab._mbSession;
  const state = { headers: null, at: 0 };
  tab.on('Network.requestWillBeSent', (p) => {
    if (!GQL_RE.test(p.request?.url || '') || p.request.method === 'OPTIONS') return;
    const h = lower(p.request.headers);
    if (!h.authorization || !h.hubid) return;
    state.headers = Object.fromEntries(Object.entries(p.request.headers).filter(([k]) => !/^(:|host$|cookie$|content-length$|accept-encoding$|connection$|origin$|referer$|user-agent$|sec-|priority$)/i.test(k)));
    state.at = Date.now();
  });
  tab._mbSession = state;
  return state;
}

async function session(tab) {
  // Tests (and callers that already hold a session) can preset the capture.
  const preset = tab._capture?.[ID];
  let headers = preset?.headers ?? null;
  if (!headers) {
    const s = watchSession(tab);
    if (!s.headers || Date.now() - s.at > SESSION_MAX_AGE_MS) {
      s.headers = null;
      const seen = tab.waitForEvent('Network.requestWillBeSent', (p) => GQL_RE.test(p.request?.url || '') && Boolean(lower(p.request.headers).authorization), 20000);
      await tab.goto(ORIGIN, { waitMs: 15000 });
      await seen;
      for (let i = 0; i < 10 && !s.headers; i++) await sleep(300);
    }
    headers = s.headers;
    // The app's first calls go out with the default city (hub 1 / city 1)
    // before it loads the account's society from storage; use the account's
    // own hub and city (its saved address) for every call we make.
    const own = await tab.evaluate(`(() => { const g = (k) => { const v = localStorage.getItem(k); try { return JSON.parse(v); } catch { return v; } };
      return { hub: g('MB_PERSIST_USER_HUB'), city: g('MB_PERSIST_USER_CITY') }; })()`, { timeoutMs: 5000 }).catch(() => null);
    if (headers && Number(own?.hub) > 0 && Number(own?.city) > 0) {
      headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, /^hubid$/i.test(k) ? String(own.hub) : /^cityid$/i.test(k) ? String(own.city) : v]));
    }
  }
  const h = lower(headers);
  if (!h.authorization || !h.hubid || String(h.cityid) === '1') {
    const why = !headers ? 'the page made no signed-in request' : !h.authorization ? 'no session token' : !h.hubid ? 'no hub' : 'guest city';
    // Said for whichever account this tab belongs to (search uses the main one, deals any).
    throw new SiteError('session', `${ID}: this account is not signed in (${why}); sign it in again from "Sign in…". Guests only see the default city`, { site: ID });
  }
  return { headers, hubId: Number(h.hubid), cityId: Number(h.cityid) };
}

async function gql(tab, s, operationName, query, variables, { log } = {}) {
  const res = await apiFetch(tab, GQL, {
    method: 'POST',
    headers: { ...s.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ operationName, variables, query }),
  }, { siteId: ID, log });
  const j = expectJson(res, ID);
  if (j?.errors?.length) {
    const msg = String(j.errors[0]?.message ?? 'error').slice(0, 120);
    const kind = /unauthori|token|login|expired/i.test(msg) ? 'session' : 'parse';
    throw new SiteError(kind, `${ID}: ${operationName}: ${msg}`, { site: ID });
  }
  return j?.data ?? {};
}

/** Page through a list until it ends, comes back empty, or MAX_PAGES. */
async function allPages(fetchPage) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { rows: got, hasNext } = parseList(await fetchPage(page));
    rows.push(...got);
    if (!hasNext) break;
  }
  return rows;
}

const cacheFile = (hubId, dir) => join(dir, 'cache', `milkbasket-catalog-${hubId}.json`);
const memory = new Map(); // hubId -> { fetchedAt, rows }
const inflight = new Map(); // hubId -> Promise

/**
 * The whole catalogue for the account's hub, at most CATALOG_MAX_AGE_MS old.
 * Product data only (names, prices, packs) is cached on disk; no session data.
 */
export async function catalog(tab, { now = Date.now, dir = DATA_DIR, gap = CATALOG_GAP_MS, log } = {}) {
  const s = await session(tab);
  const fresh = (c) => c && now() - c.fetchedAt < CATALOG_MAX_AGE_MS;
  let c = memory.get(s.hubId);
  if (!fresh(c)) {
    try { c = JSON.parse(readFileSync(cacheFile(s.hubId, dir), 'utf8')); } catch { c = null; }
  }
  if (fresh(c)) { memory.set(s.hubId, c); return c.rows; }
  if (!inflight.has(s.hubId)) {
    inflight.set(s.hubId, (async () => {
      const cats = (await gql(tab, s, 'fetchProductCategories', CATEGORIES, {}, { log })).getProductCategories ?? [];
      const subs = cats.flatMap((cat) => (cat.subCategories ?? []).filter((x) => !x.oos).map((x) => x.id));
      if (!subs.length) throw new SiteError('parse', `${ID}: the catalogue has no categories (payload shape changed?)`, { site: ID });
      const rows = [];
      const seen = new Set();
      for (const subCategoryId of subs) {
        const got = await allPages(async (page) => {
          await sleep(gap);
          return (await gql(tab, s, 'getCatalogProductList', CATALOG, { hubId: s.hubId, cityId: s.cityId, page: { page, limit: PAGE_LIMIT }, filters: { subCategoryId } }, { log })).getCatalogProductList;
        });
        for (const r of got) if (!seen.has(r.url)) { seen.add(r.url); rows.push(r); }
      }
      const out = { fetchedAt: now(), hubId: s.hubId, subcategories: subs.length, rows };
      mkdirSync(join(dir, 'cache'), { recursive: true });
      const file = cacheFile(s.hubId, dir);
      writeFileSync(`${file}.tmp`, JSON.stringify(out));
      renameSync(`${file}.tmp`, file);
      memory.set(s.hubId, out);
      log?.(`${ID}: catalogue refreshed: ${rows.length} products in ${subs.length} subcategories`);
      return out;
    })().finally(() => inflight.delete(s.hubId)));
  }
  return (await inflight.get(s.hubId)).rows;
}

/**
 * The catalogue already read today (memory, else the newest file in the cache),
 * without any call to Milkbasket; [] when there is none yet.
 */
export function cachedRows({ dir = DATA_DIR, now = Date.now, anyAge = false } = {}) {
  // anyAge: picking a product for a scheduled add (ids don't change; the price is shown as "read on …").
  const fresh = (c) => c && (anyAge || now() - c.fetchedAt < CATALOG_MAX_AGE_MS);
  for (const c of memory.values()) if (fresh(c)) return c.rows;
  try {
    const files = readdirSync(join(dir, 'cache')).filter((f) => /^milkbasket-catalog-\d+\.json$/.test(f));
    for (const f of files) {
      const c = JSON.parse(readFileSync(join(dir, 'cache', f), 'utf8'));
      if (fresh(c)) return c.rows;
    }
  } catch { /* no cache yet */ }
  return [];
}

/**
 * This account's ₹1-style flash deal: { rows, conditions } (no product search).
 * One reload of the home page captures the session and the deal id it asks for.
 */
export async function offers(tab, { log } = {}) {
  let dealId = null;
  // The home page loads its fee strip ("Shop for ₹99 to waive the ₹15 Small cart fee").
  const fees = collectResponses(tab, GQL_RE);
  const off = tab.on('Network.requestWillBeSent', (p) => {
    if (!GQL_RE.test(p.request?.url || '')) return;
    try {
      const b = JSON.parse(p.request.postData || '{}');
      if (b.operationName === 'getMegaFlashDeal' && b.variables?.id != null) dealId = b.variables.id;
    } catch { /* not JSON */ }
  });
  try {
    watchSession(tab);
    await tab.goto(ORIGIN, { waitMs: 15000 });
    for (let i = 0; i < 20 && dealId == null; i++) await sleep(500);
  } finally {
    off?.();
  }
  const info = feeInfo(await fees.done());
  const s = await session(tab);
  if (dealId == null) return { rows: [], conditions: null, info, note: 'no flash deal on the home page' };
  const deal = (await gql(tab, s, 'getMegaFlashDeal', MEGA_DEAL, { id: dealId }, { log })).getMegaFlashDeal;
  if (!deal?.listId) return { rows: [], conditions: null, note: 'flash deal has no product list' };
  const rows = await allPages(async (page) => (await gql(tab, s, 'getMegaFlashDealProducts', MEGA_DEAL_PRODUCTS, { listId: String(deal.listId), showInStockOnly: false, page: { page, limit: 15 } }, { log })).getMegaFlashDealProducts);
  const conditions = {
    ...(Number(deal.maxQty) > 0 ? { maxQty: Number(deal.maxQty) } : {}),
    ...(Number(deal.mov) > 0 ? { minBasket: Number(deal.mov) } : {}),
    // The title is sometimes a placeholder ("."); keep it only when it says something.
    ...(/[a-z]{3}/i.test(deal.title ?? '') ? { title: String(deal.title).slice(0, 80) } : {}),
  };
  return { rows, conditions: Object.keys(conditions).length ? conditions : null, info };
}

/**
 * The account's own fee rule from getExtraFeeStrips: a fee (e.g. ₹15 "Small
 * cart fee") below a minimum order (e.g. ₹99). Null when the page didn't load it.
 */
export function feeInfo(responses) {
  for (const r of responses) {
    if (r.op !== 'getExtraFeeStrips') continue;
    try {
      const strip = (JSON.parse(r.text)?.data?.getExtraFeeStrips ?? [])[0];
      const below = Number(strip?.mov?.amount);
      const fee = Number(strip?.mrp?.amount);
      if (below > 0) return { freeDeliveryAbove: below, ...(fee > 0 ? { feeBelow: fee, feeName: String(strip.name ?? 'fee').slice(0, 40) } : {}) };
    } catch { /* not JSON */ }
  }
  return null;
}

// ── Scheduled adds (user decision 2026-11-25): put a listed product in the next basket, then stop ──

/** Milkbasket's own refusal codes (from its web app) in words; any other code is shown as it came. */
export const BASKET_ERRORS = {
  cutoff_time_exceeded: 'past the cutoff for the next delivery',
  time_recheck: 'past the cutoff for the next delivery',
  time_recheck_get: 'past the cutoff for the next delivery',
  holiday_off: 'deliveries are paused (holiday) for this account',
  society_delivery_holiday: 'deliveries are paused for this society',
  vendor_off: 'the product is not available from its vendor',
  insufficient_credits: 'not enough money in the Milkbasket wallet',
  insufficient_credits_unpaid: 'not enough money in the Milkbasket wallet',
  max_quantity_exceeded: 'more than Milkbasket allows for this product',
  limit_reached: 'the order limit is reached',
  not_in_service_area: 'the address is not served',
  delivery_not_started: 'deliveries have not started for this address',
};

/** The product's id from a catalogue row's url (`…/?product=<id>`), or null. */
export const productIdOf = (row) => { const m = /[?&]product=(\d+)/.exec(row?.url ?? ''); return m ? Number(m[1]) : null; };

/** The next basket: { id, date, items: Map productId -> quantity } (a read; changes nothing). */
export async function readBasket(tab, { log } = {}) {
  const s = await session(tab);
  const b = (await gql(tab, s, 'fetchBasket', FETCH_BASKET, {}, { log })).getPrunedBasket;
  if (!b) throw new SiteError('parse', `${ID}: fetchBasket returned no basket (payload shape changed?)`, { site: ID });
  const items = new Map();
  for (const p of b.products ?? []) {
    const q = Number(p?.order?.quantity);
    if (q > 0) items.set(Number(p.order.productId ?? p.id), q);
  }
  return { id: b.id ?? null, date: b.date ?? null, items, session: s };
}

/**
 * Make sure the next basket holds at least `qty` of one product, and stop there: never more
 * than asked, never fewer than already in it, never past the basket (no order, no payment).
 * @returns {Promise<{ status: 'added'|'already'|'skipped', had: number, now: number, added: number, reason?: string, code?: string }>}
 */
export async function ensureInBasket(tab, { productId, qty, price }, { log } = {}) {
  const id = Number(productId);
  const want = Math.floor(Number(qty));
  if (!(id > 0) || !(want >= 1)) throw new SiteError('parse', `${ID}: a scheduled add needs a product id and a quantity`, { site: ID });
  const basket = await readBasket(tab, { log });
  const had = basket.items.get(id) ?? 0;
  if (had >= want) return { status: 'already', had, now: had, added: 0 };
  if (!basket.date) return { status: 'skipped', had, now: had, added: 0, reason: 'the basket has no delivery date yet (no next delivery?)' };
  const appVersion = lower(basket.session.headers).appversion ?? '';
  const payload = { quantity: want, date: basket.date, productId: id, bypassTimeCheck: false, price: Number(price) || 0, appVersion: String(appVersion), offerIds: [], fetchOffers: false };
  const r = (await gql(tab, basket.session, 'addToBasket', ADD_TO_BASKET, { payload }, { log })).addToBasket;
  if (r?.error?.error) {
    const code = String(r.error.error);
    return { status: 'skipped', had, now: had, added: 0, code, reason: BASKET_ERRORS[code] ?? (String(r.error.errorMsg || code).slice(0, 120)) };
  }
  const after = (r?.prunedBasket?.products ?? []).find((p) => Number(p?.order?.productId ?? p?.id) === id);
  const now = Number(after?.order?.quantity ?? want);
  return { status: 'added', had, now, added: Math.max(0, now - had) };
}

export default {
  id: ID,
  label: 'Milkbasket',
  origin: ORIGIN,
  domFallback: null,
  // API first (Node with the session), page fetch on refusal.
  direct: true,
  // The account's society sets the hub; there is no location to set.
  signedInOnly: true,
  parse: (json) => parseList(json?.data?.getCatalogProductList ?? json?.data?.getMegaFlashDealProducts).rows,
  cachedRows,
  ensureInBasket,
  productIdOf,
  async search(tab, query) {
    return matchCatalog(await catalog(tab), query);
  },
  offers,
};
