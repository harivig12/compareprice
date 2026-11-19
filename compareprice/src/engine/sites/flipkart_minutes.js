/**
 * Flipkart Minutes — guest, server-rendered.
 *
 * Location: held server-side against the guest session cookies (`at`, `SN`,
 *           `T`; 6–12 months). With no address the hyperlocal search
 *           redirects to /hyperlocal-preview-page. The guest picker
 *           ("Search by area, street name, pin code" -> suggestion ->
 *           "Confirm") calls rome /api/1/location/serviceability and
 *           /api/4/location/update. Driven once; the profile keeps it.
 * Search:   /search?q=<q>&marketplace=HYPERLOCAL is server-rendered; products
 *           are in window.__INITIAL_STATE__ ...widget.data.products[].productInfo.value
 *           {titles.title/subtitle, pricing.finalPrice.value, pricing.prices[MRP],
 *            availability.displayState, smartUrl}. Fetched from inside the tab.
 * Recon: docs/diagnosis/2026-11-16-api-platforms-failing.md (2026-11-18).
 */
import { pageFetch } from '../page-fetch.js';
import { SiteError } from '../errors.js';
import { bestPack, cdpClick, typeText, addressSearchText } from './_util.js';

const ID = 'flipkart_minutes';
const ORIGIN = 'https://www.flipkart.com/search?q=dal&marketplace=HYPERLOCAL';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The JSON object assigned to `marker` in an HTML page (string-aware brace match). */
export function embeddedJson(html, marker = 'window.__INITIAL_STATE__') {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  return null;
}

function collect(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return out;
  }
  if (node.productInfo?.value?.pricing) {
    out.push(node.productInfo.value);
    return out;
  }
  for (const k of Object.keys(node)) collect(node[k], out);
  return out;
}

/** Pure: __INITIAL_STATE__ -> envelope rows. */
export function parse(state) {
  const rows = [];
  const seen = new Set();
  for (const p of collect(state)) {
    const price = Number(p.pricing?.finalPrice?.value);
    if (!(price > 1)) continue;
    const key = p.id || p.smartUrl || p.titles?.title;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = p.titles?.title || p.titles?.newTitle || '';
    const size = p.titles?.subtitle || '';
    const mrp = Number((p.pricing?.prices || []).find((x) => x.priceType === 'MRP')?.value);
    const pack = bestPack(size, title);
    const brand = typeof p.productBrand === 'string' && !/^unbranded$/i.test(p.productBrand) ? p.productBrand : p.titles?.superTitle || null;
    rows.push({
      name: size && !title.includes(size) ? `${title} ${size}` : title,
      brand,
      packSize: pack ? pack.size : null,
      packUnit: pack ? pack.unit : null,
      price,
      mrp: mrp > price ? mrp : null,
      inStock: (p.availability?.displayState || 'IN_STOCK') === 'IN_STOCK',
      url: p.smartUrl || (p.baseUrl ? `https://www.flipkart.com${p.baseUrl}` : 'https://www.flipkart.com/'),
    });
  }
  return rows;
}

const needsAddress = (href) => /hyperlocal-preview-page|user-address/.test(String(href));

export default {
  id: ID,
  label: 'Flipkart Minutes',
  origin: ORIGIN,
  domFallback: null,

  async setLocation(tab, loc) {
    // The page redirects to the address sheet a few seconds after load when
    // the session has no address; when it has one, products (₹) render.
    let state = 'unknown';
    for (let i = 0; i < 30 && state === 'unknown'; i++) {
      const s = await tab
        .evaluate(`({ href: location.href, priced: /₹\\s?\\d/.test(document.body?.innerText || '') })`)
        .catch(() => ({ href: '', priced: false }));
      if (needsAddress(s.href)) state = 'needs';
      else if (s.priced) state = 'located';
      else await sleep(500);
    }
    if (state === 'located') return;
    if (state === 'unknown') throw new SiteError('unserviceable', `${ID}: search page neither rendered products nor asked for an address`, { site: ID });
    const input = await cdpClick(tab, `[...document.querySelectorAll('input')].find((i) => /area, street|pin ?code/i.test(i.placeholder || ''))`, { waitMs: 15000 });
    if (input == null) throw new SiteError('unserviceable', `${ID}: address search box not found`, { site: ID });
    const needle = addressSearchText(loc);
    await typeText(tab, needle);
    await sleep(1500);
    const first = needle.split(' ').slice(0, 2).join(' ');
    const pick = await cdpClick(
      tab,
      `(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (n.textContent.trim().startsWith(${JSON.stringify(first)}) && n.parentElement.getClientRects().length && n.parentElement.tagName !== 'INPUT') return n.parentElement; } return null; })()`,
      { waitMs: 10000 },
    );
    if (!pick) throw new SiteError('unserviceable', `${ID}: no address suggestion for "${needle}"`, { site: ID });
    const confirm = await cdpClick(
      tab,
      `[...document.querySelectorAll('button,div,span')].filter((e) => e.getClientRects().length && e.children.length < 3 && /^confirm/i.test(e.textContent.trim())).pop()`,
      { waitMs: 10000 },
    );
    if (!confirm) throw new SiteError('unserviceable', `${ID}: "Confirm" not found after picking "${pick}"`, { site: ID });
    for (let i = 0; i < 20 && needsAddress(await tab.evaluate('location.href').catch(() => '')); i++) await sleep(700);
    const text = await tab.evaluate(`document.body?.innerText || ''`).catch(() => '');
    if (needsAddress(await tab.evaluate('location.href').catch(() => ''))) {
      throw new SiteError('unserviceable', `${ID}: address "${pick}" was not accepted`, { site: ID });
    }
    if (/not (yet )?(serviceable|available)|coming soon/i.test(text) && !/₹/.test(text)) {
      throw new SiteError('unserviceable', `${ID}: Flipkart Minutes does not deliver to ${loc.label || loc.pincode}`, { site: ID });
    }
  },

  parse,

  async search(tab, query) {
    const res = await pageFetch(tab, `/search?q=${encodeURIComponent(query)}&marketplace=HYPERLOCAL`, {}, { timeoutMs: 25000 });
    if (res.timedOut) throw new SiteError('timeout', `${ID}: timed out after ${res.ms} ms`, { site: ID });
    if (res.status === 403 || res.status === 429) throw new SiteError('blocked', `${ID}: ${res.status} blocked`, { site: ID, status: res.status });
    if (res.status >= 400) throw new SiteError('blocked', `${ID}: ${res.status} error`, { site: ID, status: res.status });
    let state;
    try {
      state = embeddedJson(res.text);
    } catch (e) {
      throw new SiteError('parse', `${ID}: __INITIAL_STATE__ is not JSON`, { site: ID, cause: e });
    }
    if (!state) throw new SiteError('parse', `${ID}: search page has no __INITIAL_STATE__`, { site: ID });
    const rows = parse(state);
    if (rows.length === 0 && /hyperlocal-preview-page|Select delivery address/i.test(res.text.slice(0, 300000))) {
      // The guest session lost its address: the runner refreshes and retries.
      throw new SiteError('session', `${ID}: delivery address is not set for this session`, { site: ID });
    }
    return rows;
  },
};
