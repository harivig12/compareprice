/**
 * Run a site's API from inside its own warm tab, so the request carries the
 * browser's cookies, TLS fingerprint and client hints. Returns raw text;
 * `expectJson` turns HTTP/body shapes into SiteError kinds.
 */
import { SiteError } from './errors.js';

/**
 * @param {import('./cdp.js').CdpTab} tab
 * @param {string} url absolute, or relative to the tab's origin
 * @param {{ method?: string, headers?: Record<string,string>, body?: string }} [init]
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number, contentType: string, text: string, ms: number, timedOut?: boolean, timeoutMs: number }>}
 */
export async function pageFetch(tab, url, init = {}, { timeoutMs = 20000 } = {}) {
  const payload = JSON.stringify({ url, init: { ...init }, timeoutMs });
  const expr = `(async () => {
    const { url, init, timeoutMs } = ${payload};
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = performance.now();
    try {
      const r = await fetch(url, { credentials: 'include', ...init, signal: ctl.signal });
      const text = await r.text();
      return { status: r.status, contentType: r.headers.get('content-type') || '', text, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      if (e && e.name === 'AbortError') return { status: 0, contentType: '', text: '', ms, timedOut: true };
      return { status: 0, contentType: '', text: String(e && e.message || e), ms, error: true };
    } finally {
      clearTimeout(timer);
    }
  })()`;
  let res;
  try {
    res = await tab.evaluate(expr, { timeoutMs: timeoutMs + 5000 });
  } catch (e) {
    if (/evaluate timeout/.test(e.message)) {
      return { status: 0, contentType: '', text: '', ms: timeoutMs, timedOut: true, timeoutMs };
    }
    throw new SiteError('browser', `page fetch failed: ${e.message}`, { cause: e });
  }
  return { ...res, timeoutMs };
}

const snippet = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * @param {{ status: number, contentType?: string, text: string, ms: number, timedOut?: boolean, timeoutMs?: number, error?: boolean }} res
 * @param {string} site
 */
export function expectJson(res, site) {
  const { status, text } = res;
  const fail = (kind, what) => new SiteError(kind, `${site}: ${what}`, { status, site });
  if (res.timedOut || (res.timeoutMs && res.ms >= res.timeoutMs)) {
    throw fail('timeout', `timed out after ${res.ms} ms`);
  }
  if (res.error) {
    // "Failed to fetch" from a cross-origin API almost always means the
    // gateway answered with an error page that has no CORS headers: a WAF
    // block or rate limit, not a code bug.
    const hint = /failed to fetch/i.test(text) ? ' — the API refused the request without CORS headers (usually a bot wall or rate limit; clears in a few hours)' : '';
    throw fail('blocked', `network error (${snippet(text)})${hint}`);
  }
  if (status === 401 || status === 419) throw fail('session', `${status} session expired (${snippet(text)})`);
  if (status === 403 || status === 429) throw fail('blocked', `${status} blocked (${snippet(text)})`);
  if (/^\s*</.test(text)) throw fail('blocked', `${status} blocked: HTML instead of JSON (${snippet(text)})`);
  // Other 4xx/5xx: the API refused us. Not `not_found`, which means "no match for the query".
  if (status >= 400) throw fail('blocked', `${status} error (${snippet(text)})`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new SiteError('parse', `${site}: ${status} invalid JSON (${snippet(text)})`, { status, site, cause: e });
  }
}
