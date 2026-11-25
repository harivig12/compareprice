/**
 * User config: location, sites, schedule, default basket.
 *
 * Lives at DATA_DIR/config.json. Missing keys are filled from DEFAULT_CONFIG,
 * so an empty or partial file is always a usable config. The location is
 * config, never source.
 *
 * The default list is the one exception: it lives in DATA_DIR/basket.txt, so
 * it can be edited as a file (re-read on every load) as well as in Settings.
 * Until 2026-11-20 it was copied into config.json on the first Save, after
 * which edits to basket.txt silently did nothing. The first load moves it out
 * (the config.json copy is kept as basket.previous.txt; nothing is deleted).
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, PKG_ROOT } from './paths.js';

function defaultBasket() {
  try {
    return readFileSync(join(PKG_ROOT, 'basket.txt'), 'utf8');
  } catch {
    return '';
  }
}

export const DEFAULT_CONFIG = Object.freeze({
  location: {
    lat: 12.9161793,
    lng: 80.0975106,
    pincode: '600045',
    address:
      'Marutham Prestige, Bharathidasan Nagar, Krishna Nagar, Tambaram, Chennai, Tamil Nadu 600045, India',
    label: 'Marutham Prestige',
    // What sites' address pickers are searched with (Zepto, BigBasket).
    searchText: 'Marutham Prestige Tambaram',
  },
  phone: '',
  sites: ['instamart', 'bigbasket', 'zepto', 'blinkit', 'kpn', 'jiomart', 'flipkart_minutes'],
  basket: defaultBasket(),
  schedules: [
    {
      name: 'daily-check',
      sites: ['instamart', 'bigbasket', 'zepto', 'blinkit', 'kpn', 'jiomart', 'flipkart_minutes'],
      times: ['07:00', '09:00', '12:00'],
    },
  ],
  server: { host: '127.0.0.1', port: 7777 },
  timezone: 'Asia/Kolkata',
  browser: {
    // Close the headless Chrome after this long with no job or sign-in in
    // flight; the next job relaunches it. Idle Chrome measured ~1 GB and
    // 50–75% of a core (docs/diagnosis/2026-11-19-resource-use-and-otp-step.md).
    idleCloseMs: 5 * 60_000,
    // Skip images, media and fonts on search tabs (API calls don't need them).
    blockMedia: true,
  },
  // A product this far below MRP is a "deal": shown in its own section, never totalled.
  // The offer check (deal feeds) runs at these times, in `timezone`.
  // zeptoCart: Zepto's coupons and payment offers only exist while the cart has an item, so the
  // check puts one cheap item in the signed-in cart and takes it out again (an account that
  // already has items in its cart is only read). false = don't touch the cart at all.
  deals: { minDiscountPct: 80, times: ['07:00', '18:00'], zeptoCart: true },
  results: {
    // Per-run JSON files under results/ older than this are deleted; runs.jsonl stays.
    keepDays: 60,
  },
  // Per-site overrides of the request budget (see src/limits.js), e.g.
  // { "instamart": { "minGapMs": 4000, "perMinute": 10 } }. Empty = defaults.
  limits: {},
  // Catalogue sweep (src/sweep.js): every minGap–maxGap minutes, queue
  // minItems–maxItems catalogue products that have no saved price yet.
  // sites: [] means the sites above.
  sweep: {
    enabled: true,
    sites: [],
    minItems: 2,
    maxItems: 4,
    minGapMinutes: 5,
    maxGapMinutes: 20,
    staleHours: 24,
  },
});

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** Fill missing keys from `defaults`. Arrays and scalars in `value` win whole. */
function withDefaults(value, defaults) {
  if (!isPlainObject(defaults)) return value === undefined ? structuredClone(defaults) : value;
  const src = isPlainObject(value) ? value : {};
  const out = { ...src };
  for (const [key, def] of Object.entries(defaults)) {
    out[key] = withDefaults(src[key], def);
  }
  return out;
}

export function configFile(dir = DATA_DIR) {
  return join(dir, 'config.json');
}

