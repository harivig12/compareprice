import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMethod, methodFits, cleanRule, savingFor, bestOffer, fitsMethods, cleanMethods, offerKey } from '../src/payments.js';
import { parseRulesReply, buildRulesRequest, offerText } from '../src/ai/offer-rules.js';

const hdfc = describeMethod('HDFC Credit Card');
const bhim = describeMethod('BHIM UPI');
const gpay = describeMethod('UPI (GPay)');

test('describeMethod splits issuer and instrument', () => {
  assert.deepEqual([hdfc.issuer, hdfc.instrument], ['hdfc', 'credit']);
  assert.deepEqual([bhim.issuer, bhim.instrument], ['bhim', 'upi']);
  assert.deepEqual([gpay.issuer, gpay.instrument], ['gpay', 'upi']);
});

test('methodFits: instrument must agree, a named issuer must be mine', () => {
  assert.equal(methodFits(hdfc, { issuer: 'hdfc', instrument: 'credit' }), true);
  assert.equal(methodFits(hdfc, { issuer: 'hdfc', instrument: 'debit' }), false);
  assert.equal(methodFits(hdfc, { issuer: 'icici', instrument: 'credit' }), false);
  assert.equal(methodFits(hdfc, { issuer: null, instrument: 'credit' }), true);
  assert.equal(methodFits(bhim, { issuer: 'bhim', instrument: 'upi' }), true);
  assert.equal(methodFits(gpay, { issuer: 'bhim', instrument: 'upi' }), false);
  assert.equal(methodFits(gpay, { issuer: null, instrument: 'upi' }), true);
});

test('cleanRule keeps only usable rules', () => {
  assert.equal(cleanRule({ kind: null, value: 5 }), null);
  assert.equal(cleanRule({ kind: 'percent', value: 150 }), null);
  assert.equal(cleanRule({ kind: 'flat', value: 0 }), null);
  const r = cleanRule({ kind: 'percent', value: 10, cap: 75, minOrder: 999, methods: [{ issuer: 'HDFC', instrument: 'credit' }, { issuer: 'x', instrument: 'bogus' }], conditions: ['first order'] });
  assert.equal(r.methods[0].issuer, 'hdfc');
  assert.equal(r.methods[1].instrument, 'any');
  assert.deepEqual([r.cap, r.minOrder], [75, 999]);
  assert.deepEqual(cleanRule({ kind: 'flat', value: 50 }).methods, [{ issuer: null, instrument: 'any' }]);
});

test('savingFor: percent with cap, flat, minimum, never above the total', () => {
  const pct = { kind: 'percent', value: 10, cap: 75, minOrder: 999 };
  assert.equal(savingFor(pct, 1240), 75);
  assert.equal(savingFor(pct, 800), 0);
  assert.equal(savingFor(pct, 1000), 75);
  assert.equal(savingFor(pct, 999), 75);
  assert.equal(savingFor({ kind: 'percent', value: 10, cap: null, minOrder: null }, 500), 50);
  assert.equal(savingFor({ kind: 'flat', value: 100, minOrder: 1199 }, 1262), 100);
  assert.equal(savingFor({ kind: 'flat', value: 100 }, 60), 60);
  assert.equal(savingFor(null, 500), 0);
});

const offers = [
  { title: 'HDFC 10%', rule: cleanRule({ kind: 'percent', value: 10, cap: 75, minOrder: 999, methods: [{ issuer: 'hdfc', instrument: 'credit' }], conditions: ['first order'] }) },
  { title: 'Flat 100 on GPay', rule: cleanRule({ kind: 'flat', value: 100, minOrder: 1199, methods: [{ issuer: 'gpay', instrument: 'upi' }] }) },
  { title: 'unread', rule: null },
];

test('bestOffer picks the biggest saving among my methods and carries "if eligible"', () => {
  const b = bestOffer(1262, offers, [hdfc, gpay]);
  assert.equal(b.title, 'Flat 100 on GPay');
  assert.equal(b.saving, 100);
  assert.equal(b.after, 1162);
  const c = bestOffer(1240, offers, [hdfc]);
  assert.deepEqual([c.method, c.saving, c.after, c.conditions], ['HDFC Credit Card', 75, 1165, ['first order']]);
});

test('bestOffer: nothing for a method I do not have, an unmet minimum or unread terms', () => {
  assert.equal(bestOffer(1262, offers, [bhim]), null);
  assert.equal(bestOffer(500, offers, [hdfc, gpay]), null);
  assert.equal(bestOffer(1262, [{ title: 'x', rule: null }], [hdfc]), null);
  assert.equal(bestOffer(1262, offers, []), null);
});

