# HTTP API

Served by `src/server.js` (started by `jhola serve` / the Docker image). The base URL is `http://localhost:7777`. There is no authentication, so keep it on localhost.

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
| GET | `/ui/theme.css`, `/ui/theme.js` | | Shared light/dark theme for both pages. A fixed whitelist; nothing else under `src/ui` is served. |
| GET | `/api/history` | `?q=<item>` | `{ query, sites: { [site]: { lowUnitPrice, unit, lowPrice, product, pack, seenAt, lastUnitPrice, lastSeenAt } } }` |
| GET | `/api/suggest` | `?q=&limit=8` | Saved items whose text contains `q`, prefix matches first: `[{ query, sites, seenAt, best: { site, rate, per, date } \| null }]`. `best` is the cheapest site on the latest date with data. |
| GET | `/api/lookup` | `?q=<item>` | What each site last charged, cheapest rate first. `q` may be partial ("onion"). 404 if nothing is saved. See **Lookup** below. |
| GET | `/guide` | | The how-to guide (HTML). `/` is the compare page and `/settings` the settings page. All three load `/theme.css`. |
| GET | `/api/catalog` | `?q=<item>` and/or `?category=` | With `q`: `{ query, canonical, product: { id, name, canonical, category, matchedBy, phrase, brand } \| null, suggestions }` ("kismis 500g" → `canonical: "raisins 500g"`). Without: `{ categories, count, products: [{ id, name, category, canonical, tags, sub, brands }] }`. |
| GET | `/api/sweep` | | Catalogue sweep status: `{ enabled, settings, nextAt, runs, lastRun: { at, jobId, items, reasons } }`. 404 outside `jhola serve`. |
| POST | `/api/sweep/run` | | Queue one sweep batch now (even if disabled): `202 { jobId, items }`, or `200 { jobId: null, reason }` when nothing is missing. |
| GET | `/api/limits` | | Per-site request budget: `{ [site]: { ok, waitMs, reason, lastMinute, lastHour, limits, cooldownMs, cooldownReason } }` |
| GET | `/api/login` | | Sign-in status per site: `[{ id, label, why, loggedIn, since, phoneHint, method: 'otp'\|'password', acceptsEmail, secret: 'otp'\|'password'\|'approve', state, message, error, pending, resendInMs }]`. `phoneHint` is a masked number (`••••••0494`) or email (`a•••@gmail.com`). `secret` is what the second step asks for right now. See **Sign-in** below. |
| POST | `/api/login/start` | `{ site, id }` (`phone` is still accepted) | `id` is a 10-digit mobile, or an email where the site takes one (`acceptsEmail`, Amazon). **202** `{ state: 'sending', message }` at once; the site's page is driven in the background. 400 for an unknown site or a bad number/email. **429** `{ error, kind: 'blocked' }` inside the 30 s resend gap or after 3 starts per site per hour. |
| POST | `/api/login/verify` | `{ site, otp }`, `{ site, password }`, or `{ site }` | The second step, per `state`: the OTP (one box or split boxes), the password (`password_needed`), or a check after approving on the phone (`approve_needed`). `{ loggedIn: true }`, `{ step: 'otp'\|'approve', message }` when the site asks for one more step, or 400 `{ error, kind }`. The password is passed to the site's page only, never stored, logged or echoed. |
| GET | `/api/config` | | The full config (see README) |
| PUT | `/api/config` | partial or full config | `200` with the saved config, or `400 { field, error }`, e.g. `{ "field": "schedules[0].times", "error": "\"25:00\" is not a 24-hour HH:MM time" }` |
| POST | `/api/stop` | `{ jobId? }` (defaults to the running job) | `{ ok, stopped, jobId }` |

**Job fields:** `{ id, status: 'queued'|'running'|'done'|'failed'|'cancelled'|'interrupted', trigger: 'manual'|'schedule', sites, items, createdAt, startedAt, finishedAt, error, summary }`

**Queueing:**
- Jobs run one at a time, in order. Sites inside a job run in parallel.
- A request made while a job is running is queued. It is never refused.
- On restart, jobs that were `running` or `queued` become `interrupted`.

## Lookup (`GET /api/lookup`)

