---
name: basket
description: Compare live grocery prices across Indian quick-commerce platforms (Blinkit, Zepto, BigBasket, Amazon Now) to find which is cheapest for a whole basket. Use when the user gives a shopping list, asks "where should I buy these", "which app is cheaper", "how much is X", "compare prices for my groceries", mentions Blinkit/Zepto/BigBasket/Instamart/quick commerce pricing, or wants price-per-unit normalization across different pack sizes. Also use for single-item price checks across platforms.
---

# Basket — grocery price comparison

Compares a whole **basket**, not individual items. Cheapest-per-item is a lookup;
cheapest-basket is arithmetic nobody does by hand, and it frequently flips the
answer — a platform wins on two items and loses on the other ten.

Every price is fetched live from the platform at run time. **Nothing is
hardcoded** — no price list, no pack table, no fee table. When the tool doesn't
know a number it says so instead of supplying a plausible one. Preserve that when
you relay results: don't fill gaps with your own estimates.

## Before anything else: check the environment

Every search runs as a real webcmd command against a browser webcmd owns.

```bash
jhola doctor
```

That checks Node, webcmd, the browser bridge, the four adapters, and the data
directory — and prints a fix under anything that fails. **Run it first whenever
something looks wrong**; it is faster than reading errors from a failed run.

If it reports problems, `jhola setup` fixes most of them non-interactively
(clears the stale cloak lock, regenerates adapters) and then walks the user
through setting delivery locations.

**Two failure modes worth recognising by name**, because webcmd's own messages
don't spell them out:

- *"profile is already in use by another instance of Chromium"* — an orphaned
  cloak browser holds a lock on `~/.webcmd/cloak/profiles/default`.
  `jhola setup` clears it, or kill `*cloakbrowser*` processes and remove
  `Singleton{Lock,Cookie,Socket}` from that directory.
- *`fetch failed` on first run* — cloak is downloading ~150 MB of Chromium into
  `~/.cloakbrowser/`. Needs network and patience, not debugging.

**Delivery location** lives in the webcmd browser profile. Set it once per
platform by hand and it persists (`siteSession: 'persistent'` keeps it alive
across commands). If a platform returns *"results never rendered"*, the location
is missing — fix it in the browser, don't debug the adapter:

```bash
WEBCMD_WINDOW=foreground \
  printf 'await page.goto("https://www.bigbasket.com/");' \
  | webcmd browser setloc run --stdin
```

### Running a single site directly

```bash
webcmd blinkit search --query "amul butter 500g" -f json
```

Note `--query` is a named option, not positional.

## Commands

```bash
jhola <list.txt>          compare a basket
jhola "tata salt 1kg"     one-line basket, no file needed
jhola <list.txt> --ui     rich boxed terminal view
jhola <list.txt> --web    terminal view + a URL, server stays up
jhola search "<query>"    price ONE product everywhere
jhola fees                show / set delivery + handling
jhola serve               web view only
jhola setup               first-run wizard
jhola doctor              environment check
```

From a source checkout, `node src/cli.js …` works identically.

**Use `search` for one product, `compare` for a list.** A basket run drives a
real browser across every platform and takes 30 s – 5 min; `search` is the same
matching on one query and returns in seconds. Running a full comparison to answer
"how much is milk" wastes minutes of the user's time.

### Which surface to use

**Default to `--ui` inside Claude Code** — it renders the whole comparison in the
terminal, so the user sees everything without leaving the session.

**Use `--web` when the user asks to see it, explore it, or change the basket.**
It prints the terminal view *and* a `http://localhost:7777` URL, then stays
running. The page has its own basket editor, so the user can re-run there. Note
it blocks until Ctrl+C — mention that when you start it.

| Flag | Effect |
|---|---|
| `--platforms=a,b,c` | Default `blinkit,zepto,bigbasket`; `amazon` is opt-in |
| `--json` | Machine-readable output only |
| `--pincode=110048` | Display only — the browser profile is the real source |
| `--port=7777` | Port for `--web` / `serve` |
| `--no-open` | Don't launch a browser |

Basket format is one item per line, optional leading quantity. `#` comments and
blank lines are ignored.

```
2x amul taaza toned milk 500ml
amul butter 500g
6 eggs
tata salt 1kg
```

### Machine-readable output

Every command takes `--json` and returns one envelope, so you never have to parse
the boxed terminal view. Prefer this when you intend to compute on the numbers;
prefer `--ui` when the user is going to read the output themselves.

```bash
jhola search "amul butter 500g" --json
```
```json
{ "ok": true, "query": "amul butter 500g",
  "cheapest": { "platform": "bigbasket", "found": true, "confident": true,
                "price": 230, "pack": "500g", "pricePerUnit": "₹46.00 / 100g",
                "confidence": 0.95, "url": "..." },
  "results": [ ... ], "feesKnown": false }
```

