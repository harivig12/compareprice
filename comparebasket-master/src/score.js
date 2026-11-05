/**
 * Basket scoring: pick the best candidate per line, total per platform,
 * fold in fees, name a winner.
 *
 * The honesty rule: a platform that couldn't fulfil a line does NOT get a
 * cheaper basket for free. Its unfulfilled lines are counted and surfaced next
 * to the total, so a low number with holes in it can't masquerade as a win.
 */

import { annotate, CONFIDENCE_THRESHOLD, parsePack } from './normalize.js';
import { feesFor, loadFees } from './fees.js';

/**
 * How many packs you must actually buy to cover what was asked for.
 *
 * Without this, a 200g pack at ₹85 gets totalled against a 500g pack at ₹310
 * as though they were the same purchase. You cannot buy 2.5 packs of butter,
 * so we round up and charge for what lands in the basket.
 */
function packsNeeded(query, product) {
  const want = parsePack(query);
  const have = product.pack;
  if (!want || !have || want.family !== have.family || !(have.size > 0)) {
    return { packs: 1, covered: null, exact: true };
  }
  const packs = Math.max(1, Math.ceil(want.size / have.size - 1e-9));
  return {
    packs,
    covered: packs * have.size,
    exact: packs === 1 && Math.abs(have.size - want.size) < 1e-9,
  };
}

/**
 * Choose the best product for one basket line on one platform.
 * Preference order: in stock -> confident -> cheapest per unit -> cheapest.
 */
/** Buying a 20kg sack of onions to satisfy "onion 1kg" is technically the best
 *  price per unit and obviously not what was asked for. Anything more than this
 *  multiple of the requested size is only used when nothing sane exists. */
const OVERSIZE_FACTOR = 4;

export function pickBest(query, products) {
  const annotated = (products || []).map((p) => annotate(query, p));

  const inStock = annotated.filter((p) => p.inStock);
  const confident = inStock.filter((p) => p.confident);

  let pool = confident.length > 0 ? confident : inStock;
  if (pool.length === 0) {
    return {
      chosen: null,
      candidates: annotated,
      status: annotated.length === 0 ? 'no-results' : 'out-of-stock',
    };
  }

  // Drop wildly oversized packs when reasonable ones exist.
  const want = parsePack(query);
  if (want) {
    const sane = pool.filter(
      (p) => !p.pack || p.pack.family !== want.family || p.pack.size <= want.size * OVERSIZE_FACTOR,
    );
    if (sane.length > 0) pool = sane;
  }

  const sorted = [...pool].sort((a, b) => {
    // Prefer a comparable per-unit price; fall back to sticker price.
    if (a.pricePerUnit != null && b.pricePerUnit != null) {
      return a.pricePerUnit - b.pricePerUnit;
    }
    if (a.pricePerUnit != null) return -1;
    if (b.pricePerUnit != null) return 1;
    return a.price - b.price;
  });

  return {
    chosen: sorted[0],
    candidates: annotated,
    status: confident.length > 0 ? 'ok' : 'low-confidence',
  };
}

/**
 * Score one platform against the whole basket.
 *
 * @param {string} platform
 * @param {Array<{raw:string, query:string, qty:number}>} items
 * @param {Record<string, Array>} resultsByQuery  query -> adapter rows
 */
export function scorePlatform(platform, items, resultsByQuery, feeConfig) {
  const lines = [];
  let subtotal = 0;

  for (const item of items) {
    const products = resultsByQuery[item.query] || [];
    const { chosen, status } = pickBest(item.query, products);

    if (!chosen) {
      lines.push({
        query: item.query,
        qty: item.qty,
        status,
        product: null,
        lineTotal: null,
      });
      continue;
    }

    const { packs, covered, exact } = packsNeeded(item.query, chosen);
    const lineTotal = chosen.price * packs * item.qty;
    subtotal += lineTotal;

    lines.push({
      query: item.query,
      qty: item.qty,
      status,
      product: {
        name: chosen.name,
        price: chosen.price,
        mrp: chosen.mrp ?? null,
        packSize: chosen.pack?.size ?? null,
        packUnit: chosen.pack?.unit ?? null,
        packLabel: chosen.pack ? `${chosen.pack.size}${chosen.pack.unit}` : null,
        packs,
        covered,
        exactPack: exact,
        pricePerUnit: chosen.pricePerUnit,
        pricePerUnitLabel: chosen.pricePerUnitLabel,
        confidence: chosen.confidence,
        confidenceReason: chosen.confidenceReason,
        url: chosen.url,
      },
      lineTotal,
    });
  }

  const fulfilled = lines.filter((l) => l.lineTotal != null).length;
  const missing = lines.filter((l) => l.lineTotal == null);
  const lowConfidence = lines.filter((l) => l.status === 'low-confidence');

  const fees = feesFor(platform, subtotal, feeConfig);
  // With no fee config the total is goods only. Callers surface `fees.known`
  // so this is never mistaken for a delivered price.
  const total = subtotal + fees.total;

  return {
    platform,
    lines,
    subtotal: round2(subtotal),
    fees,
    total: round2(total),
    fulfilledLines: fulfilled,
    totalLines: items.length,
    complete: fulfilled === items.length,
    missing: missing.map((l) => ({ query: l.query, status: l.status })),
    lowConfidence: lowConfidence.map((l) => ({
      query: l.query,
      name: l.product?.name,
      confidence: l.product?.confidence,
      reason: l.product?.confidenceReason,
    })),
  };
}

