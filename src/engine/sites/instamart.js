/**
 * Instamart (Swiggy) — guest, in-page API.
 *
 * Location: the `userLocation` cookie on .swiggy.com (lat/lng/address JSON).
 * Search:   POST /api/instamart/search/v2 from the warm swiggy.com tab. The
 *           `matcher`, `x-build-version` and `x-device-id` headers rotate with
 *           site releases, so they are copied from the page's own search
 *           request (seen on warm-up) instead of being hardcoded.
 * Recon: docs/diagnosis/2026-11-16-api-platforms-failing.md
 */
import { expectJson } from '../page-fetch.js';
import { apiFetch } from '../direct.js';
import { SiteError } from '../errors.js';
import { bestPack } from './_util.js';
import { categoryPath } from '../../categories.js';
import { watchRequest, ensureCaptured, collectResponses, freeDeliveryFrom } from './_capture.js';

const ID = 'instamart';
const ORIGIN = 'https://www.swiggy.com/';
const HOME_RE = /\/api\/instamart\/home\/v2/;
const SEARCH_PATH = '/api/instamart/search/v2?offset=0&ageConsent=false&voiceSearchTrackingId=&storeId=&primaryStoreId=&secondaryStoreId=';
const MIN_GAP_MS = 2500;
const SEARCH_RE = /\/api\/instamart\/search\/v2/;
const TRIGGER = 'https://www.swiggy.com/instamart/search?custom_back=true&query=dal';
const UNSERVICEABLE_RE = /not\s+serviceable|unserviceable|coming soon to your|we don.t deliver|store (is )?(closed|unavailable)|location is not/i;

const money = (m) => (m && m.units != null ? Number(m.units) + Number(m.nanos || 0) / 1e9 : null);

/** Walk the response and collect every item that carries variations. */
function collectItems(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) collectItems(n, out);
    return out;
  }
  if (node.displayName && Array.isArray(node.variations)) {
    out.push(node);
    return out;
  }
  for (const k of Object.keys(node)) collectItems(node[k], out);
  return out;
}

/** Pure: search/v2 JSON -> envelope rows. Throws unserviceable when the payload says so. */
export function parse(json) {
  // Swiggy reports throttling as HTTP 200 with {"statusCode":429} and no data.
  if (json && !json.data && Number(json.statusCode) >= 400) {
    const code = Number(json.statusCode);
    // 15 s was too short: the retry hit the same limit (2026-11-19). 30 s cleared it.
    throw new SiteError(code === 429 ? 'blocked' : 'session', `${ID}: ${code === 429 ? 'rate limited (statusCode 429 in body)' : `statusCode ${code} in body`}`, { site: ID, status: code, retryAfterMs: code === 429 ? 30000 : 0 });
  }
  const items = collectItems(json?.data?.cards ?? json);
  const rows = [];
  const seen = new Set();
  for (const item of items) {
    for (const v of item.variations) {
      const price = money(v.price?.offerPrice) ?? money(v.price?.mrp);
      if (!(price > 0)) continue;
      const key = v.skuId || `${v.displayName}|${v.quantityDescription}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = v.displayName || item.displayName;
      const pack = bestPack(v.quantityDescription, name);
      const mrp = money(v.price?.mrp);
      rows.push({
        name: v.quantityDescription && !name.includes(v.quantityDescription) ? `${name} ${v.quantityDescription}` : name,
        brand: v.brandName || item.brand || null,
        packSize: pack ? pack.size : null,
        packUnit: pack ? pack.unit : null,
        price,
        mrp: mrp != null && mrp > price ? mrp : null,
        inStock: v.inventory?.inStock ?? item.inStock ?? true,
        url: item.productId ? `https://www.swiggy.com/instamart/item/${item.productId}` : 'https://www.swiggy.com/instamart',
        category: categoryPath(v.superCategory, v.category, v.subCategoryType),
      });
    }
  }
  if (rows.length === 0 && items.length > 0) {
    // Product widgets came back but none carried a usable price: the payload
    // shape changed. Say so (and let the runner try the page view).
    throw new SiteError('parse', `${ID}: ${items.length} product cards but no prices parsed — payload shape changed?`, { site: ID });
  }
  if (rows.length === 0) {
    const msg = [json?.data?.statusMessage, JSON.stringify(json?.data?.communication ?? '')].join(' ');
    if (UNSERVICEABLE_RE.test(msg) || json?.data?.statusCode === 1) {
      throw new SiteError('unserviceable', `${ID}: location not serviceable (${String(json?.data?.statusMessage || 'no store').slice(0, 80)})`, { site: ID });
    }
  }
  return rows;
}

