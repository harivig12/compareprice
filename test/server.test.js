/**
 * Server routes. Never touches the network: `compare` is injected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect the data dir before anything imports paths.js.
const TMP = mkdtempSync(join(tmpdir(), 'basket-test-'));
process.env.BASKET_HOME = TMP;

const { startServer } = await import('../src/server.js');

const FAKE_RESULT = {
  pincode: '600045',
  backend: 'fake',
  generatedAt: new Date().toISOString(),
  elapsedMs: 10,
  confidenceThreshold: 0.55,
  basket: [{ raw: 'tata salt 1kg', query: 'tata salt 1kg', qty: 1 }],
  platforms: [],
  unavailable: [],
  winner: null,
  runnerUp: null,
  saving: 0,
  likeForLike: true,
  feesAsOf: 'test',
  feesVerified: false,
};

async function withServer(fn, compare = async () => FAKE_RESULT) {
  // Port 0 → OS picks a free one, so tests never collide with a real server.
  const server = await startServer({ port: 0, compare });
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

test('binds to loopback only', async () => {
  await withServer((s) => {
    assert.match(s.url, /^http:\/\/localhost:\d+$/);
    assert.ok(s.port > 0);
  });
});

test('GET /health reports ok', async () => {
  await withServer(async (s) => {
    const res = await fetch(`${s.url}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.busy, false);
  });
});

test('GET /api/meta exposes platforms and defaults', async () => {
  await withServer(async (s) => {
    const body = await (await fetch(`${s.url}/api/meta`)).json();
    assert.ok(Array.isArray(body.platforms));
    assert.ok(body.platforms.includes('blinkit'));
    assert.ok(Array.isArray(body.defaultPlatforms));
    assert.equal(typeof body.confidenceThreshold, 'number');
  });
});

test('GET /api/result is 204 when nothing has been compared', async () => {
  rmSync(join(TMP, 'last-result.json'), { force: true });
  await withServer(async (s) => {
    const res = await fetch(`${s.url}/api/result`);
    assert.equal(res.status, 204);
  });
});

test('GET / serves the page', async () => {
  await withServer(async (s) => {
    const res = await fetch(`${s.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /<title>Jhola/);
    assert.match(html, /rel="manifest" href="\/ui\/manifest.webmanifest"/);
  });
});

test('the Jhola icons and manifest are served with the right types (Add to home screen)', async () => {
  await withServer(async (s) => {
    const man = await fetch(`${s.url}/ui/manifest.webmanifest`);
    assert.match(man.headers.get('content-type'), /application\/manifest\+json/);
    const m = await man.json();
    assert.equal(m.short_name, 'Jhola');
    for (const icon of m.icons) {
      const r = await fetch(`${s.url}${icon.src}`);
      assert.equal(r.status, 200, icon.src);
      assert.equal(r.headers.get('content-type').split(';')[0], icon.type, icon.src);
      const buf = Buffer.from(await r.arrayBuffer());
      if (icon.type === 'image/png') assert.equal(buf.subarray(1, 4).toString(), 'PNG', `${icon.src} is a real PNG, not text`);
    }
    assert.equal((await fetch(`${s.url}/ui/apple-touch-icon.png`)).status, 200);
    assert.equal((await fetch(`${s.url}/ui/../server.js`)).status, 404, 'still a whitelist');
  });
});

test('POST /api/compare rejects an empty basket with 400', async () => {
  await withServer(async (s) => {
    const res = await fetch(`${s.url}/api/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: '   ' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /No items/i);
  });
});

test('POST /api/compare rejects non-JSON with 400', async () => {
  await withServer(async (s) => {
    const res = await fetch(`${s.url}/api/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    assert.equal(res.status, 400);
  });
});

async function post(s, path, body) {
  return fetch(`${s.url}${path}`, {
    method: path === '/api/config' ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Read SSE frames until `until(event, data)` is true (or timeout). */
