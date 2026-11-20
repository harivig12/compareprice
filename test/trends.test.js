import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';

const result = (generatedAt, site, query, product) => ({
  generatedAt,
  platforms: [{ platform: site, lines: [{ query, status: 'ok', product: { packLabel: `${product.packSize}${product.packUnit}`, url: 'u', ...product } }] }],
});
const onion = (price, packSize = 1000) => ({ name: `Onion ${packSize} g`, price, packSize, packUnit: 'g' });

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'basket-trend-'));
  const store = openStore(join(dir, 'basket.db'));
  try { return fn(store); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('annotate: ▼/▲ against the latest earlier saved price, even earlier the same day; <1% is "same"', () => withStore((store) => {
  store.recordResult(result('2026-11-19T01:30:00.000Z', 'blinkit', 'onion 1kg', onion(69)));   // 07:00 IST
  const at10 = result('2026-11-19T04:30:00.000Z', 'blinkit', 'onion 1kg', onion(64));          // 10:00 IST, cheaper
  store.annotate(at10);
  const h = at10.platforms[0].lines[0].history;
  assert.equal(h.change, 'down');
  assert.equal(h.changePct, -7.2);
  assert.deepEqual([h.prev.price, h.prev.seenAt, h.prev.unitPrice], [69, '2026-11-19T01:30:00.000Z', 69]);
  store.recordResult(at10);

  const up = result('2026-11-19T06:30:00.000Z', 'blinkit', 'onion 1kg', onion(70));
  store.annotate(up);
  assert.equal(up.platforms[0].lines[0].history.change, 'up');

  const same = result('2026-11-19T06:30:00.000Z', 'blinkit', 'onion 1kg', onion(64.3));
  store.annotate(same);
  assert.equal(same.platforms[0].lines[0].history.change, 'same', '0.5% is not an arrow');
}));

test('annotate: a different pack at the same rate is "same", not a price change', () => withStore((store) => {
  store.recordResult(result('2026-11-18T01:30:00.000Z', 'kpn', 'onion 1kg', onion(72, 1000)));
  const r = result('2026-11-19T01:30:00.000Z', 'kpn', 'onion 1kg', onion(36, 500));
  store.annotate(r);
  assert.equal(r.platforms[0].lines[0].history.change, 'same');
}));

test('annotate: first sighting has no arrow', () => withStore((store) => {
  const r = result('2026-11-19T01:30:00.000Z', 'kpn', 'onion 1kg', onion(72));
  store.annotate(r);
  assert.equal(r.platforms[0].lines[0].history.change, null);
}));

test('cachedHistory: the latest saved price against the one before it', () => withStore((store) => {
  store.recordResult(result('2026-11-18T01:30:00.000Z', 'zepto', 'onion 1kg', onion(80)));
  store.recordResult(result('2026-11-19T01:30:00.000Z', 'zepto', 'onion 1kg', onion(76)));
  const h = store.cachedHistory('Onion 1 kg', 'zepto');
  assert.equal(h.change, 'down');
  assert.equal(h.changePct, -5);
  assert.equal(h.tag, 'at-low');
  assert.equal(store.cachedHistory('onion 1kg', 'kpn'), null);
}));

test('recentRates: last 3 dates that have data (IST), lowest per date, null where a site had nothing', () => withStore((store) => {
  // 4 dates of data; the oldest must drop out. 2026-11-17T20:00Z is already 18 Nov in IST.
  const rec = (at, site, price) => store.recordResult(result(at, site, 'onion 1kg', onion(price)));
  rec('2026-11-16T03:00:00.000Z', 'blinkit', 70);
  rec('2026-11-17T20:00:00.000Z', 'blinkit', 69);
  rec('2026-11-18T03:00:00.000Z', 'blinkit', 71);   // same IST date as above: lowest (69) wins
  rec('2026-11-19T03:00:00.000Z', 'blinkit', 69);
  rec('2026-11-20T03:00:00.000Z', 'blinkit', 64);
  rec('2026-11-20T03:00:00.000Z', 'flipkart_minutes', 63.8);
  const r = store.recentRates('onion 1kg');
  assert.deepEqual(r.dates, ['2026-11-18', '2026-11-19', '2026-11-20']);
  assert.equal(r.per, '100 g');
  assert.deepEqual(r.sites.blinkit.map((c) => c?.rate), [6.9, 6.9, 6.4]);
  assert.deepEqual(r.sites.flipkart_minutes.map((c) => c?.rate ?? null), [null, null, 6.38]);
  assert.equal(r.sites.blinkit[2].price, 64);
  assert.equal(store.recentRates('never saved'), null);
}));

test('lookup carries the 3-date trend and change per site; suggest carries the best latest rate', () => withStore((store) => {
  const rec = (at, site, price) => store.recordResult(result(at, site, 'onion 1kg', onion(price)));
  rec('2026-11-18T03:00:00.000Z', 'blinkit', 69);
  rec('2026-11-19T03:00:00.000Z', 'blinkit', 64);
  rec('2026-11-19T03:00:00.000Z', 'zepto', 80);
  const l = store.lookup('onion 1kg');
  assert.deepEqual(l.dates, ['2026-11-18', '2026-11-19']);
  const b = l.sites.find((s) => s.site === 'blinkit');
  assert.deepEqual(b.trend.map((c) => c?.rate), [6.9, 6.4]);
  assert.equal(b.change, 'down');
  assert.equal(l.sites[0].site, 'blinkit', 'cheapest now first');
  const [sg] = store.suggest('oni');
  assert.deepEqual(sg.best, { site: 'blinkit', rate: 6.4, per: '100 g', date: '2026-11-19' });
}));
