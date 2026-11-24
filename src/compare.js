/**
 * compareBasket() — the single entry point every surface calls.
 *
 * CLI, MCP server, web UI and the scheduled job queue all render the object
 * this returns. Nothing computes a total twice; if two surfaces disagree,
 * that's a bug here, not a formatting difference there.
 */

import { resolveBasket } from './resolver.js';
import { searchAll, PLATFORMS, ALL_PLATFORMS, selectBackend } from './platforms.js';
import { scorePlatform, rank, pickBest } from './score.js';
import { dropOutliers } from './pricecheck.js';
import { dealsFromRows, DEFAULT_MIN_DISCOUNT_PCT } from './deals.js';
import { CONFIDENCE_THRESHOLD, withoutBrand, addsKind, annotate } from './normalize.js';
import { FEES, loadFees, allFeesKnown } from './fees.js';
import { loadConfig } from './config.js';
import { getLimiter } from './limits.js';
import { SITES } from './engine/sites/index.js';

/**
 * Search a per-account site again with each extra signed-in account and merge
 * the rows into `result` (mutated). A failing account is a partial failure
 * naming it; the other accounts' prices still count.
 */
export const ACCOUNT_GAP_MS = 20_000;

export async function searchExtraAccounts({ result, queries, accounts, poolSet, runSearch, onProgress, signal, limiter, accountGapMs = ACCOUNT_GAP_MS }) {
  const site = result.platform;
  const extras = accounts.signedIn(site).filter((a) => a.id !== 'main');
  if (!extras.length) return;
  result.perAccount = true;
  const tag = (rows, id) => (rows ?? []).map((r) => ({ ...r, account: r.account ?? id }));
  result.resultsByQuery = Object.fromEntries(Object.entries(result.resultsByQuery ?? {}).map(([q, rows]) => [q, tag(rows, 'main')]));
  for (const acc of extras) {
    if (signal?.aborted) throw new Error('Operation aborted');
    // Instamart rate-limits bursts from one IP: the next account's searches
    // (plus its warm-up) right after the main run got a 429 on the last item
    // (2026-11-19). Let the site breathe first.
    if (accountGapMs > 0) await new Promise((r) => setTimeout(r, accountGapMs));
    const who = `account "${acc.name}"`;
    let r;
    try {
      [r] = await poolSet.with(site, acc, (pool) => runSearch({
        sites: [site], queries, pool, signal, limiter,
        onProgress: (e) => onProgress?.({ ...e, account: acc.name }),
      }));
    } catch (e) {
      r = { available: false, error: e.message, failures: [{ query: queries[0], kind: e.kind ?? 'browser', message: e.message }], resultsByQuery: {} };
    }
    for (const q of queries) result.resultsByQuery[q] = [...(result.resultsByQuery[q] ?? []), ...tag(r.resultsByQuery?.[q], acc.id)];
    const fails = (r.failures ?? []).map((f) => ({ ...f, account: acc.id, message: `${f.message} (${who})` }));
    if (fails.length) {
      result.failures = [...(result.failures ?? []), ...fails];
      result.partialFailures = [...(result.partialFailures ?? []), ...fails.map((f) => `${f.query}: ${f.message}`)];
    }
    // The main account failed but this one answered: the site is available.
    if (!result.available && r.available) {
      result.available = true;
      result.partialFailures = [...(result.partialFailures ?? []), `${result.error} (account "Main")`];
      result.error = null;
      result.errorKind = null;
    }
  }
}

/** The "Others" column from entered prices, or null when none of the items has one. */
export function othersColumn(basket, store) {
  if (!store?.manualFor) return null;
  let any = false;
  const lines = basket.map((item) => {
    const m = store.manualFor(item.query);
    if (!m) return { query: item.query, qty: item.qty, status: 'not-cached', product: null, lineTotal: null };
    any = true;
    // The user's own entry is the product (no matching against the item).
    const a = annotate(item.query, m.row);
    return {
      query: item.query,
      qty: item.qty,
      status: 'ok',
      product: {
        name: m.row.name, price: m.row.price, mrp: null,
        packSize: a.pack?.size ?? m.row.packSize, packUnit: a.pack?.unit ?? m.row.packUnit,
        packLabel: a.pack ? `${a.pack.size}${a.pack.unit}` : null, packs: 1, covered: true, exactPack: true,
        pricePerUnit: a.pricePerUnit, pricePerUnitLabel: a.pricePerUnitLabel, confidence: 1, confidenceReason: 'entered', url: '',
      },
      lineTotal: Math.round(m.row.price * (item.qty || 1) * 100) / 100,
      cachedAt: m.seenAt,
      source: m.source,
      entryId: m.id,
      history: store.cachedHistory?.(item.query, 'others') ?? null,
    };
  });
  if (!any) return null;
  const fulfilled = lines.filter((l) => l.lineTotal != null).length;
  return {
    platform: 'others', label: 'Others', others: true, lines,
    total: null, subtotal: null, fulfilledLines: fulfilled, totalLines: lines.length, complete: false,
    missing: [], lowConfidence: [], fees: { known: false, total: 0 },
  };
}

