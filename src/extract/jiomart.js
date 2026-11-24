/**
 * JioMart search adapter.
 *
 * Strategy: UI_SELECTOR
 * Evidence:
 *   - https://www.jiomart.com/search/<query>
 *   - Cards render with .ais-InfiniteHits-item, .product-card, or [data-testid="product-card"]
 *   - Title, price, MRP and pack size are embedded in card markup
 */

export const site = 'jiomart';
export const label = 'JioMart';

export function searchUrl(query) {
  return `https://www.jiomart.com/search/${encodeURIComponent(query)}`;
}

export const readyExpression = `(() => {
  return document.querySelectorAll('.ais-InfiniteHits-item, .product-card, [data-testid="product-card"], .catalog_item, .jm-prod-card').length > 0
    || (document.body && /No products found|did not match any products/i.test(document.body.innerText));
})()`;

export const extractExpression = `(() => {
  const cards = [
    ...document.querySelectorAll('.ais-InfiniteHits-item, .product-card, [data-testid="product-card"], .catalog_item, .jm-prod-card'),
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
    const linkEl = card.querySelector('a[href*="/p/"]') || card.querySelector('a');
    const href = linkEl?.getAttribute('href') || '';
    const url = href ? (href.startsWith('http') ? href : 'https://www.jiomart.com' + href) : '';
    if (url && seen.has(url)) continue;
    if (url) seen.add(url);

    const nameEl = card.querySelector('.plp-card-details-name, .product-title, .line-clamp-2, h3, h2, a[title]');
    const name = (nameEl?.getAttribute('title') || nameEl?.innerText || nameEl?.textContent || '').trim();
    if (!name || name.length < 2) continue;

    const priceEl = card.querySelector('.jm-heading-xxs, .final-price, .price, [data-testid="sp"], .plp-card-details-price');
    const price = money(priceEl);
    if (price == null) continue;

    const mrpEl = card.querySelector('.line-through, strike, .mrp, [data-testid="mrp"], .plp-card-details-mrp');
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
    const soldOut = /sold out|out of stock|currently unavailable/i.test(text);

    rows.push({
      name,
      packSize,
      packUnit,
      price,
      mrp,
      inStock: !soldOut,
      url: url || ('https://www.jiomart.com/search/' + encodeURIComponent(name)),
    });
  }

  return { rows, count: rows.length };
})()`;
