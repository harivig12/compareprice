/**
 * Optional site sign-ins (mobile number -> OTP) for the UI popup.
 *
 * The session lives in the headless Chrome profile (<data>/chrome-profile),
 * exactly like a phone app keeps you signed in: nothing is stored here but a
 * small "who signed in where, when" note (sessions.json) for the UI. Only the
 * last four digits of the number are kept.
 *
 * Flow per site is a few steps on the site's own login page, driven through a
 * small `driver` (goto / has / click / type / text) so it can be tested with a
 * scripted fake. The OTP itself is typed by the user into the popup; nothing
 * here reads SMS.
 *
 * Status: written 2026-11-19 from the pages' structure (Milkbasket /login:
 * "Enter Mobile Number" + "Get OTP"). The OTP and post-login steps have NOT
 * been exercised against the live sites yet: no OTP was requested during
 * development. Failures are reported as exact, specific errors.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SiteError } from './errors.js';
import { cdpClick, typeText } from './sites/_util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Max OTP requests per site per hour: stops SMS spam and account lockouts. */
export const MAX_OTP_REQUESTS_PER_HOUR = 3;

export const LOGIN_SITES = Object.freeze({
  milkbasket: {
    label: 'Milkbasket',
    why: 'Guests are fixed to its default city; searching needs an account with your society.',
    url: 'https://www.milkbasket.com/login',
    phoneInput: `[...document.querySelectorAll('input')].find((i) => i.getClientRects().length && /mobile|phone/i.test(i.placeholder || i.name || i.type))`,
    submitPhone: `[...document.querySelectorAll('button')].find((b) => b.getClientRects().length && !b.disabled && /get otp|send otp|continue|proceed/i.test(b.textContent))`,
    otpInput: `[...document.querySelectorAll('input')].filter((i) => i.getClientRects().length && /otp|code|verification/i.test((i.placeholder || '') + (i.name || '') + (i.autocomplete || '') + (i.id || ''))).length > 0 || document.querySelectorAll('input[maxlength="1"]').length >= 4`,
    submitOtp: `[...document.querySelectorAll('button')].find((b) => b.getClientRects().length && !b.disabled && /verify|submit|login|continue|confirm/i.test(b.textContent))`,
    wrongOtp: /invalid otp|incorrect otp|wrong otp|otp (is )?(invalid|incorrect|expired)/i,
  },
  zepto: {
    label: 'Zepto',
    why: 'At your location Zepto asks you to sign in before it shows search results.',
    url: 'https://www.zepto.com/',
    // The header's "Login" opens a sheet with the number box.
    open: `[...document.querySelectorAll('button,a,span')].find((e) => e.getClientRects().length && /^login$/i.test(e.textContent.trim()))`,
    phoneInput: `[...document.querySelectorAll('input')].find((i) => i.getClientRects().length && (i.type === 'tel' || /mobile|phone/i.test(i.placeholder || i.name || '')))`,
    submitPhone: `[...document.querySelectorAll('button')].find((b) => b.getClientRects().length && !b.disabled && /continue|get otp|send otp/i.test(b.textContent))`,
    otpInput: `[...document.querySelectorAll('input')].filter((i) => i.getClientRects().length && (/otp|code/i.test((i.placeholder || '') + (i.name || '') + (i.autocomplete || '')) || i.maxLength === 1)).length > 0`,
    submitOtp: `[...document.querySelectorAll('button')].find((b) => b.getClientRects().length && !b.disabled && /verify|continue|submit|login/i.test(b.textContent))`,
    wrongOtp: /invalid otp|incorrect otp|wrong otp|otp (is )?(invalid|incorrect|expired)/i,
  },
  amazon: {
    label: 'Amazon',
    why: 'Amazon Now can show your saved delivery address after you sign in.',
    url: 'https://www.amazon.in/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.in%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=inflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0',
    phoneInput: `document.querySelector('#ap_email_login, #ap_email, input[name=email]')`,
    submitPhone: `document.querySelector('#continue, input#continue, #continue-announce')`,
    // After "continue", Amazon either asks for a password or sends an OTP.
    otpInput: `!!document.querySelector('#auth-mfa-otpcode, input[name=otpCode], input[name=code], #cvf-input-code, input[autocomplete=one-time-code]')`,
    passwordInput: `!!document.querySelector('#ap_password')`,
    otpLink: `[...document.querySelectorAll('a,button,span.a-button-text,input[type=submit]')].find((e) => e.getClientRects().length && /otp|one.?time/i.test(e.textContent || e.value || ''))`,
    submitOtp: `document.querySelector('#auth-signin-button, #cvf-submit-otp-button input, input[type=submit]:not(#continue), #a-autoid-0 input')`,
    wrongOtp: /incorrect otp|invalid otp|wrong otp|enter a valid|incorrect code/i,
  },
});

