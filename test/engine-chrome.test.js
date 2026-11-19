import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromeArgs, matchedUserAgent, launchChrome, clearStaleProfileLock } from '../src/engine/chrome.js';

function lockedProfile(owner) {
  const dir = mkdtempSync(join(tmpdir(), 'cb-lock-test-'));
  symlinkSync(owner, join(dir, 'SingletonLock'));
  symlinkSync('/tmp/org.chromium.Chromium.x/SingletonSocket', join(dir, 'SingletonSocket'));
  symlinkSync('123', join(dir, 'SingletonCookie'));
  return dir;
}
const hasLock = (dir) => {
  try {
    lstatSync(join(dir, 'SingletonLock'));
    return true;
  } catch {
    return false;
  }
};

test('clearStaleProfileLock removes a lock left by an earlier container (other hostname)', () => {
  // The 2026-11-18 failure: SingletonLock -> 4497526007c3-27 inside container 6430a1818674.
  const dir = lockedProfile('4497526007c3-27');
  try {
    const r = clearStaleProfileLock(dir, { hostname: '6430a1818674', isAlive: () => true });
    assert.deepEqual(r, { cleared: true, owner: '4497526007c3-27' });
    assert.equal(hasLock(dir), false);
    assert.equal(existsSync(join(dir, 'SingletonCookie')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearStaleProfileLock removes a same-host lock whose Chrome is gone', () => {
  const dir = lockedProfile('myhost-4242');
  try {
    const r = clearStaleProfileLock(dir, { hostname: 'myhost', isAlive: () => false });
    assert.equal(r.cleared, true);
    assert.equal(hasLock(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearStaleProfileLock keeps the lock of a live Chrome on this host', () => {
  const dir = lockedProfile('my-host-4242');
  try {
    const seen = [];
    const r = clearStaleProfileLock(dir, { hostname: 'my-host', isAlive: (p) => (seen.push(p), true) });
    assert.deepEqual(r, { cleared: false, owner: 'my-host-4242' });
    assert.deepEqual(seen, [4242]);
    assert.equal(hasLock(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearStaleProfileLock is a no-op on an unlocked profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-lock-test-'));
  try {
    assert.deepEqual(clearStaleProfileLock(dir), { cleared: false, owner: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
import { CdpTab, greasedBrands } from '../src/engine/cdp.js';

const LIVE = process.env.LIVE === '1';

test('chromeArgs has the headless, port, profile and anti-automation flags', () => {
  const args = chromeArgs({ port: 9333, profileDir: '/x' });
  for (const flag of [
    '--headless=new',
    '--remote-debugging-port=9333',
    '--user-data-dir=/x',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
  ]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
});

test('chromeArgs with headless:false has no --headless flag', () => {
  const args = chromeArgs({ port: 9333, profileDir: '/x', headless: false });
  assert.ok(!args.some((a) => a.startsWith('--headless')));
});

test('chromeArgs passes a userAgent through when given', () => {
  const args = chromeArgs({ port: 1, profileDir: '/x', userAgent: 'UA/1' });
  assert.ok(args.includes('--user-agent=UA/1'));
});

test('matchedUserAgent swaps HeadlessChrome for Chrome', () => {
  const ua =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36';
  assert.equal(
    matchedUserAgent({ 'User-Agent': ua, Browser: 'HeadlessChrome/156.0.0.0' }),
    ua.replace('HeadlessChrome/156.0.0.0', 'Chrome/156.0.0.0'),
  );
});

test('greasedBrands reproduces Chrome 156 client-hint brands', () => {
  assert.deepEqual(greasedBrands(156, '156', '156'), [
    { brand: 'Not:A-Brand', version: '8' },
    { brand: 'Chromium', version: '156' },
    { brand: 'Google Chrome', version: '156' },
  ]);
});

test('launch, open a tab, evaluate, close', { skip: !LIVE && 'LIVE=1 only', timeout: 60000 }, async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'cb-engine-test-'));
  const chrome = await launchChrome({ port: 9334, profileDir });
  try {
    assert.match(chrome.endpoint, /^http:\/\/127\.0\.0\.1:9334$/);
    assert.ok(!/Headless/.test(chrome.userAgent));
    const tab = await CdpTab.open(chrome.endpoint, 'data:text/html,<p>hi</p>');
    try {
      assert.equal(tab.alive, true);
      assert.equal(await tab.evaluate('1+1'), 2);
      await tab.setUserAgent(chrome.userAgent);
      assert.equal(await tab.evaluate('navigator.userAgent'), chrome.userAgent);
      await assert.rejects(tab.evaluate('new Promise(() => {})', { timeoutMs: 300 }), /evaluate timeout/);
      await assert.rejects(tab.evaluate('(() => { throw new Error("boom") })()'), /boom/);
    } finally {
      await tab.close();
    }
    assert.equal(tab.alive, false);
  } finally {
    await chrome.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
});
