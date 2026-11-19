#!/usr/bin/env node
/**
 * Cross-check scheduled runs from the files the service writes.
 *
 *   node scripts/verify-runs.js [dataDir] [--date=YYYY-MM-DD] [--expect=07:00,09:00,12:00]
 *
 * Reads <dataDir>/results/runs.jsonl (one line per finished job) and prints,
 * per expected schedule time on that date (Asia/Kolkata), whether a
 * scheduled job finished within 30 minutes after it, its per-site outcome,
 * and the new lows it found. Exit code 1 if an expected run is missing.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const flag = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const dir = args.find((a) => !a.startsWith('--')) || process.env.BASKET_DATA || join(homedir(), 'basket-data');
const tz = 'Asia/Kolkata';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const date = flag('date') || today;
const expect = (flag('expect') || '07:00,09:00,12:00').split(',');

const file = join(dir, 'results', 'runs.jsonl');
if (!existsSync(file)) {
  console.error(`no ${file} yet`);
  process.exit(1);
}
const runs = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const local = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
// IST is UTC+5:30 all year.
const instant = (hhmm) => new Date(`${date}T${hhmm}:00+05:30`).getTime();

let missing = 0;
console.log(`Scheduled runs on ${date} (${tz}) from ${file}\n`);
for (const t of expect) {
  const at = instant(t);
  const run = runs.find((r) => r.trigger === 'schedule' && new Date(r.finishedAt).getTime() >= at && new Date(r.finishedAt).getTime() <= at + 30 * 60_000);
  if (!run) {
    const future = at > Date.now();
    console.log(`  ${t}  ${future ? 'not due yet' : 'MISSING'}`);
    if (!future) missing++;
    continue;
  }
  console.log(`  ${t}  job ${run.jobId} finished ${local(run.finishedAt)} in ${Math.round(run.elapsedMs / 1000)}s — winner ${run.winner ? `${run.winner.platform} ₹${run.winner.total}` : 'none'}`);
  for (const s of run.sites) {
    const status = s.error ? `FAILED [${s.errorKind}] ${s.error.slice(0, 110)}` : `${s.found} found, ₹${s.total}`;
    console.log(`        ${s.platform.padEnd(10)} ${status}${s.newLows?.length ? `  new lows: ${s.newLows.join(', ')}` : ''}`);
  }
}
process.exit(missing ? 1 : 0);
