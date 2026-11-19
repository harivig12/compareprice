# Basket service plan: implementation status (2026-11-18)

Plan: `2026-11-16-basket-service.md`. **Status: 12 tasks done, 1 deferred.** Offline tests: 127 tests, 126 pass, 1 skipped (the LIVE test). The service is running in Docker with the schedule set.

| Task | Status | Where / notes |
|---|---|---|
| 1. Chrome launcher + CDP tab | ✅ | `src/engine/chrome.js`, `cdp.js`. Adds focus emulation and anti-throttling flags so parallel tabs keep working. Adds `--no-sandbox` via `BASKET_CHROME_NO_SANDBOX`. |
| 2. In-page fetch + error kinds | ✅ | `page-fetch.js`, `errors.js`. Adds `retryAfterMs`. "Failed to fetch" is classified as a CORS-less block. |
| 3. Instamart, BigBasket | ✅ | `src/engine/sites/`. BigBasket location via the UI picker (the direct PUT returns 403). ₹1 rows dropped. |
| 4. Wave 2 | ✅ partial | Zepto, Blinkit and KPN work through APIs. Amazon, JioMart, Flipkart Minutes and Milkbasket are beta DOM scrapes (`dom-sites.js`) with documented reasons. |
| 5. Pool + runner | ✅ | Plus a bot-wall check, a circuit breaker for blocked, unserviceable or broken DOM sites, and location changes without a restart. |
| 6. Wire into compareBasket and the surfaces | ✅ | `engine` backend is the default. Legacy webcmd/cdp only via `BASKET_BACKEND`. Failed sites stay in the table. CLI progress, specific caveats, a table that fits the terminal, and cheapest/second highlighting. The CLI closes Chrome on exit. |
| 7. Generic-vs-brand matching | ✅ | `normalize.js` |
| 8. Config + history | ✅ | `config.js` (plus `validateConfig`, `searchText`), `store.js` |
| 9. Queue + scheduler | ✅ | `jobs.js`, `scheduler.js` |
| 10. Server API | ✅ | `server.js`: 202 + queue, SSE, jobs, history and config. `service.js` writes `results/*.json` and `runs.jsonl`. `scripts/verify-runs.js` checks them. |
| 11. Web UI | ✅ | `src/ui/basket.html`, `settings.html`. Evidence in `docs/evidence/2026-11-18-ui/`. |
| 12. Optional OTP logins | ⏸ deferred | All sites work as guests. No OTP was sent to the phone number. Session-lifetime measurement is still open (see the diagnosis doc). |
| 13. Docker | ✅ | `Dockerfile` and `docker-compose.yml`. Data is in `~/basket-data`, bound to 127.0.0.1:7777. Built and run with plain `docker` because this host has no compose plugin. |

## 2026-11-18 additions
- **Multipack parsing:** `80g x4`, `80gx4`, `80g x 4 pcs`, `Pack of 4 (80 g each)` and `80 g (Pack of 4)` all read as 320 g. A mass reading beats "1 pack".
- **History-first search:** see `../specs/2026-11-18-history-first-design.md`.
- **Matching:** the identity word must be present (toor ≠ moong), with regional synonyms. Saved rows the matcher now refuses are pruned on startup.
- **Milkbasket:** skipped (app-only).
- **JioMart** and **Flipkart Minutes** moved from page scrapes to the engine: catalog API with location headers, and `__INITIAL_STATE__` with the guest address picker. Both are in the defaults and the schedule.
- **Stale headers:** captured headers expire after 20 minutes and are cleared on refresh. This fixes Zepto's `blocked … Failed to fetch` at the 09:00 run on 2026-11-19.
- **Scheduled runs verified:** 19 Nov 07:00 (job 7) and 09:00 (job 8) ran on all 7 sites. At 09:00 Zepto failed with stale headers (fixed after that run).

## Follow-ups
- **Instamart:** prefer the smallest pack that covers the requested size when per-unit prices are equal. Today the scorer can buy a 1 kg pack for a "500g" line if it's cheaper per kg (as designed, but surprising).
- **History:** add a per-item chart on the compare page (`/api/history` already serves the data).
