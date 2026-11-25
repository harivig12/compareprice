/**
 * Optional site sign-ins for the UI popup: mobile number -> OTP (Milkbasket,
 * Zepto), or number/email -> password -> maybe a code (Amazon).
 *
 * The session lives in the headless Chrome profile (<data>/chrome-profile),
 * exactly like a phone app keeps you signed in: nothing is stored here but a
 * small "who signed in where, when" note (sessions.json) for the UI. Only a
 * masked hint of the number or email is kept. Passwords and OTPs are typed
 * into the site's page and never stored or logged.
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
import { SiteError } from './errors.js';
import { openAccounts, MAIN, MAX_ACCOUNTS } from './accounts.js';
import { PoolSet } from './poolset.js';
import { cdpClick, typeText } from './sites/_util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Max OTP requests per site per hour: stops SMS spam and account lockouts. */
export const MAX_OTP_REQUESTS_PER_HOUR = 3;
/** Minimum gap between two OTP requests for one site ("Resend in 27s"). */
export const RESEND_GAP_MS = 30_000;
/** Wrong passwords allowed in one sign-in before stopping (Amazon locks accounts). */
export const MAX_PASSWORD_TRIES = 3;

/**
 * Is the page showing an OTP entry screen? Sites differ a lot: Milkbasket
 * renders 4 `tel` boxes where the FIRST has maxlength=4 and the rest 1
 * (2026-11-19 — a "4 × maxlength=1" check missed it), others use one box
 * with autocomplete=one-time-code. Any of these counts:
 *   - the page says it sent an OTP / asks to verify the number
 *   - an input with autocomplete=one-time-code, or otp/code in its name
 *   - 4+ visible short (maxlength <= 6) tel/number/text inputs
 */
export const OTP_SCREEN_JS = `(() => {
  const vis = [...document.querySelectorAll('input')].filter((i) => i.getClientRects().length && i.type !== 'hidden');
  const text = (document.body && document.body.innerText) || '';
  if (/(sent|send) (an |the )?otp|verify your (mobile |phone )?number|enter (the )?otp|one.?time (password|code)/i.test(text) && vis.length) return true;
  if (vis.some((i) => i.autocomplete === 'one-time-code' || /otp|verification.?code/i.test((i.name || '') + (i.id || '') + (i.placeholder || '')))) return true;
  const short = vis.filter((i) => /^(tel|number|text)$/.test(i.type) && i.maxLength > 0 && i.maxLength <= 6);
  if (short.length >= 4) return true;
  // BigBasket (2026-11-25): six bare type=number boxes (no maxlength, name or
  // placeholder), 40 px wide, under a page that says "Enter OTP".
  const small = vis.filter((i) => /^(tel|number|text)$/.test(i.type) && i.getBoundingClientRect().width <= 64);
  return /otp/i.test(text) && small.length >= 4 && small.length <= 8;
})()`;

/** The OTP boxes on screen, in page order (one box, or one per digit). */
export const OTP_BOXES_JS = `(() => {
  const vis = [...document.querySelectorAll('input')].filter((i) => i.getClientRects().length && i.type !== 'hidden');
  const named = vis.filter((i) => i.autocomplete === 'one-time-code' || /otp|code/i.test((i.name || '') + (i.id || '') + (i.placeholder || '')) || (/^(tel|number|text)$/.test(i.type) && i.maxLength > 0 && i.maxLength <= 6));
  if (named.length) return named;
  // A row of 4 to 8 small bare boxes (BigBasket, 2026-11-25: six type=number, 40 px, no maxlength).
  const small = vis.filter((i) => /^(tel|number|text)$/.test(i.type) && i.getBoundingClientRect().width <= 64);
  return small.length >= 4 && small.length <= 8 ? small : [];
})()`;

