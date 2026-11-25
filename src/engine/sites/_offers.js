/** Small helpers shared by the cart-offer readers (zepto-offers.js, instamart-offers.js). */

const num = (s) => Number(String(s).replace(/,/g, ''));

/** "Valid on orders above ₹99 only on Sundays" / "… discount on orders above ₹999" -> the order minimum, else null. */
export function minOrderFrom(text) {
  const m = /(?:above|over|of|from)\s*(?:₹|rs\.?)\s?([\d,]+)/i.exec(String(text ?? ''));
  return m ? num(m[1]) : null;
}

/** "Shop for ₹81 more to unlock" / "Add items worth ₹928 more to avail this offer." -> what the cart is short by, else null. */
export function shortfallFrom(text) {
  const m = /(?:shop for|worth)\s*(?:₹|rs\.?)\s?([\d,]+)\s*more/i.exec(String(text ?? ''));
  return m ? num(m[1]) : null;
}
