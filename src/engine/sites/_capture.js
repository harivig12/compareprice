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
