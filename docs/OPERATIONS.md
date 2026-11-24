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
| `profiles/<site>-<id>/` | One Chrome profile per extra account (Instamart, Milkbasket). Removing the account in the popup deletes it. Launched only while that account is in use. |
| `accounts.json` | Accounts per site: name, masked hint, signed-in time, profile. Replaces `sessions.json`, which is read once and left untouched. |
| `basket.db` › `prices.hidden` | Rows set aside instead of deleted (since 2026-11-20): `rejected` (✕), `no-match` / `outlier` (clean-ups), `removed` (an entered price taken out). `SELECT hidden, COUNT(*) FROM prices GROUP BY 1` shows them. |
| `master/` | The master price list run (`scripts/master-list.js`, run on the host): `state.json` (progress, so it can resume), `run.log`, `run.lock`, `master-<date>.csv` / `.md` (the reports). |
| `cache/milkbasket-catalog-<hub>.json` | Milkbasket's catalogue (product names, prices, packs only), refreshed after 20 h. Safe to delete; the next search rebuilds it in ~4 min. |

## The default list

- **Where it lives:** `<data>/basket.txt` (on this host `/home/a/basket-data/basket.txt`). It is used by scheduled runs and pre-fills the list on the main page.
- **How to change it:** edit the file directly, or use Settings → Default list. Both write the same file, and it is re-read on every load, so no restart or rebuild is needed.
- **The repo copy:** `basket.txt` in the repository is only the starting list for a new data folder.
- **Before 2026-11-20:** the list was saved inside `config.json` on the first Save, so editing `basket.txt` did nothing. The first start of the new version moves it out and keeps that copy as `<data>/basket.previous.txt`.

## Schedules

The config holds `schedules: [{ name, sites, times: ['HH:MM', …], enabled }]` in `timezone` (default `Asia/Kolkata`). Edit it at `/settings` or with `PUT /api/config`.

How firing works:
- The scheduler ticks every 30 s.
- Each `name|date|time` fires once. The key is stored in `basket.db`, so a restart never double-fires.
- If the machine was asleep at the scheduled time, the time fires once on the first tick after waking.

Scheduled jobs use `config.basket` and the schedule's sites. They share the queue with manual runs, which wait their turn.

**Configured on 2026-11-18:** `daily-check` at 07:00, 09:00 and 12:00 on instamart, bigbasket, zepto, blinkit and kpn. **Changed on 2026-11-19:** 07:00, 10:00 and 12:00, now also on jiomart and flipkart_minutes.

## Resource use and retention

| Config key | Default | What it does |
|---|---|---|
| `browser.idleCloseMs` | `300000` (5 min) | Close Chrome after this long with nothing to do (no running or queued job, no sign-in in progress). `0` keeps it always on. The log says `browser closed after N min idle; it reopens with the next job`. |
| `browser.blockMedia` | `true` | Search tabs skip images, fonts and video. |
| `results.keepDays` | `60` | `results/*.json` older than this are deleted at startup. `runs.jsonl` and `basket.db` are kept. |

Measured on 2026-11-19 (docs/diagnosis/2026-11-19-resource-use-and-otp-step.md): with Chrome warm and idle the container used ~1 GB and 50–75% of a core. After the idle close the service is Node alone. The first search after a close takes longer, because Chrome starts and the site pages load again; sessions and chosen addresses stay in `chrome-profile/`.

