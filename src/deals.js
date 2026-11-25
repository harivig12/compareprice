/**
 * Deals: products sold at a deep discount off MRP (default 80%+), like
 * Milkbasket's ₹1 tomato (MRP ₹78). Shown in their own section, never
 * counted in a basket total. Spec: docs/superpowers/specs/2026-11-19-accounts-deals-design.md
 */

export const DEFAULT_MIN_DISCOUNT_PCT = 80;

/**
 * What an offer's terms add beyond its title and order minimum ("only on Sundays"), or null.
 * "Valid on orders above ₹99" is the minimum's own column; a description that only restates
 * the title (most coupons do) adds nothing.
 */
export function offerExtra({ title, description }) {
  const d = String(description ?? '').replace(/^Valid on (orders|transactions) above\s*(₹|rs\.?)\s?[\d,]+\.?\s*/i, '').trim();
  if (!d) return null;
  const words = (s) => new Set(String(s ?? '').toLowerCase().match(/[a-z0-9₹%]+/g) ?? []);
  const t = words(title);
  const x = words(d);
  const shared = [...t].filter((w) => x.has(w)).length;
  return t.size && shared / t.size >= 0.8 ? null : d;
}

/** Percent off MRP, rounded to one decimal; null when MRP can't say. */
export function discountPct(price, mrp) {
  const p = Number(price);
  const m = Number(mrp);
  if (!Number.isFinite(p) || !Number.isFinite(m) || m <= 0 || p < 0 || p >= m) return null;
  return Math.round((1 - p / m) * 1000) / 10;
}

/** Is this row a deal at `minPct` off? A missing, zero or lower MRP never is. */
export function isDeal(row, minPct = DEFAULT_MIN_DISCOUNT_PCT) {
  if (discountPct(row?.price, row?.mrp) == null) return false;
  // Compare unrounded: 79.96% off is not an 80% deal.
  return (1 - Number(row.price) / Number(row.mrp)) * 100 >= minPct - 1e-9;
}

const packOf = (row) => row.pack ?? (row.packSize ? `${row.packSize}${row.packUnit ?? ''}` : null);

/**
 * @param {object} row  an engine row { name, price, mrp, packSize, packUnit, url, maxQty? }
 * @returns {{ site, account, product, pack, price, mrp, pct, conditions, url, seenAt, source }}
 */
export function toDeal(row, { site, account = 'main', source = 'search', seenAt = new Date().toISOString(), conditions = null } = {}) {
  // The check's own conditions, then the row's (BigBasket: its storefront), then its buy limit.
  const cond = { ...(conditions ?? {}), ...(row.conditions ?? {}), ...(row.maxQty ? { maxQty: row.maxQty } : {}) };
  return {
    site,
    account,
    product: String(row.name ?? '').trim(),
    pack: packOf(row),
    price: Number(row.price),
    mrp: Number(row.mrp),
    pct: discountPct(row.price, row.mrp),
    conditions: Object.keys(cond).length ? cond : null,
    url: row.url ?? null,
    seenAt,
    source,
  };
}

/**
 * Deals among a site's raw search rows (every candidate, including ones the
 * price check removed): `{ [query]: Row[] }` -> Deal[], one per product.
 */
export function dealsFromRows(resultsByQuery, { site, minPct = DEFAULT_MIN_DISCOUNT_PCT, seenAt } = {}) {
  const seen = new Map();
  for (const rows of Object.values(resultsByQuery ?? {})) {
    for (const row of rows ?? []) {
      if (!row || row.inStock === false || !isDeal(row, minPct)) continue;
      const account = row.account ?? 'main';
      const key = `${account}|${row.name}|${packOf(row)}`;
      if (!seen.has(key)) seen.set(key, toDeal(row, { site, account, seenAt, source: 'search' }));
    }
  }
  return [...seen.values()];
}
