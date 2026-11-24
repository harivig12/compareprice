/**
 * Self-healing search runner.
 *
 * One worker per site (parallel); queries within a site run sequentially.
 * Per query: search -> on session/blocked (or empty first query) refresh the
 * tab and retry once -> DOM-extractor fallback -> record a classified failure.
 * Returns the searchPlatform envelope plus `errorKind` and `failures`.
 */
import { EXTRACTORS } from '../extract/index.js';
import { SiteError } from './errors.js';

const REQUIRED = ['name', 'packSize', 'packUnit', 'price', 'mrp', 'inStock', 'url'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function defaultSites() {
  return (await import('./sites/index.js')).SITES;
}

function classify(err) {
  if (err instanceof SiteError) return err.kind;
  if (/timeout|timed out/i.test(String(err?.message))) return 'timeout';
  // Anything else escaping a site (CDP closed, tab crashed, protocol error).
  return 'browser';
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && r.name && Number.isFinite(Number(r.price)))
    .map((r) => {
      for (const f of REQUIRED) if (!(f in r)) throw new SiteError('parse', `DOM extractor row missing "${f}"`);
      return {
        name: String(r.name).trim(),
        packSize: r.packSize == null ? null : Number(r.packSize),
        packUnit: r.packUnit == null ? null : String(r.packUnit).toLowerCase(),
        price: Number(r.price),
        mrp: r.mrp == null ? null : Number(r.mrp),
        inStock: Boolean(r.inStock),
        url: String(r.url),
      };
    });
}

/** Run the legacy src/extract/* DOM extractor on an engine tab. */
async function domFallback(tab, key, query, extractors) {
  const ex = extractors[key];
  if (!ex) throw new SiteError('parse', `no DOM extractor "${key}"`);
  await tab.goto(ex.searchUrl(query), { waitMs: 6000 });
  let ready = false;
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    ready = await tab.evaluate(ex.readyExpression, { timeoutMs: 5000 }).catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new SiteError('parse', `${key}: results never rendered`);
  const out = await tab.evaluate(ex.extractExpression);
  if (out?.error) throw new SiteError('parse', `${key}: extractor: ${out.error}`);
  return normalizeRows(out?.rows);
}

async function searchQuery({ siteId, site, query, first, pool, emit, extractors, limiter, signal }) {
  // One search = one unit of the site's budget; waits its turn when needed.
  const attempt = async () => {
    await limiter?.acquire(siteId, { signal, onWait: (w) => w.waitMs >= 1500 && emit({ type: 'wait', site: siteId, waitMs: w.waitMs, reason: w.reason }) });
    return site.search(await pool.tab(siteId), query);
  };

  let rows = null;
  let err = null;
  try {
    rows = await attempt();
  } catch (e) {
    err = e;
  }
  // Resting after a block: no retry, no page reload, no fallback. Touching the
  // site now would only prolong the block.
  if (err?.code === 'resting') return { rows: [], failure: { query, kind: 'blocked', code: 'resting', message: err.message } };

  const kind = err ? classify(err) : null;
  const retryable = err ? kind === 'session' || kind === 'blocked' : first && rows.length === 0;
  if (retryable) {
    emit({ type: 'retry', site: siteId, query, kind: kind ?? 'not_found', message: err ? err.message : `${siteId}: no results on first query` });
    try {
      if (err?.retryAfterMs) await sleep(err.retryAfterMs);
      await pool.refresh(siteId);
      rows = await attempt();
      err = null;
    } catch (e) {
      err = e;
    }
  }

  const needFallback = site.domFallback && (err ? classify(err) !== 'browser' && classify(err) !== 'unserviceable' : rows.length === 0 && first);
  if (needFallback) {
    emit({ type: 'fallback', site: siteId, query });
    try {
      const dom = await domFallback(await pool.tab(siteId), site.domFallback, query, extractors);
      if (dom.length > 0 || err) {
        rows = dom;
        err = dom.length > 0 ? null : err;
      }
    } catch (e) {
      // Keep the API failure if there was one; otherwise this is the failure.
      if (!err && rows.length === 0) rows = [];
      else if (!err) err = e;
    }
  }

  if (err) return { rows: [], failure: { query, kind: classify(err), message: err.message } };
  return { rows: rows ?? [], failure: null };
}

