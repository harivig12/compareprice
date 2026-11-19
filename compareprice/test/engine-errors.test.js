import test from 'node:test';
import assert from 'node:assert/strict';
import { SiteError, ERROR_KINDS } from '../src/engine/errors.js';
import { expectJson } from '../src/engine/page-fetch.js';

const res = (status, text, extra = {}) => ({ status, contentType: 'application/json', text, ms: 10, ...extra });
const kindOf = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SiteError, `not a SiteError: ${e}`);
    return e;
  }
  assert.fail('did not throw');
};

test('error kinds are the exact set', () => {
  assert.deepEqual(
    [...ERROR_KINDS].sort(),
    ['blocked', 'browser', 'not_found', 'parse', 'session', 'timeout', 'unserviceable'],
  );
  assert.throws(() => new SiteError('nope', 'x'), /kind/);
});

test('SiteError carries kind, status, site and cause', () => {
  const cause = new Error('root');
  const e = new SiteError('blocked', 'x: 403', { status: 403, site: 'x', cause });
  assert.equal(e.kind, 'blocked');
  assert.equal(e.status, 403);
  assert.equal(e.site, 'x');
  assert.equal(e.cause, cause);
  assert.equal(e.name, 'SiteError');
});

test('200 JSON parses', () => {
  assert.deepEqual(expectJson(res(200, '{"a":1}'), 'x'), { a: 1 });
});

test('401 and 419 are session', () => {
  assert.equal(kindOf(() => expectJson(res(401, '{}'), 'x')).kind, 'session');
  assert.equal(kindOf(() => expectJson(res(419, '{}'), 'x')).kind, 'session');
});

test('403 HTML is blocked and names the status', () => {
  const e = kindOf(() => expectJson(res(403, '<HTML><HEAD><TITLE>Access Denied</TITLE>'), 'instamart'));
  assert.equal(e.kind, 'blocked');
  assert.match(e.message, /403/);
  assert.match(e.message, /^instamart: 403 blocked \(<HTML>/);
  assert.equal(e.status, 403);
  assert.equal(e.site, 'instamart');
});

test('429 is blocked', () => {
  assert.equal(kindOf(() => expectJson(res(429, '{}'), 'x')).kind, 'blocked');
});

test('200 with an HTML body is blocked', () => {
  assert.equal(kindOf(() => expectJson(res(200, '  <html><body>hi'), 'x')).kind, 'blocked');
});

test('200 with bad JSON is parse', () => {
  assert.equal(kindOf(() => expectJson(res(200, '{bad'), 'x')).kind, 'parse');
});

test('a fetch that ran into its timeout is timeout', () => {
  const e = kindOf(() => expectJson(res(0, '', { ms: 20000, timeoutMs: 20000, timedOut: true }), 'x'));
  assert.equal(e.kind, 'timeout');
});

test('message trims the body to 80 characters', () => {
  const e = kindOf(() => expectJson(res(403, 'x'.repeat(500)), 's'));
  assert.ok(e.message.includes('x'.repeat(80)));
  assert.ok(!e.message.includes('x'.repeat(81)));
});
