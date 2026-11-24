/**
 * Milkbasket search adapter.
 *
 * Note: Milkbasket is an app-driven platform requiring user session and society/hub assignment.
 * When accessed via web, search redirects or renders empty without location headers.
 * The in-page API path lives in src/engine/sites/milkbasket.js (no tokens in source).
 */

export const site = 'milkbasket';
export const label = 'Milkbasket';

export function searchUrl(query) {
  return `https://www.milkbasket.com/search?q=${encodeURIComponent(query)}`;
}

export const readyExpression = `(() => {
  return document.querySelectorAll('.product-card, .product-item, [data-testid="product"], .productTile').length > 0
    || (document.body && /No products found|download the milkbasket app/i.test(document.body.innerText))
    || true;
})()`;

export const extractExpression = `(() => {
  const cards = [
    ...document.querySelectorAll('.product-card, .product-item, [data-testid="product"], .productTile, div[class*="product"]'),
  ];
  if (cards.length === 0) return { rows: [], count: 0 };

  const money = (el) => {
    if (!el) return null;
    const t = (el.textContent || '').replace(/[^\\d.]/g, '');
    const n = parseFloat(t);
    return isFinite(n) ? n : null;
  };

  const rows = [];
  const seen = new Set();

  for (const card of cards) {
    const nameEl = card.querySelector('.title, .name, h3, h2, div[class*="name"]');
    const name = (nameEl?.innerText || nameEl?.textContent || '').trim();
    if (!name || name.length < 2 || seen.has(name)) continue;

    const priceEl = card.querySelector('.price, .sp, .selling-price, [class*="price"]');
    const price = money(priceEl);
    if (price == null) continue;
    seen.add(name);

    const mrpEl = card.querySelector('.mrp, strike, del, [class*="mrp"]');
    let mrp = money(mrpEl);
    if (mrp != null && mrp <= price) mrp = null;

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
    const soldOut = /sold out|out of stock|unavailable/i.test(text);

    rows.push({
      name,
      packSize,
      packUnit,
      price,
      mrp,
      inStock: !soldOut,
      url: 'https://www.milkbasket.com/',
    });
  }

  return { rows, count: rows.length };
})()`;
