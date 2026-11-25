# Changelog

All notable changes to Jhola (called compareprice before 1.2) are listed here, newest first.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Dates are YYYY-MM-DD.

## [Unreleased]

### Added
- **BigBasket offers in Deals.** The offer check (07:00 and 18:00) reads BigBasket's deal storefronts: Deals of the Week, Buy More Save More, Combos, Big Pack Discount and the ₹30 Corner, every page up to 10 each, one call at a time. Each storefront is its own group under the 80%+ deals, marked "any discount", with BigBasket's "max 3 items" limit and "price drop" where it gives them. They never count in a total. The MCP `deals` tool lists them too (10 rows per storefront).
- **BigBasket runs in a Chrome of its own** (`<data>/profiles/bigbasket`), headless. After its bot wall shows on two page loads in a row it switches to a headed Chrome and stays so (`<data>/browser-mode.json`). On a server that Chrome runs inside a virtual screen: the Docker image now ships Xvfb.

### Fixed
- **BigBasket sign-in typed the OTP but never submitted it** ("the OTP box is still showing 15 s after entering the code"). Its submit match (`verify|continue|login|submit`) found the page header's "Login/ Sign Up" button before the dialog's "Verify & Continue". It now looks for the button that starts with "Verify". When the box still shows after 15 s, the error now says what the dialog says (digits masked).
- **BigBasket sign-in stopped at "could not focus the OTP box".** Its OTP screen is six bare number boxes (no maxlength, name or placeholder), which the box finder skipped. A row of 4 to 8 small boxes under an "OTP" page now counts, with a test that runs the real expressions against fake pages (`test/otp-boxes.test.js`).

### Changed
- The Deals heading no longer says "80%+ off"; each group says which rule it follows.
- A deal's pack is not repeated when the product name already ends with it.

## [1.3.0] - 2026-11-24

Brings together the build that has been running at home (accounts, deals, sign-in, AI labels, freshness; 2026-11-19 to 2026-11-20) and 1.2 (the Jhola name and logo, the product catalogue, the sweep and the guide).

