/**
 * Blinkit — guest, in-page API.
 *
 * Location: `gr_1_lat` / `gr_1_lon` cookies (the page then sends lat/lon headers).
 * Search:   POST /v1/layout/search?q=<q>&search_type=type_to_search with the
 *           headers the page itself sent (auth_key, device_id, session_uuid,
 *           app versions, lat, lon), captured on warm-up.
 * Products: response.snippets[].data.atc_action.add_to_cart.cart_item
 *           {product_id, product_name, price, mrp, unit, inventory, brand}.
 */
import { pageFetch, expectJson } from '../page-fetch.js';
import { SiteError } from '../errors.js';
import { bestPack } from './_util.js';
import { ensureCaptured } from './_capture.js';

const ID = 'blinkit';
const SEARCH_RE = /blinkit\.com\/v1\/layout\/search\?q=/;
const UNSERVICEABLE_RE = /not (yet )?(serviceable|available) (in|at) your|coming soon|we are not (yet )?(in|delivering)|currently unavailable in your area/i;

export function parse(json) {
  const snippets = json?.response?.snippets;
  if (!Array.isArray(snippets)) {
    throw new SiteError('parse', `${ID}: unexpected search shape (keys: ${Object.keys(json || {}).join(',')})`, { site: ID });
  }
  const rows = [];
  const seen = new Set();
  for (const s of snippets) {
    const item = s?.data?.atc_action?.add_to_cart?.cart_item;
    if (!item || !(Number(item.price) > 0)) continue;
    const key = `${item.product_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = item.display_name || item.product_name;
    const pack = bestPack(item.unit, name);
    const mrp = Number(item.mrp);
    rows.push({
      name: item.unit ? `${name} ${item.unit}` : name,
      brand: item.brand || null,
      packSize: pack ? pack.size : null,
      packUnit: pack ? pack.unit : null,
      price: Number(item.price),
      mrp: mrp > item.price ? mrp : null,
      inStock: Number(item.inventory ?? 1) > 0,
      url: `https://blinkit.com/prn/x/prid/${item.product_id}`,
    });
  }
  if (rows.length === 0 && UNSERVICEABLE_RE.test(JSON.stringify(snippets).slice(0, 20000))) {
    throw new SiteError('unserviceable', `${ID}: location not serviceable`, { site: ID });
  }
  return rows;
}

export default {
  id: ID,
  label: 'Blinkit',
  origin: 'https://blinkit.com/s/?q=dal',
  domFallback: 'blinkit',

  locationCookies(loc) {
    return [
      { name: 'gr_1_lat', value: String(loc.lat), domain: 'blinkit.com', path: '/' },
      { name: 'gr_1_lon', value: String(loc.lng), domain: 'blinkit.com', path: '/' },
      { name: 'gr_1_locality', value: encodeURIComponent(loc.label || ''), domain: 'blinkit.com', path: '/' },
    ];
  },

  parse,

  async search(tab, query) {
    const cap = await ensureCaptured(tab, ID, SEARCH_RE, 'https://blinkit.com/s/?q=dal');
    if (!cap.headers) throw new SiteError('session', `${ID}: page never issued a search request to copy headers from`, { site: ID });
    const res = await pageFetch(tab, `/v1/layout/search?q=${encodeURIComponent(query)}&search_type=type_to_search`, {
      method: 'POST',
      headers: { ...cap.headers, 'content-type': 'application/json' },
      body: '{}',
    });
    return parse(expectJson(res, ID));
  },
};
