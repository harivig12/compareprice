import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSearch } from '../src/engine/run.js';
import { BrowserPool } from '../src/engine/pool.js';
import { SiteError } from '../src/engine/errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const row = (name = 'Toor Dal 1 kg') => ({
  name, packSize: 1000, packUnit: 'g', price: 100, mrp: 120, inStock: true, url: 'https://x/y',
});

function fakePool() {
  const refreshed = [];
  return {
    refreshed,
    tab: async (id) => ({ id, alive: true }),
    refresh: async (id) => { refreshed.push(id); },
  };
}

function collect() {
  const events = [];
  return { events, onProgress: (e) => events.push(e) };
}

test('session error: refresh, retry once, succeed', async () => {
  let calls = 0;
  const sites = {
    a: { id: 'a', domFallback: null, search: async () => { if (++calls === 1) throw new SiteError('session', 'a: 401'); return [row()]; } },
  };
  const pool = fakePool();
  const { events, onProgress } = collect();
  const [r] = await runSearch({ sites: ['a'], queries: ['toor dal'], pool, onProgress, sitesImpl: sites });
  assert.equal(r.available, true);
  assert.equal(r.resultsByQuery['toor dal'].length, 1);
  assert.deepEqual(pool.refreshed, ['a']);
  const retry = events.find((e) => e.type === 'retry');
  assert.equal(retry.kind, 'session');
  assert.equal(retry.site, 'a');
  assert.equal(calls, 2);
});

test('always blocked, no fallback: unavailable with kind and message', async () => {
  const sites = { a: { id: 'a', domFallback: null, search: async () => { throw new SiteError('blocked', 'a: 403 blocked (<HTML>)'); } } };
  const [r] = await runSearch({ sites: ['a'], queries: ['q1', 'q2'], pool: fakePool(), sitesImpl: sites });
  assert.equal(r.available, false);
  assert.equal(r.errorKind, 'blocked');
  assert.match(r.error, /403 blocked/);
  assert.deepEqual(r.partialFailures, []);
  assert.equal(r.failures.length, 2);
  assert.deepEqual(Object.keys(r.resultsByQuery).sort(), ['q1', 'q2']);
  assert.deepEqual(r.resultsByQuery.q1, []);
});

test('sites run in parallel', async () => {
  const mk = (id) => ({ id, domFallback: null, search: async () => { await sleep(120); return [row()]; } });
  const sites = { a: mk('a'), b: mk('b') };
  const t0 = Date.now();
  const out = await runSearch({ sites: ['a', 'b'], queries: ['q'], pool: fakePool(), sitesImpl: sites });
  assert.ok(Date.now() - t0 < 220, `took ${Date.now() - t0}ms`);
  assert.deepEqual(out.map((r) => r.platform), ['a', 'b']);
});

test('progress query events carry 1-based index and total', async () => {
  const sites = { a: { id: 'a', domFallback: null, search: async () => [row()] } };
  const { events, onProgress } = collect();
  await runSearch({ sites: ['a'], queries: ['x', 'y', 'z'], pool: fakePool(), onProgress, sitesImpl: sites });
  const q = events.filter((e) => e.type === 'query');
  assert.deepEqual(q.map((e) => e.index), [1, 2, 3]);
  assert.ok(q.every((e) => e.total === 3 && e.site === 'a'));
  assert.deepEqual(events[0], { type: 'site-start', site: 'a', total: 3 });
  assert.deepEqual(events.at(-1), { type: 'site-done', site: 'a', ok: true });
});

test('tab crash on query 2 fails only query 2 with kind browser', async () => {
  const sites = {
    a: { id: 'a', domFallback: 'a', search: async (_t, q) => { if (q === 'q2') throw new Error('CDP Runtime.evaluate: tab is closed'); return [row(q)]; } },
    b: { id: 'b', domFallback: null, search: async () => [row()] },
  };
  const extractors = { a: { searchUrl: () => { throw new Error('fallback must not run on browser failure'); } } };
  const out = await runSearch({ sites: ['a', 'b'], queries: ['q1', 'q2', 'q3'], pool: fakePool(), sitesImpl: sites, extractors });
  const [a, b] = out;
  assert.equal(a.available, true);
  assert.equal(a.errorKind, null);
  assert.equal(a.resultsByQuery.q1.length, 1);
  assert.deepEqual(a.resultsByQuery.q2, []);
  assert.equal(a.resultsByQuery.q3.length, 1);
  assert.equal(a.failures.length, 1);
  assert.equal(a.failures[0].query, 'q2');
  assert.equal(a.failures[0].kind, 'browser');
  assert.equal(a.partialFailures.length, 1);
  assert.match(a.partialFailures[0], /^q2: /);
  assert.equal(b.available, true);
});

