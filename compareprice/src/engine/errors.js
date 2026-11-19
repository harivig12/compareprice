/**
 * Site error taxonomy. Every engine failure is one of these kinds so the
 * runner can decide (retry on `session`, fall back on `blocked`, report
 * `unserviceable` with the site's own message) and the UI can say why.
 */
export const ERROR_KINDS = Object.freeze(new Set([
  'session', // auth/session cookie expired: refresh the tab and retry once
  'blocked', // WAF/bot wall, 403/429, HTML where JSON was expected
  'unserviceable', // the site does not deliver to the configured location
  'timeout', // the request ran into its deadline
  'parse', // the payload was not what the parser expects
  'not_found', // the site answered but has no match for the query
  'browser', // Chrome/tab died or CDP failed
]));

export class SiteError extends Error {
  /**
   * @param {'session'|'blocked'|'unserviceable'|'timeout'|'parse'|'not_found'|'browser'} kind
   * @param {string} message
   * @param {{ status?: number, site?: string, cause?: unknown, retryAfterMs?: number }} [opts]
   *   retryAfterMs: how long the runner should wait before its one retry (rate limits)
   */
  constructor(kind, message, { status, site, cause, retryAfterMs } = {}) {
    if (!ERROR_KINDS.has(kind)) throw new TypeError(`SiteError: unknown kind "${kind}"`);
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'SiteError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (site !== undefined) this.site = site;
    if (retryAfterMs) this.retryAfterMs = retryAfterMs;
  }
}