async function sse(s, until, timeoutMs = 3000) {
  const ctl = new AbortController();
  const res = await fetch(`${s.url}/api/events`, { signal: ctl.signal });
  const reader = res.body.getReader();
  const seen = [];
  let buf = '';
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, k);
        buf = buf.slice(k + 2);
        const ev = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (!ev) continue;
        const parsed = data ? JSON.parse(data) : null;
        seen.push([ev, parsed]);
        if (until(ev, parsed)) return seen;
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return seen;
}

test('POST /api/compare queues (202 + jobId), persists, and /api/result returns it', async () => {
  await withServer(async (s) => {
    const res = await post(s, '/api/compare', { items: 'tata salt 1kg' });
    assert.equal(res.status, 202);
    const { jobId } = await res.json();
    assert.equal(typeof jobId, 'number');
    await new Promise((r) => setTimeout(r, 50));

    const byJob = await fetch(`${s.url}/api/result?jobId=${jobId}`);
    assert.equal(byJob.status, 200);
    assert.equal((await byJob.json()).backend, 'fake');
    // Saved, so a browser tab polling /api/result sees it.
    const latest = await fetch(`${s.url}/api/result`);
    assert.equal((await latest.json()).backend, 'fake');
  });
});

test('a second comparison while one runs is queued, not refused', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let runs = 0;
  await withServer(
    async (s) => {
      const a = await (await post(s, '/api/compare', { items: 'milk' })).json();
      await new Promise((r) => setTimeout(r, 30));
      const second = await post(s, '/api/compare', { items: 'bread' });
      assert.equal(second.status, 202);
      const b = await second.json();
      assert.notEqual(a.jobId, b.jobId);
      const jobs = await (await fetch(`${s.url}/api/jobs`)).json();
      assert.equal(jobs.current.id, a.jobId);
      assert.deepEqual(jobs.pending.map((j) => j.id), [b.jobId]);
      release();
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(runs, 2, 'both ran, one after the other');
    },
    async () => { runs++; if (runs === 1) await gate; return FAKE_RESULT; },
  );
});

test('/api/events streams progress then done for a job', async () => {
  await withServer(
    async (s) => {
      const watching = sse(s, (ev) => ev === 'done');
      await new Promise((r) => setTimeout(r, 50));
      const { jobId } = await (await post(s, '/api/compare', { items: 'toor dal' })).json();
      const seen = await watching;
      const progress = seen.find(([ev]) => ev === 'progress');
      assert.ok(progress, 'progress event');
      assert.equal(progress[1].jobId, jobId);
      assert.deepEqual(progress[1].event, { type: 'query', site: 'zepto', query: 'toor dal', index: 1, total: 1 });
      const done = seen.find(([ev]) => ev === 'done');
      assert.deepEqual(done[1], { jobId, ok: true });
    },
    async ({ onProgress }) => {
      onProgress({ type: 'query', site: 'zepto', query: 'toor dal', index: 1, total: 1 });
      return FAKE_RESULT;
    },
  );
});

test('PUT /api/config validates schedule times and saves good input', async () => {
  await withServer(async (s) => {
    const bad = await post(s, '/api/config', { schedules: [{ name: 'x', sites: ['zepto'], times: ['25:00'] }] });
    assert.equal(bad.status, 400);
    const err = await bad.json();
    assert.equal(err.field, 'schedules[0].times');
    assert.match(err.error, /25:00/);

    const badSite = await post(s, '/api/config', { sites: ['nosuch'] });
    assert.equal(badSite.status, 400);
    assert.equal((await badSite.json()).field, 'sites');

    const good = await post(s, '/api/config', { schedules: [{ name: 'am', sites: ['zepto'], times: ['07:00', '09:00'] }] });
    assert.equal(good.status, 200);
    const cfg = await (await fetch(`${s.url}/api/config`)).json();
    assert.deepEqual(cfg.schedules[0].times, ['07:00', '09:00']);
    assert.equal(cfg.location.pincode, '600045', 'defaults are kept');
  });
});

test('GET /api/history needs ?q= and answers JSON', async () => {
  await withServer(async (s) => {
    assert.equal((await fetch(`${s.url}/api/history`)).status, 400);
    const res = await fetch(`${s.url}/api/history?q=toor%20dal`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { query: 'toor dal', sites: {} });
  });
});

