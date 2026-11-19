# Plan: OTP step, light/dark theme, price ▲▼, last-3-dates, MCP for AI chat (2026-11-19)

Status: **planning only**. Agree each task below, then all code is written in one pass (order at the end).
Ground rules: AGENTS.md. `compareBasket()` stays the single entry point, and `npm test` stays green offline.

---

## Task 1: OTP box after "Send OTP", button becomes "Verify"

**Root cause, found 2026-11-19 by inspecting the service's own Chrome tab:**
- **The number was entered correctly.** The Milkbasket tab reads "Verify Your Number · We have sent an OTP to your phone. **+91-9711020494**". **The OTP was actually sent.**
- **The popup didn't move on because our check for the OTP boxes was wrong.** Milkbasket shows 4 boxes, but the first has `maxlength=4` and the other three `maxlength=1`. The detector wanted 4 boxes of `maxlength=1`, saw 3, waited 15 s, then failed with "no OTP box appeared". The popup kept its number screen with that error, so it looked as if there was no place to type the OTP.
- **Nothing was logged.** The login flow writes no log lines today, so the failure wasn't in `docker logs`.
- **No Zepto attempt happened.** Its tab still shows "Please login to continue searching".

**Fix (added to the design below):**
- **Detecting the OTP screen:** any of (a) the page says it sent an OTP ("sent an OTP", "Verify Your Number", "Enter OTP"), (b) 4 or more visible short `tel`/number inputs, (c) an `autocomplete=one-time-code` input.
- **Entering the OTP:** focus the first box and type the digits as real key presses (the boxes auto-advance). Then check every box is filled; if not, type one digit per box.
- **Note for the live test:** a Milkbasket OTP request has already happened, so the 30 s resend gap and the 3-per-hour cap count from now.

### Amazon login approach (your decision 1: check it)
Checked without submitting a number:
- `amazon.in/ap/signin` now redirects to `/ax/claim` with **"Sign in or create account · Enter mobile number or email · Continue"**. Our selectors find both the box (`#ap_email_login`) and Continue.
- **After Continue, the page depends on the account:**
  - **(a) Password page:** we look for "Get an OTP on your phone" or "Sign in with a one-time code" and use it; if neither is offered, we say so.
  - **(b) Direct OTP page:** enter the OTP.
  - **(c) "Create account"** (the number is not registered): reported as "no Amazon account for this number".
- **Extra step:** Amazon may show a CAPTCHA or a "Verify it's you" push approval. The popup will show the page's own message and offer "Open in a normal browser" rather than guess.
- **Caveat:** signing in does not change Amazon Now's answer for 600045 (`validateLocation.isServiceable=false`) unless your account's saved address resolves to a serviceable store. After sign-in we read the account's default address and re-check serviceability. If it's still false, Amazon stays "not delivering here", with that reason.


**What happens today (checked):**
- The popup only swaps to the OTP box after the server has driven the site's login page *and* seen the site's own OTP box (`/api/login/start` must return 200). That takes 15–30 s.
- If any step on the site fails, the popup stays on the number screen with a one-line error, so it looks like there is "no option to enter OTP".
- No login attempt is logged (`docker logs` shows none) and `sessions.json` doesn't exist. The flow has never completed live.

**Design:**
1. **Switch screens immediately.** Clicking **Send OTP** switches the popup to step 2 at once:
   - The number is shown read-only, e.g. "OTP sent to ••••••0494 · Change number".
   - The **OTP box** is visible and focused.
   - The button text becomes **Verify**. It is disabled, with "Waiting for the site…", until the server confirms the OTP was requested.
2. **Status line under the OTP box:**
   - `sending…`
   - `✓ OTP requested, enter it below`
   - or the exact error from the site, e.g. "zepto: no OTP box appeared (page says: …)"
3. **On error,** stay on step 2 and show **Resend OTP** and **Change number**. Resend is limited to one every 30 s, with a countdown "Resend in 27s". The existing 3-per-hour cap stays.
4. **Verify** sends the OTP.
   - Wrong OTP: "the site rejected that OTP". The box clears and stays on step 2.
   - Success: "Signed in ✓". The account list updates to show "signed in 19 Nov ••••0494", and the popup returns to step 1 for another site.
