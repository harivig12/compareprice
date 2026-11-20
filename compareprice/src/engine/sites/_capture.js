/**
 * Copy request headers from the page's own API calls.
 *
 * Sites rotate app versions, device ids, csrf secrets and store ids in custom
 * headers. Rather than hardcode them (the old bug: values pasted from DevTools
 * that expired), each site watches its warm tab for the request it wants to
 * replay and reuses whatever the page itself sent.
 */

export const MAX_AGE_MS = 20 * 60 * 1000;

// Headers the browser sets itself or that fetch() refuses to send.
const SKIP = /^(:|host$|cookie$|content-length$|accept-encoding$|connection$|origin$|referer$|user-agent$|sec-|priority$)/i;

/**
 * @param {import('../cdp.js').CdpTab} tab
 * @param {string} key  per-site slot on the tab
 * @param {RegExp} urlRe request to copy headers from
 * @returns {{ headers: Record<string,string>|null, url: string|null, body: string|null }}
 */
export function watchRequest(tab, key, urlRe) {
  tab._capture ??= {};
  if (tab._capture[key]) return tab._capture[key];
  const state = { headers: null, url: null, body: null };
  tab.on('Network.requestWillBeSent', (p) => {
    const url = p.request?.url || '';
    // CORS preflights carry Access-Control-Request-* instead of the real headers.
    if (!urlRe.test(url) || p.request.method === 'OPTIONS') return;
    const h = {};
    for (const [k, v] of Object.entries(p.request.headers || {})) if (!SKIP.test(k)) h[k] = v;
    state.headers = h;
    state.at = Date.now();
    state.url = url;
    state.body = p.request.postData ?? null;
  });
  tab._capture[key] = state;
  return state;
}

/**
 * Make sure headers were captured, navigating to `triggerUrl` (a page that
 * fires the request) when they weren't.
 */
export async function ensureCaptured(tab, key, urlRe, triggerUrl, { timeoutMs = 20000 } = {}) {
  const state = watchRequest(tab, key, urlRe);
  // Copied signatures/csrf values go stale (Zepto rejected 2-hour-old ones
  // between the 07:00 and 09:00 runs); re-capture after MAX_AGE_MS.
  if (state.headers && Date.now() - (state.at ?? 0) < MAX_AGE_MS) return state;
  state.headers = null;
  const seen = tab.waitForEvent('Network.requestWillBeSent', (p) => urlRe.test(p.request?.url || '') && p.request.method !== 'OPTIONS', timeoutMs);
  await tab.goto(triggerUrl, { waitMs: 15000 });
  await seen;
  return state;
}

/**
 * Collect the bodies of the page's own responses matching `urlRe` while it
 * loads (e.g. a fee strip the site shows anyway). Call before navigating;
 * `done()` stops listening and returns [{ url, op, text }].
 */
export function collectResponses(tab, urlRe) {
  const ids = new Map(); // requestId -> { url, op }
  const finished = new Set();
  const offs = [
    tab.on('Network.requestWillBeSent', (p) => {
      if (!urlRe.test(p.request?.url || '') || p.request.method === 'OPTIONS') return;
      let op = '';
      try { op = JSON.parse(p.request.postData || '{}').operationName || ''; } catch { /* not JSON */ }
      ids.set(p.requestId, { url: p.request.url, op });
    }),
    tab.on('Network.loadingFinished', (p) => finished.add(p.requestId)),
  ];
  const read = async () => {
    const out = [];
    for (const [id, meta] of ids) {
      if (!finished.has(id)) continue;
      const r = await tab.send('Network.getResponseBody', { requestId: id }).catch(() => null);
      if (r?.body) out.push({ ...meta, text: r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body });
    }
    return out;
  };
  return {
    /** What has arrived so far, still listening. */
    peek: read,
    async done() {
      offs.forEach((off) => off?.());
      const out = [];
      for (const [id, meta] of ids) {
        if (!finished.has(id)) continue;
        const r = await tab.send('Network.getResponseBody', { requestId: id }).catch(() => null);
        if (r?.body) out.push({ ...meta, text: r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body });
      }
      return out;
    },
  };
}

/** "FREE DELIVERY on orders above ₹99" -> 99 (first such amount in the text). */
export function freeDeliveryFrom(text) {
  const m = /free\s*delivery[^₹]{0,40}?(?:above|over|on orders of)\s*₹\s?(\d{2,4})/i.exec(String(text ?? '').replace(/<[^>]+>/g, ''));
  return m ? Number(m[1]) : null;
}
