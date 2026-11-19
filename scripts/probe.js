#!/usr/bin/env node
/**
 * Dev utility: run one site's extractor against one query and print the rows.
 *
 *   node scripts/probe.js blinkit "amul taaza toned milk 500ml"
 *   node scripts/probe.js zepto "amul butter 500g"
 */

import { searchViaBrowser, EXTRACTORS } from '../src/extract/index.js';
import { browserAvailable, CDP_HOST } from '../src/browser.js';
import { annotate } from '../src/normalize.js';

const [site, ...rest] = process.argv.slice(2);
const query = rest.join(' ');

if (!site || !query) {
  console.error('Usage: node scripts/probe.js <site> "<query>"');
  console.error('Sites:', Object.keys(EXTRACTORS).join(', '));
  process.exit(2);
}

if (!(await browserAvailable())) {
  console.error(`✖ No debuggable Chrome at ${CDP_HOST}`);
  console.error('  Start it with:');
  console.error('    chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\\Users\\HP\\chrome-basket-profile');
  process.exit(1);
}

const started = Date.now();
try {
  const rows = await searchViaBrowser(site, query);
  console.log(`\n${site} · "${query}" · ${rows.length} rows · ${Date.now() - started}ms\n`);

  const annotated = rows.map((r) => annotate(query, r));
  console.table(
    annotated.slice(0, 12).map((r) => ({
      name: r.name.slice(0, 42),
      pack: r.pack ? `${r.pack.size}${r.pack.unit}` : '—',
      price: r.price,
      mrp: r.mrp ?? '—',
      perUnit: r.pricePerUnitLabel ?? '—',
      stock: r.inStock ? 'yes' : 'NO',
      conf: r.confidence,
      ok: r.confident ? '✔' : r.refused ? 'REFUSED' : '?',
    })),
  );

  const confident = annotated.filter((r) => r.confident && r.inStock);
  console.log(`\nconfident & in stock: ${confident.length}/${rows.length}`);
  if (confident.length > 0) {
    const best = confident.sort((a, b) => (a.pricePerUnit ?? 1e9) - (b.pricePerUnit ?? 1e9))[0];
    console.log(`best per-unit: ${best.name} — ₹${best.price} (${best.pricePerUnitLabel})`);
    console.log(`url: ${best.url}`);
  }
  const rejected = annotated.filter((r) => !r.confident);
  if (rejected.length > 0) {
    console.log(`\nrejected (${rejected.length}):`);
    for (const r of rejected.slice(0, 6)) {
      console.log(`  ${r.confidence.toString().padEnd(6)} ${r.name.slice(0, 50)} — ${r.confidenceReason}`);
    }
  }
} catch (err) {
  console.error(`\n✖ ${site}: ${err.message}`);
  process.exit(1);
}
