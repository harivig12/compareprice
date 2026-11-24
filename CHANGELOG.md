# Changelog

All notable changes to compareprice. Dates are YYYY-MM-DD.

## [Unreleased]
### Added (2026-11-20, categories)
- **Run panel and freshness (mockup A)**:
  - Get fresh prices shows a panel with one chip per site (done / searching / waiting / failed; tap for the last step), a bar of searches done, a time estimate and Stop. Saved prices show dimmed meanwhile.
  - Saved-price views show how old each site's prices are (green under 6 h, amber under 2 days, red older), with an age dot in every cell and **Refresh only the old ones** (missing and old pairs only).
  - Phones get bottom tabs: Compare / Prices / Deals / Settings.
- **Jhola**: new name, icon and wordmark (option A). Tab icon, "Add to home screen" manifest with 192/512/maskable/Apple icons (`src/ui/icon*.svg`, PNGs from `node scripts/build-icons.js`). The repo, Docker service and container names are unchanged.
- **Category preference**:
  - Sites' own categories are saved with each price.
  - A generic line ("ghee") gets the raw product first. Sweets and pooja items are refused unless named, and packaged foods sort after staples.
  - Each line learns its usual category per site.
- **"Find the cheapest" reuses a more specific saved line**: "salt" and "tata salt" are answered from "tata salt 1kg", marked "saved for …". A more specific new line ("cow ghee 1l") still needs a fresh search.
- **Tap tips**: every hover text opens on tap on a phone. Prices in the saved-price lookup, basket cells and phone cards have an (i) button.
- **Optional AI labels** (Settings → AI labels, off by default):
  - Uses a Groq, OpenRouter or custom OpenAI-compatible API, with a key and a **Check connection** button.
  - Only titles are sent, many per call. Batch size, pause and daily cap are in `<data>/ai.md`.
  - Labels only demote. `/api/ai*` routes; `scripts/ai-groups-eval.js`.
### Fixed (2026-11-20)
- Editing basket.txt did not change the default list once Settings had been saved: the list is now only kept in `<data>/basket.txt` (the old copy is saved as `basket.previous.txt`).
- "ghee" no longer picks Ghee Besan Laddu (KPN) or Puja Ghee (Milkbasket), and "hing" no longer picks Hing Peda. The 4 saved rows are kept, marked `no-match`.
- "salt" / "tata salt" showed no saved price on the basket screen while the lookup found them.

### Added
- Sign-in popup has a real OTP step: after **Send OTP**, an OTP box appears and the button becomes **Verify**; *Change number* and *Resend OTP* (30 s gap). `POST /api/login/start` answers 202 and the popup polls `GET /api/login` for `state`.
- Light and dark themes with a ☀ / ☾ / Auto toggle on both pages (`/ui/theme.css`, `/ui/theme.js`).
- ▼/▲ next to prices, against the latest earlier saved price for that site.
- Saved-price lookup shows the last 3 dates that have data, one row per site, cheapest first. `GET /api/lookup` adds `dates`, `trend`, `change`, `changePct`, `prev`; `GET /api/suggest` adds `best`.
- `browser.idleCloseMs` (Chrome closes after 5 idle minutes), `browser.blockMedia` (search tabs skip images/fonts/video), `results.keepDays` (per-run JSON pruned after 60 days). Chrome's disk cache is capped at 50 MB.

### Changed
- **MCP rewritten as a thin client of the running service** (`BASKET_URL`). Answers from saved prices by default, `fresh: true` for a live run under the same limits. Tools: `lookup_price`, `suggest_items`, `compare_basket`, `run_saved_basket`, `job_result`, `site_status`, `open_basket_view`. `search_product` and `open_platform` were removed (see README › MCP).
- Zepto at Krishna Nagar now requires sign-in; it reports `session … asks you to sign in` instead of `Failed to fetch`.
- One-time store clean-ups run once per `CLEANUP_VERSION`, not on every start.

- **Instamart sign-in** (swiggy.com → Sign in → Login → mobile → OTP). Optional; guest searches keep working without it.
- **Amazon sign-in with a password** (number or email → password), with the follow-up steps Amazon may ask for: a verification code, approval on the phone, or a puzzle (reported, not solved). It stops after 3 wrong passwords. The password is never stored or logged, and Chrome's password manager is turned off in the profile.

