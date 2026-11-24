# Basket Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded-token API calls with a warm headless-Chrome engine that runs site APIs in-page, self-heals sessions, reports progress and specific errors, stores price history, runs on a schedule, and ships as one Docker container.

**Architecture:** One Chrome (`--headless=new`, persistent `--user-data-dir`) driven over raw CDP. One warm tab per site; each search is `fetch()` evaluated inside that tab. A runner fans out one worker per site, emits progress, refreshes the tab and retries once on session errors, then falls back to the DOM scrape. The existing `compareBasket()` stays the single entry point (new backend `engine`). History lives in `node:sqlite`; a scheduler and job queue sit in front of it; `server.js` adds SSE + JSON endpoints.

**Tech Stack:** Node ≥ 22.13 (ESM, built-in `node:test`, `node:sqlite`, global `fetch`/`WebSocket`), Google Chrome / Chromium, Docker.

**Spec:** `docs/superpowers/specs/2026-11-16-basket-service-design.md`. Recon evidence: `docs/diagnosis/2026-11-16-api-platforms-failing.md`.

## Global Constraints

- No new npm dependencies; use Node built-ins only. `@modelcontextprotocol/sdk` stays.
- Chrome UA string must match the real browser version (read from `/json/version`), with `Headless` removed. A mismatched UA got BigBasket 403s.
- Always launch with `--disable-blink-features=AutomationControlled`.
- Default location: lat `12.9161793`, lng `80.0975106`, pincode `600045`, address `Marutham Prestige, Bharathidasan Nagar, Krishna Nagar, Tambaram, Chennai, Tamil Nadu 600045, India`, label `Marutham Prestige`. It lives in config, not source.
- BigBasket: guest only. Never log in.
- No secrets in source. Remove `DEFAULT_INSTAMART_COOKIE` and the Milkbasket bearer from `src/extract/*`.
- Data dir is `paths.js` `DATA_DIR` (`BASKET_HOME` override); in Docker it is `/data`.
- Server binds `127.0.0.1` unless config `server.host` says otherwise.
- Totals stay goods-only (`fees.js` rule).
- Error kinds (exact strings): `session`, `blocked`, `unserviceable`, `timeout`, `parse`, `not_found`, `browser`.
- Do not change `package.json` scripts except in Task 6. Every new test file is added to `npm test` there.
- Live-site tests only run when `LIVE=1`. The default `npm test` stays offline.

## Review Focus

1. **Chrome dies or a tab crashes mid-job.** The pool relaunches Chrome, that site's current query fails with kind `browser`, and other sites carry on. Test lives in Task 5.
2. **A scheduled run fires while a manual run is in flight.** It queues, and no site runs in two jobs at once. Test lives in Task 9.
3. **A site returns 200 with zero products because the location is unserviceable.** This is reported as `unserviceable` with the site's message, not as "not found". Tests live in Tasks 3 and 4: each site parser has an unserviceable fixture.
4. **The container restarts mid-job.** On boot, jobs left `running` are marked `interrupted` and are never shown as running forever. Test lives in Task 8.
5. **History compares packs of different sizes or units.** Comparison is per unit (₹/kg, ₹/L, ₹/pc). A result from a different unit family never becomes the low. Test lives in Task 8.

---

### Task 1: CDP tab and Chrome launcher

**Files:**
- Create: `src/engine/chrome.js`, `src/engine/cdp.js`
- Test: `test/engine-chrome.test.js`

**Interfaces:**
- Produces:
  - `chromeArgs({ port: number, profileDir: string, headless?: boolean, userAgent?: string }) -> string[]`
  - `matchedUserAgent(versionJson: { 'User-Agent': string, Browser: string }) -> string`. Returns the real UA with `HeadlessChrome` replaced by `Chrome`.
  - `launchChrome({ port?, profileDir, headless?, chromePath? }) -> Promise<{ endpoint: string, userAgent: string, close(): Promise<void>, process }>`
    - If `CDP_ENDPOINT` is set, it attaches instead of launching.
    - `chromePath` falls back to `CHROME_PATH`, then `google-chrome`, `chromium`, `chromium-browser`.
  - `class CdpTab`:
    - `static open(endpoint, url = 'about:blank') -> Promise<CdpTab>`
    - `goto(url, { waitMs = 6000 })`
    - `evaluate(expr: string, { awaitPromise = true, timeoutMs = 30000 }) -> Promise<any>`. Throws `Error('evaluate timeout')` or the page exception text.
    - `setCookies(cookies)`
    - `getCookies(urls?: string[]) -> Promise<Cookie[]>`
    - `setUserAgent(ua)`
    - `close()`
    - `onCrash(cb)`
    - `alive: boolean`

