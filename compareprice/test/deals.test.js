import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeal, discountPct, toDeal, dealsFromRows } from '../src/deals.js';
import { openStore } from '../src/store.js';

test('isDeal: ₹1 against MRP ₹78 is a deal at 80; ₹20 against ₹78 is not', () => {
  assert.equal(isDeal({ price: 1, mrp: 78 }, 80), true);
  assert.equal(discountPct(1, 78), 98.7);
  assert.equal(isDeal({ price: 20, mrp: 78 }, 80), false);
  assert.equal(isDeal({ price: 15.6, mrp: 78 }, 80), true, 'exactly 80% counts');
});

test('isDeal: mrp null, 0 or below price is never a deal, and no NaN', () => {
  for (const row of [{ price: 1, mrp: null }, { price: 1, mrp: 0 }, { price: 50, mrp: 40 }, { price: 'x', mrp: 78 }, {}]) {
    assert.equal(isDeal(row, 80), false, JSON.stringify(row));
    assert.equal(discountPct(row.price, row.mrp), null);
  }
});

test('deals from searches: one per product and account, out-of-stock skipped', () => {
  const rows = {
    tomato: [
      { name: 'Tomato Desi', packSize: 1000, packUnit: 'g', price: 1, mrp: 78, inStock: true, url: 'https://x/1' },
      { name: 'Tomato Desi', packSize: 1000, packUnit: 'g', price: 1, mrp: 78, inStock: true, url: 'https://x/1' },
      { name: 'Tomato Hybrid', packSize: 1000, packUnit: 'g', price: 32, mrp: 40, inStock: true, url: 'https://x/2' },
      { name: 'Potato', packSize: 1000, packUnit: 'g', price: 1, mrp: 50, inStock: false, url: 'https://x/3' },
    ],
  };
  const d = dealsFromRows(rows, { site: 'milkbasket', seenAt: '2026-11-19T10:00:00Z' });
  assert.equal(d.length, 1);
  assert.deepEqual(
    { site: d[0].site, account: d[0].account, product: d[0].product, pack: d[0].pack, price: d[0].price, mrp: d[0].mrp, pct: d[0].pct, source: d[0].source },
    { site: 'milkbasket', account: 'main', product: 'Tomato Desi', pack: '1000g', price: 1, mrp: 78, pct: 98.7, source: 'search' },
  );
});

test('store: a feed check replaces that account\'s feed deals; search deals show for 24 h; one row per product with every account', () => {
  const s = openStore(':memory:');
  try {
    const t0 = '2026-11-19T07:00:00.000Z';
    const feed = (product, account, seenAt) => toDeal({ name: product, price: 1, mrp: 78, packSize: 1000, packUnit: 'g', maxQty: 1 }, { site: 'milkbasket', account, source: 'feed', seenAt, conditions: { minBasket: 9 } });
    s.recordDeals([feed('Tomato Desi', 'main', t0), feed('Potato', 'main', t0)], { site: 'milkbasket', account: 'main', source: 'feed', checkedAt: t0 });
    s.recordDeals([feed('Tomato Desi', 'a2', t0)], { site: 'milkbasket', account: 'a2', source: 'feed', checkedAt: t0 });
    let cur = s.currentDeals({ now: Date.parse(t0) + 60_000, names: { main: 'Main', a2: 'Amma' } });
    const mb = cur.groups.find((g) => g.site === 'milkbasket');
    assert.equal(mb.deals.length, 2);
    const tomato = mb.deals.find((d) => d.product === 'Tomato Desi');
    assert.deepEqual(tomato.seenBy.map((x) => x.account).sort(), ['a2', 'main']);
    assert.equal(tomato.seenBy.find((x) => x.account === 'a2').name, 'Amma');
    assert.deepEqual(tomato.conditions, { minBasket: 9, maxQty: 1 });

    // The next check for main no longer has Potato: it drops out, Tomato stays.
    const t1 = '2026-11-19T10:00:00.000Z';
    s.recordDeals([feed('Tomato Desi', 'main', t1)], { site: 'milkbasket', account: 'main', source: 'feed', checkedAt: t1 });
    cur = s.currentDeals({ now: Date.parse(t1) + 60_000 });
    assert.deepEqual(cur.groups.find((g) => g.site === 'milkbasket').deals.map((d) => d.product), ['Tomato Desi']);
    assert.equal(cur.checkedAt.milkbasket, t1);

    // Search deals: kept 24 h, then out of view.
    s.recordDeals([toDeal({ name: 'Onion', price: 2, mrp: 40, packSize: 1000, packUnit: 'g' }, { site: 'instamart', seenAt: t1 })], { site: 'instamart', account: 'main', source: 'search', checkedAt: t1 });
    assert.equal(s.currentDeals({ now: Date.parse(t1) + 3_600_000 }).fromSearches.length, 1);
    assert.equal(s.currentDeals({ now: Date.parse(t1) + 25 * 3_600_000 }).fromSearches.length, 0);
  } finally {
    s.close();
  }
});

