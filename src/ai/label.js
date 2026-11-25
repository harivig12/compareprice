/**
 * One call to an OpenAI-compatible chat API (Groq, OpenRouter, or a local
 * server such as Ollama) that sorts many product titles at once.
 *
 * Only the numbered titles are sent: no site, price, account or location.
 * A local 0.6B/1B model was measured first and got 57% / under 35% right
 * (docs/diagnosis/2026-11-20-ghee-laddu-and-category-preference.md), hence an API.
 */

export const AI_GROUPS = ['staple', 'packaged', 'sweets', 'pooja', 'nonfood'];

export const SYSTEM_PROMPT = `You sort Indian grocery product titles into groups. For each numbered title, give its group:
staple: a basic grocery item bought to cook with or eat as it is: rice, grains, flours, dals, spices, salt, sugar, jaggery, tea, coffee, plain edible oils and ghee, milk, curd, butter, paneer, eggs, fruit, vegetables, nuts and dry fruits.
packaged: processed or ready food: snacks, namkeen, chips, biscuits, cookies, noodles, ready-to-eat or ready-to-cook meals, instant mixes, frozen foods, sauces, pickles, digestive candies.
sweets: Indian sweets (mithai such as laddu, barfi, peda, halwa), chocolates, candy and desserts.
pooja: items for worship, not for eating: pooja oil, lamp ghee, camphor, incense, agarbatti, wicks, kumkum, pooja coconut.
nonfood: cleaning, household and personal-care items.
Reply with JSON only, one entry for every title: {"items":[{"i":<number>,"g":"<group>"}]}`;

/** The reply shape, enforced by providers that support structured outputs. */
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['i', 'g'], properties: { i: { type: 'integer' }, g: { type: 'string', enum: AI_GROUPS } } } } },
};

/**
 * @param {'schema'|'json'} [mode] 'schema' (default): strict JSON schema plus
 *   low reasoning effort. Measured 2026-11-20 on Groq gpt-oss-20b: plain JSON
 *   mode came back empty for 100 titles (HTTP 400 json_validate_failed, the
 *   reasoning used up the answer), the schema gave 100/100 in 1.9 s. 'json' is
 *   the fallback for providers that refuse those two fields.
 * @returns {object} chat/completions request body
 */
export function buildRequest(titles, model, mode = 'schema') {
  return {
    model,
    temperature: 0,
    ...(mode === 'schema'
      ? { response_format: { type: 'json_schema', json_schema: { name: 'labels', strict: true, schema: SCHEMA } }, reasoning_effort: 'low' }
      : { response_format: { type: 'json_object' } }),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: titles.map((t, i) => `${i}. ${String(t).replace(/\s+/g, ' ').trim()}`).join('\n') },
    ],
  };
}

/** Groups by title index; anything missing or malformed is null. */
export function parseReply(json, n) {
  const out = Array(n).fill(null);
  let content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return out;
  content = content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
  let data;
  try { data = JSON.parse(content); } catch { return out; }
  const items = Array.isArray(data) ? data : data?.items;
  for (const it of Array.isArray(items) ? items : []) {
    const i = Number(it?.i);
    const g = String(it?.g ?? '').toLowerCase();
    if (Number.isInteger(i) && i >= 0 && i < n && AI_GROUPS.includes(g)) out[i] = g;
  }
  return out;
}

export async function call(url, init, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(90_000) });
  } catch (err) {
    throw new Error(`AI provider not reachable (${err.cause?.code || err.name || 'network error'})`);
  }
  const text = await res.text();
  // The key is never part of a message: only the status and the provider's own text.
  if (!res.ok) throw new Error(`AI provider answered HTTP ${res.status}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
  try { return JSON.parse(text); } catch { throw new Error('AI provider answered with something that is not JSON'); }
}

export const headers = (key) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` });

/** Label one batch of titles with one request. */
export async function labelBatch({ titles, settings, key, fetchImpl = fetch, signal }) {
  const send = (mode) => call(`${settings.baseUrl}/chat/completions`, { method: 'POST', headers: headers(key), body: JSON.stringify(buildRequest(titles, settings.model, mode)), signal }, fetchImpl);
  let json;
  try {
    json = await send('schema');
  } catch (err) {
    // A provider or model without structured outputs / reasoning_effort says
    // so with a 400 about the request: retry once in plain JSON mode.
    if (!/HTTP 400/.test(err.message) || /json_validate_failed/.test(err.message)) throw err;
    json = await send('json');
  }
  return parseReply(json, titles.length);
}

/** Two titles whose group is not in doubt, for "Check connection". */
export const CHECK_SAMPLE = [['Aavin Ghee 1 L (Carton)', 'staple'], ['Sweet Sanskriti Ghee Besan Laddu Pack 200 g', 'sweets']];

/**
 * "Check connection": is the key accepted, is the model there, and does one
 * tiny labelling call come back right?
 * @returns {Promise<{ ok: boolean, modelListed: boolean|null, sample: { ok: boolean, got: Array } | null, error: string|null }>}
 */
export async function checkConnection({ settings, key, fetchImpl = fetch }) {
  if (!key) return { ok: false, modelListed: null, sample: null, error: 'No API key saved yet.' };
  if (!/^https?:\/\//.test(settings.baseUrl || '')) return { ok: false, modelListed: null, sample: null, error: 'The base URL must start with https://' };
  let modelListed = null;
  try {
    const models = await call(`${settings.baseUrl}/models`, { headers: headers(key) }, fetchImpl);
    const ids = (models?.data ?? []).map((m) => m?.id);
    modelListed = ids.includes(settings.model);
  } catch (err) {
    return { ok: false, modelListed: null, sample: null, error: err.message };
  }
  try {
    const got = await labelBatch({ titles: CHECK_SAMPLE.map(([t]) => t), settings, key, fetchImpl });
    const ok = got.every((g, i) => g === CHECK_SAMPLE[i][1]);
    return { ok, modelListed, sample: { ok, got }, error: ok ? null : `The model answered ${JSON.stringify(got)} for a ghee and a laddu; expected ["staple","sweets"].` };
  } catch (err) {
    return { ok: false, modelListed, sample: null, error: err.message };
  }
}
