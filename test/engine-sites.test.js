import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SITES, SITE_IDS, getSite } from '../src/engine/sites/index.js';
import { bestPack, addressSearchText } from '../src/engine/sites/_util.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const fixture = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/sites/${name}.json`, import.meta.url)), 'utf8'));

function assertRows(rows) {
  assert.ok(rows.length >= 1, 'at least one product');
  for (const r of rows) {
    for (const f of ['name', 'packSize', 'packUnit', 'price', 'mrp', 'inStock', 'url']) assert.ok(f in r, `row has ${f}`);
    assert.equal(typeof r.name, 'string');
    assert.ok(r.price > 0, `price > 0 for ${r.name}`);
    assert.ok(r.mrp === null || r.mrp > r.price, 'mrp is null or above price');
    assert.match(r.url, /^https:\/\//);
  }
}

describe('site registry', () => {
  it('registers all nine sites with id, label, origin and a search function', () => {
    assert.deepEqual(
      [...SITE_IDS].sort(),
      ['amazon', 'bigbasket', 'blinkit', 'flipkart_minutes', 'instamart', 'jiomart', 'kpn', 'milkbasket', 'zepto'],
    );
    for (const id of SITE_IDS) {
      const s = getSite(id);
      assert.equal(s.id, id);
      assert.ok(s.label);
      assert.match(s.origin, /^https:\/\//);
      assert.equal(typeof s.search, 'function');
      assert.ok(['api', 'dom'].includes(s.mode), `${id} mode`);
    }
    assert.equal(getSite('nope'), null);
  });

  it('marks the eight guest-API sites as api; milkbasket is skipped', () => {
    const api = SITE_IDS.filter((id) => SITES[id].mode === 'api').sort();
    assert.deepEqual(api, ['amazon', 'bigbasket', 'blinkit', 'flipkart_minutes', 'instamart', 'jiomart', 'kpn', 'zepto']);
    assert.match(SITES.milkbasket.skip, /needs a login/);
  });
});

describe('pack and address helpers', () => {
  it('bestPack prefers mass inside parentheses over a pack count', () => {
    assert.deepEqual(
      { size: bestPack('1 pack (1 kg)').size, unit: bestPack('1 pack (1 kg)').unit },
      { size: 1000, unit: 'g' },
    );
    assert.equal(bestPack('500 g').size, 500);
    assert.equal(bestPack('6 pcs').unit, 'piece');
    assert.equal(bestPack(null, ''), null);
  });

  it('addressSearchText uses config searchText, then label + locality', () => {
    assert.equal(addressSearchText(DEFAULT_CONFIG.location), 'Marutham Prestige Tambaram');
    assert.equal(
      addressSearchText({ label: 'Marutham Prestige', address: 'Marutham Prestige, Bharathidasan Nagar, Krishna Nagar, Tambaram, Chennai' }),
      'Marutham Prestige Bharathidasan Nagar',
    );
    assert.equal(addressSearchText({ pincode: '600045' }), '600045');
  });
});

describe('instamart parser', () => {
  it('parses search/v2 items with offer price, mrp and pack', () => {
    const rows = SITES.instamart.parse(fixture('instamart-ok'));
    assertRows(rows);
    const udhaiyam = rows.find((r) => /Udhaiyam Toor Dal/.test(r.name));
    assert.ok(udhaiyam, 'local Chennai brand present (location took effect)');
    assert.equal(udhaiyam.packSize, 500);
    assert.equal(udhaiyam.packUnit, 'g');
    assert.equal(udhaiyam.price, 109);
  });

  it('sets the userLocation cookie from config', () => {
    const [c] = SITES.instamart.locationCookies(DEFAULT_CONFIG.location);
    assert.equal(c.name, 'userLocation');
    assert.equal(c.domain, '.swiggy.com');
    const v = JSON.parse(decodeURIComponent(c.value));
    assert.equal(v.lat, 12.9161793);
    assert.equal(v.lng, 80.0975106);
  });

  it('reports an unserviceable payload as unserviceable, not as no results', () => {
    assert.throws(
      () => SITES.instamart.parse({ data: { statusMessage: 'Location is not serviceable', cards: [] } }),
      (e) => e.kind === 'unserviceable' && /instamart/.test(e.message),
    );
    assert.deepEqual(SITES.instamart.parse({ data: { statusMessage: '', cards: [] } }), []);
  });
});

describe('bigbasket parser', () => {
  it('parses listing products with brand, pack and stock', () => {
    const rows = SITES.bigbasket.parse(fixture('bigbasket-ok'));
    assertRows(rows);
    assert.equal(rows[0].name, 'bb Popular Toor/Arhar Dal/Thuvaram Paruppu 1 kg');
    assert.equal(rows[0].price, 135);
    assert.equal(rows[0].mrp, 175);
    assert.equal(rows[0].packSize, 1000);
    assert.equal(rows.at(-1).inStock, false, 'avail_status other than 001 is out of stock');
  });

  it('drops ₹1 promo rows from a raw capture, keeps the shelf prices', () => {
    const rows = SITES.bigbasket.parse(fixture('bigbasket-raw'));
    assertRows(rows);
    assert.ok(rows.every((r) => r.price > 1), 'no ₹1 rows');
    assert.equal(rows.length, 4);
  });

  it('refuses an all-placeholder (₹1) listing as unserviceable', () => {
    const raw = fixture('bigbasket-raw');
    for (const p of raw.tabs[0].product_info.products) p.pricing.discount.prim_price.sp = '1';
    assert.throws(() => SITES.bigbasket.parse(raw), (e) => e.kind === 'unserviceable' && /placeholder/.test(e.message));
  });

  it('treats an unexpected shape as a parse error', () => {
    assert.throws(() => SITES.bigbasket.parse({ tabs: [{ product_info: { products: 'x' } }] }), (e) => e.kind === 'parse');
    assert.deepEqual(SITES.bigbasket.parse({}), []);
  });
});

describe('zepto parser', () => {
  it('parses product responses and converts paise; "1 pack (1 kg)" is 1 kg', () => {
    const rows = SITES.zepto.parse(fixture('zepto-ok'));
    assertRows(rows);
    const kg = rows.find((r) => /\(1 kg\)/.test(r.name));
    assert.ok(kg);
    assert.equal(kg.packSize, 1000);
    assert.equal(kg.packUnit, 'g');
    assert.ok(kg.price > 50 && kg.price < 500, `rupees, not paise: ${kg.price}`);
  });
});

describe('blinkit parser', () => {
  it('parses cart_item snippets', () => {
    const rows = SITES.blinkit.parse(fixture('blinkit-ok'));
    assertRows(rows);
    assert.ok(rows.every((r) => r.packUnit === 'g'));
  });

  it('sets lat/lon cookies from config', () => {
    const names = SITES.blinkit.locationCookies(DEFAULT_CONFIG.location).map((c) => `${c.name}=${c.value}`);
    assert.ok(names.includes('gr_1_lat=12.9161793'));
    assert.ok(names.includes('gr_1_lon=80.0975106'));
  });

  it('a payload without snippets is a parse error', () => {
    assert.throws(() => SITES.blinkit.parse({ is_success: false }), (e) => e.kind === 'parse');
  });
});

describe('kpn parser', () => {
  it('emits one row per pack from __NEXT_DATA__', () => {
    const rows = SITES.kpn.parse(fixture('kpn-ok'));
    assertRows(rows);
    const loose = rows.filter((r) => /Toor Dal Economy Loose/.test(r.name));
    assert.ok(loose.length >= 2, 'several packs of one product');
    assert.deepEqual(loose.map((r) => r.packSize).sort((a, b) => a - b).slice(0, 2), [250, 500]);
    assert.equal(loose[0].brand, null, '"Loose Staples" is not a brand');
  });

  it('404 NOT_FOUND means no results; other errors are blocked', () => {
    assert.deepEqual(SITES.kpn.parse({ statusCode: 404, errorCode: 'NOT_FOUND' }), []);
    assert.throws(() => SITES.kpn.parse({ statusCode: 500, errorCode: 'X' }), (e) => e.kind === 'blocked');
  });
});

describe('jiomart', () => {
  it('parses catalog items: effective price, marked MRP, pack, sellable', async () => {
    const rows = SITES.jiomart.parse(fixture('jiomart-ok'));
    assertRows(rows);
    assert.equal(rows[0].name, 'Good Life Unpolished Toor Dal 1 kg');
    assert.equal(rows[0].price, 201);
    assert.equal(rows[0].mrp, 265);
    assert.equal(rows[0].packSize, 1000);
    assert.equal(rows[4].inStock, false, 'sellable=false is out of stock');
    assert.match(rows[0].url, /^https:\/\/www\.jiomart\.com\/product\//);
  });

  it('turns "invalid pincode" into unserviceable with the message', () => {
    assert.throws(() => SITES.jiomart.parse({ success: false, message: 'invalid pincode' }), (e) => e.kind === 'unserviceable' && /invalid pincode/.test(e.message));
  });

  it('builds the location headers and cookies from config (city/state from the address)', async () => {
    const { locationHeaders, cityState } = await import('../src/engine/sites/jiomart.js');
    assert.deepEqual(cityState(DEFAULT_CONFIG.location), { city: 'CHENNAI', state: 'TAMIL_NADU' });
    const h = locationHeaders(DEFAULT_CONFIG.location);
    assert.equal(JSON.parse(h['x-location-detail']).pincode, '600045');
    assert.equal(JSON.parse(h['x-geolocation']).latitude, '12.9161793');
    const [details] = SITES.jiomart.locationCookies(DEFAULT_CONFIG.location);
    assert.equal(details.name, 'app_location_details');
    assert.equal(JSON.parse(decodeURIComponent(details.value)).city, 'CHENNAI');
  });
});

describe('flipkart minutes', () => {
  it('parses __INITIAL_STATE__ products: final price, MRP, pack from subtitle', () => {
    const rows = SITES.flipkart_minutes.parse(fixture('flipkart_minutes-ok'));
    assertRows(rows);
    assert.equal(rows[0].name, 'Value Toor/Arhar Dal 500 g');
    assert.equal(rows[0].price, 72);
    assert.equal(rows[0].mrp, 90);
    assert.equal(rows[0].packSize, 500);
    assert.equal(rows[0].brand, null, '"Unbranded" is not a brand');
    assert.equal(rows.find((r) => /Tata/.test(r.name)).packSize, 5000);
  });

  it('extracts the embedded state from HTML, braces inside strings included', async () => {
    const { embeddedJson } = await import('../src/engine/sites/flipkart_minutes.js');
    const html = '<script>window.__INITIAL_STATE__ = {"a":"x{y}","b":{"c":1}};</script>';
    assert.deepEqual(embeddedJson(html), { a: 'x{y}', b: { c: 1 } });
    assert.equal(embeddedJson('<html></html>'), null);
  });
});

describe('amazon now', () => {
  it('parses searchByKeyword products', () => {
    const rows = SITES.amazon.parse(fixture('amazon-ok'));
    assertRows(rows);
    assert.match(rows[0].name, /Tata Sampann Toor Dal/);
    assert.equal(rows[0].price, 179);
    assert.equal(rows[0].packSize, 1000);
    assert.match(rows[0].url, /amazon\.in\/dp\//);
  });

  it('reports an unserviceable pincode instead of "not found"', async () => {
    await assert.rejects(() => SITES.amazon.search({ _amazonServiceable: false }, 'toor dal'), (e) => e.kind === 'unserviceable' && /does not deliver/.test(e.message));
  });
});

describe('LIVE: guest searches at the configured location', { skip: !process.env.LIVE }, () => {
  it('each guest-API site returns priced products', async () => {
    const { BrowserPool } = await import('../src/engine/pool.js');
    const { launchChrome } = await import('../src/engine/chrome.js');
    const pool = new BrowserPool({
      profileDir: process.env.LIVE_PROFILE || '/tmp/cb-live-test',
      location: DEFAULT_CONFIG.location,
      launch: (o) => launchChrome({ ...o, port: 9339 }),
    });
    const ids = (process.env.LIVE_SITES || 'instamart,bigbasket,zepto,blinkit,kpn,jiomart,flipkart_minutes').split(',');
    try {
      const out = await Promise.all(ids.map(async (id) => [id, await SITES[id].search(await pool.tab(id), 'toor dal 1kg').catch((e) => e)]));
      for (const [id, rows] of out) {
        assert.ok(Array.isArray(rows), `${id}: ${rows?.message}`);
        assertRows(rows);
      }
    } finally {
      await pool.close();
    }
  });
});

describe('instamart throttling', () => {
  it('a 200 with {"statusCode":429} is a rate limit (blocked, retry after a pause), not "no results"', () => {
    assert.throws(
      () => SITES.instamart.parse({ stack: null, statusCode: 429 }),
      (e) => e.kind === 'blocked' && /rate limited/.test(e.message) && e.retryAfterMs > 0,
    );
  });

  it('product cards with no parseable price are a parse error, not an empty result', () => {
    assert.throws(
      () => SITES.instamart.parse({ data: { cards: [{ card: { card: { items: [{ displayName: 'X', variations: [{ displayName: 'X', price: {} }] }] } } }] } }),
      (e) => e.kind === 'parse',
    );
  });
});

describe('captured headers', () => {
  it('are re-captured once older than 20 minutes', async () => {
    const { ensureCaptured, MAX_AGE_MS } = await import('../src/engine/sites/_capture.js');
    let navigations = 0;
    const listeners = [];
    const tab = {
      on: (m, cb) => { if (m === 'Network.requestWillBeSent') listeners.push(cb); return () => {}; },
      waitForEvent: async () => null,
      goto: async () => {
        navigations++;
        for (const cb of listeners) cb({ request: { url: 'https://x/api/search?q=1', method: 'GET', headers: { sig: `s${navigations}` } } });
      },
    };
    const a = await ensureCaptured(tab, 'k', /api\/search/, 'https://x/');
    assert.equal(a.headers.sig, 's1');
    await ensureCaptured(tab, 'k', /api\/search/, 'https://x/');
    assert.equal(navigations, 1, 'fresh headers are reused');
    a.at = Date.now() - MAX_AGE_MS - 1;
    const b = await ensureCaptured(tab, 'k', /api\/search/, 'https://x/');
    assert.equal(navigations, 2);
    assert.equal(b.headers.sig, 's2');
  });
});
