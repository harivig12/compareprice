# Second Accounts, Deals and Offer Check: Implementation Plan

> **Status 2026-11-19: Tasks 0–10 built in this session (native), `npm test` 251/252 (1 live skipped), redeployed.** Live checks:
> - Milkbasket offer check: 25 deals out of 36 (Tomato Desi ₹1 / MRP ₹78, max 1 item, basket ₹9+).
> - Instamart home feed: 23 products, none 80%+ off.
> - Milkbasket catalogue search: 6,216 products in 223 s, then 1 s from the cache.
>
> Changes from the plan:
> - Milkbasket "search" is the catalogue (the app has no search query).
> - API first replaces most page loads for Instamart and Milkbasket (`src/engine/direct.js`).
> - The plan's Task 3 signout route is `POST /api/login/signout`.
>
> Not yet verified live:
> - a second account's sign-in (needs the second phone's OTP)
> - BigBasket sign-in (selectors are from a read-only look)
> - Instamart per-account price differences
>
> **Review done** (one fresh reviewer over the whole change). Fixed, each with a test:
> - PoolSet closed a pool that a queued step still needed.
> - A failed offer check emptied that account's deals.
> - The shared pool could miss `ownLocation` after a restart.
> - Signing out kept the account's deals.
> - Search deals were never pruned.
> - Ports could collide.
> - 79.96% off counted as 80%.
> - A hand-edited `accounts.json` could set any profile path.
>
> Open: a job could start in the moment between sign-out's busy check and its clean-up. The window is small; a lock shared with the queue would close it.
>
> `npm test`: 254 of 255 pass, 1 live test skipped. Redeployed; a live Instamart + Milkbasket run took 15 s with both sites 2/2.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extra Instamart/Milkbasket accounts in their own Chrome profiles; Milkbasket product search for the main account; Instamart searched per account; an 80%+ Deals table fed by searches and per-account offer feeds; BigBasket sign-in.

**Architecture:**
- **Accounts:** `accounts.json` holds the accounts. The main account keeps `chrome-profile`, and each extra account gets `profiles/<site>-<id>`.
- **Pools:** a `PoolSet` launches one `BrowserPool` per extra profile, only for the step that needs it, and closes it afterwards.
- **Totals:** `compareBasket()` stays the only place totals are made. It merges Instamart candidates across accounts, with each one tagged by account.
- **Deals:** stored in a `deals` table, and the page renders them below the comparison table.

**Tech Stack:** Node ≥ 22.13 ESM, `node:sqlite`, CDP over WebSocket (`src/engine/cdp.js`), `node --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-accounts-deals-design.md`

## Global Constraints

- All of `AGENTS.md`:
  - `compareBasket()` is the only place totals are made.
  - Site calls go through `pageFetch` in the site's tab.
  - Every failure is a `SiteError` whose message starts with the site id.
  - Location comes from `config.location`.
  - No tokens, cookies, device ids or phone numbers in source, fixtures or logs.
  - The UA matches the real Chrome version (`matchedUserAgent`).
- Extra accounts only where `LOGIN_SITES[site].multiAccount === true` (instamart, milkbasket). At most **3 accounts per site**, main included.
- Milkbasket extra accounts **never search products**. Instamart searches **every** signed-in account, one account after another.
- The request budget stays **per site** (`src/limits.js`) and is shared by that site's accounts.
- Deal threshold `config.deals.minDiscountPct`, default **80**: a deal means `mrp > 0 && price <= (1 - pct/100) * mrp`. Deals never count in totals.
- Only masked hints (`••••••0494`, `a•••@x.com`) and the user's account name are persisted.
- Copy, verbatim:
  - Heading "Deals · 80%+ off" (with the configured number), subtitle "not in totals · checked HH:MM"
  - Empty state "No 80%+ deals in the last check (HH:MM)."
  - Group name "From searches"
  - Link "+ Add account"
- `npm test` stays offline and green. Any recon is read-only, on a `/tmp` copy of the profile, and the copy is deleted afterwards.
- Commit steps run only once the user has asked for commits (repo rule). Until then, stage nothing and leave the work uncommitted on the branch.

## Review Focus

