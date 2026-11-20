import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, directFetch, refusedDirect } from '../src/engine/direct.js';

/** A tab whose cookies and page-fetch are scripted. */
function fakeTab({ pageAnswer = { status: 200, contentType: 'application/json', text: '{"via":"page"}', ms: 1 } } = {}) {
  const t = {
    pageCalls: 0,
    send: async (m) => (m === 'Network.getCookies' ? { cookies: [{ name: 'sid', value: 'S1' }, { name: 'loc', value: 'L' }] } : {}),
    evaluate: async (expr) => {
      if (expr === 'navigator.userAgent') return 'Mozilla/5.0 Chrome/156.0.0.0';
      if (expr === 'location.origin') return 'https://www.swiggy.com';
      // pageFetch's expression
      t.pageCalls++;
      return pageAnswer;
    },
  };
  return t;
}

const answer = (status, text, type = 'application/json') => async () => ({ status, headers: { get: () => type }, text: async () => text });

test('direct call: cookies from the profile, the page\'s headers, the real UA and origin; forbidden headers dropped', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return answer(200, '{"ok":1}')(); };
  const tab = fakeTab();
  const res = await directFetch(tab, 'https://www.swiggy.com/api/x', { method: 'POST', body: '{}', headers: { 'x-build-version': 'B', 'sec-ch-ua': 'z', Cookie: 'stale' } }, { fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(res.direct, true);
  assert.equal(seen.init.headers.cookie, 'sid=S1; loc=L');
  assert.equal(seen.init.headers['x-build-version'], 'B');
  assert.equal(seen.init.headers['user-agent'], 'Mozilla/5.0 Chrome/156.0.0.0');
  assert.equal(seen.init.headers.origin, 'https://www.swiggy.com');
  assert.equal(seen.init.headers['sec-ch-ua'], undefined);
  assert.equal(seen.init.headers.Cookie, undefined, 'only the profile cookie is sent');
});

test('refusal = network error, 403, or an HTML page; a 401 or 429 is a real answer', () => {
  assert.equal(refusedDirect({ error: true }), true);
  assert.equal(refusedDirect({ status: 403, text: '{}' }), true);
  assert.equal(refusedDirect({ status: 200, contentType: 'text/html', text: '<html>Access Denied</html>' }), true);
  assert.equal(refusedDirect({ status: 200, contentType: 'application/json', text: '{"a":1}' }), false);
  assert.equal(refusedDirect({ status: 401, contentType: 'application/json', text: '{}' }), false);
  assert.equal(refusedDirect({ status: 429, contentType: 'application/json', text: '{}' }), false);
});

test('API first: a refused direct call falls back to the page, and later calls go straight to the page', async () => {
  const logs = [];
  let directCalls = 0;
  const fetchImpl = async () => { directCalls++; return answer(403, '<html>Access Denied</html>', 'text/html')(); };
  const tab = fakeTab();
  const a = await apiFetch(tab, 'https://www.swiggy.com/api/x', {}, { siteId: 'instamart', fetchImpl, log: (m) => logs.push(m) });
  assert.equal(a.text, '{"via":"page"}');
  assert.match(logs[0], /^instamart: direct API call refused \(HTTP 403\); using the browser tab instead$/);
  await apiFetch(tab, 'https://www.swiggy.com/api/y', {}, { siteId: 'instamart', fetchImpl });
  assert.equal(directCalls, 1, 'not asked again');
  assert.equal(tab.pageCalls, 2);
  assert.ok(!logs.some((l) => /S1|sid=/.test(l)), 'no cookie in logs');
});

test('API first: an accepted direct call never touches the page', async () => {
  const tab = fakeTab();
  const res = await apiFetch(tab, 'https://www.swiggy.com/api/x', {}, { siteId: 'instamart', fetchImpl: answer(200, '{"via":"direct"}') });
  assert.equal(res.text, '{"via":"direct"}');
  assert.equal(tab.pageCalls, 0);
});