/**
 * Rank platforms and compute the saving.
 *
 * Winner is chosen among *complete* baskets when any exist — an incomplete
 * basket is cheaper for the wrong reason. If none are complete, we rank by
 * total but flag that the comparison is not like-for-like.
 */
export function rank(platformScores) {
  const scored = platformScores.filter((p) => p.fulfilledLines > 0);
  if (scored.length === 0) {
    return { winner: null, runnerUp: null, saving: 0, likeForLike: false, ranked: [] };
  }

  const complete = scored.filter((p) => p.complete);

  if (complete.length > 0) {
    const ranked = [...complete].sort((a, b) => a.total - b.total);
    return {
      winner: ranked[0],
      runnerUp: ranked[1] ?? null,
      saving: ranked[1] ? round2(ranked[1].total - ranked[0].total) : 0,
      likeForLike: true,
      comparedOn: 'full basket',
      ranked,
      allScores: [...scored].sort((a, b) => a.total - b.total),
    };
  }

  // Nobody fulfilled everything. Ranking on raw totals would hand the win to
  // whichever platform failed to find the most items — the cheapest basket is
  // the emptiest one. Compare only the lines every platform actually priced.
  const common = scored[0].lines
    .filter((l) => scored.every((p) => p.lines.find((x) => x.query === l.query)?.lineTotal != null))
    .map((l) => l.query);

  const feeConfig = loadFees();
  const withSubset = scored.map((p) => {
    const goods = common.reduce(
      (sum, q) => sum + (p.lines.find((l) => l.query === q)?.lineTotal ?? 0),
      0,
    );
    const fees = feesFor(p.platform, goods, feeConfig);
    return { ...p, subsetGoods: round2(goods), subsetTotal: round2(goods + fees.total) };
  });

  const ranked = [...withSubset].sort((a, b) => a.subsetTotal - b.subsetTotal);
  const winner = ranked[0];
  const runnerUp = ranked[1] ?? null;

  // Cheapest-on-the-overlap is only half the story. A platform that stocks
  // eight of your twelve items is cheap partly because you still have to go
  // somewhere else for the other four. Surface the best-coverage platform so
  // that trade-off is visible instead of buried in a "8/12" cell.
  const byCoverage = [...withSubset].sort(
    (a, b) => b.fulfilledLines - a.fulfilledLines || a.total - b.total,
  );
  const bestCoverage = byCoverage[0];
  const coverageWarning =
    bestCoverage.fulfilledLines > winner.fulfilledLines
      ? {
          platform: bestCoverage.platform,
          fulfilledLines: bestCoverage.fulfilledLines,
          totalLines: bestCoverage.totalLines,
          total: bestCoverage.total,
          winnerMissing: winner.totalLines - winner.fulfilledLines,
        }
      : null;

  return {
    winner,
    runnerUp,
    // Saving is on the common subset, so it is a true like-for-like figure
    // even though neither basket is complete.
    saving: runnerUp ? round2(runnerUp.subsetTotal - winner.subsetTotal) : 0,
    likeForLike: false,
    comparedOn: `${common.length} of ${scored[0].totalLines} items available everywhere`,
    commonItems: common,
    coverageWarning,
    ranked,
    allScores: [...withSubset].sort((a, b) => a.total - b.total),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export { CONFIDENCE_THRESHOLD };
