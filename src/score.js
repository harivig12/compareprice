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
import { groupOf, namedGroups } from './categories.js';

/**
 * How many packs you must actually buy to cover what was asked for.
 *
 * Without this, a 200g pack at ₹85 gets totalled against a 500g pack at ₹310
 * as though they were the same purchase. You cannot buy 2.5 packs of butter,
 * so we round up and charge for what lands in the basket.
 */
const APPROX_TOLERANCE = 0.08;

function packsNeeded(query, product, qty = 1) {
  const want = parsePack(query);
  const have = product.pack;
  if (!want || !have || want.family !== have.family || !(have.size > 0)) {
    // No comparable size: one pack per unit asked for.
    return { packs: qty, covered: null, exact: true, need: null };
  }
  // Quantity folds into the amount needed: 2 × 500 ml is 1 L, so one 1 L pack
  // (not two) — and 2 × butter 500 g from 200 g packs is 5 packs, not 6.
  const need = want.size * qty;
  // Produce is sold by approximate weight ("Approx. 900 g – 1000 g"): a pack within ~7% under counts as covering.
  const packs = Math.max(1, Math.ceil(need / have.size - APPROX_TOLERANCE));
  return {
    packs,
    covered: packs * have.size,
    exact: packs === qty && Math.abs(have.size - want.size) < 1e-9,
    need,
  };
}

/**
 * Choose the best product for one basket line on one platform.
 * Preference order: in stock -> confident -> cheapest per unit -> cheapest.
 */
/**
 * A pack that covers more than this multiple of what was asked for is a
 * different purchase: 12 eggs for "6 eggs", a 5 L can for "1L", a 2 kg bag
 * for "1kg". It is shown (with its rate) but never totalled or ranked.
 */
export const BIGGER_PACK_FACTOR = 1.5;

/**
 * @param {object} [prefs]  { category?: the site category this line usually
 *   lands in (learned from saved prices), aiGroups?: Map title -> AI group }
 */
export function pickBest(query, products, qty = 1, prefs = {}) {
  const annotated = (products || []).map((p) => annotate(query, p));
  // A generic line gets the raw product first (2026-11-20): sweets and pooja
  // items are refused unless the line names them; packaged foods, and what an
  // AI label demotes, only come after staples.
  const named = namedGroups(query);
  const groupFor = (p) => groupOf({ name: p.name, category: p.category, aiGroup: prefs.aiGroups?.get(String(p.name ?? '').trim()) });
  for (const p of annotated) {
    const g = groupFor(p);
    p.group = g.group;
    p.groupSource = g.source;
    if (g.refusable && !named.has(g.group)) {
      p.refused = true;
      p.confident = false;
      p.confidenceReason = `different kind (${g.group}, from its ${g.source})`;
    }
  }
  // `prefs.lineGroup`: what the line's own saved products mostly are ("honey" is
  // labelled packaged everywhere): that kind is normal for this line, not demoted.
  // Only ordering: it never lets a sweet or pooja item through.
  // An AI label demotes only on a line known to be a staple (its saved products
  // are mostly labelled staple): the labeller is inconsistent within a kind
  // (one brown bread "packaged", another "staple"), so elsewhere it is ignored.
  // And never a product already saved for this line (`prefs.saved`): it was
  // picked before and not ✕'d, which beats a label.
  const normal = (p) => p.group === 'staple' || named.has(p.group) || p.group === prefs.lineGroup
    || (p.groupSource === 'ai' && (prefs.lineGroup !== 'staple' || prefs.saved?.has(String(p.name ?? '').trim())));
  const tierOf = (p) => (prefs.category && p.category === prefs.category ? 0 : normal(p) ? 1 : 2);
  const bestTier = (list) => {
    const t = Math.min(...list.map(tierOf));
    return list.filter((p) => tierOf(p) === t);
  };

  const inStock = annotated.filter((p) => p.inStock);
  // When the query names a size, a product whose size we can't read can't be
  // priced fairly (a "whole bunch" at ₹18 is not 1 kg): it is only a weak match.
  const wantSize = parsePack(query);
  const sizeKnown = (p) => !wantSize || (p.pack && p.pack.family === wantSize.family);
  const confident = inStock.filter((p) => p.confident && sizeKnown(p));
  // A refused candidate (different product, brand, category or unit family —
  // e.g. Tata Salt for "6 eggs") is never a fallback, not even a flagged one.
  const plausible = inStock.filter((p) => !p.refused);

  let pool = confident.length > 0 ? confident : plausible;
  if (pool.length === 0) {
    return {
      chosen: null,
      candidates: annotated,
      status: annotated.length === 0 ? 'no-results' : inStock.length === 0 ? 'out-of-stock' : 'no-match',
    };
  }

  const status = confident.length > 0 ? 'ok' : 'low-confidence';
  const want = parsePack(query);
  const need = want ? want.size * qty : null;
  const covers = (p) => (need && p.pack && p.pack.family === want.family && p.pack.size > 0 ? Math.ceil(need / p.pack.size - APPROX_TOLERANCE) * p.pack.size : null);
  const fits = (p) => {
    const c = covers(p);
    return c == null || c <= need * BIGGER_PACK_FACTOR + 1e-9;
  };

  const byValue = (a, b) => {
    // What you would actually pay to get the amount asked for, then the rate.
    if (need) {
      const d = a.price * packsNeeded(query, a, qty).packs - b.price * packsNeeded(query, b, qty).packs;
      if (Math.abs(d) > 0.005) return d;
    }
    if (a.pricePerUnit != null && b.pricePerUnit != null) return a.pricePerUnit - b.pricePerUnit;
    if (a.pricePerUnit != null) return -1;
    if (b.pricePerUnit != null) return 1;
    return a.price - b.price;
  };

  const sane = pool.filter(fits);
  if (sane.length === 0) {
    // Only bigger packs exist: show the cheapest-per-unit one, don't count it.
    const bigger = [...bestTier(pool)].sort((a, b) => (a.pricePerUnit ?? Infinity) - (b.pricePerUnit ?? Infinity))[0];
    return { chosen: bigger, candidates: annotated, status: 'bigger-pack' };
  }
  return { chosen: [...bestTier(sane)].sort(byValue)[0], candidates: annotated, status };
}