export const LOGIN_SITES = Object.freeze({
  milkbasket: {
    label: 'Milkbasket',
    why: 'Guests are fixed to its default city; searching needs an account with your society. Extra accounts are checked for deals only.',
    url: 'https://www.milkbasket.com/login',
    // Extra accounts get their own browser profile; they only look for deals.
    multiAccount: true,
    signOutOrigins: ['https://www.milkbasket.com', 'https://milkbasket.com', 'https://consumerbff.milkbasket.com'],
    // Signed in = a session token and a society (hub other than the default 1).
    sessionCheck: `(() => { const h = Number(JSON.parse(localStorage.getItem('MB_PERSIST_USER_HUB') || '0')); return !!localStorage.getItem('MB_AUTH_TOKEN') && h > 1; })()`,
    incompleteHint: 'A new number must finish sign-up (pick your society) in the Milkbasket app first, then sign in here again.',
    phoneInput: `[...document.querySelectorAll('input')].find((i) => i.getClientRects().length && /mobile|phone/i.test(i.placeholder || i.name || i.type))`,
    submitPhone: `[...document.querySelectorAll('button')].find((b) => b.getClientRects().length && !b.disabled && /get otp|send otp|continue|proceed/i.test(b.textContent))`,
    otpInput: OTP_SCREEN_JS,
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
    otpInput: OTP_SCREEN_JS,
    submitOtp: `[...document.querySelectorAll('button')].find((b) => b.getClientRects().length && !b.disabled && /verify|continue|submit|login/i.test(b.textContent))`,
    wrongOtp: /invalid otp|incorrect otp|wrong otp|otp (is )?(invalid|incorrect|expired)/i,
  },
  instamart: {
    label: 'Instamart',
    why: 'Optional. Signed in, Instamart shows your account\'s prices and offers; without it, searches run as a guest.',
    // Same tab and session as Instamart searches (swiggy.com).
    url: 'https://www.swiggy.com/instamart',
    // Extra accounts get their own browser profile; each is searched (prices can differ per account).
    multiAccount: true,
    // swiggy.com -> "Sign in" -> "Login" -> mobile number -> OTP (2026-11-19, from the user).
    open: [
      `[...document.querySelectorAll('button,a,div,span')].filter((e) => e.getClientRects().length && /^sign ?in$/i.test((e.innerText || '').trim())).sort((a, b) => a.children.length - b.children.length)[0]`,
      `[...document.querySelectorAll('button,a,div,span')].filter((e) => e.getClientRects().length && /^log ?in$/i.test((e.innerText || '').trim())).sort((a, b) => a.children.length - b.children.length)[0]`,
    ],
    phoneInput: `[...document.querySelectorAll('input')].find((i) => i.getClientRects().length && (i.type === 'tel' || /mobile|phone/i.test((i.name || '') + (i.id || '') + (i.placeholder || ''))))`,
    submitPhone: `[...document.querySelectorAll('button,a,div[role=button]')].find((b) => b.getClientRects().length && !b.disabled && /^(login|continue|get otp|send otp|proceed)$/i.test((b.innerText || '').trim()))`,
    otpInput: OTP_SCREEN_JS,
    submitOtp: `[...document.querySelectorAll('button,a,div[role=button]')].find((b) => b.getClientRects().length && !b.disabled && /verify|submit|continue|login/i.test((b.innerText || '').trim()))`,
    wrongOtp: /invalid otp|incorrect otp|wrong otp|otp (is )?(invalid|incorrect|expired)|enter a valid otp/i,
  },
  bigbasket: {
    label: 'BigBasket',
    why: 'Optional. Without it, BigBasket is searched as a guest (as before).',
    url: 'https://www.bigbasket.com/',
    // bigbasket.com -> "Login/ Sign Up" -> #multiform ("Enter Phone number/ Email Id") -> Continue -> OTP
    // (checked 2026-11-19 on the service's profile; nothing was typed).
    open: `[...document.querySelectorAll('button,a,div,span')].filter((e) => e.getClientRects().length && /^login\\s*\\/\\s*sign ?up$/i.test((e.innerText || '').trim())).sort((a, b) => a.children.length - b.children.length)[0]`,
    phoneInput: `document.querySelector('#multiform, input[placeholder*="Phone number" i]')`,
    submitPhone: `[...document.querySelectorAll('button')].find((b) => b.getClientRects().length && !b.disabled && /^(continue|get otp|send otp)$/i.test((b.innerText || '').trim()))`,
    otpInput: OTP_SCREEN_JS,
    submitOtp: `[...document.querySelectorAll('button')].find((b) => b.getClientRects().length && !b.disabled && /verify|continue|login|submit/i.test((b.innerText || '').trim()))`,
    wrongOtp: /invalid otp|incorrect otp|wrong otp|otp (is )?(invalid|incorrect|expired)|enter a valid otp/i,
    // Akamai's wall: stop at once, never retry (repeat visits prolong the block).
    botWall: /access denied|reference #\d|you don't have permission to access/i,
  },
  amazon: {
    label: 'Amazon',
    why: 'Amazon Now does not deliver to the configured address as a guest; signing in uses your saved address (it may still not deliver).',
    url: 'https://www.amazon.in/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.in%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=inflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0',
    phoneInput: `document.querySelector('#ap_email_login, #ap_email, input[name=email]')`,
    submitPhone: `document.querySelector('#continue, input#continue, #continue-announce')`,
    // Amazon signs in with the account's mobile number OR email, then a
    // password (checked 2026-11-19: amazon.in/now -> Sign in -> number -> password,
    // no OTP option). After the password it may still ask for a code
    // (two-step verification), a puzzle, or approval on the phone.
    acceptsEmail: true,
    secret: 'password',
    otpInput: `(!!document.querySelector('#auth-mfa-otpcode, input[name=otpCode], input[name=code], #cvf-input-code, input[autocomplete=one-time-code]') || ${OTP_SCREEN_JS})`,
    // "Create account" for a number that has no Amazon account.
    noAccount: /create (your |an )?(amazon )?account|looks like you('| a)re new|no account found/i,
    passwordInput: `!!document.querySelector('#ap_password')`,
    passwordBox: `document.querySelector('#ap_password')`,
    // Ticked so the session lasts (Amazon: "Keep me signed in").
    rememberMe: `document.querySelector('input[name=rememberMe]:not(:checked)')`,
    submitPassword: `document.querySelector('#signInSubmit, #auth-signin-button input, input[type=submit]#signInSubmit')`,
    wrongPassword: /your password is incorrect|password is incorrect|incorrect password|invalid password/i,
    // A puzzle can't be solved here; the user signs in once in a normal browser instead.
    captcha: `!!document.querySelector('#auth-captcha-guess, #captchacharacters, iframe[src*=arkose], #cvf-aamation-challenge-iframe, [id*=captcha i] img')`,
    approve: /approve the notification|we('ve| have) sent a notification|check your (phone|device|app)|approve (this|the) sign.?in/i,
    otpLink: `[...document.querySelectorAll('a,button,span.a-button-text,input[type=submit]')].find((e) => e.getClientRects().length && /otp|one.?time/i.test(e.textContent || e.value || ''))`,
    submitOtp: `document.querySelector('#auth-signin-button, #cvf-submit-otp-button input, input[type=submit]:not(#continue), #a-autoid-0 input')`,
    wrongOtp: /incorrect otp|invalid otp|wrong otp|enter a valid|incorrect code/i,
    // Still on a sign-in page (/ap/ or /ax/): not signed in yet.
    authUrl: /amazon\.[a-z.]+\/(ap|ax)\//,
  },
});

export const tenDigits = (phone) => String(phone ?? '').replace(/\D/g, '').slice(-10);

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i;

/** "abc.def@gmail.com" -> "a•••@gmail.com", for logs and the popup. */
export const maskEmail = (email) => {
  const [user, domain] = String(email).split('@');
  return `${user.slice(0, 1)}•••@${domain}`;
};

/**
 * What the user typed in the number box: a 10-digit mobile, or (for sites that
 * allow it) an email. Throws a SiteError before any page is touched.
 * @returns {{ value: string, hint: string, last4: string|null }}
 */
export function signInId(siteId, raw) {
  const cfg = LOGIN_SITES[siteId];
  const s = String(raw ?? '').trim();
  if (cfg?.acceptsEmail && s.includes('@')) {
    if (!EMAIL_RE.test(s)) throw new SiteError('parse', `${siteId}: that email doesn't look right`, { site: siteId });
    return { value: s, hint: maskEmail(s), last4: null };
  }
  const number = tenDigits(s);
  if (number.length !== 10) {
    throw new SiteError('parse', `${siteId}: enter a 10-digit mobile number${cfg?.acceptsEmail ? ' or the account email' : ''}`, { site: siteId });
  }
  return { value: number, hint: `••••••${number.slice(-4)}`, last4: number.slice(-4) };
}

/**
 * A snippet of the page for an error message. Sign-in pages often echo the
 * number ("OTP sent to +91 98…"), and these messages reach the log and the
 * UI, so any run of 6+ digits (spaces/dashes allowed) keeps only its last 4.
 */
export function pageSnippet(text, max) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\+?\d[\d -]{4,}\d/g, (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length < 6 ? m : `••••••${digits.slice(-4)}`;
    })
    .slice(0, max);
}

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
    evaluate: (js) => tab.evaluate(js, { timeoutMs: 8000 }),
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
  const { value: number, hint } = signInId(siteId, phone);

  await driver.goto(cfg.url);
  // Some sites need a click or two before the number box shows (Zepto: "Login";
  // Swiggy: "Sign in", then "Login"). Each step is tried only while the box is missing.
  const walled = async () => {
    if (cfg.botWall && cfg.botWall.test(await driver.text())) {
      throw new SiteError('blocked', `${siteId}: ${cfg.label} is showing its bot-protection page; sign-in stopped (searches stay guest). Try again in a few hours`, { site: siteId, code: 'bot_wall' });
    }
  };
  await walled();
  for (const step of [cfg.open ?? []].flat()) {
    if (await waitFor(driver, cfg.phoneInput, 4)) break;
    await driver.click(step, 10000);
  }
  await walled();
  if (!(await waitFor(driver, cfg.phoneInput, 30))) {
    const t = pageSnippet(await driver.text(), 120);
    throw new SiteError('parse', `${siteId}: the sign-in page has no mobile-number box (page says: "${t}")`, { site: siteId });
  }
  if ((await driver.click(cfg.phoneInput)) == null) throw new SiteError('parse', `${siteId}: could not focus the mobile-number box`, { site: siteId });
  await driver.type(number);
  await driver.sleep(400);
  if ((await driver.click(cfg.submitPhone)) == null) throw new SiteError('parse', `${siteId}: no "Get OTP" / "Continue" button after entering the number`, { site: siteId });

  // Wait for the OTP boxes; Amazon asks for a password instead.
  for (let i = 0; i < 30; i++) {
    // The password page comes first on Amazon; check it before the OTP heuristics.
    if (cfg.secret === 'password' && (await driver.has(cfg.passwordInput))) {
      return { step: 'password', message: `Enter the ${cfg.label} password for ${hint}.` };
    }
    if (await driver.has(cfg.otpInput)) return { step: 'otp', message: `OTP sent to ${hint}. Enter it below.` };
    if (cfg.noAccount && cfg.noAccount.test(await driver.text())) {
      throw new SiteError('session', `${siteId}: there is no ${cfg.label} account for ${hint}`, { site: siteId });
    }
    if (cfg.captcha && (await driver.has(cfg.captcha))) throw captchaError(siteId, cfg);
    // Password sites (Amazon) are answered by the first check on the next turn;
    // this OTP-link fallback is for OTP-only sites that show a password box.
    // (Live 2026-11-19: the page changed between the two checks of one turn and
    // this branch wrongly reported "no OTP sign-in".)
    if (cfg.secret !== 'password' && cfg.passwordInput && (await driver.has(cfg.passwordInput))) {
      if (cfg.otpLink && (await driver.click(cfg.otpLink, 3000)) != null) {
        for (let j = 0; j < 20; j++) {
          if (await driver.has(cfg.otpInput)) return { step: 'otp', message: `OTP sent to ${hint}. Enter it below.` };
          await driver.sleep(500);
        }
      }
      throw new SiteError('session', `${siteId}: this account asks for a password and offers no OTP sign-in; sign in with OTP isn't possible here`, { site: siteId });
    }
    await driver.sleep(500);
  }
  const t = pageSnippet(await driver.text(), 160);
  throw new SiteError('timeout', `${siteId}: no OTP box appeared after asking for the OTP (page says: "${t}")`, { site: siteId });
}

