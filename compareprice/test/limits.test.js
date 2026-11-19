import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SiteLimiter, DEFAULT_LIMITS } from '../src/limits.js';

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => { t += ms; }, sleep: async (ms) => { t += ms; } };
}

test('a first search is allowed at once; the next must wait for the minimum gap', async () => {
  const c = clock();
  const l = new SiteLimiter({ now: c.now, sleep: c.sleep });
  assert.deepEqual(l.check('zepto', 1), { ok: true, waitMs: 0, reason: null });
  await l.acquire('zepto');
  const r = l.check('zepto', 1);
  assert.equal(r.ok, false);
  assert.equal(r.waitMs, DEFAULT_LIMITS.default.minGapMs);
  assert.match(r.reason, /just ran/);
  c.advance(2500);
  assert.equal(l.check('zepto', 1).ok, true);
});

test('acquire waits its turn (and counts the wait as time passing)', async () => {
  const c = clock();
  const l = new SiteLimiter({ now: c.now, sleep: c.sleep });
  const start = c.now();
  for (let i = 0; i < 4; i++) await l.acquire('blinkit');
  assert.equal(c.now() - start, 3 * 2500, 'three gaps between four searches');
});

test('the per-minute cap makes a long list wait, and says why', async () => {
  const c = clock();
  const l = new SiteLimiter({ limits: { zepto: { minGapMs: 0, perMinute: 5, perHour: 100 } }, now: c.now, sleep: c.sleep });
  for (let i = 0; i < 5; i++) await l.acquire('zepto');
  const r = l.check('zepto', 3);
  assert.equal(r.ok, false);
  assert.match(r.reason, /5 searches per minute/);
  assert.ok(r.waitMs > 0 && r.waitMs <= 60_000);
  c.advance(r.waitMs);
  assert.equal(l.check('zepto', 3).ok, true);
});

test('a list longer than the per-minute cap still starts; it paces itself while running', async () => {
  const c = clock();
  const l = new SiteLimiter({ limits: { x: { minGapMs: 0, perMinute: 5, perHour: 100 } }, now: c.now, sleep: c.sleep });
  assert.equal(l.check('x', 12).ok, true);
  const waits = [];
  const start = c.now();
  for (let i = 0; i < 7; i++) await l.acquire('x', { onWait: (w) => waits.push(w.reason) });
  assert.ok(c.now() - start >= 55_000, 'the 6th and 7th search waited for the minute to roll');
  assert.ok(waits.every((r) => /per minute/.test(r)));
});

test('a blocked answer rests the site; the cool-down is reported with its reason, then clears', () => {
  const c = clock();
  const l = new SiteLimiter({ now: c.now });
  l.penalize('bigbasket', 'bot protection page "Access Denied"');
  const r = l.check('bigbasket', 1);
  assert.equal(r.ok, false);
  assert.equal(r.waitMs, DEFAULT_LIMITS.bigbasket.cooldownMs);
  assert.match(r.reason, /Access Denied.*resting 30 min/);
  c.advance(DEFAULT_LIMITS.bigbasket.cooldownMs + 1);
  assert.equal(l.check('bigbasket', 1).ok, true);
});

test('config overrides win over the built-in defaults, per site and for "default"', () => {
  const l = new SiteLimiter({ limits: { default: { minGapMs: 1000 }, instamart: { perMinute: 6 } } });
  assert.equal(l.limitsFor('kpn').minGapMs, 1000);
  assert.equal(l.limitsFor('instamart').perMinute, 6);
  assert.equal(l.limitsFor('instamart').minGapMs, 1000, 'a "default" override beats a built-in site entry; a site override beats both');
});

test('acquire stops when the job is cancelled', async () => {
  const l = new SiteLimiter({ limits: { s: { minGapMs: 60_000 } } });
  await l.acquire('s');
  const ctl = new AbortController();
  const p = l.acquire('s', { signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, /aborted/);
});

test('status reports usage and remaining wait per site', async () => {
  const c = clock();
  const l = new SiteLimiter({ now: c.now, sleep: c.sleep });
  await l.acquire('kpn');
  const s = l.status(['kpn', 'zepto']);
  assert.equal(s.kpn.lastMinute, 1);
  assert.equal(s.kpn.ok, false);
  assert.equal(s.zepto.lastMinute, 0);
  assert.equal(s.zepto.ok, true);
});