test('store: a result\'s deals are recorded with the prices, and never change the totals', () => {
  const s = openStore(':memory:');
  try {
    const result = {
      generatedAt: '2026-11-19T10:00:00.000Z',
      platforms: [{ platform: 'milkbasket', total: 32, lines: [] }],
      deals: [toDeal({ name: 'Tomato Desi', price: 1, mrp: 78 }, { site: 'milkbasket', seenAt: '2026-11-19T10:00:00.000Z' })],
    };
    s.recordResult(result, { trigger: 'manual' });
    assert.equal(result.platforms[0].total, 32);
    assert.equal(s.currentDeals({ now: Date.parse('2026-11-19T11:00:00Z') }).fromSearches[0].product, 'Tomato Desi');
  } finally {
    s.close();
  }
});

test('review fixes: a failed check keeps the last good deals; 79.96% is not 80%; signing out forgets the account\'s deals', () => {
  const s = openStore(':memory:');
  try {
    const t0 = '2026-11-19T07:00:00.000Z';
    const d = toDeal({ name: 'Tomato Desi', price: 1, mrp: 78 }, { site: 'milkbasket', account: 'a2', source: 'feed', seenAt: t0 });
    s.recordDeals([d], { site: 'milkbasket', account: 'a2', source: 'feed', checkedAt: t0 });
    s.recordDeals([], { site: 'milkbasket', account: 'a2', source: 'feed', checkedAt: '2026-11-19T10:00:00.000Z', error: 'milkbasket: network error' });
    const cur = s.currentDeals({ now: Date.parse('2026-11-19T10:01:00Z') });
    assert.equal(cur.groups[0].deals.length, 1, 'kept through one failed check');
    assert.equal(cur.errors.length, 1);
    s.forgetAccountDeals('milkbasket', 'a2');
    assert.deepEqual(s.currentDeals({}).groups, []);
  } finally {
    s.close();
  }
  assert.equal(isDeal({ price: 20.03, mrp: 100 }, 80), false, '79.97% off');
  assert.equal(isDeal({ price: 20, mrp: 100 }, 80), true);
});

test('✕ reject: keeps the row but hides it, and never picks it again for that item; free-delivery facts per site', async () => {
  const { compareBasket } = await import('../src/compare.js');
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  const { freeDeliveryFrom } = await import('../src/engine/sites/_capture.js');
  const { feeInfo } = await import('../src/engine/sites/milkbasket.js');
  const s = openStore(':memory:');
  try {
    const row = (name, price) => ({ name, packSize: 1000, packUnit: 'g', price, mrp: null, inStock: true, url: 'u' });
    const search = async ({ sites, queries }) => sites.map((site) => ({ platform: site, available: true, error: null, errorKind: null, partialFailures: [], failures: [], resultsByQuery: { [queries[0]]: [row('Low Sugar Potato 1 kg', 48), row('Madhur Sugar 1 kg', 67)] } }));
    const run = () => compareBasket({ items: 'sugar 1kg', platforms: ['milkbasket'], config: DEFAULT_CONFIG, pool: {}, search, store: s });
    s.recordResult(await run());
    const before = s.db.prepare("SELECT COUNT(*) n FROM prices WHERE site = 'milkbasket'").get().n;
    s.rejectMatch({ query: 'Sugar 1 kg', site: 'milkbasket', product: 'Low Sugar Potato 1 kg' });
    // Never deleted: the row is kept, marked hidden, and stops counting.
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM prices WHERE site = 'milkbasket'").get().n, before);
    assert.equal(s.db.prepare("SELECT hidden FROM prices WHERE product = 'Low Sugar Potato 1 kg'").get()?.hidden ?? 'rejected', 'rejected');
    const r = await run();
    assert.equal(r.platforms[0].lines[0].product.name, 'Madhur Sugar 1 kg', 'never picked again for this item');
    assert.deepEqual([...s.rejectedFor('sugar 1kg', 'milkbasket')], ['Low Sugar Potato 1 kg']);
    assert.equal(s.rejectedFor('sugar 1kg', 'zepto').size, 0, 'only on that site');

    s.setSiteInfo('zepto', { freeDeliveryAbove: 99 }, '2026-11-19T10:00:00Z');
    assert.deepEqual(s.siteInfo(), { zepto: { freeDeliveryAbove: 99, seenAt: '2026-11-19T10:00:00Z' } });
  } finally {
    s.close();
  }
  assert.equal(freeDeliveryFrom('<b>FREE DELIVERY</b> on orders above ₹99'), 99);
  assert.equal(freeDeliveryFrom('Unlock FLAT 10% OFF on orders above ₹499'), null);
  assert.deepEqual(
    feeInfo([{ op: 'getExtraFeeStrips', text: JSON.stringify({ data: { getExtraFeeStrips: [{ name: 'Small cart fee', mrp: { amount: 15 }, mov: { amount: 99 } }] } }) }]),
    { freeDeliveryAbove: 99, feeBelow: 15, feeName: 'Small cart fee' },
  );
});

