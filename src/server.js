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
import { defaultLoginManager, LOGIN_SITES } from './engine/login.js';
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
const GUIDE_FILE = join(PKG_ROOT, 'src', 'ui', 'guide.html');
const UI_DIR = join(PKG_ROOT, 'src', 'ui');
// Shared stylesheet, theme switch, home-screen icons and the web app manifest.
// A fixed allow-list: no path from the request ever reaches the filesystem.
// Each is served at /<name> (the guide links them relatively) and at
// /ui/<name> (the compare and settings pages).
const STATIC = {
  '/theme.css': ['theme.css', 'text/css; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/favicon.svg': ['icon.svg', 'image/svg+xml'],
  '/apple-touch-icon.png': ['icon-180.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/favicon.ico': ['icon.svg', 'image/svg+xml'],
};
const staticFor = (path) => STATIC[path] ?? (path.startsWith('/ui/') ? STATIC[path.slice(3)] : undefined);

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
 * @param {import('./engine/login.js').LoginManager} [opts.login]   mobile + OTP sign-ins (default: uses the engine's Chrome)
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
  accounts = null,
  dataDir = DATA_DIR,
  sweep = null,
} = {}) {
  const budget = () => limiter ?? getLimiter(getConfig().limits);
  let loginManager = login;
  const logins = () =>
    (loginManager ??= defaultLoginManager({
      file: pjoin(dataDir, 'accounts.json'),
      legacyFile: pjoin(dataDir, 'sessions.json'),
      accounts: accounts ?? undefined,
      log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
      getLocation: () => getConfig().location,
      inUse: () => Boolean(q.current()),
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
    // An offer check is not a basket result: it must not replace the table.
    // (Nor are the AI labels.)
    const offers = ok && (outcome?.kind === 'offers' || outcome?.kind === 'ai-labels');
    if (ok && outcome) results.set(jobId, outcome);
    if (ok && outcome && !offers) {
      latestJobId = jobId;
      saveLatest(outcome);
    }
    while (results.size > KEEP_RESULTS) results.delete(results.keys().next().value);
    broadcast('done', { jobId, ok, error: ok ? undefined : outcome.message, ...(offers ? { kind: outcome.kind } : {}) });
    broadcast('job', jobInfo(jobId));
  };
  q.on('progress', onProgress);
  q.on('done', onDone);

  function enqueue({ items, sites, trigger = 'manual', only }) {
    const id = q.enqueue({ items, sites, trigger, ...(only ? { only } : {}) });
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
      if (req.method === 'GET' && (path === '/guide' || path === '/guide.html')) return html(res, GUIDE_FILE);
      if (req.method === 'GET' && staticFor(path)) {
        const [file, type] = staticFor(path);
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        res.end(readFileSync(join(UI_DIR, file)));
        return;
      }

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
        if (!sweep) return json(res, 404, { error: 'The catalogue sweep runs only in the service (jhola serve).' });
        return json(res, 200, sweep.status());
      }

      if (req.method === 'POST' && path === '/api/sweep/run') {
        if (!sweep) return json(res, 404, { error: 'The catalogue sweep runs only in the service (jhola serve).' });
        const out = sweep.runOnce({ force: true });
        if (out.jobId != null) queueMicrotask(() => broadcast('job', jobInfo(out.jobId)));
        return json(res, out.jobId != null ? 202 : 200, out);
      }

      if (req.method === 'GET' && path === '/api/limits') return json(res, 200, budget().status(ALL_PLATFORMS));

      if (req.method === 'GET' && path === '/api/login') return json(res, 200, logins().status());

      if (req.method === 'POST' && path === '/api/login/start') {
        const b = await readJson(req);
        if (!LOGIN_SITES[b.site]) return json(res, 400, { error: `Sign-in is available for: ${Object.keys(LOGIN_SITES).join(', ')}`, field: 'site' });
        // Answers at once; the site's page is driven in the background and the
        // popup polls GET /api/login for state (sending -> otp_sent | error).
        try {
          // `account` signs in an existing account (default main); `name` adds a new one.
          return json(res, 202, await logins().start(b.site, b.id ?? b.phone, { account: b.account ?? 'main', ...(b.name != null ? { name: b.name } : {}) }));
        } catch (e) {
          return json(res, e.kind === 'blocked' ? 429 : 400, { error: e.message, kind: e.kind ?? 'error' });
        }
      }

      if (req.method === 'POST' && path === '/api/login/verify') {
        const b = await readJson(req);
        if (!LOGIN_SITES[b.site]) return json(res, 400, { error: 'Unknown site', field: 'site' });
        try {
          // `password` for password sites (Amazon), `otp` otherwise; never logged or echoed.
          return json(res, 200, await logins().verify(b.site, b.password ?? b.otp, { account: b.account ?? 'main' }));
        } catch (e) {
          return json(res, 400, { error: e.message, kind: e.kind ?? 'error' });
        }
      }

      if (req.method === 'POST' && path === '/api/login/signout') {
        const b = await readJson(req);
        if (!LOGIN_SITES[b.site]) return json(res, 400, { error: 'Unknown site', field: 'site' });
        try {
          return json(res, 200, await logins().signOut(b.site, b.account ?? 'main'));
        } catch (e) {
          return json(res, e.code === 'busy' ? 409 : 400, { error: e.message, kind: e.kind ?? 'error' });
        }
      }

      // ✕ on a cell: this product is the wrong match for this item on this site.
      if (req.method === 'POST' && path === '/api/prices/reject') {
        const b = await readJson(req);
        if (!ALL_PLATFORMS.includes(b.site)) return json(res, 400, { error: 'Unknown site', field: 'site' });
        if (!String(b.query ?? '').trim() || !String(b.product ?? '').trim()) return json(res, 400, { error: 'Pass { site, query, product }' });
        if (!store?.rejectMatch) return json(res, 400, { error: 'No history store' });
        return json(res, 200, { ok: true, ...store.rejectMatch({ query: b.query, site: b.site, product: b.product }) });
      }

      // "Others": prices bought or seen elsewhere, entered by the user.
      if (path === '/api/entries') {
        if (!store?.addManualPrice) return json(res, 400, { error: 'No history store' });
        if (req.method === 'GET') return json(res, 200, store.listManualPrices(Number(url.searchParams.get('limit')) || 50));
        if (req.method === 'POST') {
          const b = await readJson(req);
          try {
            return json(res, 201, store.addManualPrice({
              query: b.item, product: b.product, price: b.price, packSize: b.packSize, packUnit: b.packUnit, pack: b.pack,
              seenAt: b.date, source: b.source,
            }));
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }
        if (req.method === 'DELETE') {
          const id = Number(url.searchParams.get('id'));
          if (!Number.isInteger(id)) return json(res, 400, { error: 'Pass ?id=' });
          return json(res, 200, store.removeManualPrice(id));
        }
      }

      // What sites publish about their fees (free-delivery minimum), from the offer check.
      if (req.method === 'GET' && path === '/api/siteinfo') return json(res, 200, store?.siteInfo ? store.siteInfo() : {});

      // Deals (80%+ off MRP), grouped by site; never part of a total.
      if (req.method === 'GET' && path === '/api/deals') {
        const minDiscountPct = getConfig().deals?.minDiscountPct ?? 80;
        if (!store?.currentDeals) return json(res, 200, { minDiscountPct, checkedAt: {}, groups: [], fromSearches: [], errors: [], offerLists: [] });
        // Account ids repeat across sites ('main', 'a2'), so names are looked up per site.
  // (A Milkbasket account whose offer check lost its session is marked signed out.)
        const deals = store.currentDeals({});
        const labelsOf = (site) => accounts?.labels(site) ?? { names: {}, hints: {} };
        const name = (site, id) => labelsOf(site).names[id] ?? (id === 'main' ? 'Main' : id);
        for (const d of [...deals.groups.flatMap((g) => g.deals), ...deals.fromSearches]) {
          d.seenBy = d.seenBy.map((x) => ({ ...x, name: name(d.site, x.account), hint: labelsOf(d.site).hints[x.account] ?? null }));
        }
        for (const e of deals.errors) e.name = name(e.site, e.account);
        return json(res, 200, { minDiscountPct, ...deals });
      }

      // "Check offers": a queued job (shares the queue, so no tab is shared with a search).
      if (req.method === 'POST' && path === '/api/offers/run') {
        const b = await readJson(req).catch(() => ({}));
        const cur = q.current();
        const queued = q.pending().find((j) => j.trigger === 'offers') ?? (cur?.trigger === 'offers' ? cur : null);
        if (queued) return json(res, 202, { jobId: queued.id, queued: 0, already: true });
        const ahead = (cur ? 1 : 0) + q.pending().length;
        const jobId = enqueue({ items: '', sites: Array.isArray(b.sites) && b.sites.length ? b.sites : undefined, trigger: 'offers' });
        return json(res, 202, { jobId, queued: ahead });
      }

      // Optional AI labels (src/ai/). The key is write-only: answers carry only a hint.
      if (path === '/api/ai' || path.startsWith('/api/ai/')) {
        const ai = await import('./ai/settings.js');
        const view = () => {
          const key = ai.readKey(dataDir);
          return { settings: ai.readAiSettings(dataDir), providers: ai.PROVIDERS, hasKey: Boolean(key), keyHint: ai.keyHint(key), file: ai.aiFile(dataDir), counts: store?.labelCounts?.() ?? null };
        };
        if (req.method === 'GET' && path === '/api/ai') return json(res, 200, view());
        if (req.method === 'PUT' && path === '/api/ai') {
          const b = await readJson(req);
          const patch = {};
          if ('enabled' in b) patch.enabled = Boolean(b.enabled);
          if (b.provider != null) {
            if (!ai.PROVIDERS[b.provider]) return json(res, 400, { error: `Provider must be one of: ${Object.keys(ai.PROVIDERS).join(', ')}`, field: 'provider' });
            patch.provider = b.provider;
          }
          if (b.baseUrl != null) {
            const u = String(b.baseUrl).trim();
            if (u && !/^https?:\/\/[^\s]+$/.test(u)) return json(res, 400, { error: 'The base URL must start with https:// (or http:// for a server on this network)', field: 'baseUrl' });
            patch.baseUrl = u;
          }
          if (b.model != null) patch.model = String(b.model).trim().slice(0, 200);
          ai.writeAiSettings(dataDir, patch);
          if (b.clearKey === true) ai.saveKey(dataDir, '');
          else if (typeof b.key === 'string' && b.key.trim()) ai.saveKey(dataDir, b.key);
          return json(res, 200, view());
        }
        if (req.method === 'POST' && path === '/api/ai/check') {
          const { checkConnection } = await import('./ai/label.js');
          return json(res, 200, await checkConnection({ settings: ai.readAiSettings(dataDir), key: ai.readKey(dataDir) }));
        }
        if (req.method === 'POST' && path === '/api/ai/run') {
          if (!ai.readAiSettings(dataDir).enabled) return json(res, 400, { error: 'Turn AI labels on first.' });
          const cur = q.current();
          const queued = q.pending().find((j) => j.trigger === 'ai-labels') ?? (cur?.trigger === 'ai-labels' ? cur : null);
          if (queued) return json(res, 202, { jobId: queued.id, queued: true });
          return json(res, 202, { jobId: enqueue({ items: '', sites: null, trigger: 'ai-labels' }), queued: Boolean(cur) });
        }
        return json(res, 404, { error: 'Unknown AI route' });
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
        // "Get for missing only": { only: { site: [item, …] } }, just the pairs without a saved price.
        let only = null;
        if (payload.mode === 'missing') {
          const lines = new Set(items.split('\n').map((l) => l.trim()).filter(Boolean));
          only = {};
          for (const [site, list] of Object.entries(payload.only ?? {})) {
            if (!ALL_PLATFORMS.includes(site) || SITES[site]?.skip || !Array.isArray(list)) continue;
            const picked = list.map(String).filter((x) => lines.has(x.trim()));
            if (picked.length) only[site] = picked;
          }
          if (!Object.keys(only).length) return json(res, 400, { error: 'Nothing is missing: every item has a saved price on the chosen sites.' });
        }
        const chosen = only ? Object.keys(only) : platforms ?? (cfgNow.sites?.length ? cfgNow.sites : ALL_PLATFORMS);
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
        const jobId = enqueue({ items, sites: only ? Object.keys(only) : platforms, trigger: payload.trigger === 'schedule' ? 'schedule' : 'manual', ...(only ? { only } : {}) });
        return json(res, 202, { jobId, queued: ahead, ...(only ? { pairs: Object.values(only).flat().length } : {}) });
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
