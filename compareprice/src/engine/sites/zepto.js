/**
 * Zepto — guest, in-page API.
 *
 * Location: localStorage['user-position'] (zustand store) holds
 *           {latitude, longitude, ...}; the page derives store ids from it.
 *           We write it once and reload. The UI picker writes the same thing.
 * Search:   guest: GET bff-gateway.zepto.com/search-federator-service/api/v1/search
 *           ?query=<q>&mode=SHOW_ALL_RESULTS&pageNumber=0. Signed in: POST
 *           user-search-service/api/v3/search with a JSON body. Either way with
 *           the page's own headers (store_ids, session/device ids, csrf secret,
 *           request-signature, app version), replayed from its own request.
 */
import { pageFetch, expectJson } from '../page-fetch.js';
import { SiteError } from '../errors.js';
import { ensureCaptured, collectResponses } from './_capture.js';
import { bestPack, cdpClick, typeText, addressSearchText } from './_util.js';

const ID = 'zepto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = 'https://www.zepto.com/';
// Guests: GET search-federator-service/api/v1/search?query=…
// Signed in (seen 2026-11-19): POST user-search-service/api/v3/search with a JSON
// body {query, pageNumber, mode, userSessionId}. Same product shape in both.
const SEARCH_RE = /search-federator-service\/api\/v1\/search\?|user-search-service\/api\/v\d+\/search(\?|$)/;
const SEARCH_URL = (q) =>
  `https://bff-gateway.zepto.com/search-federator-service/api/v1/search?query=${encodeURIComponent(q).replace(/%20/g, '+')}&mode=SHOW_ALL_RESULTS&pageNumber=0`;

/**
 * The request to replay for `query`, built from the page's own captured search:
 * the v3 POST keeps the page's body (its session id) with our query, the v1 GET
 * gets the query in the URL.
 * @param {{ url: string|null, body: string|null, headers: object }} cap
 */
export function searchRequest(cap, query) {
  if (/user-search-service/.test(cap.url || '') && cap.body) {
    let body;
    try {
      body = JSON.parse(cap.body);
    } catch {
      throw new SiteError('parse', `${ID}: the page's search request body is not JSON`, { site: ID });
    }
    return { url: cap.url, init: { method: 'POST', headers: cap.headers, body: JSON.stringify({ ...body, query, pageNumber: 0, mode: 'SHOW_ALL_RESULTS' }) } };
  }
  return { url: SEARCH_URL(query), init: { headers: cap.headers } };
}

const rupees = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // Zepto prices are in paise.
  return n >= 1000 && Number.isInteger(n) ? n / 100 : n;
};

/** Walk the payload for product-response objects. */
function collect(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) collect(n, out); return out; }
  if (node.product && node.productVariant && (node.sellingPrice != null || node.discountedSellingPrice != null)) {
    out.push(node);
    return out;
  }
  for (const k of Object.keys(node)) collect(node[k], out);
  return out;
}

export function parse(json) {
  const items = collect(json);
  const rows = [];
  const seen = new Set();
  for (const it of items) {
    const id = it.productVariant?.id || it.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const price = rupees(it.discountedSellingPrice ?? it.sellingPrice);
    if (!(price > 0)) continue;
    const mrp = rupees(it.mrp ?? it.productVariant?.mrp);
    const name = it.product?.name || '';
    const qty = it.productVariant?.formattedPacksize || it.productVariant?.packsize || '';
    const pack = bestPack(qty, name);
    rows.push({
      name: qty && !name.includes(qty) ? `${name} ${qty}` : name,
      brand: it.product?.brand || null,
      packSize: pack ? pack.size : null,
      packUnit: pack ? pack.unit : null,
      price,
      mrp: mrp > price ? mrp : null,
      inStock: it.outOfStock !== true && (it.availableQuantity ?? 1) > 0,
      url: `https://www.zepto.com/pn/x/pvid/${id}`,
    });
  }
  // Serviceability is checked once in setLocation (serviceability cookie);
  // the search payload carries widget names containing "serviceable" even
  // when deliverable, so an empty result here just means no match.
  return rows;
}

