/**
 * Amazon Now (Amazon's quick-commerce storefront) search adapter.
 *
 * Strategy: UI_SELECTOR
 * Contract: visible-ui (Amazon's search result markup is long-lived)
 * Evidence:
 *   - https://www.amazon.in/s?k=<query>&i=nowstore scopes search to the Now store
 *   - results are div[data-component-type="s-search-result"] carrying data-asin
 *   - price in .a-price .a-offscreen ("₹63.00"), title in h2, link in h2 a[href]
 *
 * ⚠ Relevance on the Now store is noticeably weaker than the dedicated quick
 *   commerce apps — a query for "amul butter" returns Country Delight ghee in
 *   the top slots, and result counts are small (~6 vs 24-32 elsewhere). The
 *   match-confidence layer rejects the noise, but expect this platform to miss
 *   more basket lines than the others. That is reported, not hidden.
 *
 * Why not simpler:
 *   - PUBLIC_API: Amazon's product API needs PA-API credentials.
 *   - DOM_STATE: no usable hydration blob on the search page.
 */

export const site = 'amazon';
export const label = 'Amazon Now';

export function searchUrl(query) {
  return `https://www.amazon.in/s?k=${encodeURIComponent(query)}&i=nowstore`;
}

export const readyExpression = `document.querySelectorAll('div[data-component-type="s-search-result"]').length > 0`;

export const extractExpression = `(() => {
  const cards = [...document.querySelectorAll('div[data-component-type="s-search-result"]')];
  if (cards.length === 0) return { error: 'no_cards' };

  const money = (el) => {
    if (!el) return null;
    const t = (el.textContent || '').replace(/[^\\d.]/g, '');
    const n = parseFloat(t);
    return isFinite(n) ? n : null;
  };

  const seen = new Set();
  const rows = [];

  for (const card of cards) {
    const asin = card.getAttribute('data-asin');
    if (!asin || seen.has(asin)) continue;

    // Amazon's current layout puts the BRAND in <h2> and the real product
    // title in the title-recipe link. Take the longest candidate so we get the
    // descriptive string rather than "GIRORGANIC".
    const candidates = [
      ...card.querySelectorAll('[data-cy="title-recipe"] a span, [data-cy="title-recipe"] span, h2 a span, h2 span, h2'),
    ]
      .map(el => (el.innerText || el.textContent || '').trim())
      .filter(t => t.length > 2);
    const name = candidates.sort((a, b) => b.length - a.length)[0] || '';
    if (!name) continue;
    seen.add(asin);

    const price = money(card.querySelector('.a-price .a-offscreen'));
    if (price == null) continue;

    // Struck-through list price, when shown.
    const mrpEl = card.querySelector('.a-price.a-text-price .a-offscreen');
    let mrp = money(mrpEl);
    if (mrp != null && mrp <= price) mrp = null;

    // Amazon puts the pack in the title: "... | 900 ML", "Amul Butter 500 g".
    let packSize = null, packUnit = null;
    const multi = name.match(/(\\d+(?:\\.\\d+)?)\\s*[x×*]\\s*(\\d+(?:\\.\\d+)?)\\s*(kg|g|gm|ml|ltr|l)\\b/i);
    const single = name.match(/(\\d+(?:\\.\\d+)?)\\s*(kg|g|gm|ml|ltr|l)\\b/i);
    if (multi) {
      packSize = parseFloat(multi[1]) * parseFloat(multi[2]);
      packUnit = multi[3].toLowerCase();
    } else if (single) {
      packSize = parseFloat(single[1]);
      packUnit = single[2].toLowerCase();
    }

    const text = card.innerText || '';
    const soldOut = /currently unavailable|out of stock/i.test(text);

    rows.push({
      name,
      packSize,
      packUnit,
      price,
      mrp,
      inStock: !soldOut,
      url: 'https://www.amazon.in/dp/' + asin,
    });
  }

  return { rows, count: rows.length };
})()`;