**Read `confident`, not just `found`.** Each row is one of three things:

- `found: true, confident: true` — a real match; only these can be `cheapest`
- `found: true, confident: false` — something came back but it is **not this
  product** (`confidenceReason` says why). Report it as a near-miss if useful,
  never as the item's price.
- `found: false` — `error: null` means not stocked; `error: "…"` means that
  platform's search broke, which is a different thing to tell the user.

A query where everything scored below threshold returns `cheapest: null` and exit
`3`. Say nothing confident matched. Do not fall back to the flagged row.

Failures use the same shape — `{"ok": false, "error": "..."}`. Branch on the exit
code rather than the message text:

| Exit | Meaning | What to do |
|---|---|---|
| `0` | Success | Report the result |
| `1` | Runtime failure | Run `jhola doctor`; the backend or bridge is down |
| `2` | Usage error | Fix the arguments — bad flag, unknown platform, empty query |
| `3` | Ran fine, found nothing | Say nothing matched; do not retry identically |

`jhola setup` is interactive and refuses to run without a TTY — never call it
from a script. Use `jhola doctor` for a non-interactive check.

### Fees: goods-only unless the user set them

**Totals are goods-only by default.** Delivery and handling are only revealed at
checkout, and this tool never builds a cart, so it genuinely cannot read them. It
does not guess: no fee numbers exist anywhere in the codebase.

The output tells you which you're looking at — `GOODS TOTAL` vs `TOTAL`, plus
`feesKnown` / `feesMissing` in JSON and `totalsInclude` over MCP.

**When `feesKnown` is false, say so when you report the number.** "BigBasket is
₹81 cheaper on goods; delivery and handling aren't included" is honest. Quoting
₹251 as what the user will pay is not.

If the user knows their real fees, offer to record them once:

```bash
jhola fees --set blinkit --delivery 25 --handling 9 --free-above 199
```

Take those numbers **from the user**. Never fill them in from your own knowledge
of what a platform "usually" charges — that is exactly the fabrication this
design removes.

### HTTP API

When a server is running (`--web` or `serve`), these are available on localhost:

| Route | Method | Does |
|---|---|---|
| `/api/result` | GET | Last comparison as JSON (`204` if none) |
| `/api/meta` | GET | Available platforms, defaults, threshold |
| `/api/compare` | POST | `{items, platforms?, pincode?}` → runs and returns |
| `/health` | GET | Liveness + whether a run is in flight |

Only one comparison runs at a time; a second gets `409`. Prefer the CLI over
`curl` unless the user specifically wants the API.

### Via MCP

The `basket` MCP server exposes four tools:

- `compare_basket(items, pincode?, platforms?)` — whole basket; markdown table
  plus a JSON summary carrying `totalsInclude`, `feesKnown` and `feesMissing`
- `search_product(query, platforms?)` — one product priced everywhere, fast
- `open_basket_view()` — opens the interactive browser page for the last result
- `open_platform(platform?)` — opens the buy link, defaults to the winner

Register with:

```bash
claude mcp add jhola -- node <abs-path>/src/mcp-server.js
```

## Platforms

| Site | Status | Strategy |
|---|---|---|
| `blinkit` | ✅ default | `DOM_STATE` — `window.__reduxStore__` search snippets |
| `zepto` | ✅ default | `UI_SELECTOR` — `/pn/<slug>/pvid/` cards, names from slug |
| `bigbasket` | ✅ default | `UI_SELECTOR` — `/pd/<id>/<slug>/` cards, pipe-delimited text |
| `amazon` | ⚠ opt-in | `UI_SELECTOR` — Amazon Now (`i=nowstore`). Thin catalogue; a butter query returns ghee. Include only when explicitly asked. |
| `instamart` | ❌ stub | Search results render intermittently. Not implemented. |
| JioMart, DMart | ❌ | Ruled out in recon — JioMart shows no prices without a location cookie, DMart is behind a login wall. |

Zepto's live domain is **`zepto.com`**. `zeptonow.com` does not resolve directly.

## How matching works — and when it refuses

This is the part worth explaining to a user, because it is what stops the tool
confidently comparing the wrong things.

Each candidate is scored 0–1 on token overlap, variant agreement and pack
signal. Below `0.55` it is **flagged and shown, never silently totalled**. Four
conditions cause an outright refusal at score 0:

