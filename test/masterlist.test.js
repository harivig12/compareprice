import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProductList, masterRows, toCsv, toMarkdown } from '../src/masterlist.js';
import { runMaster, takeLock } from '../src/masterrun.js';

test('parseProductList: head words, comma lists, alternatives, describers, typos, duplicates', () => {
  const text = [
    'Rice: naga Sona Masoori, Ponni, Idli rice',
    'Wheat atta / whole-wheat flour',
    'Maida (refined flour)',
    'Urad dal: split urad, ',
    'Green peas, dried',
    'unflower oil, groundnut oil',
    'Kitchen/bathroom cleaner',
    'Tissues and toilet paper',
    'Butter', '', 'Butter',
  ].join('\n');
  assert.deepEqual(parseProductList(text).map((i) => i.query), [
    'naga sona masoori rice', 'ponni rice', 'idli rice', 'wheat atta', 'maida', 'split urad dal',
    'dried green peas', 'sunflower oil', 'groundnut oil', 'kitchen cleaner', 'tissues', 'toilet paper', 'butter',
  ]);
});

const cached = (items) => ({
  basket: items.map((q) => ({ query: q, raw: q, qty: 1 })),
  platforms: [
    { platform: 'zepto', label: 'Zepto', lines: items.map((q) => (q === 'sugar' ? { query: q, status: 'ok', lineTotal: 63, cachedAt: 't', product: { name: 'Sugar 1 kg', price: 63, packLabel: '1000g', packUnit: 'g', pricePerUnit: 0.063 } } : { query: q, status: 'not-cached', lineTotal: null })) },
    { platform: 'kpn', label: 'KPN Fresh', lines: items.map((q) => (q === 'sugar' ? { query: q, status: 'ok', lineTotal: 60, cachedAt: 't', product: { name: 'Sugar 1kg', price: 60, packLabel: '1000g', packUnit: 'g', pricePerUnit: 0.06 } } : { query: q, status: 'not-cached', lineTotal: null })) },
  ],
});

test('report: cheapest by rate, CSV and markdown with items that have no price yet', () => {
  const rows = masterRows([cached(['sugar', 'honey'])]);
  const best = rows.find((r) => r.cheapest);
  assert.deepEqual([best.item, best.site, best.rate, best.per], ['sugar', 'kpn', 6, '100 g']);
  assert.match(toCsv(rows), /^item,site,product,pack,price,mrp,rate,per,seenAt,cheapest\nsugar,zepto,Sugar 1 kg/);
  const md = toMarkdown(rows, { generatedAt: 'x' });
  assert.match(md, /\| sugar \| KPN Fresh \| Sugar 1kg \| 1000g \| ₹60 \| ₹6\/100 g \| 2 \|/);
  assert.match(md, /\| honey \| — \|/);
  assert.match(md, /2 items · 1 with at least one price · 1 with none yet/);
});

