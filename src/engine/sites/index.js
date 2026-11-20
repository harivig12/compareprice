/**
 * Site registry for the engine.
 *
 * mode 'api' — search is a site API call made from inside the warm tab.
 * mode 'dom' — search renders the site's page and scrapes it (no guest API yet).
 *
 * To add a site: write src/engine/sites/<id>.js exporting a default Site
 * object (see docs/ENGINE.md for the shape), then add it below.
 */
import instamart from './instamart.js';
import bigbasket from './bigbasket.js';
import zepto from './zepto.js';
import blinkit from './blinkit.js';
import kpn from './kpn.js';
import jiomart from './jiomart.js';
import flipkart_minutes from './flipkart_minutes.js';
import amazon from './amazon.js';
import milkbasket from './milkbasket.js';

const api = (s) => ({ mode: 'api', ...s });

export const SITES = Object.freeze({
  instamart: api(instamart),
  bigbasket: api(bigbasket),
  zepto: api(zepto),
  blinkit: api(blinkit),
  kpn: api(kpn),
  jiomart: api(jiomart),
  flipkart_minutes: api(flipkart_minutes),
  amazon: api(amazon),
  // Signed-in only; reads the catalogue + flash deal over GraphQL (API first).
  milkbasket: api(milkbasket),
});

export const SITE_IDS = Object.keys(SITES);

export function getSite(id) {
  return SITES[id] ?? null;
}