- An extra account's session expires (the site shows its sign-in again). Expect a `SiteError('session', '<site>: account "<name>" is signed out…')` for that account only; other accounts and the main account still count. Test: Task 6.
- A deal row with `mrp` null, 0 or below `price`. It must not be a deal, and must not produce NaN or Infinity. Test: Task 7.
- Removing an account while a job, sign-in or offer check uses its pool. Expect 409 "busy, try again after the current run", and nothing deleted. Test: Task 3.
- An offer feed with `hasNextPage: true` forever, or an empty page. Stop at 10 pages or the first empty page, and report what was read. Test: Task 8.
- Instamart account 2 is in a 429 cool-down. Expect account 1's prices to be used, the total built from account 1 only, and a partial failure naming account 2. Test: Task 6.

---

### Task 0: Read-only recon (no product code)

**Files:**
- Create: `test/fixtures/sites/milkbasket-search.json` (scrubbed)
- Create: `test/fixtures/sites/milkbasket-flashdeal.json` (scrubbed)
- Create: `test/fixtures/sites/instamart-offers.json` (scrubbed), only if a feed exists
- Modify: `docs/diagnosis/2026-11-19-account-offers-zepto-milkbasket.md`

- [ ] **Step 1:** On a `/tmp` copy of `/home/a/basket-data/chrome-profile`, run only while the container's Chrome is closed (`docker exec basket sh -c 'ps -eo args | grep -c "[c]hrome"'` gives `0`). Capture:
  - (a) the GraphQL operation and variables Milkbasket's web app sends for a typed search of "toor dal". Open search with the header's search element, type, and press Enter.
  - (b) one `getMegaFlashDeal` + `getMegaFlashDealProducts` page.
  - (c) the API calls the signed-in Instamart home makes whose URL or response contains `offer|deal|₹1|free`, and their product shape.
  - (d) BigBasket's sign-in sheet as a guest, on a fresh profile: its selectors for the number box and button. Type nothing.
- [ ] **Step 2:** Scrub the fixtures: replace ids that look like user or session ids with `"x"`, and mask digit runs of 10 or more. Check with `grep -E '[0-9]{10}' test/fixtures/sites/milkbasket-*.json test/fixtures/sites/instamart-offers.json`; expected: no output.
- [ ] **Step 3:** Record the operation names, variables, URLs and selectors in the diagnosis doc, then delete the `/tmp` copies (`ls /tmp | grep -i profile` → nothing of ours).
- [ ] **Step 4:** Commit: `docs(sites): recon milkbasket search, deal feeds, bigbasket sign-in`

### Task 1: Accounts model and migration

**Files:**
- Create: `src/engine/accounts.js`
- Modify: `src/engine/login.js` (LoginManager keyed by site + account; `multiAccount` on instamart and milkbasket)
- Modify: `src/server.js` (`/api/login*`, `/api/accounts/remove`)
- Test: `test/accounts.test.js`, plus updates to `test/login.test.js` and `test/server.test.js`

**Interfaces:**
- Produces `openAccounts(file, { legacyFile }) -> Accounts`:
  - `list(site) -> Account[]`
  - `get(site, id) -> Account|null`
  - `add(site, { name }) -> Account`, which throws `SiteError('parse', '<site>: 3 accounts is the limit')` and rejects duplicate names
  - `markSignedIn(site, id, { hint })`
  - `markSignedOut(site, id)`
  - `remove(site, id)`
  - `signedIn(site) -> Account[]`
- `Account = { id: 'main'|'a2'|'a3', name, hint, loggedInAt, profile }`. `profile` is `'chrome-profile'` for main, otherwise `'profiles/<site>-<id>'`.
- The LoginManager gains an `account` argument: `start(site, rawId, { account = 'main', name } = {})`, `verify(site, secret, { account = 'main' } = {})`. Its state map is keyed `${site}:${account}`. `status()` returns one row per site with `accounts: [{ id, name, hint, loggedIn, since, state, message, error, pending, resendInMs, secret }]`, and keeps the existing top-level fields for the main account.

- [ ] **Step 1: Write the failing tests.**
  - `migrates sessions.json into accounts.json once`: legacy `{ zepto: { loggedInAt, phoneLast4: '0494' } }` becomes `list('zepto')` = `[{ id: 'main', name: 'Main', hint: '••••••0494', profile: 'chrome-profile', … }]`, and the legacy file is left untouched.
  - `add() allows extra accounts only on multiAccount sites, max 3`: `add('zepto', …)` throws `/zepto: one account only/`, and the fourth `add('instamart', …)` throws `/3 accounts is the limit/`.
  - `wrong-account guard is per account`: main signed in as ••••••0494; `start('instamart', '9800001234', { account: 'a2' })` is allowed, and the same start on `main` throws `code: 'other_account'`.
  - Server: `POST /api/login/start { site: 'instamart', name: 'Amma', id: '9800001234' }` → 202 with `account: 'a2'`; `GET /api/login` shows two instamart accounts.
