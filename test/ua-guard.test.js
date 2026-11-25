/**
 * The "HeadlessChrome" leak (root cause of BigBasket's 2026-11-25 wall): the user-agent override dies
 * with the connection that set it. Everything here is offline; the browser is faked.
 * (Live proof, 2026-11-25: with a real Chrome, a fresh tab, a second script and a closed connection all
 * read HeadlessChrome before ua-guard.js and real Chrome after.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { holdUserAgent } from '../src/engine/ua-guard.js';
import { userAgentOverride } from '../src/engine/cdp.js';
import { BrowserPool, assertRealUserAgent, assertNotWalled } from '../src/engine/pool.js';
import bigbasket from '../src/engine/sites/bigbasket.js';
const bigbasketOrigin = () => bigbasket.origin;

const REAL = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.38 Safari/537.36';
const HEADLESS = REAL.replace('Chrome/', 'HeadlessChrome/');

// ───────────────────────── the override itself ─────────────────────────

test('userAgentOverride: the string and client hints carry the real version and no HeadlessChrome brand', () => {
  const p = userAgentOverride(REAL);
  assert.equal(p.userAgent, REAL);
  assert.equal(p.userAgentMetadata.platform, 'Windows');
  assert.equal(p.userAgentMetadata.fullVersion, '158.0.8127.38');
  assert.ok(!JSON.stringify(p.userAgentMetadata).includes('Headless'));
  assert.ok(p.userAgentMetadata.brands.some((b) => b.brand === 'Google Chrome' && b.version === '158'));
  // the page's own hints are used when given, with a HeadlessChrome brand renamed
  const real = { brands: [{ brand: 'Not-A.Brand', version: '99' }, { brand: 'HeadlessChrome', version: '158' }], platform: 'Windows', uaFullVersion: '158.0.8127.38' };
  const q = userAgentOverride(REAL, real);
  assert.deepEqual(q.userAgentMetadata.brands.map((b) => b.brand), ['Not-A.Brand', 'Google Chrome']);
});

// ───────────────────────── the browser-level guard ─────────────────────────

/** A fake browser connection: records sends, lets a test fire events, can fail chosen calls. */
function fakeBrowser({ targets = [], failOverride = false } = {}) {
  const sent = [];
  let onEvent = () => {};
  let closed = false;
  const b = {
    sent,
    fire: (method, params) => onEvent({ method, params }),
    get closed() { return closed; },
    async send(method, params = {}, sessionId) {
      sent.push({ method, params, sessionId });
      if (method === 'Target.getTargets') return { targetInfos: targets };
      if (method === 'Target.attachToTarget') return { sessionId: `s-${params.targetId}` };
      if (method === 'Network.setUserAgentOverride' && failOverride) throw new Error('boom');
      return {};
    },
    onEvent(cb) { onEvent = cb; },
    onClose() {},
    close() { closed = true; },
  };
  return b;
}
const guard = (browser, extra = {}) => holdUserAgent({ endpoint: 'http://x', userAgent: REAL, connect: async () => browser, fetchVersion: async () => ({ webSocketDebuggerUrl: 'ws://browser' }), ...extra });
const tick = () => new Promise((r) => setImmediate(r));

