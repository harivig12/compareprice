/**
 * Platform search layer.
 *
 * Backends, same envelope:
 *   - "engine" (default): src/engine — one warm headless Chrome, one tab per
 *     site, site APIs called from inside the tab, self-healing retries and
 *     classified errors. See docs/ENGINE.md.
 *   - "webcmd" (legacy, BASKET_BACKEND=webcmd): shells out to
 *     `webcmd <site> search "<q>" -f json`.
 *   - "cdp" (legacy, BASKET_BACKEND=cdp): drives a Chrome you started on
 *     port 9222 with the src/extract/ DOM extractors.
 *
 * A platform that fails is recorded as unavailable and reported — never
 * silently dropped, because a missing platform that reads as an expensive
 * platform is how you lose a demo.
 */

import { execFile } from 'node:child_process';

import { searchViaBrowser, EXTRACTORS } from './extract/index.js';
import { browserAvailable } from './browser.js';
import { SITE_IDS } from './engine/sites/index.js';

/** Platforms in play when neither the caller nor config.json picks any.
 *  All have working guest in-page APIs (recon 2026-11-18). Amazon (page
 *  scrape) is opt-in; milkbasket is skipped (app-only). */
export const PLATFORMS = ['instamart', 'bigbasket', 'zepto', 'blinkit', 'kpn', 'jiomart', 'flipkart_minutes'];

/** Every platform a user can pick. */
export const ALL_PLATFORMS = SITE_IDS;

// The webcmd path drives a real browser through the daemon, which is slower
// than talking to CDP ourselves — a cold page can take well over a minute.
const CALL_TIMEOUT_MS = 120_000;
const CONCURRENCY = 1; // one tab at a time — venue wifi drops parallel loads

const REQUIRED_FIELDS = ['name', 'packSize', 'packUnit', 'price', 'mrp', 'inStock', 'url'];

function runWebcmd(args, { timeout = CALL_TIMEOUT_MS } = {}) {
  // On Windows `webcmd` is a .cmd shim, so execFile needs a shell — but a shell
  // re-splits the arguments, turning `--query "tata salt 1kg"` into three
  // tokens. Quote anything with whitespace before it gets there.
  const useShell = process.platform === 'win32';
  const finalArgs = useShell
    ? args.map((a) => (/[\s"]/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a)))
    : args;

  return new Promise((resolve, reject) => {
    execFile(
      'webcmd',
      finalArgs,
      { timeout, maxBuffer: 8 * 1024 * 1024, shell: useShell },
      (err, stdout, stderr) => {
        if (err) {
          const msg = err.killed
            ? `timed out after ${timeout}ms`
            : (stderr || err.message || '').trim().split('\n')[0];
          reject(new Error(msg));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function extractRows(parsed) {
  if (Array.isArray(parsed)) return parsed;
  for (const key of ['rows', 'results', 'data']) {
    if (parsed && Array.isArray(parsed[key])) return parsed[key];
  }
  return null;
}

function validateRow(row, platform) {
  const missing = REQUIRED_FIELDS.filter((f) => !(f in row));
  if (missing.length > 0) {
    throw new Error(`${platform} row missing fields: ${missing.join(', ')}`);
  }
  return {
    name: String(row.name),
    packSize: row.packSize == null ? null : Number(row.packSize),
    packUnit: row.packUnit == null ? null : String(row.packUnit),
    price: Number(row.price),
    mrp: row.mrp == null ? null : Number(row.mrp),
    inStock: Boolean(row.inStock),
    url: String(row.url),
  };
}

/** Is a compiled webcmd adapter installed and is the bridge alive? */
async function webcmdReady() {
  try {
    const stdout = await runWebcmd(['list', '-f', 'json'], { timeout: 8000 });
    const list = JSON.parse(stdout);
    return Array.isArray(list) && list.some((c) => PLATFORMS.includes(c.site));
  } catch {
    return false;
  }
}

/**
 * Pick a backend once per run. The engine is the default; the legacy
 * backends are only used when BASKET_BACKEND asks for them, and fail loudly
 * when their prerequisites are missing instead of silently swapping.
 */
export async function selectBackend(env = process.env) {
  const want = String(env.BASKET_BACKEND || 'engine').toLowerCase();
  if (want === 'webcmd') {
    if (await webcmdReady()) return 'webcmd';
    throw new Error('BASKET_BACKEND=webcmd but no webcmd adapters are installed (run `jhola setup`).');
  }
  if (want === 'cdp') {
    if (await browserAvailable()) return 'cdp';
    throw new Error('BASKET_BACKEND=cdp but no Chrome answers on the CDP endpoint (start Chrome with --remote-debugging-port=9222).');
  }
  return 'engine';
}

/** Legacy per-query search (webcmd / cdp). The engine uses src/engine/run.js. */
export async function searchOne(platform, query, backend) {
  if (backend === 'webcmd') {
    // Adapters declare `query` as a named arg, not a positional.
    const stdout = await runWebcmd([platform, 'search', '--query', query, '-f', 'json']);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`${platform} returned non-JSON output`);
    }
    const rows = extractRows(parsed);
    if (rows === null) throw new Error(`${platform} returned an unexpected shape`);
    return rows.map((r) => validateRow(r, platform));
  }

  if (backend === 'cdp') {
    return searchViaBrowser(platform, query);
  }

  throw new Error(`${platform}: unknown backend "${backend}"`);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function searchPlatform(platform, queries, { backend, onProgress, signal } = {}) {
  const resultsByQuery = {};
  const failures = [];

  await mapLimit(queries, CONCURRENCY, async (query) => {
    if (signal?.aborted) throw new Error('Operation aborted');
    onProgress?.(platform, query);
    try {
      resultsByQuery[query] = await searchOne(platform, query, backend);
    } catch (err) {
      resultsByQuery[query] = [];
      failures.push(`${query}: ${err.message}`);
    }
  });

  const allFailed = failures.length === queries.length && queries.length > 0;

  return {
    platform,
    available: !allFailed,
    error: allFailed ? failures[0] : null,
    partialFailures: allFailed ? [] : failures,
    resultsByQuery,
  };
}

/**
 * Search every query on every platform. Platforms run sequentially: they share
 * one browser, and parallel tabs on venue wifi produced navigation failures.
 */
export async function searchAll(queries, { platforms = PLATFORMS, backend, onProgress, signal } = {}) {
  const out = [];
  for (const p of platforms) {
    if (signal?.aborted) throw new Error('Operation aborted');
    out.push(await searchPlatform(p, queries, { backend, onProgress, signal }));
  }
  return out;
}
