/**
 * Extractor registry + runner.
 *
 * Each extractor is the webcmd-adapter shape: a search URL builder, a readiness
 * expression, and an extraction expression that runs in page context and
 * returns rows in the shared envelope.
 */

import { withTab } from '../browser.js';
import * as blinkit from './blinkit.js';
import * as zepto from './zepto.js';
import * as bigbasket from './bigbasket.js';
import * as amazon from './amazon.js';
import * as instamart from './instamart.js';
import * as jiomart from './jiomart.js';
import * as milkbasket from './milkbasket.js';
import * as flipkart_minutes from './flipkart_minutes.js';
import * as kpn from './kpn.js';

export const EXTRACTORS = {
  blinkit,
  zepto,
  bigbasket,
  amazon,
  instamart,
  jiomart,
  milkbasket,
  flipkart_minutes,
  kpn,
};

const REQUIRED = ['name', 'packSize', 'packUnit', 'price', 'mrp', 'inStock', 'url'];

function validate(rows, site) {
  if (!Array.isArray(rows)) throw new Error(`${site}: extractor returned no rows array`);
  return rows
    .filter((r) => r && r.name && Number.isFinite(Number(r.price)))
    .map((r) => {
      for (const f of REQUIRED) {
        if (!(f in r)) throw new Error(`${site}: row missing "${f}"`);
      }
      return {
        name: String(r.name).trim(),
        packSize: r.packSize == null ? null : Number(r.packSize),
        packUnit: r.packUnit == null ? null : String(r.packUnit).toLowerCase(),
        price: Number(r.price),
        mrp: r.mrp == null ? null : Number(r.mrp),
        inStock: Boolean(r.inStock),
        url: String(r.url),
      };
    });
}

/**
 * Search one site for one query using the live browser.
 * @returns {Promise<Array>} envelope rows
 */
async function attempt(site, query, waitMs) {
  const ex = EXTRACTORS[site];
  return withTab(async (page) => {
    await page.goto(ex.searchUrl(query), { waitMs, retries: 2 });

    const ready = await page.waitFor(ex.readyExpression, { timeoutMs: 18000 });
    if (!ready) {
      // Distinguish "site is broken" from "this query genuinely has no results".
      const hasShell = await page.evaluate('!!document.body').catch(() => false);
      throw new Error(hasShell ? 'results never rendered' : 'page failed to load');
    }

    let out = await page.evaluate(ex.extractExpression);
    if (out?.error) throw new Error(`extractor: ${out.error}`);

    // If Amazon Now returns no results/fallbackNeeded, attempt Tez quick-commerce browse search
    if (site === 'amazon' && (out?.fallbackNeeded || (out?.rows && out.rows.length === 0)) && typeof ex.tezSearchUrl === 'function') {
      const fallbackUrl = ex.tezSearchUrl(query);
      await page.goto(fallbackUrl, { waitMs: 4000, retries: 1 });
      const tezReady = await page.waitFor(ex.readyExpression, { timeoutMs: 15000 });
      if (tezReady) {
        const tezOut = await page.evaluate(ex.extractExpression);
        if (tezOut?.rows && tezOut.rows.length > 0) {
          out = tezOut;
        }
      }
    }

    return validate(out?.rows, site);
  });
}

/**
 * Search one site for one query using the live browser.
 *
 * Retries once on an empty result. These sites intermittently render an empty
 * grid under load — observed repeatedly with Zepto, where common staples came
 * back with zero rows on one pass and full results on the next. Treating that
 * first empty as truth makes a platform look out of stock and hands it a
 * falsely cheap basket, so it is worth one more attempt before believing it.
 *
 * @returns {Promise<Array>} envelope rows
 */
export async function searchViaBrowser(site, query, { waitMs = 6000 } = {}) {
  if (!EXTRACTORS[site]) throw new Error(`no extractor for "${site}"`);

  let rows = await attempt(site, query, waitMs);
  if (rows.length === 0) {
    await new Promise((r) => setTimeout(r, 1200));
    rows = await attempt(site, query, waitMs + 3000);
  }
  return rows;
}
