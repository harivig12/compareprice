/**
 * Catalogue sweep: fills in prices for catalogue products nobody has asked
 * for yet, a few at a time, at random moments.
 *
 *   00:00  3 products   00:09  2 products   00:23  4 products   00:38  2 ...
 *
 * Each firing queues one small job (trigger "sweep") of 2–4 products on the
 * shared JobQueue, then waits a random 5–20 minutes. Random sizes and gaps
 * keep the traffic from looking like a burst, and a site's own request budget
 * (src/limits.js) still paces every query inside the job.
 *
 * Which products: those with no saved price on some sweep site first (fewest
 * sites covered, then oldest), shuffled within a tier so every run is a
 * different set. A product is swept at most once per day (fire-once keys in
 * the store), so one a site never stocks is not retried every few minutes.
 * When nothing is missing, products whose newest price is older than
 * `staleHours` are refreshed instead. A run never starts while another job is
 * running or queued: it waits a minute or two and looks again.
 *
 * Config (config.json "sweep", defaults in src/config.js):
 *   { enabled, sites: [] (= config.sites), minItems, maxItems,
 *     minGapMinutes, maxGapMinutes, staleHours }
 */
import { PRODUCTS } from './catalog.js';
import { wallClock } from './scheduler.js';

const MINUTE = 60_000;
const BUSY_RETRY = [1, 3]; // minutes to wait when the queue is busy

const randInt = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1));

function shuffle(arr, random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Sweep settings with defaults and sane bounds. */
export function sweepSettings(cfg) {
  const s = cfg?.sweep ?? {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const minItems = Math.max(1, Math.round(num(s.minItems, 2)));
  const maxItems = Math.max(minItems, Math.round(num(s.maxItems, 4)));
  const minGap = Math.max(1, num(s.minGapMinutes, 5));
  const maxGap = Math.max(minGap, num(s.maxGapMinutes, 20));
  return {
    enabled: s.enabled !== false,
    sites: Array.isArray(s.sites) && s.sites.length ? s.sites : cfg?.sites ?? [],
    minItems,
    maxItems,
    minGapMinutes: minGap,
    maxGapMinutes: maxGap,
    staleHours: Math.max(1, num(s.staleHours, 24)),
  };
}

/**
 * The next products to sweep, missing ones first.
 * @returns {Array<{ product: object, missing: string[], newest: string|null, reason: 'missing'|'stale' }>}
 */
export function pickSweepItems({ store, sites, count, random = Math.random, now = new Date(), staleHours = 24, sweptToday = () => false, products = PRODUCTS }) {
  const staleBefore = new Date(now.getTime() - staleHours * 60 * MINUTE).toISOString();
  const tiers = new Map(); // covered-site count -> candidates
  const stale = [];
  for (const product of products) {
    if (sweptToday(product.id)) continue;
    const seen = store.coverage(product.canonical);
    const covered = sites.filter((s) => seen[s]);
    const newest = Object.values(seen).sort().at(-1) ?? null;
    const missing = sites.filter((s) => !seen[s]);
    if (missing.length) {
      if (!tiers.has(covered.length)) tiers.set(covered.length, []);
      tiers.get(covered.length).push({ product, missing, newest, reason: 'missing' });
    } else if (newest && newest < staleBefore) {
      stale.push({ product, missing, newest, reason: 'stale' });
    }
  }
  const ordered = [...tiers.keys()].sort((a, b) => a - b).flatMap((k) => shuffle(tiers.get(k), random));
  stale.sort((a, b) => a.newest.localeCompare(b.newest));
  return [...ordered, ...stale].slice(0, count);
}

/**
 * @param {object} opts
 * @param {{ enqueue: Function, current: Function, pending: Function }} opts.queue
 * @param {() => object} opts.getConfig
 * @param {object} opts.store              needs coverage(), markFired(), hasFired()
 * @param {() => number} [opts.random]
 * @param {() => Date} [opts.now]
 * @param {Function} [opts.setTimer]       setTimeout-compatible (tests)
 * @param {Function} [opts.clearTimer]
 * @param {(msg: string) => void} [opts.log]
 */
export function startSweep({
  queue,
  getConfig,
  store = queue.store,
  random = Math.random,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
}) {
  let timer = null;
  let stopped = false;
  let nextAt = null;
  const state = { runs: 0, lastRun: null };

  const settings = () => {
    try {
      return { cfg: getConfig(), ...sweepSettings(getConfig()) };
    } catch (err) {
      log(`sweep: config unavailable: ${err.message}`);
      return null;
    }
  };
  const today = (cfg) => wallClock(now(), cfg.timezone || 'UTC').day;

  function arm(ms) {
    if (stopped) return;
    if (timer) clearTimer(timer);
    nextAt = new Date(now().getTime() + ms).toISOString();
    timer = setTimer(fire, ms);
    timer?.unref?.();
  }

  const gapMs = (s) => Math.round((s.minGapMinutes + random() * (s.maxGapMinutes - s.minGapMinutes)) * MINUTE);

  /** Queue one sweep job now (if anything needs sweeping). @returns {{ jobId: number|null, items: string[], reason?: string }} */
  function runOnce({ force = false } = {}) {
    const s = settings();
    if (!s) return { jobId: null, items: [], reason: 'no config' };
    if (!s.enabled && !force) return { jobId: null, items: [], reason: 'disabled' };
    if (!force && (queue.current?.() || queue.pending?.().length)) return { jobId: null, items: [], reason: 'busy' };
    const day = today(s.cfg);
    const picks = pickSweepItems({
      store,
      sites: s.sites,
      count: randInt(random, s.minItems, s.maxItems),
      random,
      now: now(),
      staleHours: s.staleHours,
      sweptToday: (id) => store.hasFired?.(`sweep|${day}|${id}`) ?? false,
    });
    if (!picks.length) return { jobId: null, items: [], reason: 'nothing to sweep' };
    const items = picks.map((p) => p.product.canonical);
    const jobId = queue.enqueue({ items: items.join('\n'), sites: s.sites, trigger: 'sweep' });
    for (const p of picks) store.markFired?.(`sweep|${day}|${p.product.id}`);
    state.runs += 1;
    state.lastRun = { at: now().toISOString(), jobId, items, reasons: picks.map((p) => p.reason) };
    log(`sweep: job ${jobId} — ${items.length} product(s): ${items.join(', ')}`);
    return { jobId, items };
  }

  function fire() {
    timer = null;
    const s = settings();
    if (!s) return arm(5 * MINUTE);
    const out = runOnce();
    if (out.reason === 'busy') return arm(randInt(random, BUSY_RETRY[0] * MINUTE, BUSY_RETRY[1] * MINUTE));
    arm(gapMs(s));
  }

  // First firing after a random gap, never in the same breath as boot.
  const first = settings();
  if (first) arm(gapMs(first));

  return {
    runOnce,
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      nextAt = null;
    },
    status() {
      const s = settings();
      return { enabled: s?.enabled ?? false, settings: s && { ...s, cfg: undefined }, nextAt, ...state };
    },
  };
}
