/**
 * KPN Fresh (Kannan Departmental / KPN Farm Fresh) search adapter.
 *
 * Strategy: UI_SELECTOR
 * Evidence:
 *   - https://www.kpnfresh.com/search?q=<query>
 */

export const site = 'kpn';
export const label = 'KPN Fresh';

export function searchUrl(query) {
  return `https://www.kpnfresh.com/search?q=${encodeURIComponent(query)}`;
}

export const readyExpression = `(() => {
  return document.querySelectorAll('.product-card, .product-item, .card-product, [class*="productCard"], [class*="product-card"]').length > 0
    || (document.body && /No products found|no results/i.test(document.body.innerText));
})()`;

export const extractExpression = `(() => {
  const cards = [
    ...document.querySelectorAll('.product-card, .product-item, .card-product, [class*="productCard"], [class*="product-card"], div[class*="Product_card"]'),
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
    const linkEl = card.querySelector('a[href*="/product/"]') || card.querySelector('a');
    const href = linkEl?.getAttribute('href') || '';
    const url = href ? (href.startsWith('http') ? href : 'https://www.kpnfresh.com' + href) : '';
    if (url && seen.has(url)) continue;
    if (url) seen.add(url);

    const nameEl = card.querySelector('.title, .product-title, .name, [class*="title"], h3, h2, a[title]');
    const name = (nameEl?.getAttribute('title') || nameEl?.innerText || nameEl?.textContent || '').trim();
    if (!name || name.length < 2) continue;

    const priceEl = card.querySelector('.price, .special-price, [class*="price"], .amount');
    const price = money(priceEl);
    if (price == null) continue;

    const mrpEl = card.querySelector('.mrp, strike, del, .old-price, [class*="mrp"]');
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
    const soldOut = /out of stock|currently unavailable|sold out/i.test(text);

    rows.push({
      name,
      packSize,
      packUnit,
      price,
      mrp,
      inStock: !soldOut,
      url: url || ('https://www.kpnfresh.com/search?q=' + encodeURIComponent(name)),
    });
  }

  return { rows, count: rows.length };
})()`;

