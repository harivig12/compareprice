#!/usr/bin/env node
/**
 * Build the master price list from `product list.md`, slowly, through the
 * running basket service. Runs on its own (no AI needed); safe to stop and
 * start again: it carries on from where it stopped.
 *
 *   node scripts/master-list.js [options]
 *
 *   --file=<path>      product list (default: "product list.md" next to this repo's package.json)
 *   --url=<url>        service (default $JHOLA_URL, $BASKET_URL or http://127.0.0.1:7777)
 *   --out=<dir>        state, log and reports (default ~/basket-data/master if it exists, else ~/.basket/master)
 *   --batch=<n>        items per job (default 8)
 *   --gap-min=<n>      minutes between jobs (default 10)
 *   --sites=a,b        sites (default: the service's configured sites)
 *   --no-missing       skip the one extra pass over item/site pairs with no price
 *   --report-only      only write the report from saved prices
 *   --dry-run          print the parsed items and exit
 *
 * Background, survives closing the terminal:
 *   nohup node scripts/master-list.js > /dev/null 2>&1 &
 *   tail -f ~/basket-data/master/run.log
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProductList, masterRows, toCsv, toMarkdown, batches } from '../src/masterlist.js';
import { runMaster, takeLock } from '../src/masterrun.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const file = args.file ? resolve(String(args.file)) : join(ROOT, 'product list.md');
const base = String(args.url ?? process.env.JHOLA_URL ?? process.env.BASKET_URL ?? 'http://127.0.0.1:7777').replace(/\/+$/, '');
const out = args.out ? resolve(String(args.out)) : existsSync(join(homedir(), 'basket-data')) ? join(homedir(), 'basket-data', 'master') : join(homedir(), '.basket', 'master');
const sites = args.sites ? String(args.sites).split(',').map((s) => s.trim()).filter(Boolean) : undefined;

if (!existsSync(file)) {
  console.error(`No product list at ${file} (use --file=…)`);
  process.exit(2);
}
const items = parseProductList(readFileSync(file, 'utf8')).map((i) => i.query);
if (args['dry-run']) {
  for (const [i, q] of items.entries()) console.log(`${String(i + 1).padStart(3)}  ${q}`);
  console.log(`\n${items.length} items`);
  process.exit(0);
}

async function http(path, init = {}) {
  const res = await fetch(base + path, {
    method: init.method ?? 'GET',
    headers: init.body ? { 'content-type': 'application/json' } : {},
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  return { status: res.status, data };
}

try {
  const health = await http('/health');
  if (health.status !== 200) throw new Error(`HTTP ${health.status}`);
} catch (e) {
  console.error(`The basket service isn't answering at ${base} (${e.message}). Start it (docker start jhola) and try again.`);
  process.exit(2);
}

if (args['report-only']) {
  const results = [];
  for (const chunk of batches(items, 40)) {
    const r = await http('/api/compare', { method: 'POST', body: { items: chunk.join('\n'), mode: 'cached', ...(sites ? { platforms: sites } : {}) } });
    if (r.status === 200) results.push(r.data);
  }
  const rows = masterRows(results);
  const day = new Date().toISOString().slice(0, 10);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `master-${day}.csv`), toCsv(rows));
  writeFileSync(join(out, `master-${day}.md`), toMarkdown(rows));
  console.log(`report: ${join(out, `master-${day}.csv`)} and .md`);
  process.exit(0);
}

let release = () => {};
try {
  release = takeLock(out);
} catch (e) {
  console.error(e.message);
  process.exit(3);
}
const stop = () => { release(); process.exit(130); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  await runMaster({
    items,
    dir: out,
    http,
    sites,
    batchSize: Math.max(1, Number(args.batch) || 8),
    gapMs: Math.max(0, Number(args['gap-min'] ?? 10)) * 60_000,
    missingPass: !args['no-missing'],
  });
} finally {
  release();
}
