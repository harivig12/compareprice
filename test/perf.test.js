import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdleCloser } from '../src/engine/idle.js';
import { BrowserPool, MEDIA_PATTERNS } from '../src/engine/pool.js';
import { chromeArgs } from '../src/engine/chrome.js';
import { pruneResults } from '../src/service.js';

function fakePool() {
  return { open: true, restarts: 0, isOpen() { return this.open; }, async restart() { this.restarts++; this.open = false; } };
}

test('idle closer: closes Chrome only after the idle time with nothing busy', async () => {
  let t = 0; let busy = false;
  const pool = fakePool();
  const c = new IdleCloser({ getPool: () => pool, isBusy: () => busy, idleMs: 300_000, now: () => t });
  t = 299_000; assert.equal(await c.tick(), false);
  t = 300_000; assert.equal(await c.tick(), true);
  assert.equal(pool.restarts, 1);
  assert.equal(await c.tick(), false, 'already closed: nothing to do');
});

test('idle closer: a job or sign-in in flight, or recent activity, keeps it open', async () => {
  let t = 0; let busy = true;
  const pool = fakePool();
  const c = new IdleCloser({ getPool: () => pool, isBusy: () => busy, idleMs: 300_000, now: () => t });
  t = 900_000; assert.equal(await c.tick(), false, 'busy');
  busy = false;
  t = 1_000_000; assert.equal(await c.tick(), false, 'busy counted as activity just now');
  t = 1_150_000; c.touch();
  t = 1_400_000; assert.equal(await c.tick(), false, 'touched 250 s ago');
  t = 1_450_001; assert.equal(await c.tick(), true);
});

test('idle closer: idleMs 0 means never close', async () => {
  const pool = fakePool();
  const c = new IdleCloser({ getPool: () => pool, isBusy: () => false, idleMs: 0, now: () => 1e12 });
  assert.equal(await c.tick(), false);
  assert.equal(pool.restarts, 0);
});

test('results retention: per-run JSON older than keepDays goes, runs.jsonl stays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basket-res-'));
  try {
    const now = Date.now();
    for (const [f, ageDays] of [['old-job1.json', 70], ['new-job2.json', 5], ['runs.jsonl', 400]]) {
      writeFileSync(join(dir, f), '{}');
      const t = new Date(now - ageDays * 86_400_000);
      utimesSync(join(dir, f), t, t);
    }
    assert.equal(pruneResults(dir, 60, now), 1);
    assert.deepEqual(readdirSync(dir).sort(), ['new-job2.json', 'runs.jsonl']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Chrome cache is capped', () => {
  assert.ok(chromeArgs({ port: 1, profileDir: '/x' }).includes('--disk-cache-size=52428800'));
});

function fakeTab() {
  const sent = [];
  return { sent, alive: true, onCrash() {}, async setUserAgent() {}, async setCookies() {}, async goto() {}, async evaluate() { return { title: 'ok', text: '' }; }, async send(m, p) { sent.push([m, p]); }, async close() { this.alive = false; } };
}

test('pool: search tabs block media when asked; the login tab unblocks it; closeTab drops a tab', async () => {
  const tabs = [];
  const pool = new BrowserPool({
    launch: async () => ({ endpoint: 'x', userAgent: 'UA', close: async () => {} }),
    openTab: async () => { const t = fakeTab(); tabs.push(t); return t; },
    sites: { zepto: { id: 'zepto', origin: 'https://z/' } },
    blockMedia: true,
  });
  const t = await pool.tab('zepto');
  assert.deepEqual(t.sent.find(([m]) => m === 'Network.setBlockedURLs')[1], { urls: MEDIA_PATTERNS });
  await pool.loginTab('zepto');
  assert.deepEqual(t.sent.filter(([m]) => m === 'Network.setBlockedURLs').at(-1)[1], { urls: [] });
  assert.equal(pool.isOpen(), true);
  await pool.closeTab('zepto');
  assert.equal(t.alive, false);
  const t2 = await pool.tab('zepto');
  assert.notEqual(t2, t, 'reopened on demand');
  await pool.restart();
  assert.equal(pool.isOpen(), false);
});

test('pool: releasing a login tab while a job may search that site keeps it open and re-blocks media', async () => {
  const pool = new BrowserPool({
    launch: async () => ({ endpoint: 'x', userAgent: 'UA', close: async () => {} }),
    openTab: async () => fakeTab(),
    sites: { zepto: { id: 'zepto', origin: 'https://z/' } },
    blockMedia: true,
  });
  const t = await pool.loginTab('zepto');
  await pool.releaseLoginTab('zepto', { inUse: true });
  assert.equal(t.alive, true, 'a running search keeps its tab');
  assert.deepEqual(t.sent.filter(([m]) => m === 'Network.setBlockedURLs').at(-1)[1], { urls: MEDIA_PATTERNS });
  assert.equal(await pool.tab('zepto'), t);
  await pool.releaseLoginTab('zepto', { inUse: false });
  assert.equal(t.alive, false, 'nothing searching: the tab is closed');
  await pool.restart();
});

test('pruneResults: a missing results dir is not an error', () => {
  assert.equal(pruneResults(join(tmpdir(), 'basket-no-such-dir-' + process.pid), 60), 0);
});

test('the profile never offers to save passwords; other preferences are kept', async () => {
  const { disablePasswordSaving } = await import('../src/engine/chrome.js');
  const { readFileSync, mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'basket-prefs-'));
  try {
    disablePasswordSaving(dir);
    const file = join(dir, 'Default', 'Preferences');
    let p = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(p.credentials_enable_service, false);
    assert.equal(p.profile.password_manager_enabled, false);
    mkdirSync(join(dir, 'Default'), { recursive: true });
    writeFileSync(file, JSON.stringify({ intl: { accept_languages: 'en-IN' }, profile: { name: 'x', password_manager_enabled: true } }));
    disablePasswordSaving(dir);
    p = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(p.intl, { accept_languages: 'en-IN' });
    assert.equal(p.profile.name, 'x');
    assert.equal(p.profile.password_manager_enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