const captchaError = (siteId, cfg) =>
  new SiteError('blocked', `${siteId}: ${cfg.label} is showing a puzzle (CAPTCHA), which can't be solved here. Sign in once at ${cfg.label.toLowerCase()}.in in a normal browser, then try again later`, { site: siteId, code: 'captcha' });

/**
 * Type the password on the site's own page and see what it does next.
 * The password goes into the page and nowhere else: it isn't logged, saved,
 * or put in any error message.
 * @returns {Promise<{ loggedIn: true } | { step: 'otp', message: string } | { step: 'approve', message: string }>}
 */
export async function submitPassword(driver, siteId, password) {
  const cfg = LOGIN_SITES[siteId];
  if (cfg?.secret !== 'password') throw new SiteError('not_found', `${siteId}: signs in with an OTP, not a password`, { site: siteId });
  const pw = String(password ?? '');
  if (!pw || pw.length > 128) throw new SiteError('parse', `${siteId}: enter the account password`, { site: siteId, code: 'bad_password' });
  if (!(await driver.has(cfg.passwordInput))) throw new SiteError('session', `${siteId}: the password page isn't showing any more; start again`, { site: siteId });

  if ((await driver.click(cfg.passwordBox)) == null) throw new SiteError('parse', `${siteId}: could not focus the password box`, { site: siteId });
  await driver.type(pw);
  await driver.sleep(300);
  if (cfg.rememberMe) await driver.click(cfg.rememberMe, 1000);
  if ((await driver.click(cfg.submitPassword, 4000)) == null) throw new SiteError('parse', `${siteId}: no "Sign in" button on the password page`, { site: siteId });

  for (let i = 0; i < 40; i++) {
    await driver.sleep(500);
    const text = await driver.text();
    if (cfg.wrongPassword.test(text)) throw new SiteError('session', `${siteId}: ${cfg.label} says the password is incorrect`, { site: siteId, code: 'wrong_password' });
    if (await driver.has(cfg.captcha)) throw captchaError(siteId, cfg);
    // Two-step verification: a code by SMS, email or an authenticator app.
    if (await driver.has(cfg.otpInput)) return { step: 'otp', message: `${cfg.label} asks for a verification code (sent to your phone or email, or from your authenticator app). Enter it below.` };
    if (cfg.approve.test(text)) return { step: 'approve', message: `${cfg.label} sent a sign-in request to your phone. Approve it there, then press Check.` };
    if (!(await driver.has(cfg.passwordInput)) && !cfg.authUrl.test(await driver.url())) return { loggedIn: true };
  }
  throw new SiteError('timeout', `${siteId}: still on the sign-in page 20 s after the password (page says: "${pageSnippet(await driver.text(), 160)}")`, { site: siteId });
}

