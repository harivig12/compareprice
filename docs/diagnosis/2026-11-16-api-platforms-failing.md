# Why API-based platforms fail while browser ones work (2026-11-16)

Static code review. The live endpoints were not called, so the 401/403/WAF responses below are inferred from the expired tokens, not observed.

## Root causes, most impactful first

1. **Errors are swallowed, then the run falls through to a backend that can't serve the platform** (`src/platforms.js` `searchOne`).
   - When `searchApi` throws or returns `[]` and a backend exists, the real error is discarded.
   - With the `webcmd` backend the run then calls `webcmd <site> search`. `scripts/build-adapters.js` only generates adapters for blinkit, zepto, bigbasket and amazon.
   - The result is `Site "<x>" is not installed.` for instamart, jiomart, flipkart_minutes and kpn. This is confirmed in `~/.basket/last-result.json` (2026-11-15, backend `webcmd`).
2. **Hardcoded, expired Instamart session** (`src/extract/instamart.js`).
   - The `tid` JWT has `iat` 2026-11-11 12:18 UTC and `exp` 13:18 UTC, so it was valid for 1 hour.
   - `aws-waf-token` is also short-lived.
   - Version-pinned values (`x-build-version`, `matcher`, layout id) will also drift.
   - Nothing captures or refreshes tokens anywhere in the code.
3. **Location mismatch.**
   - The Instamart cookie and store id are for Chennai (600045), but the default pincode is 110048.
   - Milkbasket sends `cityid` = hubId (bug in `src/extract/milkbasket.js`).
   - `--pincode` is display-only and is never sent to any platform.
4. **Non-browser fingerprint.** Node `fetch` is easy to block (Cloudflare on Blinkit, AWS WAF on Swiggy). Browser paths work because they use the real profile cookies and location.
5. **API `fetch` calls have no timeout**, so a hung request stalls the run.
6. **Failures are badly surfaced.**
   - `partialFailures` is never rendered.
   - Fully failed platforms drop out of `allScores` (`src/score.js`).
   - Only `failures[0]` is shown.

## Other facts relevant to the redesign

- **No headless mode.** `src/browser.js` attaches to a Chrome the user started with `--remote-debugging-port=9222`.
- **Missing features:** no Docker, scheduler, progress endpoint, or price history.
- **The plain CLI table overflows the terminal.** It uses fixed widths (34 + 22 per platform).
- **There is an approved but unimplemented plan for an HTTP-first engine:** `docs/superpowers/specs/2026-11-10-headless-engine-design.md`. It covers profiles with `expires_at`, Playwright fallback and history.

## Live recon: guest access in headless Chrome (2026-11-16)

Method: headless Chrome 156 (`--headless=new`) with a fresh profile, driven over CDP. Every site was visited as a guest with no login. No site asked for an OTP before showing search results.

| Site | Guest search | Location mechanism seen | API | Called from Node fetch? |
|---|---|---|---|---|
| Instamart | yes | `userLocation` cookie (lat/lng/address) | `POST www.swiggy.com/api/instamart/search/v2` | **yes**: 200 using fresh guest cookies, even without `sid` |
| BigBasket | yes, once the UA matches | `_bb_addressinfo` / `_bb_pin_code` cookies | `GET /listing-svc/v2/products?type=ps&slug=` | **no**: Akamai causes a redirect loop. In-page `fetch()` works (200, 40 items, ~2.4 s) |
| Zepto | yes | lat/lng (defaulted to Bangalore) | `bff-gateway.zepto.com/search-federator-service/api/v1/search` | not tried |
| Blinkit | yes | `gr_1_lat` / `gr_1_lon` cookies (defaulted to Gurgaon) | `POST blinkit.com/v1/layout/search` | not tried |
| JioMart | page loads | `logistics/v1.0/pincode/<pin>` (defaulted to 400001) | the `/search/<q>` URL form is wrong (404 page) | not tried |
| Flipkart Minutes | prompts "Select delivery address" | address picker | `1.rome.api.flipkart.com/api/4/page/fetch` | not tried; whether a guest can get hyperlocal results is **unverified** |
| KPN Fresh | yes | city/area (defaulted to Mylapore, Chennai) | not captured | not tried |
| Milkbasket | home page as guest | unknown | `consumerbff.milkbasket.com/graphql` (a 401 then 200s) | not tried |
| Amazon Now | yes | pincode (guessed from IP as 600042) | HTML | n/a |

Key lessons:
- **BigBasket returned 403 when the `--user-agent` override (Chrome/146) didn't match the real browser's client hints (Chrome/156).** With a matching UA and `--disable-blink-features=AutomationControlled` it returned 200. The hardcoded Chrome/146 UA in `src/extract/instamart.js` has the same flaw.
- **Instamart guest cookie lifetimes:**
  - `sid`: about 1 h
  - `aws-waf-token`: about 4 days
  - `tid` and `deviceId`: about 30 days