### Changed
- **Liquid Glass on the compare and settings pages, in light and dark.** Every control of the running build is kept. The top bar, toolbar, panels and the phone tab bar are frosted glass; prices, the comparison table, deal rows and dialogs sit on solid surfaces. Dark uses a deep green-black background. The ☀ / ☾ / Auto switch stays, and both pages link to the guide.
- **Deals and offers are checked at 07:00 and 18:00** (`deals.times`, 24-hour HH:MM in the service's time zone) instead of 15 minutes after each scheduled run. AI labels still run after the offer check. Deals are never part of a total.
- **One logo**: the yellow jhola with a green ₹ tag (`assets/brand/jhola-icon.svg`). The amber bar-chart icon and its maskable and Apple variants are gone; `/ui/apple-touch-icon.png` serves the 180 px icon.
- Basket rows and phone cards show "you typed: …" under a catalogue name (`kismis` → raisins).
- **Docker**: `scripts/deploy.sh` now runs the `jhola` container from the `jhola` image. The first deploy removes the old `basket` container and keeps `compareprice:latest` as `jhola:previous`, so a rollback still works.
- The MCP server, `scripts/master-list.js` and the docs use `JHOLA_URL`. `BASKET_URL` still works.

### Added (2026-11-20, categories)
- **Run panel and freshness (mockup A)**:
  - Get fresh prices shows a panel with one chip per site (done / searching / waiting / failed; tap for the last step), a bar of searches done, a time estimate and Stop. Saved prices show dimmed meanwhile.
  - Saved-price views show how old each site's prices are (green under 6 h, amber under 2 days, red older), with an age dot in every cell and **Refresh only the old ones** (missing and old pairs only).
  - Phones get bottom tabs: Compare / Prices / Deals / Settings.
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

### Added (2026-11-19)
- Sign-in popup has a real OTP step: after **Send OTP**, an OTP box appears and the button becomes **Verify**; *Change number* and *Resend OTP* (30 s gap). `POST /api/login/start` answers 202 and the popup polls `GET /api/login` for `state`.
- Light and dark themes with a ☀ / ☾ / Auto toggle on both pages (`/ui/theme.css`, `/ui/theme.js`).
- ▼/▲ next to prices, against the latest earlier saved price for that site.
- Saved-price lookup shows the last 3 dates that have data, one row per site, cheapest first. `GET /api/lookup` adds `dates`, `trend`, `change`, `changePct`, `prev`; `GET /api/suggest` adds `best`.
- `browser.idleCloseMs` (Chrome closes after 5 idle minutes), `browser.blockMedia` (search tabs skip images/fonts/video), `results.keepDays` (per-run JSON pruned after 60 days). Chrome's disk cache is capped at 50 MB.

### Changed (2026-11-19)
- **MCP rewritten as a thin client of the running service** (`BASKET_URL`). Answers from saved prices by default, `fresh: true` for a live run under the same limits. Tools: `lookup_price`, `suggest_items`, `compare_basket`, `run_saved_basket`, `job_result`, `site_status`, `open_basket_view`. `search_product` and `open_platform` were removed (see README › MCP).
- Zepto at Krishna Nagar now requires sign-in; it reports `session … asks you to sign in` instead of `Failed to fetch`.
- One-time store clean-ups run once per `CLEANUP_VERSION`, not on every start.

- **Instamart sign-in** (swiggy.com → Sign in → Login → mobile → OTP). Optional; guest searches keep working without it.
- **Amazon sign-in with a password** (number or email → password), with the follow-up steps Amazon may ask for: a verification code, approval on the phone, or a puzzle (reported, not solved). It stops after 3 wrong passwords. The password is never stored or logged, and Chrome's password manager is turned off in the profile.

- **Second and third accounts on Instamart and Milkbasket**, each in its own browser profile (`<data>/profiles/<site>-<id>`). Sign-in popup layout A: accounts listed under each site, with "+ Add account", Sign out and Remove. Instamart searches every account, the cheapest wins, and hovering a price shows which account. Milkbasket's extra accounts only check deals.
- **Deals section** (80%+ off MRP, `deals.minDiscountPct`) at the bottom of the page, grouped by site with conditions (e.g. "max 1 item · basket ₹9+"); hover a row to see which accounts saw it. Never counted in totals. `GET /api/deals`, MCP tool `deals`.
- **Offer check** without product searches: at set times (07:00 and 18:00 since 1.3), and from **Check offers** (`POST /api/offers/run`). Milkbasket reads each account's flash deal; Instamart reads its home feed.
- **Milkbasket is searched again** (main account): the whole catalogue (38 categories, 250 subcategories, ~6,200 products) is read once a day over its API, paced (~4 min), cached in `<data>/cache/`, then matched locally.
- **API first** for Instamart and Milkbasket: data calls go out directly with the account's session, falling back to the browser tab when a site refuses (`src/engine/direct.js`).
- **BigBasket sign-in** (optional, mobile + OTP). It stops at once on the bot-protection page.
- A signed-in account keeps the address saved on it; the configured address is only the fallback.
- `accounts.json` replaces `sessions.json` (migrated automatically; the old file is left untouched).

- **"cheaper: other brand" hint (option A)**: for an item that names a brand, a cheaper same-kind product of another brand on that site is shown inside the cell (e.g. Zepto "cheaper: Annapurna Iodized Crystal Salt ₹18"). Totals stay on the brand you asked for. Different kinds (rock/black salt, full cream vs toned…) never count (`withoutBrand`, `addsKind` in `src/normalize.js`; `alternatives` table so saved prices keep the hint).
- **Add a price ("Others")**: enter a price from a shop or a bill (item, product, price, pack, date, bought from). It shows as an "Others" column (shop on hover), in lookups and in "Best per item"; never totalled or ranked (`/api/entries`).
- **Lookup: "Pack price" column** next to the rate trend (₹19 → ₹19 → ₹19 · 1 kg), with the product and how the rate was worked out on hover.
- **Nothing is deleted any more**: ✕, the start-up clean-ups and removed entries mark rows `hidden` instead.
- **Lighter on the CPU**: a site resting after a block is skipped at once (it held the queue for 33 min); one Chrome at a time (the main one closes before an extra account's starts, with one start retry); the offer check's accounts run 1 min apart; Milkbasket deals are also read from its saved daily catalogue at no extra cost; the master list leaves resting sites out.
- **Master price list**: `scripts/master-list.js` runs every item of `product list.md` through the service in paced, resumable batches, does one pass over what's still missing, and writes `master-<date>.csv` / `.md` (`src/masterlist.js`, `src/masterrun.js`).
- The ✕ on a cell sits on the price line at the cell's top-right corner, so a long product name can't hide it.
- **Green shades by rate**: dark/light green now mark the cheapest per 100 g / 100 ml / piece (by price only when an item's cells aren't in one unit).
- **Get for missing only**: next to Get fresh prices, searches just the item/site pairs with no saved price (`POST /api/compare { mode: 'missing', only }`), then shows the list again from saved prices.
- **✕ on a cell**: marks a wrong match; its saved prices for that item are deleted and it's never picked for that item on that site again (`POST /api/prices/reject`, `rejects` table).
- **Free delivery row** under Total: each site's own minimum (Instamart, Zepto ₹99; Milkbasket ₹99 or a ₹15 small-cart fee), read by the offer check (`GET /api/siteinfo`), with "✓ free" or "₹X more" for that column.

### Fixed (2026-11-19)
- Amazon sign-in said "asks for a password and offers no OTP" when the password box appeared between two checks.
- Milkbasket: an OTP accepted for a new number (sign-up unfinished) was shown as signed in; now it says to finish sign-up in the app. An account whose deal check finds no session is marked signed out.
- Instamart's second account hit "rate limited (429)" on the last item: extra accounts start 20 s after the main run, and a 429 retry waits 30 s (was 15 s).
- Instamart's offer check could read the home-page shell (0 products) on a slow machine; it now reads the page's own feed. Zepto's delivery minimum was missed when its tab was already open.
- Zepto search failed after signing in: the signed-in page searches with `POST user-search-service/api/v3/search`, which the engine now copies and replays.
- Milkbasket's OTP screen wasn't detected (its first OTP box has `maxlength=4`), so the popup never offered an OTP box even though the OTP was sent.

## [1.2.0] - 2026-11-24

The project is now called **Jhola**, after the cloth bag you take to the market.

### Changed
- **New name and logo.** A yellow jhola with a green ₹ price tag, on green. It is used for the favicon, the home-screen icons, the top bar, the guide, the README and the social preview. The master file is `assets/brand/jhola-icon.svg`, with colours and rules in `assets/brand/README.md`. `npm run build:icons` regenerates every PNG from it.
- **The command is now `jhola`**, and the npm package is `jhola`. `basket` still works as an alias for this release.
- **Settings use `JHOLA_*` names** (`JHOLA_HOME`, `JHOLA_PORT`, `JHOLA_HOST`, `JHOLA_URL`, `JHOLA_BACKEND`, `JHOLA_CHROME_NO_SANDBOX`, `JHOLA_DATA`). Every `BASKET_*` name still works, and an explicit `BASKET_*` value wins.
- **Docker:** the image is `jhola:latest`, and the service and container are `jhola`. Remove the old container once with `docker rm -f basket`, or the new one can't take port 7777. See [Upgrading from before the rename](docs/OPERATIONS.md#upgrading-from-before-the-rename-11--12).
- **Data stays where it was.** A new install uses `~/.jhola`. An existing `~/.basket` keeps being used, and Docker keeps `~/basket-data`, so saved prices, sessions and settings carry over.
- **Generic wording.** Descriptions, the guide, the README and the social image say "the top quick-commerce sites" instead of listing them, and the guide's example tables use Site A, B and C. Real site names remain only where the app needs them to work: the site checkboxes, the result columns, error messages, `config.json`, and the technical per-site docs.
- The social preview drops the "kismis = raisins" chip. The synonym feature is still described in the guide and the README.
- The repository is now `harivig12/jhola`, and the landing page is https://harivig12.github.io/jhola/. GitHub redirects the old repository address.
- The MCP server registers as `jhola`: `claude mcp add jhola -- node /path/to/jhola/src/mcp-server.js`.

## [1.1.0] - 2026-11-23

A product catalogue so one product has one name, a background sweep that fills in missing prices, a new look, and a how-to guide you can read in the app or on a public page.

### Added
- **Product catalogue** (`src/catalog.js`, `src/catalog-data.js`): about 230 products, each a synonym set with a canonical tag, regional and transliterated names (Hindi, Tamil, Telugu, Kannada), common misspellings, narrower names, brand facets and a category. Basket lines are searched, matched and saved under the canonical tag, so `kismis`, `kishmish`, `khismis` and `dry grapes` are all `raisins`, and `gud`, `vellam` and `jagrey` are all `jaggery`. Lines naming the same product merge into one row, and the page shows what you typed under it.
  - A line is rewritten only when it is the product plus brands, pack sizes and plain modifiers. `britannia good day cashew` stays as typed, and brands are never swapped for another.
  - A listing called "Kishmish" or "Dry Grapes" now matches a search for raisins.
  - On start the store regroups saved prices under the canonical name. Search suggestions also find products by their other names, and `coverage()` reports where a product has saved prices.
- **Catalogue sweep** (`src/sweep.js`): every 5–20 minutes at random, queues 2–4 catalogue products with no saved price (or an old one), at most once a day each. It never starts while another job is running. Configure it in `config.json → sweep` or on the settings page.
- **How-to guide** at `/guide`: website and phone tracks, a "Try it" box backed by `/api/catalog`, the error kinds and troubleshooting.
- **Public landing page**: `npm run build:site` turns the guide into a static site (`site/`), which the Pages workflow publishes to https://harivig12.github.io/compareprice/. The app itself still runs on your own machine.
- `GET /api/catalog`, `GET /api/sweep`, `POST /api/sweep/run`, and the CLI commands `basket catalog` and `basket sweep-now`.
- "Add to Home screen" installs it as an app: a web app manifest, an SVG icon, and 180 / 192 / 512 px PNG icons. The server serves only a fixed list of these static files.
- Repository files: root `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, issue and pull-request templates, CI that runs the offline tests, Dependabot, and a 1280×640 social preview image.

### Changed
- **New "Liquid Glass" look** for the compare, settings and guide pages, from one shared stylesheet (`src/ui/theme.css`). Frosted-glass navigation sits over a soft gradient, and prices and forms are on near-opaque white so they stay readable.
  - Compare page: a shared top bar (Compare, Settings, Guide), an empty state that explains the three steps, site toggles as pills, and messages near the bottom of the screen instead of `alert()` popups. On phones, Find / Fresh / Stop sit in a bar within thumb reach, and the list folds away after a search.
  - Settings page: section shortcuts, a sticky save bar, and the sweep controls with live status and a "Sweep now" button.
- The pages use the device's system fonts and load nothing from third parties, so they work offline.
- **The project now lives at the repository root** instead of in a `compareprice/` subfolder, so the quick start is `git clone` then `cd compareprice`. The long usage guide moved from `compareprice/README.md` to `docs/USAGE.md`, and the root `README.md` is the project overview. Links to files under the old `compareprice/` path no longer resolve.
- `package.json` points at this repository (it still named the old `prototype` repo) and gets a description, keywords and a homepage.

### Fixed
- A site that found nothing showed a ₹0 total. It now shows "—".

## [1.0.0] - 2026-11-19

### Changed
- Renamed the project from `comparebasket` to `compareprice` (folder, npm package name, Docker image `compareprice:latest`, docs).
- The CLI command is still `basket`, and the internal `compareBasket()` entry point keeps its name.

### Included
- Warm headless-Chrome engine with per-site tabs (`src/engine/`).
- Sites: Instamart, BigBasket, Zepto, Blinkit, KPN Fresh, JioMart, Flipkart Minutes, Amazon.
- History-first search, lowest-price tracking, daily scheduler, web UI, HTTP/SSE API, MCP server.
- Offline test suite (`npm test`) and live-site tests (`npm run test:live`).
