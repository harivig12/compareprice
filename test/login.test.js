import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLogin, verifyLogin, submitPassword, checkApproved, signInId, LoginManager, LOGIN_SITES, tenDigits, pageSnippet, MAX_OTP_REQUESTS_PER_HOUR, MAX_PASSWORD_TRIES } from '../src/engine/login.js';

test('page text quoted in errors keeps only the last 4 digits of any phone-like number', () => {
  assert.equal(pageSnippet('We have sent an OTP to your phone. +91-98000 01234\n Resend', 200), 'We have sent an OTP to your phone. ••••••1234 Resend');
  assert.equal(pageSnippet('Enter 4 digit OTP · 600045 · ₹199', 200), 'Enter 4 digit OTP · ••••••0045 · ₹199');
  assert.equal(pageSnippet('a'.repeat(300), 10), 'aaaaaaaaaa');
});

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
      if (js === cfg.sessionCheck) return s.stage === 'done';
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
  const r = await startLogin(driver, 'milkbasket', '+91 98000 00000');
  assert.equal(r.step, 'otp');
  assert.match(r.message, /••••••0000/);
  assert.equal(s.typed, '9800000000');
  assert.equal(s.url, 'https://www.milkbasket.com/login');
  assert.deepEqual(s.clicks.slice(0, 2), ['phone', 'submitPhone']);
  const v = await verifyLogin(driver, 'milkbasket', '123456');
  assert.deepEqual(v, { loggedIn: true });
  assert.equal(s.typedKeys, '123456');
});

test('a wrong OTP is a specific session error, not a silent timeout', async () => {
  const { driver } = fakePage('milkbasket', { wrongOtp: true });
  await startLogin(driver, 'milkbasket', '9800000000');
  await assert.rejects(() => verifyLogin(driver, 'milkbasket', '000000'), (e) => e.kind === 'session' && /rejected that OTP/.test(e.message));
});

/**
 * Amazon's sign-in as a script: number or email -> password page -> then
 * signed in, a verification code, a puzzle, or "approve on your phone".
 */
function fakeAmazon({ password = 'right-pass', after = 'done' } = {}) {
  const cfg = LOGIN_SITES.amazon;
  const s = { stage: 'id', id: '', pw: null, wrongPw: false, remember: false, otp: '' };
  const driver = {
    goto: async () => { s.stage = 'id'; },
    has: async (js) => {
      if (js === cfg.phoneInput) return s.stage === 'id';
      if (js === cfg.passwordInput) return s.stage === 'password';
      if (js === cfg.captcha) return s.stage === 'captcha';
      if (js === cfg.otpInput) return s.stage === 'otp';
      return false;
    },
    click: async (js) => {
      if (js === cfg.submitPhone && s.stage === 'id') s.stage = 'password';
      if (js === cfg.rememberMe) s.remember = true;
      if (js === cfg.submitPassword && s.stage === 'password') {
        s.wrongPw = s.pw !== password;
        if (!s.wrongPw) s.stage = after;
        s.pw = null;
      }
      if (js === cfg.submitOtp && s.stage === 'otp' && s.otp === '123456') s.stage = 'done';
      return 'clicked';
    },
    type: async (t) => { if (s.stage === 'password') s.pw = (s.pw ?? '') + t; else s.id += t; },
    typeKeys: async (t) => { s.otp = t; },
    text: async () => (s.wrongPw ? 'Your password is incorrect' : s.stage === 'approve' ? 'We sent a notification to your phone. Approve the notification to sign in' : 'Sign in'),
    url: async () => (s.stage === 'done' ? 'https://www.amazon.in/' : 'https://www.amazon.in/ap/signin'),
    sleep: async () => {},
  };
  return { driver, s };
}

