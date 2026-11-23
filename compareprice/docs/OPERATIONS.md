# Operating the basket service

## What runs where

| | Native | Docker (this machine) |
|---|---|---|
| Start | `node src/cli.js serve` | `docker compose up -d --build`, or the `docker run` line in the README |
| Data dir | `~/.basket` (`BASKET_HOME` overrides) | `~/basket-data` on the host, mounted as `/data` |
| URL | http://localhost:7777 | http://localhost:7777 (published on 127.0.0.1 only) |
| Restarts | no | `restart: unless-stopped`; Docker is enabled at boot |

**Data dir contents:**

| Path | Contents |
|---|---|
| `config.json` | Location, sites, list, schedules |
| `basket.db` | SQLite: price history, jobs, scheduler fire-keys |
| `results/<ISO>-job<id>-<trigger>.json` | Each finished job: `{ job, result }`, with the history annotations |
| `results/runs.jsonl` | One summary line per job, with per-site outcome, error kind and new lows |
| `last-result.json` | The latest result (the page loads it on open) |
| `chrome-profile/` | Headless Chrome profile: guest sessions and the chosen delivery location. Deleting it means the sites are re-located on the next run. |

## Schedules

The config holds `schedules: [{ name, sites, times: ['HH:MM', …], enabled }]` in `timezone` (default `Asia/Kolkata`). Edit it at `/settings` or with `PUT /api/config`.

How firing works:
- The scheduler ticks every 30 s.
- Each `name|date|time` fires once. The key is stored in `basket.db`, so a restart never double-fires.
- If the machine was asleep at the scheduled time, the time fires once on the first tick after waking.

Scheduled jobs use `config.basket` and the schedule's sites. They share the queue with manual runs, which wait their turn.

**Configured on 2026-11-18:** `daily-check` at 07:00, 09:00 and 12:00 on instamart, bigbasket, zepto, blinkit and kpn.

## History-first searches

**Find the cheapest** on the page, `POST /api/compare {mode:'cached'}` and `basket … --cached` read only `basket.db`. They show the latest saved price per item and site, with its date, and never contact a site or queue a job. Only **Get fresh prices** and the schedules hit the sites, so keeping the schedules running is what keeps the saved prices fresh.

On startup the store:
- folds item spellings into one key (`toor dal 1 kg` = `toor dal 1kg`)
- deletes saved rows the current matcher refuses (e.g. Moong Dal saved under "toor dal" by the older matcher), and logs `store: removed N saved price(s)…`

## Product catalogue and synonyms

`src/catalog-data.js` lists about 230 products as synonym sets: a canonical tag, regional and transliterated names, misspellings, narrower names, brand facets and a category (`staples`, `pulses`, `spices`, `masala`, `oil`, `dairy`, `sweetener`, `dry-fruits`, `snacks`, `beverages`, `household`, `personal-care`…). Any basket line that names one of them is searched, matched and saved under the canonical tag. For example, "kismis", "kishmish", "khismis" and "dry grapes" are all `raisins`, and "gud", "vellam" and "jagrey" are all `jaggery`. Two such lines in one basket merge into one row, and the page shows what was typed under it. A listing called "Kishmish" or "Dry Grapes" counts as a match for raisins.

- A line is rewritten only when it is the product plus brands, pack sizes and plain modifiers. "britannia good day cashew" stays as typed. Brands are never rewritten ("harpic" stays brand-specific). The brand is reported as `product.brand`.
- On start the store re-keys saved prices, so rows saved under a synonym join the canonical product's history (`store: regrouped N saved price(s)…`).
- `basket catalog "<item>"` shows what a line resolves to. `basket catalog --category=spices` lists one category. `GET /api/catalog` returns the same information.

## Using it from a phone

The user guide at `/guide` covers this step by step. In short:

- **Natively:** run `basket serve --host=0.0.0.0`.
- **With Docker:** change the compose port line to `"7777:7777"`.
- **Then:** open `http://<computer-ip>:7777` on a phone that is on the same Wi-Fi.

The page has no login, so only do this on a trusted home network.