/** After "approve on your phone": signed in once the site leaves its sign-in pages. */
export async function checkApproved(driver, siteId) {
  const cfg = LOGIN_SITES[siteId];
  for (let i = 0; i < 10; i++) {
    if (!cfg.authUrl.test(await driver.url()) && !(await driver.has(cfg.passwordInput))) return { loggedIn: true };
    await driver.sleep(500);
  }
  throw new SiteError('session', `${siteId}: not approved yet. Approve the request in the ${cfg.label} app, then press Check again`, { site: siteId, code: 'not_approved' });
}

/** Type the OTP and confirm the sign-in took. */
export async function verifyLogin(driver, siteId, otp) {
  const cfg = LOGIN_SITES[siteId];
  if (!cfg) throw new SiteError('not_found', `${siteId}: no sign-in flow`, { site: siteId });
  const code = String(otp ?? '').replace(/\s+/g, '');
  if (!/^\d{4,8}$/.test(code)) throw new SiteError('parse', `${siteId}: the OTP is 4 to 8 digits`, { site: siteId, code: 'bad_otp' });
  if (!(await driver.has(cfg.otpInput))) throw new SiteError('session', `${siteId}: no OTP request is pending; ask for an OTP first`, { site: siteId });

  const focus = await driver.click(`${OTP_BOXES_JS}[0]`, 4000);
  if (focus == null) throw new SiteError('parse', `${siteId}: could not focus the OTP box`, { site: siteId });
  // Real key presses: split boxes auto-advance on input.
  await driver.typeKeys(code);
  if (driver.evaluate) {
    // If the boxes didn't advance, fill them directly: the whole code into a
    // single box, or one digit per box (React needs the native setter + input event).
    await driver.sleep(300);
    const filled = await driver.evaluate(`${OTP_BOXES_JS}.map((i) => i.value).join('')`).catch(() => '');
    if (String(filled).replace(/\D/g, '') !== code) {
      await driver.evaluate(`(() => {
        const boxes = ${OTP_BOXES_JS};
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        const code = ${JSON.stringify(code)};
        // One box: the whole code. As many boxes as digits: one each (even if
        // the first box allows more, as on Milkbasket). Otherwise fill in order.
        const parts = [];
        if (boxes.length === 1) parts.push(code);
        else if (boxes.length >= code.length) for (const ch of code) parts.push(ch);
        else { let k = 0; for (const b of boxes) { const n = Math.max(1, b.maxLength); parts.push(code.slice(k, k + n)); k += n; } }
        boxes.forEach((b, i) => { set.call(b, parts[i] || ''); b.dispatchEvent(new Event('input', { bubbles: true })); b.dispatchEvent(new Event('change', { bubbles: true })); });
      })()`).catch(() => {});
    }
  }
  await driver.sleep(500);
  await driver.click(cfg.submitOtp, 2500); // many sites submit on the last digit; a missing button is fine

  for (let i = 0; i < 30; i++) {
    await driver.sleep(500);
    const text = await driver.text();
    if (cfg.wrongOtp.test(text)) throw new SiteError('session', `${siteId}: the site rejected that OTP (wrong or expired). Ask for a new one`, { site: siteId, code: 'wrong_otp' });
    if (!(await driver.has(cfg.otpInput))) {
      // "OTP box gone" isn't proof: a new number can land on a sign-up step with
      // no session (Milkbasket "da", 2026-11-19). Sites that can tell, say so.
      if (cfg.sessionCheck) {
        let ok = false;
        for (let j = 0; j < 10 && !ok; j++) {
          ok = Boolean(await driver.has(cfg.sessionCheck));
          if (!ok) await driver.sleep(500);
        }
        if (!ok) throw new SiteError('session', `${siteId}: the OTP was accepted, but ${cfg.label} has no session for this number yet. ${cfg.incompleteHint ?? 'Finish signing up on the site, then sign in again.'}`, { site: siteId, code: 'incomplete_signup' });
      }
      return { loggedIn: true };
    }
  }
  throw new SiteError('timeout', `${siteId}: the OTP box is still showing 15 s after entering the code`, { site: siteId });
}

