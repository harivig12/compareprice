/**
 * BigBasket — guest only (never log in: bot protection), in-page API.
 *
 * Akamai blocks Node fetch, so every call runs inside the warm tab.
 * Location: the guest picker ("Select Location" -> address search -> pick).
 *           A direct PUT to member-svc/current-delivery-address returns 403,
 *           so we drive the UI once; the persistent profile keeps the
 *           `_bb_pin_code` cookie afterwards and later runs skip this.
 * Search:   GET /listing-svc/v2/products?type=ps&slug=<q>&page=1
 *           (204 = no results).
 */
import { pageFetch, expectJson } from '../page-fetch.js';
import { SiteError } from '../errors.js';
import { bestPack, addressSearchText } from './_util.js';
import { categoryPath } from '../../categories.js';

const ID = 'bigbasket';
const ORIGIN = 'https://www.bigbasket.com/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pinCode(tab) {
  const ck = await tab.getCookies([ORIGIN]);
  return decodeURIComponent(ck.find((c) => c.name === '_bb_pin_code')?.value || '');
}

/** Pure: listing JSON -> envelope rows. */
export function parse(json) {
  const products = json?.tabs?.[0]?.product_info?.products ?? [];
  if (!Array.isArray(products)) throw new SiteError('parse', `${ID}: unexpected listing shape`, { site: ID });
  // With no delivery location, BigBasket answers with ₹1 placeholder prices
  // (sp = mrp = 1) for everything. Never let those become "cheapest".
  const sps = products.map((p) => Number(p.pricing?.discount?.prim_price?.sp)).filter((n) => n > 0);
  if (sps.length > 0 && sps.every((n) => n <= 1)) {
    throw new SiteError('unserviceable', `${ID}: placeholder ₹1 prices — no delivery location is set`, { site: ID });
  }
  const rows = [];
  for (const p of products) {
    const sp = Number(p.pricing?.discount?.prim_price?.sp);
    // ₹1 rows are first-order promos (or placeholders), not a shelf price.
    if (!(sp > 1)) continue;
    const mrp = Number(p.pricing?.discount?.mrp);
    const brand = p.brand?.name || '';
    const pack = bestPack(p.w, p.desc);
    const base = brand && !p.desc.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${p.desc}` : p.desc;
    rows.push({
      name: p.w ? `${base} ${p.w}` : base,
      brand: brand || null,
      packSize: pack ? pack.size : null,
      packUnit: pack ? pack.unit : null,
      price: sp,
      mrp: mrp > sp ? mrp : null,
      // avail_status "001" = available; anything else is out of stock.
      inStock: p.availability?.avail_status ? p.availability.avail_status === '001' : true,
      url: p.absolute_url ? new URL(p.absolute_url, ORIGIN).href : ORIGIN,
      category: categoryPath(p.category?.tlc_name, p.category?.mlc_name, p.category?.llc_name),
    });
  }
  return rows;
}

const PICKER_JS = (needle) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let btn = null;
  // The header hydrates late on a cold profile; wait for the picker.
  for (let i = 0; i < 40 && !btn; i++) {
    btn = [...document.querySelectorAll('span,button')].filter((e) => e.offsetParent && /^Select Location$/i.test(e.textContent.trim())).pop();
    if (!btn) await sleep(500);
  }
  if (!btn) return 'no location button';
  (btn.closest('button') || btn).click();
  await sleep(2000);
  const input = [...document.querySelectorAll('input')].find((x) => x.offsetParent && /area or street|location|pincode/i.test(x.placeholder || ''));
  if (!input) return 'no address input';
  input.focus();
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const ch of ${JSON.stringify(needle)}) {
    set.call(input, input.value + ch);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(60);
  }
  let li = null;
  for (let i = 0; i < 20 && !li; i++) {
    await sleep(400);
    let c = input; for (let k = 0; k < 6 && c.parentElement; k++) c = c.parentElement;
    li = [...c.querySelectorAll('li')].find((e) => e.offsetParent && e.textContent.trim().length > 5);
  }
  if (!li) return 'no address suggestions';
  li.click();
  return 'ok';
})()`;

export default {
  id: ID,
  label: 'BigBasket',
  origin: ORIGIN,
  domFallback: 'bigbasket',

  async setLocation(tab, loc) {
    if ((await pinCode(tab)) === String(loc.pincode)) return;
    const needle = addressSearchText(loc);
    let out = await tab.evaluate(PICKER_JS(needle), { timeoutMs: 45000 }).catch((e) => e.message);
    if (out === 'no location button') {
      // A slow cold load: reload once and try again.
      await tab.goto(ORIGIN, { waitMs: 20000 });
      out = await tab.evaluate(PICKER_JS(needle), { timeoutMs: 45000 }).catch((e) => e.message);
    }
    // The site reloads its header data after picking; give cookies a moment.
    for (let i = 0; i < 10 && (await pinCode(tab)) !== String(loc.pincode); i++) await sleep(800);
    const pin = await pinCode(tab);
    if (pin !== String(loc.pincode)) {
      throw new SiteError('unserviceable', `${ID}: could not set location ${loc.pincode} (picker: ${out}; pin now "${pin || 'unset'}")`, { site: ID });
    }
  },

  parse,

  async search(tab, query) {
    const res = await pageFetch(tab, `/listing-svc/v2/products?type=ps&slug=${encodeURIComponent(query)}&page=1`);
    if (res.status === 204) return [];
    return parse(expectJson(res, ID));
  },
};
