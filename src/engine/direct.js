/**
 * API first, browser as the fallback (decision 2026-11-19, see
 * docs/diagnosis/2026-11-19-account-offers-zepto-milkbasket.md › Task 0 recon).
 *
 * For sites cleared by that recon (`site.direct === true`: Instamart, Milkbasket),
 * a data call is made from Node with the account's own session: the cookies of
 * its browser profile plus the headers the page itself sent, read from the warm
 * tab and held only in memory. If the site refuses a direct call (network
 * error, 403, HTML instead of JSON), the tab is marked and that call, and every
 * later one on the tab, runs inside the page instead (`pageFetch`), as AGENTS.md
 * requires for every other site.
 *
 * Nothing here is written to disk or logged: no cookie, header value or token.
 */
import { pageFetch } from './page-fetch.js';

// The fetch() spec forbids these, or Node sets them itself.
const SKIP = /^(:|host$|cookie$|content-length$|accept-encoding$|connection$|sec-|priority$)/i;

/** Is this answer a refusal of a non-browser client (vs. a real API answer)? */
export function refusedDirect(res) {
  if (!res || res.error) return true;
  if (res.status === 403) return true;
  // A bot wall answers with a page, not JSON.
  return /^\s*</.test(res.text ?? '') && !/json/i.test(res.contentType ?? '');
}

/** Cookie header for `url`, read from the tab's browser profile. */
async function cookieHeader(tab, url) {
  const { cookies = [] } = await tab.send('Network.getCookies', { urls: [url] });
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function userAgent(tab) {
  if (!tab._ua) tab._ua = await tab.evaluate('navigator.userAgent', { timeoutMs: 5000 }).catch(() => null);
  return tab._ua;
}

/**
 * One call from Node with the tab's session. Same result shape as pageFetch.
 * @param {import('./cdp.js').CdpTab} tab
 * @param {string} url absolute
 * @param {{ method?: string, headers?: Record<string,string>, body?: string }} [init]
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 */
export async function directFetch(tab, url, init = {}, { timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).filter(([k]) => !SKIP.test(k)));
  headers.cookie = await cookieHeader(tab, url);
  const ua = await userAgent(tab);
  if (ua) headers['user-agent'] = ua;
  const page = await tab.evaluate('location.origin', { timeoutMs: 5000 }).catch(() => null);
  if (page && page !== 'null') {
    headers.origin ??= page;
    headers.referer ??= `${page}/`;
  }
  const t0 = Date.now();
  try {
    const r = await fetchImpl(url, { method: init.method ?? 'GET', headers, body: init.body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    return { status: r.status, contentType: r.headers.get('content-type') || '', text, ms: Date.now() - t0, timeoutMs, direct: true };
  } catch (e) {
    const ms = Date.now() - t0;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { status: 0, contentType: '', text: '', ms, timedOut: true, timeoutMs, direct: true };
    return { status: 0, contentType: '', text: String(e?.cause?.code ?? e?.message ?? e), ms, error: true, timeoutMs, direct: true };
  }
}

/**
 * Direct first; on refusal, the page. Remembers a refusal per tab and site so
 * a refusing site isn't asked again in that session.
 * @param {{ siteId: string, log?: (msg: string) => void, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export async function apiFetch(tab, url, init = {}, { siteId, log = () => {}, fetchImpl, timeoutMs = 20000 } = {}) {
  tab._direct ??= {};
  if (tab._direct[siteId] !== 'off') {
    const res = await directFetch(tab, url, init, { timeoutMs, fetchImpl });
    if (!refusedDirect(res)) {
      tab._direct[siteId] = 'on';
      return res;
    }
    tab._direct[siteId] = 'off';
    log(`${siteId}: direct API call refused (${res.error ? 'network error' : `HTTP ${res.status}`}); using the browser tab instead`);
  }
  return pageFetch(tab, url, init, { timeoutMs });
}
