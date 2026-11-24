/**
 * KPN Fresh — guest, server-rendered (Next.js).
 *
 * There is no search XHR: /search?q= is server-rendered and carries the full
 * result set in __NEXT_DATA__ (props.pageProps.pageProps.productResponse).
 * We fetch that HTML from inside the warm tab and read the JSON. Every pack
 * of a product (1 kg, 500 g, 250 g) is a separate row.
 * Location: the guest default is a Chennai store (Mylapore), which is the
 * same city as the configured location; KPN has no guest store picker API.
 */
import { pageFetch } from '../page-fetch.js';
import { SiteError } from '../errors.js';
import { bestPack } from './_util.js';
import { categoryPath } from '../../categories.js';

const ID = 'kpn';
const ORIGIN = 'https://www.kpnfresh.com/';

const price = (list, type) => {
  const p = (list || []).find((x) => x.type === type)?.price;
  return p && p.cent_amount > 0 ? p.cent_amount / (p.fraction || 100) : null;
};

/** Pure: productResponse JSON (or the whole __NEXT_DATA__) -> rows. */
export function parse(json) {
  const pr = json?.props?.pageProps?.pageProps?.productResponse ?? json;
  // 404 NOT_FOUND is KPN's "no products for this query".
  if (pr?.statusCode === 404) return [];
  if (pr?.statusCode && pr.statusCode !== 200) {
    throw new SiteError('blocked', `${ID}: search returned ${pr.statusCode} ${pr.errorCode || ''}`.trim(), { site: ID });
  }
  const products = pr?.data?.products;
  if (!Array.isArray(products)) return [];
  const rows = [];
  for (const p of products) {
    for (const pack of p.pack_list || []) {
      const sp = price(pack.prices, 'PRICE_INCL_TAX');
      if (!(sp > 0)) continue;
      const mrp = price(pack.prices, 'MRP');
      const pk = bestPack(pack.display_name, p.product_title);
      const brand = p.brand_name && !/^loose/i.test(p.brand_name) ? p.brand_name : null;
      rows.push({
        name: `${p.product_title} ${pack.display_name || ''}`.trim(),
        brand,
        packSize: pk ? pk.size : null,
        packUnit: pk ? pk.unit : null,
        price: sp,
        mrp: mrp > sp ? mrp : null,
        inStock: (pack.stock_details?.status || 'IN_STOCK') === 'IN_STOCK',
        url: new URL(pack.product_url || p.product_url || '', ORIGIN).href,
        // Levels carry an id suffix: "Rice, Atta & Dal (1_13)".
        category: categoryPath([p.primary_navigation_category_l0, p.primary_navigation_category_l1].map((c) => String(c ?? '').replace(/\s*\(\d+_\d+\)\s*$/, ''))),
      });
    }
  }
  return rows;
}

export default {
  id: ID,
  label: 'KPN Fresh',
  origin: ORIGIN,
  domFallback: 'kpn',
  parse,

  async search(tab, query) {
    const res = await pageFetch(tab, `/search?q=${encodeURIComponent(query)}`);
    if (res.timedOut) throw new SiteError('timeout', `${ID}: timed out after ${res.ms} ms`, { site: ID });
    if (res.status === 403 || res.status === 429) throw new SiteError('blocked', `${ID}: ${res.status} blocked`, { site: ID, status: res.status });
    if (res.status >= 400) throw new SiteError('blocked', `${ID}: ${res.status} error`, { site: ID, status: res.status });
    const m = res.text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new SiteError('parse', `${ID}: search page has no __NEXT_DATA__`, { site: ID });
    let json;
    try {
      json = JSON.parse(m[1]);
    } catch (e) {
      throw new SiteError('parse', `${ID}: __NEXT_DATA__ is not JSON`, { site: ID, cause: e });
    }
    return parse(json);
  },
};
