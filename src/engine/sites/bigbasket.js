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
 * Offers:   the deal storefronts ("Deals of the Week", "Combos" …) through the
 *           same API with type=sis&slug=<storefront>, every page, paced by the
 *           site's request budget (docs/diagnosis/2026-11-24-bigbasket-deals-and-offers.md).
 *           Shown in their own group at any discount (user decision 2026-11-24).
 *
 * BigBasket runs in a Chrome and profile of its own (<data>/profiles/bigbasket),
 * headless first and headed after repeated bot walls (src/engine/browser-mode.js).
 *
 * RULES THAT KEEP BIGBASKET'S BOT WALL AWAY (Akamai answers "Access Denied"; a refused page can
 * start a block that lasts hours; learned 2026-11-24/25):
 *   1. The only page ever loaded is the HOME page (ORIGIN): by the pool once per tab, and once more
 *      here if the location picker needs a retry on a slow cold load. Every product, storefront and
 *      (later) cart/offer read is an API call from that warm tab (pageFetch). Never navigate to
 *      /basket/, /pd/, /ps/, /sp/ or any other page URL, not even to read it:
 *      test/ua-guard.test.js fails if this file gains any other navigation.
 *   2. The tab must report a real Chrome user-agent, never "HeadlessChrome". Headless Chrome says
 *      HeadlessChrome unless something overrides it, and the override lasts only as long as the
 *      connection that set it. The browser therefore holds it for every tab (ua-guard.js), the pool
 *      sets it per tab and refuses to load the site if the tab still says HeadlessChrome
 *      (assertRealUserAgent). A script that drives this Chrome gets the same protection.
 *   3. Pace everything through the site's request budget (src/limits.js), one call at a time.
 *   4. After a wall, stop: no retries, no probing (the runner rests the site, pool.js counts
 *      walls and only then switches to a headed browser).
 * The wall seen on 2026-11-25 was a page load (/basket/) made through a script connection that had
 * lost the user-agent override: see docs/diagnosis/2026-11-25-zepto-instamart-cart-offers.md.
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

/** The listing's products, after the ₹1-placeholder check. */
function productsOf(json) {
  const products = json?.tabs?.[0]?.product_info?.products ?? [];
  if (!Array.isArray(products)) throw new SiteError('parse', `${ID}: unexpected listing shape`, { site: ID });
  // With no delivery location, BigBasket answers with ₹1 placeholder prices
  // (sp = mrp = 1) for everything. Never let those become "cheapest".
  const sps = products.map((p) => Number(p.pricing?.discount?.prim_price?.sp)).filter((n) => n > 0);
  if (sps.length > 0 && sps.every((n) => n <= 1)) {
    throw new SiteError('unserviceable', `${ID}: placeholder ₹1 prices — no delivery location is set`, { site: ID });
  }
  return products;
}

