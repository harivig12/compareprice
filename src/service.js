/**
 * The long-running basket service: `basket serve` and the Docker container.
 *
 *   config.json  ->  scheduler  ->  JobQueue  ->  compareBasket (engine)
 *                                     |  ^
 *                 web UI / API  ------+  |  (manual runs share the queue)
 *                                        v
 *                    store (history + jobs)  +  results/<ts>-job<id>.json
 *
 * Every finished job is also written as a JSON file under DATA_DIR/results,
 * and one summary line is appended to DATA_DIR/results/runs.jsonl, so runs
 * can be cross-checked without the UI (see docs/OPERATIONS.md).
 */
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { DATA_DIR } from './paths.js';
import { loadConfig, saveConfig } from './config.js';
import { openStore } from './store.js';
import { JobQueue } from './jobs.js';
import { startScheduler } from './scheduler.js';
import { startServer } from './server.js';
import { IdleCloser } from './engine/idle.js';
import { defaultLoginManager, LOGIN_SITES } from './engine/login.js';
import { peekPool, getPool } from './engine/pool.js';
import { openAccounts } from './engine/accounts.js';
import { PoolSet } from './engine/poolset.js';

/**
 * Delete per-run result files older than `keepDays` (runs.jsonl is kept).
 * @returns {number} files deleted
 */
export function pruneResults(dir, keepDays, now = Date.now()) {
  let n = 0;
  const cutoff = now - keepDays * 86_400_000;
  if (!existsSync(dir)) return 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const file = join(dir, f);
    try {
      if (statSync(file).mtimeMs < cutoff) { unlinkSync(file); n++; }
    } catch { /* raced with another delete */ }
  }
  return n;
}

/** The offer check runs this long after a scheduled basket run. */
export const OFFERS_AFTER_SCHEDULE_MS = 15 * 60_000;

