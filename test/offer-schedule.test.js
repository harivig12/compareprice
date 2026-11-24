/**
 * The offer check at fixed times (src/offer-schedule.js). No timers are
 * relied on: the clock is injected and tick() is called by hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startOfferSchedule, offerTimes, DEFAULT_OFFER_TIMES } from '../src/offer-schedule.js';

// Asia/Kolkata is UTC+5:30 with no daylight saving: 07:00 IST = 01:30Z.
const cfg = (extra = {}) => ({ timezone: 'Asia/Kolkata', deals: { minDiscountPct: 80, ...extra } });

function rig({ start, config = cfg(), pending = [], current = null, store } = {}) {
  let t = new Date(start).getTime();
  const jobs = [];
  const queue = {
    enqueue: (job) => { jobs.push(job); return jobs.length; },
    current: () => current,
    pending: () => pending,
  };
  const s = startOfferSchedule({ queue, getConfig: () => config, store, now: () => new Date(t), tickMs: 30_000 });
  const at = (iso) => { t = new Date(iso).getTime(); s.tick(); };
  return { jobs, at, stop: s.stop };
}

const fireOnce = () => {
  const seen = new Set();
  return { markFired: (k) => (seen.has(k) ? false : (seen.add(k), true)) };
};

test('the default deal times are 07:00 and 18:00', () => {
  assert.deepEqual(DEFAULT_OFFER_TIMES, ['07:00', '18:00']);
  assert.deepEqual(offerTimes({}), ['07:00', '18:00']);
  assert.deepEqual(offerTimes(cfg({ times: ['06:30'] })), ['06:30']);
});

test('queues one offer check at 07:00 and one at 18:00, each once', () => {
  const r = rig({ start: '2026-11-24T01:29:30Z' }); // 06:59:30 IST
  try {
    assert.equal(r.jobs.length, 0, 'nothing before 07:00');
    r.at('2026-11-24T01:30:10Z'); // 07:00:10
    assert.equal(r.jobs.length, 1);
    assert.deepEqual(r.jobs[0], { items: '', sites: null, trigger: 'offers' });
    r.at('2026-11-24T01:30:40Z');
    r.at('2026-11-24T05:00:00Z'); // 10:30
    assert.equal(r.jobs.length, 1, 'not again the same morning');
    r.at('2026-11-24T12:30:05Z'); // 18:00:05
    assert.equal(r.jobs.length, 2);
    r.at('2026-11-24T12:31:00Z');
    assert.equal(r.jobs.length, 2);
  } finally { r.stop(); }
});

test('a restart right after 07:00 does not queue a second check', () => {
  const store = fireOnce();
  const a = rig({ start: '2026-11-24T01:29:50Z', store });
  a.at('2026-11-24T01:30:05Z');
  a.stop();
  assert.equal(a.jobs.length, 1);
  const b = rig({ start: '2026-11-24T01:30:20Z', store }); // its first window still covers 07:00:00
  b.stop();
  assert.equal(b.jobs.length, 0);
});

test('nothing is queued while an offer check is queued or running', () => {
  const queued = rig({ start: '2026-11-24T01:29:50Z', pending: [{ trigger: 'offers' }] });
  queued.at('2026-11-24T01:30:05Z');
  queued.stop();
  assert.equal(queued.jobs.length, 0);
  const running = rig({ start: '2026-11-24T01:29:50Z', current: { trigger: 'offers' } });
  running.at('2026-11-24T01:30:05Z');
  running.stop();
  assert.equal(running.jobs.length, 0);
  const other = rig({ start: '2026-11-24T01:29:50Z', current: { trigger: 'schedule' }, pending: [{ trigger: 'sweep' }] });
  other.at('2026-11-24T01:30:05Z');
  other.stop();
  assert.equal(other.jobs.length, 1, 'a basket run or a sweep does not block the offer check');
});

test('configured times are used, including one just after midnight', () => {
  const r = rig({ start: '2026-11-24T18:29:40Z', config: cfg({ times: ['00:00'] }) }); // 23:59:40 IST
  try {
    assert.equal(r.jobs.length, 0);
    r.at('2026-11-24T18:30:10Z'); // 00:00:10 on the 25th
    assert.equal(r.jobs.length, 1);
    r.at('2026-11-25T01:30:10Z'); // 07:00 is not configured
    assert.equal(r.jobs.length, 1);
  } finally { r.stop(); }
});

test('a broken config skips the tick instead of throwing', () => {
  const logs = [];
  let t = new Date('2026-11-24T01:29:50Z').getTime();
  const queue = { enqueue: () => assert.fail('must not queue'), current: () => null, pending: () => [] };
  const s = startOfferSchedule({ queue, getConfig: () => { throw new Error('bad json'); }, now: () => new Date(t), log: (m) => logs.push(m) });
  t = new Date('2026-11-24T01:30:05Z').getTime();
  s.tick();
  s.stop();
  assert.ok(logs.some((m) => /config unavailable: bad json/.test(m)));
});