test('POST /api/stop with nothing running says so', async () => {
  await withServer(async (s) => {
    const body = await (await post(s, '/api/stop', {})).json();
    assert.equal(body.stopped, false);
  });
});

test('POST /api/compare mode=cached answers 200 from history at once, without queueing a job', async () => {
  let liveRuns = 0;
  let cachedArgs;
  const server = await startServer({
    port: 0,
    compare: async () => { liveRuns++; return FAKE_RESULT; },
    store: { listJobs: () => [], getJob: () => null, createJob: () => 1, updateJob() {}, historyFor: () => ({}) },
    cachedCompare: async (opts) => { cachedArgs = opts; return { ...FAKE_RESULT, source: 'history', cachedRange: null }; },
  });
  try {
    const res = await post(server, '/api/compare', { items: 'toor dal 1kg', platforms: ['zepto'], mode: 'cached' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).source, 'history');
    assert.equal(cachedArgs.items, 'toor dal 1kg');
    assert.deepEqual(cachedArgs.platforms, ['zepto']);
    assert.ok(cachedArgs.store && cachedArgs.config, 'store and config passed through');
    assert.equal(liveRuns, 0, 'no live run');
    const jobs = await (await fetch(`${server.url}/api/jobs`)).json();
    assert.equal(jobs.current, null);
  } finally {
    await server.close();
  }
});

test('mode=cached without a history store is a 400', async () => {
  await withServer(async (s) => {
    const res = await post(s, '/api/compare', { items: 'salt', mode: 'cached' });
    assert.equal(res.status, 400);
  });
});

test('a manual fresh run right after a search is told to wait (429 + retry-after), with the site and reason', async () => {
  const { SiteLimiter } = await import('../src/limits.js');
  let t = 1_000_000;
  const limiter = new SiteLimiter({ now: () => t, sleep: async (ms) => { t += ms; } });
  await limiter.acquire('zepto');
  const server = await startServer({ port: 0, compare: async () => FAKE_RESULT, limiter });
  try {
    const res = await post(server, '/api/compare', { items: 'toor dal 1kg', platforms: ['zepto', 'kpn'] });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '3');
    const body = await res.json();
    assert.equal(body.site, 'zepto');
    assert.equal(body.label, 'Zepto');
    assert.equal(body.waitMs, 2500);
    assert.match(body.error, /Zepto needs a short pause \(a search just ran\)/);
    assert.deepEqual(body.waits.map((w) => w.site), ['zepto'], 'kpn is fine');
    // After the wait, it is accepted.
    t += 2500;
    assert.equal((await post(server, '/api/compare', { items: 'toor dal 1kg', platforms: ['zepto', 'kpn'] })).status, 202);
    // Saved-price lookups never count against a site.
    assert.equal((await post(server, '/api/compare', { items: 'toor dal 1kg', platforms: ['zepto'], mode: 'cached' })).status, 400, 'no store in this test');
  } finally {
    await server.close();
  }
});

test('a site resting after a block is reported with its cool-down', async () => {
  const { SiteLimiter } = await import('../src/limits.js');
  const limiter = new SiteLimiter();
  limiter.penalize('bigbasket', 'bot protection page');
  const server = await startServer({ port: 0, compare: async () => FAKE_RESULT, limiter });
  try {
    const res = await post(server, '/api/compare', { items: 'sugar 1kg', platforms: ['bigbasket'] });
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /BigBasket needs a short pause \(bot protection page; resting 30 min\)/);
    const limits = await (await fetch(`${server.url}/api/limits`)).json();
    assert.equal(limits.bigbasket.ok, false);
    assert.ok(limits.bigbasket.cooldownMs > 0);
    assert.equal(limits.zepto.ok, true);
  } finally {
    await server.close();
  }
});

