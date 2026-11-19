# Basket service: warm headless browser engine, history, scheduler, Docker (2026-11-16)

Status: approach 1 chosen by the user on 2026-11-16; implemented 2026-11-18 (see ../plans/2026-11-16-basket-service-STATUS.md). This design supersedes the fetch layer of `2026-11-10-headless-engine-design.md`; that design's history and deal-tag ideas are kept where they're compatible with what follows.
Background: `docs/diagnosis/2026-11-16-api-platforms-failing.md`.

## Intent

The user wants the cheapest option for each item on a grocery list, across quick-commerce sites. The list is checked on a schedule, so the time-of-day deals on Instamart and BigBasket get caught, and each result is compared with the lowest price seen so far.

Today the API sites fail because of hardcoded, expired sessions and errors that are swallowed. The fix has to stop depending on tokens that someone pasted in by hand.

## Goals

- **Reliable fetching without hand-pasted tokens.** One warm headless Chrome. Each site gets one tab, which sets the location once. Each product search is then a site API call made from inside that tab (`page.evaluate(fetch…)`), so nothing is rendered.
- **Self-healing.**
  - On HTTP 401/403, a WAF/HTML response where JSON was expected, a "store offline/unserviceable" state, or an empty or unparseable response, the tab is reloaded to refresh the session and the search is retried once.
  - If that also fails, the site's DOM scrape is used.
  - The specific error is always reported (`instamart: 403 WAF challenge after refresh`), never just "offline".
- **Progress.** Each running job shows something like `BigBasket · 3/5 · moong dal`, in both the CLI and the web UI.
- **Price history.** For each item and site, the history stores:
  - the lowest price per unit
  - the pack and product name
  - the date and time it was seen
  - the last price

  Each result shows "new low", "matches low", or "₹x above the low seen on <date>".
- **Scheduler.**
  - It runs one or more site groups once or twice a day, as set in the config. For example, Instamart and BigBasket at 07:00 and 21:00, and the others at 07:00.
  - Manual runs and scheduled runs go into one queue, so neither blocks the other and the web UI stays responsive.
  - A site that is already running is never run twice at the same time.
- **Docker.** One container holds Node, Chrome, the web UI, the scheduler and the history store. It restarts automatically and uses a volume for its data and the browser profile.
- **Comparison table.** It fits the screen without scrolling sideways. The cheapest cell per item is dark green and the second cheapest light green. **A mockup must be approved before the UI is built** (standing user preference).

## Non-goals

- Ordering or checkout.
- Baking delivery fees into totals. The existing "goods only" rule in `fees.js` stays.

## Anti-goals

- Requiring an OTP every day.
- Logging in to BigBasket. It stays guest, because of its bot protection.
- Showing a visible browser window on scheduled runs.
- Exposing the UI beyond localhost without the user opting in.

## Location

- Reference point: Marutham Prestige, Bharathidasan Nagar, Krishna Nagar, Tambaram, Chennai 600045. Coordinates lat 12.9161793, lng 80.0975106.
- Sites that take coordinates get the coordinates. Sites that take a pincode get 600045. Sites that need an address search get "Marutham Prestige, Tambaram".
- The location lives in the config, not in source code.

## Sessions and logins

- **All sites work as guests** (recon, 2026-11-16). Login is optional and only adds membership prices.
- **The browser profile is the session store.** Chrome's `--user-data-dir` sits on the data volume. Sites rotate their cookies on each visit, and the scheduled daily visits keep those rolling sessions alive, the same way a phone app stays logged in.
- **`basket login <site>`** sends an OTP to the configured phone number, takes the code in the CLI or web UI, and confirms the session works.
- **The session check** records the expiry of the site's auth cookies. If a session is close to expiring or has lapsed, it gives a clear warning and the site falls back to guest rather than failing.
- **How long a logged-in session lasts per site is measured, not assumed.** Results go in the diagnosis doc.

## Matching

- A query with no brand (`moong dal 1kg`) accepts any brand's product of the same type, and the cheapest per unit wins.
- A query that names a brand (`amul taaza`) only accepts that brand.
- Products in a different category are still refused: `moong dal` never matches `moong dal namkeen`, and butter never matches butter cookies. The current `CATEGORY_TOKENS` and product-type checks stay. Snack-style words are added, such as namkeen, bhujia, chips and mixture.

## Architecture

- `src/engine/browser-pool.js`
  - Launches or attaches to Chrome over raw CDP (headless with `--headless=new`, extending the existing `browser.js`).
  - The user-agent string matches the real Chrome version.
  - Passes `--disable-blink-features=AutomationControlled`.
  - Keeps one tab per site, all kept warm.
- `src/engine/sites/<site>.js` — one per site. Each exports:
  - `origin`
  - `setLocation(tab, loc)`
  - `search(tab, query)`, which calls the in-page API and returns the existing 7-field envelope
  - `isSessionError(res)`
  - `domFallback`, which reuses the `src/extract/*` code
- `src/engine/run.js` drives a job (a list of items and a set of sites):
  - One worker per site, running in parallel across sites and one query at a time within a site.
  - Emits progress events.
  - Per-site error taxonomy: `session`, `blocked`, `unserviceable`, `timeout`, `parse`, `not_found`.
- `src/store.js` is the history and job store, using Node's built-in `node:sqlite` (no native dependency).
- `src/scheduler.js` is a cron-like daily-times scheduler driven by the config, with a persistent job queue.
- `src/server.js` keeps the existing HTTP server. It adds:
  - SSE `/api/events` for progress
  - `/api/jobs`
  - `/api/history`
  - `/api/config` (GET/PUT)
  - the pages `/` (compare) and `/settings` (schedule, sites, location, logins)
- `config.json` lives in the data dir: sites, schedule, location, phone, and the default basket.
- `Dockerfile` and `docker-compose.yml`:
  - Image: node:22-slim plus Chrome.
  - Volume: `/data`.
  - Port published on 127.0.0.1 by default.
- **The existing CLI, TUI and MCP keep working** through `compareBasket()`, which will use the new engine. webcmd stays an optional legacy backend, used only when explicitly selected.

## Left to the builder

- The exact API endpoints and payloads per site, discovered with the capture approach in the diagnosis doc.
- The DOM fallback details.
- The table layout, after the mockup is approved.