export const tenDigits = (phone) => String(phone ?? '').replace(/\D/g, '').slice(-10);

/** A real driver over a CdpTab. */
export function tabDriver(tab) {
  return {
    goto: (url) => tab.goto(url, { waitMs: 15000 }),
    has: (js) => tab.evaluate(`!!(${js})`, { timeoutMs: 8000 }).catch(() => false),
    click: (js, ms = 8000) => cdpClick(tab, js, { waitMs: ms }),
    type: (text) => typeText(tab, text),
    // OTP boxes that auto-advance need real key events.
    async typeKeys(text) {
      for (const ch of text) {
        await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
        await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
        await sleep(60);
      }
    },
    text: () => tab.evaluate(`document.body ? document.body.innerText : ''`, { timeoutMs: 8000 }).catch(() => ''),
    url: () => tab.evaluate('location.href', { timeoutMs: 5000 }).catch(() => ''),
    sleep,
  };
}

async function waitFor(driver, js, tries = 30, gap = 500) {
  for (let i = 0; i < tries; i++) {
    if (await driver.has(js)) return true;
    await driver.sleep(gap);
  }
  return false;
}

/**
 * Enter the phone number and ask for the OTP.
 * @returns {Promise<{ step: 'otp', message: string }>}
 */
export async function startLogin(driver, siteId, phone) {
  const cfg = LOGIN_SITES[siteId];
  if (!cfg) throw new SiteError('not_found', `${siteId}: no sign-in flow`, { site: siteId });
  const number = tenDigits(phone);
  if (number.length !== 10) throw new SiteError('parse', `${siteId}: enter a 10-digit mobile number`, { site: siteId });

  await driver.goto(cfg.url);
  if (cfg.open && !(await waitFor(driver, cfg.phoneInput, 4))) await driver.click(cfg.open, 10000);
  if (!(await waitFor(driver, cfg.phoneInput, 30))) {
    const t = (await driver.text()).replace(/\s+/g, ' ').slice(0, 120);
    throw new SiteError('parse', `${siteId}: the sign-in page has no mobile-number box (page says: "${t}")`, { site: siteId });
  }
  if ((await driver.click(cfg.phoneInput)) == null) throw new SiteError('parse', `${siteId}: could not focus the mobile-number box`, { site: siteId });
  await driver.type(number);
  await driver.sleep(400);
  if ((await driver.click(cfg.submitPhone)) == null) throw new SiteError('parse', `${siteId}: no "Get OTP" / "Continue" button after entering the number`, { site: siteId });

  // Wait for the OTP boxes; Amazon may ask for a password instead.
  for (let i = 0; i < 30; i++) {
    if (await driver.has(cfg.otpInput)) return { step: 'otp', message: `OTP sent to ••••••${number.slice(-4)}. Enter it below.` };
    if (cfg.passwordInput && (await driver.has(cfg.passwordInput))) {
      if (cfg.otpLink && (await driver.click(cfg.otpLink, 3000)) != null) {
        for (let j = 0; j < 20; j++) {
          if (await driver.has(cfg.otpInput)) return { step: 'otp', message: `OTP sent to ••••••${number.slice(-4)}. Enter it below.` };
          await driver.sleep(500);
        }
      }
      throw new SiteError('session', `${siteId}: this account asks for a password and offers no OTP sign-in; sign in with OTP isn't possible here`, { site: siteId });
    }
    await driver.sleep(500);
  }
  const t = (await driver.text()).replace(/\s+/g, ' ').slice(0, 160);
  throw new SiteError('timeout', `${siteId}: no OTP box appeared after asking for the OTP (page says: "${t}")`, { site: siteId });
}

