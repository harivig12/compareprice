/**
 * compareBasket() — the single entry point every surface calls.
 *
 * CLI, MCP server, web UI and the scheduled job queue all render the object
 * this returns. Nothing computes a total twice; if two surfaces disagree,
 * that's a bug here, not a formatting difference there.
 */

import { resolveBasket } from './resolver.js';
import { searchAll, PLATFORMS, ALL_PLATFORMS, selectBackend } from './platforms.js';
import { scorePlatform, rank } from './score.js';
import { dropOutliers } from './pricecheck.js';
import { CONFIDENCE_THRESHOLD } from './normalize.js';
import { FEES, loadFees, allFeesKnown } from './fees.js';
import { loadConfig } from './config.js';
import { getLimiter } from './limits.js';
import { SITES } from './engine/sites/index.js';

/** Display pincode when config has none (config.location.pincode wins). */
export const DEFAULT_PINCODE = '600045';

const label = (p) => SITES[p]?.label ?? FEES[p]?.label ?? p;

/**
 * Progress events (engine and legacy backends alike):
 *   { type:'site-start', site, total }
 *   { type:'query', site, query, index, total }        index is 1-based
 *   { type:'retry', site, query, kind, message }
 *   { type:'fallback', site, query }
 *   { type:'site-done', site, ok, error? }
 *
 * @param {object} opts
 * @param {string|string[]} opts.items      basket text, or pre-split lines
 * @param {string[]} [opts.platforms]       defaults to config.sites
 * @param {(e: object) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.pool]              engine BrowserPool (tests inject a fake)
 * @param {object} [opts.config]            defaults to loadConfig()
 * @param {Function} [opts.search]          engine runSearch (tests inject a fake)
 * @param {boolean} [opts.cached]           history-first: build results from the
 *                                          store's last record per item and site,
 *                                          without contacting any site
 * @param {object} [opts.store]             required when cached (src/store.js)
 */
