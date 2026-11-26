/**
 * Scheduled adds: offline only. No call reaches Milkbasket; the site's GraphQL is a stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEntry, dueBetween, runAdds, readAdds, writeAdds, startAddSchedule, spentOn, DEFAULT_LIMITS } from '../src/scheduled-adds.js';
import { ensureInBasket, productIdOf, BASKET_ERRORS } from '../src/engine/sites/milkbasket.js';

const TZ = 'Asia/Kolkata';
const entry = (over = {}) => cleanEntry({ productId: 101, name: 'Toned Milk 500 ml', price: 29, qty: 2, time: '05:30', days: [0, 1, 2, 3, 4, 5, 6], ...over });
const state = (over = {}) => ({ enabled: true, limits: { ...DEFAULT_LIMITS }, accounts: { 'milkbasket:main': { enabled: true, entries: [entry({ id: 'entry-aaaa' })] } }, log: [], ...over });
// 2026-11-27 is a Friday. 05:30 IST = 00:00 UTC.
const at = (iso) => new Date(iso).getTime();

test('cleanEntry checks product, quantity, time, days and the per-item limit', () => {
  assert.throws(() => cleanEntry({ name: 'x', qty: 1, time: '05:30', days: [1] }), /Pick the product/);
  assert.throws(() => entry({ qty: 0 }), /Quantity must be 1/);
  assert.throws(() => entry({ qty: 6 }), /above the limit of 5/);
  assert.throws(() => entry({ qty: 3, maxQty: 2 }), /at most 2/);
  assert.throws(() => entry({ time: '5:30' }), /HH:MM/);
  assert.throws(() => entry({ days: [] }), /at least one day/);
  assert.throws(() => entry({ once: '27-11-2026' }), /YYYY-MM-DD/);
  const e = entry({ once: '2026-11-27', days: [1, 2] });
  assert.deepEqual([e.once, e.days, e.enabled], ['2026-11-27', [], true]);
  assert.match(entry().id, /^[\w-]{6,40}$/);
});

test('dueBetween: only the tick that sees the time pass; nothing while the master switch is off', () => {
  const s = state();
  assert.equal(dueBetween(s, at('2026-11-26T23:59:30Z'), at('2026-11-27T00:00:00Z'), TZ).length, 1);
  // Before and after the window: nothing (a missed time is not run late).
  assert.equal(dueBetween(s, at('2026-11-26T23:58:00Z'), at('2026-11-26T23:59:00Z'), TZ).length, 0);
  assert.equal(dueBetween(s, at('2026-11-27T00:00:01Z'), at('2026-11-27T00:10:00Z'), TZ).length, 0);
  assert.equal(dueBetween({ ...s, enabled: false }, at('2026-11-26T23:59:30Z'), at('2026-11-27T00:00:00Z'), TZ).length, 0);
});

test('dueBetween respects weekdays, once dates, and the account and entry switches', () => {
  const win = [at('2026-11-26T23:59:30Z'), at('2026-11-27T00:00:00Z')]; // Friday 05:30 IST
  const only = (e, acc = true) => dueBetween(state({ accounts: { 'milkbasket:main': { enabled: acc, entries: [e] } } }), ...win, TZ).length;
  assert.equal(only(entry({ days: [5] })), 1);
  assert.equal(only(entry({ days: [1, 3] })), 0);
  assert.equal(only(entry({ once: '2026-11-27' })), 1);
  assert.equal(only(entry({ once: '2026-11-28' })), 0);
  assert.equal(only(entry({ enabled: false })), 0);
  assert.equal(only(entry(), false), 0);
});

const okEnsure = (calls) => async (item) => { calls.push(item); return { status: 'added', had: 0, now: item.qty, added: item.qty }; };

test('runAdds adds within the limits and logs it with what it cost', async () => {
  const s = state();
  const calls = [];
  const lines = await runAdds({ state: s, key: 'milkbasket:main', entryIds: ['entry-aaaa'], day: '2026-11-27', ensure: okEnsure(calls) });
  assert.deepEqual(calls, [{ productId: 101, qty: 2, price: 29 }]);
  assert.equal(lines[0].status, 'added');
  assert.equal(lines[0].spent, 58);
  assert.equal(spentOn(s, '2026-11-27'), 58);
});

test('runAdds re-checks the switches at run time and never calls the site when one is off', async () => {
  for (const s of [state({ enabled: false }), state({ accounts: { 'milkbasket:main': { enabled: false, entries: [entry({ id: 'entry-aaaa' })] } } }), state({ accounts: { 'milkbasket:main': { enabled: true, entries: [entry({ id: 'entry-aaaa', enabled: false })] } } })]) {
    const calls = [];
    const [l] = await runAdds({ state: s, key: 'milkbasket:main', entryIds: ['entry-aaaa'], day: 'd', ensure: okEnsure(calls) });
    assert.equal(calls.length, 0);
    assert.equal(l.status, 'skipped');
    assert.match(l.reason, /switched off/);
  }
});

test('runAdds keeps to the daily ₹ limit across accounts, and to the quantity limit', async () => {
  const s = state({ limits: { maxQty: 5, maxPerDay: 100 } });
  s.log.push({ day: 'd', status: 'added', spent: 60 });
  const calls = [];
  const [l] = await runAdds({ state: s, key: 'milkbasket:main', entryIds: ['entry-aaaa'], day: 'd', ensure: okEnsure(calls) });
  assert.equal(calls.length, 0);
  assert.match(l.reason, /₹100 daily limit \(₹60 added today\)/);
  const s2 = state({ limits: { maxQty: 1, maxPerDay: 300 } });
  const [l2] = await runAdds({ state: s2, key: 'milkbasket:main', entryIds: ['entry-aaaa'], day: 'd', ensure: okEnsure([]) });
  assert.match(l2.reason, /quantity above the limit of 1/);
});

test('runAdds: an entry with no price is skipped (the ₹ limit could not be checked)', async () => {
  const s = state({ accounts: { 'milkbasket:main': { enabled: true, entries: [entry({ id: 'entry-aaaa', price: null })] } } });
  const [l] = await runAdds({ state: s, key: 'milkbasket:main', entryIds: ['entry-aaaa'], day: 'd', ensure: okEnsure([]) });
  assert.match(l.reason, /no known price/);
});

test('runAdds: skipped by the site, already there, and a sign-out stops the rest with "nothing was added"', async () => {
  const two = { enabled: true, entries: [entry({ id: 'entry-aaaa' }), entry({ id: 'entry-bbbb', productId: 102, name: 'Curd' })] };
  const skip = await runAdds({ state: state({ accounts: { 'milkbasket:main': two } }), key: 'milkbasket:main', entryIds: ['entry-aaaa'], day: 'd', ensure: async () => ({ status: 'skipped', had: 0, now: 0, added: 0, code: 'cutoff_time_exceeded', reason: BASKET_ERRORS.cutoff_time_exceeded }) });
  assert.deepEqual([skip[0].status, skip[0].code], ['skipped', 'cutoff_time_exceeded']);
  const already = await runAdds({ state: state(), key: 'milkbasket:main', entryIds: ['entry-aaaa'], day: 'd', ensure: async () => ({ status: 'already', had: 2, now: 2, added: 0 }) });
  assert.equal(already[0].status, 'already');
  let n = 0;
  const out = await runAdds({ state: state({ accounts: { 'milkbasket:main': JSON.parse(JSON.stringify(two)) } }), key: 'milkbasket:main', entryIds: ['entry-aaaa', 'entry-bbbb'], day: 'd', ensure: async () => { n++; const e = new Error('milkbasket: not signed in'); e.kind = 'session'; throw e; } });
  assert.equal(n, 1);
  assert.deepEqual(out.map((l) => l.status), ['failed', 'failed']);
  assert.match(out[1].reason, /Nothing was added/);
});

test('a "run once" entry switches itself off after its day', async () => {
  const s = state({ accounts: { 'milkbasket:main': { enabled: true, entries: [entry({ id: 'entry-aaaa', once: '2026-11-27' })] } } });
  await runAdds({ state: s, key: 'milkbasket:main', entryIds: ['entry-aaaa'], day: '2026-11-27', ensure: okEnsure([]) });
  assert.equal(s.accounts['milkbasket:main'].entries[0].enabled, false);
});

test('the list round-trips on disk, defaults to OFF, and drops other sites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jhola-adds-'));
  try {
    assert.equal(readAdds(dir).enabled, false);
    writeAdds(dir, { ...state(), accounts: { ...state().accounts, 'bigbasket:main': { enabled: true, entries: [entry()] } } });
    const back = readAdds(dir);
    assert.equal(back.enabled, true);
    assert.deepEqual(Object.keys(back.accounts), ['milkbasket:main']);
    assert.equal(back.accounts['milkbasket:main'].entries[0].productId, 101);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the ticker queues one job per account, once (fire-once key), and nothing while off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jhola-adds-'));
  try {
    const queued = [];
    const fired = new Set();
    const store = { markFired: (k) => (fired.has(k) ? false : (fired.add(k), true)) };
    const queue = { enqueue: (j) => { queued.push(j); return queued.length; } };
    let t = at('2026-11-26T23:59:40Z');
    writeAdds(dir, state({ enabled: false }));
    const s = startAddSchedule({ queue, dataDir: dir, getConfig: () => ({ timezone: TZ }), store, now: () => new Date(t), tickMs: 60_000 });
    t = at('2026-11-27T00:00:10Z'); s.tick();
    assert.equal(queued.length, 0);
    writeAdds(dir, state());
    t = at('2026-11-26T23:59:50Z'); // the clock as seen by a restarted ticker
    const s2 = startAddSchedule({ queue, dataDir: dir, getConfig: () => ({ timezone: TZ }), store, now: () => new Date(t), tickMs: 30_000 });
    t = at('2026-11-27T00:00:10Z'); s2.tick();
    assert.equal(queued.length, 1);
    assert.deepEqual([queued[0].trigger, queued[0].data.key, queued[0].data.ids], ['scheduled-add', 'milkbasket:main', ['entry-aaaa']]);
    s.stop(); s2.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the site side, with Milkbasket's GraphQL stubbed (no network) ──
function fakeTab() {
  return {
    _capture: { milkbasket: { headers: { authorization: 'Bearer test', hubid: '42', cityid: '7', appversion: '9.9.9' } } },
    send: async () => ({ cookies: [] }),
    evaluate: async () => 'https://www.milkbasket.com',
  };
}
async function withGql(handler, fn) {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /consumerbff\.milkbasket\.com\/graphql/);
    const body = JSON.parse(init.body);
    sent.push(body);
    return new Response(JSON.stringify({ data: handler(body) }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { return await fn(sent); } finally { globalThis.fetch = real; }
}
const basket = (items) => ({ getPrunedBasket: { id: 9, date: '2026-11-28', quantity: items.length, products: items.map(([id, q]) => ({ id, order: { productId: id, quantity: q } })) } });

test('ensureInBasket: already enough in the basket means no add call', async () => {
  await withGql(() => basket([[101, 2]]), async (sent) => {
    const r = await ensureInBasket(fakeTab(), { productId: 101, qty: 2, price: 29 });
    assert.deepEqual([r.status, r.had], ['already', 2]);
    assert.deepEqual(sent.map((b) => b.operationName), ['fetchBasket']);
  });
});

test('ensureInBasket sends the new total (never more than asked), the basket date, and no time bypass', async () => {
  await withGql((b) => (b.operationName === 'fetchBasket' ? basket([[101, 1]]) : { addToBasket: { isRefreshBasket: true, error: null, prunedBasket: { products: [{ id: 101, order: { productId: 101, quantity: 2 } }] } } }), async (sent) => {
    const r = await ensureInBasket(fakeTab(), { productId: 101, qty: 2, price: 29 });
    assert.deepEqual([r.status, r.had, r.now, r.added], ['added', 1, 2, 1]);
    const add = sent.find((b) => b.operationName === 'addToBasket');
    assert.deepEqual(add.variables.payload, { quantity: 2, date: '2026-11-28', productId: 101, bypassTimeCheck: false, price: 29, appVersion: '9.9.9', offerIds: [], fetchOffers: false });
    assert.match(add.query, /mutation addToBasket/);
    // Only the basket read and the one add: nothing past the basket.
    assert.deepEqual(sent.map((b) => b.operationName), ['fetchBasket', 'addToBasket']);
    assert.doesNotMatch(add.query, /checkout|payment|placeOrder/i);
  });
});

test("ensureInBasket: Milkbasket's refusal is a skip with a reason in words, not a failure", async () => {
  await withGql((b) => (b.operationName === 'fetchBasket' ? basket([]) : { addToBasket: { error: { error: 'insufficient_credits', errorMsg: 'Low balance' } } }), async () => {
    const r = await ensureInBasket(fakeTab(), { productId: 101, qty: 1, price: 29 });
    assert.deepEqual([r.status, r.code, r.reason], ['skipped', 'insufficient_credits', 'not enough money in the Milkbasket wallet']);
  });
});

test('ensureInBasket: a signed-out tab is a session SiteError before any call', async () => {
  const tab = fakeTab();
  tab._capture.milkbasket.headers.cityid = '1';
  await withGql(() => { throw new Error('must not be called'); }, async (sent) => {
    await assert.rejects(ensureInBasket(tab, { productId: 101, qty: 1, price: 29 }), (e) => e.kind === 'session' && /^milkbasket: /.test(e.message));
    assert.equal(sent.length, 0);
  });
});

test('productIdOf reads the id from a catalogue row', () => {
  assert.equal(productIdOf({ url: 'https://www.milkbasket.com/?product=12345' }), 12345);
  assert.equal(productIdOf({ url: '' }), null);
});