- **Second and third accounts on Instamart and Milkbasket**, each in its own browser profile (`<data>/profiles/<site>-<id>`). Sign-in popup layout A: accounts listed under each site, with "+ Add account", Sign out and Remove. Instamart searches every account, the cheapest wins, and hovering a price shows which account. Milkbasket's extra accounts only check deals.
- **Deals section** (80%+ off MRP, `deals.minDiscountPct`) at the bottom of the page, grouped by site with conditions (e.g. "max 1 item · basket ₹9+"); hover a row to see which accounts saw it. Never counted in totals. `GET /api/deals`, MCP tool `deals`.
- **Offer check** without product searches: after every scheduled run, and from **Check offers** (`POST /api/offers/run`). Milkbasket reads each account's flash deal; Instamart reads its home feed.
- **Milkbasket is searched again** (main account): the whole catalogue (38 categories, 250 subcategories, ~6,200 products) is read once a day over its API, paced (~4 min), cached in `<data>/cache/`, then matched locally.
- **API first** for Instamart and Milkbasket: data calls go out directly with the account's session, falling back to the browser tab when a site refuses (`src/engine/direct.js`).
- **BigBasket sign-in** (optional, mobile + OTP). It stops at once on the bot-protection page.
- A signed-in account keeps the address saved on it; the configured address is only the fallback.
- `accounts.json` replaces `sessions.json` (migrated automatically; the old file is left untouched).

- **"cheaper: other brand" hint (option A)**: for an item that names a brand, a cheaper same-kind product of another brand on that site is shown inside the cell (e.g. Zepto "cheaper: Annapurna Iodized Crystal Salt ₹18"). Totals stay on the brand you asked for. Different kinds (rock/black salt, full cream vs toned…) never count (`withoutBrand`, `addsKind` in `src/normalize.js`; `alternatives` table so saved prices keep the hint).
- **Add a price ("Others")**: enter a price from a shop or a bill (item, product, price, pack, date, bought from). It shows as an "Others" column (shop on hover), in lookups and in "Best per item"; never totalled or ranked (`/api/entries`).
- **Lookup: "Pack price" column** next to the rate trend (₹19 → ₹19 → ₹19 · 1 kg), with the product and how the rate was worked out on hover.
- **Nothing is deleted any more**: ✕, the start-up clean-ups and removed entries mark rows `hidden` instead.
- **Lighter on the CPU**: a site resting after a block is skipped at once (it held the queue for 33 min); one Chrome at a time (the main one closes before an extra account's starts, with one start retry); the offer check runs 15 min after a scheduled run with accounts 1 min apart; Milkbasket deals are also read from its saved daily catalogue at no extra cost; the master list leaves resting sites out.
- **Master price list**: `scripts/master-list.js` runs every item of `product list.md` through the service in paced, resumable batches, does one pass over what's still missing, and writes `master-<date>.csv` / `.md` (`src/masterlist.js`, `src/masterrun.js`).
- The ✕ on a cell sits on the price line at the cell's top-right corner, so a long product name can't hide it.
- **Green shades by rate**: dark/light green now mark the cheapest per 100 g / 100 ml / piece (by price only when an item's cells aren't in one unit).
- **Get for missing only**: next to Get fresh prices, searches just the item/site pairs with no saved price (`POST /api/compare { mode: 'missing', only }`), then shows the list again from saved prices.
- **✕ on a cell**: marks a wrong match; its saved prices for that item are deleted and it's never picked for that item on that site again (`POST /api/prices/reject`, `rejects` table).
- **Free delivery row** under Total: each site's own minimum (Instamart, Zepto ₹99; Milkbasket ₹99 or a ₹15 small-cart fee), read by the offer check (`GET /api/siteinfo`), with "✓ free" or "₹X more" for that column.

### Fixed
- Amazon sign-in said "asks for a password and offers no OTP" when the password box appeared between two checks.
- Milkbasket: an OTP accepted for a new number (sign-up unfinished) was shown as signed in; now it says to finish sign-up in the app. An account whose deal check finds no session is marked signed out.
- Instamart's second account hit "rate limited (429)" on the last item: extra accounts start 20 s after the main run, and a 429 retry waits 30 s (was 15 s).
- Instamart's offer check could read the home-page shell (0 products) on a slow machine; it now reads the page's own feed. Zepto's delivery minimum was missed when its tab was already open.
- Zepto search failed after signing in: the signed-in page searches with `POST user-search-service/api/v3/search`, which the engine now copies and replays.
- Milkbasket's OTP screen wasn't detected (its first OTP box has `maxlength=4`), so the popup never offered an OTP box even though the OTP was sent.

## [1.0.0] - 2026-11-19

### Changed
- Renamed the project from `comparebasket` to `compareprice` (folder, npm package name, Docker image `compareprice:latest`, docs).
- Repository moved to https://github.com/harivig12/prototype under `compareprice/`.
- The CLI command is still `basket`, and the internal `compareBasket()` entry point keeps its name.

### Included
- Warm headless-Chrome engine with per-site tabs (`src/engine/`).
- Sites: Instamart, BigBasket, Zepto, Blinkit, KPN Fresh, JioMart, Flipkart Minutes, Amazon.
- History-first search, lowest-price tracking, daily scheduler, web UI, HTTP/SSE API, MCP server.
- Offline test suite (`npm test`) and live-site tests (`npm run test:live`).