5. **Non-blocking start.** `POST /api/login/start` returns right away with `{ state: 'sending' }` and finishes in the background. The popup polls `GET /api/login` (`pending`, `state`, `error`) every second. This avoids a 30 s HTTP request that can time out, and survives closing and reopening the popup.
6. **Logging.** Every step is logged to the service log, with the number masked: `login zepto: number entered`, `OTP box seen`, `verify ok`, or the exact failure.
7. **Live check.** One real login on **Zepto** first, since it's the most useful; it's needed for searching at Krishna Nagar. The user reads out the OTP. The measured cookie lifetimes are recorded in the diagnosis doc, which also answers "does it stay signed in without a new OTP".

**Files:** `src/ui/basket.html` (dialog), `src/server.js` (start becomes async plus a state field), `src/engine/login.js` (state machine `idle → sending → otp_sent → verifying → signed_in | error`, plus logging).
**Tests:** the manager state goes through `sending → otp_sent` and `sending → error(message)`; a second start within 30 s is refused with the wait time; the route returns immediately. UI evidence: screenshots of step 2 in sending, sent and error states.

**Decision (2026-11-19):** check the Amazon login approach (above). Amazon stays in the list, and the popup notes "Amazon Now doesn't deliver to 600045 today".

---

## Task 2: Light and dark mode

**Today:** dark only. The colours are hardcoded CSS variables in `basket.html` and `settings.html`, plus a few inline colours (`#7ee787`, `#ffb4ad`, …).

**Design:**
- **Toggle:** a **☀ / ☾ / Auto** control in the header of both pages. **Auto** follows the system's `prefers-color-scheme`, and it is the default.
- **Storage:** the choice is saved in `localStorage` (per browser), with no server change. It is applied before the first paint, so there's no flash.
- **One set of variables per theme:** `:root[data-theme=light]` and `:root[data-theme=dark]`. Every inline colour moves into a variable (`--best`, `--second`, `--good-ink`, `--bad-ink`, `--badge-low`, …).
- **Light palette (proposal):**
  - background `#ffffff`, panel `#f6f8fa`, text `#1f2328`
  - **cheapest** `#1a7f37` with white text
  - **second cheapest** `#dafbe1` with dark green text
  - warning `#9a6700`, error `#cf222e`

  Both themes keep the same meaning: dark green is cheapest, light green is second.
- **Contrast:** checked for AA (4.5:1) on price text in both themes.

**Gate:** per standing preference, show a light-mode mockup first. **Shown and approved 2026-11-19.** The palette is the one in the mockup: background `#ffffff`, panel `#f6f8fa`, text `#1f2328`, cheapest `#1a7f37` with white text, second `#dafbe1` with `#0f5323` text, ▼ `#1a7f37`, ▲ `#cf222e`, warning `#9a6700`.

**Files:** `src/ui/basket.html`, `src/ui/settings.html`.
**Evidence:** screenshots of light and dark at 1280 and 390 px; the no-horizontal-scroll check in both.

---

## Task 3: Price went up / down icon (▲ ▼)

**Is it implemented?** Partly.
- Today each cell compares only with the **lowest price ever seen**: "new low", "at lowest", or "low ₹x · date".
- There is **no "vs last time" ▲/▼**. The store already keeps every observation (332 rows so far), so the data exists.

**Design:**
- **Store:** `annotate()` also adds `prev: { unitPrice, price, seenAt }`, the latest earlier observation for the same item and site (any day). It also adds `change: 'up' | 'down' | 'same'` and `changePct` (`same` when below 1%).
- **Cell, next to the price:**
  - **▼ ₹4 (6%)** in green when cheaper than last time
  - **▲ ₹6 (9%)** in red when dearer
  - nothing when unchanged or seen for the first time

  The tooltip shows "was ₹69 on 18 Nov". The existing "new low" badge stays; ▼ and "new low" can show together.
- **Units:** the comparison is per unit (₹/100 g), so a pack-size change doesn't show as a price change. The tooltip shows both the rate and the pack price.
- **Lookup table** (Task 4) uses the same arrows between its date columns.

