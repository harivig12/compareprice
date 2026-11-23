/**
 * Basket text -> structured lines. Deliberately dumb: regex, not a model.
 *
 * Accepts:
 *   amul taaza toned milk 500ml
 *   2x amul taaza toned milk 500ml
 *   2 x amul taaza toned milk 500ml
 *   3 maggi noodles
 *
 * Each line's product is then named by its catalogue canonical tag
 * (src/catalog.js): "kismis 500g" is searched, matched and saved as
 * "raisins 500g", and two lines naming the same product are one line.
 */
import { canonicalQuery, describeQuery } from './catalog.js';

// Unit words that must NOT be mistaken for a leading quantity.
// "500 ml milk" is a pack size, not "500 of milk".
const UNIT_WORDS =
  /^(?:g|gm|gms|gram|grams|kg|kgs|kilo|kilos|kilogram|kilograms|ml|mls|l|lt|ltr|ltrs|litre|litres|liter|liters|pc|pcs|piece|pieces|pack|packs|packet|packets|dozen|egg|eggs)\b/i;

// A bare leading integer only reads as a quantity below this.
// Nobody orders 40 of anything in a demo basket; 400 is a pack size.
const MAX_BARE_QTY = 20;

/**
 * @param {string} line
 * @returns {{ raw: string, query: string, qty: number } | null}
 */
export function parseLine(line) {
  const raw = line.trim();
  if (!raw || raw.startsWith('#')) return null;

  // Explicit multiplier: "2x foo", "2 x foo", "2 × foo", "2 * foo".
  // Always a quantity, whatever the number.
  const explicit = raw.match(/^(\d+)\s*[x×*]\s*(.+)$/i);
  if (explicit) {
    const qty = Number.parseInt(explicit[1], 10);
    const query = explicit[2].trim();
    if (qty > 0 && query) return { raw, query, qty };
  }

  // Bare leading integer: "3 maggi noodles". Only when small and not a unit.
  const bare = raw.match(/^(\d+)\s+(.+)$/);
  if (bare) {
    const qty = Number.parseInt(bare[1], 10);
    const rest = bare[2].trim();
    if (qty > 0 && qty <= MAX_BARE_QTY && rest && !UNIT_WORDS.test(rest)) {
      return { raw, query: rest, qty };
    }
  }

  return { raw, query: raw, qty: 1 };
}

/**
 * A parsed line with its product named canonically and its catalogue facets.
 *   typed     what the user wrote, when it differs from `query`
 *   product   { id, name, category, brand } when the line is a catalogue product
 */
export function canonicalLine(item) {
  const query = canonicalQuery(item.query);
  const facet = describeQuery(query);
  const out = { ...item, query };
  if (query !== item.query) out.typed = item.query;
  if (facet) out.product = { id: facet.id, name: facet.name, category: facet.category, brand: facet.brand };
  return out;
}

/**
 * @param {string} text
 * @returns {Array<{ raw: string, query: string, qty: number, typed?: string, product?: object }>}
 */
export function resolveBasket(text) {
  const lines = text
    .split(/\r?\n/)
    .map(parseLine)
    .filter((item) => item !== null)
    .map(canonicalLine);

  // One umbrella per product: "kismis" and "raisins" on two lines are one
  // line with both quantities, not two rows that split the result.
  const merged = [];
  const byKey = new Map();
  for (const line of lines) {
    const key = line.query.toLowerCase().replace(/\s+/g, ' ').replace(/(\d)\s+([a-z])/g, '$1$2'); // "500 g" = "500g"
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, line);
      merged.push(line);
      continue;
    }
    prev.qty += line.qty;
    prev.raw = `${prev.raw} + ${line.raw}`;
    const typed = [...(prev.typed ? prev.typed.split(', ') : []), line.typed ?? line.query];
    const distinct = typed.filter((t, i) => typed.indexOf(t) === i && t !== prev.query);
    if (distinct.length) prev.typed = distinct.join(', ');
  }
  return merged;
}
