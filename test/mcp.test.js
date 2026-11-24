import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { TOOLS, callTool, makeClient } from '../src/mcp/tools.js';

/** A fake basket service: route table of `${method} ${path}` -> (body, url) => [status, json]. */
async function fakeService(routes) {
  const calls = [];
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, path: url.pathname, query: url.search, body });
    const h = routes[`${req.method} ${url.pathname}`];
    const [status, data] = h ? h(body, url) : [404, { error: 'no route' }];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 204 ? '' : JSON.stringify(data));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  return { baseUrl, calls, client: makeClient({ baseUrl }), close: () => new Promise((r) => srv.close(r)) };
}

const RESULT = (source = 'history') => ({
  source,
  pincode: '600045',
  elapsedMs: 1200,
  cachedRange: source === 'history' ? { oldest: '2026-11-17T07:00:00Z', newest: '2026-11-19T07:00:00Z' } : undefined,
  uncached: [],
  basket: [{ query: 'toor dal 1kg', qty: 1 }],
  platforms: [
    { platform: 'zepto', label: 'Zepto', total: 150, fulfilledLines: 1, totalLines: 1, lowConfidence: [],
      lines: [{ query: 'toor dal 1kg', lineTotal: 150, status: 'ok', product: { packLabel: '1kg' }, history: { change: 'down' } }] },
    { platform: 'kpn', label: 'KPN Fresh', total: 0, fulfilledLines: 0, totalLines: 1, failed: true, error: 'kpn: blocked', lines: [] },
  ],
  unavailable: [{ platform: 'kpn', label: 'KPN Fresh', error: 'kpn: blocked' }],
  winner: { platform: 'zepto', label: 'Zepto', total: 150 },
  runnerUp: null,
  saving: 0,
  likeForLike: true,
  feesKnown: false,
});

const noSleep = async () => {};
const textOf = (r) => r.content.map((c) => c.text).join('\n');

test('tool list: task-shaped tools, no sign-in tool', () => {
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(names, ['lookup_price', 'suggest_items', 'compare_basket', 'run_saved_basket', 'job_result', 'deals', 'site_status', 'open_basket_view']);
  assert.ok(!names.some((n) => /login|sign/.test(n)), 'OTPs stay in the web popup');
});

test('service down: plain message, isError', async () => {
  const client = makeClient({ baseUrl: 'http://127.0.0.1:1' });
  const r = await callTool('lookup_price', { item: 'onion' }, { client });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /isn't reachable at http:\/\/127\.0\.0\.1:1.*docker start jhola/s);
});

test('compare_basket defaults to saved prices (mode cached), shows ▼ and the fee caveat', async () => {
  const svc = await fakeService({ 'POST /api/compare': (b) => (b.mode === 'cached' ? [200, RESULT()] : [500, {}]) });
  try {
    const r = await callTool('compare_basket', { items: ['toor dal 1kg'], sites: ['zepto', 'kpn'] }, { client: svc.client });
    assert.equal(r.isError, undefined);
    assert.deepEqual(svc.calls[0].body, { items: 'toor dal 1kg', platforms: ['zepto', 'kpn'], mode: 'cached' });
    const t = textOf(r);
    assert.match(t, /Saved prices — pincode 600045/);
    assert.match(t, /₹150\.00 ▼ 1kg/);
    assert.match(t, /KPN Fresh: kpn: blocked/);
    assert.match(t, /goods only/);
  } finally {
    await svc.close();
  }
});

test('compare_basket fresh: submits a job and polls until the result is ready', async () => {
  let polls = 0;
  const svc = await fakeService({
    'POST /api/compare': () => [202, { jobId: 7, queued: 0 }],
    'GET /api/result': (_, url) => (url.searchParams.get('jobId') === '7' && ++polls >= 2 ? [200, RESULT('live')] : [204, null]),
    'GET /api/jobs': () => [200, { current: { id: 7 }, pending: [], jobs: [{ id: 7, status: 'running' }] }],
  });
  try {
    const r = await callTool('compare_basket', { items: 'toor dal 1kg', fresh: true }, { client: svc.client, sleep: noSleep });
    assert.equal(svc.calls[0].body.mode, undefined, 'live run is not cached');
    assert.match(textOf(r), /Live prices/);
    assert.match(textOf(r), /"jobId": 7/);
  } finally {
    await svc.close();
  }
});