test('the advisor never changes the totals it is given', () => {
  const total = 1240;
  bestOffer(total, offers, [hdfc]);
  assert.equal(total, 1240);
});

test('fitsMethods names the method that fits, or null', () => {
  assert.equal(fitsMethods(offers[0].rule, [gpay, hdfc]), 'HDFC Credit Card');
  assert.equal(fitsMethods(offers[0].rule, [gpay]), null);
  assert.equal(fitsMethods(null, [hdfc]), null);
});

test('cleanMethods trims, drops blanks and repeats', () => {
  assert.deepEqual(cleanMethods([' HDFC  Credit Card ', '', 'hdfc credit card', 'UPI']), ['HDFC Credit Card', 'UPI']);
  assert.deepEqual(cleanMethods('nope'), []);
});

test('offerKey changes with the offer text only', () => {
  const a = { title: 'T', description: 'D', terms: ['x'], minOrder: 99 };
  assert.equal(offerKey('zepto', a), offerKey('zepto', { ...a, note: 'Shop for ₹81 more' }));
  assert.notEqual(offerKey('zepto', a), offerKey('zepto', { ...a, terms: ['y'] }));
  assert.notEqual(offerKey('zepto', a), offerKey('instamart', a));
});

test('the AI request carries only offer text', () => {
  const o = { title: 'Flat ₹25 off with Tata Neu UPI', description: 'Valid on orders above ₹199', terms: ['- Valid only on payments above ₹199'], note: 'Shop for ₹181 more', code: 'TATANEU25' };
  const req = buildRulesRequest([o], 'm');
  const user = req.messages[1].content;
  assert.match(user, /Tata Neu UPI/);
  assert.doesNotMatch(user, /181 more|TATANEU25/);
  assert.match(offerText(o), /Terms: /);
});

test('parseRulesReply: usable rule, saving-less offer is false, missing is null', () => {
  const reply = { choices: [{ message: { content: JSON.stringify({ items: [
    { i: 0, kind: 'flat', value: 25, cap: null, minOrder: 199, methods: [{ issuer: 'tata neu', instrument: 'upi' }], conditions: [] },
    { i: 1, kind: null, value: null, cap: null, minOrder: null, methods: [], conditions: [] },
  ] }) } }] };
  const out = parseRulesReply(reply, 3);
  assert.equal(out[0].value, 25);
  assert.equal(out[1], false);
  assert.equal(out[2], null);
  assert.deepEqual(parseRulesReply({ choices: [{ message: { content: 'nope' } }] }, 2), [null, null]);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOfferRules, savedRule } from '../src/ai/offer-rules.js';
import { saveKey, writeAiSettings } from '../src/ai/settings.js';

test('runOfferRules reads each unread payment offer once and caches the rule', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jhola-rules-'));
  try {
    const meta = new Map();
    const offer = { title: 'Flat ₹25 off with Tata Neu UPI', description: 'above ₹199', terms: ['x'], minOrder: 199 };
    const store = {
      getMeta: (k) => meta.get(k) ?? null, setMeta: (k, v) => meta.set(k, String(v)),
      currentDeals: () => ({ offerLists: [{ site: 'zepto', kind: 'payment', offers: [offer] }, { site: 'zepto', kind: 'coupons', offers: [{ title: 'coupon' }] }] }),
    };
    // No key: nothing is sent.
    let calls = 0;
    const fetchImpl = async (_url, init) => {
      calls++;
      assert.doesNotMatch(String(init.body), /secret-key/);
      const content = JSON.stringify({ items: [{ i: 0, kind: 'flat', value: 25, cap: null, minOrder: 199, methods: [{ issuer: 'tata neu', instrument: 'upi' }], conditions: [] }] });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    };
    assert.match((await runOfferRules({ store, dataDir: dir, fetchImpl })).skipped, /No API key/);
    assert.equal(calls, 0);
    saveKey(dir, 'secret-key');
    const out = await runOfferRules({ store, dataDir: dir, fetchImpl });
    assert.deepEqual([out.read, out.calls], [1, 1]);
    assert.equal(savedRule(store, 'zepto', offer).value, 25);
    // Already read: no second call. Turned off: no call either.
    assert.equal((await runOfferRules({ store, dataDir: dir, fetchImpl })).calls, 0);
    writeAiSettings(dir, { readOffers: false });
    meta.clear();
    assert.match((await runOfferRules({ store, dataDir: dir, fetchImpl })).skipped, /off/);
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
