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
