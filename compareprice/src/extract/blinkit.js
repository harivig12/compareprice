/**
 * Blinkit search adapter.
 *
 * Strategy: DOM_STATE
 * Contract: visible-ui (hydration state backing the rendered cards)
 * Evidence:
 *   - window.__reduxStore__.getState().ui.search.searchProductBffData.snippets
 *   - 26 snippets for "amul milk", 24 with widget_type product_card_snippet_type_2
 *   - each card: data.name.text, data.variant.text ("34 g"), data.normal_price.text,
 *     data.is_sold_out, and tracking.click_map.{price,mrp,inventory} as clean numbers
 * Why not simpler:
 *   - PUBLIC_API / COOKIE_API: blinkit.com returns 403 to non-browser clients
 *     (Cloudflare), verified with curl over IPv4.
 *   - UI_SELECTOR: prices render into generated Tailwind classes
 *     ("tw-text-200 tw-font-semibold") with no semantic anchor — far more
 *     brittle than the state blob that feeds them.
 *
 * Note: search results include sponsored cards (overlay_badges contains "ad").
 * We keep them and let match-confidence reject them, rather than filtering on a
 * badge string that upstream can rename.
 */

export const site = 'blinkit';
export const label = 'Blinkit';

export function searchUrl(query) {
  return `https://blinkit.com/s/?q=${encodeURIComponent(query)}`;
}

/** Truthy once the search state has landed. */
export const readyExpression = `(() => {
  const s = window.__reduxStore__;
  if (!s) return false;
  const st = typeof s.getState === 'function' ? s.getState() : s;
  const snips = st?.ui?.search?.searchProductBffData?.snippets;
  return Array.isArray(snips) && snips.length > 0;
})()`;

/**
 * Runs in page context. Returns rows in the shared envelope.
 */
export const extractExpression = `(() => {
  const s = window.__reduxStore__;
  if (!s) return { error: 'no_state' };
  const st = typeof s.getState === 'function' ? s.getState() : s;
  const snips = st?.ui?.search?.searchProductBffData?.snippets;
  if (!Array.isArray(snips)) return { error: 'no_snippets' };

  const num = (v) => {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') {
      const m = v.replace(/,/g, '').match(/\\d+(?:\\.\\d+)?/);
      if (m) return parseFloat(m[0]);
    }
    return null;
  };

  // "34 g" / "500 ml" / "1 ltr" -> { size, unit }
  // "2 x 200 ml" -> { size: 400, unit: 'ml' }  (multipacks are common here)
  const parseVariant = (text) => {
    if (!text) return { size: null, unit: null };
    const s = String(text);

    const multi = s.match(/(\\d+(?:\\.\\d+)?)\\s*[x×*]\\s*(\\d+(?:\\.\\d+)?)\\s*([a-zA-Z]+)/);
    if (multi) {
      return {
        size: parseFloat(multi[1]) * parseFloat(multi[2]),
        unit: multi[3].toLowerCase(),
      };
    }

    const single = s.match(/(\\d+(?:\\.\\d+)?)\\s*([a-zA-Z]+)/);
    if (!single) return { size: null, unit: null };
    return { size: parseFloat(single[1]), unit: single[2].toLowerCase() };
  };

  const rows = [];
  for (const snip of snips) {
    if (snip?.widget_type !== 'product_card_snippet_type_2') continue;
    const d = snip.data || {};
    const cm = (snip.tracking && snip.tracking.click_map) || {};

    const name = (d.name && d.name.text) || cm.name;
    if (!name) continue;

    const price = num(cm.price) ?? num(d.normal_price && d.normal_price.text);
    if (price == null) continue;

    let mrp = num(cm.mrp);
    if (mrp != null && mrp <= price) mrp = null; // no discount worth showing

    const { size, unit } = parseVariant(d.variant && d.variant.text);
    const productId = d.product_id || (d.identity && d.identity.id) || cm.product_id;

    rows.push({
      name: String(name),
      packSize: size,
      packUnit: unit,
      price,
      mrp,
      inStock: d.is_sold_out === true ? false : (cm.inventory == null ? true : Number(cm.inventory) > 0),
      url: productId
        ? 'https://blinkit.com/prn/x/prid/' + productId
        : location.href,
    });
  }
  return { rows, count: rows.length };
})()`;
