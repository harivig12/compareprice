/**
 * AI step of the payment advisor: turn each payment offer's own words into a
 * fixed rule, once per offer. After that, the saving is plain arithmetic
 * (src/payments.js). Only offer text goes to the provider: never a basket,
 * a price, a payment method of yours, an account or a location.
 *
 * Rules are kept in the store's meta table under `offer_rule:<hash of the text>`,
 * so a changed offer is read again and an unchanged one never is.
 */
import { readAiSettings, readKey } from './settings.js';
import { call, headers } from './label.js';
import { cleanRule, offerKey, INSTRUMENTS } from '../payments.js';

export const RULES_PROMPT = `You read Indian quick-commerce payment offers and turn each into one fixed rule. For each numbered offer give:
kind: "percent" (a percentage off) or "flat" (a fixed rupee amount off or back). If the offer is tiered, use its first, simplest tier.
value: the percent, or the rupees.
cap: the most rupees it can save, or null.
minOrder: the smallest order in rupees, or null.
methods: the payment methods it needs: a list of {issuer, instrument}. instrument is one of credit, debit, upi, wallet, netbanking, any. issuer is the lower-case bank or app name ("hdfc", "bhim", "jupiter") or null for any.
conditions: up to 3 short phrases for things only the shop can check ("first order", "once per user", "new users only"), or an empty list.
If the offer has no clear saving, give kind null.
Reply with JSON only: {"items":[{"i":<number>,"kind":"percent|flat|null","value":<number>,"cap":<number|null>,"minOrder":<number|null>,"methods":[{"issuer":"<text|null>","instrument":"<instrument>"}],"conditions":["..."]}]}`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['i', 'kind', 'value', 'cap', 'minOrder', 'methods', 'conditions'],
    properties: {
      i: { type: 'integer' },
      kind: { type: ['string', 'null'], enum: ['percent', 'flat', null] },
      value: { type: ['number', 'null'] },
      cap: { type: ['number', 'null'] },
      minOrder: { type: ['number', 'null'] },
      methods: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['issuer', 'instrument'], properties: { issuer: { type: ['string', 'null'] }, instrument: { type: 'string', enum: INSTRUMENTS } } } },
      conditions: { type: 'array', items: { type: 'string' } },
    },
  } } },
};

const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The text of one offer as sent: title, short description and the first terms. */
export const offerText = (o) => [oneLine(o.title, 160), o.description ? `(${oneLine(o.description, 160)})` : '', ...(o.terms ?? []).slice(0, 1).map((t) => `Terms: ${oneLine(t, 700)}`)].filter(Boolean).join(' ');

export function buildRulesRequest(offers, model, mode = 'schema') {
  return {
    model,
    temperature: 0,
    ...(mode === 'schema'
      ? { response_format: { type: 'json_schema', json_schema: { name: 'offer_rules', strict: true, schema: SCHEMA } }, reasoning_effort: 'low' }
      : { response_format: { type: 'json_object' } }),
    messages: [
      { role: 'system', content: RULES_PROMPT },
      { role: 'user', content: offers.map((o, i) => `${i}. ${offerText(o)}`).join('\n') },
    ],
  };
}

/** Cleaned rules by offer index; an unreadable or saving-less offer is `false`, a missing one null. */
export function parseRulesReply(json, n) {
  const out = Array(n).fill(null);
  let content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return out;
  content = content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
  let data;
  try { data = JSON.parse(content); } catch { return out; }
  for (const it of Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []) {
    const i = Number(it?.i);
    if (!Number.isInteger(i) || i < 0 || i >= n) continue;
    out[i] = cleanRule(it) ?? false;
  }
  return out;
}

async function readBatch({ offers, settings, key, fetchImpl, signal }) {
  const send = (mode) => call(`${settings.baseUrl}/chat/completions`, { method: 'POST', headers: headers(key), body: JSON.stringify(buildRulesRequest(offers, settings.model, mode)), signal }, fetchImpl);
  let json;
  try {
    json = await send('schema');
  } catch (err) {
    if (!/HTTP 400/.test(err.message) || /json_validate_failed/.test(err.message)) throw err;
    json = await send('json');
  }
  return parseRulesReply(json, offers.length);
}

const META = 'offer_rule:';
/** The saved rule for an offer: an object, `false` (read, no usable saving) or null (not read yet). */
export function savedRule(store, site, offer) {
  const raw = store.getMeta(META + offerKey(site, offer));
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** The payment lists with each offer's rule attached (null = not read yet, false = nothing usable). */
export function withRules(store, offerLists) {
  return (offerLists ?? []).filter((l) => l.kind === 'payment').map((l) => ({ site: l.site, checkedAt: l.checkedAt, offers: l.offers.map((o) => ({ ...o, rule: savedRule(store, l.site, o) || null, read: savedRule(store, l.site, o) !== null })) }));
}

const dayOf = (d, timeZone) => d.toLocaleDateString('sv-SE', { timeZone });

/**
 * The `offer-rules` queue job: read every payment offer that has no saved rule.
 * Counts against the same per-day call cap as the AI labels.
 */
export async function runOfferRules({ store, dataDir, fetchImpl = fetch, now = () => new Date(), log = () => {}, signal, timeZone = 'Asia/Kolkata', batchSize = 15 } = {}) {
  const done = (extra) => ({ kind: 'ai-labels', sub: 'offer-rules', generatedAt: now().toISOString(), read: 0, calls: 0, ...extra });
  const settings = readAiSettings(dataDir);
  if (!settings.readOffers) return done({ skipped: 'Reading offers is off (ai.md: read offers: no)' });
  const key = readKey(dataDir);
  if (!key) return done({ skipped: 'No API key saved yet (Settings → AI)' });
  const todo = [];
  for (const l of store.currentDeals().offerLists) {
    if (l.kind !== 'payment') continue;
    for (const o of l.offers) if (savedRule(store, l.site, o) === null) todo.push({ site: l.site, offer: o });
  }
  const metaKey = `ai_calls:${dayOf(now(), timeZone)}`;
  let used = Number(store.getMeta(metaKey) ?? 0);
  let calls = 0;
  let read = 0;
  for (let at = 0; at < todo.length && used < settings.maxCallsPerDay; at += batchSize) {
    const batch = todo.slice(at, at + batchSize);
    let rules;
    try {
      rules = await readBatch({ offers: batch.map((b) => b.offer), settings, key, fetchImpl, signal });
    } catch (err) {
      return done({ read, calls, error: err.message });
    } finally {
      calls++;
      used++;
      store.setMeta(metaKey, used);
    }
    batch.forEach((b, i) => {
      if (rules[i] === null) return; // the provider skipped it: tried again next time
      store.setMeta(META + offerKey(b.site, b.offer), JSON.stringify(rules[i]));
      read++;
    });
    log(`offer-rules: ${read}/${todo.length} read (call ${used}/${settings.maxCallsPerDay} today)`);
  }
  return done({ read, calls, ...(read < todo.length && used >= settings.maxCallsPerDay ? { skipped: 'daily cap reached; the rest waits for tomorrow' } : {}) });
}