```js
{
  query, per: '100 g'|'100 ml'|'piece',
  dates: ['2026-11-17', '2026-11-18', '2026-11-19'],   // last 3 dates that have data (service time zone), oldest first
  sites: [{
    site, rate, lastPrice, pack, product, seenAt, lowRate, lowSeenAt, url,
    trend: [{ rate, price, product, pack, seenAt } | null, …],   // one per `dates`; the LOWEST rate that site had that date
    change: 'down'|'up'|'same'|null, changePct,                  // latest saved price vs the one saved before it
    prev: { unitPrice, price, seenAt, product, pack } | null
  }],
  options: [{ query, sites, seenAt, best }]                      // other saved items matching q
}
```

`change` compares with the latest earlier saved price, even one from the same day. Under 1% is `same`.

## Accounts, deals and offers

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/api/login/start` | `{ site, id, account? }` or `{ site, id, name }` | `account` (default `main`) signs in an existing account; `name` adds a new one on a multi-account site (Instamart, Milkbasket; max 3 per site). 202 `{ state, message, account }`. 400 `other_account` when that account is already signed in with another number, `same_account` when the number is another account's. |
| POST | `/api/login/verify` | `{ site, account?, otp \| password }` | As before, for that account. |
| POST | `/api/login/signout` | `{ site, account? }` | Main: clears only that site's cookies and storage in the shared profile. Extra: removes the account and deletes its profile directory. 200 `{ signedOut, removed, account }`, or **409** `{ error: '<site>: busy, try again after the current run' }`. |
| GET | `/api/login` | | Each site row also has `multiAccount`, `canAdd` and `accounts: [{ id, name, hint, loggedIn, since, state, message, error, pending, resendInMs, secret }]`. The top-level fields describe the main account. |
| GET | `/api/deals` | | `{ minDiscountPct, checkedAt: { [site]: iso }, groups: [{ site, checkedAt, conditions, deals: Deal[] }], fromSearches: Deal[], offerLists: [{ site, kind: 'payment'|'coupons', checkedAt, cart: 'probe'|'yours', item, offers: [{ code, title, note, state, type, minOrder, shortfall, description, extra, terms }] }], errors: [{ site, account, name, error, checkedAt }] }`. `Deal = { site, product, pack, price, mrp, pct, conditions: { maxQty?, minBasket? }, url, source: 'feed'\|'search', seenAt, seenBy: [{ account, name, hint, seenAt }] }`. Feed deals come from each account's latest offer check; search deals are shown for 24 h. |
| POST | `/api/compare` | `{ items, mode: 'missing', only: { site: [item line, …] } }` | "Get for missing only": queues a job that searches only those pairs (lines must be in `items`). 202 `{ jobId, queued, pairs }`; 400 when nothing is left. |
| POST | `/api/prices/reject` | `{ site, query, product }` | ✕ on a cell: marks that product's saved prices for the item on that site hidden (kept, not deleted) and never picks it for that item there again. 200 `{ ok, hidden }`. |
| GET | `/api/entries` | `?limit=50` | Entered "Others" prices, newest first: `[{ id, query, product, price, pack, seenAt, source }]`. |
| POST | `/api/entries` | `{ item, product?, price, pack?, date?, source? }` | Adds one (date defaults to today; the pack is read from `pack`, else the product name, else the item). 201 `{ id }`, or 400 `{ error }`. |
| DELETE | `/api/entries?id=` | | Takes it out of view (kept, marked hidden). `{ removed }`. |

Result lines can carry `alternative: { product, price, pack, pricePerUnit, unit, savingPct }`: a cheaper same-kind other brand on that site (hint only). An `others` platform (`others: true`, `total: null`) holds entered prices, with `source` and `entryId` per line.
| GET | `/api/siteinfo` | | What each site states about delivery, from the last offer check: `{ [site]: { freeDeliveryAbove, feeBelow?, feeName?, seenAt } }`. |
| POST | `/api/offers/run` | `{ sites? }` | Queues an offer check (`trigger: 'offers'`; it shares the job queue with basket runs). 202 `{ jobId, queued }`, or the job already queued (`already: true`). One also runs after every scheduled job. Its result never replaces the latest basket result; SSE `done` carries `kind: 'offers'`. |

Result lines from a site searched per account (Instamart) carry `product.account` and `accountPrices: [{ account, name, price }]`, cheapest first. A result's `deals: Deal[]` lists the 80%+ candidates seen in that run's searches (never totalled).

## AI labels (`/api/ai*`, optional)

- `GET /api/ai` → `{ settings, providers, hasKey, keyHint, file, counts: { labelled, waiting } }`.
  - `settings` comes from `<data>/ai.md`: `enabled, provider, baseUrl, model, batchSize, pauseSeconds, maxCallsPerDay`.
  - The key is never returned, only `keyHint` ("••••abcd").
- `PUT /api/ai` takes `{ enabled?, provider?, baseUrl?, model?, key?, clearKey? }` and answers like GET. On a bad value it answers 400 `{ error, field }`.
  - `provider` is one of `groq`, `openrouter` or `custom`.
  - The key goes to `<data>/secrets.json` (mode 600).
- `POST /api/ai/check` → `{ ok, modelListed, sample: { ok, got }, error }`. It calls `GET {base}/models`, then labels two known titles.
- `POST /api/ai/run` → 202 `{ jobId, queued }`, which queues an `ai-labels` job. It answers 400 when the labeller is off.
- `POST /api/ai/offer-rules/run` → 202 `{ jobId, queued }`, which queues an `offer-rules` job (reads new payment offers' terms into fixed rules; 400 without a key). `PUT /api/ai` also takes `readOffers` (bool).
- `GET /api/payments` / `PUT /api/payments { methods: string[] }` → `{ methods }`: "my payment methods", kept in the local store.
- `POST /api/advice { totals: { <site>: <goods total> } }` → `{ hasMethods, advice: { <site>: { best: { title, code, method, saving, after, conditions, minOrder } | null, checkedAt } }, unread }`. Pure arithmetic on saved rules; it changes no total.
- `GET /api/deals` payment offers carry `read` (rule saved) and `fits` (the method of mine that fits, or null).

Cached `POST /api/compare` lines can now carry `savedFrom`: the more specific saved line they were answered from ("salt" ← "tata salt 1kg"). Line products carry `category`.

## Sign-in (`/api/login*`)

The popup calls `start`, then polls `GET /api/login` about once a second:

| `state` | meaning | next |
|---|---|---|
| `idle` | never started (or restarted service) | `start` |
| `sending` | opening the site's page and asking for the OTP | wait |
| `otp_sent` | the site shows its OTP (or two-step verification code) screen; `message` is what it said | `verify` with `otp` (or `start` again after `resendInMs`) |
| `password_needed` | password sites (`method: 'password'`, Amazon): the password page is showing | `verify` with `password`. A wrong one stays here with `error`; the 3rd wrong one ends in `error` so the account isn't locked |
| `approve_needed` | the site sent a sign-in request to the user's phone | approve it there, then `verify` with just `{ site }` |
| `verifying` | entering the OTP or password | wait |
| `signed_in` | the session is in the browser profile | — |
| `error` | `error` says what went wrong (message starts with the site id) | `start` again |

A wrong OTP returns 400 and goes back to `otp_sent` with `error` set. A wrong password does the same on `password_needed`. The service doesn't write the phone number or OTP to its own files or logs; it keeps only the last 4 digits, for `phoneHint`. (They are typed into the site's page, so the site itself, and Chrome's form state in the profile, are outside this guarantee.)

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
              history: { low, lowSeenAt, delta, tag: 'new-low'|'at-low'|'above-low',
                         change: 'down'|'up'|'same'|null, changePct, prev } | null }]
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

`history` is per base unit (₹/kg, ₹/L, ₹/pc) and is compared against what was stored before this run. It is `low: null` on the first sighting. `change`/`changePct`/`prev` compare with the latest earlier saved price for that site (the page's ▼/▲); in a history-first result they compare the saved price with the one saved before it.

## Examples

```bash
curl -s -X POST localhost:7777/api/compare -H 'content-type: application/json' \
  -d '{"items":"2x toor dal 1kg\nsugar 1kg","platforms":["instamart","bigbasket"]}'
curl -sN localhost:7777/api/events            # watch progress
curl -s 'localhost:7777/api/history?q=toor%20dal%201kg'
```