test('guard: auto-attaches to new tabs, pausing them until the override is set', async () => {
  const b = fakeBrowser();
  const g = await guard(b);
  const auto = b.sent.find((s) => s.method === 'Target.setAutoAttach');
  assert.deepEqual(auto.params, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  b.fire('Target.attachedToTarget', { sessionId: 'A', targetInfo: { type: 'page' }, waitingForDebugger: true });
  await tick(); await tick();
  const forA = b.sent.filter((s) => s.sessionId === 'A').map((s) => s.method);
  assert.deepEqual(forA, ['Network.setUserAgentOverride', 'Runtime.runIfWaitingForDebugger'], 'override first, then let the page run');
  assert.equal(b.sent.find((s) => s.sessionId === 'A').params.userAgent, REAL);
  assert.equal(g.applied, 1);
  g.stop();
  assert.equal(b.closed, true);
});

test('guard: tabs that already exist get the override too, without being resumed', async () => {
  const b = fakeBrowser({ targets: [{ targetId: 'T1', type: 'page' }, { targetId: 'T2', type: 'service_worker' }] });
  const g = await guard(b);
  assert.ok(b.sent.some((s) => s.method === 'Target.attachToTarget' && s.params.targetId === 'T1'));
  assert.ok(!b.sent.some((s) => s.method === 'Target.attachToTarget' && s.params.targetId === 'T2'), 'only pages');
  assert.ok(b.sent.some((s) => s.method === 'Network.setUserAgentOverride' && s.sessionId === 's-T1'));
  assert.ok(!b.sent.some((s) => s.method === 'Runtime.runIfWaitingForDebugger'));
  assert.equal(g.applied, 1);
});

test('guard: a failing override still lets the tab run; other target kinds are only let go', async () => {
  const b = fakeBrowser({ failOverride: true });
  const logs = [];
  await guard(b, { log: (m) => logs.push(m) });
  b.fire('Target.attachedToTarget', { sessionId: 'A', targetInfo: { type: 'page' }, waitingForDebugger: true });
  b.fire('Target.attachedToTarget', { sessionId: 'W', targetInfo: { type: 'service_worker' }, waitingForDebugger: true });
  await tick(); await tick(); await tick();
  assert.ok(b.sent.some((s) => s.method === 'Runtime.runIfWaitingForDebugger' && s.sessionId === 'A'), 'the page is released even though the override failed');
  assert.ok(b.sent.some((s) => s.method === 'Runtime.runIfWaitingForDebugger' && s.sessionId === 'W'));
  assert.ok(!b.sent.some((s) => s.method === 'Network.setUserAgentOverride' && s.sessionId === 'W'));
  assert.match(logs[0], /could not set the user-agent/);
});

test('guard: a browser without a debugging socket is an error (launchChrome treats it as non-fatal)', async () => {
  await assert.rejects(holdUserAgent({ endpoint: 'http://x', userAgent: REAL, fetchVersion: async () => ({}) }), /no browser-level debugging socket/);
});

// ───────────────────────── the pool's last check ─────────────────────────

function tabReporting(ua, { wallTitle = null } = {}) {
  const calls = [];
  return {
    calls, alive: true,
    onCrash() {}, async setUserAgent() { calls.push('setUserAgent'); }, async setCookies() {},
    async goto(url) { calls.push(`goto ${url}`); },
    async send() {}, async close() { this.alive = false; },
    async evaluate(expr) {
      if (expr === 'navigator.userAgent') return ua;
      return { title: wallTitle ?? 'bigbasket', ua, text: wallTitle ? 'You don\'t have permission. Reference #18.8c43c717.1' : '' };
    },
  };
}
const poolFor = (tab, extra = {}) => new BrowserPool({
  launch: async () => ({ endpoint: 'x', userAgent: REAL, close: async () => {} }),
  openTab: async () => tab,
  sites: { bigbasket: { id: 'bigbasket', origin: 'https://www.bigbasket.com/' } },
  ...extra,
});

test('assertRealUserAgent: a HeadlessChrome tab is refused before the site is touched', async () => {
  await assert.rejects(assertRealUserAgent(tabReporting(HEADLESS), 'bigbasket'), (e) => e.kind === 'browser' && e.code === 'headless_ua' && /^bigbasket:/.test(e.message) && /not loaded/.test(e.message));
  await assertRealUserAgent(tabReporting(REAL), 'bigbasket');
  await assertRealUserAgent({}, 'bigbasket'); // a tab that cannot evaluate (a test double) is let through
});

test('pool: a tab that reports HeadlessChrome never gets as far as loading BigBasket', async () => {
  const tab = tabReporting(HEADLESS);
  await assert.rejects(poolFor(tab).tab('bigbasket'), (e) => e.code === 'headless_ua');
  assert.ok(!tab.calls.some((c) => c.startsWith('goto')), `no page was loaded: ${tab.calls}`);
  const ok = tabReporting(REAL);
  await poolFor(ok).tab('bigbasket');
  assert.deepEqual(ok.calls, ['setUserAgent', 'goto https://www.bigbasket.com/']);
});

test('pool: refresh checks the user-agent before reloading too', async () => {
  const tab = tabReporting(REAL);
  const pool = poolFor(tab);
  await pool.tab('bigbasket');
  tab.evaluate = async (expr) => (expr === 'navigator.userAgent' ? HEADLESS : { title: 'bigbasket', ua: HEADLESS, text: '' });
  tab.calls.length = 0;
  await assert.rejects(pool.refresh('bigbasket'), (e) => e.code === 'headless_ua');
  assert.deepEqual(tab.calls, [], 'not reloaded');
});

test('a wall on a tab that said HeadlessChrome is reported as our leak and does not push BigBasket to a headed browser', async () => {
  const leaked = tabReporting(HEADLESS, { wallTitle: 'Access Denied' });
  await assert.rejects(assertNotWalled(leaked, 'bigbasket'), (e) => e.kind === 'blocked' && e.code === 'headless_ua' && /not necessarily an IP block/.test(e.message));
  const real = tabReporting(REAL, { wallTitle: 'Access Denied' });
  await assert.rejects(assertNotWalled(real, 'bigbasket'), (e) => e.kind === 'blocked' && e.code === undefined && /IP is temporarily blocked/.test(e.message));
  // through the pool: the wall counter hears the real wall, not the leak
  const heard = [];
  const wallWatch = { walled: (s, m) => { heard.push(s); return false; }, clear() {} };
  // (the leak is stopped even earlier by assertRealUserAgent; use a tab whose UA only turns bad after the load)
  let load = 0;
  const tab = tabReporting(REAL, { wallTitle: 'Access Denied' });
  tab.evaluate = async (expr) => (expr === 'navigator.userAgent' ? REAL : { title: 'Access Denied', ua: load++ === 0 ? HEADLESS : REAL, text: 'Reference #18.1' });
  await assert.rejects(poolFor(tab, { wallWatch }).tab('bigbasket'), (e) => e.code === 'headless_ua');
  assert.deepEqual(heard, [], 'a leak is not counted as a wall');
  const tab2 = tabReporting(REAL, { wallTitle: 'Access Denied' });
  await assert.rejects(poolFor(tab2, { wallWatch }).tab('bigbasket'), (e) => e.kind === 'blocked');
  assert.deepEqual(heard, ['bigbasket'], 'a real wall is');
});

// ───────────────────────── BigBasket never loads a page ─────────────────────────

test('BigBasket module: the only page it ever loads is its home page (everything else is an API call from the warm tab)', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/engine/sites/bigbasket.js', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // code only, not the comments that explain the rule
  for (const bad of [/Page\.navigate/, /location\.(href|assign|replace)\b/, /window\.open/]) {
    assert.doesNotMatch(src, bad, `bigbasket.js must not use ${bad}`);
  }
  // goto is allowed for the home page (ORIGIN) only: no /basket/, /pd/, /sp/ ... page loads
  const gotos = [...src.matchAll(/\.goto\s*\(([^)]*)\)/g)].map((m) => m[1].split(',')[0].trim());
  assert.ok(gotos.length <= 1, `at most the location picker's one home-page retry, got ${gotos.length}`);
  assert.ok(gotos.every((a) => a === 'ORIGIN'), `goto may only load ORIGIN, got ${gotos}`);
  assert.equal(bigbasketOrigin(), 'https://www.bigbasket.com/');
});

test('BigBasket search and offers run on a tab that throws on any navigation', async () => {
  const tab = {
    async goto() { throw new Error('a page was loaded'); },
    async send(m) { if (/Page\.navigate|Page\.reload/.test(m)) throw new Error('a page was loaded'); return {}; },
    async getCookies() { return [{ name: '_bb_pin_code', value: '600045' }]; },
    async evaluate(expr) {
      if (expr.includes('a[href*="/sp/"]')) return ['/sp/2311728-deals-week/'];
      const url = /"url":"([^"]+)"/.exec(expr)?.[1] ?? '';
      if (/type=sis/.test(url)) return { status: 204, contentType: '', text: '', ms: 1 };
      return { status: 204, contentType: '', text: '', ms: 1 };
    },
  };
  assert.deepEqual(await bigbasket.search(tab, 'salt'), []);
  const out = await bigbasket.offers(tab);
  assert.deepEqual(out.rows, []);
});
