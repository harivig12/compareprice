import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXTRACTORS } from '../src/extract/index.js';
import { renderTui } from '../src/tui.js';

describe('New Platforms & Amazon Tez', () => {
  it('exposes amazon with searchUrl and tezSearchUrl', () => {
    const amazon = EXTRACTORS.amazon;
    assert.ok(amazon);
    assert.match(amazon.searchUrl('IDHAYAM Sesame Oil 1 Ltr'), /nowstore/);
    assert.match(amazon.tezSearchUrl('IDHAYAM Sesame Oil 1 Ltr'), /tez\/browse\/search/);
    assert.match(amazon.tezSearchUrl('IDHAYAM Sesame Oil 1 Ltr'), /qcbrand=qqfsWw9RkO/);
  });

  it('exposes jiomart, instamart, and milkbasket in EXTRACTORS', () => {
    assert.ok(EXTRACTORS.jiomart);
    assert.ok(EXTRACTORS.instamart);
    assert.ok(EXTRACTORS.milkbasket);
    assert.ok(EXTRACTORS.flipkart_minutes);
    assert.ok(EXTRACTORS.kpn);

    assert.equal(EXTRACTORS.flipkart_minutes.site, 'flipkart_minutes');
    assert.match(EXTRACTORS.flipkart_minutes.searchUrl('amul butter'), /marketplace=HYPERLOCAL/);

    assert.equal(EXTRACTORS.kpn.site, 'kpn');
    assert.match(EXTRACTORS.kpn.searchUrl('moong dal'), /kpnfresh\.com\/search\?q=moong%20dal/);

    assert.equal(EXTRACTORS.jiomart.site, 'jiomart');
    assert.match(EXTRACTORS.jiomart.searchUrl('amul butter'), /jiomart\.com\/search/);

    assert.equal(EXTRACTORS.instamart.site, 'instamart');
    assert.match(EXTRACTORS.instamart.searchUrl('amul butter'), /swiggy\.com\/instamart/);

    assert.equal(EXTRACTORS.milkbasket.site, 'milkbasket');
    assert.match(EXTRACTORS.milkbasket.searchUrl('amul butter'), /milkbasket\.com\/search/);

    // No hardcoded tokens in the DOM extractors: API paths live in src/engine/sites.
    assert.equal(EXTRACTORS.milkbasket.searchApi, undefined);
    assert.equal(EXTRACTORS.instamart.searchApi, undefined);
  });

  it('renders TUI with wrapped rows without throwing', () => {
    const mockReport = {
      pincode: '110048',
      elapsedMs: 2500,
      backend: 'cdp',
      labels: {
        blinkit: 'Blinkit',
        zepto: 'Zepto',
        bigbasket: 'BigBasket',
      },
      platforms: [
        {
          platform: 'blinkit',
          total: 250,
          fulfilledLines: 1,
          totalLines: 1,
          fees: { known: false },
          lines: [
            {
              query: 'amul taaza fresh toned milk pasteurized 500ml pouch',
              lineTotal: 250,
              status: 'exact',
              product: {
                packs: 1,
                packLabel: '500ml pouch carton pack',
                pricePerUnitLabel: '₹50.00 / 100ml',
              },
            },
          ],
        },
        {
          platform: 'zepto',
          total: 260,
          fulfilledLines: 1,
          totalLines: 1,
          fees: { known: false },
          lines: [
            {
              query: 'amul taaza fresh toned milk pasteurized 500ml pouch',
              lineTotal: 260,
              status: 'exact',
              product: {
                packs: 1,
                packLabel: '500ml pouch carton pack',
                pricePerUnitLabel: '₹52.00 / 100ml',
              },
            },
          ],
        },
      ],
      basket: [
        { qty: 1, query: 'amul taaza fresh toned milk pasteurized 500ml pouch' },
      ],
      winner: { platform: 'blinkit', total: 250 },
      likeForLike: true,
      feesKnown: false,
    };

    const output = renderTui(mockReport);
    assert.ok(typeof output === 'string');
    assert.match(output, /BASKET/);
    assert.match(output, /₹250\.00/);
    assert.match(output, /BLINKIT/);
  });

  it('selectBackend defaults to the engine and never silently swaps', async () => {
    const { selectBackend } = await import('../src/platforms.js');
    assert.equal(await selectBackend({}), 'engine');
    assert.equal(await selectBackend({ BASKET_BACKEND: 'engine' }), 'engine');
  });

  it('searchOne rejects an unknown backend with the platform name', async () => {
    const { searchOne } = await import('../src/platforms.js');
    await assert.rejects(() => searchOne('blinkit', 'salt', 'nope'), /blinkit: unknown backend "nope"/);
  });
});

