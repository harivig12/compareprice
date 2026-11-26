/**
 * The long-running Jhola service: `jhola serve` and the Docker container.
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
import { startSweep } from './sweep.js';
import { startOfferSchedule } from './offer-schedule.js';
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
 * @param {{ setTimer: Function, clearTimer: Function }} [opts.sweepTimers]  catalogue sweep timers (tests)
 * @param {(msg: string) => void} [opts.log]
 */
export async function startService({
  dataDir = DATA_DIR,
  port,
  host,
  run,
  now,
  tickMs,
  sweepTimers,
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
      : opts.trigger === 'offer-rules'
        ? runOfferRulesJob(opts)
        : opts.trigger === 'same-product'
          ? runSameProductJob(opts)
          : opts.trigger === 'scheduled-add'
            ? runScheduledAddJob(opts)
            : opts.trigger === 'mb-catalogue'
              ? runCatalogueJob(opts)
              : import('./compare.js').then((m) => m.compareBasket({ ...opts, accounts, poolSet, store, pool: poolSet.getMain() })));
  const runOfferCheck = async ({ signal, onProgress, platforms }) => {
    const [{ checkOffers, OFFER_SITES }, { SITES }, { getLimiter }] = await Promise.all([import('./offers.js'), import('./engine/sites/index.js'), import('./limits.js')]);
    const out = await checkOffers({
      poolSet, accounts, store, signal, onProgress, sitesImpl: SITES,
      sites: platforms?.length ? platforms.filter((s) => OFFER_SITES.includes(s)) : OFFER_SITES,
      limiter: getLimiter(getConfig().limits),
      minPct: getConfig().deals?.minDiscountPct,
      zeptoCart: getConfig().deals?.zeptoCart !== false,
      cartOffers: { zepto: getConfig().deals?.zeptoCart !== false, instamart: getConfig().deals?.instamartCart !== false },
      log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
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
  // Payment advisor: read new payment offers' terms into fixed rules (offer text only).
  const runOfferRulesJob = async ({ signal }) => {
    const { runOfferRules } = await import('./ai/offer-rules.js');
    const out = await runOfferRules({ store, dataDir, signal, log, timeZone: getConfig().timezone });
    log(`offer-rules: ${out.error ? `FAILED ${out.error}` : `${out.read} read in ${out.calls} call(s)${out.skipped ? ` (${out.skipped})` : ''}`}`);
    if (out.error) throw new Error(`offer-rules: ${out.error}${out.read ? ` (after ${out.read} read)` : ''}`);
    return out;
  };
  // Scheduled adds (src/scheduled-adds.js): one account's due entries, in that account's own browser.
  const runScheduledAddJob = async ({ data, signal }) => {
    const sa = await import('./scheduled-adds.js');
    const [{ SITES }, { getLimiter }] = await Promise.all([import('./engine/sites/index.js'), import('./limits.js')]);
    const [site, accountId] = String(data?.key ?? '').split(':');
    const impl = SITES[site];
    if (!sa.ADD_SITES.includes(site) || !impl?.ensureInBasket) throw new Error(`scheduled-add: ${site || '?'} does not support scheduled adds`);
    const state = sa.readAdds(dataDir);
    const acc = accounts.get(site, accountId);
    let lines;
    if (!acc?.loggedInAt) {
      lines = await sa.runAdds({ state, key: data.key, entryIds: data.ids, day: data.day, log, ensure: async () => { const e = new Error(`${site}: this account is not signed in; sign it in again from "Sign in…". Nothing was added`); e.kind = 'session'; throw e; } });
    } else {
      lines = await poolSet.with(site, acc, async (pool) => {
        const tab = await pool.tab(site);
        return sa.runAdds({
          state, key: data.key, entryIds: data.ids, day: data.day, log,
          ensure: async (item) => {
            if (signal?.aborted) throw new Error('cancelled');
            await getLimiter(getConfig().limits).acquire(site, { signal });
            return impl.ensureInBasket(tab, item, { log });
          },
        });
      });
    }
    // Written onto the latest saved list (an edit made meanwhile is kept): the log, and "once" entries done.
    const fresh = sa.readAdds(dataDir);
    fresh.log.push(...lines);
    const done = new Set(state.accounts[data.key]?.entries.filter((e) => e.once && !e.enabled).map((e) => e.id) ?? []);
    for (const e of fresh.accounts[data.key]?.entries ?? []) if (done.has(e.id)) e.enabled = false;
    sa.writeAdds(dataDir, fresh);
    return { kind: 'scheduled-add', generatedAt: new Date().toISOString(), platforms: [], lines };
  };
  // Read a Milkbasket account's catalogue (read-only, paced) so a scheduled-add product can be picked.
  const runCatalogueJob = async ({ data }) => {
    const [site, accountId] = String(data?.key ?? '').split(':');
    const mb = await import('./engine/sites/milkbasket.js');
    const acc = accounts.get(site, accountId);
    if (site !== 'milkbasket' || !acc?.loggedInAt) throw new Error(`${site || 'milkbasket'}: sign this account in first`);
    const rows = await poolSet.with(site, acc, async (pool) => mb.catalog(await pool.tab(site), { log }));
    log(`mb-catalogue: ${rows.length} products read for ${data.key}`);
    return { kind: 'mb-catalogue', generatedAt: new Date().toISOString(), platforms: [], products: rows.length };
  };
  // "Same product?" check on the latest comparison's borderline matches (titles only; it only demotes).
  const runSameProductJob = async ({ signal }) => {
    const { runSameProduct } = await import('./ai/same-product.js');
    let result = null;
    try { result = JSON.parse(readFileSync(join(dataDir, 'last-result.json'), 'utf8')); } catch { /* none yet */ }
    const out = await runSameProduct({ store, dataDir, result, signal, log, timeZone: getConfig().timezone });
    log(`same-product: ${out.error ? `FAILED ${out.error}` : out.skipped ?? `${out.asked} asked, ${out.flagged} flagged`}`);
    if (out.error) throw new Error(`same-product: ${out.error}`);
    return out;
  };
  const aiEnabled = async () => (await import('./ai/settings.js')).readAiSettings(dataDir).enabled;
  const queue = new JobQueue({ run: run ?? engineRun, store });
  const meta = new Map(); // jobId -> { id, trigger, sites }
  const origEnqueue = queue.enqueue.bind(queue);
  const lastTrigger = new Map(); // jobId -> trigger, for the after-schedule offer check
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
    // The offer check (deals) runs at fixed times of its own (deals.times,
    // 07:00 and 18:00 by default; src/offer-schedule.js), not after each
    // scheduled basket run.
    // After the offer check (the quiet slot after a schedule), label new titles
    // if the AI labeller is on. Queued, so it never overlaps a search.
    if (!run && lastTrigger.get(jobId) === 'offers') {
      aiEnabled().then((on) => {
        const already = queue.pending().some((j) => j.trigger === 'ai-labels') || queue.current()?.trigger === 'ai-labels';
        if (on && !already) queue.enqueue({ items: '', sites: null, trigger: 'ai-labels' });
      }).catch((err) => log(`ai-labels: could not read ai.md: ${err.message}`));
      // New payment offers get their rules read (a no-op without a key or with "read offers: no").
      if (!queue.pending().some((j) => j.trigger === 'offer-rules') && queue.current()?.trigger !== 'offer-rules') queue.enqueue({ items: '', sites: null, trigger: 'offer-rules' });
    }
    // After a basket run (search or schedule), judge its borderline matches (a no-op without a key).
    const trig = lastTrigger.get(jobId);
    if (!run && trig && !['offers', 'ai-labels', 'offer-rules', 'same-product', 'scheduled-add', 'mb-catalogue'].includes(trig) && !(outcome instanceof Error)
      && !queue.pending().some((j) => j.trigger === 'same-product')) {
      queue.enqueue({ items: '', sites: null, trigger: 'same-product' });
    }
    lastTrigger.delete(jobId);
    idle.touch();
    pruneResults(resultsDir, getConfig().results?.keepDays ?? 60);
  });
  const idleTimer = run ? null : idle.start(30_000);
  // The sweep starts after the server (it shares the queue), but the server's
  // /api/sweep routes need it: hand over a holder filled in below.
  const sweep = { ref: null };
  const server = await startServer({
    sweep: {
      status: () => sweep.ref?.status() ?? null,
      runOnce: (opts) => sweep.ref?.runOnce(opts) ?? { jobId: null, items: [], reason: 'not started' },
    },
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
  sweep.ref = startSweep({ queue, getConfig, store, log, ...(now ? { now } : {}), ...(sweepTimers ?? {}) });
  // Not with an injected test runner, which has no engine to check offers with.
  const offerSchedule = run ? null : startOfferSchedule({ queue, getConfig, store, log, ...(now ? { now } : {}), ...(tickMs ? { tickMs } : {}) });
  // Scheduled adds (master switch off until the user turns it on in Settings).
  const addSchedule = run ? null : (await import('./scheduled-adds.js')).startAddSchedule({ queue, dataDir, getConfig, store, log, ...(now ? { now } : {}), ...(tickMs ? { tickMs } : {}) });
  const sw = getConfig().sweep ?? {};
  const sched = getConfig().schedules.filter((s) => s.enabled !== false).map((s) => `${s.name} ${s.times.join('/')} [${s.sites.join(',')}]`);
  log(`Jhola service on ${server.url} (bind ${server.host}); data ${dataDir}; tz ${cfg.timezone}`);
  log(`schedules: ${sched.join('; ') || 'none'}`);
  log(
    sw.enabled === false
      ? 'catalogue sweep: off'
      : `catalogue sweep: ${sw.minItems ?? 2}–${sw.maxItems ?? 4} products every ${sw.minGapMinutes ?? 5}–${sw.maxGapMinutes ?? 20} min; next ${sweep.ref.status().nextAt}`,
  );

  return {
    server,
    queue,
    store,
    scheduler,
    sweep: sweep.ref,
    resultsDir,
    idle,
    login,
    accounts,
    poolSet,
    async close() {
      offerSchedule?.stop();
      addSchedule?.stop();
      idleTimer?.stop();
      scheduler.stop();
      sweep.ref.stop();
      await server.close();
      await poolSet.closeAll().catch(() => {});
      const pool = await import('./engine/pool.js').then((m) => m.peekPool?.()).catch(() => null);
      await pool?.close().catch(() => {});
      store.close();
    },
  };
}
