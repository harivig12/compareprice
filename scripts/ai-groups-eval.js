// How well does the configured AI provider sort product titles?
// Sends the hand-labelled titles in test/fixtures/ai/labels.txt in batches of
// ai.md's "batch size" (one call for all 103 at the default 100… two calls) and
// prints accuracy and the misses. Uses <data>/ai.md and the key saved in Settings.
// usage: node scripts/ai-groups-eval.js            (BASKET_HOME picks the data dir)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../src/paths.js';
import { readAiSettings, readKey } from '../src/ai/settings.js';
import { labelBatch } from '../src/ai/label.js';

const file = fileURLToPath(new URL('../test/fixtures/ai/labels.txt', import.meta.url));
const rows = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => {
  // Titles may contain "|" themselves: the query is the first field, the label the last.
  const parts = l.split('|');
  return { query: parts[0], product: parts.slice(1, -1).join('|'), label: parts.at(-1).trim() };
});
const settings = readAiSettings(DATA_DIR);
const key = readKey(DATA_DIR);
if (!key) { console.error('No API key saved (Settings → AI labels).'); process.exit(2); }

const got = [];
for (let i = 0; i < rows.length; i += settings.batchSize) {
  if (i) await new Promise((r) => setTimeout(r, settings.pauseSeconds * 1000));
  const t = Date.now();
  got.push(...await labelBatch({ titles: rows.slice(i, i + settings.batchSize).map((r) => r.product), settings, key }));
  console.log(`call ${i / settings.batchSize + 1}: ${Math.min(settings.batchSize, rows.length - i)} titles in ${((Date.now() - t) / 1000).toFixed(1)} s`);
}
const misses = rows.map((r, i) => ({ ...r, got: got[i] })).filter((r) => r.got !== r.label);
const right = rows.length - misses.length;
console.log(`\n${settings.provider} ${settings.model}: ${right}/${rows.length} right (${((100 * right) / rows.length).toFixed(1)}%), ${got.filter((g) => g == null).length} missing`);
// What matters most: a sweet or pooja item called a staple would not be demoted.
const unsafe = misses.filter((m) => ['sweets', 'pooja', 'packaged'].includes(m.label) && m.got === 'staple');
console.log(`demotions missed (sweets/pooja/packaged called staple): ${unsafe.length}`);
for (const m of misses) console.log(`  ${m.label.padEnd(8)} → ${String(m.got).padEnd(8)} ${m.product}`);