/**
 * The LoginManager the service uses: drives the engine's Chrome, the main
 * account in the shared profile and each extra account in its own (PoolSet).
 * `inUse()` says whether a job may be searching right now, so finishing a
 * sign-in never closes a tab under a running search.
 */
export function defaultLoginManager({ file, legacyFile, log, getLocation, inUse = () => false, onActivity, poolSet, accounts, onSignedOut = () => {} }) {
  const pools = poolSet ?? new PoolSet({ getLocation });
  return new LoginManager({
    file,
    legacyFile,
    accounts,
    log,
    onActivity,
    getDriver: async (siteId, acc) => tabDriver(await (await pools.forAccount(siteId, acc)).loginTab(siteId)),
    release: async (siteId, acc) => pools.releaseLogin(siteId, acc, { inUse: inUse(siteId) }),
    isBusy: (siteId, acc) => pools.busy(acc) || (acc.id === MAIN && inUse(siteId)),
    clearSession: async (siteId, acc) => {
      if (acc.id !== MAIN) await pools.removeProfile(acc);
      else {
        const cfg = LOGIN_SITES[siteId];
        await pools.getMain().clearSiteData(siteId, cfg.signOutOrigins ?? [new URL(cfg.url).origin]);
      }
      // Its deals belong to a session that is gone.
      await onSignedOut(siteId, acc.id);
    },
  });
}