**Decision (2026-11-19): against the latest available data.** ▲/▼ compares with the **most recent earlier saved price** for that item and site, even from earlier the same day (e.g. 12:00 vs 10:00). This catches time-of-day deals. Changes under 1% show as "=", not an arrow. The tooltip names the run: "was ₹21 · 19 Nov 10:00".

**Files:** `src/store.js` (`annotate`), `src/ui/basket.html` (cell and card).
**Tests:** previous day lower gives `down` with the right %; same day only gives no arrow; a different pack at the same rate gives `same`; a different unit family gives no arrow.

---

## Task 4: Last 3 dates in the "Check a saved price" box

**Are we storing it?** Yes. Every run's price is stored per item and site, with a timestamp (`prices` table). For example, onion has 1 to 5 rows per site per day for 18 and 19 Nov. Today the lookup only shows the **latest** rate and the **lowest** rate.

**Design:**
- **Store:** a new `store.recentRates(query, { days: 3 })` returns, per site, the rate on each of the **last 3 dates that have data**. One value per date: the **lowest that day**, which is the deal-hunting view; the closing value is a possible alternative.
- **API:** `GET /api/lookup` adds `dates: ['17/11/26','18/11/26','19/11/26']` and, per site, `rates: [6.9, 6.9, 6.38]` (null where that site has no data that day).
- **Lookup table:**

  | Site | 17/11 | 18/11 | 19/11 | Lowest ever |
  |---|---|---|---|---|
  | Flipkart | — | ₹6.9 | **₹6.38 ▼** | ₹6.38 · 19 Nov |
  | Blinkit | ₹6.9 | ₹6.9 | ₹6.9 | ₹6.9 · 18 Nov |

  - The rate is per 100 g, 100 ml or piece, as today.
  - The cheapest cell in each date column is green.
  - ▲/▼ appear between adjacent dates.
  - Hovering a cell shows the price, pack and product.
- **Suggestions dropdown** also shows the best rate of the latest date, e.g. "onion 1kg · ₹6.38/100g · 19/11/26".
- **Phones:** the per-date columns collapse to "latest + ▲▼".

**Decision (2026-11-19): last 3 dates that have data.** Each value is the lowest rate that site had that date.

**Layout chosen: option B, a compact trend line, one line per vendor.**
- Every site with saved data gets its own row: Zepto, Flipkart, BigBasket, Instamart, Blinkit, KPN, JioMart, and Amazon once it has data.
- Columns: **Site · Trend (3 dates) · Now · Lowest ever**.
- **Trend** is three small bars plus the three rates, e.g. `6.55 → 6.55 → 6.90`, with "—" where that site had no data on a date.
- **Dates** are shown once, in the box header (e.g. "18/11 → 19/11 → 20/11"), and on hover for each value. Hovering a value also shows the pack price and product, e.g. "₹20 · Organically Grown Onion 500 g · 19/11 10:00".
- **Now** is the latest rate with ▼/▲ against the previous saved value (decision 2).
- **Ordering and colour:** rows are sorted by **Now**, cheapest first, and the cheapest row is green.
- **Phones:** the bars shrink and the "Lowest ever" column drops; the text trend stays.

**Files:** `src/store.js`, `src/server.js` (`/api/lookup`, `/api/suggest`), `src/ui/basket.html`.
**Tests:** 3 dates picked across 4 days of data; the lowest of the day is used; a gap gives null; ordering is oldest to newest.

---

## Task 5: MCP so an AI chat can query directly (no browser)

**Today:** `src/mcp-server.js` exists, with 4 tools: `compare_basket`, `search_product`, `open_basket_view`, `open_platform`. Gaps:
- It runs its **own** engine and Chrome, and uses `~/.basket` for data. That is **not** the Docker service's history (`~/basket-data`), so a chat would see different, emptier history.
- Every question triggers a **live** search, with no saved-price answers and no rate limits shared with the service.
- There are no tools for history, lookups, sign-in status or schedules.

**Design:** make the MCP server a **thin client of the running service's HTTP API**. One history, one browser, one request budget, and it starts instantly.