/**
 * Score one platform against the whole basket.
 *
 * @param {string} platform
 * @param {Array<{raw:string, query:string, qty:number}>} items
 * @param {Record<string, Array>} resultsByQuery  query -> adapter rows
 */
/**
 * @param {object} [opts]  { prefs?: query -> { category }, aiGroups?: Map } (see pickBest)
 */
export function scorePlatform(platform, items, resultsByQuery, feeConfig, opts = {}) {
  const lines = [];
  let subtotal = 0;

  for (const item of items) {
    const products = resultsByQuery[item.query] || [];
    const { chosen, status } = pickBest(item.query, products, item.qty, { ...(opts.prefs?.[item.query] ?? {}), aiGroups: opts.aiGroups });

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

    const { packs, covered, exact } = packsNeeded(item.query, chosen, item.qty);
    const product = {
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
      // Which account showed this price (sites searched per account, e.g. Instamart).
      ...(chosen.account ? { account: chosen.account } : {}),
      url: chosen.url,
      category: chosen.category ?? null,
    };
    if (status === 'bigger-pack') {
      // Visible, with its rate, but not part of the basket total.
      lines.push({ query: item.query, qty: item.qty, status, product, lineTotal: null });
      continue;
    }
    // `packs` already includes qty, so the line is simply price × packs.
    const lineTotal = chosen.price * packs;
    subtotal += lineTotal;

    lines.push({
      query: item.query,
      qty: item.qty,
      status,
      product,
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

  // Nobody fulfilled everything. If some platforms fulfilled items,
  // compare the common items if any overlap exists; otherwise rank by fulfilled value/totals.
  const common = scored[0].lines
    .filter((l) => scored.every((p) => p.lines.find((x) => x.query === l.query)?.lineTotal != null))
    .map((l) => l.query);

  const feeConfig = loadFees();

  if (common.length > 0) {
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
      saving: runnerUp ? round2(runnerUp.subsetTotal - winner.subsetTotal) : 0,
      likeForLike: false,
      comparedOn: `${common.length} of ${scored[0].totalLines} items available everywhere`,
      commonItems: common,
      coverageWarning,
      ranked,
      allScores: [...withSubset].sort((a, b) => a.total - b.total),
    };
  }

  // Fallback when common.length === 0: rank by highest coverage, then lowest total.
  // Still surface a winner and all platform columns so the user sees results!
  const byCoverage = [...scored].sort(
    (a, b) => b.fulfilledLines - a.fulfilledLines || a.total - b.total,
  );
  const winner = byCoverage[0];
  const runnerUp = byCoverage[1] ?? null;

  return {
    winner,
    runnerUp,
    saving: 0,
    likeForLike: false,
    comparedOn: 'best available coverage (no single item stocked by all platforms)',
    commonItems: [],
    coverageWarning: null,
    ranked: byCoverage,
    allScores: [...scored].sort((a, b) => a.total - b.total),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export { CONFIDENCE_THRESHOLD };