## Catalogue sweep

The service also fills in prices for catalogue products that no basket asked for. Each sweep picks a random 2–4 products, queues them as one job (trigger `sweep`), then waits a random 5–20 minutes before the next one (for example 3 products at 00:00, 2 at 00:09, 4 at 00:23). Products with no saved price on some site come first. When none are missing, prices older than `staleHours` are refreshed. A product is swept at most once a day. A sweep never starts while another job is running or queued. It looks again a minute or two later.

Settings are in `config.json → sweep`: `{ enabled, sites: [] (= config sites), minItems, maxItems, minGapMinutes, maxGapMinutes, staleHours }`. Status is at `GET /api/sweep`, and `basket sweep-now` (or `POST /api/sweep/run`) queues a batch at once. Turn it off with `"sweep": { "enabled": false }`.

## Waiting, pacing and sign-ins

- **"Wait 3s…" on the page:** a chosen site was searched moments ago, or is resting after the site blocked us. The page retries by itself. Budgets are in `src/limits.js` and can be overridden in `config.json → limits`. Current usage is at `/api/limits`.
- **Sign-ins:** use the page's *Sign in…* (Milkbasket, Zepto, Amazon). The session lives in `chrome-profile/`, and `sessions.json` notes when. Deleting `chrome-profile/` signs everything out.

## Checking that it works

```bash
curl -s localhost:7777/health                      # {"ok":true,...}
docker logs --tail 50 basket                       # per-job / per-site log lines
node scripts/verify-runs.js ~/basket-data          # today's 07:00 / 09:00 / 12:00 runs
node scripts/verify-runs.js ~/basket-data --date=2026-11-19 --expect=07:00,09:00,12:00
tail -n 3 ~/basket-data/results/runs.jsonl
node src/cli.js history "toor dal 1kg"             # native data dir; for Docker:
docker exec basket node src/cli.js history "toor dal 1kg"
```

`verify-runs.js` exits with code 1 if an expected time already passed with no scheduled run finishing within 30 minutes of it. That makes it usable from cron or a monitor.

## Troubleshooting

| Symptom (UI chip / log / runs.jsonl) | Cause and fix |
|---|---|
| `blocked … bot protection page "Access Denied" (ref …)` | BigBasket's Akamai has flagged the IP, usually after many fresh-profile visits. It clears within hours. The circuit breaker stops after one retry so the block isn't prolonged. |
| `blocked … rate limited (statusCode 429 in body)` | Instamart throttling. Searches are paced 2.5 s apart. Bursts of manual runs trigger it. Wait a few minutes. |
| `blocked … network error (Failed to fetch) — the API refused the request without CORS headers` | Zepto's gateway returned an error without CORS headers, usually a WAF or rate limit. Seen right after heavy recon. It clears on its own. |
| `unserviceable … could not set location` | The address picker changed, or `location.searchText` doesn't match any suggestion. Fix `searchText` in settings, or look at the site's picker (`setLocation` in its module). |
| `browser … could not start Chrome: Chrome exited early` | Chrome is missing, or its sandbox isn't available. In Docker, `BASKET_CHROME_NO_SANDBOX=1` must be set (the image does this). Natively, set `CHROME_PATH`. |
| `session … page never issued a search request` | The site's search page didn't fire its API, possibly after a site redesign. Check the request URL regex in the site module. |
| `parse … product cards but no prices parsed` | The payload shape changed. Capture a new fixture and update `parse`. |
| JioMart / Flipkart Minutes `results never rendered` | Expected. These are beta page scrapes with no working guest location (see docs/ENGINE.md). Leave them out of schedules. |
| A run sits in `queued` | Another job is running. Check `/api/jobs`. A stuck job can be stopped with `POST /api/stop`. |

## Upgrading

```bash
docker build -t compareprice:latest . && docker rm -f basket && \
docker run -d --name basket --restart unless-stopped -p 127.0.0.1:7777:7777 \
  -v ~/basket-data:/data -e TZ=Asia/Kolkata --shm-size=1g compareprice:latest
```

The data dir survives upgrades.