export default {
  id: ID,
  label: 'Zepto',
  origin: ORIGIN,
  domFallback: 'zepto',

  /**
   * Writing localStorage alone does not move the store: the picker also sets
   * `user_position` / `serviceability` cookies from the server. So drive the
   * picker once with real mouse events; the persistent profile keeps it.
   */
  async setLocation(tab, loc) {
    const placed = async () => {
      const ck = await tab.getCookies([ORIGIN]);
      const pos = ck.find((c) => c.name === 'user_position');
      try {
        const p = JSON.parse(decodeURIComponent(pos?.value || ''));
        return Math.abs(p.latitude - loc.lat) < 2e-3 && Math.abs(p.longitude - loc.lng) < 2e-3;
      } catch {
        return false;
      }
    };
    if (await placed()) return;
    const btn = await cdpClick(tab, `[...document.querySelectorAll('button')].find((b) => b.offsetParent && /Select Location|minutes/i.test(b.textContent))`, { waitMs: 15000 });
    if (!btn) throw new SiteError('unserviceable', `${ID}: location picker button not found`, { site: ID });
    await sleep(1500);
    const input = await cdpClick(tab, `[...document.querySelectorAll('input')].find((x) => x.offsetParent && /address/i.test(x.placeholder || ''))`);
    if (input == null) throw new SiteError('unserviceable', `${ID}: address search box not found`, { site: ID });
    const needle = addressSearchText(loc);
    await typeText(tab, needle);
    const first = needle.split(' ').slice(0, 2).join(' ');
    const pick = await cdpClick(
      tab,
      `(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (n.textContent.includes(${JSON.stringify(first)}) && n.parentElement.offsetParent && n.parentElement.tagName !== 'INPUT') return n.parentElement; } return null; })()`,
      { waitMs: 10000 },
    );
    if (!pick) throw new SiteError('unserviceable', `${ID}: no address suggestion for "${needle}"`, { site: ID });
    for (let i = 0; i < 15 && !(await placed()); i++) await sleep(700);
    if (!(await placed())) throw new SiteError('unserviceable', `${ID}: picked "${pick}" but location did not stick`, { site: ID });
    const ck = await tab.getCookies([ORIGIN]);
    const svc = decodeURIComponent(ck.find((c) => c.name === 'serviceability')?.value || '');
    if (/"isDeliverable":false/.test(svc)) throw new SiteError('unserviceable', `${ID}: not deliverable at ${loc.label || loc.pincode}`, { site: ID });
  },

  parse,

  /**
   * No deal feed: only the free-delivery minimum its home page states
   * (`etaInfo.deliveryFeeMov`, ₹99 on 2026-11-19), for the row under Total.
   */
  async offers(tab) {
    const page = collectResponses(tab, /\/lms\/api\/v\d+\/get_page/);
    // Re-opening the address the tab is already on loaded nothing new (live,
    // 2026-11-19): go via a blank page so the home page asks for its layout.
    await tab.goto('about:blank', { waitMs: 2000 }).catch(() => {});
    await tab.goto(ORIGIN, { waitMs: 15000 });
    let mov = null;
    for (let i = 0; i < 20 && mov == null; i++) {
      for (const r of await page.peek()) {
        const m = /"deliveryFeeMov"\s*:\s*(\d{2,4})/.exec(r.text);
        if (m) { mov = Number(m[1]); break; }
      }
      if (mov == null) await sleep(500);
    }
    await page.done();
    return { rows: [], conditions: null, info: mov ? { freeDeliveryAbove: mov } : null };
  },

  async search(tab, query) {
    const cap = await ensureCaptured(tab, ID, SEARCH_RE, `${ORIGIN}search?query=dal`);
    if (!cap.headers) throw new SiteError('session', `${ID}: page never issued a search request to copy headers from`, { site: ID });
    const req = searchRequest(cap, query);
    const res = await pageFetch(tab, req.url, req.init);
    if (res.error) {
      // Since 2026-11-19 Zepto can require sign-in to search at a located store;
      // the API then answers without CORS headers ("Failed to fetch"). Say so.
      const text = await tab.evaluate(`document.body ? document.body.innerText : ''`, { timeoutMs: 5000 }).catch(() => '');
      if (/please login to continue|login to continue searching/i.test(text)) {
        throw new SiteError('session', `${ID}: Zepto asks you to sign in to search at this location. Use "Sign in…" (mobile + OTP) once`, { site: ID });
      }
    }
    return parse(expectJson(res, ID));
  },
};
