# HTTP API

Served by `src/server.js` (started by `basket serve` / the Docker image). The base URL is `http://localhost:7777`. There is no authentication, so keep it on localhost.

## Routes

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/` | | compare page (`src/ui/basket.html`) |
| GET | `/settings` | | settings page (`src/ui/settings.html`) |
| GET | `/health` | | `{ ok, service: 'basket', busy, queued }` |
| GET | `/api/meta` | | `{ platforms, labels, modes, skipped, defaultPlatforms, defaultPincode, location, basket, confidenceThreshold, busy }`. `modes[id]` is `'api'` or `'dom'`. `skipped[id]` is the reason a site is never contacted (currently `milkbasket`). |
| POST | `/api/compare` | `{ items: "one per line", platforms?: string[], mode?: 'fresh'\|'cached' }` | **429** (fresh only) when a chosen site needs a pause: `{ error, site, label, waitMs, waits: [{ site, label, waitMs, reason }] }` with a `retry-after` header. The page counts this down and retries. |
| ″ | ″ | ″ | **`mode: 'cached'`** (history-first): `200` straight away with a result built from saved prices. No job is queued and no site is contacted. **Default `fresh`**: `202 { jobId, queued }`, where `queued` is the number of jobs ahead. Returns 400 on empty items, unknown platforms or bad JSON. |
| GET | `/api/events` | | Server-Sent Events, see below |
| GET | `/api/result` | `?jobId=` (optional) | The `compareBasket()` result for that job, or the latest one. 204 if there isn't one. |
| GET | `/api/jobs` | `?limit=20` | `{ current, pending: Job[], jobs: Job[] }` |
| GET | `/api/history` | `?q=<item>` | `{ query, sites: { [site]: { lowUnitPrice, unit, lowPrice, product, pack, seenAt, lastUnitPrice, lastSeenAt } } }` |
| GET | `/api/suggest` | `?q=&limit=8` | Saved items whose text contains `q`, prefix matches first: `[{ query, sites, seenAt }]` |
| GET | `/api/lookup` | `?q=<item>` | What each site last charged: `{ query, per: '100 g'\|'100 ml'\|'piece', sites: [{ site, rate, lastPrice, pack, product, seenAt, lowRate, lowSeenAt, url }], options }`, cheapest rate first. `q` may be partial ("onion"). 404 if nothing is saved. |
| GET | `/guide` | | The how-to guide (HTML). `/` is the compare page and `/settings` the settings page. All three load `/theme.css`. |
| GET | `/api/catalog` | `?q=<item>` and/or `?category=` | With `q`: `{ query, canonical, product: { id, name, canonical, category, matchedBy, phrase, brand } \| null, suggestions }` ("kismis 500g" → `canonical: "raisins 500g"`). Without: `{ categories, count, products: [{ id, name, category, canonical, tags, sub, brands }] }`. |
| GET | `/api/sweep` | | Catalogue sweep status: `{ enabled, settings, nextAt, runs, lastRun: { at, jobId, items, reasons } }`. 404 outside `basket serve`. |
| POST | `/api/sweep/run` | | Queue one sweep batch now (even if disabled): `202 { jobId, items }`, or `200 { jobId: null, reason }` when nothing is missing. |
| GET | `/api/limits` | | Per-site request budget: `{ [site]: { ok, waitMs, reason, lastMinute, lastHour, limits, cooldownMs, cooldownReason } }` |
| GET | `/api/login` | | Sign-in status per site: `[{ id, label, why, loggedIn, since, phoneHint, pending }]` |
| POST | `/api/login/start` | `{ site, phone }` | Opens the site's sign-in page, enters the number and asks for the OTP: `{ step: 'otp', message }`. Returns 429 after 3 OTP requests per site per hour. |
| POST | `/api/login/verify` | `{ site, otp }` | Enters the OTP: `{ loggedIn: true }`, or 400 `{ error, kind }` (e.g. "the site rejected that OTP") |
| GET | `/api/config` | | The full config (see README) |
| PUT | `/api/config` | partial or full config | `200` with the saved config, or `400 { field, error }`, e.g. `{ "field": "schedules[0].times", "error": "\"25:00\" is not a 24-hour HH:MM time" }` |
| POST | `/api/stop` | `{ jobId? }` (defaults to the running job) | `{ ok, stopped, jobId }` |

**Job fields:** `{ id, status: 'queued'|'running'|'done'|'failed'|'cancelled'|'interrupted', trigger: 'manual'|'schedule', sites, items, createdAt, startedAt, finishedAt, error, summary }`

**Queueing:**
- Jobs run one at a time, in order. Sites inside a job run in parallel.
- A request made while a job is running is queued. It is never refused.
- On restart, jobs that were `running` or `queued` become `interrupted`.

## SSE events (`GET /api/events`)

| event | data |
|---|---|
| `hello` | `{ current, pending }` on connect |
| `progress` | `{ jobId, event }`, where `event` is one of the progress events below |
| `done` | `{ jobId, ok, error? }` |
| `job` | the Job row after a change |

**Progress events** (`event` above). These same objects are what `compareBasket({ onProgress })` receives.

```js
{ type: 'site-start', site, total }
{ type: 'query',      site, query, index /* 1-based */, total }
{ type: 'retry',      site, query, kind, message }
{ type: 'fallback',   site, query }
{ type: 'wait',       site, waitMs, reason }      // pacing between searches
{ type: 'site-done',  site, ok, error? }
```

## Result shape (abridged)

```js
{
  pincode, address, locationLabel, backend: 'engine', generatedAt, elapsedMs,
  basket: [{ query, qty, raw }],
  labels: { [site]: label },
  platforms: [{
    platform, label, total, subtotal, fulfilledLines, totalLines, complete,
    failed?, error?, errorKind?,                 // a site that failed entirely
    failures?: [{ query, kind, message }],       // per-query failures
    lines: [{ query, qty, status: 'ok'|'low-confidence'|'no-results'|'no-match'|'out-of-stock'|'bigger-pack'|'suspect'|'not-cached', lineTotal,
              dropped?: [{ name, price, unit, reason }],   // removed by the price check
              product: { name, price, mrp, packLabel, packs, pricePerUnitLabel, confidence, url },
              history: { low, lowSeenAt, delta, tag: 'new-low'|'at-low'|'above-low' } | null }]
  }],
  unavailable: [{ platform, label, error, errorKind }],
  winner, runnerUp, saving, likeForLike, comparedOn, feesKnown
}
```

**History-first results** (`mode: 'cached'`) also carry:
- `source: 'history'` (live results have `source: 'live'`)
- `cachedRange: { oldest, newest } | null`
- `uncached: [{ platform, query }]`

Each line also gets `cachedAt` (when that price was saved), or `status: 'not-cached'` when no price is saved. A site with no saved prices at all gets `notCached: true`.

`history` is per base unit (₹/kg, ₹/L, ₹/pc) and is compared against what was stored before this run. It is `low: null` on the first sighting.

## Examples

```bash
curl -s -X POST localhost:7777/api/compare -H 'content-type: application/json' \
  -d '{"items":"2x toor dal 1kg\nsugar 1kg","platforms":["instamart","bigbasket"]}'
curl -sN localhost:7777/api/events            # watch progress
curl -s 'localhost:7777/api/history?q=toor%20dal%201kg'
```