| Tool | Does | Uses |
|---|---|---|
| `lookup_price(item)` | "what did I pay for onion?": rate per 100 g by site, last 3 dates, lowest ever | `/api/lookup` |
| `suggest_items(text)` | what saved items match | `/api/suggest` |
| `compare_basket(items, fresh=false)` | cheapest site and best mix. Saved prices by default; `fresh=true` runs live and waits for the job, streaming progress; returns "wait Ns" if rate-limited | `/api/compare` (cached or job), `/api/events`, `/api/result` |
| `price_history(item, site?)` | the trend, for charts and "is today a good price?" | `/api/history` (extended) |
| `site_status()` | which sites work, are resting or need sign-in | `/api/limits`, `/api/login` |
| `run_schedule_now(sites?)` | trigger the list now | `/api/compare` |
| `open_basket_view()` | the URL, for when a table is easier | — |

- **Output:** each tool returns a short markdown answer, such as "Cheapest onion today: Flipkart ₹6.38/100g (▼ from ₹6.9 on 18 Nov)", plus the JSON for the model.
- **No sign-in tool.** Logins stay in the web popup, so OTPs don't go through a chat.
- **Configuration:** `BASKET_URL` (default `http://127.0.0.1:7777`). If the service isn't running, the server says so plainly. It does not start a second engine.
- **Registration:** documented for Kiro (`.kiro/settings/mcp.json`) and Claude (`claude mcp add`). Example:

  ```json
  { "mcpServers": { "basket": { "command": "node", "args": ["/home/a/Downloads/git/compareprice/src/mcp-server.js"], "env": { "BASKET_URL": "http://127.0.0.1:7777" } } }
  ```
- **Security:** the API has no auth and stays on localhost. The MCP server only talks to `127.0.0.1`.

**How much work:** small to medium, about one focused session.
- The HTTP endpoints exist; only `history` needs the 3-dates extension from Task 4.
- The MCP SDK is already a dependency, and the protocol smoke test (`scripts/mcp-smoke.js`) exists.
- New: an HTTP client, 7 tool handlers, markdown formatting, and tests against a fake server (about 10 tests). Plus one live check from Kiro: "what's the cheapest onion?" answered from saved prices.

**Decision (2026-11-19): saved prices by default, with live search as an option.** `compare_basket` and `lookup_price` answer from saved prices. With `fresh: true`, or when the user asks for "latest" or "live", they run a live search under the same per-site limits. If a site needs a pause they return "Zepto needs a 3 s pause", and the AI can retry.

---

## Task 6: Performance (from measurements, see `docs/diagnosis/2026-11-19-resource-use-and-otp-step.md`)

**Finding:**
- The Node code is light: 67 MB and about 0% CPU.
- The warm Chrome left open between runs uses **about 1 GB and 50–75% of a core while idle**. JioMart's home page alone uses about 361 ms/s of main-thread time.
- Runs happen three times a day, about a minute each.

**Design:**
1. **Idle shutdown:** `BrowserPool.closeWhenIdle(ms)`. When the job queue has been empty for `browser.idleCloseMs` (default 5 min, set in config), close Chrome. The next job relaunches it, and the needed tabs warm up in parallel as they do today. Profile, cookies, location and sign-ins stay on disk.
2. **Park tabs after each job:** a tab whose site wasn't in the job, or a login tab after sign-in finishes, goes to `about:blank` or is closed. That stops the Milkbasket login tab staying open.
3. **Lighter pages while warm:** block images, media and fonts via CDP (`Network.setBlockedURLs` / request interception), only on tabs used for API calls. The DOM-scrape fallback still works without images.
4. **Disk:**
   - Cap the Chrome cache (`--disk-cache-size=50000000`).
   - Keep `results/*.json` for 60 days (`results.keepDays` in config); `runs.jsonl` stays.
   - Run the store's startup clean-ups (matcher and outlier prune) once per schema version instead of on every start.
5. **Image (optional):** drop `fonts-noto-color-emoji` (about 10 MB). Not worth more than that.

**Expected:** near 0% CPU and about 70 MB idle. Each run gains about 10–25 s of warm-up. **Trade-off:** the first manual "Get fresh prices" after idle takes about 20 s longer.

