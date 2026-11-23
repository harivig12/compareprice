import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startSweep, pickSweepItems, sweepSettings } from '../src/sweep.js';
import { openStore } from '../src/store.js';
import { PRODUCTS } from '../src/catalog.js';
import { DEFAULT_CONFIG, validateConfig, completeConfig } from '../src/config.js';

// Deterministic "random": a fixed cycle of values in [0, 1).
const cycle = (...v) => {
  let i = 0;
  return () => v[i++ % v.length];
};

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
    // Run the newest live timer.
    fireNext() {
      const t = timers.filter((x) => !x.cleared).at(-1);
      t.cleared = true;
      t.fn();
      return t.ms;
    },
  };
}

function fakeQueue() {
  const jobs = [];
  return {
    jobs,
    busy: false,
    current() {
      return this.busy ? { id: 99 } : null;
    },
    pending: () => [],
    enqueue(job) {
      jobs.push(job);
      return jobs.length;
    },
  };
}

const cfg = (sweep = {}) => ({ ...DEFAULT_CONFIG, sites: ['blinkit', 'zepto'], sweep: { ...DEFAULT_CONFIG.sweep, ...sweep } });

test('missing products come first; products covered everywhere and fresh are skipped', () => {
  const store = openStore(':memory:');
  try {
    const add = (query, site, seenAt) =>
      store.db.prepare(`INSERT INTO prices (query, site, family, unit, unit_price, price, seen_at) VALUES (?, ?, 'mass', 'kg', 100, 50, ?)`).run(query, site, seenAt);
    const now = new Date('2026-11-23T12:00:00Z');
    add('rice', 'blinkit', '2026-11-23T10:00:00Z');
    add('rice', 'zepto', '2026-11-23T10:00:00Z'); // fully covered, fresh
    add('sugar', 'blinkit', '2026-11-23T10:00:00Z'); // half covered
    const products = PRODUCTS.filter((p) => ['rice', 'sugar', 'jaggery'].includes(p.id));
    const picks = pickSweepItems({ store, sites: ['blinkit', 'zepto'], count: 5, now, products, random: () => 0 });
    assert.deepEqual(picks.map((p) => p.product.id), ['jaggery', 'sugar']);
    assert.deepEqual(picks[1].missing, ['zepto']);
    // A day later rice is stale and comes back, after the missing ones.
    const later = pickSweepItems({ store, sites: ['blinkit', 'zepto'], count: 5, now: new Date('2026-11-24T12:00:00Z'), products, random: () => 0 });
    assert.deepEqual(later.map((p) => [p.product.id, p.reason]), [['jaggery', 'missing'], ['sugar', 'missing'], ['rice', 'stale']]);
  } finally {
    store.close();
  }
});

test('the sweep queues 2–4 products at random 5–20 minute gaps, a different set each time', () => {
  const store = openStore(':memory:');
  const queue = fakeQueue();
  const t = fakeTimers();
  try {
    // random() feeds: first gap, then per firing [batch size, shuffles..., gap].
    const sweep = startSweep({ queue, store, getConfig: () => cfg(), random: cycle(0.0, 0.99, 0.5, 0.25, 0.75), setTimer: t.setTimer, clearTimer: t.clearTimer });
    const gaps = [t.timers[0].ms];
    for (let i = 0; i < 4; i++) gaps.push(t.fireNext());
    sweep.stop();

    assert.equal(queue.jobs.length, 4);
    for (const g of gaps) assert.ok(g >= 5 * 60_000 && g <= 20 * 60_000, `gap ${g}`);
    const sets = queue.jobs.map((j) => j.items.split('\n'));
    for (const s of sets) assert.ok(s.length >= 2 && s.length <= 4, `batch of ${s.length}`);
    assert.ok(queue.jobs.every((j) => j.trigger === 'sweep' && j.sites.join() === 'blinkit,zepto'));
    // Never the same product twice in a day.
    const all = sets.flat();
    assert.equal(new Set(all).size, all.length);
  } finally {
    store.close();
  }
});

test('a busy queue postpones the sweep by a minute or two; disabled means nothing is queued', () => {
  const store = openStore(':memory:');
  const queue = fakeQueue();
  const t = fakeTimers();
  try {
    let enabled = true;
    const sweep = startSweep({ queue, store, getConfig: () => cfg({ enabled }), random: () => 0.5, setTimer: t.setTimer, clearTimer: t.clearTimer });
    queue.busy = true;
    t.fireNext();
    const retry = t.timers.at(-1).ms;
    assert.ok(retry >= 60_000 && retry <= 3 * 60_000, `retry ${retry}`);
    assert.equal(queue.jobs.length, 0);
    queue.busy = false;
    enabled = false;
    t.fireNext();
    assert.equal(queue.jobs.length, 0);
    assert.equal(sweep.runOnce().reason, 'disabled');
    // A manual "sweep now" still runs.
    assert.ok(sweep.runOnce({ force: true }).jobId);
    sweep.stop();
  } finally {
    store.close();
  }
});

test('sweep settings are validated and bounded', () => {
  assert.equal(validateConfig(completeConfig({}), DEFAULT_CONFIG.sites), null);
  assert.equal(validateConfig(completeConfig({ sweep: { minItems: 5, maxItems: 2 } }), DEFAULT_CONFIG.sites)?.field, 'sweep.maxItems');
  assert.equal(validateConfig(completeConfig({ sweep: { sites: ['nope'] } }), DEFAULT_CONFIG.sites)?.field, 'sweep.sites');
  const s = sweepSettings({ sites: ['a'], sweep: { minItems: 0, maxGapMinutes: 1 } });
  assert.equal(s.minItems, 1);
  assert.ok(s.maxGapMinutes >= s.minGapMinutes);
  assert.deepEqual(s.sites, ['a']);
});
