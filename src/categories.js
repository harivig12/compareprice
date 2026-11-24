/**
 * Product groups: is this the raw staple, or a sweet / pooja item / packaged
 * food made from it? (design 2026-11-20, docs/superpowers/specs/2026-11-20-category-preference-design.md)
 *
 * A generic line ("ghee") gets the raw product first. Sweets and pooja items
 * are refused unless the line names them ("ghee laddu", "pooja ghee");
 * packaged foods only sort after staples.
 *
 * Word lists come from docs/diagnosis/2026-11-20-category-trigger-words.md
 * (Google Product Taxonomy 2021-09-21, Open Food Facts categories, Wikipedia's
 * list of Indian sweets), checked against the saved products. TITLE words
 * are safe in a product name. CATEGORY words are only trusted inside a site's
 * own category path, where "sweet", "frozen" or "instant" can't be a brand
 * or a description.
 */

export const GROUPS = ['staple', 'packaged', 'sweets', 'pooja'];
const REFUSABLE = new Set(['sweets', 'pooja']);

const TITLE = {
  sweets: [
    'laddu', 'laddus', 'ladoo', 'ladoos', 'laddoo', 'laddoos', 'ladu',
    'barfi', 'burfi', 'barfee', 'pedha', 'pede', 'penda',
    'mysore pak', 'mysorepak', 'mysore paak',
    'soan papdi', 'sohan papdi', 'son papdi', 'sonpapdi',
    'gulab jamun', 'gulabjamun', 'kala jamun',
    'rasgulla', 'rasagulla', 'roshogolla', 'rasmalai', 'ras malai',
    'kaju katli', 'kajukatli', 'katli',
    'jalebi', 'jilebi', 'jilapi', 'imarti',
    'chikki', 'chikkis', 'gajak', 'gajjak', 'gazak', 'rewari', 'rewri', 'revdi',
    'sandesh', 'sondesh', 'kheer', 'payasam', 'paysam', 'phirni', 'rabri', 'rabdi', 'shrikhand', 'basundi',
    'kulfi', 'petha', 'modak', 'ghevar', 'malpua', 'mohanthal', 'kalakand', 'cham cham', 'balushahi',
    'motichoor', 'shankarpali', 'gujiya', 'ghujia',
    'mithai', 'mithaai', 'confectionery', 'confectionary', 'gummies', 'gummy', 'toffee', 'toffees', 'lollipop', 'nougat', 'marzipan',
  ],
  pooja: [
    'pooja', 'puja', 'poojan', 'pujan', 'poojai', 'pujai',
    'agarbatti', 'agarbathi', 'agarbathis', 'incense', 'dhoop', 'dhup', 'dhoopam', 'loban', 'sambrani', 'guggul',
    'camphor', 'karpooram', 'karpur',
    'diya', 'diyas', 'deepam lamp', 'lamp oil', 'wick', 'wicks', 'batti', 'panju', 'jyot',
    'kumkum', 'kumkuma', 'kunkum', 'kungumam', 'sindoor', 'sindur', 'vermilion', 'haldi kumkum', 'roli', 'mauli', 'kalawa', 'abir', 'gulal',
    'havan', 'hawan', 'samagri', 'samidha', 'ashtagandha', 'rudraksha', 'gangajal', 'gangajali',
  ],
  packaged: [
    'namkeen', 'namkin', 'bhujia', 'chivda', 'mathri', 'murukku', 'chakli', 'bhakarwadi', 'khakhra', 'mixture',
    'chips', 'crisps', 'wafers', 'nachos', 'kurkure', 'pretzels', 'crackers', 'cracker',
    'biscuit', 'biscuits', 'cookie', 'cookies', 'rusk',
    'noodles', 'ramen', 'maggi', 'yippee', 'macaroni', 'cornflakes', 'corn flakes', 'muesli', 'granola',
    'ready to eat', 'ready to cook', 'rte', 'rtc', 'heat and eat', 'readymade',
    'premix', 'instant mix', 'ready mix', 'batter',
    'ketchup', 'pickle', 'pickles', 'achar', 'papad', 'papadum', 'appalam', 'fryums',
    'canned', 'tinned', 'instant noodles', 'instant soup',
  ],
};