- [ ] **Step 1: Write the failing tests.**
  - `chromeArgs` includes `--headless=new`, `--remote-debugging-port=9333`, `--user-data-dir=/x`, `--disable-blink-features=AutomationControlled` and `--no-first-run`.
  - With `headless:false`, there is no `--headless` flag.
  - `matchedUserAgent({'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36'})` returns the same string with `Chrome/156.0.0.0`.
  - `LIVE=1` only: launch, open `data:text/html,<p>hi</p>`, `evaluate('1+1') === 2`, and close.
- [ ] **Step 2: Run `node --test test/engine-chrome.test.js`.** Expected: FAIL (module not found).
- [ ] **Step 3: Implement.**
  - Reuse the WebSocket/`send` pattern from `src/browser.js`.
  - `launchChrome` polls `http://127.0.0.1:<port>/json/version` for up to 15 s.
  - It passes `--user-agent=<matchedUserAgent>` on a relaunch only after the first run discovers the version. Simpler: after launch, call `Network.setUserAgentOverride` per tab via `setUserAgent`.
  - `onCrash` fires on `Inspector.targetCrashed` or a WebSocket close.
- [ ] **Step 4: Run the tests (and `LIVE=1 node --test test/engine-chrome.test.js`).** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/engine/chrome.js src/engine/cdp.js test/engine-chrome.test.js && git commit -m "feat(engine): headless chrome launcher and CDP tab"`

### Task 2: In-page fetch and error taxonomy

**Files:**
- Create: `src/engine/errors.js`, `src/engine/page-fetch.js`
- Test: `test/engine-errors.test.js`

**Interfaces:**
- Produces:
  - `class SiteError extends Error { constructor(kind, message, { status?, site?, cause? }) }`. `kind` is one of the Global Constraints kinds.
  - `pageFetch(tab: CdpTab, url: string, init?: { method, headers, body }, { timeoutMs = 20000 }) -> Promise<{ status: number, contentType: string, text: string, ms: number }>`. It evaluates `fetch(url, { credentials:'include', ...init })` in the page and returns text, never parsed JSON.
  - `expectJson(res, site) -> any`. Throws:
    - `SiteError('session')` for 401 or 419
    - `SiteError('blocked')` for 403, 429, or an HTML body (`/^\s*</`) when JSON was expected
    - `SiteError('parse')` for invalid JSON
    - `SiteError('timeout')` when `ms` reaches the timeout

    Messages include the status and the first 80 characters of the body, e.g. `instamart: 403 blocked (<HTML>Access Denied…)`.

- [ ] **Step 1: Write the failing tests** for `expectJson` (fake `res` objects only):
  - 200 with `{"a":1}` returns `{a:1}`
  - 401 → kind `session`
  - 403 with an HTML body → kind `blocked`, and the message contains `403`
  - 200 with `<html>` → `blocked`
  - 200 with `{bad` → `parse`
- [ ] **Step 2: Run `node --test test/engine-errors.test.js`.** Expected: FAIL.
- [ ] **Step 3: Implement both files.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(engine): in-page fetch and site error taxonomy`

### Task 3: Site modules, wave 1 (Instamart, BigBasket)

**Files:**
- Create: `src/engine/sites/index.js`, `src/engine/sites/instamart.js`, `src/engine/sites/bigbasket.js`
- Fixtures: `test/fixtures/sites/{instamart,bigbasket}-{ok,unserviceable}.json`. These are captured live with the approach in the diagnosis doc and trimmed to at most 5 products. Scrub cookies, device ids and phone numbers.
- Test: `test/engine-sites.test.js`
- Modify: `src/extract/instamart.js`. Delete `DEFAULT_INSTAMART_COOKIE`, the hardcoded headers and `searchApi`, and keep the DOM extractor.

**Interfaces:**
- Consumes: `CdpTab`, `pageFetch`, `expectJson` and `SiteError` (Tasks 1–2).
- Produces a site module shape. `sites/index.js` exports `SITES: Record<id, Site>` and `getSite(id)`.
  ```js
  {
    id, label,
    origin,                              // page kept warm, e.g. 'https://www.swiggy.com/instamart'
    locationCookies?(loc) -> Cookie[],   // set before first load
    setLocation?(tab, loc) -> Promise<void>,
    parse(json, query) -> Product[],     // pure; throws SiteError('unserviceable') when the payload says so
    search(tab, query) -> Promise<Product[]>,  // pageFetch + expectJson + parse
    domFallback: 'instamart',            // key into src/extract EXTRACTORS, or null
    login?: { start(tab, phone), submit(tab, otp), authCookies: string[] }  // Task 12
  }
  ```
  - `Product` is the existing 7-field envelope: `{ name, packSize, packUnit, price, mrp, inStock, url }`. Add `brand?` when the API gives one.
- Site specifics, from recon:
  - **Instamart**
    - Location: cookie `userLocation` = encoded JSON `{lat,lng,address,id:'',annotation,name:''}` on `.swiggy.com`.
    - Search: `POST /api/instamart/search/v2?offset=0&ageConsent=false&voiceSearchTrackingId=&storeId=&primaryStoreId=&secondaryStoreId=` with body `{"facets":[],"sortAttribute":"","query":q,"search_results_offset":"0","page_type":"INSTAMART_SEARCH_PAGE","is_pre_search_tag":false}`.
    - Copy the `matcher`, `x-build-version` and `x-device-id` headers from a request the page made itself. Capture them with `Network.requestWillBeSent` on the warm-up load, rather than hardcoding them.
  - **BigBasket**
    - Search: `GET /listing-svc/v2/products?type=ps&slug=<encoded q>&page=1`.
    - Products are at `tabs[0].product_info.products[]`:
      - `brand.name`
      - `desc` (the name)
      - `w` (the pack, e.g. `1 kg`)
      - `pricing.discount.prim_price.sp`
      - `pricing.discount.mrp`
    - Location: `setLocation` drives the "Select Location" picker with the pincode `600045` or the address search. Verify that the `_bb_pin_code` cookie equals `600045` afterwards; otherwise throw `SiteError('unserviceable','bigbasket: could not set location 600045')`.

- [ ] **Step 1: Capture the fixtures** (`LIVE` scratch script under `/tmp`, not committed). Assert in the test that `parse(ok fixture)` returns at least 1 product with a numeric `price` > 0 and a `packSize`/`packUnit` parsed from `1 kg` → `1000`/`g`, using the existing `normalize.parsePack` helpers.
- [ ] **Step 2: Write the failing tests.**
  - The parsers handle the ok fixtures.
  - Each unserviceable fixture throws kind `unserviceable`.
  - `SITES.instamart.locationCookies(defaultLoc)[0].name === 'userLocation'`.
- [ ] **Step 3: Run `node --test test/engine-sites.test.js`.** Expected: FAIL.
- [ ] **Step 4: Implement** both sites plus the registry.
- [ ] **Step 5: Run the tests, plus `LIVE=1`.** In the live test, search `toor dal` on both sites and get at least 1 product. Expected: PASS.
- [ ] **Step 6: Commit.** `feat(engine): instamart and bigbasket in-page API sites`

### Task 4: Site modules, wave 2

**Files:**
- Create: `src/engine/sites/{zepto,blinkit,kpn,jiomart,amazon,milkbasket,flipkart_minutes}.js`
- Fixtures and tests: extend Task 3's files.
- Modify: `src/extract/milkbasket.js`. Remove the bearer and `searchApi`, and fix the `cityid` bug only if any API code remains.

**Interfaces:** the same `Site` shape as Task 3. Recon starting points:
- **Zepto**
  - Search: `bff-gateway.zepto.com/search-federator-service/api/v1/search?query=`.
  - Location goes through lat/lng and the serviceability/store id. Capture the headers the page sends.
- **Blinkit**
  - Search: `POST /v1/layout/search?q=&search_type=type_to_search`.
  - Location cookies are `gr_1_lat` / `gr_1_lon`, plus the `lat`/`lon` request headers.
- **JioMart**
  - Pincode: `GET /api/service/application/logistics/v1.0/pincode/600045`.
  - Find the real search route; `/search/<q>` returns a 404 page.
- **KPN:** capture the search XHR. The default city is Mylapore, Chennai; set it to Tambaram.
- **Amazon Now:** HTML only, so `search` parses the `/s?k=&i=nowstore` HTML via in-page `fetch` + `DOMParser`. Location is pincode 600045.
- **Milkbasket:** guest GraphQL `consumerbff.milkbasket.com/graphql` `getSearchProducts`, if a guest session works.
- **Flipkart Minutes:** `1.rome.api.flipkart.com/api/4/page/fetch`.

**Rule for each site.** If no guest in-page API can be made to work, set `search` to throw `SiteError('blocked', '<site>: <exact reason>')` and keep `domFallback`. Record the reason in the diagnosis doc's recon table. Never leave a site that silently returns `[]`.

- [ ] **Step 1: Capture the ok and unserviceable fixtures** for each site that works.
- [ ] **Step 2: Write the failing parser tests** for each.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement each site.**
- [ ] **Step 5: Run the tests, plus a `LIVE=1` `toor dal` search per site.** Expected: PASS. The per-site outcome (ok / dom-only / blocked + reason) is appended to the diagnosis doc.
- [ ] **Step 6: Commit.** `feat(engine): wave 2 sites`

### Task 5: Browser pool and job runner

**Files:**
- Create: `src/engine/pool.js`, `src/engine/run.js`
- Test: `test/engine-run.test.js`

**Interfaces:**
- Consumes: `launchChrome`, `CdpTab`, `SITES` and `SiteError`.
- Produces:
  - `class BrowserPool`:
    - `constructor({ launch = launchChrome, profileDir, location })`
    - `tab(siteId) -> Promise<CdpTab>`. Opens `site.origin` warm, applies location cookies or `setLocation` once per tab, sets the matched UA, and caches the tab.
    - `refresh(siteId)` reloads the origin.
    - `restart()`
    - `close()`
    - On a crash it relaunches on the next `tab()`.
  - `runSearch({ sites: string[], queries: string[], pool, onProgress?, signal?, sitesImpl = SITES, extractors = EXTRACTORS }) -> Promise<PlatformResult[]>`
    - `PlatformResult` is exactly the shape of `platforms.js` `searchPlatform`: `{ platform, available, error, partialFailures, resultsByQuery }`.
    - Add `errorKind`, plus `failures: [{query, kind, message}]`.
  - `onProgress(event)` receives one of:
    - `{ type:'site-start', site, total }`
    - `{ type:'query', site, query, index /*1-based*/, total }`
    - `{ type:'retry', site, query, kind, message }`
    - `{ type:'fallback', site, query }`
    - `{ type:'site-done', site, ok:boolean, error? }`
- Per-query algorithm:
  1. Call `site.search`.
  2. On a `SiteError` of kind `session` or `blocked`, or on `[]` for the first query of a site: `pool.refresh(site)`, emit `retry`, and search again once.
  3. If it still fails and `domFallback` is set: emit `fallback` and run the DOM extractor through the existing `src/extract/index.js` logic, on the same pool tab.
  4. If it still fails, record the failure with its kind.

  Sites run in parallel; queries within a site run sequentially. A tab crash gives kind `browser` for that query only.

- [ ] **Step 1: Write the failing tests** with fake sites and a fake pool (no Chrome):
  - A site that throws `session` once, then succeeds: results come back and the `retry` event is emitted.
  - A site that always throws `blocked` with no fallback: `available:false`, `errorKind:'blocked'`, and the error contains the message.
  - Two sites run concurrently: total wall time < the sum of the per-site delays.
  - Progress `query` events for 3 queries have `index` 1, 2, 3 and `total` 3.
  - A crash on query 2 gives a `browser` failure for query 2 only, and query 3 succeeds.
- [ ] **Step 2: Run `node --test test/engine-run.test.js`.** Expected: FAIL.
- [ ] **Step 3: Implement the pool and the runner.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(engine): browser pool and self-healing runner`

### Task 6: Wire the engine into compareBasket and the surfaces

**Files:**
- Modify:
  - `src/platforms.js`:
    - `searchOne` must stop swallowing errors.
    - `ALL_PLATFORMS` is derived from `SITES`.
    - `selectBackend()` returns `'engine'` unless `BASKET_BACKEND=webcmd|cdp`.
  - `src/compare.js`:
    - The `engine` backend calls `runSearch`.
    - Remove the Windows path message.
    - `DEFAULT_PINCODE` comes from config (Task 8 provides `loadConfig`; until then use `'600045'`).
    - Keep fully failed platforms in `platforms` with their `error` and `errorKind`.
  - `src/score.js`: `rank()` must not drop failed platforms from `allScores`. Mark them `failed:true` instead.
  - `src/cli.js`:
    - Progress line: `\r  BigBasket · 3/5 · moong dal`.
    - Render `partialFailures` as `⚠ <site>: <query>: <kind> <message>`.
  - `src/tui.js`: the same caveats, and headers use site labels.
  - `package.json` `test` script: add every `test/*.test.js`, including `extensions.test.js`. Rewrite it as `node --test test/`.
- Test: extend `test/ranking.test.js` and `test/extensions.test.js`.

**Interfaces:**
- Consumes: `runSearch` and `BrowserPool` (Task 5).
- Produces:
  - `compareBasket({ ..., pool?, onProgress? })`. `onProgress` receives the Task 5 event objects.
  - A module-level shared pool, `getPool()`, exported from `src/engine/pool.js` and used when none is passed. It is closed on process exit.

- [ ] **Step 1: Write the failing tests.**
  - `rank()` with one failed platform keeps it in `allScores` with `failed:true`.
  - `searchOne` with a `searchApi` that throws now rethrows its message, instead of falling through to webcmd.
- [ ] **Step 2: Run `npm test`.** Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` (all green), plus a `LIVE=1 node src/cli.js basket.txt --platforms=instamart,bigbasket`.** Expected: a table with real prices, progress lines, no `not installed` errors.
- [ ] **Step 5: Commit.** `feat: engine backend with specific errors and progress`

### Task 7: Generic-vs-brand matching

**Files:**
- Modify: `src/normalize.js`
- Test: `test/matching.test.js`

**Interfaces:** `matchConfidence(query, product)` keeps its signature.

- [ ] **Step 1: Write the failing tests.**

  Accepted (`matchConfidence(q, p).score >= CONFIDENCE_THRESHOLD`):
  - `moong dal 1kg` ↔ `Fortune Unpolished Moong Dal 1 kg`
  - `moong dal 1kg` ↔ `Tata Sampann Unpolished Moong Dal 1 kg`

  Refused (score 0):
  - `moong dal` ↔ `Too Yumm! Moong Dal Namkeen 140 g`
  - `moong dal` ↔ `Haldiram's Moong Dal Crispy Fried Lentil Snack 200 g`
  - `amul butter 100g` ↔ `Britannia Butter 100g` (named brand mismatch; existing rule)

  Behaviour change:
  - `toor dal 1kg` ↔ `Udhaiyam Toor Dal 1 kg` (the brand isn't in the `BRANDS` list) gives score ≥ threshold. A brand-less query must not apply the ×0.5 unknown-brand penalty.
- [ ] **Step 2: Run `node --test test/matching.test.js`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add `namkeen`, `bhujia`, `mixture`, `chips`, `snack`, `fried`, `crispy`, `papad`, `halwa`, `ladoo` to `CATEGORY_TOKENS`.
  - Apply the brand penalty only when the query names a brand.
- [ ] **Step 4: Run all of `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit.** `fix(matching): any brand for generic queries, refuse snack variants`

### Task 8: Config and history store

**Files:**
- Create: `src/config.js`, `src/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Produces:
  - `loadConfig() -> Config` and `saveConfig(cfg)`, at `DATA_DIR/config.json`. Missing keys are filled from `DEFAULT_CONFIG`.
  - `DEFAULT_CONFIG`:
    ```js
    {
      location: {
        lat: 12.9161793,
        lng: 80.0975106,
        pincode: '600045',
        address: 'Marutham Prestige, Bharathidasan Nagar, Krishna Nagar, Tambaram, Chennai, Tamil Nadu 600045, India',
        label: 'Marutham Prestige',
      },
      phone: '',
      sites: ['instamart', 'bigbasket', 'zepto', 'blinkit'],
      basket: '<contents of basket.txt>',
      schedules: [
        { name: 'deals', sites: ['instamart', 'bigbasket'], times: ['07:00', '21:00'] },
        { name: 'daily', sites: ['zepto', 'blinkit'], times: ['07:00'] },
      ],
      server: { host: '127.0.0.1', port: 7777 },
      timezone: 'Asia/Kolkata',
    }
    ```
  - `openStore(file = DATA_DIR/basket.db) -> Store`, using `node:sqlite` `DatabaseSync`:
    - `recordResult(result /* compareBasket output */, { jobId, trigger: 'manual'|'schedule' }) -> void`
    - `historyFor(query) -> { [site]: { lowUnitPrice, unit, lowPrice, product, pack, seenAt, lastUnitPrice, lastSeenAt } }`
    - `annotate(result) -> result`. For each line and site it adds `history: { low, lowSeenAt, delta, tag: 'new-low'|'at-low'|'above-low' }`.
    - `createJob({ sites, items, trigger }) -> jobId`
    - `updateJob(id, patch)`
    - `listJobs(limit)`
    - `markInterrupted()`. Jobs left `running` become `interrupted`.
  - The history key is `(normalized query, site)`. Prices are compared per base unit: g→kg, ml→L, pc. A different unit family is never compared.

- [ ] **Step 1: Write the failing tests** with a temp `BASKET_HOME`:
  - `loadConfig()` on an empty dir returns `DEFAULT_CONFIG.location.pincode === '600045'`.
  - Record ₹120/1 kg, then ₹55/500 g. `historyFor` shows the low as ₹110/kg from the second, with its `seenAt`.
  - Then ₹130/1 kg gives `tag:'above-low'` and `delta` 20.
  - A 1 L result for the same query never replaces the kg low.
  - `markInterrupted()` flips a `running` job.
- [ ] **Step 2: Run `node --test test/store.test.js`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: config and price history store`

