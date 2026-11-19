/**
 * Sites without a working guest API yet: search by rendering the site's
 * search page in the warm tab and running the legacy src/extract/* DOM
 * extractor. Slower (a full page per query) but still headless, and every
 * failure is a classified SiteError with the reason, never a silent [].
 */
import { EXTRACTORS } from '../../extract/index.js';
import { SiteError } from '../errors.js';

const REQUIRED = ['name', 'packSize', 'packUnit', 'price', 'mrp', 'inStock', 'url'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function domSearch(tab, key, query, { readyMs = 18000 } = {}) {
  const ex = EXTRACTORS[key];
  if (!ex) throw new SiteError('parse', `no DOM extractor "${key}"`, { site: key });
  await tab.goto(ex.searchUrl(query), { waitMs: 8000 });
  let ready = false;
  const deadline = Date.now() + readyMs;
  while (Date.now() < deadline) {
    ready = await tab.evaluate(ex.readyExpression, { timeoutMs: 5000 }).catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new SiteError('parse', `${key}: results never rendered`, { site: key });
  const out = await tab.evaluate(ex.extractExpression);
  if (out?.error) throw new SiteError('parse', `${key}: extractor: ${out.error}`, { site: key });
  const rows = (out?.rows || []).filter((r) => r && r.name && Number.isFinite(Number(r.price)));
  for (const r of rows) for (const f of REQUIRED) if (!(f in r)) throw new SiteError('parse', `${key}: row missing "${f}"`, { site: key });
  return rows.map((r) => ({
    name: String(r.name).trim(),
    packSize: r.packSize == null ? null : Number(r.packSize),
    packUnit: r.packUnit == null ? null : String(r.packUnit).toLowerCase(),
    price: Number(r.price),
    mrp: r.mrp == null ? null : Number(r.mrp),
    inStock: Boolean(r.inStock),
    url: String(r.url),
  }));
}

/**
 * Build a DOM-only site module.
 * @param {{ id: string, label: string, origin: string, note: string, locationCookies?: Function, setLocation?: Function }} def
 */
export function domSite(def) {
  return {
    domFallback: null, // search already is the DOM path; no second fallback
    parse: () => [],
    ...def,
    mode: 'dom',
    async search(tab, query) {
      const rows = await domSearch(tab, def.id, query);
      if (rows.length === 0) throw new SiteError('not_found', `${def.id}: no products rendered (experimental DOM site: ${def.note})`, { site: def.id });
      return rows;
    },
  };
}