- [ ] **Step 2:** Run `node --test test/accounts.test.js test/login.test.js test/server.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement. Write `accounts.json` atomically (write a temp file, then rename).
- [ ] **Step 4:** Run `npm test`. Expected: all pass.
- [ ] **Step 5:** Commit: `feat(engine): accounts per site with migration from sessions.json`

### Task 2: PoolSet for extra profiles

**Files:**
- Create: `src/engine/poolset.js`
- Modify: `src/engine/login.js` (`defaultLoginManager` resolves the account's pool)
- Modify: `src/service.js`
- Test: `test/poolset.test.js`

**Interfaces:**
- Consumes `Account.profile` (Task 1).
- Produces `PoolSet({ dataDir, makePool = (opts) => new BrowserPool(opts), basePort = 9400 })`:
  - `forAccount(account) -> BrowserPool`: main returns the shared `getPool()`; an extra account gets a pool on `profileDir = join(dataDir, account.profile)` and port `basePort + n`.
  - `with(account, fn)`: runs `fn(pool)`, then closes an extra pool afterwards; main stays open for the idle closer.
  - `busy(account) -> boolean`
  - `closeAll()`

- [ ] **Step 1: Write the failing tests.**
  - `extra accounts get their own profile and port; main reuses the shared pool`
  - `with() closes an extra pool after use, even when fn throws`
  - `two with() calls on the same account run one after another`
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Every pool gets `location: config.location` and `blockMedia`, and calls `disablePasswordSaving` through `launchChrome` (already done).
- [ ] **Step 4:** Run `npm test`. Expected: pass.
- [ ] **Step 5:** Commit: `feat(engine): separate browser profile per extra account`

### Task 3: Sign out and remove

**Files:**
- Modify: `src/engine/login.js`, `src/engine/pool.js` (`clearSiteData(siteId)`), `src/server.js`
- Test: `test/login.test.js`, `test/server.test.js`

**Interfaces:**
- `BrowserPool.clearSiteData(siteId)`: calls `Storage.clearDataForOrigin({ origin, storageTypes: 'all' })` for each origin in `site.signOutOrigins ?? [site.origin]`.
- `POST /api/login/signout { site, account }`:
  - main: clears that site's data only
  - extra account: `accounts.remove`, and the profile directory is deleted (`rmSync`, only under `<data>/profiles/`)
  - in use (`PoolSet.busy` or a job running that site): 409 `{ error: '<site>: busy, try again after the current run' }`

- [ ] **Step 1: Write the failing tests.**
  - `sign out of main clears only that site's origins`: a fake pool records `clearDataForOrigin` calls for `https://www.swiggy.com` only.
  - `removing an extra account deletes only its profile dir`: a path outside `<data>/profiles/` throws.
  - `remove while busy is 409 and deletes nothing`
- [ ] **Steps 2–4:** Run (fail), implement, run `npm test` (pass).
- [ ] **Step 5:** Commit: `feat(engine): sign out per site and remove extra accounts`

### Task 4: BigBasket sign-in

**Files:**
- Modify: `src/engine/login.js` (add `LOGIN_SITES.bigbasket`, with the selectors from Task 0)
- Modify: `src/engine/sites/bigbasket.js` (header comment: sign-in optional)
- Test: `test/login.test.js`

- [ ] **Step 1: Write the failing tests.**
  - `bigbasket: number -> OTP on its sign-in sheet`
  - `bigbasket: an Access Denied page during sign-in stops with blocked, no retry`: the fake page text is "Access Denied … Reference #"; expect `e.kind === 'blocked'` and exactly one `goto`.
- [ ] **Steps 2–4:** Run (fail), implement (`botWall: /access denied|reference #/i` checked after each step), run `npm test` (pass).
- [ ] **Step 5:** Commit: `feat(engine): optional bigbasket sign-in`

### Task 5: Milkbasket product search (main account)

**Files:**
- Create: `src/engine/sites/milkbasket.js`, replacing the `skip` DOM entry in `src/engine/sites/dom-sites.js` and `index.js`
- Test: `test/engine-sites.test.js` (fixture `milkbasket-search.json`)

