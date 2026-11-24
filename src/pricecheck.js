/**
 * Cross-site price sanity check.
 *
 * Matching and pack parsing can still let a wrong product through (a 100 g
 * block read as 1 kg, a spice combo for a vegetable, a bulk can for a litre).
 * Those show up as a price per unit far from what every other site charges
 * for the same item. This pass finds them *before* totals and ranking:
 *
 *   per item, take each site's chosen product and its price per unit; with at
 *   least MIN_SITES sites, a unit price below LOW × median or above HIGH ×
 *   median is dropped, and that site's next-best candidate is tried instead.
 *
 * Dropped products are returned so the UI can say what was left out and why.
 */
import { pickBest } from './score.js';

export const MIN_SITES = 3;
export const LOW = 0.4;
export const HIGH = 2.5;
const MAX_ROUNDS = 3;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const unitLabel = (p) => p.pricePerUnitLabel || '';

/**
 * @param {Array<{ query: string, qty: number }>} basket
 * @param {Record<string, Record<string, object[]>>} byPlatform platform -> query -> rows
 * @returns {{ filtered: Record<string, Record<string, object[]>>,
 *             dropped: Record<string, Record<string, Array<{ name: string, price: number, unit: string, reason: string }>>> }}
 */
export function dropOutliers(basket, byPlatform) {
  const filtered = {};
  const dropped = {};
  for (const platform of Object.keys(byPlatform)) {
    filtered[platform] = {};
    dropped[platform] = {};
    for (const [query, rows] of Object.entries(byPlatform[platform] ?? {})) filtered[platform][query] = [...rows];
  }

  for (const item of basket) {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const picks = [];
      for (const platform of Object.keys(filtered)) {
        const rows = filtered[platform][item.query] ?? [];
        const r = pickBest(item.query, rows, item.qty);
        if (r.status === 'ok' && r.chosen?.pricePerUnit != null) picks.push({ platform, chosen: r.chosen, unit: r.chosen.pricePerUnit });
      }
      if (picks.length < MIN_SITES) break;
      const mid = median(picks.map((x) => x.unit));
      const bad = picks.filter((x) => x.unit < mid * LOW || x.unit > mid * HIGH);
      if (bad.length === 0) break;
      for (const x of bad) {
        const rows = filtered[x.platform][item.query];
        // Rows are the raw adapter rows; match the annotated pick back by name+price.
        const i = rows.findIndex((row) => row.name === x.chosen.name && row.price === x.chosen.price);
        if (i < 0) continue;
        const [row] = rows.splice(i, 1);
        const ratio = x.unit / mid;
        (dropped[x.platform][item.query] ??= []).push({
          name: row.name,
          price: row.price,
          unit: unitLabel(x.chosen),
          reason: ratio < 1
            ? `price per unit ${unitLabel(x.chosen)} is only ${Math.round(ratio * 100)}% of the median across ${picks.length} sites`
            : `price per unit ${unitLabel(x.chosen)} is ${ratio.toFixed(1)}× the median across ${picks.length} sites`,
        });
      }
    }
  }
  return { filtered, dropped };
}
