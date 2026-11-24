/**
 * BigBasket search adapter.
 *
 * Strategy: UI_SELECTOR
 * Contract: visible-ui
 * Evidence:
 *   - https://www.bigbasket.com/ps/?q=<query> renders ~32 <a href="/pd/<id>/<slug>/"> cards
 *   - card text is pipe-clean and ordered:
 *       "10 MINS | Amul | Pasteurised Butter | 4.1 | 132976 Ratings | 100 g - Carton | ₹63.00 | Add"
 *     giving brand, product, pack and price as separate lines
 *   - the slug repeats the pack ("amul-butter-pasteurised-100-g-carton"), so pack size
 *     survives even when the card layout shifts
 *
 * Why not simpler:
 *   - PUBLIC_API / COOKIE_API: no unauthenticated JSON endpoint found during recon.
 *   - DOM_STATE: no hydration blob exposed on window.
 */

export const site = 'bigbasket';
export const label = 'BigBasket';

export function searchUrl(query) {
  return `https://www.bigbasket.com/ps/?q=${encodeURIComponent(query)}`;
}

export const readyExpression = `document.querySelectorAll('a[href*="/pd/"]').length > 0`;

export const extractExpression = `(() => {
  const anchors = [...document.querySelectorAll('a[href*="/pd/"]')];
  if (anchors.length === 0) return { error: 'no_cards' };

  // Climb from the anchor to the nearest ancestor that actually holds a price.
  const cardFor = (a) => {
    let cur = a;
    for (let i = 0; i < 5 && cur; i++) {
      if (/₹/.test(cur.textContent || '')) return cur;
      cur = cur.parentElement;
    }
    return a;
  };

  const seen = new Set();
  const rows = [];

  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    const id = (href.match(/\\/pd\\/(\\d+)\\//) || [])[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const card = cardFor(a);
    const parts = (card.innerText || '')
      .split('\\n')
      .map(s => s.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;

    // Discount badges ("₹5 OFF", "SAVE ₹20") sit above the real price and
    // would otherwise be read as the price — a 6-egg tray priced at ₹5.
    const isBadge = (p) => /\\b(off|save|saving|discount|cashback)\\b/i.test(p);
    const moneyLines = parts.filter(p => /^₹\\s?\\d/.test(p) && !isBadge(p));

    const priceLine = moneyLines[0];
    if (!priceLine) continue;
    const price = parseFloat(priceLine.replace(/[^\\d.]/g, ''));
    if (!isFinite(price)) continue;

    // A struck-through MRP appears as a second, larger rupee value.
    const allMoney = moneyLines
      .map(p => parseFloat(p.replace(/[^\\d.]/g, '')))
      .filter(n => isFinite(n));
    let mrp = null;
    for (const v of allMoney) { if (v > price) { mrp = v; break; } }

    // Brand and product name sit before the ratings block. Prefer building the
    // name from the slug: it is stable and already brand-prefixed.
    const slug = (href.match(/\\/pd\\/\\d+\\/([^/?]+)/) || [])[1] || '';
    let name = slug
      .split('-')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    // Trim the packaging suffix the slug carries ("... 100 G Carton").
    name = name.replace(/\\s+\\d+(\\.\\d+)?\\s*(G|Kg|Ml|L|Ltr|Gm)\\b.*$/i, '').trim();
    if (!name) {
      const idx = parts.findIndex(p => /Ratings?$/i.test(p));
      name = parts.slice(Math.max(0, idx - 3), idx).join(' ') || parts[0];
    }

    // Pack: a line like "100 g - Carton" / "1 kg - Pouch", else from the slug.
    let packSize = null, packUnit = null;
    const packLine = parts.find(p => /^\\d+(\\.\\d+)?\\s*(g|kg|ml|l|ltr|gm|pc|pcs)\\b/i.test(p));
    const packSrc = packLine || slug.replace(/-/g, ' ');
    const multi = packSrc.match(/(\\d+(?:\\.\\d+)?)\\s*[x×*]\\s*(\\d+(?:\\.\\d+)?)\\s*([a-zA-Z]+)/);
    const single = packSrc.match(/(\\d+(?:\\.\\d+)?)\\s*(kg|g|gm|ml|ltr|l|pcs|pc)\\b/i);
    if (multi) {
      packSize = parseFloat(multi[1]) * parseFloat(multi[2]);
      packUnit = multi[3].toLowerCase();
    } else if (single) {
      packSize = parseFloat(single[1]);
      packUnit = single[2].toLowerCase();
    }

    const text = card.innerText || '';
    const soldOut = /out of stock|notify me|currently unavailable/i.test(text);

    rows.push({
      name,
      packSize,
      packUnit,
      price,
      mrp,
      inStock: !soldOut,
      url: 'https://www.bigbasket.com' + href.split('?')[0],
    });
  }

  return { rows, count: rows.length };
})()`;
