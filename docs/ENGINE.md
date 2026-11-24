# The engine: how sites are searched

Read this before changing anything under `src/engine/`. Recon evidence and the history of why it is built this way: `docs/diagnosis/2026-11-16-api-platforms-failing.md`. Design: `docs/superpowers/specs/2026-11-16-basket-service-design.md`.

## Flow

```
compareBasket()                       src/compare.js
  └─ runSearch({sites, queries})      src/engine/run.js     one worker per site (parallel),
       │                                                    queries in order within a site
       ├─ pool.tab(site)              src/engine/pool.js    one Chrome, one warm tab per site
       │    ├─ setUserAgent           real UA, "Headless" removed, matching client hints
       │    ├─ site.locationCookies   set before the first load
       │    ├─ goto(site.origin)  →  assertNotWalled (Akamai/Cloudflare page ⇒ `blocked`)
       │    └─ site.setLocation       once; persisted in the profile
       ├─ site.search(tab, query)     src/engine/sites/<id>.js
       │    └─ pageFetch(tab, url)    fetch() runs INSIDE the page: real cookies, TLS, CORS
       │         └─ expectJson        HTTP/body → SiteError kind
       ├─ on session/blocked (or empty first query): wait retryAfterMs, pool.refresh, retry once
       ├─ still failing + site.domFallback: render the search page, run src/extract/<id>.js
       └─ circuit breaker: blocked / unserviceable / broken page ⇒ skip the site's remaining queries
```

Why the API calls run inside the page and not from Node:
- BigBasket (Akamai) and Blinkit (Cloudflare) block non-browser TLS.
- Zepto and Blinkit need headers that the page computes (store ids, csrf secret, request signature, auth_key).

Running inside the tab gets all of that for free. It's also why nothing is hardcoded.

## Chrome

`src/engine/chrome.js` launches `--headless=new` Chrome. It uses a persistent `--user-data-dir` (`<data>/chrome-profile`) and passes these flags:
- `--disable-blink-features=AutomationControlled`
- the background-throttling flags, so parallel tabs keep working

Every tab also gets `Emulation.setFocusEmulationEnabled`, for the same reason.

**The UA must match the real browser version.** BigBasket returned 403 when a Chrome/146 UA override ran on Chrome 156.

Other launch rules:
- `CDP_ENDPOINT` makes it attach to an existing Chrome instead of launching one.
- `CHROME_PATH` picks the binary.
- `BASKET_CHROME_NO_SANDBOX=1` (set in the Docker image) adds `--no-sandbox`.

**Lifecycle:**
- One-shot CLI commands close the pool when they finish (`closeEngine()` in `src/cli.js`).
- The service keeps it warm.
- On SIGINT/SIGTERM the pool closes Chrome before exiting. Chrome is a child process and outlives an abruptly killed parent on Linux.

## Error kinds (`src/engine/errors.js`)

| Kind | Meaning | Runner does |
|---|---|---|
| `session` | 401/419, or the page never issued the request whose headers we copy | refresh tab, retry once, then DOM fallback |
| `blocked` | 403/429, HTML where JSON was expected, a bot-wall page, a CORS-less gateway error ("Failed to fetch"), Instamart's in-body `statusCode: 429` | wait `retryAfterMs` if set, refresh, retry once, then DOM fallback; then stop the site (circuit breaker) |
| `unserviceable` | the site doesn't deliver to the location, the location couldn't be set, or BigBasket's all-₹1 placeholder prices | no retry; stop the site |
| `timeout` | the request ran into its deadline (20 s) | retry via fallback |
| `parse` | the payload shape changed (e.g. product cards without prices) | DOM fallback; for DOM-only sites, stop the site |
| `not_found` | the site answered with no match | recorded per query |
| `browser` | Chrome or the tab died, or CDP failed | that query fails; the next `tab()` relaunches |

Every message starts with the site id and carries the status or snippet. The UI and CLI show them verbatim.

## Request budget (`src/limits.js`)

None of these sites publishes a limit. The defaults come from what was observed:

| Site | Min gap | Per minute | Per hour | Cool-down after `blocked` |
|---|---|---|---|---|
| default | 2.5 s | 15 | 240 | 5 min |
| instamart | 3 s | 12 | 200 | 10 min (it sends `statusCode 429` in bursts) |
| bigbasket | 3 s | 12 | 200 | 30 min (Akamai IP walls) |
| amazon | 4 s | 8 | 120 | 30 min |

How it is applied:
- Engine searches `acquire()` a slot, so scheduled runs pace themselves. Each wait emits a `wait` progress event.
- Manual fresh runs are pre-checked by the server, which answers 429 with `waitMs`; the page shows the countdown.
- A `blocked` answer starts that site's cool-down.
- Override per site in `config.json → limits`.
- One OTP flow is limited to 3 requests per site per hour.

## Sign-in (`src/engine/login.js`)