const CATEGORY = {
  sweets: [
    'sweets', 'sweet', 'mithai', 'indian sweets', 'dessert', 'desserts', 'confectionery',
    'chocolates', 'chocolate', 'candies', 'candy', 'toffees', 'halwa', 'halva', 'peda',
    'ice cream', 'ice creams', 'kulfi', 'frozen desserts', 'cakes', 'pastries', 'jelly', 'pudding',
  ],
  pooja: ['pooja', 'puja', 'pooja needs', 'religious', 'incense', 'agarbatti', 'dhoop', 'camphor', 'lamps', 'diyas', 'wicks'],
  packaged: [
    'snacks', 'namkeen', 'chips', 'biscuits', 'cookies', 'crackers', 'instant food', 'instant', 'ready to eat', 'ready to cook',
    'ready meals', 'noodles', 'pasta', 'soups', 'sauces', 'spreads', 'jams', 'breakfast cereals', 'frozen', 'frozen food',
    'frozen snacks', 'packaged food', 'canned food',
  ],
};

// "Sweet Corn", "Sweet Lime", "Sweet Potato" are produce, not sweets.
const SWEET_PRODUCE = /\bsweet\s+(corn|lime|potato|potatoes|limes)\b/;

const padded = (text) => ` ${String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const hasAny = (pad, words) => words.some((w) => pad.includes(` ${w} `));

/** The group a product title gives away, from TITLE words only, or null. */
export function titleGroup(name) {
  const pad = padded(name);
  for (const g of ['sweets', 'pooja', 'packaged']) if (hasAny(pad, TITLE[g])) return g;
  return null;
}

/** The groups one category segment names ("Chocolates & Biscuits" names two). */
function segmentGroups(segment) {
  const raw = String(segment ?? '').toLowerCase();
  const pad = padded(raw.replace(SWEET_PRODUCE, ' '));
  return ['sweets', 'pooja', 'packaged'].filter((g) => hasAny(pad, CATEGORY[g]));
}

/**
 * The group a site's category path gives, or null.
 * Read from the most specific segment up. The top level of a multi-level path
 * can only make a product "packaged", never refuse it: BigBasket files milk
 * under "Bakery, Cakes & Dairy", so "cakes" there says nothing about milk.
 * A segment naming a refusable group and packaged at once ("Chocolates &
 * Biscuits") counts as packaged, so a biscuit is never refused.
 */
export function categoryGroup(path) {
  if (!path) return null;
  const segs = String(path).split('›').map((s) => s.trim()).filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const gs = segmentGroups(segs[i]);
    if (!gs.length) continue;
    if (gs.includes('packaged')) return 'packaged';
    if (i === 0 && segs.length > 1) return null;
    return gs[0];
  }
  return null;
}

/** Groups the line itself asks for: "ghee laddu" names sweets, "pooja oil" pooja. */
export function namedGroups(query) {
  const pad = padded(query);
  const out = new Set();
  for (const g of ['sweets', 'pooja', 'packaged']) if (hasAny(pad, TITLE[g]) || hasAny(pad, CATEGORY[g])) out.add(g);
  return out;
}

/**
 * What a product is, from the strongest signal available.
 * Either the title or the site category can make it a sweet or a pooja item
 * (refusable). An AI label (src/ai/) only ever demotes: it is never refusable,
 * because it can be wrong ("sweet lime" → sweets).
 * @returns {{ group: string, source: 'category'|'title'|'ai'|'default', refusable: boolean }}
 */
export function groupOf({ name, category, aiGroup } = {}) {
  const t = titleGroup(name);
  const c = categoryGroup(category);
  for (const [g, source] of [[t, 'title'], [c, 'category']]) {
    if (g && REFUSABLE.has(g)) return { group: g, source, refusable: true };
  }
  if (t) return { group: t, source: 'title', refusable: false };
  if (c) return { group: c, source: 'category', refusable: false };
  if (aiGroup && aiGroup !== 'staple') return { group: aiGroup === 'nonfood' ? 'packaged' : aiGroup, source: 'ai', refusable: false };
  return { group: 'staple', source: aiGroup ? 'ai' : 'default', refusable: false };
}

/** A site's category levels as one path ("A › B › C"), or null. Empty and repeated levels are dropped. */
export function categoryPath(...parts) {
  const out = [];
  for (const p of parts.flat()) {
    const s = String(p ?? '').replace(/\s+/g, ' ').trim();
    if (s && s !== out.at(-1)) out.push(s);
  }
  return out.length ? out.join(' › ') : null;
}
