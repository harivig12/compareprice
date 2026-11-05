/**
 * Local web view + JSON API. Zero dependencies — node:http only.
 *
 * Bound to 127.0.0.1 on purpose: POST /api/compare drives a real browser with
 * whatever basket it is handed, so this must not be reachable from the network
 * the laptop happens to be on.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

import { PAGE_FILE } from './paths.js';
import { saveResult, loadResult } from './ui-writer.js';
import { compareBasket, DEFAULT_PINCODE } from './compare.js';
import { PLATFORMS, ALL_PLATFORMS } from './platforms.js';
import { CONFIDENCE_THRESHOLD } from './normalize.js';

const DEFAULT_PORT = 7777;
const PORT_ATTEMPTS = 10;
const MAX_BODY = 256 * 1024;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {object} [opts]
 * @param {number} [opts.port]
 * @param {(args: object) => Promise<object>} [opts.compare] injectable for tests
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export function startServer({ port = DEFAULT_PORT, compare = compareBasket } = {}) {
  // One comparison at a time. Concurrent runs fight over a single browser
  // session and surface as SessionBusyError from webcmd.
  let inFlight = null;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;

    try {
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = readFileSync(PAGE_FILE, 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && path === '/health') {
        json(res, 200, { ok: true, service: 'basket', busy: inFlight !== null });
        return;
      }

      if (req.method === 'GET' && path === '/api/meta') {
        json(res, 200, {
          platforms: ALL_PLATFORMS,
          defaultPlatforms: PLATFORMS,
          defaultPincode: DEFAULT_PINCODE,
          confidenceThreshold: CONFIDENCE_THRESHOLD,
          busy: inFlight !== null,
        });
        return;
      }

      if (req.method === 'GET' && path === '/api/result') {
        const result = loadResult();
        if (!result) {
          // 204 rather than an empty object: the page shows its empty state
          // instead of rendering a table with no columns.
          res.writeHead(204, { 'cache-control': 'no-store' });
          res.end();
          return;
        }
        json(res, 200, result);
        return;
      }

      if (req.method === 'POST' && path === '/api/compare') {
        if (inFlight) {
          json(res, 409, {
            error: 'A comparison is already running. Wait for it to finish.',
          });
          return;
        }

        let payload;
        try {
          payload = JSON.parse((await readBody(req)) || '{}');
        } catch {
          json(res, 400, { error: 'Body must be JSON.' });
          return;
        }

        const items = String(payload.items ?? '').trim();
        if (!items) {
          json(res, 400, { error: 'No items given. Send { "items": "one per line" }.' });
          return;
        }

        const platforms = Array.isArray(payload.platforms) && payload.platforms.length > 0
          ? payload.platforms.filter((p) => ALL_PLATFORMS.includes(p))
          : undefined;
        if (platforms && platforms.length === 0) {
          json(res, 400, { error: `Unknown platforms. Available: ${ALL_PLATFORMS.join(', ')}` });
          return;
        }

        inFlight = compare({
          items,
          platforms,
          pincode: payload.pincode || DEFAULT_PINCODE,
        });

        try {
          const result = await inFlight;
          saveResult(result);
          json(res, 200, result);
        } catch (err) {
          json(res, 500, { error: err.message });
        } finally {
          inFlight = null;
        }
        return;
      }

      json(res, 404, { error: `No route for ${req.method} ${path}` });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryListen = (p) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < PORT_ATTEMPTS) {
          attempt += 1;
          tryListen(p + 1);
          return;
        }
        reject(err);
      });
      server.listen(p, '127.0.0.1', () => {
        const actual = server.address().port;
        resolve({
          url: `http://localhost:${actual}`,
          port: actual,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    };

    tryListen(port);
  });
}