/** Type the OTP and confirm the sign-in took. */
export async function verifyLogin(driver, siteId, otp) {
  const cfg = LOGIN_SITES[siteId];
  if (!cfg) throw new SiteError('not_found', `${siteId}: no sign-in flow`, { site: siteId });
  const code = String(otp ?? '').replace(/\s+/g, '');
  if (!/^\d{4,8}$/.test(code)) throw new SiteError('parse', `${siteId}: the OTP is 4 to 8 digits`, { site: siteId });
  if (!(await driver.has(cfg.otpInput))) throw new SiteError('session', `${siteId}: no OTP request is pending; ask for an OTP first`, { site: siteId });

  const focus = await driver.click(`[...document.querySelectorAll('input')].find((i) => i.getClientRects().length && (/otp|code|verification/i.test((i.placeholder || '') + (i.name || '') + (i.id || '')) || i.maxLength === 1))`, 4000);
  if (focus == null) throw new SiteError('parse', `${siteId}: could not focus the OTP box`, { site: siteId });
  await driver.typeKeys(code);
  await driver.sleep(500);
  await driver.click(cfg.submitOtp, 2500); // many sites submit on the last digit; a missing button is fine

  for (let i = 0; i < 30; i++) {
    await driver.sleep(500);
    const text = await driver.text();
    if (cfg.wrongOtp.test(text)) throw new SiteError('session', `${siteId}: the site rejected that OTP (wrong or expired). Ask for a new one`, { site: siteId });
    if (!(await driver.has(cfg.otpInput))) return { loggedIn: true };
  }
  throw new SiteError('timeout', `${siteId}: the OTP box is still showing 15 s after entering the code`, { site: siteId });
}

export class LoginManager {
  /**
   * @param {{ getDriver: (siteId: string) => Promise<object>, file: string, now?: () => number }} opts
   */
  constructor({ getDriver, file, now = () => Date.now() }) {
    this.getDriver = getDriver;
    this.file = file;
    this.now = now;
    this.requests = new Map(); // site -> number[] (OTP request times)
    this.pending = new Map(); // site -> { phoneLast4, at }
  }

  #read() {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  #write(o) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(o, null, 2) + '\n');
  }

  /** What the popup shows for each site that supports sign-in. */
  status() {
    const saved = this.#read();
    return Object.entries(LOGIN_SITES).map(([id, cfg]) => ({
      id,
      label: cfg.label,
      why: cfg.why,
      loggedIn: Boolean(saved[id]?.loggedInAt),
      since: saved[id]?.loggedInAt ?? null,
      phoneHint: saved[id]?.phoneLast4 ? `••••••${saved[id].phoneLast4}` : null,
      pending: this.pending.has(id),
    }));
  }

  async start(siteId, phone) {
    if (!LOGIN_SITES[siteId]) throw new SiteError('not_found', `${siteId}: no sign-in flow`, { site: siteId });
    const t = this.now();
    const recent = (this.requests.get(siteId) ?? []).filter((x) => t - x < 3_600_000);
    if (recent.length >= MAX_OTP_REQUESTS_PER_HOUR) {
      const waitMin = Math.ceil((recent[0] + 3_600_000 - t) / 60_000);
      throw new SiteError('blocked', `${siteId}: ${MAX_OTP_REQUESTS_PER_HOUR} OTP requests in the last hour is the limit here (to avoid locking the account). Try again in ${waitMin} min`, { site: siteId });
    }
    this.requests.set(siteId, [...recent, t]);
    const driver = await this.getDriver(siteId);
    const out = await startLogin(driver, siteId, phone);
    this.pending.set(siteId, { phoneLast4: tenDigits(phone).slice(-4), at: t });
    return out;
  }

  async verify(siteId, otp) {
    const p = this.pending.get(siteId);
    if (!p) throw new SiteError('session', `${siteId}: ask for an OTP first`, { site: siteId });
    const driver = await this.getDriver(siteId);
    const out = await verifyLogin(driver, siteId, otp);
    this.pending.delete(siteId);
    const saved = this.#read();
    saved[siteId] = { loggedInAt: new Date(this.now()).toISOString(), phoneLast4: p.phoneLast4 };
    this.#write(saved);
    return out;
  }

  /** Forget the sign-in note (the browser session itself stays in the profile). */
  forget(siteId) {
    const saved = this.#read();
    delete saved[siteId];
    this.#write(saved);
  }
}
