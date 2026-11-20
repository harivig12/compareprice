import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAccounts, MAX_ACCOUNTS } from '../src/engine/accounts.js';
import { LoginManager, LOGIN_SITES } from '../src/engine/login.js';
import { PoolSet } from '../src/engine/poolset.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'basket-acc-'));
const multi = (s) => Boolean(LOGIN_SITES[s]?.multiAccount);

test('migrates sessions.json into accounts.json; the legacy file is left as it was', () => {
  const dir = tmp();
  try {
    const legacy = join(dir, 'sessions.json');
    writeFileSync(legacy, JSON.stringify({ zepto: { loggedInAt: '2026-11-19T12:55:26.126Z', phoneLast4: '0000' } }));
    const a = openAccounts(join(dir, 'accounts.json'), { legacyFile: legacy, multiAccount: multi });
    assert.deepEqual(a.list('zepto'), [{ id: 'main', name: 'Main', hint: '••••••0000', loggedInAt: '2026-11-19T12:55:26.126Z', profile: 'chrome-profile' }]);
    a.markSignedIn('instamart', 'main', { hint: '••••••1111', at: '2026-11-19T14:00:00Z' });
    assert.ok(existsSync(join(dir, 'accounts.json')));
    assert.equal(JSON.parse(readFileSync(legacy, 'utf8')).zepto.phoneLast4, '0000');
    assert.equal(a.list('zepto')[0].hint, '••••••0000', 'migrated rows survive the first write');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('add(): extra accounts only on multi-account sites, max 3, unique names, own profile', () => {
  const dir = tmp();
  try {
    const a = openAccounts(join(dir, 'accounts.json'), { multiAccount: multi });
    assert.throws(() => a.add('zepto', { name: 'Amma' }), /zepto: one account only/);
    const amma = a.add('instamart', { name: '  Amma <b>' });
    assert.deepEqual(amma, { id: 'a2', name: 'Amma b', hint: null, loggedInAt: null, profile: 'profiles/instamart-a2' });
    assert.throws(() => a.add('instamart', { name: 'amma b' }), /already an account called/);
    a.add('instamart', { name: 'Appa' });
    assert.equal(a.list('instamart').length, MAX_ACCOUNTS);
    assert.throws(() => a.add('instamart', { name: 'Four' }), /3 accounts is the limit/);
    assert.throws(() => a.remove('instamart', 'main'), /can be signed out, not removed/);
    a.remove('instamart', 'a2');
    assert.equal(a.add('instamart', { name: 'Again' }).id, 'a2', 'a freed id is reused');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A scripted OTP page per account (each account has its own "browser"). */
function otpPage() {
  const cfg = LOGIN_SITES.instamart;
  const s = { stage: 'closed', otp: '' };
  return {
    goto: async () => { s.stage = 'closed'; },
    has: async (js) => (js === cfg.phoneInput ? s.stage === 'phone' : js === cfg.otpInput ? s.stage === 'otp' : false),
    click: async (js) => {
      if (js === cfg.open[0] && s.stage === 'closed') s.stage = 'sheet';
      else if (js === cfg.open[1] && s.stage === 'sheet') s.stage = 'phone';
      else if (js === cfg.submitPhone && s.stage === 'phone') s.stage = 'otp';
      else if (js === cfg.submitOtp && s.stage === 'otp' && s.otp === '123456') s.stage = 'done';
      return 'clicked';
    },
    type: async () => {},
    typeKeys: async (t) => { s.otp = t; },
    text: async () => 'Login',
    url: async () => 'https://www.swiggy.com/instamart',
    sleep: async () => {},
  };
}

test('manager: a second Instamart account signs in on its own browser; the guard is per account', async () => {
  const dir = tmp();
  try {
    const drivers = new Map();
    const released = [];
    const m = new LoginManager({
      file: join(dir, 'accounts.json'),
      getDriver: async (site, acc) => { if (!drivers.has(acc.id)) drivers.set(acc.id, otpPage()); return drivers.get(acc.id); },
      release: (site, acc) => released.push(acc.id),
    });
    m.start('instamart', '9800000000');
    await m.whenSettled('instamart');
    await m.verify('instamart', '123456');

    const r = m.start('instamart', '9800001234', { name: 'Amma' });
    assert.equal(r.account, 'a2');
    await m.whenSettled('instamart', 'a2');
    assert.deepEqual(await m.verify('instamart', '123456', { account: 'a2' }), { loggedIn: true });
    assert.deepEqual([...drivers.keys()], ['main', 'a2'], 'separate browsers');

    const row = m.status().find((x) => x.id === 'instamart');
    assert.equal(row.multiAccount, true);
    assert.equal(row.canAdd, true);
    assert.deepEqual(row.accounts.map((a) => [a.id, a.name, a.hint, a.loggedIn]), [['main', 'Main', '••••••0000', true], ['a2', 'Amma', '••••••1234', true]]);
    // The main row's own fields stay as before.
    assert.equal(row.phoneHint, '••••••0000');

    assert.throws(() => m.start('instamart', '9800009999', { account: 'a2' }), (e) => e.code === 'other_account');
    assert.throws(() => m.start('instamart', '9800001234', { name: 'Again' }), (e) => e.code === 'same_account' && /already the "Amma" account/.test(e.message));
    assert.ok(!readFileSync(join(dir, 'accounts.json'), 'utf8').match(/98000/), 'no full numbers on disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sign out: main clears its site only; an extra account is removed; busy is refused and changes nothing', async () => {
  const dir = tmp();
  try {
    const cleared = [];
    let busy = false;
    const a = openAccounts(join(dir, 'accounts.json'), { multiAccount: multi });
    a.markSignedIn('instamart', 'main', { hint: '••••••0000' });
    const extra = a.add('instamart', { name: 'Amma' });
    a.markSignedIn('instamart', extra.id, { hint: '••••••1234' });
    const m = new LoginManager({ file: join(dir, 'accounts.json'), accounts: a, getDriver: async () => null, clearSession: async (site, acc) => cleared.push(`${site}:${acc.id}`), isBusy: () => busy });
    busy = true;
    await assert.rejects(() => m.signOut('instamart', 'a2'), (e) => e.code === 'busy' && /^instamart: busy, try again after the current run$/.test(e.message));
    assert.equal(a.list('instamart').length, 2);
    busy = false;
    assert.deepEqual(await m.signOut('instamart', 'a2'), { signedOut: true, removed: true, account: 'a2' });
    assert.deepEqual(await m.signOut('instamart', 'main'), { signedOut: true, removed: false, account: 'main' });
    assert.deepEqual(cleared, ['instamart:a2', 'instamart:main']);
    assert.deepEqual(a.list('instamart').map((x) => [x.id, Boolean(x.loggedInAt)]), [['main', false]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PoolSet: extra accounts get their own profile and port, closed after each step; main is shared', async () => {
  const dir = tmp();
  try {
    const made = [];
    const main = { id: 'shared' };
    const ps = new PoolSet({ dataDir: dir, getMain: () => main, makePool: (o) => { const p = { o, closed: false, close: async () => { p.closed = true; } }; made.push(p); return p; } });
    assert.equal(ps.forAccount('instamart', { id: 'main' }), main);
    const acc = { id: 'a2', profile: 'profiles/instamart-a2' };
    const order = [];
    const one = ps.with('instamart', acc, async (pool) => { order.push('1 start'); assert.equal(ps.busy(acc), true); await new Promise((r) => setTimeout(r, 20)); order.push('1 end'); return pool; });
    const two = ps.with('instamart', acc, async () => { order.push('2'); throw new Error('boom'); });
    const pool = await one;
    await assert.rejects(two, /boom/);
    assert.deepEqual(order, ['1 start', '1 end', '2'], 'one step at a time per account');
    assert.equal(pool.o.profileDir, join(dir, 'profiles/instamart-a2'));
    assert.equal(pool.o.ownLocation('instamart'), true, 'an extra account keeps its saved address');
    assert.ok(made.every((p) => p.closed), 'closed after use, even when the step threw');
    assert.equal(ps.busy(acc), false);

    mkdirSync(join(dir, 'profiles', 'instamart-a2'), { recursive: true });
    await ps.removeProfile(acc);
    assert.equal(existsSync(join(dir, 'profiles', 'instamart-a2')), false);
    await assert.rejects(() => ps.removeProfile({ id: 'a3', profile: '../../etc' }), /refusing to delete/);
    await assert.rejects(() => ps.removeProfile({ id: 'main', profile: 'chrome-profile' }), /never deleted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PoolSet: a queued second step keeps the pool open (no second Chrome on the same profile); ports never collide', async () => {
  const made = [];
  const ps = new PoolSet({ dataDir: '/tmp/x', getMain: () => ({}), makePool: (o) => { const p = { o, closed: false, close: async () => { p.closed = true; } }; made.push(p); return p; } });
  const acc = { id: 'a2', profile: 'profiles/instamart-a2' };
  let firstPool;
  const one = ps.with('instamart', acc, async (pool) => { firstPool = pool; await new Promise((r) => setTimeout(r, 10)); });
  const two = ps.with('instamart', acc, async (pool) => { assert.equal(pool, firstPool, 'same pool'); assert.equal(pool.closed, false, 'not closed under step 2'); });
  await Promise.all([one, two]);
  assert.equal(made.length, 1);
  assert.equal(made[0].closed, true, 'closed once both steps are done');
  const p1 = ps.forAccount('instamart', { id: 'a2', profile: 'profiles/instamart-a2' });
  const p2 = ps.forAccount('milkbasket', { id: 'a2', profile: 'profiles/milkbasket-a2' });
  assert.notEqual(p1.o.launch, p2.o.launch);
  assert.notEqual([...ps.extra.values()][0].port, [...ps.extra.values()][1].port);
});

test('a hand-edited accounts.json cannot point a profile outside profiles/', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ instamart: [{ id: 'a2', name: 'x', profile: '../../etc' }, { id: '../evil', name: 'y', profile: 'p' }] }));
    const a = openAccounts(join(dir, 'accounts.json'), { multiAccount: multi });
    assert.deepEqual(a.list('instamart').map((x) => [x.id, x.profile]), [['main', 'chrome-profile'], ['a2', 'profiles/instamart-a2']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
