/**
 * Chrome DevTools Protocol driver.
 *
 * This exists because webcmd's `cloak` runtime could not provision a browser at
 * the venue (its control API was unreachable), so the adapters run against a
 * Chrome we launch ourselves. The extractors in src/extract/ are written in the
 * webcmd adapter shape — same envelope, same `func(page, args)` split — so they
 * port back to `~/.webcmd/clis/<site>/search.js` with minimal change once the
 * bridge works.
 */

const CDP_HOST = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';

async function listTargets() {
  const res = await fetch(`${CDP_HOST}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: HTTP ${res.status}`);
  return res.json();
}

/** Open a fresh tab so concurrent searches don't fight over one page. */
async function newTab() {
  const res = await fetch(`${CDP_HOST}/json/new?about:blank`, { method: 'PUT' });
  if (res.ok) return res.json();
  // Older Chrome builds want GET here.
  const fallback = await fetch(`${CDP_HOST}/json/new?about:blank`);
  if (!fallback.ok) throw new Error(`CDP new tab failed: HTTP ${fallback.status}`);
  return fallback.json();
}

async function closeTab(id) {
  try {
    await fetch(`${CDP_HOST}/json/close/${id}`);
  } catch {
    /* tab already gone */
  }
}

function attach(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const timer = setTimeout(() => reject(new Error('CDP attach timed out')), 15000);

    ws.onopen = () => {
      clearTimeout(timer);
      resolve(makeSession());
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP websocket error'));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };

    function send(method, params = {}, timeoutMs = 30000) {
      const msgId = ++id;
      return new Promise((res, rej) => {
        const t = setTimeout(() => {
          pending.delete(msgId);
          rej(new Error(`CDP ${method} timed out`));
        }, timeoutMs);
        pending.set(msgId, (m) => {
          clearTimeout(t);
          res(m);
        });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    }

    function makeSession() {
      return {
        send,
        async evaluate(expression, timeoutMs = 30000) {
          const r = await send(
            'Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: true },
            timeoutMs,
          );
          const ex = r.result?.exceptionDetails;
          if (ex) throw new Error(ex.exception?.description || ex.text || 'evaluate threw');
          return r.result?.result?.value;
        },
        async goto(url, { waitMs = 6000, retries = 2 } = {}) {
          for (let attempt = 0; attempt <= retries; attempt++) {
            await send('Page.navigate', { url });
            await new Promise((r) => setTimeout(r, waitMs));
            const href = await this.evaluate('location.href').catch(() => null);
            if (href && !String(href).startsWith('chrome-error')) return href;
            // Venue wifi drops connections; a retry usually lands.
            await new Promise((r) => setTimeout(r, 2500));
          }
          throw new Error(`navigation failed after ${retries + 1} attempts`);
        },
        /** Poll until `expression` returns truthy, or give up. */
        async waitFor(expression, { timeoutMs = 15000, intervalMs = 500 } = {}) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const ok = await this.evaluate(expression).catch(() => false);
            if (ok) return true;
            await new Promise((r) => setTimeout(r, intervalMs));
          }
          return false;
        },
        close: () => ws.close(),
      };
    }
  });
}

/**
 * Run `fn(session)` in a throwaway tab, cleaning up whatever happens.
 */
export async function withTab(fn) {
  const target = await newTab();
  let session;
  try {
    session = await attach(target);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    return await fn(session);
  } finally {
    session?.close();
    await closeTab(target.id);
  }
}

/** True when a debuggable Chrome is actually there. */
export async function browserAvailable() {
  try {
    const res = await fetch(`${CDP_HOST}/json/version`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

export { CDP_HOST };
