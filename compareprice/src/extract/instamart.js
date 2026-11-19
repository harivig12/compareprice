/**
 * Swiggy Instamart search adapter.
 *
 * Strategy: UI_SELECTOR / HYDRATION STATE
 * Evidence:
 *   - https://www.swiggy.com/instamart/search?query=<query>
 *   - Items render with [data-testid="item-card"], [data-testid="product-card"], or [data-testid="default_container_ux4"]
 */

export const site = 'instamart';
export const label = 'Instamart';

export function searchUrl(query) {
  return `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(query)}`;
}

export const readyExpression = `(() => {
  return document.querySelectorAll('[data-testid*="item-card"], [data-testid*="product-card"], [data-testid*="search-result"], [data-testid="default_container_ux4"], ._1W_5L').length > 0
    || (document.body && /No results found|We could not find/i.test(document.body.innerText));
})()`;

export const extractExpression = `(() => {
  const cards = [
    ...document.querySelectorAll('[data-testid*="item-card"], [data-testid*="product-card"], [data-testid*="search-result"], [data-testid="default_container_ux4"]'),
  ];

  const money = (el) => {
    if (!el) return null;
    const t = (el.textContent || '').replace(/[^\\d.]/g, '');
    const n = parseFloat(t);
    return isFinite(n) ? n : null;
  };

  const rows = [];
  const seen = new Set();

  for (const card of cards) {
    const nameEl = card.querySelector('[data-testid="item_name"], [data-testid*="item-name"], .novmY, div[title], h2, h3');
    const name = (nameEl?.getAttribute('title') || nameEl?.innerText || nameEl?.textContent || '').trim();
    if (!name || name.length < 2 || seen.has(name)) continue;

    const priceEl = card.querySelector('[data-testid*="item-price"], [data-testid="item_price"], [data-testid="offer-price"], ._3Z_LH');
    const price = money(priceEl);
    if (price == null) continue;
    seen.add(name);

    const mrpEl = card.querySelector('[data-testid*="item-mrp"], [data-testid="item_mrp"], strike, ._2V8e-');
    let mrp = money(mrpEl);
    if (mrp != null && mrp <= price) mrp = null;

    // Pack size is often in subtitle or title
    const packEl = card.querySelector('[data-testid*="item-quantity"], [data-testid="item_quantity"], ._2zW-s');
    const packText = (packEl?.innerText || packEl?.textContent || name).trim();

    let packSize = null, packUnit = null;
    const multi = packText.match(/(\\d+(?:\\.\\d+)?)\\s*[x×*]\\s*(\\d+(?:\\.\\d+)?)\\s*(kg|g|gm|ml|ltr|l)\\b/i);
    const single = packText.match(/(\\d+(?:\\.\\d+)?)\\s*(kg|g|gm|ml|ltr|l)\\b/i);
    if (multi) {
      packSize = parseFloat(multi[1]) * parseFloat(multi[2]);
      packUnit = multi[3].toLowerCase();
    } else if (single) {
      packSize = parseFloat(single[1]);
      packUnit = single[2].toLowerCase();
    }

    const text = card.innerText || '';
    const soldOut = /sold out|out of stock|currently unavailable/i.test(text);

    const link = card.querySelector('a[href*="/item/"]') || card.closest('a');
    const href = link?.getAttribute('href') || '';
    const url = href ? (href.startsWith('http') ? href : 'https://www.swiggy.com' + href) : 'https://www.swiggy.com/instamart';

    rows.push({
      name,
      packSize,
      packUnit,
      price,
      mrp,
      inStock: !soldOut,
      url,
    });
  }

  return { rows, count: rows.length };
})()`;

// The in-page API path lives in src/engine/sites/instamart.js. No session
// cookies or tokens are kept in source: the engine's warm browser tab gets
// fresh guest cookies on every visit.