async function runSite({ siteId, queries, pool, onProgress, signal, sitesImpl, extractors, limiter }) {
  const emit = (e) => { try { onProgress?.(e); } catch { /* observer bug */ } };
  const site = sitesImpl[siteId];
  const total = queries.length;
  const resultsByQuery = {};
  const failures = [];

  emit({ type: 'site-start', site: siteId, total });

  // Sites marked skip are reported, never opened.
  if (site?.skip) {
    const message = `${siteId}: skipped — ${site.skip}`;
    const failures = queries.map((query) => ({ query, kind: 'unserviceable', message }));
    emit({ type: 'site-done', site: siteId, ok: false, error: message });
    return {
      platform: siteId, available: false, error: `${queries[0]}: ${message}`, partialFailures: [],
      resultsByQuery: Object.fromEntries(queries.map((q) => [q, []])), errorKind: 'unserviceable', failures,
    };
  }

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    if (signal?.aborted) throw new Error('Operation aborted');
    emit({ type: 'query', site: siteId, query, index: i + 1, total });
    if (!site) {
      resultsByQuery[query] = [];
      failures.push({ query, kind: 'not_found', message: `unknown site "${siteId}"` });
      continue;
    }
    let res;
    try {
      res = await searchQuery({ siteId, site, query, first: i === 0, pool, emit, extractors, limiter, signal });
    } catch (e) {
      res = { rows: [], failure: { query, kind: classify(e), message: e.message } };
    }
    resultsByQuery[query] = res.rows;
    if (res.failure) failures.push(res.failure);
    // Circuit breaker: a bot wall or an unserviceable location won't change
    // between queries, and hammering a wall prolongs the block. The retry
    // already happened inside searchQuery, so mark the rest and stop.
    // A page-scrape site whose page never renders is broken for every query.
    const brokenPage = site.mode === 'dom' && res.failure?.kind === 'parse';
    // The site refused us: rest it, so the next manual run says "wait" instead of hammering.
    // (Not when it was already resting: that would extend the rest on every run.)
    if (res.failure?.kind === 'blocked' && res.failure.code !== 'resting') limiter?.penalize(siteId, res.failure.message.slice(0, 120));
    if (res.failure && (res.failure.kind === 'blocked' || res.failure.kind === 'unserviceable' || brokenPage)) {
      for (const rest of queries.slice(i + 1)) {
        resultsByQuery[rest] = [];
        failures.push({ query: rest, kind: res.failure.kind, message: `skipped after "${query}": ${res.failure.message}` });
      }
      break;
    }
  }

  const allFailed = total > 0 && failures.length === total;
  const fmt = (f) => `${f.query}: ${f.message}`;
  const result = {
    platform: siteId,
    available: !allFailed,
    error: allFailed ? fmt(failures[0]) : null,
    partialFailures: allFailed ? [] : failures.map(fmt),
    resultsByQuery,
    errorKind: allFailed ? failures[0].kind : null,
    failures,
  };
  emit({ type: 'site-done', site: siteId, ok: !allFailed, ...(allFailed ? { error: result.error } : {}) });
  return result;
}

/**
 * @param {{ sites: string[], queries: string[], pool: { tab(id): Promise<any>, refresh(id): Promise<void> },
 *           onProgress?: (e: object) => void, signal?: AbortSignal,
 *           sitesImpl?: Record<string, object>, extractors?: Record<string, object> }} opts
 * @returns {Promise<Array<{platform:string, available:boolean, error:string|null, partialFailures:string[],
 *           resultsByQuery:Record<string, object[]>, errorKind:string|null,
 *           failures:Array<{query:string, kind:string, message:string}>}>>}
 */
export async function runSearch({ sites, queries, pool, onProgress, signal, sitesImpl, extractors = EXTRACTORS, limiter = null }) {
  const impl = sitesImpl ?? (await defaultSites());
  return Promise.all(
    sites.map((siteId) => runSite({ siteId, queries, pool, onProgress, signal, sitesImpl: impl, extractors, limiter })),
  );
}