const PENDING = ['sending', 'otp_sent', 'password_needed', 'approve_needed', 'verifying'];

/**
 * Sign-in state per site and account, for the popup to poll:
 *   idle -> sending -> otp_sent | password_needed -> verifying -> signed_in
 *                 \-> error           \-> otp_sent (wrong OTP) / error
 * `start()` returns at once and drives the site's page in the background, so
 * the popup can show the OTP box immediately instead of waiting 15–30 s on
 * one HTTP request. Logs every step with the number masked.
 */
export class LoginManager {
  /**
   * @param {{ getDriver: (siteId: string, account: object) => Promise<object>, file: string, legacyFile?: string,
   *           accounts?: ReturnType<typeof openAccounts>, now?: () => number, log?: (msg: string) => void,
   *           release?: (siteId: string, account: object) => unknown, onActivity?: () => void }} opts
   */
  constructor({ getDriver, file, legacyFile, accounts, now = () => Date.now(), log = () => {}, release = () => {}, onActivity = () => {}, clearSession = async () => {}, isBusy = () => false }) {
    this.getDriver = getDriver;
    // Sign-out side effects (browser data / profile directory) and "is that browser busy?".
    this.clearSession = clearSession;
    this.isBusy = isBusy;
    // Called when a site's sign-in is finished (signed in or failed), so its
    // page can be closed instead of idling in the browser.
    this.release = release;
    this.onActivity = onActivity;
    this.accounts = accounts ?? openAccounts(file, { legacyFile, multiAccount: (s) => Boolean(LOGIN_SITES[s]?.multiAccount) });
    this.now = now;
    this.log = log;
    this.requests = new Map(); // site:account -> number[] (start times)
    this.states = new Map(); // site:account -> { state, message, error, phoneLast4, hint, at }
    this.work = new Map(); // site:account -> Promise of the background step
  }