export function basketFile(dir = DATA_DIR) {
  return join(dir, 'basket.txt');
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/**
 * The default list: DATA_DIR/basket.txt. Created on first use from the list
 * that config.json still holds (older installs), else from the bundled basket.txt.
 */
function readBasket(dir, stored) {
  try {
    return readFileSync(basketFile(dir), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const text = typeof stored.basket === 'string' ? stored.basket : DEFAULT_CONFIG.basket;
  try {
    mkdirSync(dir, { recursive: true });
    writeAtomic(basketFile(dir), text.endsWith('\n') || !text ? text : text + '\n');
  } catch (err) {
    console.warn(`config: could not create ${basketFile(dir)}: ${err.message}`);
  }
  return text;
}

/** @returns {typeof DEFAULT_CONFIG} */
export function loadConfig(dir = DATA_DIR) {
  let stored = {};
  try {
    stored = JSON.parse(readFileSync(configFile(dir), 'utf8'));
  } catch (err) {
    // Missing file is normal on first run. A corrupt one falls back to defaults
    // rather than taking the whole service down.
    if (err.code !== 'ENOENT') console.warn(`config: ignoring unreadable ${configFile(dir)}: ${err.message}`);
  }
  const basket = readBasket(dir, stored);
  if (typeof stored.basket === 'string') {
    // Older config.json carried the list: keep a copy, then drop it from the
    // config so basket.txt is the only place it lives.
    try {
      writeFileSync(join(dir, 'basket.previous.txt'), stored.basket, { flag: 'wx' });
    } catch { /* already kept */ }
    const { basket: _old, ...rest } = stored;
    try {
      writeAtomic(configFile(dir), JSON.stringify(rest, null, 2) + '\n');
    } catch (err) {
      console.warn(`config: could not move the list out of ${configFile(dir)}: ${err.message}`);
    }
  }
  return { ...withDefaults(stored, DEFAULT_CONFIG), basket };
}

export function saveConfig(cfg, dir = DATA_DIR) {
  mkdirSync(dir, { recursive: true });
  // Write-then-rename so a crash never leaves a half-written config.
  const { basket, ...rest } = withDefaults(cfg, DEFAULT_CONFIG);
  writeAtomic(configFile(dir), JSON.stringify(rest, null, 2) + '\n');
  if (typeof basket === 'string') writeAtomic(basketFile(dir), basket.endsWith('\n') || !basket ? basket : basket + '\n');
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validate a full config (after defaults are filled).
 * @param {object} cfg
 * @param {string[]} knownSites
 * @returns {{ field: string, error: string } | null}
 */
export function validateConfig(cfg, knownSites) {
  const bad = (field, error) => ({ field, error });
  const loc = cfg.location ?? {};
  if (!Number.isFinite(Number(loc.lat)) || Math.abs(Number(loc.lat)) > 90) return bad('location.lat', 'latitude must be a number between -90 and 90');
  if (!Number.isFinite(Number(loc.lng)) || Math.abs(Number(loc.lng)) > 180) return bad('location.lng', 'longitude must be a number between -180 and 180');
  if (loc.pincode != null && !/^\d{6}$/.test(String(loc.pincode))) return bad('location.pincode', 'pincode must be 6 digits');
  if (cfg.phone && !/^\+?\d{10,13}$/.test(String(cfg.phone).replace(/[\s-]/g, ''))) return bad('phone', 'phone must be 10–13 digits');
  if (!Array.isArray(cfg.sites) || cfg.sites.length === 0) return bad('sites', 'pick at least one site');
  const unknownSite = cfg.sites.find((s) => !knownSites.includes(s));
  if (unknownSite) return bad('sites', `unknown site "${unknownSite}"`);
  if (typeof cfg.basket !== 'string') return bad('basket', 'basket must be text, one item per line');
  if (!Array.isArray(cfg.schedules)) return bad('schedules', 'schedules must be a list');
  for (const [i, s] of cfg.schedules.entries()) {
    if (!s || typeof s.name !== 'string' || !s.name.trim()) return bad(`schedules[${i}].name`, 'each schedule needs a name');
    if (!Array.isArray(s.sites) || s.sites.length === 0) return bad(`schedules[${i}].sites`, 'each schedule needs at least one site');
    const u = s.sites.find((x) => !knownSites.includes(x));
    if (u) return bad(`schedules[${i}].sites`, `unknown site "${u}"`);
    if (!Array.isArray(s.times) || s.times.length === 0) return bad(`schedules[${i}].times`, 'each schedule needs at least one time');
    const t = s.times.find((x) => !HHMM.test(String(x)));
    if (t != null) return bad(`schedules[${i}].times`, `"${t}" is not a 24-hour HH:MM time`);
  }
  if (cfg.browser && !(Number(cfg.browser.idleCloseMs) >= 0)) return bad('browser.idleCloseMs', 'idle close time must be 0 (never) or more milliseconds');
  if (cfg.results && !(Number(cfg.results.keepDays) >= 1)) return bad('results.keepDays', 'keep results for at least 1 day');
  if (cfg.deals) {
    const pct = Number(cfg.deals.minDiscountPct);
    if (!(pct >= 50 && pct <= 99)) return bad('deals.minDiscountPct', 'a deal is 50 to 99 percent off MRP');
    if (cfg.deals.zeptoCart != null && typeof cfg.deals.zeptoCart !== 'boolean') return bad('deals.zeptoCart', 'must be true or false');
    if (cfg.deals.times != null) {
      if (!Array.isArray(cfg.deals.times)) return bad('deals.times', 'deal check times must be a list');
      const t = cfg.deals.times.find((x) => !HHMM.test(String(x)));
      if (t != null) return bad('deals.times', `"${t}" is not a 24-hour HH:MM time`);
    }
  }
  const names = cfg.schedules.map((s) => s.name.trim());
  if (new Set(names).size !== names.length) return bad('schedules', 'schedule names must be unique');
  const sw = cfg.sweep ?? {};
  if (sw.sites != null && !Array.isArray(sw.sites)) return bad('sweep.sites', 'sweep sites must be a list');
  const swUnknown = (sw.sites ?? []).find((x) => !knownSites.includes(x));
  if (swUnknown) return bad('sweep.sites', `unknown site "${swUnknown}"`);
  for (const k of ['minItems', 'maxItems', 'minGapMinutes', 'maxGapMinutes', 'staleHours']) {
    if (sw[k] != null && !(Number(sw[k]) > 0)) return bad(`sweep.${k}`, `${k} must be a positive number`);
  }
  if (Number(sw.minItems) > Number(sw.maxItems)) return bad('sweep.maxItems', 'maxItems must be at least minItems');
  if (Number(sw.minGapMinutes) > Number(sw.maxGapMinutes)) return bad('sweep.maxGapMinutes', 'maxGapMinutes must be at least minGapMinutes');
  try {
    new Intl.DateTimeFormat('en', { timeZone: cfg.timezone });
  } catch {
    return bad('timezone', `unknown timezone "${cfg.timezone}"`);
  }
  return null;
}

/** Fill defaults into a partial config (used by PUT /api/config). */
export function completeConfig(partial) {
  return withDefaults(partial ?? {}, DEFAULT_CONFIG);
}
