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
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DATA_DIR } from './paths.js';
import { loadConfig, saveConfig } from './config.js';
import { openStore } from './store.js';
import { JobQueue } from './jobs.js';
import { startScheduler } from './scheduler.js';
import { startServer } from './server.js';
import { startSweep } from './sweep.js';

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

  const queue = new JobQueue({ ...(run ? { run } : {}), store });
  const meta = new Map(); // jobId -> { id, trigger, sites }
  const origEnqueue = queue.enqueue.bind(queue);
  queue.enqueue = (job) => {
    const id = origEnqueue(job);
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

  // The sweep starts after the server (it shares the queue), but the server's
  // /api/sweep routes need it: hand over a holder filled in below.
  const sweep = { ref: null };
  const server = await startServer({
    sweep: {
      status: () => sweep.ref?.status() ?? null,
      runOnce: (opts) => sweep.ref?.runOnce(opts) ?? { jobId: null, items: [], reason: 'not started' },
    },
    port: port ?? Number(process.env.BASKET_PORT || cfg.server?.port || 7777),
    host: host ?? process.env.BASKET_HOST ?? cfg.server?.host ?? '127.0.0.1',
    queue,
    store,
    getConfig,
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
    async close() {
      scheduler.stop();
      sweep.ref.stop();
      await server.close();
      const pool = await import('./engine/pool.js').then((m) => m.peekPool?.()).catch(() => null);
      await pool?.close().catch(() => {});
      store.close();
    },
  };
}
