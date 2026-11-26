/**
 * Scheduled adds (user decisions 2026-11-25 / 26): at a set time, put a listed product into a
 * signed-in account's next basket, then stop. Milkbasket only for now.
 *
 *   - The list is separate from the compare list. Each account has its own entries.
 *   - An entry: a product picked once (its id is stored), a quantity, weekdays (or one date), a time.
 *   - "Run at the time, else leave it": a time is acted on only by the tick that sees it pass.
 *     A time missed while the service was down is not run late.
 *   - Hard limits on every run: max quantity per item, max ₹ added per day (all accounts), only
 *     listed items, a master switch (OFF until the user turns it on), and an on/off per account
 *     and per entry. Every run is written to the log, including skips.
 *   - The add only makes sure the basket holds at least the quantity (src/engine/sites/milkbasket.js
 *     ensureInBasket): a re-run never doubles it, and nothing goes past the basket.
 *
 * Kept in <data>/scheduled-adds.json (no session data: product ids, names, times, the log).
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { wallClock, instantOf } from './scheduler.js';

export const ADD_SITES = ['milkbasket'];
export const DEFAULT_LIMITS = Object.freeze({ maxQty: 5, maxPerDay: 300 });
const LIMIT_RANGE = { maxQty: [1, 20], maxPerDay: [10, 5000] };
const LOG_KEEP = 200;
const DAYS = 7;

export const addsFile = (dataDir) => join(dataDir, 'scheduled-adds.json');

const empty = () => ({ enabled: false, limits: { ...DEFAULT_LIMITS }, accounts: {}, log: [] });

/** The saved state, made safe (unknown fields dropped). Never throws on a missing or broken file. */
export function readAdds(dataDir) {
  let raw;
  try { raw = JSON.parse(readFileSync(addsFile(dataDir), 'utf8')); } catch { return empty(); }
  const s = empty();
  s.enabled = raw?.enabled === true;
  s.limits = cleanLimits(raw?.limits);
  for (const [key, acc] of Object.entries(raw?.accounts ?? {})) {
    const [site] = key.split(':');
    if (!ADD_SITES.includes(site)) continue;
    s.accounts[key] = { enabled: acc?.enabled !== false, entries: (acc?.entries ?? []).map((e) => { try { return cleanEntry(e, s.limits); } catch { return null; } }).filter(Boolean) };
  }
  s.log = Array.isArray(raw?.log) ? raw.log.slice(-LOG_KEEP) : [];
  return s;
}

export function writeAdds(dataDir, state) {
  const file = addsFile(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, log: state.log.slice(-LOG_KEEP) }, null, 2) + '\n');
  renameSync(tmp, file);
  return state;
}

export function cleanLimits(l) {
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(LIMIT_RANGE)) {
    const n = Math.round(Number(l?.[k]));
    if (Number.isFinite(n)) out[k] = Math.min(LIMIT_RANGE[k][1], Math.max(LIMIT_RANGE[k][0], n));
  }
  return out;
}

const bad = (msg, field) => Object.assign(new Error(msg), { field, status: 400 });