test('amazon: number or email, then the password page; the password signs in and ticks "keep me signed in"', async () => {
  for (const id of ['98000 00000', 'Shopper.One@example.com']) {
    const { driver, s } = fakeAmazon();
    const r = await startLogin(driver, 'amazon', id);
    assert.equal(r.step, 'password');
    assert.equal(s.id, id.includes('@') ? id : '9800000000');
    assert.match(r.message, id.includes('@') ? /S•••@example\.com/ : /••••••0000/);
    assert.deepEqual(await submitPassword(driver, 'amazon', 'right-pass'), { loggedIn: true });
    assert.equal(s.remember, true);
  }
});

test('amazon: wrong password, puzzle, verification code and phone approval each say what happened', async () => {
  let p = fakeAmazon();
  await startLogin(p.driver, 'amazon', '9800000000');
  await assert.rejects(() => submitPassword(p.driver, 'amazon', 'nope'), (e) => e.code === 'wrong_password' && /^amazon: .*incorrect/.test(e.message) && !e.message.includes('nope'));

  p = fakeAmazon({ after: 'captcha' });
  await startLogin(p.driver, 'amazon', '9800000000');
  await assert.rejects(() => submitPassword(p.driver, 'amazon', 'right-pass'), (e) => e.kind === 'blocked' && e.code === 'captcha' && /puzzle/.test(e.message));

  p = fakeAmazon({ after: 'otp' });
  await startLogin(p.driver, 'amazon', '9800000000');
  assert.equal((await submitPassword(p.driver, 'amazon', 'right-pass')).step, 'otp');
  assert.deepEqual(await verifyLogin(p.driver, 'amazon', '123456'), { loggedIn: true });

  p = fakeAmazon({ after: 'approve' });
  await startLogin(p.driver, 'amazon', '9800000000');
  assert.equal((await submitPassword(p.driver, 'amazon', 'right-pass')).step, 'approve');
  await assert.rejects(() => checkApproved(p.driver, 'amazon'), (e) => e.code === 'not_approved');
  p.s.stage = 'done';
  assert.deepEqual(await checkApproved(p.driver, 'amazon'), { loggedIn: true });
});

test('amazon: the password box appearing between two checks still goes to the password step (live race, 2026-11-19)', async () => {
  const p = fakeAmazon();
  const cfg = LOGIN_SITES.amazon;
  let pwChecks = 0;
  const has = p.driver.has;
  // First password check of a turn says no, the second yes: the page just changed.
  p.driver.has = async (js) => (js === cfg.passwordInput && p.s.stage === 'password' ? ++pwChecks > 1 : has(js));
  const r = await startLogin(p.driver, 'amazon', '9800000000');
  assert.equal(r.step, 'password');
});

