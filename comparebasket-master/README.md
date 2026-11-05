# Basket

Give it a grocery list. It checks **Blinkit, Zepto, BigBasket and Amazon Now**
with live prices, normalizes pack sizes, and tells you which platform is cheapest
**for the whole basket** — in your terminal, at a URL, or over MCP.

Built on [webcmd](https://github.com/agentrhq/webcmd): each platform is a real
compiled webcmd command, not a screen-scraper bolted to the side.

```
  BASKET   pincode 110048 · 31.9s · 3 platforms · via webcmd

  ╭──────────────────────────────────────────────────────────────────────╮
  │ITEM                        BIGBASKET          ZEPTO           BLINKIT│
  ├──────────────────────────────────────────────────────────────────────┤
  │amul butter 500g              ₹230.00        ₹310.00           ₹310.00│
  │                   500g · 46.00 / 100g  500g · 62.00/100g  500g · 62.00│
  │tata salt 1kg                  ₹21.00         ₹22.00            ₹29.00│
  ├──────────────────────────────────────────────────────────────────────┤
  │delivery                            —              —                 —│
  │handling                            —              —                 —│
  ├──────────────────────────────────────────────────────────────────────┤
  │GOODS TOTAL                   ₹251.00        ₹332.00           ₹339.00│
  │items found                       2/2            2/2               2/2│
  ╰──────────────────────────────────────────────────────────────────────╯

  ╭─ VERDICT ──────────────────────────────────────────────────────────────╮
  │ BigBasket is cheapest — ₹251.00                                        │
  │ You save ₹81.00  vs Zepto at ₹332.00                                   │
  ╰────────────────────────────────────────────────────────────────────────╯

  ⚠ Goods only — delivery and handling are NOT included
  ● Web view  http://localhost:7777
```

**Why baskets, not items.** Cheapest-per-item is a lookup anyone can do.
Cheapest-basket is arithmetic nobody does by hand, and it regularly flips the
answer — a platform wins on two items and loses on the other ten, or wins only
because it quietly didn't stock half your list.

**Everything in the output is read live.** No prices, packs or fees are baked
into this repo. If a number isn't on the page, the tool says it doesn't know it
rather than filling in a plausible one — see [Fees](#fees).

---

## Install

```bash
npm install -g comparebasket
basket setup
```

`basket setup` is a wizard: it checks webcmd, clears the stale browser lock that
otherwise blocks the bridge, generates the adapters, and walks you through
setting a delivery location on each platform. It exists because every one of
those steps cost real debugging time once.

Prerequisite: [webcmd](https://github.com/agentrhq/webcmd) —
`npm install -g @agentrhq/webcmd`. Node ≥ 20.

Check anytime:

```bash
basket doctor
```
```
  ✔ Node 22.15.0
  ✔ webcmd 0.5.3
  ✔ webcmd browser bridge connected
  ✔ adapters installed: blinkit, zepto, bigbasket, amazon
  ✔ data directory writable (C:\Users\HP\.basket)
```

---

## Use

```bash
basket list.txt                  # terminal table
basket list.txt --ui             # rich boxed terminal view
basket list.txt --web            # terminal view + http://localhost:7777
basket "tata salt 1kg"           # one-line basket, no file needed
cat list.txt | basket --ui       # stdin
```

| Command | Does |
|---|---|
| `basket <file\|"items">` | Compare a basket (the default) |
| `basket search "<query>"` | Price **one** product everywhere — seconds, not minutes |
| `basket fees` | Show / set delivery + handling (see [Fees](#fees)) |
| `basket serve` | Web view only, paste a basket in the browser |
| `basket setup` | First-run wizard |
| `basket doctor` | Environment check |

| Flag | Effect |
|---|---|
| `--web` | Serve the interactive page, print its URL, stay running (Ctrl+C stops) |
| `--ui` | Rich boxed terminal view |
| `--json` | Machine-readable output, nothing else |
| `--platforms=a,b,c` | Default `blinkit,zepto,bigbasket`; also `amazon` |
| `--pincode=110048` | Display only — the browser profile is the real source |
| `--port=7777` | Port for `--web` / `serve` |
| `--no-open` | Don't launch a browser |

### Basket format

One item per line, optional leading quantity. `#` comments and blanks ignored.

```
2x amul taaza toned milk 500ml
amul butter 500g
6 eggs
tata salt 1kg
```

`2x foo` and `3 foo` are quantities. `500 ml milk` is not — a leading number
followed by a unit reads as a pack size, and bare numbers above 20 are never
quantities.

---

## Fees

**Totals are goods-only by default, and the output says so.**

Delivery and handling are only revealed at checkout. The search and listing pages
this tool reads carry nothing usable — Blinkit's own search state ships
`chargeableDeliveryCost: 0` and `additional_charges_config: null`, because no
cart exists yet. Reading real fees would mean adding items to a real cart, which
v1 deliberately doesn't do.

An earlier version shipped hand-written fee tables marked `verified: false`. They
rendered as authoritative rupee amounts and were fiction. They're gone. Nothing
in this repo knows what Blinkit charges for delivery.

If you know your actual fees, supply them once:

```bash
basket fees                                                  # what's set
basket fees --set blinkit --delivery 25 --handling 9 --free-above 199
basket fees --clear blinkit
```

Stored in `~/.basket/fees.json`. Any platform with fees set gets them folded into
its total and free-delivery threshold applied; any platform without stays
goods-only. The header switches from `GOODS TOTAL` to `TOTAL` only when **every**
platform in the run has fees configured — a mixed row would compare a
fees-inclusive total against a goods-only one and call it a saving.

---

## Calling it from an agent

Every command takes `--json` and returns one envelope shape, so nothing has to
parse prose or ANSI boxes.

```bash
basket search "amul butter 500g" --platforms=blinkit,bigbasket --json
```
```json
{
  "ok": true,
  "query": "amul butter 500g",
  "cheapest": {
    "platform": "bigbasket", "found": true, "confident": true, "price": 230,
    "name": "Amul Butter Pasteurised",
    "pack": "500g", "pricePerUnit": "₹46.00 / 100g",
    "confidence": 0.95, "confidenceReason": null,
    "url": "https://www.bigbasket.com/pd/104864/...", "error": null
  },
  "results": [ ... ],
  "feesKnown": false
}
```

Three states per platform, and they mean different things:

| Row | Means |
|---|---|
| `found: true, confident: true` | A real match. Only these are eligible to be `cheapest`. |
| `found: true, confident: false` | Something came back, but it isn't this product — `confidenceReason` says why. Shown so you can judge it; never counted. |
| `found: false` | `error: null` → not stocked. `error: "…"` → that platform's search failed. |

A query with only low-confidence rows returns `cheapest: null` and exit `3`. The
tool would rather say "no confident match" than hand you a ₹208 pack of Cadbury
Gems as the price of something it doesn't stock.

Failures use the same envelope — `{"ok": false, "error": "..."}` — and the exit
code tells you which kind without reading the message:

| Exit | Meaning |
|---|---|
| `0` | Success |
| `1` | Runtime failure (backend down, browser bridge dead) |
| `2` | Usage error (bad flag, unknown platform, empty query) |
| `3` | Ran fine, found nothing |

`basket setup` refuses to run when stdin isn't a TTY rather than hanging on a
prompt inside a pipeline.

---

## The web view

`--web` (or `serve`) starts a local server on `127.0.0.1` and prints a URL. The
page shows the same comparison as the terminal, plus a basket editor — edit the
list, tick platforms, press **Compare**, and it re-runs without going back to
the shell. A terminal run refreshes any open tab within a few seconds.

It binds to loopback only, deliberately: `POST /api/compare` drives a real
browser with whatever basket it's handed, and that should not be reachable from
whatever Wi-Fi you're on.

| Route | Method | Does |
|---|---|---|
| `/` | GET | The page |
| `/api/result` | GET | Last comparison as JSON (`204` if none yet) |
| `/api/meta` | GET | Available platforms, defaults, threshold |
| `/api/compare` | POST | `{items, platforms?, pincode?}` → runs and returns a comparison |
| `/health` | GET | Liveness + whether a run is in flight |

```bash
curl -s localhost:7777/api/result | jq .winner
curl -s -X POST localhost:7777/api/compare \
  -H 'content-type: application/json' \
  -d '{"items":"tata salt 1kg","platforms":["blinkit","bigbasket"]}'
```

Only one comparison runs at a time — a second returns `409` rather than two runs
fighting over a single browser session.

---

## Cheapest ≠ best

The most dangerous failure for a price comparator is rewarding the platform that
stocked the least — **an empty basket is always the cheapest basket.** Three
guards:

**1. Complete baskets win.** If any platform stocks everything, only complete
baskets compete.

**2. Otherwise, compare the common subset** — only lines every platform actually
priced. The output says so: *"cheapest on what everyone stocks — compares 8 of 12
items available everywhere"*.

**3. Coverage sits next to price.** If the winner covers less than someone else:

```
⚠ Zepto only stocked 8/12 of your basket.
→ Best coverage: Blinkit 11/12 at ₹1,679.00 — one trip instead of two.
  Cheapest is only cheapest if you don't mind sourcing 4 items elsewhere.
```

> Repeated `no-results` for staples (milk, bread, eggs) usually means a scrape
> failure, not genuine absence. Searches retry once on empty; if a platform still
> returns zeros across common items, treat its total as suspect, not cheap.

---

## Matching: what it refuses, and why

Candidates score 0–1. Below **0.55** they're flagged and shown, never silently
totalled. Four conditions refuse outright:

| Refusal | Example |
|---|---|
| **Unit family mismatch** | 500g butter vs 500ml oil — ₹/100g and ₹/100ml share no axis |
| **Brand mismatch** | Query says Amul, product is Mother Dairy |
| **Product type mismatch** | Query says butter, name has no "butter" |
| **Different category** | `amul butter` vs *Amul Butter **Cookies*** |

The last is the subtle one, and a real bug this codebase hit: matching on "is the
word present" cheerfully bought sixteen packs of butter cookies. Comparing
category *sets* catches it.

### Pack normalization

`2 x 250ml → 500ml` · `0.5 L → 500ml` · `1kg → 1000g` · `1 dozen → 12`

The scorer **buys the packs you'd actually need**. Ask for 500g, find only 200g
packs, and it charges for three — not 2.5, and not pretending a 200g pack
competes with a 500g one. The table prints `3× 200g` so you can check the maths.

---

## webcmd is the engine

Every search is a real webcmd command:

```bash
webcmd blinkit search --query "amul butter 500g" -f json
```

Adapters live at `~/.webcmd/clis/<site>/search.js` — `Strategy.UI`,
`browser: true`, `siteSession: 'persistent'` (so the delivery location survives
across commands), typed errors, and a shared 7-column envelope:

```js
{ name, packSize, packUnit, price, mrp, inStock, url }
```

They are **generated** by `scripts/build-adapters.js` from `src/extract/*.js`.
Adapters may only import from `@agentrhq/webcmd/*`, so they can't require this
project's source — generating them beats maintaining the same selectors twice.

```bash
npm run build:adapters          # all sites
node scripts/build-adapters.js zepto
```

`src/platforms.js` picks a backend once per run: `webcmd` when adapters are
installed and the bridge is up, else a direct CDP fallback speaking the same
envelope. **The run header prints which served it** — check it before trusting a
demo.

### If `webcmd doctor` won't go green

The failure we hit, and the fix, because the error doesn't name it:

> `Opening in existing browser session. This usually means that the profile is
> already in use by another instance of Chromium.`

An orphaned cloak Chromium holds a lock on `~/.webcmd/cloak/profiles/default`.
`basket setup` clears this for you, or by hand:

```powershell
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*cloakbrowser*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```
```bash
rm -f ~/.webcmd/cloak/profiles/default/Singleton{Lock,Cookie,Socket}
webcmd doctor
```

A first-run `fetch failed` is different: cloak is downloading ~150 MB of Chromium
into `~/.cloakbrowser/`. That one just needs working network and patience.

---

## Platforms

| Site | Status | Strategy |
|---|---|---|
| Blinkit | ✅ default | `DOM_STATE` — `window.__reduxStore__` |
| Zepto | ✅ default | `UI_SELECTOR` — `/pn/<slug>/pvid/`, names from slug |
| BigBasket | ✅ default | `UI_SELECTOR` — `/pd/<id>/<slug>/` |
| Amazon Now | ⚠ opt-in | `i=nowstore`. Thin catalogue — a butter query returns ghee |
| Instamart | ❌ stub | Results render intermittently |
| JioMart, DMart | ❌ | No prices without a location cookie / login wall |

Zepto's live domain is **`zepto.com`** — `zeptonow.com` doesn't resolve.

### Adding one

1. Recon in the webcmd browser. A hydration blob on `window` beats CSS selectors.
2. `src/extract/<site>.js` exporting `site`, `label`, `searchUrl`,
   `readyExpression`, `extractExpression`, with a strategy note in the header.
3. Return the shared envelope exactly.
4. Register in `src/extract/index.js`, and add its display name to `LABELS` in
   `src/fees.js`. (No fee numbers — that file holds none by design.)
5. `npm run build:adapters && node scripts/probe.js <site> "amul butter 500g"`
   and **compare against the live page**. A probe that passes on wrong data is
   worse than one that fails.

---

## MCP

```bash
claude mcp add basket -- node "$(npm root -g)/comparebasket/src/mcp-server.js"
```

| Tool | Does |
|---|---|
| `compare_basket(items, pincode?, platforms?)` | Whole basket → markdown table + JSON summary |
| `search_product(query, platforms?)` | One product priced everywhere — fast |
| `open_basket_view()` | Starts the web view and returns its **URL** |
| `open_platform(platform?)` | Buy link, defaults to the winner |

The MCP process hosts the web server itself, so `open_basket_view` hands back a
live URL the user can keep using after the conversation moves on.

`compare_basket`'s JSON block carries `totalsInclude: "goods only" | "goods +
fees"` alongside `feesKnown` and `feesMissing`, so a model can't quote a
goods-only figure as a final bill without having been told.

---

## Layout

| Path | Job |
|---|---|
| `src/cli.js` | Command surface |
| `src/compare.js` | `compareBasket()` — the one entry point every surface calls |
| `src/resolver.js` | Basket text → `{query, qty}` |
| `src/extract/*.js` | Per-platform extraction (source of truth for adapters) |
| `src/normalize.js` | Pack parsing, match confidence, price-per-unit |
| `src/score.js` | Best pick, packs needed, totals, ranking, coverage |
| `src/fees.js` | User-supplied fee config — carries no fee numbers itself |
| `src/server.js` | Local HTTP server + JSON API |
| `src/tui.js` | Boxed terminal renderer |
| `src/setup.js` | `setup` wizard and `doctor` |
| `src/paths.js` | Package root vs writable `~/.basket` |

Runtime state lives in `~/.basket/` (override with `BASKET_HOME`) — nothing is
ever written inside the installed package.

---

## Development

```bash
npm test                                        # 47 tests, no network
node scripts/probe.js bigbasket "amul butter"   # one site, one query
node scripts/mcp-smoke.js                       # MCP protocol check
npm run build:adapters                          # regenerate webcmd adapters
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `No search backend available` | webcmd bridge down and no debug Chrome — run `basket doctor` |
| `results never rendered` | Delivery location not set for that platform |
| Every platform returns 0 rows | Location lost from the webcmd profile |
| One platform empty, rest fine | That site changed markup — re-run recon |
| Implausible price | A discount badge parsed as price — filter badge lines |
| `409` from `/api/compare` | A comparison is already running |
| Total has no delivery charge | Expected — goods-only until you run `basket fees --set` |

---

## Not implemented

Cart preparation · login/auth · persistence beyond the last result ·
multi-pincode · coupons · membership pricing · price history · split-basket
optimization (cheapest single platform vs cheapest split across two, fees counted
twice — the strongest next upgrade).

## License

MIT