test('GET /api/suggest and /api/lookup answer from saved prices', async () => {
  const rows = [{ query: 'onion 1kg', sites: 3, seenAt: '2026-11-19T01:00:00.000Z' }];
  const lookup = { query: 'onion 1kg', per: '100 g', sites: [{ site: 'blinkit', rate: 6.9, lastPrice: 69, seenAt: '2026-11-19T01:00:00.000Z', lowRate: 6, lowSeenAt: '2026-11-16T01:00:00.000Z', pack: '1000g', product: 'Onion' }] };
  const store = { listJobs: () => [], getJob: () => null, createJob: () => 1, updateJob() {}, historyFor: () => ({}), suggest: (q) => (/oni/.test(q) ? rows : []), lookup: (q) => (/onion/.test(q) ? lookup : null) };
  const server = await startServer({ port: 0, compare: async () => FAKE_RESULT, store });
  try {
    assert.deepEqual(await (await fetch(`${server.url}/api/suggest?q=oni`)).json(), rows);
    const ok = await (await fetch(`${server.url}/api/lookup?q=onion%201kg`)).json();
    assert.equal(ok.per, '100 g');
    assert.equal(ok.sites[0].rate, 6.9);
    const fuzzy = await (await fetch(`${server.url}/api/lookup?q=onion`)).json();
    assert.equal(fuzzy.query, 'onion 1kg', '"onion" resolves to the closest saved item');
    const none = await fetch(`${server.url}/api/lookup?q=truffle`);
    assert.equal(none.status, 404);
    assert.match((await none.json()).error, /No saved price for "truffle"/);
    assert.equal((await fetch(`${server.url}/api/lookup`)).status, 400);
  } finally {
    await server.close();
  }
});

test('login routes: start, verify and status go through the manager; bad input is a 400', async () => {
  const calls = [];
  const login = {
    status: () => [{ id: 'milkbasket', label: 'Milkbasket', loggedIn: false, pending: false }],
    start: async (site, phone) => { calls.push(['start', site, phone]); return { step: 'otp', message: 'OTP sent' }; },
    verify: async (site, otp) => {
      calls.push(['verify', site, otp]);
      if (otp === '000000') throw Object.assign(new Error('milkbasket: the site rejected that OTP'), { kind: 'session' });
      return { loggedIn: true };
    },
  };
  const server = await startServer({ port: 0, compare: async () => FAKE_RESULT, login });
  try {
    assert.equal((await (await fetch(`${server.url}/api/login`)).json())[0].id, 'milkbasket');
    const started = await post(server, '/api/login/start', { site: 'milkbasket', phone: '9800000000' });
    assert.equal(started.status, 202, 'answers at once; the OTP step runs in the background');
    assert.deepEqual(await started.json(), { step: 'otp', message: 'OTP sent' });
    assert.equal((await post(server, '/api/login/start', { site: 'kpn', phone: '9800000000' })).status, 400);
    const bad = await post(server, '/api/login/verify', { site: 'milkbasket', otp: '000000' });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'milkbasket: the site rejected that OTP', kind: 'session' });
    assert.deepEqual(await (await post(server, '/api/login/verify', { site: 'milkbasket', otp: '123456' })).json(), { loggedIn: true });
    assert.deepEqual(calls.map((c) => c[0]), ['start', 'verify', 'verify']);
  } finally {
    await server.close();
  }
});