/** Hover data: what each account charged for the chosen product of a line. */
function addAccountPrices(scored, result, accounts) {
  const names = accounts ? accounts.labels(result.platform).names : {};
  for (const line of scored.lines) {
    if (!line.product) continue;
    const rows = (result.resultsByQuery?.[line.query] ?? []).filter((r) => r.name === line.product.name && r.account);
    const best = new Map();
    for (const r of rows) if (!best.has(r.account) || r.price < best.get(r.account)) best.set(r.account, r.price);
    if (best.size) {
      line.accountPrices = [...best].map(([account, price]) => ({ account, name: names[account] ?? account, price })).sort((a, b) => a.price - b.price);
    }
  }
}

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
  accounts,
  poolSet,
  only,
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
  const savedFrom = {}; // site -> query -> the more specific saved line it was answered from
  if (cached) {
    platformResults = active.map((site) => {
      const resultsByQuery = {};
      cachedAt[site] = {};
      savedFrom[site] = {};
      for (const query of queries) {
        // A line with no saved price of its own may use a more specific saved
        // line's ("salt" from "tata salt 1kg"); see store.savedFor.
        const row = store.latestFor(query, site) ?? store.savedFor?.(query, site) ?? null;
        resultsByQuery[query] = row ? [row] : [];
        if (row) cachedAt[site][query] = row.seenAt;
        if (row?.savedFrom) savedFrom[site][query] = row.savedFrom;
      }
      return { platform: site, available: true, error: null, errorKind: null, partialFailures: [], failures: [], resultsByQuery };
    });
  } else if (backend === 'engine') {
    const runSearch = search ?? (await import('./engine/run.js')).runSearch;
    const thePool = pool ?? (await import('./engine/pool.js')).getPool({ location: cfg.location, blockMedia: cfg.browser?.blockMedia !== false });
    if (only && Object.keys(only).length) {
      // "Get for missing only": each site searches just its missing items; the
      // rest of its column stays empty here (the page re-reads saved prices after).
      const sitesOnly = active.filter((s) => only[s]?.length);
      platformResults = await Promise.all(sitesOnly.map(async (site) => {
        const qs = queries.filter((q) => only[site].some((x) => resolveBasket(x)[0]?.query === q || x === q));
        const [r] = await runSearch({ sites: [site], queries: qs, pool: thePool, onProgress, signal, limiter: getLimiter(cfg.limits) });
        for (const q of queries) r.resultsByQuery[q] ??= [];
        return r;
      }));
    } else {
      platformResults = await runSearch({ sites: active, queries, pool: thePool, onProgress, signal, limiter: getLimiter(cfg.limits) });
    }
    // Sites that price per account (Instamart): search each extra signed-in
    // account too, one after another, and pool the candidates. Every row keeps
    // its account, so the cheapest wins and the page can say which account.
    if (accounts && poolSet) {
      for (const result of platformResults.filter((r) => SITES[r.platform]?.perAccountSearch)) {
        await searchExtraAccounts({ result, queries, accounts, poolSet, runSearch, onProgress, signal, limiter: getLimiter(cfg.limits), accountGapMs: search ? 0 : ACCOUNT_GAP_MS });
      }
    }
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

  // Products the user marked ✕ (wrong match) for an item on a site are never candidates.
  if (store?.rejectedFor) {
    for (const r of platformResults) {
      for (const [q, rows] of Object.entries(r.resultsByQuery ?? {})) {
        const bad = store.rejectedFor(q, r.platform);
        if (bad.size) r.resultsByQuery[q] = (rows ?? []).filter((row) => !bad.has(String(row.name ?? '').trim()));
      }
    }
  }

  // Deals (80%+ off MRP) among every raw candidate, before the price check:
  // a ₹1 tomato is "suspect" to the price check and stays out of the totals,
  // but is exactly what the Deals section is for. Saved prices aren't re-dealt.
  const dealPct = cfg.deals?.minDiscountPct ?? DEFAULT_MIN_DISCOUNT_PCT;
  const deals = cached
    ? []
    : platformResults.filter((r) => r.available).flatMap((r) => dealsFromRows(r.resultsByQuery, { site: r.platform, minPct: dealPct, seenAt: new Date().toISOString() }));

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

  // What each line usually is on each site (learned from saved prices), and the
  // optional AI labels: both only reorder candidates (categories, 2026-11-20).
  const prefs = store?.prefsFor?.(queries, active) ?? {};
  const aiGroups = store?.aiGroups?.() ?? new Map();
  for (const result of platformResults) {
    const scored = scorePlatform(result.platform, basket, filtered[result.platform] ?? result.resultsByQuery ?? {}, feeConfig, { prefs: prefs[result.platform], aiGroups });
    if (result.perAccount) addAccountPrices(scored, result, accounts);
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
          const from = savedFrom[p.platform]?.[line.query];
          if (from) line.savedFrom = from;
          // ▲/▼ and lows for the saved price, from the store itself (the source line's, when borrowed).
          if (store.cachedHistory) line.history = store.cachedHistory(from ?? line.query, p.platform);
        } else {
          line.status = 'not-cached';
          uncached.push({ platform: p.platform, query: line.query });
        }
      }
      if (p.lines.every((l) => l.status === 'not-cached')) p.notCached = true;
    }
    seen.sort();
  }

  // "cheaper: other brand" (option A, 2026-11-20): for an item that names a
  // brand, the best same-kind product of ANOTHER brand on that site, when its
  // rate is lower. A hint only: the line, totals and ranking keep the brand asked for.
  const alternatives = [];
  for (const p of scores) {
    if (p.failed) continue;
    for (const line of p.lines) {
      const pr = line.product;
      if (!pr || line.lineTotal == null || !(pr.pricePerUnit > 0)) continue;
      const generic = withoutBrand(line.query);
      if (!generic) continue;
      let alt = null;
      if (cached) {
        const a = store?.alternativeFor?.(line.query, p.platform);
        if (a && a.unit === pr.packUnit) alt = a;
      } else {
        const cands = (filtered[p.platform]?.[line.query] ?? []).filter((r) => r.name !== pr.name && !addsKind(line.query, pr.name, r.name));
        const best = cands.length ? pickBest(generic, cands, line.qty ?? 1) : null;
        const c = best?.status === 'ok' ? best.chosen : null;
        if (c && c.pack?.unit === pr.packUnit) {
          alt = { product: c.name, price: c.price, pack: c.pack ? `${c.pack.size}${c.pack.unit}` : null, pricePerUnit: c.pricePerUnit, unit: c.pack.unit };
          alternatives.push({ query: line.query, site: p.platform, product: alt.product, price: alt.price, pack: alt.pack, unitPrice: alt.pricePerUnit, unit: alt.unit });
        }
      }
      // Only worth saying when it is really cheaper (1% or more).
      if (alt && alt.pricePerUnit < pr.pricePerUnit * 0.99) {
        line.alternative = { ...alt, savingPct: Math.round((1 - alt.pricePerUnit / pr.pricePerUnit) * 100) };
      }
    }
  }

  const ranking = rank(scores);
  const ranked = ranking.allScores ?? [];
  // Failed platforms stay in the table (with their error) after the ranked ones.
  const shown = [...ranked, ...scores.filter((s) => !ranked.some((r) => r.platform === s.platform))];

  // "Others": prices the user entered (bought elsewhere). A column like a site's
  // for colours and "best per item", but never ranked, totalled or searched.
  const others = othersColumn(basket, store);
  if (others) shown.push(others);

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
    deals,
    // Cheaper other-brand products seen this run (stored for the hint on saved prices).
    alternatives,
    feesKnown: allFeesKnown(active, feeConfig),
    feesConfigured: active.filter((p) => Boolean(feeConfig[p])),
    feesMissing: active.filter((p) => !feeConfig[p]),
  };
}
