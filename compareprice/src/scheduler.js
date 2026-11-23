/**
 * Daily-times scheduler.
 *
 * Every tick it looks at the window since the previous tick. Each schedule
 * time (HH:MM in config.timezone) that falls in that window enqueues the
 * basket for that schedule's sites, once per day. Fired keys live in the
 * store, so a restart inside the window never fires twice.
 */

/** Wall-clock parts of `date` in `timeZone`. */
export function wallClock(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const y = Number(parts.year);
  const mo = Number(parts.month);
  const d = Number(parts.day);
  const asUtc = Date.UTC(y, mo - 1, d, Number(parts.hour), Number(parts.minute), Number(parts.second));
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    y,
    mo,
    d,
    // tz offset at this instant, in ms (whole seconds; sub-second dropped)
    offset: asUtc - Math.floor(date.getTime() / 1000) * 1000,
  };
}

/** The instant `HH:MM` occurs on the wall-clock day of `wc`. */
function instantOf(wc, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return null;
  return Date.UTC(wc.y, wc.mo - 1, wc.d, Number(m[1]), Number(m[2])) - wc.offset;
}

/**
 * @param {object} opts
 * @param {{ enqueue: Function, store?: object }} opts.queue
 * @param {() => object} opts.getConfig
 * @param {() => Date} [opts.now]
 * @param {number} [opts.tickMs]
 * @param {object} [opts.store]  fire-once persistence; defaults to queue.store
 * @returns {{ stop(): void, tick(): void }}
 */
export function startScheduler({ queue, getConfig, now = () => new Date(), tickMs = 30000, store = queue.store }) {
  let prev = now().getTime() - tickMs;
  const memoryFired = new Set(); // used only when there is no store

  const claim = (key) => {
    if (store?.markFired) return store.markFired(key);
    if (memoryFired.has(key)) return false;
    memoryFired.add(key);
    return true;
  };

  function tick() {
    const cur = now().getTime();
    const from = prev;
    if (cur <= from) return; // clock went backwards or a duplicate tick: nothing new
    prev = cur;

    let config;
    try {
      config = getConfig();
    } catch (err) {
      console.warn(`scheduler: config unavailable: ${err.message}`);
      return;
    }
    const tz = config.timezone || 'UTC';
    // The window may straddle midnight, so check the times on both days.
    const days = [wallClock(new Date(from), tz), wallClock(new Date(cur), tz)];
    if (days[0].day === days[1].day) days.pop();

    for (const schedule of config.schedules ?? []) {
      if (schedule.enabled === false) continue;
      for (const time of schedule.times ?? []) {
        for (const wc of days) {
          const at = instantOf(wc, time);
          if (at == null || !(at > from && at <= cur)) continue;
          if (!claim(`${schedule.name}|${wc.day}|${time}`)) continue;
          try {
            queue.enqueue({ items: config.basket, sites: schedule.sites, trigger: 'schedule' });
          } catch (err) {
            console.warn(`scheduler: could not enqueue ${schedule.name} ${time}: ${err.message}`);
          }
        }
      }
    }
  }

  tick();
  const timer = setInterval(tick, tickMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
    tick,
  };
}
