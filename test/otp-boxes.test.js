/**
 * The OTP screen / box finders run in the site's page. Here the real
 * expressions run against small fake pages (no browser), shaped like the
 * pages seen live.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { OTP_SCREEN_JS, OTP_BOXES_JS } from '../src/engine/login.js';

const input = (o = {}) => ({
  type: 'text', name: '', id: '', placeholder: '', maxLength: -1, autocomplete: '', width: 200,
  getClientRects() { return o.hidden ? [] : [{}]; },
  getBoundingClientRect() { return { width: this.width, height: 38 }; },
  ...o,
});

function page(inputs, text) {
  const document = { querySelectorAll: (sel) => (sel === 'input' ? inputs : []), body: { innerText: text } };
  return (js) => vm.runInNewContext(js, { document });
}

const search = () => input({ placeholder: 'Search for Products...' });
// BigBasket, 2026-11-25: six bare number boxes, 40 px wide, no maxlength, name or placeholder.
const bigbasket = () => [search(), search(), ...Array.from({ length: 6 }, () => input({ type: 'number', width: 40 }))];
const BB_TEXT = 'Verify Mobile Number\n+91 90000 00000\nEnter OTP\nVerify & Continue\nResend OTP';

test('BigBasket: six bare number boxes are an OTP screen, and are the boxes to fill', () => {
  const run = page(bigbasket(), BB_TEXT);
  assert.equal(run(OTP_SCREEN_JS), true);
  const boxes = run(`${OTP_BOXES_JS}.map((i) => i.type + ':' + i.getBoundingClientRect().width)`);
  assert.deepEqual([...boxes], Array(6).fill('number:40'));
});

test('a page of small boxes without any OTP wording is not an OTP screen', () => {
  const run = page(bigbasket(), 'Quantity 1 2 3 4 5 6');
  assert.equal(run(OTP_SCREEN_JS), false);
});

test('named or short-maxlength boxes still win (Milkbasket: first box maxlength 4, the rest 1)', () => {
  const boxes = [input({ type: 'tel', maxLength: 4, width: 48 }), ...Array.from({ length: 3 }, () => input({ type: 'tel', maxLength: 1, width: 48 })), search()];
  const run = page(boxes, 'Enter the code');
  assert.equal(run(OTP_SCREEN_JS), true);
  assert.equal(run(`${OTP_BOXES_JS}.length`), 4);
  const one = page([input({ autocomplete: 'one-time-code' }), search()], 'We sent an OTP');
  assert.equal(one(`${OTP_BOXES_JS}.length`), 1);
});

test('the number page and a lone search box are not OTP boxes', () => {
  const run = page([search(), input({ type: 'text', placeholder: 'Phone number', maxLength: 10 }), input({ type: 'number', width: 40 })], 'Login / Sign Up');
  assert.equal(run(`${OTP_BOXES_JS}.length`), 0, 'fewer than four small boxes: none');
  assert.equal(run(OTP_SCREEN_JS), false);
});

test('hidden inputs are ignored', () => {
  const boxes = Array.from({ length: 6 }, () => input({ type: 'number', width: 40, hidden: true }));
  const run = page(boxes, BB_TEXT);
  assert.equal(run(`${OTP_BOXES_JS}.length`), 0);
});

// ───────────────────────── the Verify button ─────────────────────────

import { BIGBASKET_VERIFY_JS, LOGIN_SITES } from '../src/engine/login.js';

const el = (innerText, o = {}) => ({
  innerText, disabled: false, aria: null, hidden: false,
  getClientRects() { return this.hidden ? [] : [{}]; },
  getAttribute(n) { return n === 'aria-disabled' ? this.aria : null; },
  ...o,
});

/** A page with `buttons` (button / role=button elements) and `others` (div, span, a), in page order. */
function buttonPage(buttons, others = []) {
  const document = { querySelectorAll: (sel) => (sel === 'button,[role=button]' ? buttons : sel === 'div,span,a' ? others : []) };
  return () => vm.runInNewContext(BIGBASKET_VERIFY_JS, { document });
}

test('BigBasket: the OTP is submitted with the dialog\'s Verify button, not the header\'s "Login/ Sign Up"', () => {
  const header = el('Login/ Sign Up');
  const verify = el('Verify & Continue');
  const resend = el('Resend OTP');
  assert.equal(buttonPage([header, el('Cart'), verify, resend])(), verify);
  assert.equal(LOGIN_SITES.bigbasket.submitOtp, BIGBASKET_VERIFY_JS);
});

test('BigBasket Verify: a disabled or hidden button is skipped; a non-button that says it is the fallback; nothing -> null', () => {
  const off = el('Verify & Continue', { disabled: true });
  const ariaOff = el('Verify & Continue', { aria: 'true' });
  const gone = el('Verify & Continue', { hidden: true });
  assert.equal(buttonPage([off, ariaOff, gone])(), null);
  const div = el('Verify & Continue');
  const wrapper = el('Verify & Continue Resend OTP');
  assert.equal(buttonPage([el('Login/ Sign Up')], [wrapper, div])(), div, 'the exact "Verify & Continue" element, not a wrapper around more text');
  assert.equal(buttonPage([el('Login/ Sign Up'), el('Resend OTP')])(), null);
});

// ───────────────────────── what the dialog says ─────────────────────────

import { DIALOG_TEXT_JS } from '../src/engine/login.js';

test('the dialog reader returns the login dialog and any toast, not the page\'s menus', () => {
  const box = (innerText, o = {}) => ({ innerText, src: '', getClientRects() { return o.hidden ? [] : [{}]; }, getBoundingClientRect() { return { height: o.h ?? 300 }; } });
  const menu = box('Shop by Category Electronics Fashion Pharmacy & Wellness Fruits & Vegetables');
  const dialog = box('Login/ Sign up\nEnter Phone number/ Email Id\nContinue');
  const toast = box('Too many attempts. Please try after some time');
  const document = {
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === 'div' ? [menu, dialog] : sel === 'iframe' ? [] : /role=alert/.test(sel) ? [toast] : []),
  };
  const said = vm.runInNewContext(DIALOG_TEXT_JS, { document });
  assert.match(said, /Enter Phone number/);
  assert.match(said, /Too many attempts/);
  assert.doesNotMatch(said, /Shop by Category/);
  const captcha = { ...document, querySelectorAll: (sel) => (sel === 'iframe' ? [{ ...box(''), src: 'https://www.google.com/recaptcha/api2/bframe' }] : []) };
  assert.match(vm.runInNewContext(DIALOG_TEXT_JS, { document: captcha }), /reCAPTCHA puzzle/);
});
