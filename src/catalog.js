/**
 * Product catalogue: many names, one product.
 *
 * A basket line is resolved against the synonym sets in catalog-data.js.
 * When it names a product by any of its tags ("kismis 500g", "gud", "arhar
 * dal 1kg"), the line is rewritten to the canonical tag ("raisins 500g",
 * "jaggery", "toor dal 1kg"). Everything downstream (the live search, the
 * matcher, the price history) then sees one product, so "kismis" and
 * "raisins" never split into two result sets or two histories.
 *
 * The rewrite is deliberately narrow. It happens only when the line is the
 * product plus nothing but brands, pack sizes and plain modifiers
 * ("organic", "premium", "salted"...). "britannia good day cashew" is not
 * "cashew", and "kishmish namkeen" is left alone.
 */
import { ROWS, CATEGORIES } from './catalog-data.js';
import { BRANDS } from './brands.js';

export { CATEGORIES };

const clean = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const list = (s) => String(s ?? '').split(',').map(clean).filter(Boolean);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @type {Array<{ id: string, name: string, category: string, canonical: string, tags: string[], sub: string[], brands: string[] }>} */
export const PRODUCTS = ROWS.map(([name, category, aka, sub, brands]) => {
  const tags = list(aka);
  return { id: clean(name).replace(/\s+/g, '-'), name, category, canonical: tags[0], tags, sub: list(sub), brands: list(brands) };
});

export const PRODUCT_BY_ID = new Map(PRODUCTS.map((p) => [p.id, p]));

// phrase -> { product, kind: 'tag' | 'sub' | 'brand' }. A phrase belongs to
// one product; any clash is recorded (and a test keeps the list empty).
const INDEX = new Map();
const CONFLICTS = [];
for (const product of PRODUCTS) {
  for (const [kind, phrases] of [['tag', product.tags], ['sub', product.sub], ['brand', product.brands]]) {
    for (const phrase of phrases) {
      const prev = INDEX.get(phrase);
      if (!prev) INDEX.set(phrase, { product, kind });
      else if (prev.product !== product) CONFLICTS.push({ phrase, products: [prev.product.id, product.id] });
    }
  }
}
const MAX_WORDS = Math.max(...[...INDEX.keys()].map((k) => k.split(' ').length));

/** Phrases claimed by more than one product (should be none). */
export function catalogConflicts() {
  return CONFLICTS.slice();
}

const ALL_BRANDS = [...new Set([...BRANDS, ...PRODUCTS.flatMap((p) => p.brands)])].sort(
  (a, b) => b.split(' ').length - a.split(' ').length || b.length - a.length,
);

/**
 * Words that may sit beside a product name without changing which product it
 * is. Variant words ("salted", "toned") are kept in the rewritten line, so
 * the matcher still insists on them.
 */
const MODIFIERS = new Set([
  'organic', 'premium', 'natural', 'pure', 'fresh', 'whole', 'split', 'loose', 'small', 'medium',
  'large', 'big', 'jumbo', 'local', 'regular', 'classic', 'original', 'best', 'value', 'pack',
  'packet', 'pouch', 'bottle', 'jar', 'box', 'refill', 'combo', 'family', 'economy', 'super',
  'extra', 'new', 'special', 'select', 'gold', 'daily', 'indian', 'desi', 'quality', 'grade',
  'toned', 'double', 'full', 'skimmed', 'slim', 'diet', 'zero', 'sugarfree', 'unsweetened',
  'sweetened', 'salted', 'unsalted', 'plain', 'brown', 'white', 'red', 'black', 'green', 'yellow',
  'multigrain', 'spicy', 'refined', 'raw', 'filtered', 'dark', 'roasted', 'seedless', 'dry',
  'the', 'a', 'an', 'of', 'and', 'with', 'for', 'in',
]);

// Pack sizes and bare numbers: "500g", "1 kg", "2 x 250ml", "6".
const PACK_RE =
  /\b\d+(?:\.\d+)?\s*(?:[x×*]\s*\d+(?:\.\d+)?\s*)?(?:kgs?|kilos?|kilograms?|gms?|grams?|g|mls?|ltrs?|lt|litres?|liters?|l|pcs?|pieces?|packs?|packets?|units?|dozen)?(?![a-z])/g;

const memo = new Map();

/**
 * Which catalogue product a basket line names, if any.
 * @param {string} text
 * @returns {{ product: object, kind: 'tag'|'sub'|'brand', phrase: string, brands: string[] } | null}
 */