Mobile → OTP flows for Milkbasket (`/login`), Zepto (the header's *Login*) and Amazon (`/ap/signin`, switching to OTP if a password is asked for).
- The session stays in the Chrome profile. `sessions.json` only records which site, when, and the last 4 digits.
- **These flows are written from the pages' structure and tested against a scripted fake. They have not been run against the live sites with a real OTP yet.** Every failing step names what the page said.

## Site module shape (`src/engine/sites/<id>.js`)

```js
export default {
  id: 'zepto', label: 'Zepto',
  origin: 'https://www.zepto.com/',        // page kept warm in the tab
  domFallback: 'zepto',                    // key into src/extract EXTRACTORS, or null
  locationCookies?(loc) -> Cookie[],       // set before the first load
  setLocation?(tab, loc) -> Promise<void>, // idempotent: check first, act only if needed
  parse(json) -> Product[],                // pure; throws SiteError for unserviceable/parse
  search(tab, query) -> Promise<Product[]>,
};
// Product = { name, brand?, packSize, packUnit, price, mrp, inStock, url }
```

Register it in `src/engine/sites/index.js`. To park a site, set `skip: '<reason>'`: the runner reports it as `unserviceable` without contacting it, and the UI greys it out. Mark it `mode: 'api'` if `search` calls an API, or build it with `domSite()` (`_dom.js`) if it scrapes the page.

**Helpers:**
- `_capture.js` (`watchRequest`, `ensureCaptured`) copies headers from the page's own request. It ignores CORS preflights, which only carry `Access-Control-Request-*`. Copied headers expire after 20 minutes (`MAX_AGE_MS`), and `pool.refresh()` clears them. Zepto rejected 2-hour-old ones at the 09:00 run on 2026-11-19.
- `_util.js`:
  - `bestPack` turns "1 pack (1 kg)" into 1 kg.
  - `cdpClick` and `typeText` send real mouse and keyboard events (React pickers ignore `el.click()`).
  - `addressSearchText` builds the text typed into address pickers.

### Adding or fixing a site

1. **Capture the site's own request.** Run Chrome with this engine (headless, with the matched UA), load the site's search page, and watch `Network.requestWillBeSent` for the XHR/fetch that returns products.
2. **Write `parse`** against a trimmed, scrubbed fixture in `test/fixtures/sites/` (see its README), then add a test to `test/engine-sites.test.js`.
3. **Write `search`** with `pageFetch` + `expectJson` + `parse`. If the request needs computed headers, copy them with `ensureCaptured`.
4. **Location.** Prefer cookies. If the site needs its picker, drive it once with `cdpClick`/`typeText`, then verify the result through a cookie the site sets. Throw `unserviceable` with the reason if it doesn't stick.
5. **Live check:** `LIVE=1 LIVE_SITES=<id> node --test test/engine-sites.test.js`.

**Be gentle during recon.** Fresh profiles and repeated hits got this IP temporarily blocked by BigBasket's Akamai (hours) and rate-limited by Instamart (`statusCode: 429`) on 2026-11-18. Reuse one profile and pace requests.

## Site status

As of 2026-11-18, guest, at Marutham Prestige, Tambaram 600045:

| Site | Status | Evidence / reason |
|---|---|---|
| instamart | ✅ API | Local brands (Udhaiyam) confirm the location. Throttles bursts. |
| bigbasket | ✅ API | Location set via the picker, `_bb_pin_code=600045`. Watch out for Akamai blocks. |
| zepto | ⚠ API, needs sign-in at the located store (2026-11-19) | Picker sets the Krishna Nagar store. Store ids differ from the Bangalore default. |
| blinkit | ✅ API | Coordinates via cookies. 12 products per query. |
| kpn | ✅ HTML+JSON | `__NEXT_DATA__`. Chennai default store. |
| jiomart | ✅ API (2026-11-18) | `catalog/v1.0/products?f=journey:standard:::department:groceries` with `x-location-detail` + `x-geolocation` headers. Without them it answers 400 "invalid pincode". The cookies need city **and** state (`CHENNAI`, `TAMIL_NADU`), or the page resets them to Mumbai. Quick delivery (`journey:quickcommerce:::store_ids:`) is not used: the store ids only come from a signed `delivery-promise` call, and the ids the page shows were the same for Mumbai and Chennai. |
| amazon | ✅ API, ⛔ not serviceable at 600045 (2026-11-19) | `/tez/browse/searchByKeyword` JSON. Pincode set with `POST /portal-migration/hz/glow/address-change` (token from `get-location-label`). The page's `validateLocation` returns `isServiceable: false` for 600045, and search returns 0 products. With the IP guess 600042 it returned products. The old `/s?k=&i=nowstore` URL returned 503 "rush hour", and regular `/s?k=` search is plain Amazon, not Now (its DOM price parse also doubled prices, e.g. 211211). |
| flipkart_minutes | ✅ HTML+JSON (2026-11-18) | Without an address it redirects to `/hyperlocal-preview-page` about 3 s after load. The guest picker ("Search by area, street name, pin code" → suggestion → Confirm) calls `api/1/location/serviceability` and `api/4/location/update` and is remembered by the session (`at`/`SN`/`T` cookies, 6–12 months). Products come from `window.__INITIAL_STATE__` in `/search?q=&marketplace=HYPERLOCAL`. A lost address is reported as `session`, so the runner refreshes and retries. |
| milkbasket | ⛔ skipped (`skip` in `dom-sites.js`) | Correction 2026-11-19: a web login **does** exist at `/login` (mobile → OTP); there's just no link to it for guests. Recon 2026-11-18: guests have no location or pincode input. Every guest GraphQL call sends `cityid: 1, hubid: 1` (its default city), and `/search?q=` renders a brand store instead of results. The runner reports `unserviceable … skipped` without opening a tab. |