**Interfaces:**
- Produces a standard site module (`docs/ENGINE.md` › Site module shape): `parse(json) -> Row[]` and `search(tab, query)`, replaying the captured search operation from Task 0 via `_capture.js`.
- Prices come from `product.price.price.value` and MRP from `product.price.mrp.value`; the pack comes from `bestPack(product.weight.text, name)`.
- If the session is missing: `SiteError('session', 'milkbasket: sign in (main account) to search')`.

- [ ] **Step 1: Write the failing tests.**
  - `milkbasket parser reads price, MRP and "1 KG - 1.1 KG Approx" as 1 kg`
  - `registry: milkbasket is an api site, no longer skipped`: update the existing `marks the eight guest-API sites` test to nine sites.
- [ ] **Steps 2–4:** Run (fail), implement, run `npm test` (pass).
- [ ] **Step 5:** Commit: `feat(sites): milkbasket search for the signed-in account`

### Task 6: Instamart searched per account in `compareBasket()`

**Files:**
- Modify: `src/compare.js`, `src/engine/run.js` (accept `accounts: { instamart: Account[] }` and a pool per account from `PoolSet`)
- Modify: `src/store.js` (nullable `account` column on `prices`; record it; history reads the cheapest across accounts)
- Test: `test/compare-engine.test.js`, `test/store.test.js`

**Interfaces:**
- Engine results per site gain `resultsByQuery[q] = Row[]`, with each row carrying `account` (an id).
- Scored lines gain `product.account` and `accountPrices: [{ account, name, price }]`, sorted ascending.
- Failures: `partialFailures: [{ account, kind, message }]`.

- [ ] **Step 1: Write the failing tests.**
  - `instamart rows from two accounts merge; the cheaper account wins the line`: main gives ₹159 and a2 gives ₹154, so `lineTotal === 154`, `product.account === 'a2'`, and `accountPrices` has `[154, 159]`.
  - `an account in cool-down is a partial failure; the other account's prices count`: a2 throws `SiteError('blocked','instamart: …')`; the total uses main, and `partialFailures[0].account === 'a2'`.
  - `an extra account signed out is a session error for that account only`
  - `milkbasket searches only the main account, even with extra accounts`
  - Store: `price rows keep the account; history uses the cheapest across accounts`
