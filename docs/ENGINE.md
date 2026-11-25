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
- `JHOLA_CHROME_NO_SANDBOX=1` (set in the Docker image) adds `--no-sandbox`.

**Lifecycle:**
- One-shot CLI commands close the pool when they finish (`closeEngine()` in `src/cli.js`).
- The service keeps it warm between searches, then **closes Chrome after `browser.idleCloseMs` (default 5 min) with no job, queued job or sign-in in progress** (`src/engine/idle.js`, checked every 30 s). Idle Chrome cost ~1 GB and 50–75% of a core, mostly site pages animating in background tabs (JioMart's home page alone ran 361 ms of script per second). The next search relaunches it with the same profile, so sessions and picked addresses survive; the first search after a close pays the launch and page-load time again. Set `idleCloseMs: 0` to keep it always warm.
- The sign-in tab is the site's search tab (same session). It's closed as soon as a sign-in finishes or fails, unless a job is running; then it stays open for that job and only gets its media block back (`releaseLoginTab`).
- Search tabs block images, fonts and media (`browser.blockMedia`, default on) via `Network.setBlockedURLs`. Prices come from JSON and HTML, never from pictures. Turn it off if a site starts treating the missing requests as a bot signal.
- Chrome's disk cache is capped at 50 MB (`--disk-cache-size`).
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

## Accounts, API first, deals (2026-11-19)

- **User-agent (2026-11-25).** Headless Chrome reports `HeadlessChrome` (user-agent and `sec-ch-ua` brand) and bot walls reject it on sight. `Network.setUserAgentOverride` fixes one tab but only **while the connection that set it stays open**: close it, or open a tab from another script, and the tab says HeadlessChrome again (proved with a real Chrome: fresh tab, second script, closed connection). Three layers now: (1) `ua-guard.js`, started by `launchChrome`, keeps one browser-level connection that auto-attaches to every page, existing and new, sets the override before the page runs and lets it go, so even a tab a script opens is real Chrome; (2) the pool sets the exact override per tab with the page's own client hints (`CdpTab.setUserAgent`); (3) `assertRealUserAgent` refuses to load a site from a tab that still says HeadlessChrome, and `assertNotWalled` labels a wall on such a tab as our leak (`code: headless_ua`), which does not count toward BigBasket's switch to a headed browser.
- **BigBasket's own Chrome** (since 1.3, `SitePools` in `src/engine/pool.js`, `OWN_PROFILES` in `accounts.js`): `getPool()` returns one pool to callers, but BigBasket's calls go to a second `BrowserPool` on `<data>/profiles/bigbasket` (port 9350). It starts headless. Every bot-wall check (`assertNotWalled`, on tab open and refresh) is reported to `src/engine/browser-mode.js`; two walls in a row switch it to headed (kept in `<data>/browser-mode.json`), and the next use relaunches it. On Linux without `$DISPLAY`, `src/engine/display.js` starts Xvfb on `:99` for it (the Docker image ships `xvfb`).
- **Zepto coupons and payment offers** (`src/engine/sites/zepto-offers.js`, `zepto.offers`): `POST bff-gateway.zepto.com/cfs/api/v1/cart/coupons/fetch-list` with `activeTab` `PAYMENT_OFFERS_TAB` or `COUPONS_TAB` returns one `COUPON_CARD_WIDGET` per offer (title, code in the button's action, "Shop for ₹X more to unlock", state, terms). With an empty cart it returns **no offers**, so the check asks first; offers back means the account's cart has items and it is only read. Otherwise `PUT /cfs/api/v1/cart` puts the cheapest in-stock search result in, both lists are read, and `PUT` with no products empties it again (3 tries, verified by `itemQuantityCount`; failing that, the check reports "Remove \"…\" in Zepto"). The page's own `/cfs/` request supplies the headers; `localStorage.cart.state.cartId` the cart id; the store comes from the home page's `storeServiceableResponse`. Rows go to `offer_lists` and `/api/deals` → `offerLists`. Signed-in only; `deals.zeptoCart: false` skips the cart part.
- **BigBasket deal storefronts** (`bigbasket.offers`): the offer check reads the six storefronts (`STOREFRONTS`, plus home-page `/sp/` links with the same names) through `listing-svc/v2/products?type=sis&slug=<storefront>&page=N`, up to `STOREFRONT_MAX_PAGES` (10) each, one call at a time through the site budget. Every discount is kept (`offersMinPct: 0`); rows carry `conditions.storefront`, and `/api/deals` returns one group per storefront with `storefront` and `anyDiscount: true`. Out-of-stock rows and rows with no MRP discount are left out.
- **Accounts** (`src/engine/accounts.js`, `<data>/accounts.json`): the main account per site in `chrome-profile` (BigBasket: `profiles/bigbasket`), and extra accounts (`LOGIN_SITES[site].multiAccount`: Instamart, Milkbasket; max 3) in `profiles/<site>-<id>`.
- **PoolSet** (`src/engine/poolset.js`): an extra account gets its own `BrowserPool` (own profile and port 9400+), launched for one step and closed straight after; one step at a time per account. The main account uses the shared pool. `ownLocation` keeps a signed-in account's saved address: location cookies are only added when missing, and pickers don't run (passive hooks like Instamart's header watcher still do).
- **API first** (`src/engine/direct.js`, `site.direct`): `apiFetch` sends the call from Node with the tab's cookies and the page's own headers, all in memory. A refusal (network error, 403, HTML) switches that tab to `pageFetch` for the rest of its life and logs `<site>: direct API call refused (HTTP n); using the browser tab instead`. Enabled for Instamart and Milkbasket only (recon in docs/diagnosis/2026-11-19-account-offers-zepto-milkbasket.md).
- **Per-account search** (`site.perAccountSearch`: Instamart): `compareBasket()` searches each extra signed-in account after the main run, tags each row with its `account`, and the scorer keeps the cheapest. A failing account adds a partial failure naming it.
- **Milkbasket** (`src/engine/sites/milkbasket.js`, `signedInOnly`):
  - Session headers come from the page's GraphQL calls that carry `authorization`. Hub and city come from the account's `localStorage` (`MB_PERSIST_USER_HUB` / `MB_PERSIST_USER_CITY`), because the app's first calls use the default city 1/1.
  - Search reads the catalogue (cached 20 h) and shortlists with `matchCatalog`. That drops negated mentions such as "Low Sugar Potato" or "Sugar Free …"; the scorer then decides.
  - `offers()` reads `getMegaFlashDeal` → `getMegaFlashDealProducts`, stopping at the last page, an empty page, or 10 pages.
  - Query documents are in `milkbasket/queries.js`. If Milkbasket renames a field, the server answers `GRAPHQL_VALIDATION_FAILED` and the module reports `parse`.
- **Instamart `offers()`**: the home feed (`/api/instamart/home/v2`); no separate deal feed exists.
- **Deals** (`src/deals.js`): `price ≤ (1 − pct/100) × MRP`, with no MRP never counting. They're collected from every raw search candidate (before the price check) and from the offer feeds (`src/offers.js`), and stored in the `deals` and `deal_checks` tables.

## Categories and product groups (2026-11-20)

- Every row carries `category`: the site's own path, joined with ` › `, or `null`.
  - BigBasket: `tlc › mlc › llc`.
  - Instamart: variation `superCategory › category › subCategoryType`.
  - Milkbasket: `category › subCategory › type`.
  - KPN: `l0 › l1`, with the "(1_13)" ids dropped.
  - Zepto: `primaryCategoryName`.
  - JioMart: `l3-category`.
  - Blinkit, Amazon and Flipkart Minutes send none.
- It is saved in `prices.category`.
- `src/categories.js` turns title + category into a group: `staple`, `packaged`, `sweets` or `pooja`. The word lists and their sources are in `docs/diagnosis/2026-11-20-category-trigger-words.md`.
  - Title words are only the safe ones.
  - Risky words ("sweet", "frozen", "instant") count only inside a category path.
  - The top level of a multi-level path never refuses: BigBasket files milk under "Bakery, Cakes & Dairy".
- `pickBest`:
  - Refuses **sweets and pooja** unless the line names them ("ghee laddu", "pooja oil").
  - Then picks from the best tier present:
    1. the category this line usually lands in on this site (`store.prefsFor`: 2+ visible staple rows);
    2. staples;
    3. packaged, or demoted by an AI label.
  - Packaged is still returned when it is all there is.
- **AI labels** (`product_groups`, optional, `src/ai/`) only demote. They never refuse or hide, because they can be wrong. Even demotion is narrow:
  - It applies only on a line known to be a staple: 2+ of its saved products are labelled, and staple is the most common label.
  - It never touches a product already saved for that line.

  So in practice it pushes a new, different kind of product down, such as a ghee masala paste found in a "ghee" search. See `store.prefsFor` (`lineGroup`, `saved`).

## Sign-in (`src/engine/login.js`)

Mobile → OTP flows for Milkbasket (`/login`), Zepto (the header's *Login*) and Instamart (swiggy.com → *Sign in* → *Login*; `open` may list several clicks, each tried only while the number box is missing); number or email → password for Amazon (`/ap/signin`).

Instamart sign-in is optional: it runs in the same swiggy.com tab and session as Instamart searches, so a signed-in account searches with its own prices; without it, searches stay guest.
- The session stays in the Chrome profile. `sessions.json` only records which site, when, and a masked hint (last 4 digits, or `a•••@domain`).
- **Asynchronous.** `LoginManager.start()` checks the id and the limits, returns at once, and drives the page in the background. States: `idle → sending → otp_sent | password_needed → verifying → signed_in`, or `error`; after a password, also `otp_sent` (a two-step code) or `approve_needed`. The popup polls `GET /api/login` (see docs/API.md). Resend needs a 30 s gap; at most 3 OTP requests per site per hour.
- **OTP screen detection** (`OTP_SCREEN_JS`) accepts one OTP box *or* a row of split boxes. Milkbasket shows four `tel` inputs where the first has `maxlength=4` and the rest `maxlength=1`; the old check wanted four `maxlength=1` boxes, so the OTP was sent but the popup never moved to the OTP step. `verifyLogin` types one digit per box when the boxes are split (`OTP_BOXES_JS`).
- **Amazon signs in with a password**, checked on 2026-11-19: amazon.in/now → Sign in → number → password, with no OTP option.
  - The id can be the mobile number or the account email (`acceptsEmail`). `startLogin` stops at the password page (`step: 'password'`, state `password_needed`), and `submitPassword` types it on Amazon's page and ticks "Keep me signed in".
  - Then one of: signed in (it leaves `/ap/` / `/ax/`); a two-step verification code (state `otp_sent`, the normal OTP step); approval on the phone (`approve_needed`, then `checkApproved`); a puzzle (`blocked`, code `captcha`; it can't be solved here, so sign in once in a normal browser); or a wrong password (`wrong_password`, stays on the step, 3 tries per sign-in).
  - The password isn't stored, logged or put in an error message. Chrome's own password manager is switched off in the profile before every launch (`disablePasswordSaving`, `credentials_enable_service: false`), so it never lands in `Login Data`.
- Amazon: if the number has no account, the failure says so (`noAccount`) rather than timing out.
- A wrong OTP is told apart from other failures by `SiteError.code` (`wrong_otp`, `bad_otp`), never by message text. It keeps the OTP step open.
- Page text quoted in an error goes through `pageSnippet()`, which keeps only the last 4 digits of any phone-like number, because these messages reach the log and the popup.
- **These flows are written from the pages' structure and tested against a scripted fake. Milkbasket's OTP screen was checked on the live page; a full live sign-in with a real OTP hasn't been done yet.** Every failing step names what the page said.

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
| zepto | ✅ API, signed in (needs sign-in at the located store since 2026-11-19) | Picker sets the Krishna Nagar store. Store ids differ from the Bangalore default. Signed in, the page searches with `POST user-search-service/api/v3/search`; `searchRequest()` replays it with the page's body and our query (guest pages still use `GET …/v1/search`). |
| blinkit | ✅ API | Coordinates via cookies. 12 products per query. |
| kpn | ✅ HTML+JSON | `__NEXT_DATA__`. Chennai default store. |
| jiomart | ✅ API (2026-11-18) | `catalog/v1.0/products?f=journey:standard:::department:groceries` with `x-location-detail` + `x-geolocation` headers. Without them it answers 400 "invalid pincode". The cookies need city **and** state (`CHENNAI`, `TAMIL_NADU`), or the page resets them to Mumbai. Quick delivery (`journey:quickcommerce:::store_ids:`) is not used: the store ids only come from a signed `delivery-promise` call, and the ids the page shows were the same for Mumbai and Chennai. |
| amazon | ✅ API, ⛔ not serviceable at 600045 (2026-11-19) | `/tez/browse/searchByKeyword` JSON. Pincode set with `POST /portal-migration/hz/glow/address-change` (token from `get-location-label`). The page's `validateLocation` returns `isServiceable: false` for 600045, and search returns 0 products. With the IP guess 600042 it returned products. The old `/s?k=&i=nowstore` URL returned 503 "rush hour", and regular `/s?k=` search is plain Amazon, not Now (its DOM price parse also doubled prices, e.g. 211211). |
| flipkart_minutes | ✅ HTML+JSON (2026-11-18) | Without an address it redirects to `/hyperlocal-preview-page` about 3 s after load. The guest picker ("Search by area, street name, pin code" → suggestion → Confirm) calls `api/1/location/serviceability` and `api/4/location/update` and is remembered by the session (`at`/`SN`/`T` cookies, 6–12 months). Products come from `window.__INITIAL_STATE__` in `/search?q=&marketplace=HYPERLOCAL`. A lost address is reported as `session`, so the runner refreshes and retries. |
| milkbasket | ⛔ skipped (`skip` in `dom-sites.js`) | Correction 2026-11-19: a web login **does** exist at `/login` (mobile → OTP); there's just no link to it for guests. Recon 2026-11-18: guests have no location or pincode input. Every guest GraphQL call sends `cityid: 1, hubid: 1` (its default city), and `/search?q=` renders a brand store instead of results. The runner reports `unserviceable … skipped` without opening a tab. |