test('result has the searchPlatform shape plus errorKind and failures', async () => {
  const sites = { a: { id: 'a', domFallback: null, search: async () => [row()] } };
  const [r] = await runSearch({ sites: ['a'], queries: ['q'], pool: fakePool(), sitesImpl: sites });
  assert.deepEqual(Object.keys(r).sort(), ['available', 'error', 'errorKind', 'failures', 'partialFailures', 'platform', 'resultsByQuery']);
  assert.equal(r.error, null);
  assert.deepEqual(r.failures, []);
});

test('still failing after retry falls back to DOM extractor on the pool tab', async () => {
  const sites = { a: { id: 'a', domFallback: 'a', search: async () => { throw new SiteError('blocked', 'a: 403'); } } };
  const calls = [];
  const tab = {
    alive: true,
    goto: async (u) => calls.push(['goto', u]),
    evaluate: async (expr) => {
      if (expr === 'READY') return true;
      if (expr === 'EXTRACT') return { rows: [row('DOM Dal'), { name: 'bad', price: 'x' }] };
      return null;
    },
  };
  const pool = { ...fakePool(), tab: async () => tab };
  const extractors = { a: { searchUrl: (q) => `https://a/s?q=${q}`, readyExpression: 'READY', extractExpression: 'EXTRACT' } };
  const { events, onProgress } = collect();
  const [r] = await runSearch({ sites: ['a'], queries: ['q'], pool, onProgress, sitesImpl: sites, extractors });
  assert.equal(r.available, true);
  assert.equal(r.resultsByQuery.q.length, 1);
  assert.equal(r.resultsByQuery.q[0].name, 'DOM Dal');
  assert.deepEqual(calls[0], ['goto', 'https://a/s?q=q']);
  assert.ok(events.some((e) => e.type === 'fallback'));
});

test('empty first query is refreshed and retried; later empties are not', async () => {
  let n = 0;
  const sites = { a: { id: 'a', domFallback: null, search: async (_t, q) => { n++; return q === 'q1' && n === 1 ? [] : q === 'q2' ? [] : [row()]; } } };
  const pool = fakePool();
  const [r] = await runSearch({ sites: ['a'], queries: ['q1', 'q2'], pool, sitesImpl: sites });
  assert.equal(r.resultsByQuery.q1.length, 1);
  assert.deepEqual(r.resultsByQuery.q2, []);
  assert.deepEqual(pool.refreshed, ['a']);
  assert.equal(r.available, true);
});

test('BrowserPool caches the tab per site and relaunches after Chrome dies', async () => {
  let launches = 0;
  const opened = [];
  const launch = async () => { launches++; return { endpoint: 'http://x', userAgent: 'UA', close: async () => {} }; };
  const openTab = async () => {
    const t = {
      alive: true, crash: null, cookies: [], gotos: [],
      onCrash(cb) { this.crash = cb; },
      setUserAgent: async () => {},
      setCookies: async (c) => t.cookies.push(...c),
      goto: async (u) => t.gotos.push(u),
      close: async () => { t.alive = false; },
    };
    opened.push(t);
    return t;
  };
  const sites = { a: { origin: 'https://a', locationCookies: () => [{ name: 'loc', value: '1' }] } };
  const pool = new BrowserPool({ launch, openTab, sites, location: {} });
  const [t1, t2] = await Promise.all([pool.tab('a'), pool.tab('a')]);
  assert.equal(t1, t2);
  assert.equal(opened.length, 1);
  assert.deepEqual(t1.gotos, ['https://a']);
  assert.equal(t1.cookies[0].name, 'loc');
  t1.alive = false;
  t1.crash('websocket closed');
  const t3 = await pool.tab('a');
  assert.notEqual(t3, t1);
  assert.equal(launches, 2);
  await assert.rejects(pool.tab('nope'), (e) => e.kind === 'not_found');
  await pool.close();
});

test('circuit breaker: a blocked site stops after the first query and skips the rest', async () => {
  let calls = 0;
  const sites = { a: { id: 'a', domFallback: null, search: async () => { calls++; throw new SiteError('blocked', 'a: bot protection page "Access Denied"'); } } };
  const [r] = await runSearch({ sites: ['a'], queries: ['q1', 'q2', 'q3'], pool: fakePool(), sitesImpl: sites });
  assert.equal(calls, 2, 'first query + its one retry, then stop');
  assert.equal(r.available, false);
  assert.equal(r.errorKind, 'blocked');
  assert.equal(r.failures.length, 3);
  assert.match(r.failures[2].message, /skipped after "q1": a: bot protection/);
  assert.deepEqual(r.resultsByQuery.q3, []);
});

test('circuit breaker: an unserviceable location stops the site without retry storms', async () => {
  let calls = 0;
  const sites = { a: { id: 'a', domFallback: 'x', search: async () => { calls++; throw new SiteError('unserviceable', 'a: not deliverable'); } } };
  const [r] = await runSearch({ sites: ['a'], queries: ['q1', 'q2'], pool: fakePool(), sitesImpl: sites, extractors: {} });
  assert.equal(calls, 1, 'unserviceable is not retried and skips the DOM fallback');
  assert.equal(r.errorKind, 'unserviceable');
  assert.equal(r.failures.length, 2);
});
