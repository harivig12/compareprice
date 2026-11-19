/**
 * Job queue and daily scheduler, with a fake run, a fake clock and a temp store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { openStore } from '../src/store.js';
import { JobQueue } from '../src/jobs.js';
import { startScheduler } from '../src/scheduler.js';

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'basket-jobs-'));
  const store = openStore(join(dir, 'basket.db'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

const fakeResult = () => ({ generatedAt: new Date().toISOString(), basket: [], platforms: [] });

/** A run() whose calls resolve only when the test says so. */
function controlledRun() {
  const calls = [];
  const run = (opts) =>
    new Promise((resolve, reject) => {
      const call = { opts, resolve: () => resolve(fakeResult()), reject };
      opts.signal?.addEventListener('abort', () => reject(opts.signal.reason ?? new Error('aborted')));
      calls.push(call);
      run.onCall?.(call);
    });
  run.calls = calls;
  run.nextCall = () => new Promise((r) => (run.onCall = r));
  return run;
}

const tick = () => new Promise((r) => setImmediate(r));

const config = (over = {}) => ({
  basket: 'onion 1kg',
  timezone: 'Asia/Kolkata',
  schedules: [{ name: 'deals', sites: ['instamart', 'bigbasket'], times: ['07:00'] }],
  ...over,
});
// 07:00 IST is 01:30 UTC.
const ist = (hms) => new Date(`2026-11-16T${hms}+05:30`);

test('two jobs run one at a time, in order', async (t) => {
  const store = tempStore(t);
  const run = controlledRun();
  const queue = new JobQueue({ run, store });
  const first = queue.enqueue({ items: 'onion 1kg', sites: ['zepto'], trigger: 'manual' });
  const second = queue.enqueue({ items: 'tomato 500g', sites: ['blinkit'], trigger: 'manual' });
  await tick();
  assert.equal(run.calls.length, 1, 'second must not start while first runs');
  assert.equal(queue.current().id, first);
  assert.deepEqual(run.calls[0].opts.platforms, ['zepto']);
  assert.equal(run.calls[0].opts.items, 'onion 1kg');
  assert.equal(store.getJob(second).status, 'queued');

  const firstDone = once(queue, 'done');
  run.calls[0].resolve();
  const [doneId, doneResult] = await firstDone;
  assert.equal(doneId, first);
  assert.ok(Array.isArray(doneResult.platforms));
  assert.equal(store.getJob(first).status, 'done');

  await tick();
  assert.equal(run.calls.length, 2);
  assert.equal(queue.current().id, second);
  const secondDone = once(queue, 'done');
  run.calls[1].resolve();
  await secondDone;
  assert.equal(queue.current(), null);
});

test('progress events carry the job id', async (t) => {
  const store = tempStore(t);
  const run = async ({ onProgress }) => {
    onProgress({ site: 'zepto', done: 1, total: 1, query: 'onion 1kg' });
    return fakeResult();
  };
  const queue = new JobQueue({ run, store });
  const events = [];
  queue.on('progress', (id, ev) => events.push([id, ev]));
  const id = queue.enqueue({ items: 'onion 1kg', sites: ['zepto'], trigger: 'manual' });
  await once(queue, 'done');
  assert.deepEqual(events, [[id, { site: 'zepto', done: 1, total: 1, query: 'onion 1kg' }]]);
});

test('a failed run is recorded and the queue moves on', async (t) => {
  const store = tempStore(t);
  let n = 0;
  const run = async () => {
    if (n++ === 0) throw new Error('boom');
    return fakeResult();
  };
  const queue = new JobQueue({ run, store });
  const done = [];
  queue.on('done', (id, r) => done.push([id, r]));
  const a = queue.enqueue({ items: 'x', sites: ['zepto'], trigger: 'manual' });
  const b = queue.enqueue({ items: 'y', sites: ['zepto'], trigger: 'manual' });
  while (done.length < 2) await once(queue, 'done');
  assert.ok(done[0][1] instanceof Error);
  assert.equal(store.getJob(a).status, 'failed');
  assert.equal(store.getJob(a).error, 'boom');
  assert.equal(store.getJob(b).status, 'done');
});