/** One listing product -> an engine row, or null for a ₹1 promo row. */
function rowOf(p) {
  const sp = Number(p.pricing?.discount?.prim_price?.sp);
  // ₹1 rows are first-order promos (or placeholders), not a shelf price.
  if (!(sp > 1)) return null;
  const mrp = Number(p.pricing?.discount?.mrp);
  const brand = p.brand?.name || '';
  const desc = String(p.desc ?? '');
  const pack = bestPack(p.w, desc);
  const base = brand && !desc.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${desc}` : desc;
  return {
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
  };
}

/** Pure: listing JSON -> envelope rows. */
export function parse(json) {
  return productsOf(json).map(rowOf).filter(Boolean);
}

/**
 * The deal storefronts linked from the home page (seen 2026-11-24 at 600045).
 * The ids change now and then: the home page's own /sp/ links with the same
 * name are used too, and a storefront that is gone (204/404) is skipped.
 */
export const STOREFRONTS = Object.freeze([
  { slug: '2311728-deals-week', title: 'Deals of the Week' },
  { slug: '2307001-buy-more-save-more', title: 'Buy More Save More' },
  { slug: '2306008-combos', title: 'Combos' },
  { slug: '2310049-combos', title: 'Combos' },
  { slug: '2310048-big-pack-discount', title: 'Big Pack Discount' },
  { slug: '2308175-the-30-corner', title: 'The ₹30 Corner' },
]);
export const STOREFRONT_MAX_PAGES = 10;
const nameOf = (slug) => slug.replace(/^\d+-/, '');

/** Pure: the storefronts to read: the known ones plus home-page links with a known name. */
export function storefrontSlugs(hrefs = []) {
  const known = new Map(STOREFRONTS.map((s) => [nameOf(s.slug), s.title]));
  const out = new Map(STOREFRONTS.map((s) => [s.slug, s]));
  for (const h of hrefs) {
    const m = /\/sp\/(\d+-[a-z0-9-]+?)\/?(?:[?#]|$)/i.exec(String(h ?? ''));
    if (!m) continue;
    const slug = m[1].toLowerCase();
    if (known.has(nameOf(slug)) && !out.has(slug)) out.set(slug, { slug, title: known.get(nameOf(slug)) });
  }
  return [...out.values()];
}

/**
 * Pure: storefront listing JSON -> rows with what the deal says: the most you
 * can buy at the offer price (`camp_detail.narq`; 9999999 = no limit) and the
 * deal type (`price_drop`).
 */
export function parseOffers(json) {
  const rows = [];
  for (const p of productsOf(json)) {
    const row = rowOf(p);
    if (!row) continue;
    const narq = Number(p.pricing?.discount?.camp_detail?.narq ?? p.camp_detail?.narq);
    if (narq > 0 && narq < 1000) row.maxQty = narq;
    const type = p.pricing?.discount?.deal_type ?? p.deal_type;
    if (typeof type === 'string' && type) row.dealType = type;
    rows.push(row);
  }
  return rows;
}

const HREFS_JS = `[...document.querySelectorAll('a[href*="/sp/"]')].map((a) => a.getAttribute('href')).slice(0, 400)`;

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

  // Every discount counts here: the storefronts are 20–40% off, far from the 80% deal line.
  offersMinPct: 0,

  /**
   * The deal storefronts, every page (at most STOREFRONT_MAX_PAGES each), one
   * call at a time through the site's budget. Rows carry their storefront in
   * `conditions`, so the Deals section can group them.
   * @param {import('../cdp.js').CdpTab} tab
   * @param {{ acquire?: () => Promise<void>, signal?: AbortSignal }} [ctx]
   */
  async offers(tab, { acquire = async () => {}, signal } = {}) {
    const hrefs = await tab.evaluate(HREFS_JS, { timeoutMs: 5000 }).catch(() => []);
    const rows = [];
    const notes = [];
    for (const sf of storefrontSlugs(Array.isArray(hrefs) ? hrefs : [])) {
      let title = sf.title;
      let pages = 1;
      let n = 0;
      for (let page = 1; page <= pages && page <= STOREFRONT_MAX_PAGES; page++) {
        if (signal?.aborted) throw new Error('Operation aborted');
        await acquire();
        const res = await pageFetch(tab, `/listing-svc/v2/products?type=sis&slug=${encodeURIComponent(sf.slug)}&page=${page}`);
        // A storefront that has ended: nothing to read, not a failure.
        if (res.status === 204 || res.status === 404 || res.status === 410) break;
        const json = expectJson(res, ID);
        const named = String(json?.screen_info?.title ?? '').trim();
        // An ended storefront answers with a general listing titled just "bigbasket"
        // (seen 2026-11-24: 60 pages of festive items). That is not a deal page.
        if (/^bigbasket$/i.test(named)) {
          notes.push(`${sf.slug}: not a deal storefront any more (no title)`);
          pages = 0;
          break;
        }
        title = named || title;
        pages = Math.max(1, Number(json?.tabs?.[0]?.product_info?.number_of_pages) || 1);
        for (const r of parseOffers(json)) {
          rows.push({ ...r, conditions: { storefront: title, ...(r.dealType ? { dealType: r.dealType } : {}) } });
          n++;
        }
      }
      if (pages > STOREFRONT_MAX_PAGES) notes.push(`${title}: first ${STOREFRONT_MAX_PAGES} of ${pages} pages`);
      if (!n && pages) notes.push(`${title}: nothing listed`);
    }
    return { rows, note: notes.join('; ') || null };
  },
};