/** An entry as typed or stored, checked; throws an Error with `field` when it can't be used. */
export function cleanEntry(e, limits = DEFAULT_LIMITS) {
  const productId = Number(e?.productId);
  if (!Number.isInteger(productId) || productId <= 0) throw bad('Pick the product from the search results first', 'productId');
  const name = String(e?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw bad('The product name is missing', 'name');
  const qty = Math.floor(Number(e?.qty));
  if (!(qty >= 1)) throw bad('Quantity must be 1 or more', 'qty');
  if (qty > limits.maxQty) throw bad(`Quantity is above the limit of ${limits.maxQty} per item`, 'qty');
  if (e?.maxQty && qty > Number(e.maxQty)) throw bad(`Milkbasket allows at most ${e.maxQty} of this product`, 'qty');
  const time = String(e?.time ?? '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad('Time must be HH:MM (24 h), e.g. 05:30', 'time');
  const once = e?.once ? String(e.once).trim() : null;
  if (once && !/^\d{4}-\d{2}-\d{2}$/.test(once)) throw bad('The date must be YYYY-MM-DD', 'once');
  const days = once ? [] : [...new Set((Array.isArray(e?.days) ? e.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d < DAYS))].sort();
  if (!once && !days.length) throw bad('Pick at least one day, or a date to run once', 'days');
  const price = Number(e?.price);
  return {
    id: typeof e?.id === 'string' && /^[\w-]{6,40}$/.test(e.id) ? e.id : randomUUID(),
    productId, name, qty, time, days, once,
    price: price > 0 ? Math.round(price * 100) / 100 : null,
    ...(e?.maxQty ? { maxQty: Number(e.maxQty) } : {}),
    enabled: e?.enabled !== false,
    pickedAt: e?.pickedAt ?? new Date().toISOString(),
  };
}

export const accountKey = (site, account) => `${site}:${account}`;

/** Weekday (0 = Sunday) of a wall-clock day. */
const weekday = (wc) => new Date(Date.UTC(wc.y, wc.mo - 1, wc.d)).getUTCDay();

/**
 * Entries whose time falls in (from, to]: [{ key, entry, day }]. Only switched-on
 * accounts and entries; nothing at all while the master switch is off.
 */
export function dueBetween(state, from, to, timeZone) {
  if (!state.enabled || !(to > from)) return [];
  const days = [wallClock(new Date(from), timeZone), wallClock(new Date(to), timeZone)];
  if (days[0].day === days[1].day) days.pop();
  const out = [];
  for (const [key, acc] of Object.entries(state.accounts)) {
    if (!acc.enabled) continue;
    for (const entry of acc.entries) {
      if (!entry.enabled) continue;
      for (const wc of days) {
        if (entry.once ? entry.once !== wc.day : !entry.days.includes(weekday(wc))) continue;
        const at = instantOf(wc, entry.time);
        if (at != null && at > from && at <= to) out.push({ key, entry, day: wc.day });
      }
    }
  }
  return out;
}

/** ₹ added today (all accounts), from the log. */
export function spentOn(state, day) {
  return state.log.filter((l) => l.day === day && l.status === 'added').reduce((a, l) => a + (Number(l.spent) || 0), 0);
}

/**
 * One account's due entries, one after another. `ensure` is the site's ensureInBasket bound to
 * that account's tab; nothing here talks to a site directly.
 * @returns {Promise<object[]>} the log lines written
 */
export async function runAdds({ state, key, entryIds, day, ensure, now = () => new Date(), log = () => {} }) {
  const acc = state.accounts[key];
  const lines = [];
  const write = (entry, rest) => {
    const line = { at: now().toISOString(), day, key, entryId: entry?.id ?? null, name: entry?.name ?? null, qty: entry?.qty ?? null, ...rest };
    state.log.push(line);
    lines.push(line);
    log(`scheduled-add ${key} ${entry?.name ?? ''}: ${rest.status}${rest.reason ? ` (${rest.reason})` : ''}`);
  };
  for (const id of entryIds) {
    // Re-checked at run time: a switch turned off, or an entry removed, after it was queued.
    const entry = acc?.entries.find((e) => e.id === id);
    if (!state.enabled) { write(entry, { status: 'skipped', reason: 'scheduled adds are switched off' }); continue; }
    if (!acc?.enabled) { write(entry, { status: 'skipped', reason: 'this account is switched off' }); continue; }
    if (!entry) continue;
    if (!entry.enabled) { write(entry, { status: 'skipped', reason: 'this entry is switched off' }); continue; }
    if (entry.qty > state.limits.maxQty) { write(entry, { status: 'skipped', reason: `quantity above the limit of ${state.limits.maxQty}` }); continue; }
    const cost = (entry.price ?? 0) * entry.qty;
    const spent = spentOn(state, day);
    if (!entry.price) { write(entry, { status: 'skipped', reason: 'no known price, so the daily limit cannot be checked; pick the product again' }); continue; }
    if (spent + cost > state.limits.maxPerDay) { write(entry, { status: 'skipped', reason: `would pass the ₹${state.limits.maxPerDay} daily limit (₹${Math.round(spent)} added today)` }); continue; }
    try {
      const r = await ensure({ productId: entry.productId, qty: entry.qty, price: entry.price });
      if (r.status === 'added') write(entry, { status: 'added', had: r.had, now: r.now, spent: Math.round((entry.price ?? 0) * r.added * 100) / 100 });
      else if (r.status === 'already') write(entry, { status: 'already', had: r.had, reason: `already ${r.had} in the basket` });
      else write(entry, { status: 'skipped', reason: r.reason, code: r.code });
    } catch (err) {
      // A session or site failure: nothing was added. Said plainly; not retried later.
      write(entry, { status: 'failed', reason: String(err?.message ?? err).slice(0, 200), kind: err?.kind ?? null });
      if (err?.kind === 'session') {
        for (const rest of entryIds.slice(entryIds.indexOf(id) + 1)) {
          const e2 = acc.entries.find((e) => e.id === rest);
          if (e2) write(e2, { status: 'failed', reason: 'signed out; sign in again. Nothing was added', kind: 'session' });
        }
        break;
      }
    }
    // A run "once" is done after its day, whatever happened.
    if (entry.once) entry.enabled = false;
  }
  return lines;
}

/**
 * The ticker: each tick queues one `scheduled-add` job per account that has entries due since the
 * previous tick. Fire-once keys (store.markFired) stop a restart from running a time twice.
 */
export function startAddSchedule({ queue, dataDir, getConfig, store = queue.store, now = () => new Date(), tickMs = 30_000, log = () => {} }) {
  let prev = now().getTime() - tickMs;
  const memory = new Set();
  const claim = (k) => {
    if (store?.markFired) return store.markFired(k);
    if (memory.has(k)) return false;
    memory.add(k);
    return true;
  };
  function tick() {
    const cur = now().getTime();
    const from = prev;
    if (cur <= from) return;
    prev = cur;
    let state;
    try { state = readAdds(dataDir); } catch (err) { log(`scheduled-add: could not read the list: ${err.message}`); return; }
    const tz = getConfig().timezone || 'UTC';
    const byAccount = new Map();
    for (const d of dueBetween(state, from, cur, tz)) {
      if (!claim(`add|${d.key}|${d.entry.id}|${d.day}|${d.entry.time}`)) continue;
      const k = `${d.key}|${d.day}`;
      byAccount.set(k, { key: d.key, day: d.day, ids: [...(byAccount.get(k)?.ids ?? []), d.entry.id] });
    }
    for (const job of byAccount.values()) {
      const id = queue.enqueue({ items: '', sites: [job.key.split(':')[0]], trigger: 'scheduled-add', data: job });
      log(`scheduled-add: job ${id} queued for ${job.key} (${job.ids.length} item${job.ids.length > 1 ? 's' : ''})`);
    }
  }
  tick();
  const timer = setInterval(tick, tickMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
