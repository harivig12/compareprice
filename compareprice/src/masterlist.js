/**
 * Master price list: turn `product list.md` (one line per product family,
 * free text) into search items, and build the report from saved prices.
 * The paced runner is scripts/master-list.js (talks to the running service).
 *
 * Line rules (from the list as written on 2026-11-19):
 *   "Rice: naga Sona Masoori, Ponni, …"  -> "naga sona masoori rice", "ponni rice", …
 *       (the head word is added when an item doesn't already say it)
 *   "Urad dal: split urad,"               -> "split urad dal"
 *   "Garlic, ginger, green chillies"       -> three items
 *   "Toor dal / Arhar dal / Pigeon peas"   -> "toor dal" (first name; the matcher
 *                                             already knows arhar/tur/thuvaram)
 *   "Maida (refined flour)"                -> "maida"
 *   blank lines, duplicates                -> dropped
 */

/** Plain typos in the list, fixed so the sites can find them. */
const TYPOS = { unflower: 'sunflower' };
/** A part that is only a describing word belongs to the item before it ("Green peas, dried"). */
const DESCRIBERS = new Set(['dried', 'fresh', 'whole', 'split', 'roasted', 'raw', 'organic', 'loose']);

const fixTypos = (s) => s.replace(/\b[a-z]+\b/g, (w) => TYPOS[w] ?? w);

/**
 * "Tea leaves / Tea bags" -> "Tea leaves" (alternatives, spaced);
 * "Kitchen/bathroom cleaner" -> "kitchen cleaner" (one word swapped, unspaced).
 */
function firstAlternative(part) {
  if (/\s\/\s/.test(part)) return part.split(/\s\/\s/)[0];
  const m = /^(.*?)\b([a-z-]+)\/[a-z-]+\b(.*)$/i.exec(part);
  return m ? `${m[1]}${m[2]}${m[3]}` : part;
}

const clean = (s) => String(s)
  .replace(/\([^)]*\)/g, ' ')
  .replace(/[*_`#>]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/** The noun a "Head: a, b" line is about: "Urad dal" -> "dal", "Rice" -> "rice". */
const headNoun = (head) => clean(head).split(' ').filter(Boolean).at(-1) ?? '';

/**
 * @param {string} text  contents of product list.md
 * @returns {{ query: string, line: number, source: string }[]}
 */
export function parseProductList(text) {
  const out = [];
  const seen = new Set();
  const add = (q, line, source) => {
    const query = clean(q).replace(/^[-–•\d.)\s]+/, '').replace(/[,;:.]+$/, '').trim();
    if (query.length < 2 || seen.has(query)) return;
    seen.add(query);
    out.push({ query, line, source: source.trim() });
  };
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || /^#/.test(line)) return;
    const colon = line.indexOf(':');
    let head = '';
    let rest = line;
    if (colon > 0) {
      head = line.slice(0, colon);
      rest = line.slice(colon + 1);
    }
    const parts = [];
    for (const p of rest.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (DESCRIBERS.has(clean(p)) && parts.length) parts[parts.length - 1] = `${clean(p)} ${parts[parts.length - 1]}`;
      // "Tissues and toilet paper" is two products.
      else parts.push(...p.split(/\s+and\s+/i));
    }
    // "Rice:" with nothing after: the head is the item.
    if (!parts.length && head) parts.push(head);
    const noun = headNoun(head);
    for (const part of parts) {
      const first = fixTypos(clean(firstAlternative(part)));
      const words = clean(first).split(' ');
      // Add the family word only when the item doesn't say it already:
      // "Ponni" -> "ponni rice", but "iodised salt" stays as it is.
      const q = noun && !words.includes(noun) ? `${clean(first)} ${noun}` : first;
      add(q, i + 1, line);
    }
  });
  return out;
}

/** Split into batches of `size`. */
export function batches(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const rate = (product) => {
  if (!product?.pricePerUnit || !product.packUnit) return null;
  const unit = product.packUnit;
  if (unit === 'piece') return { value: product.pricePerUnit, per: 'pc' };
  return { value: product.pricePerUnit * 100, per: unit === 'ml' ? '100 ml' : '100 g' };
};

/**
 * Rows of the master list from cached compareBasket() results: one row per
 * item × site with a saved, matched price, plus the cheapest site per item
 * (by rate when the sites share a unit, else by price).
 */
export function masterRows(results) {
  const rows = [];
  for (const r of results) {
    for (const item of r.basket ?? []) {
      const lines = [];
      for (const p of r.platforms ?? []) {
        const l = (p.lines ?? []).find((x) => x.query === item.query);
        if (!l || l.lineTotal == null || l.status !== 'ok' || !l.product) continue;
        lines.push({ site: p.platform, label: p.label ?? p.platform, l, rate: rate(l.product) });
      }
      const sameUnit = lines.length && lines.every((x) => x.rate) && new Set(lines.map((x) => x.rate.per)).size === 1;
      const key = (x) => (sameUnit ? x.rate.value : x.l.product.price);
      const best = [...lines].sort((a, b) => key(a) - key(b))[0];
      for (const x of lines) {
        rows.push({
          item: item.query,
          site: x.site,
          label: x.label,
          product: x.l.product.name,
          pack: x.l.product.packLabel ?? '',
          price: x.l.product.price,
          mrp: x.l.product.mrp ?? null,
          rate: x.rate ? Math.round(x.rate.value * 100) / 100 : null,
          per: x.rate?.per ?? '',
          seenAt: x.l.cachedAt ?? null,
          cheapest: x === best,
        });
      }
      if (!lines.length) rows.push({ item: item.query, site: '', label: '', product: '', pack: '', price: null, mrp: null, rate: null, per: '', seenAt: null, cheapest: false });
    }
  }
  return rows;
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows) {
  const cols = ['item', 'site', 'product', 'pack', 'price', 'mrp', 'rate', 'per', 'seenAt', 'cheapest'];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

/** One line per item: the cheapest site, its product and rate, how many sites have it. */
export function toMarkdown(rows, { title = 'Master price list', generatedAt = new Date().toISOString() } = {}) {
  const byItem = new Map();
  for (const r of rows) byItem.set(r.item, [...(byItem.get(r.item) ?? []), r]);
  const md = [`# ${title}`, '', `Built ${generatedAt} from saved prices. Rates are per 100 g / 100 ml / piece. Goods only.`, '',
    '| Item | Cheapest site | Product | Pack | Price | Rate | Sites with a price |', '|---|---|---|---|---|---|---|'];
  let missing = 0;
  for (const [item, list] of byItem) {
    const priced = list.filter((r) => r.site);
    const b = priced.find((r) => r.cheapest);
    if (!b) { missing++; md.push(`| ${item} | — | — | — | — | — | 0 |`); continue; }
    const esc = (s) => String(s).replace(/\|/g, '/');
    md.push(`| ${esc(item)} | ${esc(b.label)} | ${esc(b.product)} | ${esc(b.pack)} | ₹${b.price} | ${b.rate != null ? `₹${b.rate}/${b.per}` : '—'} | ${priced.length} |`);
  }
  md.push('', `${byItem.size} items · ${byItem.size - missing} with at least one price · ${missing} with none yet.`, '');
  return md.join('\n');
}
