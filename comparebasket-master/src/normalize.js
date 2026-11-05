/**
 * Pack-size normalization and product-match confidence.
 *
 * Two jobs:
 *   1. Turn "500ml" / "0.5 L" / "2 x 250ml" / "1kg" into a comparable number.
 *   2. Decide whether two product names plausibly refer to the same product,
 *      and refuse to compare them when they don't.
 *
 * Refusing is the point. A cheerful wrong comparison is worse than a gap.
 */

// unit token -> [canonical unit, multiplier, family]
const UNITS = {
  g: ['g', 1, 'mass'],
  gm: ['g', 1, 'mass'],
  gms: ['g', 1, 'mass'],
  gram: ['g', 1, 'mass'],
  grams: ['g', 1, 'mass'],
  kg: ['g', 1000, 'mass'],
  kgs: ['g', 1000, 'mass'],
  kilo: ['g', 1000, 'mass'],
  kilos: ['g', 1000, 'mass'],
  kilogram: ['g', 1000, 'mass'],
  kilograms: ['g', 1000, 'mass'],

  ml: ['ml', 1, 'volume'],
  mls: ['ml', 1, 'volume'],
  l: ['ml', 1000, 'volume'],
  lt: ['ml', 1000, 'volume'],
  ltr: ['ml', 1000, 'volume'],
  ltrs: ['ml', 1000, 'volume'],
  litre: ['ml', 1000, 'volume'],
  litres: ['ml', 1000, 'volume'],
  liter: ['ml', 1000, 'volume'],
  liters: ['ml', 1000, 'volume'],

  pc: ['piece', 1, 'count'],
  pcs: ['piece', 1, 'count'],
  piece: ['piece', 1, 'count'],
  pieces: ['piece', 1, 'count'],
  pack: ['piece', 1, 'count'],
  packs: ['piece', 1, 'count'],
  packet: ['piece', 1, 'count'],
  packets: ['piece', 1, 'count'],
  unit: ['piece', 1, 'count'],
  units: ['piece', 1, 'count'],
  egg: ['piece', 1, 'count'],
  eggs: ['piece', 1, 'count'],
  dozen: ['piece', 12, 'count'],
};

const UNIT_ALTERNATION = Object.keys(UNITS)
  .sort((a, b) => b.length - a.length) // longest first, so "kg" beats "g"
  .join('|');

// "2 x 250ml", "2x250 ml", "6 x 1 L"
const MULTIPACK_RE = new RegExp(
  `(\\d+)\\s*[x×*]\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNIT_ALTERNATION})\\b`,
  'i',
);