- [ ] **Steps 2–4:** Run (fail), implement (accounts run one after another; each search call `acquire()`s the site's shared budget), run `npm test` (pass).
- [ ] **Step 5:** Commit: `feat(compare): search instamart per account, cheapest wins`

### Task 7: Deals store and deals from searches

**Files:**
- Create: `src/deals.js`
- Modify: `src/store.js` (`deals` table, `recordDeals`, `currentDeals`), `src/compare.js` (collect deals from every candidate, including ones the price check removed)
- Modify: `src/config.js` (`deals.minDiscountPct: 80`, validated 50–99)
- Modify: `src/server.js` (`GET /api/deals`), `src/mcp/tools.js` (tool `deals()`)
- Test: `test/deals.test.js`, `test/mcp.test.js`, `test/server.test.js`

**Interfaces:**
- `isDeal(row, pct) -> boolean`, `toDeal(row, { site, account, source, seenAt }) -> Deal`
- `Deal = { site, account, product, pack, price, mrp, pct, conditions: { maxQty?, minBasket? }, url, seenAt, source: 'search'|'feed' }`
- Store:
  - `recordDeals(deals, { site, account, source })`: a `feed` call replaces that site and account's feed deals; `search` calls append.
  - `currentDeals({ now }) -> { checkedAt: { [site]: iso }, groups: [{ site, conditions, deals: Deal[] }], fromSearches: Deal[] }`, where search deals are those from the last 24 h. Rows are merged by site and product, and `seenBy: [{ account, name, hint, seenAt }]` is used for the hover.
- The result gains `deals: Deal[]`.

- [ ] **Step 1: Write the failing tests.**
  - `isDeal: ₹1 against MRP ₹78 is a deal at 80; ₹20 against ₹78 is not`
  - `isDeal: mrp null, 0 or below price is never a deal, and no NaN`
  - `deals from searches include rows the price check removed, and never change totals`
  - `a feed check replaces that account's feed deals; search deals expire after 24 h`
  - `the same product seen by two accounts is one row with both in seenBy`
  - MCP: `deals tool lists groups and the not-in-totals note`
- [ ] **Steps 2–4:** Run (fail), implement, run `npm test` (pass).
- [ ] **Step 5:** Commit: `feat(deals): 80%+ deals from searches, stored and served`

### Task 8: Offer check (feeds, no product search)

**Files:**
- Create: `src/offers.js` (`checkOffers`)
- Modify: `src/engine/sites/milkbasket.js` (`offers(tab)`), `src/engine/sites/instamart.js` (`offers(tab)`, only if Task 0 found a feed)
- Modify: `src/service.js` (run after each scheduled job), `src/server.js` (`POST /api/offers/run` → 202 `{ jobId }`; it shares the job queue as `trigger: 'offers'`)
- Test: `test/offers.test.js`, `test/engine-sites.test.js` (fixture `milkbasket-flashdeal.json`)

**Interfaces:**
- `site.offers(tab) -> Promise<Row[] & { conditions }>`. Milkbasket reads `getMegaFlashDeal` → `getMegaFlashDealProducts` for page 1 to N, stopping at `!hasNextPage`, an empty page, or **10 pages**.
- `checkOffers({ poolSet, accounts, sites = ['instamart','milkbasket'], store, limiter, onProgress }) -> { results: [{ site, account, deals, error? }] }`. It covers each signed-in account, one after another, through the site budget, and writes `recordDeals(..., source: 'feed')`.

- [ ] **Step 1: Write the failing tests.**
  - `milkbasket flash deal: 36 records over 3 pages; Tomato ₹1 / MRP ₹78, maxQty 1`
  - `feed paging stops at an empty page and at 10 pages`
  - `an account whose feed fails is reported with its name; others still record`
  - `offer check runs after a scheduled job, not after a manual one`
  - `offer check never calls site.search`
- [ ] **Steps 2–4:** Run (fail), implement, run `npm test` (pass).
- [ ] **Step 5:** Commit: `feat(offers): per-account offer check after scheduled runs`

### Task 9: Sign-in popup, layout A

**Files:**
- Modify: `src/ui/basket.html` (dialog markup and popup script)
- Evidence: `docs/evidence/2026-11-19-accounts-deals/`

- [ ] **Step 1:** Render per site:
  - an account row: name · hint · status · Sign in / Sign out / Remove
  - "+ Add account" on `multiAccount` sites, opening a name field and then the existing number → OTP steps
  - a confirm dialog before Remove
  - all server text through `esc()`
- [ ] **Step 2:** Syntax-check the inline script (`node --check` on the extracted script) and run `npm test`.
- [ ] **Step 3:** Screenshot with `scripts/ui-screenshot.js` at 1280 and 390, light and dark, with dummy numbers. Expected: `noHorizontalScroll: true`.
- [ ] **Step 4:** Commit: `feat(ui): accounts per site in the sign-in popup`

### Task 10: Deals table (option 1) and account hover

**Files:**
- Modify: `src/ui/basket.html`, `src/ui/theme.css` (the green % off pill uses `--best`)
- Evidence: `docs/evidence/2026-11-19-accounts-deals/`

- [ ] **Step 1:** Render `GET /api/deals` below the table, using the Global Constraints copy:
  - per-site groups with conditions
  - the first 5 rows, then "+ N more"
  - a hover (`title` plus a visible tooltip on focus) listing `seenBy`
  - "Check offers" calls `POST /api/offers/run`
  - Instamart cells show `accountPrices` on hover
  - before a fresh run with more than one Instamart account, the run bar shows "Instamart: N accounts · about M min extra" (M = accounts × items × the site's minimum gap, rounded up)
- [ ] **Step 2:** Syntax check and `npm test`.
- [ ] **Step 3:** Screenshots as in Task 9, plus an empty-state shot.
- [ ] **Step 4:** Commit: `feat(ui): deals table and per-account price hover`

### Task 11: Docs, redeploy, live check, review

- [ ] **Step 1:** Update the docs:
  - `README.md`: accounts, Deals, Check offers, BigBasket sign-in
  - `docs/API.md`: accounts, signout, deals, offers/run, `accountPrices`
  - `docs/ENGINE.md`: PoolSet, Milkbasket module, offer feeds
  - `docs/OPERATIONS.md`: profiles dir, troubleshooting
  - `CHANGELOG.md`
- [ ] **Step 2:** Redeploy with the `docker run` line in OPERATIONS. `curl -s localhost:7777/health` must give `"ok":true`.
- [ ] **Step 3:** One gentle live pass, then record the outcome in the diagnosis doc:
  - a Milkbasket search of 2 items
  - one Instamart run (2 items) with all signed-in accounts
  - one offer check
- [ ] **Step 4:** Run the code-review skill against `main`, and fix the findings.
- [ ] **Step 5:** Commit: `docs: accounts, deals and offer check`