**Tests:** the pool closes after the idle time with a fake clock, a job during the countdown cancels the close, a job after a close relaunches Chrome, results older than `keepDays` are deleted while newer ones stay, and the prune runs once per version.
**Evidence:** `docker stats` idle before and after, recorded in the diagnosis doc.

## Task 7: Code review pass

There's no need for a broad refactor, but a focused review of the riskier areas is worthwhile before merging. After the code is written, run the repo's **code-review skill** (standards and spec, in parallel) on the branch, with focus on:
- `src/score.js` / `src/pricecheck.js`: `pickBest` is called repeatedly per item and site (cheap at current sizes); check correctness of the new `bigger-pack` / `suspect` paths.
- `src/engine/login.js`: selectors, masking, and that no number or OTP is written to disk or logs.
- `src/server.js`: route count is growing; it's fine as one file for now, but split into `routes/` if it passes about 500 lines.
- `src/cli.js` (860 lines): leave as is unless touched.

Fix what the review finds before merging.

## Branch, commits, docs

- **Branch:** `feature/signin-theme-trends-mcp` off `main`.
- **Commits** (one logical change each, Conventional Commits):
  - `fix(engine): detect OTP screen and type OTP into split boxes`
  - `feat(ui): OTP step with verify, resend and live status`
  - `feat(ui): light, dark and auto theme`
  - `feat(store): last-3-dates rates and change vs previous price`
  - `feat(ui): price change arrows and trend lookup`
  - `feat(mcp): MCP server as a client of the running service`
  - `perf(engine): close idle browser and park unused tabs`
  - `chore(store): results retention and one-time prune`
  - `docs: …` updates in the same commits as the code
- **Docs updated in the same commits:**
  - `README.md`: theme, sign-in steps, lookup trend, MCP setup for Kiro and Claude
  - `docs/API.md`: async login state; lookup `dates`/`rates`; history fields `prev`, `change`, `changePct`
  - `docs/ENGINE.md`: login detection, idle shutdown, blocked resource types
  - `docs/OPERATIONS.md`: idle behaviour, `browser.idleCloseMs`, `results.keepDays`, MCP troubleshooting
  - `docs/evidence/<date>-ui/`: light and dark at 1280 and 390, the OTP dialog states, the lookup trend
  - `CHANGELOG.md`
- **PR:** into `main` with what was tested, plus what wasn't verified live (the Amazon OTP and the session lifetime).

## Order and effort (all code in one pass after sign-off)

| # | Task | Depends on | Size |
|---|---|---|---|
| 0 | Light-mode mockup → your OK | ✅ done | — |
| 4 | Last-3-dates store and API | none | small |
| 3 | ▲▼ in `annotate` and cells | Task 4's store helpers | small |
| 2 | Theme variables and toggle | mockup OK | small–medium |
| 1 | OTP step 2, async login, logging | none | medium |
| 5 | MCP as a client of the service | Task 4's API | medium |
| 6 | Idle browser shutdown, tab parking, retention | none | small–medium |
| 7 | Code review on the branch and fixes | all above | small |
| — | Docs (README, API, ENGINE, OPERATIONS), evidence screenshots, full test run, redeploy | all | small |

One live check needs you: the Zepto OTP (Task 1).

## Decisions log (2026-11-19)
1. Amazon: check the login approach → done above; kept in the list.
2. ▲▼: against the latest available data (previous saved price, any day).
3. Last 3 dates: dates that have data.
4. MCP: saved by default, plus an option for a live search.
5. Light-mode mockup: shown.

6. Req 4 layout: **option B**, one line per vendor.
7. Light palette: **approved**.

Nothing open. **Coding starts only after your approval of this plan.**

## Earlier open questions (answered above)
1. **Task 1:** keep Amazon in the sign-in list (greyed, not serviceable), or hide it?
2. **Task 3:** ▲▼ against the previous **day** (proposed) or the previous **run**?
3. **Task 4:** last 3 **dates with data** (proposed) or 3 calendar days? And the lowest of the day (proposed) or the last of the day?
4. **Task 5:** allow fresh (live) runs from the chat (proposed, rate-limited), or saved prices only?
5. **Task 2:** OK to show the light-mode mockup first? I'll make it right after your answers.