// "500ml", "0.5 L", "1 kg", "250gm"
const SINGLE_RE = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(${UNIT_ALTERNATION})\\b`,
  'i',
);

// Bare count with no unit at all: "6 eggs" is caught by UNITS, but "pack of 6" isn't.
const PACK_OF_RE = /pack\s+of\s+(\d+)/i;

/**
 * Parse a pack size out of free text.
 * @param {string} text
 * @returns {{ size: number, unit: 'g'|'ml'|'piece', family: 'mass'|'volume'|'count', source: string } | null}
 */
export function parsePack(text) {
  if (!text) return null;
  const s = String(text);

  const multi = s.match(MULTIPACK_RE);
  if (multi) {
    const count = Number.parseFloat(multi[1]);
    const each = Number.parseFloat(multi[2]);
    const [unit, mult, family] = UNITS[multi[3].toLowerCase()];
    return { size: count * each * mult, unit, family, source: multi[0] };
  }

  const single = s.match(SINGLE_RE);
  if (single) {
    const value = Number.parseFloat(single[1]);
    const [unit, mult, family] = UNITS[single[2].toLowerCase()];
    return { size: value * mult, unit, family, source: single[0] };
  }

  const packOf = s.match(PACK_OF_RE);
  if (packOf) {
    return {
      size: Number.parseFloat(packOf[1]),
      unit: 'piece',
      family: 'count',
      source: packOf[0],
    };
  }

  return null;
}

/**
 * Build a pack from an adapter's structured fields, falling back to the name.
 * Adapters return packSize/packUnit; both may be missing on messy listings.
 */
export function packFromProduct(product) {
  if (product.packSize != null && product.packUnit) {
    const entry = UNITS[String(product.packUnit).toLowerCase()];
    if (entry) {
      const [unit, mult, family] = entry;
      return {
        size: Number(product.packSize) * mult,
        unit,
        family,
        source: `${product.packSize}${product.packUnit}`,
      };
    }
  }
  return parsePack(product.name);
}

// Words that carry no identifying signal.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'with', 'and', 'for', 'in', 'pack', 'packet',
  'combo', 'value', 'fresh', 'premium', 'special', 'new', 'best',
]);

/**
 * Variant tokens change what the product *is*, not just its size.
 * Disagreement here is a strong signal these are different products.
 */
const VARIANT_TOKENS = [
  'toned', 'double', 'full', 'cream', 'skimmed', 'slim',
  'diet', 'zero', 'sugarfree', 'unsweetened', 'sweetened',
  'salted', 'unsalted', 'plain',
  'brown', 'white', 'multigrain', 'wholewheat', 'maida',
  'spicy', 'masala', 'classic', 'original', 'tandoori', 'peri',
  'organic', 'refined', 'raw', 'filtered',
  'dark', 'roasted',
];

/**
 * Common Indian grocery brands. The brand is the single strongest identity
 * signal: asking for "amul butter" and being handed Mother Dairy is not a
 * near-miss, it's the wrong product. Multi-word brands are matched as phrases.
 */
const BRANDS = [
  'amul', 'mother dairy', 'nestle', 'britannia', 'parle', 'itc', 'aashirvaad',
  'fortune', 'saffola', 'tata', 'dabur', 'patanjali', 'haldiram', 'haldirams',
  'maggi', 'kelloggs', 'quaker', 'bingo', 'lays', 'kurkure', 'cadbury',
  'tropicana', 'real', 'paperboat', 'bisleri', 'kinley', 'coca', 'pepsi',
  'surf', 'ariel', 'vim', 'harpic', 'dettol', 'lifebuoy', 'colgate',
  'nandini', 'heritage', 'gowardhan', 'govardhan', 'verka', 'nova',
  'bonn', 'harvest', 'modern', 'english oven', 'wibs',
  'catch', 'everest', 'mdh', 'daawat', 'india gate', 'kohinoor',
  'epigamia', 'yakult', 'danone', 'milky mist', 'id', 'akshayakalpa',
];

/**
 * Food categories. These are what a thing *is*. If the product carries a
 * category the query never mentioned, it's a different product however many
 * words match: "Amul Butter Cookies" is not butter, and "Milk Chocolate" is
 * not milk. Presence-anywhere matching cannot catch this — you have to compare
 * the category sets.
 */
const CATEGORY_TOKENS = [
  // NOTE: words that are variants rather than categories ("cream" as in full
  // cream milk, "masala" as in masala noodles) belong in VARIANT_TOKENS, not
  // here — listing them twice makes every flavour look like a different food.
  'butter', 'ghee', 'cheese', 'paneer', 'curd', 'dahi', 'yogurt', 'yoghurt',
  'milk', 'lassi', 'buttermilk', 'shake',
  'cookies', 'cookie', 'biscuit', 'biscuits', 'cake', 'rusk', 'bread', 'bun',
  'chocolate', 'candy', 'wafer', 'chips', 'namkeen', 'mixture',
  'oil', 'vanaspati',
  'atta', 'flour', 'maida', 'rice', 'dal', 'pulses', 'sugar', 'salt',
  'noodles', 'pasta', 'vermicelli', 'poha',
  'juice', 'drink', 'soda', 'water', 'tea', 'coffee',
  'egg', 'eggs', 'chicken', 'mutton', 'fish',
  'soap', 'shampoo', 'detergent', 'toothpaste', 'sanitizer',
  'spread', 'jam', 'ketchup', 'sauce', 'pickle', 'honey',
  'seeds', 'nuts', 'cashew', 'almond', 'raisin',
];

function categoriesIn(tokens) {
  return new Set(tokens.filter((t) => CATEGORY_TOKENS.includes(t)));
}

/** Find brand names present in a token list (phrases allowed). */
function brandsIn(tokens) {
  const joined = ' ' + tokens.join(' ') + ' ';
  const found = new Set();
  for (const b of BRANDS) {
    if (joined.includes(' ' + b + ' ')) found.add(b);
  }
  return found;
}

function tokenize(text) {
  const raw = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');

  const tokens = raw
    // strip embedded pack sizes so "500ml" doesn't count as a name token
    .replace(new RegExp(`\\b\\d+(?:\\.\\d+)?\\s*(?:${UNIT_ALTERNATION})\\b`, 'gi'), ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t) && !/^\d+$/.test(t));

  if (tokens.length > 0) return tokens;

  // "6 eggs" strips to nothing: the count is a number and "eggs" is a unit.
  // Falling back to the un-stripped words keeps the item comparable instead of
  // reporting "no comparable tokens" on a perfectly ordinary basket line.
  return raw.split(/\s+/).filter((t) => t && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function variantsIn(tokens) {
  return new Set(tokens.filter((t) => VARIANT_TOKENS.includes(t)));
}

/**
 * Score how confident we are that `productName` is the thing `query` asked for.
 *
 * @returns {{ score: number, refused: boolean, reason: string }}
 *   score 0..1. `refused` means we will not compare these at any price.
 */
export function matchConfidence(query, product) {
  const qTokens = tokenize(query);
  const pTokens = tokenize(product.name);

  if (qTokens.length === 0 || pTokens.length === 0) {
    return { score: 0, refused: true, reason: 'no comparable tokens' };
  }

  const qPack = parsePack(query);
  const pPack = packFromProduct(product);

  // Hard refusal: a mass is never comparable to a volume. 500g of butter and
  // 500ml of oil have no shared denominator, so price-per-unit is meaningless.
  if (qPack && pPack && qPack.family !== pPack.family) {
    return {
      score: 0,
      refused: true,
      reason: `unit family mismatch (${qPack.family} vs ${pPack.family})`,
    };
  }

  // Token overlap, weighted toward covering what the user actually asked for.
  const qSet = new Set(qTokens);
  const pSet = new Set(pTokens);
  const shared = [...qSet].filter((t) => pSet.has(t));
  const coverage = shared.length / qSet.size; // how much of the query is present
  const precision = shared.length / pSet.size; // how much of the product is query
  const overlap = 0.75 * coverage + 0.25 * precision;

  // Variant agreement. Only penalize variants the *query* named — a product
  // carrying extra descriptors it didn't ask about is fine.
  const qVariants = variantsIn(qTokens);
  let variantAgreement = 1;
  if (qVariants.size > 0) {
    const pVariants = variantsIn(pTokens);
    const matched = [...qVariants].filter((v) => pVariants.has(v)).length;
    variantAgreement = matched / qVariants.size;
  }

  // Having a parseable pack on both sides is itself a small confidence signal.
  const packSignal = qPack && pPack ? 1 : qPack || pPack ? 0.5 : 0.25;

  let score = 0.6 * overlap + 0.3 * variantAgreement + 0.1 * packSignal;

  // Brand is identity, not a detail. If the query named a brand and the
  // product is a *different* named brand, this is the wrong product however
  // well the rest of the words line up.
  const qBrands = brandsIn(qTokens);
  const pBrands = brandsIn(pTokens);
  let brandNote = null;

  if (qBrands.size > 0) {
    const shared = [...qBrands].filter((b) => pBrands.has(b));
    if (shared.length === 0) {
      if (pBrands.size > 0) {
        // Named a different brand — disqualifying.
        return {
          score: 0,
          refused: true,
          reason: `brand mismatch (wanted ${[...qBrands].join('/')}, got ${[...pBrands].join('/')})`,
        };
      }
      // Unbranded or unrecognised brand: heavy penalty, not a refusal.
      score *= 0.5;
      brandNote = `brand "${[...qBrands].join('/')}" not found in name`;
    }
  }

  // The head noun is what you're actually buying. Strip brand and variant
  // words from the query and whatever remains ("butter", "milk", "bread") must
  // appear in the product name — otherwise "amul butter" happily matches
  // "Amul Masti Dahi Cup", which is the right brand and the wrong food.
  const coreTokens = qTokens.filter(
    (t) => !VARIANT_TOKENS.includes(t) && ![...qBrands].some((b) => b.split(' ').includes(t)),
  );
  if (coreTokens.length > 0 && !coreTokens.some((t) => pSet.has(t))) {
    return {
      score: 0,
      refused: true,
      reason: `product type mismatch (no "${coreTokens.join('/')}" in name)`,
    };
  }

  // Category containment. The product may not introduce a food category the
  // query never asked for — that's how "amul butter" ends up buying sixteen
  // packs of Amul Butter Cookies, which contains the word "butter" and is
  // nonetheless not butter.
  const qCats = categoriesIn(qTokens);
  if (qCats.size > 0) {
    const extra = [...categoriesIn(pTokens)].filter((cat) => !qCats.has(cat));
    if (extra.length > 0) {
      return {
        score: 0,
        refused: true,
        reason: `different category (${extra.join(', ')})`,
      };
    }
  }

  let reason = 'ok';
  if (brandNote) {
    reason = brandNote;
  } else if (variantAgreement < 1) {
    const missing = [...qVariants].filter((v) => !variantsIn(pTokens).has(v));
    reason = `variant mismatch (missing: ${missing.join(', ')})`;
  } else if (coverage < 0.6) {
    reason = 'weak name overlap';
  }

  return { score: Number(score.toFixed(3)), refused: false, reason };
}

/** Default cut-off. Below this a match is reported but never silently totalled. */
export const CONFIDENCE_THRESHOLD = 0.55;

/**
 * Attach normalized pack, price-per-unit and confidence to a raw adapter row.
 */
export function annotate(query, product) {
  const pack = packFromProduct(product);
  const confidence = matchConfidence(query, product);
  const pricePerUnit =
    pack && pack.size > 0 && Number.isFinite(product.price)
      ? product.price / pack.size
      : null;

  return {
    ...product,
    pack,
    pricePerUnit,
    pricePerUnitLabel: pack ? `₹${(pricePerUnit * 100).toFixed(2)} / 100${pack.unit}` : null,
    confidence: confidence.score,
    confidenceReason: confidence.reason,
    refused: confidence.refused,
    confident: !confidence.refused && confidence.score >= CONFIDENCE_THRESHOLD,
  };
}