### Task 9: Job queue and scheduler

**Files:**
- Create: `src/jobs.js`, `src/scheduler.js`
- Test: `test/jobs.test.js`

**Interfaces:**
- Consumes: `compareBasket`, `openStore` and `loadConfig`.
- Produces:
  - `class JobQueue extends EventEmitter`:
    - `constructor({ run = compareBasket, store })`
    - `enqueue({ items, sites, trigger }) -> jobId`
    - `current() -> job|null`
    - `cancel(jobId)`
    - Events: `progress` `(jobId, event)` and `done` `(jobId, result|error)`.
  - Jobs run one at a time, FIFO. Within a job, sites run in parallel (Task 5). The result is `store.annotate`d and `recordResult`ed.
  - `startScheduler({ queue, getConfig, now = () => new Date(), tickMs = 30000 }) -> { stop() }`
    - At each tick, for each schedule and each `HH:MM` in `config.timezone` that falls within the last tick window and hasn't fired today, it enqueues `{ items: config.basket, sites: schedule.sites, trigger:'schedule' }`.
    - Fired keys are persisted in the store, so a restart doesn't double-fire.

- [ ] **Step 1: Write the failing tests** with a fake `run`, a fake clock and a temp store:
  - Two enqueued jobs run sequentially; the second starts after the first is done.
  - A schedule at `07:00` fires once between ticks 06:59:50 and 07:00:20, and doesn't fire again at 07:00:50.
  - A schedule job enqueued during a manual job waits and then runs.
  - `cancel` aborts the running job's signal.