test('"Others": an entered price (past date, shop) becomes its own column, joins the lookup, is never totalled or ranked', async () => {
  const { compareBasket } = await import('../src/compare.js');
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  const s = openStore(':memory:');
  try {
    assert.throws(() => s.addManualPrice({ query: 'tata salt 1kg', price: 0 }), /price/);
    assert.throws(() => s.addManualPrice({ query: 'salt', price: 18 }), /pack size/);
    const { id } = s.addManualPrice({ query: 'Tata Salt 1 kg', product: 'Tata Salt 1 kg', price: 18, seenAt: '2026-11-10', source: 'Murugan Stores' });
    assert.ok(id > 0);
    const row = (name, price) => ({ name, packSize: 1000, packUnit: 'g', price, mrp: null, inStock: true, url: 'u' });
    const search = async ({ sites, queries }) => sites.map((site) => ({ platform: site, available: true, error: null, errorKind: null, partialFailures: [], failures: [], resultsByQuery: { [queries[0]]: [row('Tata Salt Crystal 1 kg', 22)] } }));
    const r = await compareBasket({ items: 'tata salt 1kg', platforms: ['zepto'], config: DEFAULT_CONFIG, pool: {}, search, store: s });
    const o = r.platforms.find((p) => p.platform === 'others');
    assert.equal(o.others, true);
    assert.equal(o.total, null, 'no basket total');
    assert.deepEqual([o.lines[0].lineTotal, o.lines[0].source, o.lines[0].cachedAt.slice(0, 10)], [18, 'Murugan Stores', '2026-11-10']);
    assert.equal(r.winner.platform, 'zepto', 'never ranked');
    s.recordResult(r);
    assert.equal(s.listManualPrices().length, 1, 'recording a result does not copy the entry');
    const look = s.lookup('tata salt 1kg');
    assert.equal(look.sites.find((x) => x.site === 'others').source, 'Murugan Stores');
    assert.equal(s.removeManualPrice(id).removed, 1);
    assert.equal(s.lookup('tata salt 1kg').sites.some((x) => x.site === 'others'), false);
  } finally {
    s.close();
  }
});

test('option A hint: a cheaper same-kind other brand on that site; rock salt never counts for table salt; totals unchanged', async () => {
  const { compareBasket } = await import('../src/compare.js');
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  const { withoutBrand, addsKind } = await import('../src/normalize.js');
  assert.equal(withoutBrand('tata salt 1kg'), 'salt 1kg');
  assert.equal(withoutBrand('2x amul taaza toned milk 500ml'), '2x taaza toned milk 500ml');
  assert.equal(withoutBrand('salt 1kg'), null);
  assert.equal(addsKind('tata salt 1kg', 'Tata Salt Crystal 1 kg', 'Himalayan Pink Rock Salt 1 kg'), true);
  assert.equal(addsKind('tata salt 1kg', 'Tata Salt Crystal 1 kg', 'Aashirvaad Iodised Salt 1 kg'), false);
  const s = openStore(':memory:');
  try {
    const row = (name, price, packSize = 1000) => ({ name, packSize, packUnit: 'g', price, mrp: null, inStock: true, url: 'u' });
    const search = async ({ sites, queries }) => sites.map((site) => ({ platform: site, available: true, error: null, errorKind: null, partialFailures: [], failures: [],
      resultsByQuery: { [queries[0]]: [row('Tata Salt Crystal 1 kg', 22), row('Aashirvaad Iodised Salt 1 kg', 20), row('Himalayan Pink Rock Salt 1 kg', 15)] } }));
    const r = await compareBasket({ items: 'tata salt 1kg', platforms: ['zepto'], config: DEFAULT_CONFIG, pool: {}, search, store: s });
    const line = r.platforms[0].lines[0];
    assert.equal(line.product.name, 'Tata Salt Crystal 1 kg');
    assert.equal(line.lineTotal, 22, 'total stays on the brand asked for');
    assert.deepEqual([line.alternative.product, line.alternative.price, line.alternative.savingPct], ['Aashirvaad Iodised Salt 1 kg', 20, 9]);
    // Saved for the hint on saved prices.
    s.recordResult(r);
    const c = await compareBasket({ items: 'tata salt 1kg', platforms: ['zepto'], config: DEFAULT_CONFIG, cached: true, store: s });
    assert.equal(c.platforms[0].lines[0].alternative.product, 'Aashirvaad Iodised Salt 1 kg');
  } finally {
    s.close();
  }
});