test('runner: batches through the service with gaps, waits out 429, one missing pass, resumable, writes the report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'basket-master-'));
  try {
    const calls = [];
    let jobId = 0;
    let limited = true;
    const statuses = new Map();
    const http = async (path, init = {}) => {
      calls.push([init.method ?? 'GET', path, init.body]);
      if (path === '/api/compare' && init.body?.mode === 'cached') return { status: 200, data: cached(init.body.items.split('\n')) };
      if (path === '/api/compare') {
        if (limited) { limited = false; return { status: 429, data: { error: 'Zepto needs a short pause', waitMs: 3000 } }; }
        jobId++;
        statuses.set(jobId, 'done');
        return { status: 202, data: { jobId } };
      }
      if (path.startsWith('/api/jobs')) return { status: 200, data: { jobs: [...statuses].map(([id, status]) => ({ id, status })) } };
      return { status: 404, data: {} };
    };
    const slept = [];
    const items = ['sugar', 'honey', 'salt', 'ghee', 'rice'];
    const out = await runMaster({ items, dir, http, batchSize: 2, gapMs: 600_000, pollMs: 1, sleep: async (ms) => { slept.push(ms); }, log: () => {} });
    const fresh = calls.filter(([m, p, b]) => m === 'POST' && p === '/api/compare' && !b.mode);
    assert.deepEqual(fresh.map(([, , b]) => b.items), ['sugar\nhoney', 'sugar\nhoney', 'salt\nghee', 'rice'], 'the 429 is retried, then 3 batches');
    assert.ok(slept.includes(7000), 'waited out the 429 (at least 5 s, + 2 s)');
    assert.equal(slept.filter((ms) => ms === 600_000).length >= 2, true, 'gap between batches');
    const missing = calls.filter(([, , b]) => b?.mode === 'missing');
    assert.ok(missing.length >= 1);
    assert.deepEqual(Object.keys(missing[0][2].only).sort(), ['kpn', 'zepto']);
    assert.ok(!missing.some(([, , b]) => Object.values(b.only).flat().includes('sugar')), 'sugar already has prices');
    assert.ok(existsSync(out.csv) && existsSync(out.md));
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.ok(state.finishedAt);
    assert.equal(Object.keys(state.done).length, 5);

    // A second run of a finished list starts over (new day); an unfinished one resumes.
    const st = { ...state, finishedAt: null, done: { sugar: { status: 'done' }, honey: { status: 'done' } }, missingDone: true };
    (await import('node:fs')).writeFileSync(join(dir, 'state.json'), JSON.stringify(st));
    calls.length = 0;
    await runMaster({ items, dir, http, batchSize: 2, gapMs: 0, pollMs: 1, sleep: async () => {}, log: () => {} });
    assert.deepEqual(calls.filter(([m, p, b]) => m === 'POST' && p === '/api/compare' && !b.mode).map(([, , b]) => b.items), ['salt\nghee', 'rice'], 'resumed after the done items');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one runner at a time; a lock left by a dead process is taken over', async () => {
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'basket-master-'));
  try {
    // A live other process (our parent) holds the lock: refused.
    writeFileSync(join(dir, 'run.lock'), String(process.ppid));
    assert.throws(() => takeLock(dir), /another master-list run is going/);
    // A pid that doesn't exist: taken over.
    writeFileSync(join(dir, 'run.lock'), '999999999');
    const release = takeLock(dir);
    assert.equal(readFileSync(join(dir, 'run.lock'), 'utf8'), String(process.pid));
    release();
    assert.equal(existsSync(join(dir, 'run.lock')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a resting site is skipped at once (no waiting, no retry, no longer rest); the master run leaves it out', async () => {
  const { SiteLimiter } = await import('../src/limits.js');
  const { runSearch } = await import('../src/engine/run.js');
  let t = 1_000_000;
  const lim = new SiteLimiter({ now: () => t, sleep: async (ms) => { t += ms; } });
  lim.penalize('bigbasket', 'bot wall');
  const until = lim.cooldown.get('bigbasket').until;
  let searched = 0;
  let refreshed = 0;
  const pool = { tab: async () => ({}), refresh: async () => { refreshed++; } };
  const sitesImpl = { bigbasket: { id: 'bigbasket', search: async () => { searched++; return []; } } };
  const t0 = t;
  const [r] = await runSearch({ sites: ['bigbasket'], queries: ['salt', 'sugar'], pool, sitesImpl, limiter: lim });
  assert.equal(t, t0, 'did not wait');
  assert.equal(searched + refreshed, 0, 'site never touched');
  assert.equal(r.available, false);
  assert.match(r.error, /bigbasket: resting until \d\d:\d\d .*skipped this run/);
  assert.equal(lim.cooldown.get('bigbasket').until, until, 'the rest is not extended');

  // Master run: a resting site is dropped from the job's sites.
  const posted = [];
  const http = async (path, init = {}) => {
    if (path === '/api/meta') return { status: 200, data: { defaultPlatforms: ['zepto', 'bigbasket'] } };
    if (path === '/api/limits') return { status: 200, data: { bigbasket: { cooldownMs: 600_000 }, zepto: { cooldownMs: 0 } } };
    if (path === '/api/compare' && init.body?.mode === 'cached') return { status: 200, data: { basket: [], platforms: [] } };
    if (path === '/api/compare') { posted.push(init.body); return { status: 202, data: { jobId: posted.length } }; }
    if (path.startsWith('/api/jobs')) return { status: 200, data: { jobs: posted.map((_, i) => ({ id: i + 1, status: 'done' })) } };
    return { status: 404, data: {} };
  };
  const dir = mkdtempSync(join(tmpdir(), 'basket-master-'));
  try {
    await runMaster({ items: ['salt'], dir, http, gapMs: 0, pollMs: 1, missingPass: false, sleep: async () => {}, log: () => {} });
    assert.deepEqual(posted[0].platforms, ['zepto']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
