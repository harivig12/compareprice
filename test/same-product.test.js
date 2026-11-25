import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickCandidates, buildJudgeRequest, parseJudgeReply, runSameProduct, keepMatch, verdictFor, doubtedNames, matchKey } from '../src/ai/same-product.js';
import { saveKey, writeAiSettings } from '../src/ai/settings.js';
import { pickBest, scorePlatform } from '../src/score.js';

const memStore = () => { const m = new Map(); return { getMeta: (k) => m.get(k) ?? null, setMeta: (k, v) => m.set(k, String(v)), m }; };
const line = (query, status, name, price, confidence = 0.9) => ({ query, qty: 1, status, product: { name, price, confidence }, lineTotal: status === 'bigger-pack' ? null : price });
const result = () => ({
  basket: [{ query: 'curd 400g' }],
  platforms: [
    { platform: 'a', lines: [line('curd 400g', 'ok', 'Epigamia Greek Yogurt 400 g', 40, 0.6)] },
    { platform: 'b', lines: [line('curd 400g', 'ok', 'Heritage Curd 400 g', 45, 0.95)] },
    { platform: 'c', lines: [line('curd 400g', 'ok', 'Curd Rice Mix 400 g', 60, 0.6)] },
    { platform: 'd', lines: [line('curd 400g', 'low-confidence', 'Curd Chilli 400 g', 30, 0.4)] },
    { platform: 'e', failed: true, lines: [] },
    { platform: 'others', others: true, lines: [] },
  ],
});

test('pickCandidates: weak matches, and borderline ones that could win; not sure ones, failed sites or Others', () => {
  const store = memStore();
  const got = pickCandidates(result(), store).map((c) => c.site);
  // a: borderline and cheapest counted -> yes. b: confident -> no. c: borderline but third cheapest of the counted -> no. d: weak -> yes.
  assert.deepEqual(got.sort(), ['a', 'd']);
});

test('pickCandidates skips a pair that already has a verdict, and caps the run', () => {
  const store = memStore();
  store.setMeta(matchKey('curd 400g', 'a', 'Epigamia Greek Yogurt 400 g'), JSON.stringify({ v: 'same' }));
  assert.deepEqual(pickCandidates(result(), store).map((c) => c.site), ['d']);
  assert.equal(pickCandidates(result(), memStore(), { max: 1 }).length, 1);
});

test('the AI request carries only the typed text and the product title', () => {
  const req = buildJudgeRequest([{ query: 'curd 400g', site: 'zepto', product: 'Heritage Curd 400 g', price: 45 }], 'm');
  const user = req.messages[1].content;
  assert.match(user, /WANTED: curd 400g \| FOUND: Heritage Curd 400 g/);
  assert.doesNotMatch(user, /zepto|45/);
});

test('parseJudgeReply: yes / no / unsure by index, anything else is null', () => {
  const content = JSON.stringify({ items: [{ i: 0, v: 'no' }, { i: 1, v: 'yes' }, { i: 5, v: 'no' }, { i: 2, v: 'maybe' }] });
  assert.deepEqual(parseJudgeReply({ choices: [{ message: { content } }] }, 3), ['no', 'yes', null]);
  assert.deepEqual(parseJudgeReply({}, 2), [null, null]);
});

test('runSameProduct saves verdicts, counts one call, and never asks twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jhola-same-'));
  try {
    const store = memStore();
    let calls = 0;
    const fetchImpl = async (_u, init) => {
      calls++;
      assert.doesNotMatch(String(init.body), /secret-key/);
      const items = JSON.parse(init.body).messages[1].content.split('\n').map((_, i) => ({ i, v: i === 0 ? 'no' : 'unsure' }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }), { status: 200 });
    };
    assert.match((await runSameProduct({ store, dataDir: dir, result: result(), fetchImpl })).skipped, /No API key/);
    saveKey(dir, 'secret-key');
    const out = await runSameProduct({ store, dataDir: dir, result: result(), fetchImpl });
    assert.deepEqual([out.asked, out.flagged, out.calls], [2, 1, 1]);
    assert.equal(calls, 1);
    assert.equal(verdictFor(store, 'curd 400g', 'a', 'Epigamia Greek Yogurt 400 g').v, 'no');
    assert.equal(verdictFor(store, 'curd 400g', 'd', 'Curd Chilli 400 g').v, 'unsure');
    assert.match((await runSameProduct({ store, dataDir: dir, result: result(), fetchImpl })).skipped, /Nothing borderline/);
    assert.equal(calls, 1);
    writeAiSettings(dir, { checkMatches: false });
    assert.match((await runSameProduct({ store, dataDir: dir, result: result(), fetchImpl })).skipped, /off/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the daily cap is shared and respected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jhola-same-'));
  try {
    const store = memStore();
    saveKey(dir, 'k');
    writeAiSettings(dir, { maxCallsPerDay: 1 });
    const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
    store.setMeta(`ai_calls:${day}`, 1);
    const out = await runSameProduct({ store, dataDir: dir, result: result(), fetchImpl: async () => { throw new Error('must not be called'); } });
    assert.match(out.skipped, /daily cap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('✓ keep overrides a "no" for good, and doubtedNames lists only the "no"s', () => {
  const store = memStore();
  store.setMeta(matchKey('curd', 'a', 'X'), JSON.stringify({ v: 'no' }));
  store.setMeta(matchKey('curd', 'a', 'Y'), JSON.stringify({ v: 'unsure' }));
  assert.deepEqual([...doubtedNames(store, 'curd', 'a', ['X', 'Y', 'Z'])], ['X']);
  keepMatch(store, { query: 'curd', site: 'a', product: 'X' });
  assert.equal(doubtedNames(store, 'curd', 'a', ['X']).size, 0);
  assert.equal(verdictFor(store, 'curd', 'a', 'X').by, 'user');
});

test('a doubted product is demoted, never removed: another confident one wins; alone it stays a weak match', () => {
  const rows = [
    { name: 'Greek Yogurt 400 g', price: 40, inStock: true, packSize: 400, packUnit: 'g' },
    { name: 'Heritage Curd 400 g', price: 45, inStock: true, packSize: 400, packUnit: 'g' },
  ];
  const doubt = new Set(['Greek Yogurt 400 g']);
  const withDoubt = pickBest('curd 400g', rows, 1, { doubt });
  assert.equal(withDoubt.chosen.name, 'Heritage Curd 400 g');
  const alone = pickBest('curd 400g', [rows[0]], 1, { doubt });
  assert.equal(alone.chosen.name, 'Greek Yogurt 400 g');
  assert.equal(alone.status, 'low-confidence');
  assert.equal(alone.chosen.aiDoubt, true);
  // The line carries the flag for the page, and the AI never changes a total by itself.
  const scored = scorePlatform('a', [{ raw: 'curd 400g', query: 'curd 400g', qty: 1 }], { 'curd 400g': rows }, {}, { doubt: new Map([['curd 400g', doubt]]) });
  assert.deepEqual(scored.lines[0].aiDoubt, [{ name: 'Greek Yogurt 400 g', price: 40 }]);
  assert.equal(scored.lines[0].product.name, 'Heritage Curd 400 g');
});
