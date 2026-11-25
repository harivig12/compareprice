/**
 * AI "same product?" check for borderline matches (user decision 2026-11-25).
 *
 * After a basket run, the matches that are weak (low confidence, bigger pack) or
 * borderline AND could win their item are put to the AI as plain pairs of titles:
 * what you asked for, and the product a site matched to it. Nothing else is sent
 * (no price, site, account, location or basket).
 *
 * The AI only demotes. A "no" is saved as a verdict; the matcher then treats that
 * product as a weak match (never counted while a better candidate exists) and the
 * page flags it. It is never hidden or deleted: ✓ "keep" on the page overrides the
 * AI for good, ✕ rejects it as before.
 */
import { readAiSettings, readKey } from './settings.js';
import { call, headers } from './label.js';
import { normalizeQuery } from '../store.js';

/** Below this a counted match is "borderline" (the matcher's cut-off is 0.55). */
export const BORDERLINE_BELOW = 0.8;
/** At most this many pairs per run: a run is a handful of calls, not a crawl. */
export const MAX_PAIRS_PER_RUN = 60;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const matchKey = (query, site, product) => `same:${normalizeQuery(query)}|${site}|${clean(product)}`;

/** The saved verdict { v: 'same'|'no'|'unsure', by?: 'user' } or null. */
export function verdictFor(store, query, site, product) {
  const raw = store.getMeta?.(matchKey(query, site, product));
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Product names the AI doubts for this item on this site (and the user did not keep). */
export function doubtedNames(store, query, site, names) {
  const out = new Set();
  for (const n of names) if (verdictFor(store, query, site, n)?.v === 'no') out.add(clean(n));
  return out;
}

/**
 * Which matches of a finished comparison are worth asking about.
 * @returns {{ query: string, site: string, product: string }[]}
 */
export function pickCandidates(result, store, { max = MAX_PAIRS_PER_RUN } = {}) {
  const out = [];
  const seen = new Set();
  const platforms = (result?.platforms ?? []).filter((p) => !p.failed && !p.others);
  for (const item of result?.basket ?? []) {
    const lines = platforms.map((p) => ({ site: p.platform, l: (p.lines ?? []).find((x) => x.query === item.query) })).filter((x) => x.l?.product?.name);
    const counted = lines.filter((x) => x.l.lineTotal != null && x.l.status === 'ok').sort((a, b) => a.l.lineTotal - b.l.lineTotal);
    const couldWin = new Set(counted.slice(0, 2).map((x) => x.site));
    for (const { site, l } of lines) {
      const weak = l.status === 'low-confidence' || l.status === 'bigger-pack';
      const borderline = l.status === 'ok' && (l.product.confidence ?? 1) < BORDERLINE_BELOW && couldWin.has(site);
      if (!weak && !borderline) continue;
      const key = matchKey(item.query, site, l.product.name);
      if (seen.has(key) || store.getMeta?.(key) != null) continue;
      seen.add(key);
      out.push({ query: item.query, site, product: clean(l.product.name) });
      if (out.length >= max) return out;
    }
  }
  return out;
}

export const JUDGE_PROMPT = `You check grocery matches. Each numbered line gives WANTED (what a shopper typed) and FOUND (a product title from a shop).
Answer "yes" if FOUND is what the shopper wants to buy. Other brands and other pack sizes are fine unless WANTED names a brand or a size. Answer "no" if FOUND is a different product (another item, variety, flavour or kind, or something that only contains the item). Answer "unsure" if you cannot tell from the words.
Reply with JSON only: {"items":[{"i":<number>,"v":"yes|no|unsure"}]}`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['i', 'v'], properties: { i: { type: 'integer' }, v: { type: 'string', enum: ['yes', 'no', 'unsure'] } } } } },
};