- [ ] **Step 2: Run `node --test test/jobs.test.js`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: job queue and daily scheduler`

### Task 10: Server API (SSE, jobs, history, config)

**Files:**
- Modify: `src/server.js`, `src/cli.js` (`serve` starts the queue and scheduler)
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `JobQueue`, `startScheduler`, `openStore`, `loadConfig` and `saveConfig`.
- Produces routes:
  - `POST /api/compare {items, platforms}` → `202 {jobId}`. This replaces the 409 lock: requests queue instead.
  - `GET /api/events` is SSE, sending `progress`, `done` and `job` events as JSON.
  - `GET /api/jobs`
  - `GET /api/result[?jobId]`
  - `GET /api/history?q=`
  - `GET /api/config`
  - `PUT /api/config`, which validates `HH:MM` times, known site ids and the lat/lng range, and returns 400 with a field message.
  - `POST /api/stop {jobId}`
  - `GET /settings` serves `src/ui/settings.html`.
  - Keep `/`, `/health` and `/api/meta`.

- [ ] **Step 1: Write the failing tests**, using the existing injected fake `compare` pattern:
  - Two quick `POST /api/compare` calls both get 202 with different jobIds.
  - `/api/events` receives a `progress` event, then `done`.
  - `PUT /api/config` with `times:['25:00']` returns 400.
  - `GET /api/history?q=toor dal` returns 200 JSON.
- [ ] **Step 2: Run `node --test test/server.test.js`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all of `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): queued jobs, SSE progress, history and config API`

### Task 11: Web UI (blocked on mockup approval)

**Files:**
- Modify: `src/ui/basket.html`
- Create: `src/ui/settings.html`

**Interfaces:** consumes Task 10's routes.

Build exactly the approved mockup. Requirements already fixed:
- No horizontal scroll at 1280 px with 9 sites.
- Cheapest cell per item: dark green. Second cheapest: light green.
- A progress strip from SSE, e.g. `BigBasket · 3/5 · moong dal`.
- Per-cell history badge.
- Specific errors per site.
- The settings page edits schedules, sites, location and phone, and has a "Run now" button.

- [ ] **Step 1:** Implement against the approved mockup.
- [ ] **Step 2:** Verify with headless Chrome screenshots at 1280×800 and 390×844, saved under `docs/evidence/2026-11-16-ui/` with a README. Check there's no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`).
- [ ] **Step 3:** Commit. `feat(ui): compare and settings pages`