export function resolveProduct(text) {
  const key = String(text ?? '');
  if (memo.has(key)) return memo.get(key);
  const out = resolveUncached(key);
  if (memo.size > 5000) memo.clear();
  memo.set(key, out);
  return out;
}

function resolveUncached(text) {
  let core = ` ${clean(text).replace(PACK_RE, ' ')} `;
  const brands = [];
  for (const b of ALL_BRANDS) {
    if (core.includes(` ${b} `)) {
      brands.push(b);
      core = core.split(` ${b} `).join(' ');
    }
  }
  const words = core.split(' ').filter((w) => w && !/\d/.test(w));

  // The longest catalogue phrase in the line whose leftovers are all modifiers.
  let best = null;
  for (let n = Math.min(MAX_WORDS, words.length); n >= 1 && !best; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(' ');
      const hit = INDEX.get(phrase);
      if (!hit || hit.kind === 'brand') continue;
      const rest = [...words.slice(0, i), ...words.slice(i + n)];
      if (rest.every((w) => MODIFIERS.has(w))) {
        best = { product: hit.product, kind: hit.kind, phrase, brands };
        break;
      }
    }
  }
  if (best) return best;

  // "harpic", "dalda 1kg": a brand facet standing for its product.
  if (words.every((w) => MODIFIERS.has(w))) {
    const b = brands.find((x) => INDEX.get(x)?.kind === 'brand');
    if (b) return { product: INDEX.get(b).product, kind: 'brand', phrase: b, brands };
  }
  return null;
}

const phraseRe = (phrase) => phrase.split(' ').map(escapeRe).join('[^a-z0-9]+');

/**
 * The line with its product named by the canonical tag. Unchanged when the
 * line names no catalogue product, names it by a narrower (sub) name or a
 * brand, or already uses the canonical tag.
 * @param {string} text
 * @returns {string}
 */
export function canonicalQuery(text) {
  const r = resolveProduct(text);
  if (!r || r.kind !== 'tag' || r.phrase === r.product.canonical) return text;
  const s = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  const re = new RegExp(`(^|[^a-z])${phraseRe(r.phrase)}(?![a-z])`);
  return re.test(s) ? s.replace(re, (m, pre) => pre + r.product.canonical) : text;
}

const foldCache = new Map();
function foldRe(product) {
  if (!foldCache.has(product.id)) {
    const alts = product.tags
      .filter((t) => t !== product.canonical)
      .sort((a, b) => b.length - a.length)
      .map(phraseRe);
    foldCache.set(product.id, alts.length ? new RegExp(`(^|[^a-z])(?:${alts.join('|')})(?![a-z])`, 'g') : null);
  }
  return foldCache.get(product.id);
}

/**
 * A listing's name read in the query's vocabulary: when `query` names a
 * catalogue product, that product's other names in `name` become its
 * canonical tag ("Kishmish Green 250 g" -> "raisins green 250 g" for
 * "raisins"). Only that product's names are folded, never anyone else's.
 */
export function foldAliases(query, name) {
  const r = resolveProduct(query);
  const re = r && foldRe(r.product);
  if (!re) return name;
  return String(name ?? '').toLowerCase().replace(re, (m, pre) => pre + r.product.canonical);
}

/**
 * Catalogue facets of a basket line, for display and filtering.
 * @returns {{ id: string, name: string, canonical: string, category: string, matchedBy: string, phrase: string, brand: string|null } | null}
 */
export function describeQuery(text) {
  const r = resolveProduct(text);
  if (!r) return null;
  const { id, name, canonical, category } = r.product;
  return { id, name, canonical, category, matchedBy: r.kind, phrase: r.phrase, brand: r.brands[0] ?? null };
}

/** Products, optionally one category, as plain objects. */
export function listProducts({ category } = {}) {
  return PRODUCTS.filter((p) => !category || p.category === category).map((p) => ({ ...p }));
}

/**
 * Catalogue products a search term could mean, for suggestions: any whose
 * name, tags, sub-names or brands start with (or contain) the term.
 */
export function productsMatching(term, limit = 10) {
  const t = clean(term);
  if (!t) return [];
  const scored = [];
  for (const p of PRODUCTS) {
    const names = [...p.tags, ...p.sub, ...p.brands];
    const starts = names.some((n) => n.startsWith(t) || n.includes(` ${t}`));
    const contains = starts || names.some((n) => n.includes(t));
    if (contains) scored.push([starts ? 0 : 1, p]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, p]) => p);
}