/** One-line summary of a finished job, for runs.jsonl. */
export function summarize(job, outcome) {
  if (outcome instanceof Error) {
    return { jobId: job.id, trigger: job.trigger, finishedAt: new Date().toISOString(), ok: false, error: outcome.message };
  }
  const r = outcome;
  return {
    jobId: job.id,
    trigger: job.trigger,
    finishedAt: r.generatedAt,
    ok: true,
    elapsedMs: r.elapsedMs,
    pincode: r.pincode,
    items: r.basket?.length ?? 0,
    winner: r.winner ? { platform: r.winner.platform, total: r.winner.total } : null,
    sites: (r.platforms ?? []).map((p) => ({
      platform: p.platform,
      total: p.total,
      found: `${p.fulfilledLines}/${p.totalLines}`,
      error: p.error ?? null,
      errorKind: p.errorKind ?? null,
      newLows: (p.lines ?? []).filter((l) => l.history?.tag === 'new-low').map((l) => l.query),
    })),
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {Function} [opts.run]       compareBasket-compatible (tests)
 * @param {() => Date} [opts.now]     scheduler clock (tests)
 * @param {number} [opts.tickMs]
 * @param {(msg: string) => void} [opts.log]
 */
export async function startService({
  dataDir = DATA_DIR,
  port,
  host,
  run,
  now,
  tickMs,
  log = (m) => console.log(`[${new Date().toISOString()}] ${m}`),
} = {}) {
  const getConfig = () => loadConfig(dataDir);
  const cfg = getConfig();
  const store = openStore(join(dataDir, 'basket.db'));
  const interrupted = store.markInterrupted();
  if (interrupted) log(`marked ${interrupted} job(s) from a previous run as interrupted`);

  const resultsDir = join(dataDir, 'results');
  mkdirSync(resultsDir, { recursive: true });

  // Accounts (main in chrome-profile, extras in profiles/<site>-<id>) and their browsers.
  const accounts = openAccounts(join(dataDir, 'accounts.json'), {
    legacyFile: join(dataDir, 'sessions.json'),
    multiAccount: (s) => Boolean(LOGIN_SITES[s]?.multiAccount),
  });
  const blockMedia = cfg.browser?.blockMedia !== false;
  const signedIn = (site, id = 'main') => Boolean(accounts.get(site, id)?.loggedInAt);
  const poolSet = new PoolSet({
    dataDir,
    blockMedia,
    getLocation: () => getConfig().location,
    signedIn,
    // Close the main Chrome before an extra account's starts, unless a sign-in is open in it.
    canCloseMain: () => !login.status().some((x) => x.pending),
    // A signed-in main account keeps the address saved on it; config fills in the rest.
    getMain: () => getPool({ location: getConfig().location, blockMedia, ownLocation: (site) => signedIn(site) }),
  });
  // One queue: basket runs and offer checks take turns, so a tab is never shared.
  // The main pool always comes from poolSet, so a signed-in account keeps its
  // saved address even when a search is the first thing after a restart.
  const engineRun = (opts) => (opts.trigger === 'offers'
    ? runOfferCheck(opts)
    : opts.trigger === 'ai-labels'
      ? runAiLabelsJob(opts)
      : import('./compare.js').then((m) => m.compareBasket({ ...opts, accounts, poolSet, store, pool: poolSet.getMain() })));
  const runOfferCheck = async ({ signal, onProgress, platforms }) => {
    const [{ checkOffers, OFFER_SITES }, { SITES }, { getLimiter }] = await Promise.all([import('./offers.js'), import('./engine/sites/index.js'), import('./limits.js')]);
    const out = await checkOffers({
      poolSet, accounts, store, signal, onProgress, sitesImpl: SITES,
      sites: platforms?.length ? platforms.filter((s) => OFFER_SITES.includes(s)) : OFFER_SITES,
      limiter: getLimiter(getConfig().limits),
      minPct: getConfig().deals?.minDiscountPct,
      accountGapMs: (await import('./offers.js')).OFFER_ACCOUNT_GAP_MS,
    });
    for (const o of out.offers) log(`offers ${o.site} ${o.account === 'main' ? '' : `(${o.name}) `}${o.error ? `FAILED ${o.error}` : `${o.deals} deal(s) of ${o.scanned} checked`}`);
    return out;
  };
  // Optional AI labels (src/ai/, off by default): no browser, paced by <data>/ai.md.
  const runAiLabelsJob = async ({ signal }) => {
    const { runAiLabels } = await import('./ai/job.js');
    const out = await runAiLabels({ store, dataDir, signal, log, timeZone: getConfig().timezone });
    log(`ai-labels: ${out.error ? `FAILED ${out.error}` : `${out.labelled} labelled in ${out.calls} call(s)${out.skipped ? ` (${out.skipped})` : ''}`}`);
    // A failure shows in the jobs list with its reason (what was labelled before it is kept).
    if (out.error) throw new Error(`ai-labels: ${out.error}${out.labelled ? ` (after ${out.labelled} labelled)` : ''}`);
    return out;
  };
  const aiEnabled = async () => (await import('./ai/settings.js')).readAiSettings(dataDir).enabled;
  const queue = new JobQueue({ run: run ?? engineRun, store });
  const meta = new Map(); // jobId -> { id, trigger, sites }
  const origEnqueue = queue.enqueue.bind(queue);
  const lastTrigger = new Map(); // jobId -> trigger, for the after-schedule offer check
  let offersTimer = null;
  queue.enqueue = (job) => {
    const id = origEnqueue(job);
    lastTrigger.set(id, job.trigger ?? 'manual');
    meta.set(id, { id, trigger: job.trigger ?? 'manual', sites: job.sites ?? null });
    log(`job ${id} queued (${job.trigger ?? 'manual'}; sites ${job.sites?.join(',') || 'default'})`);
    return id;
  };

  const lastProgress = new Map();
  queue.on('progress', (jobId, e) => {
    if (e?.type === 'site-done') log(`job ${jobId} ${e.site}: ${e.ok ? 'done' : `FAILED ${e.error}`}`);
    else if (e?.type === 'retry') log(`job ${jobId} ${e.site}: retry after ${e.kind} (${e.message})`);
    else if (e?.type === 'query') lastProgress.set(jobId, e);
  });

  queue.on('done', (jobId, outcome) => {
    const job = meta.get(jobId) ?? { id: jobId, trigger: 'manual' };
    meta.delete(jobId);
    lastProgress.delete(jobId);
    const summary = summarize(job, outcome);
    try {
      appendFileSync(join(resultsDir, 'runs.jsonl'), JSON.stringify(summary) + '\n');
      if (!(outcome instanceof Error)) {
        const stamp = String(outcome.generatedAt || new Date().toISOString()).replace(/[:.]/g, '-');
        writeFileSync(join(resultsDir, `${stamp}-job${jobId}-${job.trigger}.json`), JSON.stringify({ job, result: outcome }, null, 2));
      }
    } catch (err) {
      log(`could not write results for job ${jobId}: ${err.message}`);
    }
    log(
      outcome instanceof Error
        ? `job ${jobId} failed: ${outcome.message}`
        : `job ${jobId} done in ${(outcome.elapsedMs / 1000).toFixed(1)}s; winner ${outcome.winner?.label ?? 'none'} ${outcome.winner ? `₹${outcome.winner.total}` : ''}`,
    );
  });

  const pruned = pruneResults(resultsDir, cfg.results?.keepDays ?? 60);
  if (pruned) log(`deleted ${pruned} result file(s) older than ${cfg.results?.keepDays ?? 60} days`);

  // Sign-ins and jobs share one browser; the idle closer must wait for both.
  const idle = new IdleCloser({
    getPool: () => peekPool(),
    isBusy: () => Boolean(queue.current()) || queue.pending().length > 0 || login.status().some((x) => x.pending),
    // (Extra accounts' browsers close themselves after each step; see PoolSet.)
    idleMs: cfg.browser?.idleCloseMs ?? 300_000,
    log,
  });
  const login = defaultLoginManager({
    file: join(dataDir, 'accounts.json'),
    accounts,
    poolSet,
    log,
    getLocation: () => getConfig().location,
    inUse: () => Boolean(queue.current()),
    onActivity: () => idle.touch(),
    onSignedOut: (site, account) => store.forgetAccountDeals(site, account),
  });
  queue.on('progress', () => idle.touch());
  queue.on('done', (jobId, outcome) => {
    // After a scheduled basket run, check the accounts' offers (once; queued).
    const job = { trigger: outcome?.kind === 'offers' ? 'offers' : null };
    // (Not with an injected test runner, which has no engine to check offers with.)
    // 15 minutes later, not straight after: back-to-back they kept the CPU at
    // its limit for most of an hour (2026-11-20).
    if (!run && !(outcome instanceof Error) && job.trigger !== 'offers' && lastTrigger.get(jobId) === 'schedule' && !offersTimer) {
      offersTimer = setTimeout(() => {
        offersTimer = null;
        const already = queue.pending().some((j) => j.trigger === 'offers') || queue.current()?.trigger === 'offers';
        if (!already) queue.enqueue({ items: '', sites: null, trigger: 'offers' });
      }, OFFERS_AFTER_SCHEDULE_MS);
      offersTimer.unref?.();
    }
    // After the offer check (the quiet slot after a schedule), label new titles
    // if the AI labeller is on. Queued, so it never overlaps a search.
    if (!run && lastTrigger.get(jobId) === 'offers') {
      aiEnabled().then((on) => {
        const already = queue.pending().some((j) => j.trigger === 'ai-labels') || queue.current()?.trigger === 'ai-labels';
        if (on && !already) queue.enqueue({ items: '', sites: null, trigger: 'ai-labels' });
      }).catch((err) => log(`ai-labels: could not read ai.md: ${err.message}`));
    }
    lastTrigger.delete(jobId);
    idle.touch();
    pruneResults(resultsDir, getConfig().results?.keepDays ?? 60);
  });
  const idleTimer = run ? null : idle.start(30_000);

  const server = await startServer({
    login,
    accounts,
    port: port ?? Number(process.env.BASKET_PORT || cfg.server?.port || 7777),
    host: host ?? process.env.BASKET_HOST ?? cfg.server?.host ?? '127.0.0.1',
    queue,
    store,
    getConfig,
    dataDir,
    setConfig: (c) => saveConfig(c, dataDir),
    saveLatest: (r) => writeFileSync(join(dataDir, 'last-result.json'), JSON.stringify(r, null, 2)),
    loadLatest: () => {
      try {
        return JSON.parse(readFileSync(join(dataDir, 'last-result.json'), 'utf8'));
      } catch {
        return null;
      }
    },
  });

  const scheduler = startScheduler({ queue, getConfig, store, ...(now ? { now } : {}), ...(tickMs ? { tickMs } : {}) });
  const sched = getConfig().schedules.filter((s) => s.enabled !== false).map((s) => `${s.name} ${s.times.join('/')} [${s.sites.join(',')}]`);
  log(`basket service on ${server.url} (bind ${server.host}); data ${dataDir}; tz ${cfg.timezone}`);
  log(`schedules: ${sched.join('; ') || 'none'}`);

  return {
    server,
    queue,
    store,
    scheduler,
    resultsDir,
    idle,
    login,
    accounts,
    poolSet,
    async close() {
      clearTimeout(offersTimer);
      idleTimer?.stop();
      scheduler.stop();
      await server.close();
      await poolSet.closeAll().catch(() => {});
      const pool = await import('./engine/pool.js').then((m) => m.peekPool?.()).catch(() => null);
      await pool?.close().catch(() => {});
      store.close();
    },
  };
}
