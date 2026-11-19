/**
 * Amazon Now (amazon.in/tez) — guest, in-page API.
 *
 * Location: POST /portal-migration/hz/glow/address-change {zipCode} with the
 *           `validationToken` from get-location-label as anti-csrftoken-a2z.
 *           Without it Amazon uses an IP guess (600042 was seen).
 * Serviceability: POST /tez/order/validateLocation -> {isServiceable}. At
 *           600045 (Tambaram) it is false on 2026-11-19, so searches return
 *           0 products; that is reported as `unserviceable`, not "not found".
 * Search:   GET /tez/browse/searchByKeyword?keyword=&brandId=&offset=0 with
 *           the page's tez-brand-id / tez-group-id headers.
 *           data.searchResponse.products[] {title, packSize, buyingPrice.amount,
 *           listPrice.amount, availability.type, asin}.
 */
import { pageFetch, expectJson } from '../page-fetch.js';
import { SiteError } from '../errors.js';
import { bestPack } from './_util.js';

const ID = 'amazon';
const BRAND = 'qqfsWw9RkO';
const ORIGIN = `https://www.amazon.in/tez/browse?qcbrand=${BRAND}`;
const LABEL = '/portal-migration/hz/glow/get-location-label?storeContext=amazontez&pageType=amazontez&actionSource=tez-glow';

export function parse(json) {
  if (json?.success === false) throw new SiteError('blocked', `${ID}: ${json.message || 'search failed'}`, { site: ID });
  const products = json?.data?.searchResponse?.products;
  if (products != null && !Array.isArray(products)) throw new SiteError('parse', `${ID}: unexpected search shape`, { site: ID });
  const rows = [];
  for (const p of products ?? []) {
    const price = Number(p.buyingPrice?.amount ?? p.price?.amount);
    if (!(price > 1)) continue;
    const mrp = Number(p.listPrice?.amount);
    const pack = bestPack(p.packSize, p.title);
    rows.push({
      name: p.packSize && !String(p.title).includes(p.packSize) ? `${p.title} ${p.packSize}` : p.title,
      packSize: pack ? pack.size : null,
      packUnit: pack ? pack.unit : null,
      price,
      mrp: mrp > price ? mrp : null,
      inStock: (p.availability?.type || 'IN_STOCK') === 'IN_STOCK',
      url: p.asin ? `https://www.amazon.in/dp/${p.asin}` : ORIGIN,
    });
  }
  return rows;
}

export default {
  id: ID,
  label: 'Amazon Now',
  origin: ORIGIN,
  domFallback: null,

  async setLocation(tab, loc) {
    const out = await tab.evaluate(`(async () => {
      const label = async () => (await fetch(${JSON.stringify(LABEL)})).json();
      let l = await label();
      if (l.customerIntent?.zipCode !== ${JSON.stringify(String(loc.pincode))}) {
        const body = new URLSearchParams({ locationType: 'LOCATION_INPUT', zipCode: ${JSON.stringify(String(loc.pincode))}, storeContext: 'amazontez', deviceType: 'web', pageType: 'amazontez', actionSource: 'glow' });
        await fetch('/portal-migration/hz/glow/address-change?actionSource=glow', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'anti-csrftoken-a2z': l.validationToken }, body });
        l = await label();
      }
      return { zip: l.customerIntent?.zipCode };
    })()`, { timeoutMs: 30000 });
    if (out?.zip !== String(loc.pincode)) {
      throw new SiteError('unserviceable', `${ID}: could not set pincode ${loc.pincode} (Amazon has ${out?.zip || 'none'})`, { site: ID });
    }
    // Reload and read the page's own serviceability check for this pincode.
    let reqId = null;
    const offReq = tab.on('Network.requestWillBeSent', (p) => { if (/\/tez\/order\/validateLocation/.test(p.request?.url || '')) reqId = p.requestId; });
    const done = tab.waitForEvent('Network.loadingFinished', (p) => p.requestId === reqId, 20000);
    await tab.goto(ORIGIN, { waitMs: 15000 });
    await done;
    offReq();
    if (reqId) {
      const body = await tab.send('Network.getResponseBody', { requestId: reqId }).catch(() => null);
      try {
        tab._amazonServiceable = JSON.parse(body?.body || '{}')?.data?.isServiceable;
      } catch { /* unknown */ }
    }
  },

  parse,

  async search(tab, query) {
    if (tab._amazonServiceable === false) {
      throw new SiteError('unserviceable', `${ID}: Amazon Now does not deliver to this pincode (validateLocation: isServiceable=false)`, { site: ID });
    }
    const res = await pageFetch(tab, `/tez/browse/searchByKeyword?keyword=${encodeURIComponent(query)}&brandId=${BRAND}&offset=0&spellCorrectionDisabled=false`, {
      headers: { 'tez-brand-id': BRAND },
    });
    return parse(expectJson(res, ID));
  },
};
