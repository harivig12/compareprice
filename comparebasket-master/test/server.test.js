/**
 * Server routes. Never touches the network: `compare` is injected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect the data dir before anything imports paths.js.
const TMP = mkdtempSync(join(tmpdir(), 'basket-test-'));
process.env.BASKET_HOME = TMP;

const { startServer } = await import('../src/server.js');

const FAKE_RESULT = {
  pincode: '110048',
  backend: 'fake',
  generatedAt: new Date().toISOString(),
  elapsedMs: 10,
  confidenceThreshold: 0.55,
  basket: [{ raw: 'tata salt 1kg', query: 'tata salt 1kg', qty: 1 }],
  platforms: [],
  unavailable: [],
  winner: null,
  runnerUp: null,
  saving: 0,
  likeForLike: true,
  feesAsOf: 'test',
  feesVerified: false,
};

async function withServer(fn, compare = async () => FAKE_RESULT) {
  // Port 0 → OS picks a free one, so tests never collide with a real server.
  const server = await startServer({ port: 0, compare });
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

test('binds to loopback only', async () => {
  await withServer((s) => {
    assert.match(s.url, /^http:\/\/localhost:\d+$/);
    assert.ok(s.port > 0);
  });
});

test('GET /health reports ok', async () => {
  await withServer(async (s) => {
    const res = await fetch(`${s.url}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.busy, false);
  });
});

test('GET /api/meta exposes platforms and defaults', async () => {
  await withServer(async (s) => {
    const body = await (await fetch(`${s.url}/api/meta`)).json();
    assert.ok(Array.isArray(body.platforms));
    assert.ok(body.platforms.includes('blinkit'));
    assert.ok(Array.isArray(body.defaultPlatforms));
    assert.equal(typeof body.confidenceThreshold, 'number');
  });
});

test('GET /api/result is 204 when nothing has been compared', async () => {
  rmSync(join(TMP, 'last-result.json'), { force: true });
  await withServer(async (s) => {
    const res = await fetch(`${s.url}/api/result`);
    assert.equal(res.status, 204);
  });
});

test('GET / serves the page', async () => {
  await withServer(async (s) => {
    const res = await fetch(`${s.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /<title>Basket/);
  });
});

test('POST /api/compare rejects an empty basket with 400', async () => {
  await withServer(async (s) => {
    const res = await fetch(`${s.url}/api/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: '   ' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /No items/i);
  });
});

test('POST /api/compare rejects non-JSON with 400', async () => {
  await withServer(async (s) => {
    const res = await fetch(`${s.url}/api/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    assert.equal(res.status, 400);
  });
});

test('POST /api/compare runs, persists, and /api/result then returns it', async () => {
  await withServer(async (s) => {
    const res = await fetch(`${s.url}/api/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: 'tata salt 1kg' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.backend, 'fake');

    // Saved, so a browser tab polling /api/result sees it.
    const again = await fetch(`${s.url}/api/result`);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).backend, 'fake');
  });
});

test('a second comparison while one is running gets 409, not a wedged browser', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });

  await withServer(
    async (s) => {
      const first = fetch(`${s.url}/api/compare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: 'milk' }),
      });
      // Let the first request reach the handler and take the lock.
      await new Promise((r) => setTimeout(r, 60));

      const second = await fetch(`${s.url}/api/compare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: 'bread' }),
      });
      assert.equal(second.status, 409);

      release();
      assert.equal((await first).status, 200);
    },
    async () => { await gate; return FAKE_RESULT; },
  );
});

test('unknown routes 404 as JSON', async () => {
  await withServer(async (s) => {
    const res = await fetch(`${s.url}/nope`);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /No route/);
  });
});

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
});
