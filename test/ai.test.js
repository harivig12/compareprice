/**
 * Optional AI labeller (src/ai/): settings in ai.md, key in secrets.json,
 * one call per batch of titles, only titles sent, labels only demote.
 * No network: every call goes to a fake fetch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAiSettings, writeAiSettings, readKey, saveKey, keyHint, aiFile, DEFAULT_AI } from '../src/ai/settings.js';
import { buildRequest, parseReply, checkConnection, SYSTEM_PROMPT } from '../src/ai/label.js';
import { runAiLabels } from '../src/ai/job.js';
import { openStore } from '../src/store.js';
import { startServer } from '../src/server.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'basket-ai-'));
const reply = (items) => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }) });

function seed(store, n) {
  for (let i = 0; i < n; i++) {
    store.recordResult({ generatedAt: `2026-11-20T06:${String(i % 60).padStart(2, '0')}:00.000Z`, platforms: [{ platform: 'blinkit', lines: [{ query: `item ${i}`, status: 'ok', product: { name: `Product ${i} 1 kg`, price: 50, packSize: 1000, packUnit: 'g', packLabel: '1000g', url: 'u' } }] }] });
  }
}

test('ai.md: written with defaults the first time, edited values read back, other lines kept', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readAiSettings(dir), { ...DEFAULT_AI });
    const text = readFileSync(aiFile(dir), 'utf8');
    assert.match(text, /- batch size: 100/);
    assert.match(text, /- enabled: no/);
    writeFileSync(aiFile(dir), text.replace('batch size: 100', 'batch size: 40') + '\nmy own note: keep me\n');
    assert.equal(readAiSettings(dir).batchSize, 40);
    writeAiSettings(dir, { enabled: true, model: 'm1' });
    const after = readFileSync(aiFile(dir), 'utf8');
    assert.match(after, /my own note: keep me/);
    assert.equal(readAiSettings(dir).enabled, true);
    assert.equal(readAiSettings(dir).model, 'm1');
    writeFileSync(aiFile(dir), after.replace('batch size: 40', 'batch size: 9999'));
    assert.equal(readAiSettings(dir).batchSize, 400, 'clamped');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the key lives in secrets.json (mode 600), never in ai.md, shown only as a hint', () => {
  const dir = tmp();
  try {
    saveKey(dir, 'gsk_test_secret_1234');
    assert.equal(readKey(dir), 'gsk_test_secret_1234');
    assert.equal(statSync(join(dir, 'secrets.json')).mode & 0o777, 0o600);
    readAiSettings(dir);
    assert.doesNotMatch(readFileSync(aiFile(dir), 'utf8'), /gsk_test/);
    assert.equal(keyHint('gsk_test_secret_1234'), '••••1234');
    saveKey(dir, '');
    assert.equal(readKey(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the request carries only numbered titles; the reply is checked item by item', () => {
  const body = buildRequest(['Aavin Ghee 1 L', 'Ghee Laddu 200 g'], 'm');
  assert.equal(body.model, 'm');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.reasoning_effort, 'low');
  assert.deepEqual(body.response_format.json_schema.schema.properties.items.items.properties.g.enum, ['staple', 'packaged', 'sweets', 'pooja', 'nonfood']);
  assert.deepEqual(buildRequest(['x'], 'm', 'json').response_format, { type: 'json_object' });
  assert.equal(buildRequest(['x'], 'm', 'json').reasoning_effort, undefined);
  assert.equal(body.messages[0].content, SYSTEM_PROMPT);
  assert.equal(body.messages[1].content, '0. Aavin Ghee 1 L\n1. Ghee Laddu 200 g');
  const ok = { choices: [{ message: { content: '```json\n{"items":[{"i":1,"g":"sweets"},{"i":0,"g":"staple"},{"i":7,"g":"staple"},{"i":0,"g":"bogus"}]}\n```' } }] };
  assert.deepEqual(parseReply(ok, 2), ['staple', 'sweets']);
  assert.deepEqual(parseReply({ choices: [{ message: { content: 'not json' } }] }, 2), [null, null]);
  assert.deepEqual(parseReply({}, 1), [null]);
});

test('230 titles at batch size 100: 3 calls, 2 pauses of 65 s, every title labelled, only titles sent', async () => {
  const dir = tmp();
  const store = openStore(join(dir, 'basket.db'));
  try {
    seed(store, 230);
    writeAiSettings(dir, { enabled: true });
    saveKey(dir, 'k-1234');
    const bodies = [];
    const sleeps = [];
    const fetchImpl = async (url, init) => {
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
      assert.equal(init.headers.authorization, 'Bearer k-1234');
      const body = JSON.parse(init.body);
      bodies.push(body);
      const n = body.messages[1].content.split('\n').length;
      return reply(Array.from({ length: n }, (_, i) => ({ i, g: 'staple' })));
    };
    const out = await runAiLabels({ store, dataDir: dir, fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(out.error, undefined);
    assert.equal(out.calls, 3);
    assert.equal(out.labelled, 230);
    assert.deepEqual(sleeps, [65_000, 65_000]);
    assert.deepEqual(bodies.map((b) => b.messages[1].content.split('\n').length), [100, 100, 30]);
    const sent = JSON.stringify(bodies);
    for (const word of ['blinkit', '"price"', '"url"', 'item 1']) assert.ok(!sent.includes(word), `request has no ${word}`);
    assert.equal(store.aiGroups().size, 230);
    assert.deepEqual(store.labelCounts(), { labelled: 230, waiting: 0 });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('bad answers label nothing, a partial answer keeps only valid items, the daily cap holds', async () => {
  const dir = tmp();
  const store = openStore(join(dir, 'basket.db'));
  try {
    seed(store, 5);
    writeAiSettings(dir, { enabled: true });
    saveKey(dir, 'k');
    const bad = await runAiLabels({ store, dataDir: dir, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"nope"}}]}' }), sleep: async () => {} });
    assert.match(bad.error, /no usable labels/);
    assert.equal(store.aiGroups().size, 0);
    const down = await runAiLabels({ store, dataDir: dir, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'invalid api key' }), sleep: async () => {} });
    assert.match(down.error, /HTTP 401/);
    assert.ok(!down.error.includes('Bearer'), 'no key in the message');
    const part = await runAiLabels({ store, dataDir: dir, fetchImpl: async () => reply([{ i: 0, g: 'packaged' }, { i: 2, g: 'nope' }]), sleep: async () => {} });
    assert.equal(part.labelled, 1);
    assert.equal(store.aiGroups().size, 1);
    // Calls so far today: 4 (bad, down, part + the retry of the 4 skipped titles); cap it.
    writeAiSettings(dir, { maxCallsPerDay: Number(store.getMeta(`ai_calls:${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' })}`)) });
    let called = 0;
    const capped = await runAiLabels({ store, dataDir: dir, fetchImpl: async () => { called++; return reply([]); }, sleep: async () => {} });
    assert.equal(called, 0);
    assert.match(capped.skipped, /daily cap/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('off by default, and on without a key it says so', async () => {
  const dir = tmp();
  const store = openStore(join(dir, 'basket.db'));
  try {
    assert.match((await runAiLabels({ store, dataDir: dir, fetchImpl: async () => assert.fail('no call') })).skipped, /off/);
    writeAiSettings(dir, { enabled: true });
    assert.match((await runAiLabels({ store, dataDir: dir, fetchImpl: async () => assert.fail('no call') })).error, /no API key/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Check connection: key accepted, model listed, a ghee and a laddu labelled right', async () => {
  const settings = { ...DEFAULT_AI };
  const fetchImpl = async (url) => (url.endsWith('/models')
    ? { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: settings.model }] }) }
    : reply([{ i: 0, g: 'staple' }, { i: 1, g: 'sweets' }]));
  assert.deepEqual(await checkConnection({ settings, key: 'k', fetchImpl }), { ok: true, modelListed: true, sample: { ok: true, got: ['staple', 'sweets'] }, error: null });
  const wrong = await checkConnection({ settings, key: 'k', fetchImpl: async (url) => (url.endsWith('/models') ? { ok: true, status: 200, text: async () => '{"data":[]}' } : reply([{ i: 0, g: 'staple' }, { i: 1, g: 'staple' }])) });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.modelListed, false);
  assert.equal((await checkConnection({ settings, key: null })).error, 'No API key saved yet.');
  const refused = await checkConnection({ settings, key: 'k', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad key' }) });
  assert.match(refused.error, /HTTP 401/);
});

test('GET/PUT /api/ai never return the key', async () => {
  const dir = tmp();
  const server = await startServer({ port: 0, compare: async () => ({}), dataDir: dir });
  try {
    const put = await fetch(`${server.url}/api/ai`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'openrouter', model: 'x:free', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, key: 'sk-or-verysecret-9876' }) });
    const text = await put.text();
    assert.equal(put.status, 200);
    assert.ok(!text.includes('verysecret'), 'PUT answer has no key');
    const got = await (await fetch(`${server.url}/api/ai`)).json();
    assert.equal(got.hasKey, true);
    assert.equal(got.keyHint, '••••9876');
    assert.equal(got.settings.provider, 'openrouter');
    assert.ok(!JSON.stringify(got).includes('verysecret'));
    assert.equal(readKey(dir), 'sk-or-verysecret-9876');
    const bad = await fetch(`${server.url}/api/ai`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseUrl: 'ftp://x' }) });
    assert.equal(bad.status, 400);
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a provider that refuses the schema request is asked once more in plain JSON mode', async () => {
  const { labelBatch } = await import('../src/ai/label.js');
  const modes = [];
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body);
    modes.push(b.response_format.type);
    return b.response_format.type === 'json_schema'
      ? { ok: false, status: 400, text: async () => '{"error":{"message":"response_format json_schema is not supported"}}' }
      : reply([{ i: 0, g: 'staple' }]);
  };
  assert.deepEqual(await labelBatch({ titles: ['Toor Dal 1 kg'], settings: { ...DEFAULT_AI }, key: 'k', fetchImpl }), ['staple']);
  assert.deepEqual(modes, ['json_schema', 'json_object']);
  // A bad generation is not a reason to retry: it would just cost another call.
  const once = [];
  await assert.rejects(() => labelBatch({ titles: ['x'], settings: { ...DEFAULT_AI }, key: 'k', fetchImpl: async () => { once.push(1); return { ok: false, status: 400, text: async () => '{"error":{"code":"json_validate_failed"}}' }; } }), /HTTP 400/);
  assert.equal(once.length, 1);
});
