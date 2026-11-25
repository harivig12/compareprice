/**
 * "Best payment offer for your basket" (user decision 2026-11-25).
 *
 * Pure arithmetic, no network and no AI: the AI only turns an offer's terms
 * into a fixed rule once (src/ai/offer-rules.js); this file applies a rule to
 * a site's goods total. Nothing here changes a total or the ranking: the
 * result is a separate line ("after offer"), and a condition that can't be
 * checked from here (first order, once per user) is carried as "if eligible".
 *
 * A rule: { kind: 'percent'|'flat', value, cap?, minOrder?, methods: [{ issuer, instrument }], conditions: string[] }
 *   instrument: credit | debit | upi | wallet | netbanking | any
 *   issuer: a lower-case bank/app word ("hdfc", "bhim", "jupiter"), or null for any.
 */
import { createHash } from 'node:crypto';

export const INSTRUMENTS = ['credit', 'debit', 'upi', 'wallet', 'netbanking', 'any'];

const INSTRUMENT_WORDS = [
  ['credit', /\bcredit\b/],
  ['debit', /\bdebit\b/],
  ['netbanking', /\b(net\s?banking|internet banking)\b/],
  ['upi', /\bupi\b/],
  ['wallet', /\b(wallet|pay later|paylater)\b/],
];
const FILLER = /\b(credit|debit|cards?|upi|wallet|net\s?banking|internet banking|bank|app|pay later|paylater|the|my)\b/g;

/** What a person typed ("HDFC Credit Card", "UPI (GPay)") as { text, issuer, instrument }. */
export function describeMethod(text) {
  const t = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const instrument = INSTRUMENT_WORDS.find(([, re]) => re.test(t))?.[0] ?? 'any';
  const issuer = t.replace(/[()]/g, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim() || null;
  return { text: String(text ?? '').trim(), issuer, instrument };
}

const words = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Does a method the person has satisfy one the offer asks for? */
export function methodFits(mine, wanted) {
  if (!mine || !wanted) return false;
  const wi = wanted.instrument ?? 'any';
  if (wi !== 'any' && mine.instrument !== 'any' && wi !== mine.instrument) return false;
  // "UPI" alone, with no issuer, is any UPI app; an offer for a named UPI app needs that app.
  if (wi !== 'any' && mine.instrument === 'any' && !mine.issuer) return false;
  const want = words(wanted.issuer);
  if (!want.length) return true;
  const have = new Set(words(mine.issuer));
  return want.every((w) => have.has(w));
}

/** A stable id for an offer's text: the same words give the same rule. */
export const offerKey = (site, offer) => createHash('sha1')
  .update(JSON.stringify([site, offer.title ?? '', offer.description ?? '', offer.terms ?? [], offer.minOrder ?? null]))
  .digest('hex').slice(0, 20);

/** A rule from the AI, made safe: only the fields and ranges the arithmetic uses. */
export function cleanRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== null && v !== '' ? Number(v) : null);
  const kind = raw.kind === 'percent' || raw.kind === 'flat' ? raw.kind : null;
  const value = num(raw.value);
  if (!kind || value === null || value === 0) return null;
  if (kind === 'percent' && value > 100) return null;
  const methods = (Array.isArray(raw.methods) ? raw.methods : [])
    .map((m) => ({ issuer: m?.issuer ? String(m.issuer).toLowerCase().slice(0, 40) : null, instrument: INSTRUMENTS.includes(m?.instrument) ? m.instrument : 'any' }))
    .slice(0, 8);
  return {
    kind, value, cap: num(raw.cap), minOrder: num(raw.minOrder),
    methods: methods.length ? methods : [{ issuer: null, instrument: 'any' }],
    conditions: (Array.isArray(raw.conditions) ? raw.conditions : []).map((c) => String(c).replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, 3),
  };
}

/** Rupees a rule saves on a goods total, or 0 when the total is under its minimum. */
export function savingFor(rule, total) {
  if (!rule || !(total > 0)) return 0;
  if (rule.minOrder != null && total < rule.minOrder) return 0;
  const raw = rule.kind === 'percent' ? (total * rule.value) / 100 : rule.value;
  const capped = rule.cap != null ? Math.min(raw, rule.cap) : raw;
  return Math.max(0, Math.min(Math.round(capped), Math.round(total)));
}

/**
 * The best offer for one site's goods total among the person's methods.
 * @param {number} total
 * @param {{ title: string, code?: string|null, minOrder?: number|null, rule: object|null }[]} offers  a site's payment offers with their rule (null = terms not read)
 * @param {{ text: string, issuer: string|null, instrument: string }[]} methods
 * @returns {{ title, code, method, saving, after, conditions, minOrder } | null}
 */
export function bestOffer(total, offers, methods) {
  let best = null;
  for (const o of offers ?? []) {
    if (!o.rule) continue;
    const mine = (methods ?? []).find((m) => o.rule.methods.some((w) => methodFits(m, w)));
    if (!mine) continue;
    const saving = savingFor(o.rule, total);
    if (saving <= 0) continue;
    if (!best || saving > best.saving) {
      best = { title: o.title, code: o.code ?? null, method: mine.text, saving, after: Math.round(total) - saving, conditions: o.rule.conditions, minOrder: o.rule.minOrder ?? o.minOrder ?? null };
    }
  }
  return best;
}

/** Offers on a person's methods whose minimum a total reaches or not: the "works for your basket" mark. */
export function fitsMethods(rule, methods) {
  if (!rule) return null;
  const mine = (methods ?? []).find((m) => rule.methods.some((w) => methodFits(m, w)));
  return mine ? mine.text : null;
}

/** Methods as stored (an array of strings) to described methods; blanks and repeats dropped. */
export function cleanMethods(list) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const text = String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out.slice(0, 20);
}
