/**
 * Web view + JSON API. Zero dependencies — node:http only.
 *
 * Bound to 127.0.0.1 by default: POST /api/compare drives a browser with
 * whatever basket it is handed, and there is no login. Inside Docker the
 * server listens on 0.0.0.0 but compose publishes it on 127.0.0.1 only.
 *
 * Comparisons go through a JobQueue: POST /api/compare answers 202 with a
 * jobId at once, progress streams over GET /api/events (SSE), and a second
 * request queues behind the first instead of being refused. Route and event
 * shapes are documented in docs/API.md.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { PAGE_FILE, PKG_ROOT, DATA_DIR } from './paths.js';
import { join as pjoin } from 'node:path';
import { resolveBasket } from './resolver.js';
import { getLimiter } from './limits.js';
import { LoginManager, LOGIN_SITES, tabDriver } from './engine/login.js';
import { saveResult, loadResult } from './ui-writer.js';
import { compareBasket, DEFAULT_PINCODE } from './compare.js';
import { PLATFORMS, ALL_PLATFORMS } from './platforms.js';
import { CONFIDENCE_THRESHOLD } from './normalize.js';
import { JobQueue } from './jobs.js';
import { loadConfig, saveConfig, validateConfig, completeConfig } from './config.js';
import { SITES } from './engine/sites/index.js';
import { CATEGORIES, canonicalQuery, describeQuery, listProducts, productsMatching } from './catalog.js';

const DEFAULT_PORT = 7777;
const PORT_ATTEMPTS = 10;
const MAX_BODY = 256 * 1024;
const KEEP_RESULTS = 20;
const SETTINGS_FILE = join(PKG_ROOT, 'src', 'ui', 'settings.html');

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw Object.assign(new Error('Body must be JSON.'), { status: 400 });
  }
}

function html(res, file) {
  if (!existsSync(file)) return json(res, 404, { error: 'page not found' });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(readFileSync(file, 'utf8'));
}

/**
 * @param {object} [opts]
 * @param {number} [opts.port]
 * @param {string} [opts.host]         default 127.0.0.1
 * @param {(args: object) => Promise<object>} [opts.compare] injectable for tests
 * @param {JobQueue} [opts.queue]      share a queue with the scheduler
 * @param {object} [opts.store]        history/job store (src/store.js)
 * @param {() => object} [opts.getConfig]
 * @param {(cfg: object) => void} [opts.setConfig]
 * @param {(result: object) => void} [opts.saveLatest]  persist the newest result
 * @param {() => object|null} [opts.loadLatest]
 * @param {(opts: object) => Promise<object>} [opts.cachedCompare] history-first compare (tests)
 * @param {import('./limits.js').SiteLimiter} [opts.limiter]  request budget shared with the engine
 * @param {LoginManager} [opts.login]   mobile + OTP sign-ins (default: uses the engine's Chrome)
 * @param {string} [opts.dataDir]
 * @param {{ status(): object, runOnce(o?: object): object }} [opts.sweep]  catalogue sweep (src/sweep.js)
 * @returns {Promise<{url: string, port: number, queue: JobQueue, close: () => Promise<void>}>}
 */
