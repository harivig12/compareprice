/**
 * Platform fees.
 *
 * THERE ARE NO FEE NUMBERS IN THIS FILE, ON PURPOSE.
 *
 * Delivery and handling charges are only exposed at cart/checkout — the search
 * and listing pages this tool reads carry nothing usable (Blinkit's search
 * state has `chargeableDeliveryCost: 0` and `additional_charges_config: null`,
 * because no cart exists yet). Reading them would mean adding items to a real
 * cart, which v1 deliberately does not do.
 *
 * So fees are *unknown* unless the user supplies them. An earlier version
 * shipped invented numbers flagged `verified: false`; they looked authoritative
 * in the output and were not. Goods-only totals that say so beat confident
 * totals built on fiction.
 *
 * Users provide real values via `basket fees --set`, stored in
 * ~/.basket/fees.json:
 *
 *   {
 *     "blinkit":   { "deliveryFee": 25, "handlingFee": 9, "freeDeliveryAbove": 199 },
 *     "bigbasket": { "deliveryFee": 30, "handlingFee": 0, "freeDeliveryAbove": 399 }
 *   }
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { DATA_DIR, ensureDataDir } from './paths.js';

export const FEES_FILE = join(DATA_DIR, 'fees.json');

/** Display names. Not fee data — just how each platform is spelled. */
export const LABELS = {
  blinkit: 'Blinkit',
  zepto: 'Zepto',
  bigbasket: 'BigBasket',
  amazon: 'Amazon Tez / Now',
  instamart: 'Instamart',
  jiomart: 'JioMart',
  milkbasket: 'Milkbasket',
  flipkart_minutes: 'Flipkart Minutes',
  kpn: 'KPN Fresh',
};

/** Back-compat: callers used FEES[p].label. Keep that working, carry no numbers. */
export const FEES = Object.fromEntries(
  Object.entries(LABELS).map(([k, label]) => [k, { label }]),
);

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** Read the user's fee config. Returns {} when absent or unreadable. */
export function loadFees() {
  if (!existsSync(FEES_FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(FEES_FILE, 'utf8'));
    const out = {};
    for (const [platform, cfg] of Object.entries(raw)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const entry = {};
      if (isFiniteNumber(cfg.deliveryFee)) entry.deliveryFee = cfg.deliveryFee;
      if (isFiniteNumber(cfg.handlingFee)) entry.handlingFee = cfg.handlingFee;
      if (isFiniteNumber(cfg.freeDeliveryAbove)) entry.freeDeliveryAbove = cfg.freeDeliveryAbove;
      if (typeof cfg.updatedAt === 'string') entry.updatedAt = cfg.updatedAt;
      // A platform needs at least one charge to be worth applying.
      if (entry.deliveryFee != null || entry.handlingFee != null) out[platform] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

/** Merge one platform's fees into the config file. */
export function saveFees(platform, { deliveryFee, handlingFee, freeDeliveryAbove }) {
  ensureDataDir();
  const all = existsSync(FEES_FILE)
    ? (() => { try { return JSON.parse(readFileSync(FEES_FILE, 'utf8')); } catch { return {}; } })()
    : {};

  const entry = { ...(all[platform] || {}) };
  if (deliveryFee != null) entry.deliveryFee = Number(deliveryFee);
  if (handlingFee != null) entry.handlingFee = Number(handlingFee);
  if (freeDeliveryAbove != null) entry.freeDeliveryAbove = Number(freeDeliveryAbove);
  entry.updatedAt = new Date().toISOString().slice(0, 10);

  all[platform] = entry;
  writeFileSync(FEES_FILE, JSON.stringify(all, null, 2), 'utf8');
  return entry;
}

export function clearFees(platform) {
  if (!existsSync(FEES_FILE)) return false;
  let all;
  try { all = JSON.parse(readFileSync(FEES_FILE, 'utf8')); } catch { return false; }
  if (platform) {
    if (!(platform in all)) return false;
    delete all[platform];
  } else {
    all = {};
  }
  writeFileSync(FEES_FILE, JSON.stringify(all, null, 2), 'utf8');
  return true;
}

/**
 * Fees for one platform at a given goods subtotal.
 *
 * `known: false` means the user has not supplied fees for this platform. The
 * caller must then present a goods-only total and say so — never silently
 * treat missing fees as zero fees.
 *
 * @param {string} platform
 * @param {number} subtotal
 * @param {object} [config] pre-loaded fee config, to avoid re-reading per line
 */
export function feesFor(platform, subtotal, config) {
  const all = config ?? loadFees();
  const f = all[platform];

  if (!f) {
    return {
      known: false,
      deliveryFee: 0,
      handlingFee: 0,
      freeDeliveryApplied: false,
      freeDeliveryAbove: null,
      total: 0,
      updatedAt: null,
    };
  }

  const delivery = f.deliveryFee ?? 0;
  const handling = f.handlingFee ?? 0;
  const threshold = f.freeDeliveryAbove ?? null;
  const freeDeliveryApplied = threshold != null && subtotal >= threshold;
  const deliveryFee = freeDeliveryApplied ? 0 : delivery;

  return {
    known: true,
    deliveryFee,
    handlingFee: handling,
    freeDeliveryApplied,
    freeDeliveryAbove: threshold,
    total: deliveryFee + handling,
    updatedAt: f.updatedAt ?? null,
  };
}

/** True when every platform in play has user-supplied fees. */
export function allFeesKnown(platforms, config) {
  const all = config ?? loadFees();
  return platforms.length > 0 && platforms.every((p) => Boolean(all[p]));
}
