/**
 * The `ai-labels` queue job: label saved titles that have no site category,
 * a batch per call, paced, capped per day (settings in <data>/ai.md).
 * Search never waits for it; nothing it writes hides a product.
 */
import { readAiSettings, readKey } from './settings.js';
import { labelBatch } from './label.js';

const sleepMs = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('cancelled')); }, { once: true });
});

/** The day the per-day cap counts against (IST, like the schedules). */
const dayOf = (d, timeZone) => d.toLocaleDateString('sv-SE', { timeZone });

/**
 * @returns {Promise<{ kind: 'ai-labels', generatedAt: string, labelled: number, calls: number, skipped?: string, error?: string }>}
 */
export async function runAiLabels({ store, dataDir, fetchImpl = fetch, sleep = sleepMs, now = () => new Date(), log = () => {}, signal, timeZone = 'Asia/Kolkata' } = {}) {
  const done = (extra) => ({ kind: 'ai-labels', generatedAt: now().toISOString(), labelled: 0, calls: 0, ...extra });
  const settings = readAiSettings(dataDir);
  if (!settings.enabled) return done({ skipped: 'AI labels are off (ai.md: enabled: no)' });
  const key = readKey(dataDir);
  if (!key) return done({ error: 'AI labels are on but no API key is saved (Settings → AI labels)' });

  const metaKey = `ai_calls:${dayOf(now(), timeZone)}`;
  let calls = 0;
  let used = Number(store.getMeta(metaKey) ?? 0);
  let labelled = 0;
  const tried = new Set(); // titles the provider skipped this run: not sent again until the next run
  while (used < settings.maxCallsPerDay) {
    const titles = store.unlabelled(settings.batchSize + tried.size).filter((t) => !tried.has(t)).slice(0, settings.batchSize);
    if (!titles.length) break;
    if (calls > 0) await sleep(settings.pauseSeconds * 1000, signal);
    let groups;
    try {
      groups = await labelBatch({ titles, settings, key, fetchImpl, signal });
    } catch (err) {
      return done({ labelled, calls, error: err.message });
    } finally {
      calls++;
      used++;
      store.setMeta(metaKey, used);
    }
    const list = titles.map((product, i) => ({ product, group: groups[i] })).filter((x) => x.group);
    for (const t of titles) tried.add(t);
    if (!list.length) return done({ labelled, calls, error: 'The AI provider returned no usable labels (check the model in Settings)' });
    labelled += store.setGroups(list, { model: settings.model, at: now().toISOString() });
    log(`ai-labels: ${list.length}/${titles.length} labelled (call ${used}/${settings.maxCallsPerDay} today)`);
  }
  return done({ labelled, calls, ...(used >= settings.maxCallsPerDay && store.unlabelled(1).length ? { skipped: `daily cap of ${settings.maxCallsPerDay} calls reached; the rest waits for tomorrow` } : {}) });
}
