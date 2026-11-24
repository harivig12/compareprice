import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOffers } from '../src/offers.js';
import { openAccounts } from '../src/engine/accounts.js';
import { LOGIN_SITES } from '../src/engine/login.js';
import { openStore } from '../src/store.js';
import { parseList, MAX_PAGES } from '../src/engine/sites/milkbasket.js';

const fixture = (n) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/sites/${n}.json`, import.meta.url)), 'utf8'));
const multi = (s) => Boolean(LOGIN_SITES[s]?.multiAccount);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'basket-offers-'));
  const accounts = openAccounts(join(dir, 'accounts.json'), { multiAccount: multi });
  accounts.markSignedIn('milkbasket', 'main', { hint: '••••••0000' });
  const amma = accounts.add('milkbasket', { name: 'Amma' });
  accounts.markSignedIn('milkbasket', amma.id, { hint: '••••••1234' });
  const store = openStore(':memory:');
  const used = [];
  const poolSet = { with: async (site, acc, fn) => { used.push(`${site}:${acc.id}`); return fn({ tab: async () => ({ acc: acc.id }) }); } };
  return { dir, accounts, store, poolSet, used, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('milkbasket flash deal: every signed-in account is checked; ₹1 / MRP ₹78 kept, conditions carried', async () => {
  const s = setup();
  try {
    const rows = parseList(fixture('milkbasket-flashdeal').data.getMegaFlashDealProducts).rows;
    let searched = 0;
    const sitesImpl = {
      milkbasket: { signedInOnly: true, offers: async (tab) => ({ rows: tab.acc === 'a2' ? rows.slice(0, 2) : rows, conditions: { maxQty: 1, minBasket: 9 } }), search: async () => { searched++; return []; } },
      instamart: { offers: async () => ({ rows: [{ name: 'Coconut water', price: 188, mrp: 356, inStock: true }] }), search: async () => { searched++; return []; } },
    };
    const out = await checkOffers({ ...s, sitesImpl, now: () => '2026-11-19T10:00:00.000Z' });
    assert.equal(searched, 0, 'offer check never searches products');
    assert.deepEqual(s.used, ['instamart:main', 'milkbasket:main', 'milkbasket:a2'], 'instamart guest main; both milkbasket accounts, in turn');
    assert.equal(out.offers.find((o) => o.site === 'instamart').deals, 0, '47% off is not a deal');
    const cur = s.store.currentDeals({ now: Date.parse('2026-11-19T10:05:00Z'), ...s.accounts.labels('milkbasket') });
    const mb = cur.groups.find((g) => g.site === 'milkbasket');
    const tomato = mb.deals.find((d) => /Tomato Desi/.test(d.product));
    assert.deepEqual([tomato.price, tomato.mrp], [1, 78]);
    assert.deepEqual(tomato.conditions, { maxQty: 1, minBasket: 9 });
    assert.deepEqual(tomato.seenBy.map((x) => x.name).sort(), ['Amma', 'Main']);
    assert.deepEqual(mb.conditions, { maxQty: 1, minBasket: 9 }, 'shared conditions go on the site line');
  } finally {
    s.cleanup();
  }
});

test('an account whose feed fails is reported with its name; the others still record', async () => {
  const s = setup();
  try {
    const sitesImpl = {
      milkbasket: {
        signedInOnly: true,
        offers: async (tab) => {
          if (tab.acc === 'a2') { const e = new Error('milkbasket: getMegaFlashDeal: Unauthorized'); e.kind = 'session'; throw e; }
          return { rows: [{ name: 'Potato', price: 1, mrp: 50, inStock: true }] };
        },
      },
    };
    const out = await checkOffers({ ...s, sitesImpl, sites: ['milkbasket'] });
    const bad = out.offers.find((o) => o.account === 'a2');
    assert.match(bad.error, /^milkbasket: getMegaFlashDeal: Unauthorized \(account "Amma"\)$/);
    const cur = s.store.currentDeals({ ...s.accounts.labels('milkbasket') });
    assert.equal(cur.groups[0].deals.length, 1);
    assert.equal(cur.errors[0].name, 'Amma');
  } finally {
    s.cleanup();
  }
});

test('milkbasket sign-in required: no signed-in account means no check (Instamart falls back to guest)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'basket-offers-'));
  try {
    const accounts = openAccounts(join(dir, 'accounts.json'), { multiAccount: multi });
    const used = [];
    const poolSet = { with: async (site, acc, fn) => { used.push(`${site}:${acc.id}`); return fn({ tab: async () => ({}) }); } };
    await checkOffers({ accounts, poolSet, sitesImpl: { milkbasket: { signedInOnly: true, offers: async () => ({ rows: [] }) }, instamart: { offers: async () => ({ rows: [] }) } } });
    assert.deepEqual(used, ['instamart:main']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feed paging stops at the last page, an empty page, or MAX_PAGES', () => {
  assert.equal(MAX_PAGES, 10);
  assert.equal(parseList({ products: [], pages: { hasNextPage: true } }).hasNext, false, 'empty page ends it even if the site says more');
  assert.equal(parseList(fixture('milkbasket-flashdeal').data.getMegaFlashDealProducts).hasNext, true);
});