export async function compareBasket({
  items,
  pincode,
  address,
  platforms,
  onProgress,
  signal,
  pool,
  config,
  search,
  cached = false,
  store,
} = {}) {
  const cfg = config ?? loadConfig();
  const text = Array.isArray(items) ? items.join('\n') : String(items ?? '');
  const basket = resolveBasket(text);

  if (basket.length === 0) {
    throw new Error('Basket is empty — give me at least one item, one per line.');
  }

  const requested = platforms?.length ? platforms : cfg.sites?.length ? cfg.sites : PLATFORMS;
  const unknown = requested.filter((p) => !ALL_PLATFORMS.includes(p));
  if (unknown.length) throw new Error(`Unknown platform(s): ${unknown.join(', ')}. Available: ${ALL_PLATFORMS.join(', ')}`);
  const active = requested;

  if (cached && !store) throw new Error('cached comparison needs the history store');
  const backend = cached ? 'history' : search || pool ? 'engine' : await selectBackend();
  const startedAt = Date.now();
  const queries = [...new Set(basket.map((i) => i.query))];

  let platformResults;
  const cachedAt = {}; // site -> query -> ISO time of the stored record
  if (cached) {
    platformResults = active.map((site) => {
      const resultsByQuery = {};
      cachedAt[site] = {};
      for (const query of queries) {
        const row = store.latestFor(query, site);
        resultsByQuery[query] = row ? [row] : [];
        if (row) cachedAt[site][query] = row.seenAt;
      }
      return { platform: site, available: true, error: null, errorKind: null, partialFailures: [], failures: [], resultsByQuery };
    });
  } else if (backend === 'engine') {
    const runSearch = search ?? (await import('./engine/run.js')).runSearch;
    const thePool = pool ?? (await import('./engine/pool.js')).getPool({ location: cfg.location });
    platformResults = await runSearch({ sites: active, queries, pool: thePool, onProgress, signal, limiter: getLimiter(cfg.limits) });
  } else {
    // Legacy backends report (platform, query); translate to event objects.
    const counters = {};
    platformResults = await searchAll(queries, {
      platforms: active,
      backend,
      signal,
      onProgress: (p, q) => {
        counters[p] = (counters[p] ?? 0) + 1;
        onProgress?.({ type: 'query', site: p, query: q, index: counters[p], total: queries.length });
      },
    });
  }

  // Read the user's fee config once, not per platform per line.
  const feeConfig = loadFees();

  const scores = [];
  const unavailable = [];

  // Price check: drop products whose price per unit is far from what the
  // other sites charge, and let each site fall back to its next candidate.
  const { filtered, dropped } = dropOutliers(
    basket,
    Object.fromEntries(platformResults.filter((r) => r.available).map((r) => [r.platform, r.resultsByQuery || {}])),
  );

  for (const result of platformResults) {
    const scored = scorePlatform(result.platform, basket, filtered[result.platform] ?? result.resultsByQuery ?? {}, feeConfig);
    for (const line of scored.lines) {
      const d = dropped[result.platform]?.[line.query];
      if (!d?.length) continue;
      line.dropped = d;
      if (line.lineTotal == null && line.status !== 'bigger-pack') line.status = 'suspect';
    }
    scored.label = label(result.platform);
    if (result.failures?.length) scored.failures = result.failures;
    if (!result.available) {
      unavailable.push({ platform: result.platform, label: scored.label, error: result.error, errorKind: result.errorKind ?? null });
      scored.error = result.error;
      scored.errorKind = result.errorKind ?? null;
      scored.failed = true;
    } else if (result.partialFailures?.length) {
      scored.partialFailures = result.partialFailures;
    }
    scores.push(scored);
  }

  const uncached = [];
  const seen = [];
  if (cached) {
    for (const p of scores) {
      for (const line of p.lines) {
        const at = cachedAt[p.platform]?.[line.query];
        if (at) {
          line.cachedAt = at;
          seen.push(at);
        } else {
          line.status = 'not-cached';
          uncached.push({ platform: p.platform, query: line.query });
        }
      }
      if (p.lines.every((l) => l.status === 'not-cached')) p.notCached = true;
    }
    seen.sort();
  }

  const ranking = rank(scores);
  const ranked = ranking.allScores ?? [];
  // Failed platforms stay in the table (with their error) after the ranked ones.
  const shown = [...ranked, ...scores.filter((s) => !ranked.some((r) => r.platform === s.platform))];

  const brief = (p) =>
    p
      ? { platform: p.platform, total: p.total, subsetTotal: p.subsetTotal ?? null, label: label(p.platform) }
      : null;

  return {
    pincode: pincode || cfg.location?.pincode || DEFAULT_PINCODE,
    address: address || cfg.location?.address || '',
    locationLabel: cfg.location?.label || '',
    backend,
    source: cached ? 'history' : 'live',
    ...(cached ? { cachedRange: seen.length ? { oldest: seen[0], newest: seen.at(-1) } : null, uncached } : {}),
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    basket,
    labels: Object.fromEntries(active.map((p) => [p, label(p)])),
    platforms: shown,
    unavailable,
    winner: brief(ranking.winner),
    runnerUp: brief(ranking.runnerUp),
    saving: ranking.saving,
    likeForLike: ranking.likeForLike,
    comparedOn: ranking.comparedOn ?? null,
    commonItems: ranking.commonItems ?? null,
    coverageWarning: ranking.coverageWarning
      ? { ...ranking.coverageWarning, label: label(ranking.coverageWarning.platform) }
      : null,
    // Totals are goods-only unless the user configured fees. Surfaces let the
    // reader know which they're looking at; nothing invents a delivery charge.
    feesKnown: allFeesKnown(active, feeConfig),
    feesConfigured: active.filter((p) => Boolean(feeConfig[p])),
    feesMissing: active.filter((p) => !feeConfig[p]),
  };
}