test('accounts: start with a name adds an account; signout of a busy account is 409; deals and offers routes', async () => {
  const calls = [];
  const login = {
    status: () => [],
    start: (site, id, opts) => { calls.push(['start', site, opts]); return { state: 'sending', message: 'm', account: opts.name ? 'a2' : opts.account }; },
    verify: async (site, secret, opts) => { calls.push(['verify', site, opts]); return { loggedIn: true }; },
    signOut: async (site, account) => {
      if (account === 'a2') { const e = new Error('instamart: busy, try again after the current run'); e.code = 'busy'; e.kind = 'session'; throw e; }
      return { signedOut: true, removed: false, account };
    },
  };
  const store = {
    currentDeals: () => ({ checkedAt: { milkbasket: '2026-11-19T10:00:00.000Z' }, groups: [{ site: 'milkbasket', conditions: { maxQty: 1 }, deals: [{ site: 'milkbasket', product: 'Tomato Desi', price: 1, mrp: 78, pct: 98.7, seenBy: [{ account: 'a2', seenAt: 't' }] }] }], fromSearches: [], errors: [] }),
    listJobs: () => [],
    createJob: () => 41,
    updateJob: () => {},
    getJob: () => null,
  };
  const accounts = { labels: () => ({ names: { main: 'Main', a2: 'Amma' }, hints: { a2: '••••••1234' } }) };
  const queue = { enqueue: () => 42, current: () => null, pending: () => [], on: () => {}, off: () => {} };
  const server = await startServer({ port: 0, compare: async () => FAKE_RESULT, login, store, accounts, queue });
  try {
    const r = await post(server, '/api/login/start', { site: 'instamart', id: '9800001234', name: 'Amma' });
    assert.equal(r.status, 202);
    assert.equal((await r.json()).account, 'a2');
    await post(server, '/api/login/verify', { site: 'instamart', otp: '123456', account: 'a2' });
    assert.deepEqual(calls.map((c) => [c[0], c[2]]), [['start', { account: 'main', name: 'Amma' }], ['verify', { account: 'a2' }]]);

    const busy = await post(server, '/api/login/signout', { site: 'instamart', account: 'a2' });
    assert.equal(busy.status, 409);
    assert.match((await busy.json()).error, /busy, try again after the current run/);
    assert.equal((await post(server, '/api/login/signout', { site: 'instamart' })).status, 200);

    const deals = await (await fetch(`${server.url}/api/deals`)).json();
    assert.equal(deals.minDiscountPct, 80);
    assert.deepEqual(deals.groups[0].deals[0].seenBy, [{ account: 'a2', seenAt: 't', name: 'Amma', hint: '••••••1234' }]);

    const run = await post(server, '/api/offers/run', {});
    assert.equal(run.status, 202);
    assert.equal((await run.json()).jobId, 42);
  } finally {
    await server.close();
  }
});

test('"Get for missing only": only the listed pairs are queued; unknown or nothing-missing is refused; ✕ reject route', async () => {
  const queued = [];
  const queue = { enqueue: (j) => { queued.push(j); return 7; }, current: () => null, pending: () => [], on: () => {}, off: () => {} };
  const rejected = [];
  const store = { rejectMatch: (x) => { rejected.push(x); return { deleted: 2 }; }, listJobs: () => [], createJob: () => 7, updateJob: () => {}, getJob: () => null };
  const server = await startServer({ port: 0, compare: async () => FAKE_RESULT, queue, store, limiter: { check: () => ({ ok: true }), status: () => ({}) } });
  try {
    const items = 'toor dal 1kg\nsugar 1kg';
    const ok = await post(server, '/api/compare', { items, mode: 'missing', only: { zepto: ['sugar 1kg', 'not in list'], nosuch: ['sugar 1kg'] } });
    assert.equal(ok.status, 202);
    assert.equal((await ok.json()).pairs, 1);
    assert.deepEqual(queued[0].only, { zepto: ['sugar 1kg'] });
    assert.deepEqual(queued[0].sites, ['zepto']);
    assert.equal((await post(server, '/api/compare', { items, mode: 'missing', only: {} })).status, 400);

    const r = await post(server, '/api/prices/reject', { site: 'milkbasket', query: 'sugar 1kg', product: 'Low Sugar Potato 1 kg' });
    assert.deepEqual(await r.json(), { ok: true, deleted: 2 });
    assert.equal((await post(server, '/api/prices/reject', { site: 'nosuch', query: 'x', product: 'y' })).status, 400);
  } finally {
    await server.close();
  }
});

test('theme assets are served, and nothing else under src/ui', async () => {
  await withServer(async (s) => {
    const css = await fetch(`${s.url}/ui/theme.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.match(await css.text(), /data-theme="light"/);
    const js = await fetch(`${s.url}/ui/theme.js`);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(`${s.url}/ui/basket.html`)).status, 404);
    assert.equal((await fetch(`${s.url}/ui/../server.js`)).status, 404);
    const page = await (await fetch(`${s.url}/`)).text();
    assert.match(page, /\/ui\/theme\.js/);
  });
});

test('unknown routes 404 as JSON', async () => {
  await withServer(async (s) => {
    const res = await fetch(`${s.url}/nope`);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /No route/);
  });
});

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
});
