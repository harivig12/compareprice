/**
 * Config defaults and the price-history / job store.
 * Every test uses its own temp dir so nothing touches the real DATA_DIR.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../src/config.js';
import { openStore } from '../src/store.js';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'basket-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempStore(t) {
  const store = openStore(join(tempDir(t), 'basket.db'));
  t.after(() => store.close());
  return store;
}

/** A minimal compareBasket()-shaped result: one line on one site. */
function result({ query = 'moong dal', site = 'instamart', name = 'Tata Sampann Moong Dal', price, packSize, packUnit, at }) {
  return {
    generatedAt: at,
    basket: [{ raw: query, query, qty: 1 }],
    platforms: [
      {
        platform: site,
        lines: [
          {
            query,
            qty: 1,
            status: 'ok',
            product: { name, price, packSize, packUnit, packLabel: `${packSize}${packUnit}`, packs: 1 },
            lineTotal: price,
          },
        ],
      },
    ],
  };
}

test('loadConfig on an empty dir returns the defaults', (t) => {
  const dir = tempDir(t);
  const cfg = loadConfig(dir);
  assert.equal(cfg.location.pincode, '600045');
  assert.equal(cfg.server.host, '127.0.0.1');
  assert.deepEqual(cfg.sites, DEFAULT_CONFIG.sites);
});

test('saveConfig round-trips and missing keys are filled', (t) => {
  const dir = tempDir(t);
  saveConfig({ phone: '9999999999', server: { port: 8080 } }, dir);
  const cfg = loadConfig(dir);
  assert.equal(cfg.phone, '9999999999');
  assert.equal(cfg.server.port, 8080);
  assert.equal(cfg.server.host, '127.0.0.1');
  assert.equal(cfg.timezone, 'Asia/Kolkata');
});

test('the low is per base unit and keeps its seenAt', (t) => {
  const store = tempStore(t);
  store.recordResult(result({ price: 120, packSize: 1000, packUnit: 'g', at: '2026-11-16T01:30:00.000Z' }), { jobId: 1, trigger: 'manual' });
  store.recordResult(result({ price: 55, packSize: 500, packUnit: 'g', at: '2026-11-16T15:30:00.000Z' }), { jobId: 2, trigger: 'schedule' });
  const h = store.historyFor('moong dal').instamart;
  assert.equal(h.lowUnitPrice, 110);
  assert.equal(h.unit, 'kg');
  assert.equal(h.lowPrice, 55);
  assert.equal(h.pack, '500g');
  assert.equal(h.seenAt, '2026-11-16T15:30:00.000Z');
  assert.equal(h.lastUnitPrice, 110);
  assert.equal(h.lastSeenAt, '2026-11-16T15:30:00.000Z');
});

test('annotate tags a price above the low with the per-unit delta', (t) => {
  const store = tempStore(t);
  store.recordResult(result({ price: 120, packSize: 1000, packUnit: 'g', at: '2026-11-16T01:30:00.000Z' }), { jobId: 1, trigger: 'manual' });
  store.recordResult(result({ price: 55, packSize: 500, packUnit: 'g', at: '2026-11-16T15:30:00.000Z' }), { jobId: 2, trigger: 'manual' });
  const r = store.annotate(result({ price: 130, packSize: 1000, packUnit: 'g', at: '2026-11-17T01:30:00.000Z' }));
  const { history } = r.platforms[0].lines[0];
  assert.equal(history.tag, 'above-low');
  assert.equal(history.delta, 20);
  assert.equal(history.low, 110);
  assert.equal(history.lowSeenAt, '2026-11-16T15:30:00.000Z');
});

test('annotate tags new-low and at-low', (t) => {
  const store = tempStore(t);
  const first = store.annotate(result({ price: 120, packSize: 1000, packUnit: 'g', at: '2026-11-16T01:30:00.000Z' }));
  assert.equal(first.platforms[0].lines[0].history.tag, 'new-low');
  store.recordResult(first, { jobId: 1, trigger: 'manual' });
  const same = store.annotate(result({ price: 60, packSize: 500, packUnit: 'g', at: '2026-11-17T01:30:00.000Z' }));
  assert.equal(same.platforms[0].lines[0].history.tag, 'at-low');
  const lower = store.annotate(result({ price: 100, packSize: 1000, packUnit: 'g', at: '2026-11-18T01:30:00.000Z' }));
  assert.equal(lower.platforms[0].lines[0].history.tag, 'new-low');
  assert.equal(lower.platforms[0].lines[0].history.delta, -20);
});

test('a different unit family never replaces the low', (t) => {
  const store = tempStore(t);
  store.recordResult(result({ price: 110, packSize: 1000, packUnit: 'g', at: '2026-11-16T01:30:00.000Z' }), { jobId: 1, trigger: 'manual' });
  const litre = result({ price: 40, packSize: 1000, packUnit: 'ml', at: '2026-11-16T02:30:00.000Z' });
  assert.equal(store.annotate(litre).platforms[0].lines[0].history, null);
  store.recordResult(litre, { jobId: 2, trigger: 'manual' });
  const h = store.historyFor('moong dal').instamart;
  assert.equal(h.unit, 'kg');
  assert.equal(h.lowUnitPrice, 110);
});

test('history is keyed by normalized query and site', (t) => {
  const store = tempStore(t);
  store.recordResult(result({ query: 'Moong  Dal', price: 120, packSize: 1000, packUnit: 'g', at: '2026-11-16T01:30:00.000Z' }), { jobId: 1, trigger: 'manual' });
  store.recordResult(result({ site: 'zepto', price: 90, packSize: 1000, packUnit: 'g', at: '2026-11-16T01:30:00.000Z' }), { jobId: 1, trigger: 'manual' });
  const h = store.historyFor('moong dal');
  assert.equal(h.instamart.lowUnitPrice, 120);
  assert.equal(h.zepto.lowUnitPrice, 90);
});

test('markInterrupted flips running jobs', (t) => {
  const store = tempStore(t);
  const running = store.createJob({ sites: ['zepto'], items: 'onion 1kg', trigger: 'manual' });
  const finished = store.createJob({ sites: ['zepto'], items: 'onion 1kg', trigger: 'schedule' });
  store.updateJob(running, { status: 'running', startedAt: '2026-11-16T01:30:00.000Z' });
  store.updateJob(finished, { status: 'done' });
  store.markInterrupted();
  const jobs = store.listJobs(10);
  assert.equal(jobs.find((j) => j.id === running).status, 'interrupted');
  assert.equal(jobs.find((j) => j.id === finished).status, 'done');
  assert.deepEqual(jobs.find((j) => j.id === running).sites, ['zepto']);
  assert.equal(jobs[0].id, finished, 'newest first');
});