export default {
  id: ID,
  label: 'Instamart',
  origin: 'https://www.swiggy.com/instamart/search?custom_back=true&query=dal',
  domFallback: 'instamart',
  // API first (Node with the session), page fetch on refusal.
  direct: true,
  // Prices can differ per account: every signed-in account is searched.
  perAccountSearch: true,

  locationCookies(loc) {
    const value = encodeURIComponent(JSON.stringify({
      lat: loc.lat, lng: loc.lng, address: loc.address, id: '', annotation: loc.label || '', name: '',
    }));
    return [{ name: 'userLocation', value, domain: '.swiggy.com', path: '/' }];
  },

  // Only watches the page's own search request; never moves the address.
  locationPassive: true,
  async setLocation(tab) {
    watchRequest(tab, ID, SEARCH_RE);
  },

  parse,

  async search(tab, query) {
    const cap = await ensureCaptured(tab, ID, SEARCH_RE, TRIGGER);
    if (!cap.headers) throw new SiteError('session', `${ID}: page never issued a search request to copy headers from`, { site: ID });
    // Pace requests per tab: Swiggy throttles bursts (statusCode 429). The
    // page's own warm-up search counts as the first request.
    tab._instamartNext ??= Date.now() + MIN_GAP_MS;
    const wait = tab._instamartNext - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    tab._instamartNext = Date.now() + MIN_GAP_MS;
    // API first: answered from Node with the session (recon 2026-11-19); a
    // refusal falls back to fetch inside the tab for the rest of the session.
    const res = await apiFetch(tab, `${ORIGIN}${SEARCH_PATH.replace(/^\//, '')}`, {
      method: 'POST',
      headers: { ...cap.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        facets: [], sortAttribute: '', query, search_results_offset: '0',
        page_type: 'INSTAMART_SEARCH_PAGE', is_pre_search_tag: false,
      }),
    }, { siteId: ID });
    return parse(expectJson(res, ID));
  },

  /**
   * Offer check without a product search: the home feed's product widgets
   * (same item shape as search). Recon 2026-11-19 found no separate deal feed;
   * deals at 80%+ show up here or in searches.
   */
  async offers(tab) {
    // Read the page's own responses (no replay): the home feed comes twice, a
    // small shell first and the product widgets after, and the cart says
    // "FREE DELIVERY on orders above ₹99". On a slow machine the second feed
    // and the cart land seconds after the load (live, 2026-11-19), so wait for them.
    const watch = collectResponses(tab, /\/api\/instamart\/(home\/v2|checkout\/v2\/cart)/);
    await tab.goto('about:blank', { waitMs: 2000 }).catch(() => {});
    await tab.goto(`${ORIGIN}instamart`, { waitMs: 15000 });
    let got = [];
    for (let i = 0; i < 20; i++) {
      got = await watch.peek();
      const feed = got.some((r) => HOME_RE.test(r.url) && r.text.includes('"variations"'));
      const cart = got.some((r) => /checkout\/v2\/cart/.test(r.url));
      if (feed && cart) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    got = await watch.done();
    const freeAbove = got.filter((r) => /checkout\/v2\/cart/.test(r.url)).map((r) => freeDeliveryFrom(r.text)).find((n) => n != null) ?? null;
    const info = freeAbove != null ? { freeDeliveryAbove: freeAbove } : null;
    const rows = [];
    const seen = new Set();
    for (const r of got.filter((x) => HOME_RE.test(x.url))) {
      let j;
      try { j = JSON.parse(r.text); } catch { continue; }
      // The home feed keeps its product widgets outside `data.cards`: walk all of it.
      for (const row of parse({ data: { cards: j } })) if (!seen.has(row.url + row.name)) { seen.add(row.url + row.name); rows.push(row); }
    }
    return { rows, conditions: null, info, ...(rows.length ? {} : { note: 'the home feed had no products' }) };
  },
};