One-time store clean-ups (spelling folds, refused rows) run once per `CLEANUP_VERSION` (recorded in `basket.db`'s `meta` table), not on every start.

## History-first searches

**Find the cheapest** on the page, `POST /api/compare {mode:'cached'}` and `basket … --cached` read only `basket.db`. They show the latest saved price per item and site, with its date, and never contact a site or queue a job. Only **Get fresh prices** and the schedules hit the sites, so keeping the schedules running is what keeps the saved prices fresh.

On startup the store:
- folds item spellings into one key (`toor dal 1 kg` = `toor dal 1kg`)
- deletes saved rows the current matcher refuses (e.g. Moong Dal saved under "toor dal" by the older matcher), and logs `store: removed N saved price(s)…`

## Product catalogue and synonyms

`src/catalog-data.js` lists about 230 products as synonym sets: a canonical tag, regional and transliterated names, misspellings, narrower names, brand facets and a category (`staples`, `pulses`, `spices`, `masala`, `oil`, `dairy`, `sweetener`, `dry-fruits`, `snacks`, `beverages`, `household`, `personal-care`…). Any basket line that names one of them is searched, matched and saved under the canonical tag. For example, "kismis", "kishmish", "khismis" and "dry grapes" are all `raisins`, and "gud", "vellam" and "jagrey" are all `jaggery`. Two such lines in one basket merge into one row, and the page shows what was typed under it. A listing called "Kishmish" or "Dry Grapes" counts as a match for raisins.

- A line is rewritten only when it is the product plus brands, pack sizes and plain modifiers. "britannia good day cashew" stays as typed. Brands are never rewritten ("harpic" stays brand-specific). The brand is reported as `product.brand`.
- On start the store re-keys saved prices, so rows saved under a synonym join the canonical product's history (`store: regrouped N saved price(s)…`).
- `jhola catalog "<item>"` shows what a line resolves to. `jhola catalog --category=spices` lists one category. `GET /api/catalog` returns the same information.

## The public landing page

The guide (`src/ui/guide.html`) is a static page, so it can be published for free on GitHub Pages as the project's landing page: https://harivig12.github.io/jhola/. The app itself cannot be hosted there, because it needs a headless Chrome and a scheduler running on a machine of yours.

- `npm run build:site` writes the static copy to `site/` (git-ignored): the page marked `<html class="static">` so links to app pages hide and GitHub links show, the shared `theme.css`, the icons, and a manifest that starts at the page itself.
- `.github/workflows/pages.yml` builds and publishes it when `main` changes the pages.
- One-time setup in the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**. Then set the repository's **About → Website** to the address above.

## Using it from a phone

The user guide at `/guide` covers this step by step. In short:

- **Natively:** run `jhola serve --host=0.0.0.0`.
- **With Docker:** change the compose port line to `"7777:7777"`.
- **Then:** open `http://<computer-ip>:7777` on a phone that is on the same Wi-Fi.

The page has no login, so only do this on a trusted home network.

## Catalogue sweep

The service also fills in prices for catalogue products that no basket asked for. Each sweep picks a random 2–4 products, queues them as one job (trigger `sweep`), then waits a random 5–20 minutes before the next one (for example 3 products at 00:00, 2 at 00:09, 4 at 00:23). Products with no saved price on some site come first. When none are missing, prices older than `staleHours` are refreshed. A product is swept at most once a day. A sweep never starts while another job is running or queued. It looks again a minute or two later.

Settings are in `config.json → sweep`: `{ enabled, sites: [] (= config sites), minItems, maxItems, minGapMinutes, maxGapMinutes, staleHours }`. Status is at `GET /api/sweep`, and `jhola sweep-now` (or `POST /api/sweep/run`) queues a batch at once. Turn it off with `"sweep": { "enabled": false }`.
## Categories, saved-line reuse and AI labels (2026-11-20)

- **"Find the cheapest" fallback.** A line with no saved price of its own is answered from a more specific saved line on the same site, and the cell says "saved for “…”". The saved line must:
  - contain every word of the line, and add no kind word (black or rock salt is not salt);
  - have the same pack when the line names one;
  - have a product the matcher still accepts.

  A more specific new line ("cow ghee 1l") never borrows from "ghee". It needs Get fresh prices.
- **Matcher re-checks.** Matcher-only changes bump `MATCH_VERSION` (now 3). On the next start, saved rows the matcher now refuses are marked `hidden = 'no-match'`, never deleted. So are rows whose own site category says sweets or pooja for a generic line.
- **AI labels (optional, off by default).** These run as a queue job `ai-labels` after the offer check that follows a schedule, or from Settings → "Label now". The job:
  - sends only product titles to the chosen OpenAI-compatible API (Groq, OpenRouter, or a local server);
  - sends one batch per call;
  - saves results to `product_groups`.
- **AI settings files:**
  - `<data>/ai.md` holds the tunables: `batch size` (default 100), `pause seconds` (65), `max calls per day` (50), plus provider/model. Edit it to change them; it is re-read on every run.
  - `<data>/secrets.json` (mode 600) holds the key. Set it on the Settings page. Don't copy it anywhere.
- **AI accuracy check:** `docker exec jhola node scripts/ai-groups-eval.js` scores the configured model on `test/fixtures/ai/labels.txt` (103 hand-labelled titles). The image leaves out `test/`, so run it from a checkout with `BASKET_HOME=/home/a/basket-data`.

## Waiting, pacing and sign-ins

- **"Wait 3s…" on the page:** a chosen site was searched moments ago, or is resting after the site blocked us. The page retries by itself. Budgets are in `src/limits.js` and can be overridden in `config.json → limits`. Current usage is at `/api/limits`.
- **Sign-ins:** use the page's *Sign in…* (Milkbasket, Zepto, Amazon). Enter the number and press **Send OTP**; when the site shows its OTP screen, an OTP box appears and the button becomes **Verify**. *Resend OTP* unlocks after 30 s; 3 requests per site per hour is the cap. The session lives in `chrome-profile/`, and `sessions.json` notes when. Deleting `chrome-profile/` signs everything out. The log shows `login <site>: …` lines with only the last 4 digits of the number.
- **Zepto at Krishna Nagar asks for sign-in** before it shows search results. Until it is signed in, Zepto reports `session … asks you to sign in`.

## Checking that it works

```bash
curl -s localhost:7777/health                      # {"ok":true,...}
docker logs --tail 50 jhola                        # per-job / per-site log lines
node scripts/verify-runs.js ~/basket-data          # today's 07:00 / 09:00 / 12:00 runs
node scripts/verify-runs.js ~/basket-data --date=2026-11-19 --expect=07:00,09:00,12:00
tail -n 3 ~/basket-data/results/runs.jsonl
node src/cli.js history "toor dal 1kg"             # native data dir; for Docker:
docker exec jhola node src/cli.js history "toor dal 1kg"
```

`verify-runs.js` exits with code 1 if an expected time already passed with no scheduled run finishing within 30 minutes of it. That makes it usable from cron or a monitor.

## Troubleshooting

| Symptom (UI chip / log / runs.jsonl) | Cause and fix |
|---|---|
| `blocked … bot protection page "Access Denied" (ref …)` | BigBasket's Akamai has flagged the IP, usually after many fresh-profile visits. It clears within hours. The circuit breaker stops after one retry so the block isn't prolonged. |
| `blocked … rate limited (statusCode 429 in body)` | Instamart throttling. Searches are paced 2.5 s apart. Bursts of manual runs trigger it. Wait a few minutes. |
| `blocked … network error (Failed to fetch) — the API refused the request without CORS headers` | Zepto's gateway returned an error without CORS headers, usually a WAF or rate limit. Seen right after heavy recon. It clears on its own. |
| `unserviceable … could not set location` | The address picker changed, or `location.searchText` doesn't match any suggestion. Fix `searchText` in settings, or look at the site's picker (`setLocation` in its module). |
| `browser … could not start Chrome: Chrome exited early` | Chrome is missing, or its sandbox isn't available. In Docker, `JHOLA_CHROME_NO_SANDBOX=1` must be set (the image does this). Natively, set `CHROME_PATH`. |
| `session … page never issued a search request` | The site's search page didn't fire its API, possibly after a site redesign. Check the request URL regex in the site module. |
| `parse … product cards but no prices parsed` | The payload shape changed. Capture a new fixture and update `parse`. |
| JioMart / Flipkart Minutes `results never rendered` | Expected. These are beta page scrapes with no working guest location (see docs/ENGINE.md). Leave them out of schedules. |
| A run sits in `queued` | Another job is running. Check `/api/jobs`. A stuck job can be stopped with `POST /api/stop`. |
| `milkbasket: sign in (main account) to search … (no session token / no hub / guest city)` | The session expired or the sign-in never happened. Sign in again from the popup. "guest city" means the account has no society saved. |
| The first Milkbasket search takes ~4 minutes | Expected once a day: it reads the whole catalogue (~300 paced calls). Later searches use `cache/`. |
| `<site>: direct API call refused (HTTP 403); using the browser tab instead` in the log | The site stopped accepting direct calls; that tab now uses the page as before. No action needed. If it happens every day, set the site's `direct` to false. |
| Deals section says `<site> · <name>: …` | That account's offer check failed (often an expired session). Sign that account in again; the other accounts still count. |
| `409 busy, try again after the current run` on Sign out / Remove | A run or offer check is using that browser. Wait for it to finish. |
| Sign-in popup stays on "Asking … to send an OTP" | The background step is still loading the site's page (up to ~30 s on a cold Chrome). If it ends in `error`, the message says which step failed. A site may have changed its sign-in page; see `LOGIN_SITES` in `src/engine/login.js`. |
| First fresh search of the day is slow | Expected after the idle close: Chrome relaunches and reloads the sites. Raise `browser.idleCloseMs` or set it to `0` if that matters more than the memory. |
| MCP tool says "The basket service isn't reachable at …" | The container is stopped (`docker start jhola`) or `JHOLA_URL` in the MCP config points elsewhere. `curl -s localhost:7777/health` should answer. |
| Amazon sign-in: `amazon: Amazon is showing a puzzle (CAPTCHA)…` | Amazon wants a human check this time. Sign in once at amazon.in in a normal browser on this network, wait a while, then try the popup again. Repeated attempts make it more likely. |
| Amazon sign-in: `3 wrong passwords. Stopped…` | The popup stops after 3 wrong passwords in one sign-in so Amazon doesn't lock the account. Check the password, then start again. |
| Zepto `session … page never issued a search request` right after signing in | Fixed 2026-11-19: signed-in Zepto searches with `POST …/user-search-service/api/v3/search`, and the engine now copies that request as well as the guest `GET …/v1/search`. |
| MCP `compare_basket fresh=true` says a site needs a pause | The same per-site budget as the page. The tool shows the saved prices meanwhile; ask again after the wait. |

## Deploying a change

Run this from the repository folder:

```bash
BASKET_DATA=/home/a/basket-data scripts/deploy.sh      # SKIP_TESTS=1 to skip npm test
```

The script:
- runs the tests, and waits for a running job;
- keeps the current image as `jhola:previous` (on the first 1.3 deploy, the old `compareprice:latest`, and it removes the old `basket` container), then builds and restarts on port 7777;
- **rolls back on its own** if `/health` doesn't answer within 60 s;
- removes only this project's untagged leftover builds (label `org.opencontainers.image.title=jhola`).

The data folder and volumes are never touched. Use this script instead of a hand-typed `docker build && docker run`, because each hand deploy used to leave ~1.1 GB behind (docs/diagnosis/2026-11-20-docker-disk-cleanup.md).

## Upgrading

```bash
docker build -t jhola:latest . && docker rm -f jhola && \
docker run -d --name jhola --restart unless-stopped -p 127.0.0.1:7777:7777 \
  -v ~/basket-data:/data -e TZ=Asia/Kolkata --shm-size=1g jhola:latest
```

The data dir survives upgrades.

### Upgrading from before the rename (1.1 → 1.2)

The project is now called Jhola. The container is now `jhola` instead of `basket`, and the image is `jhola:latest` instead of `compareprice:latest`. Remove the old container once, or the new one can't take port 7777:

```bash
docker rm -f basket
docker compose up -d --build
```

Nothing else moves. `~/basket-data` (Docker) and `~/.basket` (native) keep being used, so saved prices, sessions and settings carry over. The old `basket` command and every `BASKET_*` setting still work next to the new `jhola` command and `JHOLA_*` settings.