test('compare_basket fresh over the limit: says how long and falls back to saved prices', async () => {
  const svc = await fakeService({
    'POST /api/compare': (b) =>
      b.mode === 'cached'
        ? [200, RESULT()]
        : [429, { error: 'Zepto needs a short pause (1/min).', waits: [{ site: 'zepto', label: 'Zepto', waitMs: 42_000, reason: '1/min' }] }],
  });
  try {
    const r = await callTool('compare_basket', { items: 'toor dal 1kg', fresh: true }, { client: svc.client, sleep: noSleep });
    const t = textOf(r);
    assert.match(t, /Zepto: wait 42 s/);
    assert.match(t, /Showing saved prices instead/);
    assert.equal(svc.calls.length, 2);
  } finally {
    await svc.close();
  }
});

test('fresh run that outlasts the wait returns the job id; job_result picks it up; failures are reported', async () => {
  let t = 0;
  let status = 'running';
  const svc = await fakeService({
    'POST /api/compare': () => [202, { jobId: 9, queued: 1 }],
    'GET /api/result': () => [204, null],
    'GET /api/jobs': () => [200, { current: null, pending: [{ id: 9 }], jobs: [{ id: 9, status, error: status === 'failed' ? 'boom' : null }] }],
  });
  const deps = { client: svc.client, sleep: async (ms) => { t += ms; }, now: () => t };
  try {
    const r = await callTool('compare_basket', { items: 'x', fresh: true, waitSeconds: 6 }, deps);
    assert.match(textOf(r), /Run 9 is still queued.*job_result/s);
    status = 'failed';
    const r2 = await callTool('job_result', { jobId: 9 }, deps);
    assert.equal(r2.isError, true);
    assert.match(textOf(r2), /Run 9 failed: boom/);
  } finally {
    await svc.close();
  }
});

test('lookup_price renders the 3-date trend, change and lowest; 404 suggests a live search', async () => {
  const svc = await fakeService({
    'GET /api/lookup': (_, url) =>
      url.searchParams.get('q') === 'onion'
        ? [404, { error: 'No saved price for "onion" yet.' }]
        : [200, {
            query: 'toor dal 1kg', per: '100 g', dates: ['2026-11-17', '2026-11-18', '2026-11-19'], options: [],
            sites: [{ site: 'zepto', rate: 15, lastPrice: 150, seenAt: '2026-11-19T07:00:00Z', pack: '1kg', product: 'Toor Dal', lowRate: 14, lowSeenAt: '2026-11-01T07:00:00Z',
              change: 'up', changePct: 3.4, trend: [{ rate: 14.5 }, null, { rate: 15 }] }],
          }],
  });
  try {
    const r = await callTool('lookup_price', { item: 'toor dal 1kg' }, { client: svc.client });
    const t = textOf(r);
    assert.match(t, /14\.5 → — → 15/);
    assert.match(t, /₹15\.00\/100 g ▲ \(\+3\.4%\)/);
    assert.match(t, /₹14\.00 on 2026-11-01/);
    const miss = await callTool('lookup_price', { item: 'onion' }, { client: svc.client });
    assert.equal(miss.isError, undefined);
    assert.match(textOf(miss), /fresh=true/);
  } finally {
    await svc.close();
  }
});

test('run_saved_basket uses the service basket; site_status merges limits and sign-ins', async () => {
  const svc = await fakeService({
    'GET /api/meta': () => [200, { basket: 'toor dal 1kg\nsugar 1kg', labels: { zepto: 'Zepto' }, skipped: {} }],
    'POST /api/compare': () => [202, { jobId: 3, queued: 0 }],
    'GET /api/result': () => [200, RESULT('live')],
    'GET /api/jobs': () => [200, { current: null, pending: [], jobs: [] }],
    'GET /api/limits': () => [200, { zepto: { ok: false, waitMs: 30_000, reason: '1/min', lastHour: 4 } }],
    'GET /api/login': () => [200, [{ id: 'zepto', label: 'Zepto', loggedIn: false, pending: false, state: 'idle', why: 'asks you to sign in' }]],
  });
  try {
    await callTool('run_saved_basket', {}, { client: svc.client, sleep: noSleep });
    assert.equal(svc.calls.find((c) => c.path === '/api/compare').body.items, 'toor dal 1kg\nsugar 1kg');
    const st = textOf(await callTool('site_status', {}, { client: svc.client }));
    assert.match(st, /Zepto: wait 30 s \(1\/min\) · 4 search/);
    assert.match(st, /Zepto: not signed in/);
  } finally {
    await svc.close();
  }
});

