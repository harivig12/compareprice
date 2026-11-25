/**
 * AI labeller settings (design 2026-11-20 §5).
 *
 * `<data>/ai.md` holds the tunables as plain "key: value" lines, so they can be
 * changed by editing the file (no rebuild, re-read on every run). The API key
 * never goes there: it lives in `<data>/secrets.json` (mode 600) and is only
 * ever sent to the chosen provider.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const PROVIDERS = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-oss-20b:free' },
  custom: { baseUrl: '', model: '' },
};

// key in ai.md -> [setting, kind]. Order is the order written to a new file.
const FIELDS = [
  ['enabled', 'enabled', 'bool'],
  // Reads payment offers' terms into fixed rules for the payment advisor (offer text only).
  ['read offers', 'readOffers', 'bool'],
  ['provider', 'provider', 'text'],
  ['base url', 'baseUrl', 'text'],
  ['model', 'model', 'text'],
  // 100 titles ≈ 3.5k tokens per call: under the smaller per-minute token
  // limits of free tiers, and ~12 calls label the ~1,200 titles saved so far.
  ['batch size', 'batchSize', 'int'],
  // Free tiers count tokens per minute: a call a minute stays under them.
  ['pause seconds', 'pauseSeconds', 'int'],
  ['max calls per day', 'maxCallsPerDay', 'int'],
];

export const DEFAULT_AI = Object.freeze({
  enabled: false,
  readOffers: true,
  provider: 'groq',
  baseUrl: PROVIDERS.groq.baseUrl,
  model: PROVIDERS.groq.model,
  batchSize: 100,
  pauseSeconds: 65,
  maxCallsPerDay: 50,
});

const LIMITS = { batchSize: [1, 400], pauseSeconds: [0, 3600], maxCallsPerDay: [1, 10_000] };

const HEADER = `# AI labels (optional)

Labels saved products from sites that send no category (Blinkit, Amazon,
Flipkart Minutes) as staple / packaged / sweets / pooja / nonfood. A label
only moves a product down the list; it never hides one.

Change a value after the colon. The service re-reads this file on every run.
Only product titles are sent to the provider, many per call. The API key is
set on the Settings page and kept in secrets.json, never here.

`;

export const aiFile = (dataDir) => join(dataDir, 'ai.md');
const secretsFile = (dataDir) => join(dataDir, 'secrets.json');

const fmt = (kind, v) => (kind === 'bool' ? (v ? 'yes' : 'no') : String(v ?? ''));

function parse(text) {
  const out = { ...DEFAULT_AI };
  for (const line of String(text).split('\n')) {
    const m = /^\s*[-*]?\s*([a-z ]+?)\s*:\s*(.*?)\s*$/i.exec(line);
    if (!m) continue;
    const f = FIELDS.find(([k]) => k === m[1].toLowerCase());
    if (!f) continue;
    const [, key, kind] = f;
    if (kind === 'bool') out[key] = /^(yes|true|on|1)$/i.test(m[2]);
    else if (kind === 'int') {
      const n = Math.round(Number(m[2]));
      const [lo, hi] = LIMITS[key];
      if (Number.isFinite(n)) out[key] = Math.min(hi, Math.max(lo, n));
    } else out[key] = m[2];
  }
  out.baseUrl = String(out.baseUrl).replace(/\/+$/, '');
  return out;
}

/** Settings from ai.md; writes the file with defaults the first time. */
export function readAiSettings(dataDir) {
  try {
    return parse(readFileSync(aiFile(dataDir), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    writeAiSettings(dataDir, {});
    return { ...DEFAULT_AI };
  }
}

/** Update some values; every other line (comments, unknown keys) is kept. */
export function writeAiSettings(dataDir, patch) {
  let text;
  try { text = readFileSync(aiFile(dataDir), 'utf8'); } catch { text = HEADER + FIELDS.map(([k, key, kind]) => `- ${k}: ${fmt(kind, DEFAULT_AI[key])}`).join('\n') + '\n'; }
  for (const [k, key, kind] of FIELDS) {
    if (!(key in patch)) continue;
    const re = new RegExp(`^(\\s*[-*]?\\s*${k}\\s*:).*$`, 'im');
    const v = fmt(kind, patch[key]);
    text = re.test(text) ? text.replace(re, `$1 ${v}`) : `${text.replace(/\n?$/, '\n')}- ${k}: ${v}\n`;
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(aiFile(dataDir), text);
  return parse(text);
}

function readSecrets(dataDir) {
  try { return JSON.parse(readFileSync(secretsFile(dataDir), 'utf8')); } catch { return {}; }
}

export function readKey(dataDir) {
  const k = readSecrets(dataDir).ai?.key;
  return typeof k === 'string' && k ? k : null;
}

/** Save (or clear, with '') the provider key. File mode 600. */
export function saveKey(dataDir, key) {
  const s = readSecrets(dataDir);
  s.ai = { ...(s.ai ?? {}), key: String(key ?? '').trim() || undefined };
  mkdirSync(dataDir, { recursive: true });
  const file = secretsFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

/** "••••abcd": enough to recognise the key, never the key. */
export const keyHint = (key) => (key ? `••••${String(key).slice(-4)}` : null);