test('cancel aborts the running job signal', async (t) => {
  const store = tempStore(t);
  const run = controlledRun();
  const queue = new JobQueue({ run, store });
  const id = queue.enqueue({ items: 'onion 1kg', sites: ['zepto'], trigger: 'manual' });
  await tick();
  const { signal } = run.calls[0].opts;
  assert.equal(signal.aborted, false);
  const done = once(queue, 'done');
  queue.cancel(id);
  assert.equal(signal.aborted, true);
  const [, err] = await done;
  assert.ok(err instanceof Error);
  assert.equal(store.getJob(id).status, 'cancelled');
  assert.equal(queue.current(), null);
});

test('cancel removes a queued job before it starts', async (t) => {
  const store = tempStore(t);
  const run = controlledRun();
  const queue = new JobQueue({ run, store });
  queue.enqueue({ items: 'a', sites: ['zepto'], trigger: 'manual' });
  const queued = queue.enqueue({ items: 'b', sites: ['zepto'], trigger: 'manual' });
  await tick();
  queue.cancel(queued);
  assert.equal(store.getJob(queued).status, 'cancelled');
  run.calls[0].resolve();
  await once(queue, 'done');
  await tick();
  assert.equal(run.calls.length, 1, 'cancelled job never runs');
});

test('a 07:00 schedule fires once across the 07:00 tick and not again', async (t) => {
  const store = tempStore(t);
  const queue = { store, enqueued: [], enqueue(job) { this.enqueued.push(job); return this.enqueued.length; } };
  let clock = ist('06:59:50');
  const sched = startScheduler({ queue, getConfig: () => config(), now: () => clock, tickMs: 30000 });
  t.after(() => sched.stop());
  sched.tick();
  assert.equal(queue.enqueued.length, 0, 'nothing at 06:59:50');
  clock = ist('07:00:20');
  sched.tick();
  assert.equal(queue.enqueued.length, 1, 'fires in the window containing 07:00');
  assert.deepEqual(queue.enqueued[0], { items: 'onion 1kg', sites: ['instamart', 'bigbasket'], trigger: 'schedule' });
  clock = ist('07:00:50');
  sched.tick();
  assert.equal(queue.enqueued.length, 1, 'does not fire again');
});

test('a restart inside the window does not double-fire', async (t) => {
  const store = tempStore(t);
  const queue = { store, enqueued: [], enqueue(job) { this.enqueued.push(job); return this.enqueued.length; } };
  let clock = ist('07:00:20');
  const a = startScheduler({ queue, getConfig: () => config(), now: () => clock, tickMs: 30000 });
  a.tick();
  a.stop();
  clock = ist('07:00:25');
  const b = startScheduler({ queue, getConfig: () => config(), now: () => clock, tickMs: 30000 });
  b.tick();
  b.stop();
  assert.equal(queue.enqueued.length, 1);
});

test('a scheduled job enqueued during a manual job waits, then runs', async (t) => {
  const store = tempStore(t);
  const run = controlledRun();
  const queue = new JobQueue({ run, store });
  const manual = queue.enqueue({ items: 'onion 1kg', sites: ['instamart'], trigger: 'manual' });
  await tick();
  let clock = ist('06:59:50');
  const sched = startScheduler({ queue, getConfig: () => config(), now: () => clock, tickMs: 30000 });
  t.after(() => sched.stop());
  clock = ist('07:00:20');
  sched.tick();
  await tick();
  assert.equal(run.calls.length, 1, 'scheduled job waits for the manual one');
  assert.equal(queue.current().id, manual);

  const next = run.nextCall();
  run.calls[0].resolve();
  const call = await next;
  assert.deepEqual(call.opts.platforms, ['instamart', 'bigbasket']);
  assert.equal(queue.current().trigger, 'schedule');
  const done = once(queue, 'done');
  call.resolve();
  await done;
  assert.equal(store.listJobs(10).filter((j) => j.status === 'done').length, 2);
});
