/**
 * Master price list runner: searches every item of `product list.md` through
 * the RUNNING SERVICE (same queue, per-site limits, history), in small batches
 * with a long gap between them, so it never bursts a site. Progress is saved
 * after every batch; a restarted run carries on where it stopped.
 *
 *   phase 1  each batch -> POST /api/compare (a normal fresh job), wait for it
 *   phase 2  once: item/site pairs still without a price -> mode 'missing'
 *   phase 3  report from saved prices -> master-<date>.csv / .md
 *
 * No AI involved: scripts/master-list.js runs it (nohup / cron / by hand).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { batches, masterRows, toCsv, toMarkdown } from './masterlist.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted']);

/**
 * @param {object} o
 * @param {string[]} o.items              search lines
 * @param {string} o.dir                  where state, log and reports go
 * @param {(path: string, init?: object) => Promise<{status: number, data: any}>} o.http
 * @param {string[]} [o.sites]            default: the service's configured sites
 * @param {number} [o.batchSize]
 * @param {number} [o.gapMs]              pause between batches
 * @param {number} [o.pollMs]
 * @param {number} [o.jobTimeoutMs]
 * @param {boolean} [o.missingPass]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {() => Date} [o.now]
 * @param {(msg: string) => void} [o.log]
 */
export async function runMaster({
  items, dir, http, sites, batchSize = 8, gapMs = 10 * 60_000, pollMs = 15_000, jobTimeoutMs = 45 * 60_000,
  missingPass = true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date(), log = console.log,
}) {
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, 'state.json');
  const say = (m) => {
    const line = `[${now().toISOString()}] ${m}`;
    log(line);
    try { appendFileSync(join(dir, 'run.log'), line + '\n'); } catch { /* best effort */ }
  };
  const fresh = { listKey: items.join('\n'), startedAt: now().toISOString(), done: {}, missingDone: false, finishedAt: null };
  let state = fresh;
  try {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (s.listKey === fresh.listKey && !s.finishedAt) state = s;
  } catch { /* first run */ }
  const save = () => {
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${stateFile}.tmp`, stateFile);
  };
  save();

  /**
   * The sites for the next job, minus any resting after a block: re-visiting a
   * bot wall every batch kept BigBasket blocked all night (2026-11-20).
   */
  async function sitesNow() {
    let list = sites?.length ? [...sites] : null;
    try {
      if (!list) list = (await http('/api/meta')).data?.defaultPlatforms ?? null;
      const lim = (await http('/api/limits')).data ?? {};
      const resting = (list ?? []).filter((s) => lim[s]?.cooldownMs > 0);
      if (resting.length) say(`left out while resting: ${resting.map((s) => `${s} (${Math.ceil(lim[s].cooldownMs / 60_000)} min)`).join(', ')}`);
      if (list) list = list.filter((s) => !resting.includes(s));
    } catch { /* the job itself will say what is wrong */ }
    return list;
  }

  /** Submit one job and wait for it to finish; waits out rate limits and a service that is down. */
  async function runJob(body, what) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        const now = await sitesNow();
        if (now && !now.length) { say(`${what}: every site is resting; waiting 10 min`); await sleep(600_000); continue; }
        // "missing" jobs name their own sites in `only`; keep only the ones not resting.
        const b = body.only && now ? { ...body, only: Object.fromEntries(Object.entries(body.only).filter(([s]) => now.includes(s))) } : body;
        if (b.only && !Object.keys(b.only).length) return { status: 'done', jobId: null };
        res = await http('/api/compare', { method: 'POST', body: { ...b, ...(now?.length && !b.only ? { platforms: now } : {}) } });
      } catch (e) {
        say(`${what}: service not reachable (${e.message}); retrying in 60 s`);
        await sleep(60_000);
        continue;
      }
      if (res.status === 429) {
        const wait = Math.max(5_000, Number(res.data?.waitMs) || 30_000) + 2_000;
        say(`${what}: ${res.data?.error ?? 'a site needs a pause'}; waiting ${Math.ceil(wait / 1000)} s`);
        await sleep(wait);
        continue;
      }
      if (res.status === 400 && /Nothing is missing/i.test(res.data?.error ?? '')) return { status: 'done', jobId: null };
      if (res.status !== 202) {
        if (attempt >= 3) return { status: 'failed', error: res.data?.error ?? `HTTP ${res.status}` };
        say(`${what}: refused (${res.data?.error ?? res.status}); retry ${attempt}/3 in 60 s`);
        await sleep(60_000);
        continue;
      }
      const { jobId } = res.data;
      say(`${what}: job ${jobId} queued`);
      const deadline = now().getTime() + jobTimeoutMs;
      while (now().getTime() < deadline) {
        await sleep(pollMs);
        const jobs = await http('/api/jobs?limit=100').catch(() => null);
        const job = jobs?.data?.jobs?.find((j) => j.id === jobId);
        if (job && TERMINAL.has(job.status)) return { status: job.status, jobId, error: job.error ?? null };
      }
      return { status: 'timeout', jobId };
    }
  }

  // Phase 1: every item, in batches.
  const todo = items.filter((q) => !state.done[q]);
  const list = batches(todo, batchSize);
  say(`master list: ${items.length} items, ${items.length - todo.length} already done, ${list.length} batch(es) of up to ${batchSize}, ${Math.round(gapMs / 60_000)} min apart`);
  for (const [i, batch] of list.entries()) {
    const out = await runJob({ items: batch.join('\n') }, `batch ${i + 1}/${list.length}`);
    say(`batch ${i + 1}/${list.length}: ${out.status}${out.error ? ` (${out.error})` : ''}`);
    for (const q of batch) state.done[q] = { status: out.status, jobId: out.jobId ?? null, at: now().toISOString() };
    save();
    if (i < list.length - 1) await sleep(gapMs);
  }

  // Saved prices for the whole list (no site contacted).
  async function cachedAll() {
    const results = [];
    for (const chunk of batches(items, 40)) {
      const res = await http('/api/compare', { method: 'POST', body: { items: chunk.join('\n'), mode: 'cached', ...(sites?.length ? { platforms: sites } : {}) } });
      if (res.status === 200) results.push(res.data);
    }
    return results;
  }

  // Phase 2: one pass over what is still missing.
  if (missingPass && !state.missingDone) {
    await sleep(gapMs);
    const pairs = [];
    for (const r of await cachedAll()) {
      for (const p of r.platforms ?? []) {
        for (const item of r.basket ?? []) {
          const l = (p.lines ?? []).find((x) => x.query === item.query);
          if (!l || (l.lineTotal == null && l.status !== 'bigger-pack')) pairs.push({ site: p.platform, item: item.raw ?? item.query });
        }
      }
    }
    say(`missing pass: ${pairs.length} item/site pair(s) without a price`);
    const byItem = new Map();
    for (const { site, item } of pairs) byItem.set(item, [...(byItem.get(item) ?? []), site]);
    const groups = batches([...byItem.keys()], batchSize);
    for (const [i, group] of groups.entries()) {
      const only = {};
      for (const item of group) for (const site of byItem.get(item)) (only[site] ??= []).push(item);
      const out = await runJob({ items: group.join('\n'), mode: 'missing', only }, `missing ${i + 1}/${groups.length}`);
      say(`missing ${i + 1}/${groups.length}: ${out.status}`);
      if (i < groups.length - 1) await sleep(gapMs);
    }
    state.missingDone = true;
    save();
  }

  // Phase 3: the report.
  const rows = masterRows(await cachedAll());
  const day = now().toISOString().slice(0, 10);
  const csv = join(dir, `master-${day}.csv`);
  const md = join(dir, `master-${day}.md`);
  writeFileSync(csv, toCsv(rows));
  writeFileSync(md, toMarkdown(rows, { generatedAt: now().toISOString() }));
  state.finishedAt = now().toISOString();
  save();
  say(`report: ${csv} and ${md}`);
  return { rows, csv, md };
}

/** One runner at a time: a lock file with the pid, cleared if that pid is gone. */
export function takeLock(dir, pid = process.pid) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'run.lock');
  if (existsSync(file)) {
    const other = Number(readFileSync(file, 'utf8'));
    let alive = false;
    try { process.kill(other, 0); alive = other !== pid; } catch { alive = false; }
    if (alive) throw new Error(`another master-list run is going (pid ${other}); stop it or delete ${file}`);
  }
  writeFileSync(file, String(pid));
  return () => { try { unlinkSync(file); } catch { /* gone */ } };
}