- **Instamart with the Marutham Prestige location** (lat 12.9161793, lng 80.0975106, from the old cookie's address "Marutham Prestige, Bharathidasan Nagar, Krishna Nagar, Tambaram, Chennai 600045") returned Chennai-local brands, e.g. Udhaiyam Toor Dal. That confirms the location took effect. OpenStreetMap has no entry for the building, so these coordinates are the reference point.
- Setting a BigBasket location as a guest was not completed in recon; the picker selector was not found. **Unverified.**

## Resolution and new findings (2026-11-18)

**What fixed the original bug.** The site-API calls now run inside a warm headless Chrome tab, one per site (`src/engine/`). Errors are classified and shown, never swallowed. No tokens are kept in source: the hardcoded Instamart cookie and the Milkbasket bearer were removed.

### Per-site outcome (guest, Marutham Prestige, 600045)

| Site | Endpoint | Location mechanism | Result |
|---|---|---|---|
| Instamart | `POST /api/instamart/search/v2`; prices in `variations[].price.offerPrice.units` | `userLocation` cookie | ✅ about 58 products for "toor dal 1kg", local brands |
| BigBasket | `GET /listing-svc/v2/products?type=ps&slug=`; price in `pricing.discount.prim_price.sp`, `204` when nothing matches | guest picker, which calls `places/v1/places/autocomplete` → `places/details` → `PUT member-svc/v2/member/current-delivery-address` (`{lat,long,contact_zipcode}`) and sets `_bb_pin_code` | ✅ (see the notes below) |
| Zepto | `GET bff-gateway.zepto.com/search-federator-service/api/v1/search` | picker → `api/v1/maps/place/autocomplete` → `user/customer/address/location`; cookies `user_position`, `serviceability` | ✅ Krishna Nagar store (store ids changed from the Bangalore default) |
| Blinkit | `POST /v1/layout/search?q=&search_type=type_to_search`; items in `snippets[].data.atc_action.add_to_cart.cart_item` | `gr_1_lat` / `gr_1_lon` cookies | ✅ 12 products |
| KPN | `/search?q=` server-rendered; `__NEXT_DATA__.props.pageProps.pageProps.productResponse.data.products[].pack_list[]`; `statusCode 404` means no results | Chennai default (Mylapore) | ✅ |
| JioMart | `catalog/v1.0/products` → `400 invalid pincode`; `logistics/v1.0/pincode/600045` → `401` | guest default Mumbai 400001 | ⚠ beta DOM; the search page doesn't render |
| Amazon Now / Flipkart Minutes / Milkbasket | — | — | ⚠ beta DOM (see docs/ENGINE.md) |

### BigBasket notes
- Calling the `PUT current-delivery-address` directly from the page gets a **403**. It needs whatever the picker flow adds, so the engine drives the picker once and the profile keeps the result.
- When **no location is set**, listings come back with ₹1 placeholder prices. There are also genuine ₹1 first-order promo rows. The parser drops any price ≤ ₹1, and reports `unserviceable` if every price is ₹1.

### Throttling and blocks seen during recon (time-limited, cleared on their own)
- **BigBasket (Akamai):** after about 15 fresh-profile visits, it served an "Access Denied" page on the whole site, and `curl` got 403 too. The block cleared within about an hour. Now detected by `assertNotWalled`: `blocked … bot protection page "Access Denied" (ref …)`.
- **Instamart:** returns HTTP 200 with the body `{"stack":null,"statusCode":429}` when searches burst. This used to look like "not found"; it is now `blocked … rate limited`, with a 15 s pause before the retry and 2.5 s pacing between searches.
- **Zepto:** after heavy testing, the gateway answered without CORS headers (`net::ERR_FAILED`, `corsError: MissingAllowOriginHeader`). It is reported as `blocked … refused the request without CORS headers`.

### Docker
Debian's `chromium` (156.0.8078.79) won't start under Docker's default seccomp/userns. It fails with "No usable sandbox!", which surfaced as `browser … Chrome exited early (code 1)`. The image sets `BASKET_CHROME_NO_SANDBOX=1` and runs as the non-root `node` user.

### Not yet measured: logged-in session lifetime (plan Task 12)
No OTP login was done, so the lifetime of a logged-in token is **unverified**. What was measured on guest cookies (Instamart, 2026-11-16):
- `tid` and `deviceId` last 30 days.
- `sid` lasts 1 hour.
- `aws-waf-token` lasts about 4 days.

Because the browser profile is the session store and scheduled visits refresh these cookies, a logged-in session should roll forward the same way a phone app does. Confirm this once with an actual login before relying on it.

## Milkbasket and OTP login recon (2026-11-18)

**Milkbasket (web, guest)**
- No location or pincode input, and no login/sign-in entry, anywhere on the site. "Add" doesn't open a login sheet either.
- Every `consumerbff.milkbasket.com/graphql` call carries `authorization: ''`, `cityid: 1`, `hubid: 1`. That is its default city, and nothing on the web changes it.
- `/search?q=toor dal` renders an Epigamia brand store, not search results.
- Its app store listing does include Chennai, so the service exists there, but only through the app. Status: **skipped**.

**Does an OTP login keep working without a fresh OTP?** Unverified. No site we use needed a login, and Milkbasket (the one that would) has no web login. No OTP was sent. What's known:
- The engine keeps sessions in the browser profile, the same way a phone app keeps its login.
- Instamart's guest cookies roll forward on each visit (`tid` lasts 30 days, `sid` 1 hour).
- Whether a logged-in token can be refreshed indefinitely can only be measured by logging in once and watching its cookie expiries across a few days of scheduled visits.

**Matching bug found with history-first.** The old matcher accepted "Bb Popular Moong Dal 1 kg" for "toor dal 1kg" (score 0.66 > 0.55; only "dal" was shared), and the per-kg sort then preferred it. It is fixed by requiring the identity word, with regional synonyms. 10 saved rows were pruned.

## JioMart, Flipkart Minutes, first scheduled runs (2026-11-18/19)

- **JioMart:**
  - The catalog API works for guests when the page's `x-location-detail` header is sent.
  - The cookies must include city and state, otherwise the page rewrites them to Mumbai 400001.
  - Prices used are standard-delivery groceries.
  - The UI picker ("Select location manually") also works, but it was flaky on cold profiles, so cookies are used instead.
- **Flipkart Minutes:**
  - The guest address picker works with "Marutham Prestige Tambaram", resolving to 600045.
  - Results are server-rendered in `__INITIAL_STATE__`; there is no XHR to call.
- **Scheduled runs on 2026-11-19:**
  - 07:00 (job 7): all 7 sites succeeded.
  - 09:00 (job 8): 6 sites succeeded. Zepto returned `blocked … Failed to fetch` because the `request-signature` and csrf headers captured at 07:00 had gone stale; the tab was never re-captured. Fixed: captured headers expire after 20 minutes and refresh clears them.
- **Recon hygiene:** live probes killed by `timeout` leave their headless Chrome running. On 2026-11-18 that took the machine to 465 MB of free RAM. Kill leftovers with `pkill -f "remote-debugging-port=<port>"`.

## 2026-11-19: eggs → Tata Salt, Amazon Now, Milkbasket correction

- **"6 eggs" showed Tata Salt (JioMart).**
  - JioMart's search returned only salt. The matcher refused it (count vs mass), but `pickBest` fell back to *any* in-stock product when nothing was confident, and totalled it as "low-confidence".
  - Fixed: refused candidates are never picked; the line becomes `no-match` ("no matching product").
  - Second bug in the same data: Zepto "Fresh White Eggs 1 pack (6 pcs)" was read as 1 piece, so "6 eggs" bought 6 packs (₹312). A piece count now beats a pack count.
- **Amazon Now.**
  - It has a guest JSON API (`/tez/browse/searchByKeyword`), and the pincode can be set via `glow/address-change`.
  - At **600045 it is not serviceable** (`validateLocation.isServiceable=false`); with the IP guess 600042 it returned products.
  - It now reports `unserviceable … does not deliver to this pincode`.
- **Milkbasket correction.** `/login` (and `/signin`, `/account`) shows "Enter Mobile Number → Get OTP". Login is possible on the web. GraphQL introspection is disabled; `getSocieties` exists, and `getSearchProducts` takes arguments other than `searchTerm`.

## 2026-11-19 (later): price check, Zepto login wall

- **Odd prices in the 09:00 run, now fixed:**

  | Item | Site | What it was | Fix |
  |---|---|---|---|
  | butter 500g, ₹79 | JioMart | "Pack of 10 … 100 g" read as 1 kg | the measure is the total unless "each" is said |
  | tomato 500g, ₹489 | JioMart | an onion+tomato *powder* combo | processed forms refused |
  | tomato 500g, ₹310 | JioMart | ketchup | processed forms refused |
  | onion 1kg, ₹18 | KPN | spring onion bunch | "spring" refused; unreadable size is a weak match |
  | sunflower oil 1L, ₹869 | Flipkart | 5 L can | bigger than 1.5× asked: shown, not counted |
  | milk 2× 500ml, ₹150 | BigBasket | 2 × 1 L | quantity folds into the amount: one 1 L |
  | onion 1kg, ₹131 | BigBasket | "2x1 kg" | bigger pack: not counted |

  Plus a cross-site median price check (`src/pricecheck.js`). On startup the store pruned 5 saved rows far from the median.
- **Zepto "Failed to fetch" root cause:** at the Krishna Nagar store the page shows "Oops! Please login to continue searching", and the API refuses guests without CORS headers. It is not rate limiting and not stale headers; even a brand-new profile failed. Zepto now reports `session … asks you to sign in`, and Zepto is in the sign-in popup.
