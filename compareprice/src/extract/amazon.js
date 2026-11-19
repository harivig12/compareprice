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

export function tezSearchUrl(query) {
  return `https://www.amazon.in/tez/browse/search?qcbrand=qqfsWw9RkO&searchKeyword=${encodeURIComponent(query)}`;
}

export function tezDirectBrowseUrl(query) {
  return `https://www.amazon.in/tez/browse?qcbrand=qqfsWw9RkO&searchKeyword=${encodeURIComponent(query)}`;
}

export const readyExpression = `document.querySelectorAll('div[data-component-type="s-search-result"], div[data-asin], .a-section').length > 0 || (document.body && (document.body.innerText.includes('No results for your search query') || document.body.innerText.includes('did not match any products')))`;

export const extractExpression = `(() => {
  const bodyText = (document.body && document.body.innerText) || '';
  const noResultsInFresh = /No results for your search query in Amazon Fresh/i.test(bodyText) ||
                           /did not match any products/i.test(bodyText);

  // Cards can be standard search result items or Tez quick-commerce tiles
  let cards = [...document.querySelectorAll('div[data-component-type="s-search-result"]')];
  if (cards.length === 0) {
    cards = [...document.querySelectorAll('div[data-asin]')].filter(c => c.getAttribute('data-asin') && c.innerText && c.innerText.includes('₹'));
  }

  if (cards.length === 0 || noResultsInFresh) {
    return { rows: [], count: 0, fallbackNeeded: true, reason: noResultsInFresh ? 'no_fresh_results' : 'no_cards' };
  }

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

    // Amazon's layout puts the brand in <h2> and product title in title-recipe link.
    // In Tez layout it can be in .a-size-base-plus, [data-cy="title-recipe"], or h2.
    const candidates = [
      ...card.querySelectorAll('[data-cy="title-recipe"] a span, [data-cy="title-recipe"] span, h2 a span, h2 span, h2, .a-size-base-plus'),
    ]
      .map(el => (el.innerText || el.textContent || '').trim())
      .filter(t => t.length > 2);
    const name = candidates.sort((a, b) => b.length - a.length)[0] || '';
    if (!name) continue;
    seen.add(asin);

    const price = money(card.querySelector('.a-price .a-offscreen, .a-color-price, .a-price'));
    if (price == null) continue;

    // Struck-through list price, when shown.
    const mrpEl = card.querySelector('.a-price.a-text-price .a-offscreen, .a-text-strike');
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