| Refusal | Example |
|---|---|
| **Unit family mismatch** | 500 g butter vs 500 ml oil — mass and volume share no denominator, so ₹/100g and ₹/100ml cannot be compared |
| **Brand mismatch** | Query says Amul, product is Mother Dairy |
| **Product type mismatch** | Query says butter, name contains no "butter" |
| **Different category** | `amul butter` vs *Amul Butter **Cookies*** — the word matches, the food doesn't |

That last one is the subtle one. Presence-anywhere matching happily buys sixteen
packs of butter cookies; comparing category *sets* catches it.

## Pack normalization

Sizes are normalized to grams, millilitres or pieces before anything is
compared: `2 x 250ml → 500ml`, `0.5 L → 500ml`, `1kg → 1000g`, `1 dozen → 12`.

Crucially, the scorer **buys the packs you would actually need**. Ask for 500g,
find only a 200g pack, and it charges for three packs — not for 2.5, and
certainly not pretending a 200g pack competes with a 500g one. The table shows
`3× 200g` so the arithmetic is visible rather than asserted.

## Reading the output honestly

### Cheapest ≠ best. Always read coverage with price.

The single most misleading thing this tool could do is hand the win to whichever
platform failed to stock the most items — an empty basket is always the cheapest
basket. Two mechanisms prevent that, and you should explain both to the user:

1. **When at least one platform stocks everything**, only complete baskets
   compete. An incomplete basket cannot win on price.
2. **When nobody stocks everything**, the verdict is computed on the
   **common subset** — only the lines every platform actually priced. That is a
   true like-for-like number even though no basket is complete. The header says
   so: *"cheapest on what everyone stocks"* and *"compares 8 of 12 items
   available everywhere"*.

On top of that, if the winner has **worse coverage** than some other platform,
the output surfaces a **best-coverage** recommendation:

```
→ Best coverage: Blinkit 11/12 at ₹1,679.00 — one trip instead of two.
  Cheapest is only cheapest if you don't mind sourcing 4 items elsewhere.
```

**When relaying results, present both.** "Zepto is ₹47 cheaper on the 8 items
both stock, but Blinkit covers 11 of 12 — Zepto leaves you sourcing 4 items
somewhere else." Never report the headline price alone.

### Other signals

- **`items found` (`10/12`)** — that platform's basket is smaller.
- **`?` next to a price** — matched below threshold. Look before trusting.
- **Repeated `no-results` for staples** (milk, bread, eggs) usually means a
  scrape failure, not genuine absence. The extractor retries once on empty; if a
  platform still shows zeros across common items, treat its numbers as suspect
  and say so rather than reporting it as cheap.
- **`GOODS TOTAL` in the header** means delivery and handling are excluded for at
  least one platform. Repeat that caveat when you quote the number.

## Adding a platform

1. Recon: load the search URL in the debug browser, find where the data lives —
   a hydration blob on `window` beats CSS selectors every time.
2. Create `src/extract/<site>.js` exporting `site`, `label`, `searchUrl(query)`,
   `readyExpression`, `extractExpression`. Write the strategy note in the header
   comment: what you chose, the evidence, and why a simpler strategy doesn't work.
3. Return the shared envelope exactly — `name, packSize, packUnit, price, mrp,
   inStock, url`. The normalizer must never know which platform it is reading.
4. Register in `src/extract/index.js`, and add its display name to `LABELS` in
   `src/fees.js`. Do not add fee numbers there — that file holds none by design.
5. Verify against the live page: `node scripts/probe.js <site> "amul butter 500g"`
   and compare the numbers to what the site actually shows. A probe that passes
   on wrong data is the failure mode that kills a demo.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `No search backend available` | webcmd bridge down and no debug Chrome — run `jhola doctor` (exit 1) |
| Total shows no delivery charge | Expected. Goods-only until the user runs `jhola fees --set` |
| Every platform returns 0 rows | Delivery location lost from the browser profile |
| `navigation failed after 3 attempts` | Network dropped; adapters already retry twice |
| One platform empty, others fine | That site changed its markup — re-run recon for it |
| Implausible price (₹5 for 6 eggs) | A discount badge parsed as the price. Filter badge lines in that extractor. |

## Architecture note

webcmd is the engine. `src/platforms.js` calls `selectBackend()` once per run:
`webcmd` when adapters are installed and the bridge is up, otherwise a direct
CDP fallback that speaks the same envelope. The run header prints which served
it (`via webcmd` / `via cdp`) — check it before trusting a demo.

Adapters are **generated**, never hand-edited: `scripts/build-adapters.js` reads
`src/extract/*.js` and writes `~/.webcmd/clis/<site>/search.js`. Adapters may
only import from `@agentrhq/webcmd/*`, so they can't require project source;
generating them keeps one source of truth. Change the extractor, re-run the
generator.