  #set(key, patch) {
    this.onActivity();
    const next = { ...(this.states.get(key) ?? { state: 'idle' }), ...patch, at: this.now() };
    this.states.set(key, next);
    return next;
  }

  #account(siteId, accountId) {
    const acc = this.accounts.get(siteId, accountId);
    if (!acc) throw new SiteError('not_found', `${siteId}: no account "${accountId}"`, { site: siteId });
    return acc;
  }

  /** Milliseconds until another OTP may be requested for this account (0 = now). */
  resendWaitMs(siteId, account = MAIN) {
    const last = (this.requests.get(`${siteId}:${account}`) ?? []).at(-1);
    return last == null ? 0 : Math.max(0, last + RESEND_GAP_MS - this.now());
  }

  /** One account's row for the popup. */
  #row(siteId, cfg, acc) {
    const key = `${siteId}:${acc.id}`;
    const st = this.states.get(key) ?? { state: acc.loggedInAt ? 'signed_in' : 'idle' };
    return {
      id: acc.id,
      name: acc.name,
      hint: acc.hint ?? st.hint ?? null,
      loggedIn: Boolean(acc.loggedInAt),
      since: acc.loggedInAt ?? null,
      // What the second step asks for, so the popup shows the right box.
      secret: st.state === 'password_needed' ? 'password' : st.state === 'approve_needed' ? 'approve' : 'otp',
      state: st.state,
      message: st.message ?? null,
      error: st.error ?? null,
      pending: PENDING.includes(st.state),
      resendInMs: this.resendWaitMs(siteId, acc.id),
    };
  }

  /**
   * What the popup shows: one row per site. The top-level fields describe the
   * main account (as before accounts existed); `accounts` lists all of them.
   */
  status() {
    return Object.entries(LOGIN_SITES).map(([id, cfg]) => {
      const rows = this.accounts.list(id).map((acc) => this.#row(id, cfg, acc));
      const main = rows.find((r) => r.id === MAIN);
      return {
        id,
        label: cfg.label,
        why: cfg.why,
        acceptsEmail: Boolean(cfg.acceptsEmail),
        method: cfg.secret ?? 'otp',
        multiAccount: Boolean(cfg.multiAccount),
        canAdd: Boolean(cfg.multiAccount) && rows.length < MAX_ACCOUNTS,
        loggedIn: main.loggedIn,
        since: main.since,
        phoneHint: main.hint,
        secret: main.secret,
        state: main.state,
        message: main.message,
        error: main.error,
        pending: rows.some((r) => r.pending),
        resendInMs: main.resendInMs,
        accounts: rows,
      };
    });
  }

  /** Resolves when the account's background step finishes (tests, CLI). */
  whenSettled(siteId, account = MAIN) {
    return this.work.get(`${siteId}:${account}`) ?? Promise.resolve();
  }

  /**
   * Check the input and the limits now (errors are thrown immediately), then
   * open the site's sign-in in the background.
   * @param {{ account?: string, name?: string }} [opts]  `name` adds a new account first
   * @returns {{ state: 'sending', message: string, account: string }}
   */
  start(siteId, phone, { account = MAIN, name } = {}) {
    const cfg = LOGIN_SITES[siteId];
    if (!cfg) throw new SiteError('not_found', `${siteId}: no sign-in flow`, { site: siteId });
    const id = signInId(siteId, phone);
    // The same number on two accounts would be one session twice.
    const twin = this.accounts.list(siteId).find((a) => a.hint === id.hint && a.id !== account && a.loggedInAt);
    if (twin) throw new SiteError('session', `${siteId}: ${id.hint} is already the "${twin.name}" account`, { site: siteId, code: 'same_account' });
    const acc = name != null ? this.accounts.add(siteId, { name }) : this.#account(siteId, account);
    const key = `${siteId}:${acc.id}`;
    // One profile holds one session per site: a different number can't sign in
    // on top of it (the site shows no sign-in box). Say so instead of failing later.
    if (acc.loggedInAt && acc.hint && acc.hint !== id.hint) {
      const how = cfg.multiAccount ? 'Use "+ Add account" for another number' : 'Sign out first to use another account';
      throw new SiteError('session', `${siteId}: "${acc.name}" is already signed in as ${acc.hint}. ${how}`, { site: siteId, code: 'other_account' });
    }
    const cur = this.states.get(key)?.state;
    if (cur === 'sending' || cur === 'verifying') throw new SiteError('session', `${siteId}: still working on the last step, wait a moment`, { site: siteId });
    const gap = this.resendWaitMs(siteId, acc.id);
    if (gap > 0) throw new SiteError('blocked', `${siteId}: wait ${Math.ceil(gap / 1000)}s before asking for another OTP`, { site: siteId });
    const t = this.now();
    const recent = (this.requests.get(key) ?? []).filter((x) => t - x < 3_600_000);
    if (recent.length >= MAX_OTP_REQUESTS_PER_HOUR) {
      const waitMin = Math.ceil((recent[0] + 3_600_000 - t) / 60_000);
      throw new SiteError('blocked', `${siteId}: ${MAX_OTP_REQUESTS_PER_HOUR} OTP requests in the last hour is the limit here (to avoid locking the account). Try again in ${waitMin} min`, { site: siteId });
    }
    this.requests.set(key, [...recent, t]);
    const asking = cfg.secret === 'password' ? `Opening ${cfg.label} sign-in for ${id.hint}…` : `Asking ${cfg.label} to send an OTP to ${id.hint}…`;
    this.#set(key, { state: 'sending', message: asking, error: null, phoneLast4: id.last4, hint: id.hint, pwTries: 0 });
    const who = acc.id === MAIN ? '' : ` (account "${acc.name}")`;
    this.log(`login ${siteId}${who}: starting sign-in for ${id.hint}`);
    const job = (async () => {
      try {
        const driver = await this.getDriver(siteId, acc);
        const out = await startLogin(driver, siteId, id.value);
        const state = out.step === 'password' ? 'password_needed' : 'otp_sent';
        this.#set(key, { state, message: out.message, error: null });
        this.log(`login ${siteId}${who}: ${state === 'password_needed' ? 'password page shown' : 'OTP screen shown'}`);
      } catch (e) {
        this.#set(key, { state: 'error', message: null, error: e.message });
        this.log(`login ${siteId}${who}: failed — ${e.message}`);
        Promise.resolve(this.release(siteId, acc)).catch(() => {});
      }
    })();
    this.work.set(key, job);
    return { state: 'sending', message: this.states.get(key).message, account: acc.id };
  }

  /**
   * The second step: the OTP, the password (sites with `secret: 'password'`),
   * or "check" after the user approved the sign-in on their phone. `secret` is
   * only passed to the page; it is never stored or logged.
   */
  async verify(siteId, secret, { account = MAIN } = {}) {
    const acc = this.#account(siteId, account);
    const key = `${siteId}:${acc.id}`;
    const st = this.states.get(key);
    if (st?.state === 'password_needed') return this.#password(siteId, acc, st, secret);
    if (st?.state === 'approve_needed') return this.#approved(siteId, acc, st);
    if (!st || st.state === 'idle' || st.state === 'signed_in') throw new SiteError('session', `${siteId}: ask for an OTP first`, { site: siteId });
    if (st.state === 'sending') throw new SiteError('session', `${siteId}: the OTP request is still on its way, wait a moment`, { site: siteId });
    if (st.state === 'error') throw new SiteError('session', `${siteId}: the OTP request failed (${st.error}); resend it`, { site: siteId });
    this.#set(key, { state: 'verifying', message: 'Checking the OTP…', error: null });
    this.log(`login ${siteId}${acc.id === MAIN ? '' : ` (account "${acc.name}")`}: verifying OTP`);
    try {
      const driver = await this.getDriver(siteId, acc);
      const out = await verifyLogin(driver, siteId, secret);
      this.#signedIn(siteId, acc, st);
      return out;
    } catch (e) {
      // A wrong OTP keeps the OTP screen; anything else is an error to resend from.
      const wrong = e.code === 'wrong_otp' || e.code === 'bad_otp';
      this.#set(key, wrong ? { state: 'otp_sent', message: null, error: e.message } : { state: 'error', message: null, error: e.message });
      this.log(`login ${siteId}: verify failed — ${e.message}`);
      if (!wrong) Promise.resolve(this.release(siteId, acc)).catch(() => {});
      throw e;
    }
  }

  #signedIn(siteId, acc, st) {
    this.accounts.markSignedIn(siteId, acc.id, { hint: st.hint ?? null, at: new Date(this.now()).toISOString() });
    this.#set(`${siteId}:${acc.id}`, { state: 'signed_in', message: 'Signed in. The session is kept for future searches.', error: null });
    this.log(`login ${siteId}${acc.id === MAIN ? '' : ` (account "${acc.name}")`}: signed in (${st.hint ?? 'account'})`);
    Promise.resolve(this.release(siteId, acc)).catch(() => {});
  }

  /** Password step. A wrong password stays on this step, up to MAX_PASSWORD_TRIES. */
  async #password(siteId, acc, st, password) {
    const key = `${siteId}:${acc.id}`;
    this.#set(key, { state: 'verifying', message: 'Checking the password…', error: null });
    this.log(`login ${siteId}: submitting password`);
    try {
      const out = await submitPassword(await this.getDriver(siteId, acc), siteId, password);
      if (out.loggedIn) {
        this.#signedIn(siteId, acc, st);
        return { loggedIn: true };
      }
      // The site wants a second step: a code, or approval on the phone.
      const state = out.step === 'otp' ? 'otp_sent' : 'approve_needed';
      this.#set(key, { state, message: out.message, error: null });
      this.log(`login ${siteId}: password accepted; ${state === 'otp_sent' ? 'verification code asked' : 'waiting for approval on the phone'}`);
      return { step: out.step, message: out.message };
    } catch (e) {
      const tries = (st.pwTries ?? 0) + (e.code === 'wrong_password' ? 1 : 0);
      const retry = (e.code === 'wrong_password' && tries < MAX_PASSWORD_TRIES) || e.code === 'bad_password';
      const error = e.code === 'wrong_password' && !retry
        ? `${siteId}: ${MAX_PASSWORD_TRIES} wrong passwords. Stopped so the account isn't locked; check the password and start again later`
        : e.message;
      this.#set(key, retry ? { state: 'password_needed', message: null, error, pwTries: tries } : { state: 'error', message: null, error });
      this.log(`login ${siteId}: password step failed — ${error}`);
      if (!retry) Promise.resolve(this.release(siteId, acc)).catch(() => {});
      throw retry ? e : new SiteError(e.kind ?? 'session', error, { site: siteId, code: e.code });
    }
  }

  /** "Check" after approving on the phone. Not approved yet keeps waiting. */
  async #approved(siteId, acc, st) {
    try {
      const out = await checkApproved(await this.getDriver(siteId, acc), siteId);
      this.#signedIn(siteId, acc, st);
      return out;
    } catch (e) {
      this.#set(`${siteId}:${acc.id}`, { state: 'approve_needed', error: e.message });
      throw e;
    }
  }

  /**
   * Sign out: the main account clears only this site's data in the shared
   * profile; an extra account is removed with its whole profile directory.
   * Refused while that account's browser is in use.
   */
  async signOut(siteId, account = MAIN) {
    const acc = this.#account(siteId, account);
    const key = `${siteId}:${acc.id}`;
    if (PENDING.includes(this.states.get(key)?.state)) {
      throw new SiteError('session', `${siteId}: a sign-in is in progress for "${acc.name}"; finish or close it first`, { site: siteId, code: 'busy' });
    }
    if (this.isBusy(siteId, acc)) throw new SiteError('session', `${siteId}: busy, try again after the current run`, { site: siteId, code: 'busy' });
    await this.clearSession(siteId, acc);
    if (acc.id === MAIN) this.accounts.markSignedOut(siteId, acc.id);
    else this.accounts.remove(siteId, acc.id);
    this.states.delete(key);
    this.requests.delete(key);
    this.log(`login ${siteId}: ${acc.id === MAIN ? 'signed out' : `account "${acc.name}" removed`}`);
    return { signedOut: true, removed: acc.id !== MAIN, account: acc.id };
  }

  /** Mark an account signed out here (the caller clears its browser data). */
  forget(siteId, account = MAIN) {
    this.accounts.markSignedOut(siteId, account);
    this.states.delete(`${siteId}:${account}`);
  }
}
