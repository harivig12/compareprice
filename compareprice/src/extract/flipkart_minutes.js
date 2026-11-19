/**
 * Flipkart Minutes (Hyperlocal) search adapter.
 *
 * Strategy: UI_SELECTOR
 * Evidence:
 *   - https://www.flipkart.com/search?q=<query>&marketplace=HYPERLOCAL
 *   - Or landing: https://www.flipkart.com/flipkart-minutes-store?marketplace=HYPERLOCAL
 */

export const site = 'flipkart_minutes';
export const label = 'Flipkart Minutes';

export function searchUrl(query) {
  return `https://www.flipkart.com/search?q=${encodeURIComponent(query)}&marketplace=HYPERLOCAL`;
}

export const readyExpression = `(() => {
  return document.querySelectorAll('div[data-id], ._1AtVbE, ._75nlfW, div[class*="productCard"], div[class*="col-"]').length > 0
    || (document.body && /No results found|did not match any products/i.test(document.body.innerText));
})()`;

export const extractExpression = `(() => {
  const cards = [
    ...document.querySelectorAll('div[data-id], ._1AtVbE, div[class*="productCard"]'),
  ].filter(c => c.querySelector('a') && (c.innerText.includes('₹') || c.innerText.includes('Rs.')));

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
    const url = href ? (href.startsWith('http') ? href : 'https://www.flipkart.com' + href) : '';
    if (url && seen.has(url)) continue;
    if (url) seen.add(url);

    const nameEl = card.querySelector('.s1Q9rs, ._4rR01T, .KzDlHZ, .wjcEIp, a[title], div[class*="title"]');
    const name = (nameEl?.getAttribute('title') || nameEl?.innerText || nameEl?.textContent || '').trim();
    if (!name || name.length < 2) continue;

    const priceEl = card.querySelector('._30jeq3, ._1_WHN1, .Nx9bqj, div[class*="price"]');
    const price = money(priceEl);
    if (price == null) continue;

    const mrpEl = card.querySelector('._3I9_wc, ._27UcVY, .yRaY8j, strike, del');
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
      url: url || ('https://www.flipkart.com/search?q=' + encodeURIComponent(name)),
    });
  }

  return { rows, count: rows.length };
})()`;

