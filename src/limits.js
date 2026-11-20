/**
 * Per-site request budget.
 *
 * None of these sites publishes a rate limit. The defaults are conservative
 * numbers chosen from what was observed (docs/diagnosis, 2026-11-18/19):
 *   - Instamart answers HTTP 200 with {"statusCode":429} when searches come
 *     in a burst; one search every ~2.5 s was fine, a rapid run of ten was not.
 *   - BigBasket's Akamai walled the whole IP after ~15 page loads with fresh
 *     profiles in an hour; API calls from one warm tab were never blocked.
 *   - Zepto's gateway dropped CORS headers (a WAF answer) once headers went
 *     stale, not because of volume.
 * So: a minimum gap between searches, a per-minute and a per-hour cap, and a
 * cool-down after any `blocked` answer. All are adjustable in config.json
 * under `limits` (per site, or "default").
 *
 * Two behaviours:
 *   acquire(site)       waits its turn (jobs and the scheduler use this)
 *   check(site, count)  says how long a *manual* request must wait, so the UI
 *                       can show "wait 10s…" instead of silently stalling
 */
import { SiteError } from './engine/errors.js';

export const DEFAULT_LIMITS = Object.freeze({
  default: { minGapMs: 2500, perMinute: 15, perHour: 240, cooldownMs: 5 * 60_000 },
  instamart: { minGapMs: 3000, perMinute: 12, perHour: 200, cooldownMs: 10 * 60_000 },
  bigbasket: { minGapMs: 3000, perMinute: 12, perHour: 200, cooldownMs: 30 * 60_000 },
  amazon: { minGapMs: 4000, perMinute: 8, perHour: 120, cooldownMs: 30 * 60_000 },
});

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Operation aborted'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error('Operation aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class SiteLimiter {
  /**
   * @param {{ limits?: Record<string, Partial<typeof DEFAULT_LIMITS.default>>, now?: () => number, sleep?: Function }} [opts]
   */
  constructor({ limits = {}, now = () => Date.now(), sleep: sleeper = sleep } = {}) {
    this.overrides = limits;
    this.now = now;
    this.sleep = sleeper;
    this.events = new Map(); // site -> number[] (timestamps of searches, newest last)
    this.cooldown = new Map(); // site -> { until, reason }
  }

  limitsFor(site) {
    return { ...DEFAULT_LIMITS.default, ...(DEFAULT_LIMITS[site] ?? {}), ...(this.overrides.default ?? {}), ...(this.overrides[site] ?? {}) };
  }

  #recent(site) {
    const t = this.now();
    const list = (this.events.get(site) ?? []).filter((x) => t - x < 3_600_000);
    this.events.set(site, list);
    return list;
  }

  /**
   * How long until `count` more searches fit.
   * @returns {{ ok: boolean, waitMs: number, reason: string|null }}
   */
  check(site, count = 1) {
    const lim = this.limitsFor(site);
    const t = this.now();
    const cd = this.cooldown.get(site);
    if (cd && cd.until > t) return { ok: false, waitMs: cd.until - t, reason: cd.reason };

    const ev = this.#recent(site);
    let wait = 0;
    let reason = null;
    const bump = (ms, why) => { if (ms > wait) { wait = ms; reason = why; } };
    // The gap after the last search; a job paces itself inside, so only the
    // first of the new searches needs to wait for it.
    if (ev.length) bump(ev.at(-1) + lim.minGapMs - t, 'a search just ran');
    // Window caps: the count-th new search must fit within the budget.
    for (const [windowMs, cap, label] of [[60_000, lim.perMinute, 'per minute'], [3_600_000, lim.perHour, 'per hour']]) {
      const inWindow = ev.filter((x) => t - x < windowMs);
      // A list longer than the cap still starts; it paces itself through acquire().
      const overflow = inWindow.length + Math.min(count, cap) - cap;
      if (overflow > 0) {
        // Wait until enough old searches age out of the window.
        const ageOut = inWindow[Math.min(overflow, inWindow.length) - 1];
        bump(ageOut + windowMs - t, `${cap} searches ${label}`);
      }
    }
    return wait > 0 ? { ok: false, waitMs: Math.ceil(wait), reason } : { ok: true, waitMs: 0, reason: null };
  }

  /**
   * Wait until one search is allowed, then count it. A site resting after a
   * block is NOT waited for: that held the whole queue for 33 minutes
   * (2026-11-20, BigBasket's Akamai wall). It fails at once as `blocked`, the
   * runner skips the site's remaining items, and the other sites carry on.
   */
  async acquire(site, { signal, onWait } = {}) {
    for (;;) {
      const r = this.check(site, 1);
      if (r.ok) break;
      const cd = this.cooldown.get(site);
      if (cd && cd.until > this.now()) {
        const at = new Date(cd.until).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
        throw new SiteError('blocked', `${site}: resting until ${at} (${cd.reason}); skipped this run`, { site, code: 'resting' });
      }
      onWait?.(r);
      await this.sleep(Math.min(r.waitMs, 5000), signal);
    }
    this.#recent(site).push(this.now());
  }

  /** The site said no (bot wall, 429): leave it alone for a while. */
  penalize(site, reason = 'blocked by the site') {
    const ms = this.limitsFor(site).cooldownMs;
    this.cooldown.set(site, { until: this.now() + ms, reason: `${reason}; resting ${Math.round(ms / 60000)} min` });
  }

  /** Clear a cool-down (the user says it's fine, or a good answer came back). */
  clear(site) {
    this.cooldown.delete(site);
  }

  /** Snapshot for the UI and /api/limits. */
  status(sites = []) {
    const t = this.now();
    const names = new Set([...sites, ...this.events.keys(), ...this.cooldown.keys()]);
    return Object.fromEntries(
      [...names].map((site) => {
        const ev = this.#recent(site);
        const cd = this.cooldown.get(site);
        return [site, {
          lastMinute: ev.filter((x) => t - x < 60_000).length,
          lastHour: ev.length,
          limits: this.limitsFor(site),
          cooldownMs: cd && cd.until > t ? cd.until - t : 0,
          cooldownReason: cd && cd.until > t ? cd.reason : null,
          ...this.check(site, 1),
        }];
      }),
    );
  }
}

let shared = null;
/** Process-wide limiter, so manual runs, jobs and the scheduler share one budget. */
export function getLimiter(limits) {
  if (!shared) shared = new SiteLimiter({ limits });
  else if (limits) shared.overrides = limits;
  return shared;
}
