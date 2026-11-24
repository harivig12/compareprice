/**
 * The offer check (deals) at fixed times of day: `deals.times` in
 * config.timezone, 07:00 and 18:00 by default.
 *
 * Like the basket scheduler, each tick looks at the window since the previous
 * tick, and each time in it queues one `offers` job, once per day (fire-once
 * keys in the store, so a restart never fires twice). If an offer check is
 * already queued or running, nothing more is queued.
 */
import { wallClock, instantOf } from './scheduler.js';

export const DEFAULT_OFFER_TIMES = Object.freeze(['07:00', '18:00']);

/** The configured times, or the defaults. */
export function offerTimes(cfg) {
  const t = cfg?.deals?.times;
  return Array.isArray(t) ? t : DEFAULT_OFFER_TIMES;
}

/**
 * @param {object} opts
 * @param {{ enqueue: Function, current: Function, pending: Function }} opts.queue
 * @param {() => object} opts.getConfig
 * @param {object} [opts.store]    fire-once keys (markFired)
 * @param {() => Date} [opts.now]
 * @param {number} [opts.tickMs]
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ stop(): void, tick(): void }}
 */
export function startOfferSchedule({ queue, getConfig, store = queue.store, now = () => new Date(), tickMs = 30000, log = () => {} }) {
  let prev = now().getTime() - tickMs;
  const memory = new Set();
  const claim = (key) => {
    if (store?.markFired) return store.markFired(key);
    if (memory.has(key)) return false;
    memory.add(key);
    return true;
  };
  const busy = () => queue.current?.()?.trigger === 'offers' || (queue.pending?.() ?? []).some((j) => j.trigger === 'offers');

  function tick() {
    const cur = now().getTime();
    const from = prev;
    if (cur <= from) return;
    prev = cur;
    let cfg;
    try { cfg = getConfig(); } catch (err) { log(`offers: config unavailable: ${err.message}`); return; }
    const tz = cfg.timezone || 'UTC';
    const days = [wallClock(new Date(from), tz), wallClock(new Date(cur), tz)];
    if (days[0].day === days[1].day) days.pop();
    for (const time of offerTimes(cfg)) {
      for (const wc of days) {
        const at = instantOf(wc, time);
        if (at == null || !(at > from && at <= cur)) continue;
        if (!claim(`offers|${wc.day}|${time}`)) continue;
        if (busy()) continue;
        try {
          const id = queue.enqueue({ items: '', sites: null, trigger: 'offers' });
          log(`offers: job ${id} queued (${time})`);
        } catch (err) {
          log(`offers: could not queue the ${time} check: ${err.message}`);
        }
      }
    }
  }

  tick();
  const timer = setInterval(tick, tickMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
