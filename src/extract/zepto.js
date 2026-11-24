/**
 * Zepto search adapter.
 *
 * Strategy: UI_SELECTOR (with names read from the URL slug, not the DOM text)
 * Contract: visible-ui
 * Evidence:
 *   - live domain is zepto.com; zeptonow.com does not resolve directly
 *   - search results render as <a href="/pn/<slug>/pvid/<uuid>"> cards, 30 per page
 *   - card innerText carries price ("₹33"), optional struck MRP, and pack ("1 pack (450 ml)")
 *
 * Names come from the href slug rather than the card's text node. The slug is
 * a stable, server-generated identifier, while the visible title is truncated
 * with an ellipsis in the grid ("Amul Taaza Homogenised Toned Milk Tetra Pa…").
 * Truncated names would silently depress match confidence, so we don't use them.
 *
 * Why not simpler:
 *   - PUBLIC_API / COOKIE_API: no reachable JSON endpoint found; the page is a
 *     Next.js App Router stream whose __next_f buffer is already drained by the
 *     time the document is idle.
 *   - DOM_STATE: no hydration blob survives on window.
 */

export const site = 'zepto';
export const label = 'Zepto';

export function searchUrl(query) {
  return `https://www.zepto.com/search?query=${encodeURIComponent(query)}`;
}

export const readyExpression = `document.querySelectorAll('a[href*="/pn/"]').length > 0`;

export const extractExpression = `(() => {
  const cards = [...document.querySelectorAll('a[href*="/pn/"]')];
  if (cards.length === 0) return { error: 'no_cards' };

  // "/pn/amul-taaza-homogenised-toned-milk-tetra-pack/pvid/84ea..." -> readable name.
  // Slug is authoritative: the rendered text is missing every "s".
  const nameFromHref = (href) => {
    const m = String(href).match(/\\/pn\\/([^/]+)\\/pvid\\//);
    if (!m) return null;
    return decodeURIComponent(m[1])
      .split('-')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  };

  const seen = new Set();
  const rows = [];

  for (const card of cards) {
    const href = card.getAttribute('href') || '';
    const pvid = (href.match(/\\/pvid\\/([^/?#]+)/) || [])[1];
    if (!pvid || seen.has(pvid)) continue;
    seen.add(pvid);

    const name = nameFromHref(href);
    if (!name) continue;

    const text = card.innerText || '';

    // Prices: first ₹ value is what you pay; a second, larger one is the MRP.
    const money = [...text.matchAll(/₹\\s?(\\d+(?:[.,]\\d+)?)/g)]
      .map(m => parseFloat(m[1].replace(/,/g, '')))
      .filter(n => isFinite(n));
    if (money.length === 0) continue;

    const price = money[0];
    let mrp = null;
    for (const v of money.slice(1)) {
      if (v > price) { mrp = v; break; }
    }

    // Pack: "1 pack (450 ml)", "1 pc (150 ml)", "2 x 200 ml"
    let packSize = null, packUnit = null;
    const multi = text.match(/(\\d+(?:\\.\\d+)?)\\s*[x×*]\\s*(\\d+(?:\\.\\d+)?)\\s*([a-zA-Z]+)/);
    const paren = text.match(/\\((\\d+(?:\\.\\d+)?)\\s*([a-zA-Z]+)\\)/);
    if (multi) {
      packSize = parseFloat(multi[1]) * parseFloat(multi[2]);
      packUnit = multi[3].toLowerCase();
    } else if (paren) {
      packSize = parseFloat(paren[1]);
      packUnit = paren[2].toLowerCase();
    }

    // No ADD control, or an explicit sold-out label, means unavailable.
    // The label itself is 's'-mangled, so match loosely.
    const soldOut = /out\\s*of\\s*(s?)tock|(s?)old\\s*out|notify\\s*me/i.test(text);

    rows.push({
      name,
      packSize,
      packUnit,
      price,
      mrp,
      inStock: !soldOut,
      url: 'https://www.zepto.com' + href,
    });
  }

  return { rows, count: rows.length };
})()`;
