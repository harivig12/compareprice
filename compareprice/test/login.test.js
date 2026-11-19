import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLogin, verifyLogin, LoginManager, LOGIN_SITES, tenDigits, MAX_OTP_REQUESTS_PER_HOUR } from '../src/engine/login.js';

/**
 * A scripted login page: the real selectors are strings evaluated in Chrome,
 * so the fake answers by matching which selector the flow asks about.
 */
function fakePage(site, { otpAfterPhone = true, password = false, wrongOtp = false, noPhoneBox = false } = {}) {
  const cfg = LOGIN_SITES[site];
  const s = { stage: 'phone', typed: '', clicks: [], url: '' };
  const driver = {
    goto: async (u) => { s.url = u; s.stage = 'phone'; },
    has: async (js) => {
      if (js === cfg.phoneInput) return s.stage === 'phone' && !noPhoneBox;
      if (js === cfg.otpInput) return s.stage === 'otp';
      if (js === cfg.passwordInput) return s.stage === 'password';
      return false;
    },
    click: async (js) => {
      s.clicks.push(js === cfg.phoneInput ? 'phone' : js === cfg.submitPhone ? 'submitPhone' : js === cfg.otpLink ? 'otpLink' : js === cfg.submitOtp ? 'submitOtp' : 'otpFocus');
      if (js === cfg.submitPhone) s.stage = password ? 'password' : otpAfterPhone ? 'otp' : 'phone';
      if (js === cfg.otpLink && s.stage === 'password') s.stage = 'otp';
      if (js === cfg.submitOtp && s.stage === 'otp' && s.typedKeys === '123456' && !wrongOtp) s.stage = 'done';
      return js === cfg.otpLink && !cfg.otpLink ? null : 'clicked';
    },
    type: async (t) => { s.typed += t; },
    typeKeys: async (t) => { s.typedKeys = t; },
    text: async () => (wrongOtp && s.typedKeys ? 'Invalid OTP, please try again' : s.stage === 'done' ? 'Welcome' : 'Sign in'),
    url: async () => s.url,
    sleep: async () => {},
  };
  return { driver, s };
}

test('milkbasket: number is typed without +91, "Get OTP" is pressed, then OTP is entered and sign-in confirmed', async () => {
  const { driver, s } = fakePage('milkbasket');
  const r = await startLogin(driver, 'milkbasket', '+91 97110 20494');
  assert.equal(r.step, 'otp');
  assert.match(r.message, /••••••0494/);
  assert.equal(s.typed, '9711020494');
  assert.equal(s.url, 'https://www.milkbasket.com/login');
  assert.deepEqual(s.clicks.slice(0, 2), ['phone', 'submitPhone']);
  const v = await verifyLogin(driver, 'milkbasket', '123456');
  assert.deepEqual(v, { loggedIn: true });
  assert.equal(s.typedKeys, '123456');
});

test('a wrong OTP is a specific session error, not a silent timeout', async () => {
  const { driver } = fakePage('milkbasket', { wrongOtp: true });
  await startLogin(driver, 'milkbasket', '9711020494');
  await assert.rejects(() => verifyLogin(driver, 'milkbasket', '000000'), (e) => e.kind === 'session' && /rejected that OTP/.test(e.message));
});

test('amazon asking for a password (no OTP option) says so', async () => {
  const { driver } = fakePage('amazon', { password: true });
  // The fake has no OTP link, so click() on it must fail.
  const orig = driver.click;
  driver.click = async (js, ...r) => (js === LOGIN_SITES.amazon.otpLink ? null : orig(js, ...r));
  await assert.rejects(() => startLogin(driver, 'amazon', '9711020494'), (e) => e.kind === 'session' && /asks for a password and offers no OTP/.test(e.message));
});

test('amazon with a "Get OTP" link switches from password to OTP', async () => {
  const { driver } = fakePage('amazon', { password: true });
  const r = await startLogin(driver, 'amazon', '9711020494');
  assert.equal(r.step, 'otp');
});

test('a page with no number box reports what the page says', async () => {
  const { driver } = fakePage('milkbasket', { noPhoneBox: true });
  await assert.rejects(() => startLogin(driver, 'milkbasket', '9711020494'), (e) => e.kind === 'parse' && /no mobile-number box/.test(e.message));
});

test('input is validated before any page is touched', async () => {
  const { driver, s } = fakePage('milkbasket');
  await assert.rejects(() => startLogin(driver, 'milkbasket', '12345'), /10-digit/);
  await assert.rejects(() => verifyLogin(driver, 'milkbasket', '12'), /4 to 8 digits/);
  assert.equal(s.url, '');
  assert.equal(tenDigits('+91-97110 20494'), '9711020494');
});

test('manager: status is shown, only the last four digits are kept, and the OTP is limited per hour', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'basket-login-'));
  try {
    const file = join(dir, 'sessions.json');
    let t = 1_000_000;
    const pages = { milkbasket: fakePage('milkbasket') };
    const m = new LoginManager({ file, now: () => t, getDriver: async (id) => pages[id].driver });
    assert.equal(m.status().find((x) => x.id === 'milkbasket').loggedIn, false);
    await assert.rejects(() => m.verify('milkbasket', '123456'), /ask for an OTP first/);

    await m.start('milkbasket', '9711020494');
    assert.equal(m.status().find((x) => x.id === 'milkbasket').pending, true);
    await m.verify('milkbasket', '123456');
    const st = m.status().find((x) => x.id === 'milkbasket');
    assert.equal(st.loggedIn, true);
    assert.equal(st.phoneHint, '••••••0494');
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes('9711020494') && !raw.includes('123456'), 'no full number or OTP on disk');

    for (let i = 1; i < MAX_OTP_REQUESTS_PER_HOUR; i++) { t += 1000; await m.start('milkbasket', '9711020494'); }
    await assert.rejects(() => m.start('milkbasket', '9711020494'), (e) => e.kind === 'blocked' && /limit here/.test(e.message));
    t += 3_600_001;
    await m.start('milkbasket', '9711020494');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
