import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startService, summarize } from '../src/service.js';

const RESULT = (generatedAt) => ({
  generatedAt,
  elapsedMs: 1200,
  pincode: '600045',
  basket: [{ query: 'toor dal 1kg', qty: 1 }],
  winner: { platform: 'zepto', total: 154, label: 'Zepto' },
  platforms: [
    { platform: 'zepto', total: 154, fulfilledLines: 1, totalLines: 1, lines: [{ query: 'toor dal 1kg', status: 'ok', product: { price: 154, packSize: 1000, packUnit: 'g', name: 'BestValue Toor Dal 1 kg', packLabel: '1000g' } }] },
    { platform: 'bigbasket', total: 0, fulfilledLines: 0, totalLines: 1, failed: true, error: 'toor dal 1kg: bigbasket: bot protection page', errorKind: 'blocked', lines: [] },
  ],
});

test('a scheduled time enqueues the configured basket and the run is written to results/ and runs.jsonl', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'basket-svc-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    basket: 'toor dal 1kg\n',
    timezone: 'Asia/Kolkata',
    schedules: [{ name: 'morning', sites: ['zepto', 'bigbasket'], times: ['07:00'] }],
  }));
  // 06:59:50 IST, then 07:00:20 IST
  let clock = new Date('2026-11-19T01:29:50Z');
  const calls = [];
  const logs = [];
  const svc = await startService({
    dataDir: dir,
    port: 0,
    tickMs: 60_000,
    now: () => clock,
    log: (m) => logs.push(m),
    run: async (opts) => { calls.push(opts); return RESULT('2026-11-19T01:30:25.000Z'); },
  });
  try {
    assert.equal(calls.length, 0, 'nothing fires before 07:00');
    clock = new Date('2026-11-19T01:30:20Z');
    svc.scheduler.tick();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls.length, 1, '07:00 fired once');
    assert.deepEqual(calls[0].platforms, ['zepto', 'bigbasket']);
    assert.equal(calls[0].items, 'toor dal 1kg\n');

    const files = readdirSync(join(dir, 'results'));
    const resultFile = files.find((f) => /job\d+-schedule\.json$/.test(f));
    assert.ok(resultFile, `result file written: ${files}`);
    const saved = JSON.parse(readFileSync(join(dir, 'results', resultFile), 'utf8'));
    assert.equal(saved.job.trigger, 'schedule');
    assert.equal(saved.result.winner.platform, 'zepto');
    assert.equal(saved.result.platforms[0].lines[0].history.tag, 'new-low', 'annotated with history');

    const lines = readFileSync(join(dir, 'results', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].trigger, 'schedule');
    assert.deepEqual(lines[0].sites.map((s) => [s.platform, s.errorKind]), [['zepto', null], ['bigbasket', 'blocked']]);
    assert.deepEqual(lines[0].sites[0].newLows, ['toor dal 1kg']);

    // History is queryable over the API.
    const h = await (await fetch(`${svc.server.url}/api/history?q=toor%20dal%201kg`)).json();
    assert.equal(h.sites.zepto.lowUnitPrice, 154);
    assert.equal(h.sites.zepto.seenAt, '2026-11-19T01:30:25.000Z');

    // Same window again: no double fire.
    svc.scheduler.tick();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls.length, 1);
    assert.ok(logs.some((l) => /schedules: morning 07:00/.test(l)));
  } finally {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarize records failures as ok:false with the message', () => {
  assert.deepEqual(summarize({ id: 3, trigger: 'manual' }, new Error('Basket is empty')).error, 'Basket is empty');
});
