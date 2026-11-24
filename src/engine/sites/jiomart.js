/**
 * JioMart — guest, in-page API.
 *
 * Location: the guest default is Mumbai 400001. Setting the cookies
 *           `app_location_details` {pincode} and `app_geolocation` {lat, lng}
 *           before the first load is enough: the page resolves the pincode
 *           and its fulfillment stores itself.
 * Search:   GET /api/service/application/catalog/v1.0/products/?q=&page_size=
 *           &f=journey:standard:::department:groceries, with the page's
 *           `x-location-detail` / `x-geolocation` headers built from config.
 *           Without them the API answers 400 "invalid pincode".
 *   Not used: quick delivery (f=journey:quickcommerce:::store_ids:…) needs
 *   store ids that only the page's signed delivery-promise call returns; the
 *   ids seen (3442…) were the same for Mumbai and Chennai, so they can't be
 *   trusted as "your store". Prices here are JioMart standard delivery.
 * Recon: docs/diagnosis/2026-11-16-api-platforms-failing.md (2026-11-18).
 */
import { pageFetch, expectJson } from '../page-fetch.js';
import { SiteError } from '../errors.js';
import { bestPack } from './_util.js';
import { categoryPath } from '../../categories.js';

const ID = 'jiomart';
const ORIGIN = 'https://www.jiomart.com/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));



/**
 * City and state in JioMart's format (CHENNAI, TAMIL_NADU): from config
 * `location.city` / `location.state`, else from the address, whose segment
 * "Tamil Nadu 600045" is the state and the one before it the city.
 */
export function cityState(loc) {
  const parts = String(loc.address || '').split(',').map((x) => x.trim()).filter(Boolean);
  const i = parts.findIndex((x) => x.includes(String(loc.pincode)));
  const state = loc.state || (i >= 0 ? parts[i].replace(String(loc.pincode), '').trim() : '');
  const city = loc.city || (i > 0 ? parts[i - 1] : '');
  return { city: city.toUpperCase(), state: state.toUpperCase().replace(/\s+/g, '_') };
}


/** Pure: catalog JSON -> envelope rows. */
export function parse(json) {
  if (json?.success === false) {
    const msg = String(json.message || 'error');
    if (/pincode|location|serviceab|store ids/i.test(msg)) throw new SiteError('unserviceable', `${ID}: ${msg}`, { site: ID });
    throw new SiteError('blocked', `${ID}: ${msg}`, { site: ID });
  }
  const items = json?.items;
  if (items != null && !Array.isArray(items)) throw new SiteError('parse', `${ID}: unexpected catalog shape`, { site: ID });
  const rows = [];
  for (const it of items ?? []) {
    const price = Number(it.price?.effective?.min);
    if (!(price > 1)) continue;
    const mrp = Number(it.price?.marked?.min);
    const qty = it['net-quantity-value'] != null && it['net-quantity-unit'] ? `${it['net-quantity-value']} ${it['net-quantity-unit']}` : '';
    const pack = bestPack(it.name, qty);
    rows.push({
      name: it.name,
      brand: it.brand?.name || null,
      packSize: pack ? pack.size : null,
      packUnit: pack ? pack.unit : null,
      price,
      mrp: mrp > price ? mrp : null,
      inStock: it.sellable !== false,
      url: it.slug ? `${ORIGIN}product/${it.slug}` : ORIGIN,
      journey: it.journey || null,
      category: categoryPath(it.attributes?.['l3-category']?.[0]),
    });
  }
  return rows;
}

/** The location headers the page itself sends, built from config. */
export function locationHeaders(loc) {
  const { city, state } = cityState(loc);
  return {
    'x-location-detail': JSON.stringify({ country: 'INDIA', country_iso_code: 'IN', city, pincode: String(loc.pincode), state }),
    'x-geolocation': JSON.stringify({ latitude: String(loc.lat), longitude: String(loc.lng) }),
  };
}

async function catalog(tab, query, headers, filter) {
  const url = `/api/service/application/catalog/v1.0/products/?q=${encodeURIComponent(query)}&page_size=24${filter ? `&f=${encodeURIComponent(filter)}` : ''}`;
  const res = await pageFetch(tab, url, { headers });
  // The API reports "invalid pincode" etc. as 400 JSON; let parse() classify it.
  if (res.status === 400 && /^\s*\{/.test(res.text)) {
    try {
      return parse(JSON.parse(res.text));
    } catch (e) {
      if (e instanceof SiteError) throw e;
    }
  }
  return parse(expectJson(res, ID));
}

export default {
  id: ID,
  label: 'JioMart',
  origin: ORIGIN,
  domFallback: null,

  /**
   * Cookies are enough: given app_location_details/app_geolocation the page
   * looks the pincode up itself and sets the matching fulfillment_stores
   * (verified 2026-11-18: same stores as the UI picker). City and state are
   * resolved by the site from the pincode; we only send what config knows.
   */
  locationCookies(loc) {
    const enc = (o) => encodeURIComponent(JSON.stringify(o));
    // Without city and state the page discards the cookie and falls back to Mumbai.
    const { city, state } = cityState(loc);
    return [
      { name: 'app_location_details', value: enc({ country: 'INDIA', country_iso_code: 'IN', city, pincode: String(loc.pincode), state }), domain: '.jiomart.com', path: '/' },
      { name: 'app_geolocation', value: enc({ latitude: String(loc.lat), longitude: String(loc.lng) }), domain: '.jiomart.com', path: '/' },
    ];
  },

  async setLocation(tab, loc) {
    // Searches send the location as headers (below), so a page that later
    // rewrites its own cookie can't move us back to its default city.
    tab._jiomartHeaders = locationHeaders(loc);
  },

  parse,

  async search(tab, query) {
    const headers = tab._jiomartHeaders;
    if (!headers) throw new SiteError('unserviceable', `${ID}: no delivery location set`, { site: ID });
    // Groceries only: the plain catalog mixes in marketplace sellers
    // ("Pink Delight … Sugar 1 Kg" at ₹225).
    return catalog(tab, query, headers, 'journey:standard:::department:groceries');
  },
};