### Task 12: Optional logins and session lifetime

**Files:**
- Create: `src/engine/login.js`
- Modify: `src/cli.js` (`basket login <site>`, `basket sessions`), and the `login` blocks in the site modules (Instamart first)
- Test: `test/login.test.js`

**Interfaces:**
- Produces:
  - `sessionStatus(pool, siteId) -> { loggedIn: boolean, cookies: [{ name, expiresAt }], earliestExpiry }`, read from `tab.getCookies()` filtered by `site.login.authCookies`.
  - `startLogin(pool, siteId, phone)`
  - `submitOtp(pool, siteId, otp) -> sessionStatus`
- The browser profile on the data volume is the session store, so nothing is copied out. `basket sessions` prints each site's status and warns when `earliestExpiry` is under 3 days away.

- [ ] **Step 1: Write the failing test.** `sessionStatus` with a fake tab returning `tid` (expires in 30 d) and `sid` (expires in 1 h) gives `loggedIn:true`, `earliestExpiry` = the sid expiry. Here `authCookies:['tid']` is used for login detection.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement it.** Then do one real Instamart OTP login with the user's phone number. Record the measured cookie expiries after login, and again after 24 h of scheduled visits, in the diagnosis doc.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: optional site logins with session status`

### Task 13: Docker

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.dockerignore`
- Modify: `README.md` (run section)

**Interfaces:**
- Image: `node:24-slim`, plus `chromium` and `fonts-noto` from Debian. Env:
  - `CHROME_PATH=/usr/bin/chromium`
  - `BASKET_HOME=/data`
  - `BASKET_HOST=0.0.0.0` (inside the container only)
- `CMD ["node","src/cli.js","serve"]`.
- Compose:
  - volume `basket-data:/data`
  - `ports: ["127.0.0.1:7777:7777"]`
  - `restart: unless-stopped`
  - `shm_size: 1gb`
  - a healthcheck on `/health`

- [ ] **Step 1:** Run `docker compose build`. Expected: success.
- [ ] **Step 2:** Run `docker compose up -d`, then `curl -s 127.0.0.1:7777/health`. Expected: `ok`.
- [ ] **Step 3:** `POST /api/compare` with `toor dal 1kg` on instamart and bigbasket. Poll `/api/result`. Expected: prices from both sites.
- [ ] **Step 4:** Commit. `feat: docker service`