export function startServer({
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  compare = compareBasket,
  queue,
  store = null,
  getConfig = loadConfig,
  setConfig = saveConfig,
  saveLatest = saveResult,
  loadLatest = loadResult,
  cachedCompare = (opts) => compareBasket({ ...opts, cached: true }),
  limiter = null,
  login = null,
  dataDir = DATA_DIR,
  sweep = null,
} = {}) {
  const budget = () => limiter ?? getLimiter(getConfig().limits);
  let loginManager = login;
  const logins = () =>
    (loginManager ??= new LoginManager({
      file: pjoin(dataDir, 'sessions.json'),
      getDriver: async (siteId) => tabDriver(await (await import('./engine/pool.js')).getPool({ location: getConfig().location }).tab(siteId)),
    }));
  const q = queue ?? new JobQueue({ run: compare, store });
  const results = new Map(); // jobId -> result (most recent KEEP_RESULTS)
  const jobs = new Map(); // jobId -> summary, used when there is no store
  const clients = new Set();
  let latestJobId = null;

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  const jobInfo = (id) => store?.getJob?.(id) ?? jobs.get(id) ?? null;

  const onProgress = (jobId, event) => broadcast('progress', { jobId, event });
  const onDone = (jobId, outcome) => {
    const ok = !(outcome instanceof Error);
    const j = jobs.get(jobId);
    if (j) Object.assign(j, { status: ok ? 'done' : outcome.message === 'cancelled' ? 'cancelled' : 'failed', finishedAt: new Date().toISOString(), error: ok ? null : outcome.message });
    if (ok && outcome) {
      results.set(jobId, outcome);
      latestJobId = jobId;
      while (results.size > KEEP_RESULTS) results.delete(results.keys().next().value);
      saveLatest(outcome);
    }
    broadcast('done', { jobId, ok, error: ok ? undefined : outcome.message });
    broadcast('job', jobInfo(jobId));
  };
  q.on('progress', onProgress);
  q.on('done', onDone);

  function enqueue({ items, sites, trigger = 'manual' }) {
    const id = q.enqueue({ items, sites, trigger });
    if (!store) jobs.set(id, { id, status: 'queued', trigger, sites: sites ?? [], createdAt: new Date().toISOString() });
    queueMicrotask(() => broadcast('job', jobInfo(id)));
    return id;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;

    try {
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) return html(res, PAGE_FILE);
      if (req.method === 'GET' && (path === '/settings' || path === '/settings.html')) return html(res, SETTINGS_FILE);

      if (req.method === 'GET' && path === '/health') {
        return json(res, 200, { ok: true, service: 'basket', busy: q.current() !== null, queued: q.pending().length });
      }

      if (req.method === 'GET' && path === '/api/meta') {
        const cfg = getConfig();
        return json(res, 200, {
          platforms: ALL_PLATFORMS,
          labels: Object.fromEntries(ALL_PLATFORMS.map((p) => [p, SITES[p]?.label ?? p])),
          modes: Object.fromEntries(ALL_PLATFORMS.map((p) => [p, SITES[p]?.mode ?? 'dom'])),
          skipped: Object.fromEntries(ALL_PLATFORMS.filter((p) => SITES[p]?.skip).map((p) => [p, SITES[p].skip])),
          defaultPlatforms: cfg.sites?.length ? cfg.sites : PLATFORMS,
          defaultPincode: cfg.location?.pincode || DEFAULT_PINCODE,
          location: cfg.location,
          basket: cfg.basket,
          confidenceThreshold: CONFIDENCE_THRESHOLD,
          busy: q.current() !== null,
        });
      }

      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ current: q.current(), pending: q.pending() })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }

      if (req.method === 'GET' && path === '/api/result') {
        const id = url.searchParams.get('jobId');
        const result = id ? results.get(Number(id)) : (latestJobId != null ? results.get(latestJobId) : null) ?? loadLatest();
        if (!result) {
          // 204 rather than an empty object: the page shows its empty state.
          res.writeHead(204, { 'cache-control': 'no-store' });
          res.end();
          return;
        }
        return json(res, 200, result);
      }

      if (req.method === 'GET' && path === '/api/jobs') {
        const limit = Math.min(100, Number(url.searchParams.get('limit')) || 20);
        const list = store?.listJobs ? store.listJobs(limit) : [...jobs.values()].reverse().slice(0, limit);
        return json(res, 200, { current: q.current(), pending: q.pending(), jobs: list });
      }

      if (req.method === 'GET' && path === '/api/history') {
        const query = String(url.searchParams.get('q') ?? '').trim();
        if (!query) return json(res, 400, { error: 'Pass ?q=<item>' });
        if (!store) return json(res, 200, { query, sites: {} });
        return json(res, 200, { query, sites: store.historyFor(query) });
      }

      if (req.method === 'GET' && path === '/api/suggest') {
        if (!store?.suggest) return json(res, 200, []);
        return json(res, 200, store.suggest(url.searchParams.get('q') ?? '', Number(url.searchParams.get('limit')) || 8));
      }

      if (req.method === 'GET' && path === '/api/lookup') {
        const q = String(url.searchParams.get('q') ?? '').trim();
        if (!q) return json(res, 400, { error: 'Pass ?q=<item>' });
        if (!store?.lookup) return json(res, 404, { error: 'No saved prices yet.' });
        let found = store.lookup(q);
        // "onion" -> the closest saved item containing it.
        const options = store.suggest(q, 6);
        if (!found && options.length) found = store.lookup(options[0].query);
        if (!found) return json(res, 404, { error: `No saved price for "${q}" yet. Run it once with Get fresh prices.`, options: [] });
        return json(res, 200, { ...found, options: options.filter((o) => o.query !== found.query) });
      }

      // Product catalogue: ?q= resolves a line ("kismis 500g" -> raisins 500g),
      // ?category= filters; with neither, the whole catalogue and its facets.
      if (req.method === 'GET' && path === '/api/catalog') {
        const term = String(url.searchParams.get('q') ?? '').trim();
        const category = String(url.searchParams.get('category') ?? '').trim();
        if (category && !CATEGORIES.includes(category)) return json(res, 400, { error: `Unknown category. Available: ${CATEGORIES.join(', ')}`, field: 'category' });
        if (term) {
          return json(res, 200, {
            query: term,
            canonical: canonicalQuery(term),
            product: describeQuery(term),
            suggestions: productsMatching(term, 10).filter((p) => !category || p.category === category).map(({ id, name, canonical, category: cat }) => ({ id, name, canonical, category: cat })),
          });
        }
        const products = listProducts({ category: category || undefined });
        return json(res, 200, { categories: CATEGORIES, count: products.length, products });
      }

      if (req.method === 'GET' && path === '/api/sweep') {
        if (!sweep) return json(res, 404, { error: 'The catalogue sweep runs only in the service (basket serve).' });
        return json(res, 200, sweep.status());
      }

      if (req.method === 'POST' && path === '/api/sweep/run') {
        if (!sweep) return json(res, 404, { error: 'The catalogue sweep runs only in the service (basket serve).' });
        const out = sweep.runOnce({ force: true });
        if (out.jobId != null) queueMicrotask(() => broadcast('job', jobInfo(out.jobId)));
        return json(res, out.jobId != null ? 202 : 200, out);
      }

      if (req.method === 'GET' && path === '/api/limits') return json(res, 200, budget().status(ALL_PLATFORMS));

      if (req.method === 'GET' && path === '/api/login') return json(res, 200, logins().status());

      if (req.method === 'POST' && path === '/api/login/start') {
        const b = await readJson(req);
        if (!LOGIN_SITES[b.site]) return json(res, 400, { error: `Sign-in is available for: ${Object.keys(LOGIN_SITES).join(', ')}`, field: 'site' });
        try {
          return json(res, 200, await logins().start(b.site, b.phone));
        } catch (e) {
          return json(res, e.kind === 'blocked' ? 429 : 400, { error: e.message, kind: e.kind ?? 'error' });
        }
      }

      if (req.method === 'POST' && path === '/api/login/verify') {
        const b = await readJson(req);
        if (!LOGIN_SITES[b.site]) return json(res, 400, { error: 'Unknown site', field: 'site' });
        try {
          return json(res, 200, await logins().verify(b.site, b.otp));
        } catch (e) {
          return json(res, 400, { error: e.message, kind: e.kind ?? 'error' });
        }
      }

      if (req.method === 'GET' && path === '/api/config') return json(res, 200, getConfig());

      if (req.method === 'PUT' && path === '/api/config') {
        const body = await readJson(req);
        const cfg = completeConfig({ ...getConfig(), ...body });
        const problem = validateConfig(cfg, ALL_PLATFORMS);
        if (problem) return json(res, 400, problem);
        setConfig(cfg);
        return json(res, 200, getConfig());
      }

      if (req.method === 'POST' && path === '/api/stop') {
        const body = await readJson(req).catch(() => ({}));
        const id = body.jobId != null ? Number(body.jobId) : q.current()?.id;
        if (id == null) return json(res, 200, { ok: true, stopped: false, message: 'No run in flight' });
        return json(res, 200, { ok: true, stopped: q.cancel(id), jobId: id });
      }

      if (req.method === 'POST' && path === '/api/compare') {
        const payload = await readJson(req);
        const items = String(payload.items ?? '').trim();
        if (!items) return json(res, 400, { error: 'No items given. Send { "items": "one per line" }.' });

        let platforms;
        if (Array.isArray(payload.platforms) && payload.platforms.length > 0) {
          platforms = payload.platforms.filter((p) => ALL_PLATFORMS.includes(p));
          if (platforms.length === 0) return json(res, 400, { error: `Unknown platforms. Available: ${ALL_PLATFORMS.join(', ')}` });
        }
        // History-first: answer from stored prices, no job, no site contacted.
        if (payload.mode === 'cached') {
          if (!store) return json(res, 400, { error: 'Saved prices are not available (no history store).' });
          return json(res, 200, await cachedCompare({ items, platforms, store, config: getConfig() }));
        }

        // Per-site request budget: a manual run that would hit a site that was just
        // searched (or is resting after a block) is told how long to wait, so the
        // page can count down instead of stalling. Scheduled runs never get here:
        // they queue directly and pace themselves inside the engine.
        const cfgNow = getConfig();
        const chosen = platforms ?? (cfgNow.sites?.length ? cfgNow.sites : ALL_PLATFORMS);
        const waits = chosen
          .filter((site) => !SITES[site]?.skip)
          .map((site) => ({ site, label: SITES[site]?.label ?? site, ...budget().check(site, 1) }))
          .filter((w) => !w.ok);
        if (waits.length) {
          const worst = waits.reduce((a, b) => (b.waitMs > a.waitMs ? b : a));
          res.setHeader('retry-after', String(Math.ceil(worst.waitMs / 1000)));
          return json(res, 429, {
            error: `${worst.label} needs a short pause (${worst.reason}).`,
            site: worst.site,
            label: worst.label,
            waitMs: worst.waitMs,
            waits: waits.map(({ site, label, waitMs, reason }) => ({ site, label, waitMs, reason })),
          });
        }

        // Jobs ahead of this one (0 = it starts right away).
        const ahead = (q.current() ? 1 : 0) + q.pending().length;
        const jobId = enqueue({ items, sites: platforms, trigger: payload.trigger === 'schedule' ? 'schedule' : 'manual' });
        return json(res, 202, { jobId, queued: ahead });
      }

      json(res, 404, { error: `No route for ${req.method} ${path}` });
    } catch (err) {
      json(res, err.status ?? 500, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryListen = (p) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < PORT_ATTEMPTS && p !== 0) {
          attempt += 1;
          tryListen(p + 1);
          return;
        }
        reject(err);
      });
      server.listen(p, host, () => {
        const actual = server.address().port;
        resolve({
          url: `http://${host === '0.0.0.0' || host === '127.0.0.1' ? 'localhost' : host}:${actual}`,
          port: actual,
          host,
          queue: q,
          enqueue,
          close: () =>
            new Promise((r) => {
              q.off('progress', onProgress);
              q.off('done', onDone);
              for (const c of clients) c.end();
              clients.clear();
              server.close(() => r());
            }),
        });
      });
    };

    tryListen(port);
  });
}