test('lookup_price fresh=true: one-item live run first, then the lookup; a rate limit stops before the lookup', async () => {
  let limited = false;
  const svc = await fakeService({
    'POST /api/compare': (b) =>
      b.mode === 'cached' ? [200, RESULT()]
        : limited ? [429, { error: 'Zepto needs a short pause.', waits: [{ label: 'Zepto', waitMs: 5000, reason: 'gap' }] }]
          : [202, { jobId: 4, queued: 0 }],
    'GET /api/result': () => [200, RESULT('live')],
    'GET /api/jobs': () => [200, { current: null, pending: [], jobs: [] }],
    'GET /api/lookup': () => [200, { query: 'toor dal 1kg', per: '100 g', dates: [], options: [], sites: [{ site: 'zepto', rate: 15, lastPrice: 150, lowRate: 15 }] }],
  });
  try {
    const r = await callTool('lookup_price', { item: 'toor dal 1kg', fresh: true }, { client: svc.client, sleep: noSleep });
    assert.deepEqual(svc.calls.map((c) => c.path).filter((p) => p !== '/api/jobs'), ['/api/compare', '/api/result', '/api/lookup']);
    assert.equal(svc.calls[0].body.items, 'toor dal 1kg');
    assert.match(textOf(r), /Searched the sites just now[\s\S]*Cheapest saved: zepto/);

    limited = true;
    svc.calls.length = 0;
    const w = await callTool('lookup_price', { item: 'toor dal 1kg', fresh: true }, { client: svc.client, sleep: noSleep });
    assert.match(textOf(w), /Zepto: wait 5 s/);
    assert.ok(!svc.calls.some((c) => c.path === '/api/lookup'));
  } finally {
    await svc.close();
  }
});

test('deals tool lists groups with conditions and accounts, and the not-in-totals note', async () => {
  const svc = await fakeService({
    'GET /api/deals': () => [200, {
      minDiscountPct: 80, checkedAt: { milkbasket: '2026-11-19T04:30:00.000Z' }, errors: [{ site: 'milkbasket', name: 'Amma', error: 'milkbasket: session expired' }],
      groups: [
        { site: 'milkbasket', checkedAt: '2026-11-19T04:30:00.000Z', conditions: { maxQty: 1, minBasket: 9 }, deals: [{ product: 'Tomato Desi', pack: '1050g', price: 1, mrp: 78, pct: 98.7, conditions: { maxQty: 1, minBasket: 9 }, seenBy: [{ name: 'Main' }, { name: 'Amma' }] }] },
        { site: 'bigbasket', storefront: 'Deals of the Week', anyDiscount: true, checkedAt: '2026-11-19T04:30:00.000Z', conditions: null,
          deals: Array.from({ length: 12 }, (_, i) => ({ product: `Item ${i}`, pack: null, price: 60, mrp: 100, pct: 40, conditions: i === 0 ? { maxQty: 3, dealType: 'price_drop' } : null, seenBy: [{ name: 'Main' }] })) },
      ],
      fromSearches: [],
    }],
  });
  try {
    const t = textOf(await callTool('deals', {}, { client: svc.client }));
    assert.match(t, /\*\*Deals\*\* \(not in totals\): 80%\+ off, and BigBasket's deal storefronts at any discount/);
    assert.match(t, /\*\*milkbasket\*\* \(80%\+ off, checked 10:00\) · max 1 item · basket ₹9\+/);
    assert.match(t, /\*\*bigbasket · Deals of the Week\*\* \(any discount, 12 items, checked 10:00\)/);
    assert.match(t, /Item 0: ₹60\.00 \(MRP ₹100\.00, 40% off\) · max 3 items · price drop/);
    assert.match(t, /… and 2 more \(see the page\)/);
    assert.match(t, /Tomato Desi · 1050g: ₹1\.00 \(MRP ₹78\.00, 99% off\).*seen by Main, Amma/);
    assert.match(t, /milkbasket · Amma: milkbasket: session expired/);
  } finally {
    await svc.close();
  }
});