test('sign-in ids: email only where the site takes one; masked hints', () => {
  assert.deepEqual(signInId('amazon', 'a.b@example.com'), { value: 'a.b@example.com', hint: 'a•••@example.com', last4: null });
  assert.throws(() => signInId('amazon', 'not-an-email@'), /email doesn't look right/);
  assert.throws(() => signInId('milkbasket', 'a.b@example.com'), (e) => e.kind === 'parse' && /10-digit mobile number$/.test(e.message));
  assert.equal(signInId('zepto', '+91 98000 01234').hint, '••••••1234');
});

test('manager, amazon: password step, wrong password retries (max 3), then signed in; password never on disk or in logs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'basket-login-'));
  try {
    const logs = [];
    const file = join(dir, 's.json');
    let page = fakeAmazon();
    const m = new LoginManager({ file, log: (l) => logs.push(l), getDriver: async () => page.driver });
    const st = () => m.status().find((x) => x.id === 'amazon');
    assert.equal(st().method, 'password');
    assert.equal(st().acceptsEmail, true);
    m.start('amazon', 'shopper@example.com');
    await m.whenSettled('amazon');
    assert.equal(st().state, 'password_needed');
    assert.equal(st().secret, 'password');
    assert.equal(st().pending, true);
    await assert.rejects(() => m.verify('amazon', 'wrong-1'), /incorrect/);
    assert.equal(st().state, 'password_needed', 'a wrong password stays on the password step');
    assert.deepEqual(await m.verify('amazon', 'right-pass'), { loggedIn: true });
    assert.equal(st().state, 'signed_in');
    assert.equal(st().phoneHint, 's•••@example.com');
    const raw = readFileSync(file, 'utf8');
    for (const secret of ['right-pass', 'wrong-1', 'shopper@example.com']) {
      assert.ok(!raw.includes(secret), `${secret} not on disk`);
      assert.ok(logs.every((l) => !l.includes(secret)), `${secret} not in logs`);
    }

    // Three wrong passwords stop the sign-in so the account isn't locked.
    page = fakeAmazon();
    const m2 = new LoginManager({ file: join(dir, 's2.json'), getDriver: async () => page.driver });
    m2.start('amazon', '9800000000');
    await m2.whenSettled('amazon');
    for (let i = 1; i < MAX_PASSWORD_TRIES; i++) await assert.rejects(() => m2.verify('amazon', 'bad'));
    await assert.rejects(() => m2.verify('amazon', 'bad'), /3 wrong passwords/);
    assert.equal(m2.status().find((x) => x.id === 'amazon').state, 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manager: a different number on an already signed-in site is refused up front, with the reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'basket-login-'));
  try {
    const file = join(dir, 's.json');
    writeFileSync(file, JSON.stringify({ instamart: { loggedInAt: '2026-11-19T14:56:33.243Z', phoneLast4: '0000' } }));
    let opened = 0;
    const m = new LoginManager({ file, getDriver: async () => { opened++; return fakePage('milkbasket').driver; } });
    assert.throws(() => m.start('instamart', '9800001234'), (e) => e.code === 'other_account' && /already signed in as ••••••0000/.test(e.message) && /\+ Add account/.test(e.message));
    assert.equal(opened, 0, 'no page touched');
    // Zepto has one account only: the hint says sign out instead.
    writeFileSync(file, JSON.stringify({ zepto: { loggedInAt: '2026-11-19T14:56:33.243Z', phoneLast4: '0000' } }));
    assert.throws(() => m.start('zepto', '9800001234'), (e) => e.code === 'other_account' && /Sign out first/.test(e.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manager, amazon: a code after the password goes to the OTP step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'basket-login-'));
  try {
    const page = fakeAmazon({ after: 'otp' });
    const m = new LoginManager({ file: join(dir, 's.json'), getDriver: async () => page.driver });
    m.start('amazon', '9800000000');
    await m.whenSettled('amazon');
    const r = await m.verify('amazon', 'right-pass');
    assert.equal(r.step, 'otp');
    assert.equal(m.status().find((x) => x.id === 'amazon').state, 'otp_sent');
    assert.deepEqual(await m.verify('amazon', '123456'), { loggedIn: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('instamart: "Sign in" then "Login" open the number box, then number -> OTP', async () => {
  const cfg = LOGIN_SITES.instamart;
  const s = { stage: 'closed', typed: '', otp: '', clicks: [] };
  const driver = {
    goto: async () => { s.stage = 'closed'; },
    has: async (js) => (js === cfg.phoneInput ? s.stage === 'phone' : js === cfg.otpInput ? s.stage === 'otp' : false),
    click: async (js) => {
      if (js === cfg.open[0] && s.stage === 'closed') { s.clicks.push('sign in'); s.stage = 'sheet'; }
      else if (js === cfg.open[1] && s.stage === 'sheet') { s.clicks.push('login'); s.stage = 'phone'; }
      else if (js === cfg.submitPhone && s.stage === 'phone') { s.clicks.push('submit'); s.stage = 'otp'; }
      else if (js === cfg.submitOtp && s.stage === 'otp' && s.otp === '123456') s.stage = 'done';
      return 'clicked';
    },
    type: async (t) => { s.typed += t; },
    typeKeys: async (t) => { s.otp = t; },
    text: async () => (s.stage === 'done' ? 'Instamart' : 'Login'),
    url: async () => 'https://www.swiggy.com/instamart',
    sleep: async () => {},
  };
  const r = await startLogin(driver, 'instamart', '98000 00000');
  assert.equal(r.step, 'otp');
  assert.deepEqual(s.clicks.slice(0, 3), ['sign in', 'login', 'submit']);
  assert.equal(s.typed, '9800000000');
  assert.deepEqual(await verifyLogin(driver, 'instamart', '123456'), { loggedIn: true });
  assert.equal(LOGIN_SITES.instamart.secret, undefined, 'mobile + OTP, not a password');
});

test('bigbasket: "Login/ Sign Up" opens the number box, then number -> OTP', async () => {
  const cfg = LOGIN_SITES.bigbasket;
  const s = { stage: 'home', otp: '', typed: '' };
  const driver = {
    goto: async () => { s.stage = 'home'; },
    has: async (js) => (js === cfg.phoneInput ? s.stage === 'phone' : js === cfg.otpInput ? s.stage === 'otp' : false),
    click: async (js) => {
      if (js === cfg.open && s.stage === 'home') s.stage = 'phone';
      else if (js === cfg.submitPhone && s.stage === 'phone') s.stage = 'otp';
      else if (js === cfg.submitOtp && s.stage === 'otp' && s.otp === '123456') s.stage = 'done';
      return 'clicked';
    },
    type: async (t) => { s.typed += t; },
    typeKeys: async (t) => { s.otp = t; },
    text: async () => 'bigbasket',
    url: async () => 'https://www.bigbasket.com/',
    sleep: async () => {},
  };
  assert.equal((await startLogin(driver, 'bigbasket', '9800000000')).step, 'otp');
  assert.equal(s.typed, '9800000000');
  assert.deepEqual(await verifyLogin(driver, 'bigbasket', '123456'), { loggedIn: true });
  assert.equal(LOGIN_SITES.bigbasket.multiAccount, undefined, 'one account only');
});

test('bigbasket: an Access Denied page during sign-in stops with blocked, no retry', async () => {
  let gotos = 0;
  const driver = {
    goto: async () => { gotos++; }, has: async () => false, click: async () => 'clicked', type: async () => {}, typeKeys: async () => {},
    text: async () => 'Access Denied You don\'t have permission to access this server. Reference #18.6f2c',
    url: async () => 'https://www.bigbasket.com/', sleep: async () => {},
  };
  await assert.rejects(() => startLogin(driver, 'bigbasket', '9800000000'), (e) => e.kind === 'blocked' && e.code === 'bot_wall' && /^bigbasket: BigBasket is showing its bot-protection page/.test(e.message));
  assert.equal(gotos, 1);
});

test('milkbasket: OTP accepted but no session (new number, sign-up unfinished) is not "signed in"', async () => {
  const { driver, s } = fakePage('milkbasket');
  const cfg = LOGIN_SITES.milkbasket;
  const has = driver.has;
  let session = false;
  driver.has = async (js) => (js === cfg.sessionCheck ? session : has(js));
  await startLogin(driver, 'milkbasket', '9800000000');
  await assert.rejects(() => verifyLogin(driver, 'milkbasket', '123456'), (e) => e.code === 'incomplete_signup' && /^milkbasket: the OTP was accepted, but Milkbasket has no session.*pick your society/.test(e.message));
  // With a session it signs in as before.
  const p2 = fakePage('milkbasket');
  const has2 = p2.driver.has;
  p2.driver.has = async (js) => (js === cfg.sessionCheck ? true : has2(js));
  await startLogin(p2.driver, 'milkbasket', '9800000000');
  assert.deepEqual(await verifyLogin(p2.driver, 'milkbasket', '123456'), { loggedIn: true });
  session = s;
});

test('a page with no number box reports what the page says', async () => {
  const { driver } = fakePage('milkbasket', { noPhoneBox: true });
  await assert.rejects(() => startLogin(driver, 'milkbasket', '9800000000'), (e) => e.kind === 'parse' && /no mobile-number box/.test(e.message));
});

test('input is validated before any page is touched', async () => {
  const { driver, s } = fakePage('milkbasket');
  await assert.rejects(() => startLogin(driver, 'milkbasket', '12345'), /10-digit/);
  await assert.rejects(() => verifyLogin(driver, 'milkbasket', '12'), /4 to 8 digits/);
  assert.equal(s.url, '');
  assert.equal(tenDigits('+91-98000 00000'), '9800000000');
});

test('manager: start returns at once, the OTP step runs in the background, status shows each state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'basket-login-'));
  try {
    const file = join(dir, 'sessions.json');
    let t = 1_000_000;
    const logs = [];
    const pages = { milkbasket: fakePage('milkbasket') };
    const m = new LoginManager({ file, now: () => t, log: (x) => logs.push(x), getDriver: async (id) => pages[id].driver });
    const st = (id = 'milkbasket') => m.status().find((x) => x.id === id);
    assert.equal(st().state, 'idle');
    await assert.rejects(() => m.verify('milkbasket', '123456'), /ask for an OTP first/);
    assert.throws(() => m.start('milkbasket', '12345'), /10-digit/);

    const r = m.start('milkbasket', '9800000000');
    assert.equal(r.state, 'sending');
    assert.match(r.message, /••••••0000/);
    assert.equal(st().state, 'sending');
    await assert.rejects(() => m.verify('milkbasket', '123456'), /still on its way/);
    await m.whenSettled('milkbasket');
    assert.equal(st().state, 'otp_sent');
    assert.equal(st().pending, true);

    await m.verify('milkbasket', '123456');
    assert.equal(st().state, 'signed_in');
    assert.equal(st().loggedIn, true);
    assert.equal(st().phoneHint, '••••••0000');
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes('9800000000') && !raw.includes('123456'), 'no full number or OTP on disk');
    assert.ok(logs.length >= 3 && logs.every((l) => !l.includes('9800000000') && !l.includes('123456')), 'logs are masked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manager: a failed OTP request is shown as an error state with the reason; resend waits 30 s; 3 per hour max', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'basket-login-'));
  try {
    let t = 1_000_000;
    const pages = { milkbasket: fakePage('milkbasket', { noPhoneBox: true }) };
    const m = new LoginManager({ file: join(dir, 's.json'), now: () => t, getDriver: async (id) => pages[id].driver });
    const st = () => m.status().find((x) => x.id === 'milkbasket');
    m.start('milkbasket', '9800000000');
    await m.whenSettled('milkbasket');
    assert.equal(st().state, 'error');
    assert.match(st().error, /no mobile-number box/);
    await assert.rejects(() => m.verify('milkbasket', '123456'), /request failed .*resend/);

    assert.throws(() => m.start('milkbasket', '9800000000'), (e) => e.kind === 'blocked' && /wait 30s/.test(e.message));
    assert.equal(st().resendInMs, 30_000);
    for (let i = 1; i < MAX_OTP_REQUESTS_PER_HOUR; i++) { t += 31_000; m.start('milkbasket', '9800000000'); await m.whenSettled('milkbasket'); }
    t += 31_000;
    assert.throws(() => m.start('milkbasket', '9800000000'), (e) => e.kind === 'blocked' && /limit here/.test(e.message));
    t += 3_600_001;
    m.start('milkbasket', '9800000000');
    await m.whenSettled('milkbasket');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manager: a wrong OTP keeps the OTP step open so the user can retype', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'basket-login-'));
  try {
    const pages = { milkbasket: fakePage('milkbasket', { wrongOtp: true }) };
    const m = new LoginManager({ file: join(dir, 's.json'), getDriver: async (id) => pages[id].driver });
    m.start('milkbasket', '9800000000');
    await m.whenSettled('milkbasket');
    await assert.rejects(() => m.verify('milkbasket', '000000'), /rejected that OTP/);
    const st = m.status().find((x) => x.id === 'milkbasket');
    assert.equal(st.state, 'otp_sent');
    assert.match(st.error, /rejected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