export function buildJudgeRequest(pairs, model, mode = 'schema') {
  return {
    model,
    temperature: 0,
    ...(mode === 'schema'
      ? { response_format: { type: 'json_schema', json_schema: { name: 'same_product', strict: true, schema: SCHEMA } }, reasoning_effort: 'low' }
      : { response_format: { type: 'json_object' } }),
    messages: [
      { role: 'system', content: JUDGE_PROMPT },
      { role: 'user', content: pairs.map((p, i) => `${i}. WANTED: ${clean(p.query)} | FOUND: ${clean(p.product)}`).join('\n') },
    ],
  };
}

/** "yes" | "no" | "unsure" by pair index; anything missing is null. */
export function parseJudgeReply(json, n) {
  const out = Array(n).fill(null);
  let content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return out;
  content = content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
  let data;
  try { data = JSON.parse(content); } catch { return out; }
  for (const it of Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []) {
    const i = Number(it?.i);
    const v = String(it?.v ?? '').toLowerCase();
    if (Number.isInteger(i) && i >= 0 && i < n && ['yes', 'no', 'unsure'].includes(v)) out[i] = v;
  }
  return out;
}

async function judgeBatch({ pairs, settings, key, fetchImpl, signal }) {
  const send = (mode) => call(`${settings.baseUrl}/chat/completions`, { method: 'POST', headers: headers(key), body: JSON.stringify(buildJudgeRequest(pairs, settings.model, mode)), signal }, fetchImpl);
  let json;
  try {
    json = await send('schema');
  } catch (err) {
    if (!/HTTP 400/.test(err.message) || /json_validate_failed/.test(err.message)) throw err;
    json = await send('json');
  }
  return parseJudgeReply(json, pairs.length);
}

const dayOf = (d, timeZone) => d.toLocaleDateString('sv-SE', { timeZone });

/** The `same-product` queue job: judge the borderline matches of the latest comparison. Counts against the daily AI call cap. */
export async function runSameProduct({ store, dataDir, result, fetchImpl = fetch, now = () => new Date(), log = () => {}, signal, timeZone = 'Asia/Kolkata' } = {}) {
  const done = (extra) => ({ kind: 'ai-labels', sub: 'same-product', generatedAt: now().toISOString(), asked: 0, flagged: 0, calls: 0, ...extra });
  const settings = readAiSettings(dataDir);
  if (!settings.checkMatches) return done({ skipped: 'Match checks are off (ai.md: check matches: no)' });
  const key = readKey(dataDir);
  if (!key) return done({ skipped: 'No API key saved yet (Settings → AI)' });
  const todo = pickCandidates(result, store);
  if (!todo.length) return done({ skipped: 'Nothing borderline to check' });
  const metaKey = `ai_calls:${dayOf(now(), timeZone)}`;
  let used = Number(store.getMeta(metaKey) ?? 0);
  if (used >= settings.maxCallsPerDay) return done({ skipped: `daily cap of ${settings.maxCallsPerDay} calls reached` });
  let verdicts;
  try {
    verdicts = await judgeBatch({ pairs: todo, settings, key, fetchImpl, signal });
  } catch (err) {
    return done({ error: err.message });
  } finally {
    store.setMeta(metaKey, used + 1);
  }
  let flagged = 0;
  const at = now().toISOString();
  todo.forEach((p, i) => {
    const v = verdicts[i];
    if (!v) return; // not answered: asked again next run
    store.setMeta(matchKey(p.query, p.site, p.product), JSON.stringify({ v: v === 'yes' ? 'same' : v, at, model: settings.model }));
    if (v === 'no') flagged++;
  });
  log(`same-product: ${todo.length} asked, ${flagged} flagged`);
  return done({ asked: todo.length, flagged, calls: 1 });
}

/** ✓ keep: the user says it is the same product; the AI is not asked again and never demotes it. */
export function keepMatch(store, { query, site, product }) {
  store.setMeta(matchKey(query, site, product), JSON.stringify({ v: 'same', by: 'user', at: new Date().toISOString() }));
}
