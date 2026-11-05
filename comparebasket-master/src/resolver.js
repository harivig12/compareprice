/**
 * Basket text -> structured lines. Deliberately dumb: regex, not a model.
 *
 * Accepts:
 *   amul taaza toned milk 500ml
 *   2x amul taaza toned milk 500ml
 *   2 x amul taaza toned milk 500ml
 *   3 maggi noodles
 */

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
 * @param {string} text
 * @returns {Array<{ raw: string, query: string, qty: number }>}
 */
export function resolveBasket(text) {
  return text
    .split(/\r?\n/)
    .map(parseLine)
    .filter((item) => item !== null);
}
