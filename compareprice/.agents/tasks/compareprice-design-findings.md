> **SUPERSEDED (2026-11-18):** this pre-dates the engine rewrite. See AGENTS.md, docs/ENGINE.md and docs/superpowers/plans/2026-11-16-basket-service-STATUS.md.

# compareprice — Design & Mechanics Findings

**Investigation scope:** READ-ONLY. Source read in full; offline unit suite run (`npm test`). The live CLI, webcmd, and any browser/network paths were **not** exercised. Project root: `/home/a/Downloads/git/compareprice`. Upstream: https://github.com/aizen2006/comparebasket.

---

## Summary answer (how it works and how it was designed)

`compareprice` ("basket") is a Node.js ESM CLI (`type: module`, `engines.node >= 20`, one runtime dep `@modelcontextprotocol/sdk`) that compares a grocery **basket** across Indian quick-commerce platforms (Blinkit, Zepto, BigBasket, Amazon Now) using **live** prices and tells you which platform is cheapest for the whole basket.

The architecture is a clean layered pipeline funnelled through **one entry point**, `compareBasket()` in `src/compare.js`. Every surface — CLI (`src/cli.js`), web server (`src/server.js`), and MCP server (`src/mcp-server.js`) — calls that single function and only differs in how it renders the returned object. The design intent, stated repeatedly in both code comments and the README, is **honesty over completeness**: live data only, no baked prices or fees, and a matcher that refuses to compare the wrong products rather than producing a confident-but-wrong answer.

The data flow:

```
basket text
   │  resolveBasket()            src/resolver.js      → [{raw, query, qty}]
   ▼
compareBasket()                  src/compare.js       (single entry point)
   │  selectBackend()            src/platforms.js     → "webcmd" | "cdp" | null
   │  searchAll(queries)         src/platforms.js     → per-platform rows {resultsByQuery}
   │       ├─ webcmd backend: execFile `webcmd <site> search --query q -f json`
   │       └─ cdp backend:     src/extract/*.js via src/browser.js (CDP)
   │  → shared 7-col envelope {name,packSize,packUnit,price,mrp,inStock,url}
   ▼
scorePlatform() per platform     src/score.js
   │  annotate()                 src/normalize.js     (pack, pricePerUnit, confidence)
   │  pickBest(), packsNeeded()  src/score.js
   │  feesFor()                  src/fees.js          (goods-only unless user config)
   ▼
rank()                           src/score.js         (winner, subset, coverage guards)
   ▼
result object → rendered by:
   CLI table / renderTui()       src/cli.js / src/tui.js
   web JSON + basket.html        src/server.js / src/ui/basket.html
   markdown + JSON               src/mcp-server.js
```

**`npm test` result: all 47 tests pass offline, exit 0** (see §7). This matches the README's "47 tests, no network" claim exactly.

Overall, the README and `.claude/skills/basket/SKILL.md` are unusually faithful to the code — nearly every design claim is directly confirmable in source. I found only **one** real (cosmetic) discrepancy: `src/tui.js` reads `r.labels`, a field `compareBasket()` never produces (§8, Discrepancy 1). A few smaller nuances are noted where the README simplifies.

---

## 1. Architecture overview & the single entry point

**Entry point — `compareBasket()` (`src/compare.js`).** The module docstring states the intent plainly: "the single entry point every surface calls … Nothing computes a total twice; if two surfaces disagree, that's a bug here." The function (`src/compare.js:28`):

1. Normalises `items` (string or `string[]`) to text, then `resolveBasket(text)` (`src/compare.js:37-38`).
2. Throws on an empty basket (`src/compare.js:40-42`) — this is what makes the CLI/server emit a usage/runtime error for empty input.
3. Picks platforms (`platforms ?? PLATFORMS`, `:45`) and a backend once via `selectBackend()` (`:47`); throws a descriptive "No search backend available" error if none (`:48-55`).
4. De-duplicates queries (`[...new Set(basket.map(i => i.query))]`, `:58`) so repeated basket lines hit the network once.
5. `searchAll(queries, {platforms, backend, onProgress})` (`:60`).
6. Loads fee config **once** (`loadFees()`, `:63`) and scores each available platform via `scorePlatform(...)` (`:74`), collecting unavailable platforms separately (`:70-72`).
7. `rank(scores)` (`:77`) and assembles the result object (`:79-116`).

**Result object** (the contract every surface renders) includes: `pincode`, `backend`, `generatedAt`, `elapsedMs`, `confidenceThreshold`, `basket`, `platforms` (scored), `unavailable`, `winner`, `runnerUp`, `saving`, `likeForLike`, `comparedOn`, `commonItems`, `coverageWarning`, and the fee flags `feesKnown` / `feesConfigured` / `feesMissing`.

**How each surface calls it:**

- **CLI** (`src/cli.js`): `main()` builds `text` from a file, a positional string, or stdin (`:393-401`), then `await compareBasket({items, pincode, platforms, onProgress})` (`:415`). `onProgress` prints a live `platform ← query` line to a TTY (`:419-426`). `search` (`searchCommand`, `:580`) and MCP both treat a one-line query as a single-item basket — "A one-line basket is exactly a single-item search" (`src/cli.js:606`), guaranteeing a product's price can never differ between `search` and `compare`.
- **Web server** (`src/server.js`): `POST /api/compare` calls `compare(...)` where `compare` defaults to `compareBasket` but is **injectable** (`startServer({compare = compareBasket})`, `:62`) — this is what lets `test/server.test.js` run routes with zero network.
- **MCP** (`src/mcp-server.js`): both `compare_basket` and `search_product` handlers call `compareBasket(...)` (`:260`, `:305`).

Shared persistence: `saveResult()` / `loadResult()` in `src/ui-writer.js` write `~/.basket/last-result.json` so a browser tab survives the CLI exiting; the CLI, server, and MCP all persist after every run so "the terminal and the web view never disagree" (`src/cli.js:430-432`).

---

## 2. Backend / engine design (webcmd vs direct CDP)

**Two backends, one envelope** (`src/platforms.js` docstring). `selectBackend()` (`:120`) probes **once per run**:

```
webcmdReady()      → "webcmd"   (preferred)
else browserAvailable() → "cdp" (fallback)
else null          → compareBasket throws "No search backend available"
```

- **`webcmdReady()`** (`:110`) runs `webcmd list -f json` and returns true only if the installed CLI list contains one of the default `PLATFORMS`. The webcmd path then shells out per query: `runWebcmd([platform, 'search', '--query', query, '-f', 'json'])` (`searchOne`, `:138`). Note the Windows-specific quoting workaround (`:65-72`) for the `.cmd` shim re-splitting args, and the long `CALL_TIMEOUT_MS = 120_000` (`:47`) because a cold webcmd page "can take well over a minute."
- **`browserAvailable()`** (`src/browser.js:132`) hits `http://127.0.0.1:9222/json/version` (overridable via `CDP_ENDPOINT`). The CDP fallback drives a Chrome the tool launches itself, running the `src/extract/*.js` extractors via `searchViaBrowser` (`src/extract/index.js`).

**Why CDP exists** is documented candidly in `src/browser.js` and `src/platforms.js`: at the hackathon venue "cloak could not provision a browser (its control API was unreachable)," so the extractors — deliberately written in the webcmd adapter shape — are run against a self-launched Chrome. This confirms the README's "picks a backend once per run … else a direct CDP fallback speaking the same envelope."

**The shared 7-column envelope** `{name, packSize, packUnit, price, mrp, inStock, url}` is enforced in **both** backends:
- webcmd path: `REQUIRED_FIELDS` + `validateRow()` (`src/platforms.js:51, 88-108`).
- CDP path: `REQUIRED` + `validate()` (`src/extract/index.js:18-41`), which additionally filters rows with no name or non-finite price and lowercases `packUnit`.

**Adapters are GENERATED, not hand-written** — see §2a. `scripts/build-adapters.js` writes `~/.webcmd/clis/<site>/search.js` from `src/extract/*.js`.

**The run header reports which backend served it.** The `backend` field flows into every renderer:
- CLI TUI: `via ${r.backend}` in the header (`src/tui.js:76`).
- MCP: `_Backend: ${r.backend}._` (`src/mcp-server.js`, `toMarkdown`).
- Web: `via <b>${esc(r.backend)}</b>` (`src/ui/basket.html` `render()`).

This confirms the README's "The run header prints which served it — check it before trusting a demo."

### 2a. Adapter generation (`scripts/build-adapters.js`)

- `IMPLEMENTED = ['blinkit','zepto','bigbasket','amazon']` (`:33`); instamart is skipped because its extractor is a stub.
- `adapterSource(site, ex)` (`:38`) emits a real webcmd command module that: imports only `@agentrhq/webcmd/registry` and `.../errors`; sets `strategy: Strategy.UI`, `browser: true`, `siteSession: 'persistent'`; declares `columns` as exactly the 7-field envelope; and embeds the extractor's `readyExpression`/`extractExpression`/`searchUrl` via `JSON.stringify` (so escaping is handled).
- The generated `func(page, kwargs)` polls readiness up to 24×700ms, retries extraction up to 4× (comment: Zepto re-navigates and "destroys the execution context mid-call"), throws `EmptyResultError`/`CommandExecutionError`, and slices to `limit` (default 30).
- The generated file header says: "GENERATED by scripts/build-adapters.js — edit src/extract/<site>.js instead." The rationale (adapters may only import from `@agentrhq/webcmd/*`, so they can't require project source → generation keeps a single source of truth) is stated in the script docstring and confirmed by the README/SKILL. **Confirmed.**

---

## 3. Matching & normalization (`src/normalize.js`)

### Pack normalization — all four README examples confirmed
`parsePack()` (`:72`) with the `UNITS` table (`:17-55`) and longest-first `UNIT_ALTERNATION` (`:57-59`):
- `2 x 250ml → 500ml`: `MULTIPACK_RE` multiplies count×each×mult (`:81-87`). Test: `test/normalize.test.js` "multipacks multiply out".
- `0.5 L → 500ml`: `SINGLE_RE`, 0.5×1000 (`:90-95`). Test confirms `{size:500, unit:'ml'}`.
- `1kg → 1000g`: `kg` maps to `['g',1000,'mass']`. Test "kg beats g when both could match" verifies the longest-first ordering so `1kg` isn't parsed as `1 g`.
- `1 dozen → 12`: `dozen` maps to `['piece',12,'count']`. Test confirms `{size:12, unit:'piece'}`.
Also `pack of N` via `PACK_OF_RE` (`:69`). `packFromProduct()` (`:111`) prefers structured `packSize/packUnit`, else falls back to parsing the product name.

### Confidence score 0–1 and the 0.55 threshold
`matchConfidence()` (`:198`) computes:
`score = 0.6·overlap + 0.3·variantAgreement + 0.1·packSignal`, where `overlap = 0.75·coverage + 0.25·precision` (query-token coverage weighted higher than product-token precision). Unbranded/unrecognised-brand queries get `score *= 0.5` (penalty, not refusal). `CONFIDENCE_THRESHOLD = 0.55` (`:308`). `annotate()` sets `confident = !refused && score >= 0.55` (`:329`). README claims "candidates score 0–1, below 0.55 flagged and shown" — **Confirmed.**

> Nuance: the README says candidates "score 0–1." Internally scores can be driven to 0 (refusals, or bad-brand halving) but never above the `0.6+0.3+0.1` ceiling of 1, so the 0–1 claim holds.

### The four refusal conditions (`refused: true`, score 0)
1. **Unit-family mismatch** — mass vs volume (`:216-222`). Test: "refuses mass against volume".
2. **Brand mismatch** — query names a brand, product names a *different* recognised brand (`:258-265`). Uses the `BRANDS` list (`:147-162`), phrase-matched. Test: "refuses a different named brand".
3. **Product-type mismatch** — the query's core tokens (brand+variant stripped) must appear in the product name; otherwise refuse (`:274-282`). Test: "refuses the right brand but the wrong food" (the Amul-butter → Amul Masti Dahi bug).
4. **Different category via category-SET comparison** — if the product introduces a `CATEGORY_TOKENS` category the query never named, refuse (`:287-296`). This is the subtle "butter cookies" guard. Tests: "refuses a product that adds a category the query never asked for" (16 packs of Amul Butter Cookies) and "refuses milk chocolate for a milk query."

Design care is visible in the `CATEGORY_TOKENS` comment (`:177-181`): flavour words like "cream"/"masala" are deliberately kept in `VARIANT_TOKENS`, *not* `CATEGORY_TOKENS`, "makes every flavour look like a different food." The test "a flavour word is not a category" (full-cream milk is *flagged*, not refused) locks this in. **All four refusals confirmed and regression-tested.**

### "Packs you'd actually need" purchase math
`packsNeeded(query, product)` in `src/score.js` (`:24`): `packs = max(1, ceil(want/have - 1e-9))`. Only applies within the same unit family. `scorePlatform` charges `price * packs * qty` (`:120`). README's "ask for 500g, find only 200g packs, charges for three" — Test "buys the number of packs actually needed" asserts `packs===3`, `lineTotal===255`, `covered===600`. Quantity multiplies on top (test "quantity multiplies on top of packs needed": `3 × ₹85 × 2 = 510`). **Confirmed.**

`pickBest()` (`src/score.js:49`) preference order: in-stock → confident → cheapest-per-unit → cheapest sticker. Oversized packs beyond `OVERSIZE_FACTOR = 4×` the requested size are dropped when a saner option exists (`:64-69`), but still used if nothing else exists (tests: the 20kg onion-sack cases).

---

## 4. Scoring/ranking & the "cheapest ≠ best" guards (`src/score.js`)

**Three per-platform line states** emerge from `pickBest()`'s `status` (`:71-85`) consumed by `scorePlatform`:
- `ok` → found + confident (eligible for totals).
- `low-confidence` → something returned but below threshold; surfaced in `lowConfidence[]`, never totalled.
- `no-results` / `out-of-stock` → `chosen: null`; line recorded in `missing[]` with `lineTotal: null`.

These feed the README's/SKILL's three JSON states (`found`/`confident`) and the CLI/MCP "flagged" vs "excluded" sections.

**Guard 1 — complete baskets win.** `rank()` (`:170`): if any platform is `complete`, only complete baskets are ranked by `total`; `likeForLike: true`, `comparedOn: 'full basket'` (`:178-190`). Tests: "a complete basket beats an incomplete cheaper one," "an incomplete basket does not win on price alone."

**Guard 2 — common-subset comparison.** If nobody is complete, compute `common` = lines every platform priced (`:195-197`), re-total each platform on just that subset (`subsetGoods`/`subsetTotal`, with fees re-applied, `:200-207`), and rank by `subsetTotal`; `likeForLike: false`, `comparedOn: "N of M items available everywhere"` (`:234`). Tests: "when nobody is complete, the verdict uses only items everyone priced" and "subset saving is computed on the subset, not the full basket." The saving is `runnerUp.subsetTotal − winner.subsetTotal` — a true like-for-like figure.

**Guard 3 — coverage reporting.** `byCoverage` sorts by `fulfilledLines` desc (`:214-217`); if the best-coverage platform beats the subset winner on coverage, a `coverageWarning` is emitted with `winnerMissing` count (`:219-228`). Tests: "coverage warning names the platform that stocks the most," and "no coverage warning when the winner also has the best coverage." Rendered by CLI (`renderVerdict`, `src/cli.js`), TUI, and MCP markdown as "→ Best coverage: … one trip instead of two."

The module docstring ("an empty basket is always the cheapest basket") and `ranking.test.js` header ("a platform must never win by failing to stock things") exactly match the README's "Cheapest ≠ best" section. **All three guards confirmed.**

**Exit codes** (`src/cli.js:530`): `EXIT = {OK:0, RUNTIME:1, USAGE:2, NO_RESULTS:3}`.
- `0` success; `1` runtime (top-level `dispatch().catch` → `process.exit(1)`, `src/cli.js` end; also backend-down throw); `2` usage (unknown platform `:462`, empty search query `:589`, `setup` without TTY `:702`, bad fees flags); `3` no confident match (`search` with `cheapest == null`, `:636` / `:664`).
**Confirmed against the README exit-code table.**

---

## 5. Fees design (`src/fees.js`)

- **No fee numbers in the repo, by design.** The file's top comment shouts it: "THERE ARE NO FEE NUMBERS IN THIS FILE, ON PURPOSE." Verified: the module contains only `LABELS` (display names), config read/write, and `feesFor`/`allFeesKnown` logic — no hardcoded rupee amounts. The README's explanation (search/listing pages carry `chargeableDeliveryCost: 0` / `additional_charges_config: null` because no cart exists; an earlier version shipped `verified: false` fictions that were removed) is restated verbatim-in-spirit in the code comment. **Confirmed.**
- **Totals goods-only by default.** `feesFor()` (`:116`) returns `known:false, total:0` when the user has no config for a platform; `scorePlatform` adds `fees.total` (0 when unknown) so `total === subtotal` for goods-only (`src/score.js:139-141`). **Confirmed.**
- **User config in `~/.basket/fees.json`.** `FEES_FILE = join(DATA_DIR, 'fees.json')` (`:35`). `loadFees()` validates each field (`isFiniteNumber`, `:49`), requires at least a delivery or handling charge to count a platform (`:69`). `saveFees()`/`clearFees()` back the `basket fees --set/--clear` CLI (`feesCommand`, `src/cli.js:544`). Free-delivery threshold applied when `subtotal >= freeDeliveryAbove` (`:131-133`). **Confirmed.**
- **GOODS TOTAL vs TOTAL header switch.** `allFeesKnown(platforms, config)` (`:147`) returns true only when **every** active platform has config. Surfaces switch on `r.feesKnown`:
  - TUI: `r.feesKnown ? 'TOTAL' : 'GOODS TOTAL'` (`src/tui.js`), with the comment about a "TOTAL" that silently omits delivery being "the kind of thing someone quotes on stage and then can't defend."
  - MCP markdown: same ternary (`src/mcp-server.js`, `toMarkdown`).
  - CLI plain table prints a "Goods subtotal"/"Delivery"/"Handling"/"BASKET TOTAL" breakdown and a goods-only footer warning when `!feesKnown` (`renderFooter`).
  The README's "switches … only when every platform in the run has fees configured — a mixed row would compare a fees-inclusive total against a goods-only one" — **Confirmed.**

---

## 6. Web server & MCP surfaces

### Web server (`src/server.js`) — zero-dependency `node:http`
Routes (all confirmed in code and `test/server.test.js`):
| Route | Method | Behaviour |
|---|---|---|
| `/` or `/index.html` | GET | Serves `src/ui/basket.html` (read from `PAGE_FILE`, never written). |
| `/health` | GET | `{ok, service:'basket', busy: inFlight !== null}`. |
| `/api/meta` | GET | `{platforms: ALL_PLATFORMS, defaultPlatforms: PLATFORMS, defaultPincode, confidenceThreshold, busy}`. |
| `/api/result` | GET | `loadResult()`; **204** when none (comment: so the page shows its empty state). |
| `/api/compare` | POST | `{items, platforms?, pincode?}` → runs `compare(...)`, persists, returns the result. |
| other | — | **404** JSON `{error:"No route …"}`. |

- **Loopback-only binding, deliberately.** `server.listen(p, '127.0.0.1', …)` (`:171`); docstring: "POST /api/compare drives a real browser with whatever basket it is handed, so this must not be reachable from the network." Test "binds to loopback only" asserts the URL is `http://localhost:<port>`. **Confirmed.**
- **Single-run 409 locking.** A single `inFlight` promise guards `/api/compare`; a second concurrent POST returns **409** (`:118-122`), cleared in `finally` (`:154`). Test "a second comparison while one is running gets 409, not a wedged browser." README's "Only one comparison runs at a time — a second returns 409." **Confirmed.**
- Hardening: `MAX_BODY = 256KB` (`readBody` rejects oversize, `:39`), JSON parse → 400, empty items → 400, unknown platforms filtered against `ALL_PLATFORMS`, `cache-control: no-store`, and `EADDRINUSE` auto-retry across up to 10 ports (`:165-178`). Tests `port:0` to avoid collisions.
- The page (`src/ui/basket.html`) polls `/api/result` on a `setInterval`, re-renders only when `generatedAt` changes, and holds a `dirty` flag so a terminal refresh never clobbers an in-progress textarea edit; `Ctrl/Cmd+Enter` triggers compare. This backs the README's "A terminal run refreshes any open tab within a few seconds."

### MCP surface (`src/mcp-server.js`) — stdio
Four tools (`ListToolsRequestSchema` handler): `compare_basket(items, pincode?, platforms?)`, `search_product(query, platforms?)`, `open_basket_view()`, `open_platform(platform?)`. **Confirmed** vs README/SKILL.
- The MCP process **hosts the web server itself** via `ensureServer()` (lazy `startServer`), so `open_basket_view` returns a live URL that outlives the conversation (README claim confirmed).
- `compare_basket` returns a markdown table **plus** a JSON block carrying `totalsInclude: "goods only" | "goods + fees"`, `feesKnown`, and `feesMissing` (`:270-290`) — exactly the "a model can't quote a goods-only figure as a final bill" guard the README describes. **Confirmed.**
- `open_platform` defaults to `lastResult.winner.platform` and opens the first product URL for that platform; errors if no prior comparison. Tool `enum` for `platform` is restricted to `PLATFORMS` (defaults), while `compare_basket`/`search_product` use `ALL_PLATFORMS`.
- Tool descriptions themselves encode the honesty rules (e.g. "Totals are GOODS ONLY … you must repeat that caveat", and "do not call [compare_basket] for a single product — use search_product").
- `scripts/mcp-smoke.js` validates the protocol offline: spawns the server, sends `initialize` + `tools/list`, prints the tools and required args, exits non-zero on failure.

---

## 7. Testing & tooling

**`npm test` → 47 tests, pass 47 / fail 0, exit 0, ~2.7s, no network.** Run command (`package.json`): `node --test test/normalize.test.js test/matching.test.js test/ranking.test.js test/server.test.js` (built-in `node:test`, no test framework dependency). This confirms the README's "47 tests, no network."

Coverage by file:
- **`test/normalize.test.js`** — pack parsing/normalization, multipacks, kg-vs-g ordering, null-on-no-pack, unit-family refusal, same-product-different-size, variant-mismatch scoring, price-per-unit on normalized size, resolver quantity-vs-pack parsing, resolver blank/comment skipping, `pickBest` in-stock + per-unit preference, missing-line reporting, incomplete-basket ranking.
- **`test/matching.test.js`** — the four refusal rules (each annotated as a real shipped bug), unbranded penalty, correct-brand acceptance, bare-count line ("6 eggs") stays comparable, pack-scaling math, qty×packs, refused candidate never chosen, out-of-stock skipped, `annotate` exposes refusal.
- **`test/ranking.test.js`** — complete-beats-incomplete, common-subset verdict, subset saving, oversized-pack rejection/fallback, missing-line reporting, coverage-warning presence/absence.
- **`test/server.test.js`** — loopback binding, `/health`, `/api/meta`, `/api/result` 204, `/` HTML, `/api/compare` 400s (empty/non-JSON), run+persist+re-read, **409** concurrency, 404. Uses an injected `compare` and `BASKET_HOME` tmpdir → genuinely offline.

**Tooling scripts:**
- `scripts/build-adapters.js` — generates webcmd adapters from extractors (§2a).
- `scripts/probe.js` — dev utility: runs one extractor via CDP against one query, annotates and `console.table`s rows with confidence/refusal, prints best-per-unit and rejected candidates. **Requires a live debug Chrome** (exits 1 if none) — not runnable in this read-only investigation.
- `scripts/mcp-smoke.js` — offline MCP protocol check (§6).

---

## 8. Notable design decisions, rationale, and README cross-check

**Decisions well-grounded in code + comments:**
- **Live-only, no baked data.** No price/pack/fee tables anywhere; `src/fees.js` explicitly carries none; extractors read live pages. SKILL reinforces "don't fill gaps with your own estimates." **Confirmed.**
- **Refuse rather than guess.** `matchConfidence` returns `refused` and the matcher excludes refused candidates at any price (`pickBest`); the whole `normalize.js` docstring is "Refusing is the point." **Confirmed.**
- **Category-SET matching to kill the "butter cookies" bug.** §3 Rule 4; regression-tested. The deliberate separation of variant vs category tokens is a thoughtful design detail. **Confirmed.**
- **Single entry point → surfaces can't disagree.** §1. Reinforced by `search`==single-item-basket and shared `saveResult`. **Confirmed.**
- **`siteSession: 'persistent'` for delivery location.** Set in generated adapters (`build-adapters.js`); the README/SKILL explain the delivery location lives in the webcmd browser profile and persists across commands; `setup.js` walks the user through setting it. **Confirmed** (in generated-adapter source; cannot be verified live here).
- **Writable state isolated from the package.** `src/paths.js`: `PKG_ROOT` read-only, all mutable state in `DATA_DIR` (`~/.basket`, overridable via `BASKET_HOME`). Tests rely on `BASKET_HOME`. **Confirmed.**
- **Retry-once-on-empty** to counter intermittent empty grids (`src/extract/index.js` `searchViaBrowser`; generated adapters also poll/retry). Matches the README's "Searches retry once on empty." **Confirmed.**
- **Backend transparency** (`via webcmd`/`via cdp` in every header). **Confirmed.**
- **Platform roster & strategies** match the README/SKILL tables: Blinkit `DOM_STATE` via `window.__reduxStore__` (`src/extract/blinkit.js`); Zepto `UI_SELECTOR` with names from the `/pn/<slug>/pvid/` URL slug because rendered text is truncated and "'s'-mangled" (`src/extract/zepto.js`); BigBasket `UI_SELECTOR` on `/pd/<id>/<slug>/`, with explicit discount-badge filtering so a "₹5 OFF" badge isn't read as the price (`src/extract/bigbasket.js`); Amazon Now `i=nowstore`, opt-in, "thin catalogue — a butter query returns ghee" (`src/extract/amazon.js` warning + `PLATFORMS` comment); Instamart a `not_implemented` stub (`src/extract/instamart.js`), excluded from `ALL_PLATFORMS` by the stub filter in `src/platforms.js:38-42` and skipped by `build-adapters.js`. Zepto domain `zepto.com` (not `zeptonow.com`) noted in-code. **Confirmed.**
- **`basket setup` refuses without a TTY** (`src/cli.js:701-706`) — README/SKILL confirmed.

### Discrepancies / nuances found

**Discrepancy 1 (real, cosmetic) — `r.labels` is never produced.**
`src/tui.js:86` reads `const name = (r.labels?.[p.platform] ?? p.platform).toUpperCase();`, but `compareBasket()` never sets a `labels` field on the result object (verified: `grep "labels" src/compare.js` → none). So the optional-chain always falls through to the **raw platform key** uppercased (e.g. `BIGBASKET`, `BLINKIT`) rather than the nicer `LABELS` display names (`BigBasket`, `Amazon Now`). The CLI plain table (`src/cli.js renderTable`) has the same behaviour — it uses `p.platform.toUpperCase()` directly. The MCP markdown and the verdict lines **do** use the proper labels (`FEES[p.platform]?.label`). Impact: purely visual column headers in the TUI/table; the README's sample banner shows `BIGBASKET`/`ZEPTO`/`BLINKIT` in caps, so the shipped behaviour actually matches the README screenshot — but the `r.labels` lookup in `tui.js` is dead code that signals an intended (never-wired) feature. **Recommendation:** either set `labels: Object.fromEntries(active.map(p => [p, FEES[p]?.label ?? p]))` in `compare.js`, or drop the `r.labels?.` lookup to avoid the misleading dead path.

**Nuance 2 — README "30s–5min" vs test suite "47 tests, no network."** Both are accurate; just note the timing claims refer to live runs (driven by `CALL_TIMEOUT_MS = 120_000` per webcmd query), not the test suite. No conflict.

**Nuance 3 — `test/server.test.js`'s `FAKE_RESULT` carries legacy fields** `feesAsOf`/`feesVerified` that the current `compareBasket` no longer emits (the real shape uses `feesKnown`/`feesConfigured`/`feesMissing`). These stray fields are harmless test fixture leftovers from the removed "invented fees" era described in `src/fees.js`; they don't affect assertions. **Recommendation (optional):** update the fixture to the current envelope for clarity.

**Nuance 4 — `--pincode` is display-only.** Both README and `DEFAULT_PINCODE`/comments make clear the real location source is the browser profile; `pincode` only flows to display. Confirmed, not a discrepancy.

---

## Conclusions & recommendations

1. **The implementation matches its documentation to an unusual degree.** Nearly every design claim in `README.md` and `.claude/skills/basket/SKILL.md` is directly traceable to code and, for the core logic, locked in by regression tests that are explicitly labelled with the real bugs they prevent. The offline suite passes cleanly (47/47).

2. **The honesty-first design is the defining characteristic** and is implemented consistently across all three surfaces via the single `compareBasket()` chokepoint: refuse-don't-guess matching, goods-only fees with no baked numbers, complete-baskets-win + common-subset + coverage guards, and backend transparency in the header.

3. **One real finding to fix:** the dead `r.labels` lookup in `src/tui.js:86` (and the equivalent raw-key uppercasing in `src/cli.js renderTable`) — wire up `labels` in `compare.js` or remove the lookup so the TUI uses the same `LABELS` display names the MCP/verdict surfaces already use (§8 Discrepancy 1).

4. **Minor housekeeping (optional):** refresh the `FAKE_RESULT` fixture in `test/server.test.js` to the current fee-envelope fields (§8 Nuance 3).

5. **Not verifiable in this read-only, offline pass** (and therefore trusted-as-documented rather than observed): the live webcmd path, CDP extraction against real storefronts, adapter generation output under a real `~/.webcmd`, and delivery-location persistence. The extractor/adapter code and the generation logic were read in full and are internally consistent with the envelope contract; `scripts/probe.js` and `scripts/mcp-smoke.js` are the intended tools to validate these live.

---

*Evidence basis: full read of `README.md`, `package.json`, all of `src/**`, `scripts/**`, `test/**`, `src/ui/basket.html`, and `.claude/skills/basket/SKILL.md`; `npm test` executed offline (47 passed). No files were modified; `git status` was clean after the investigation.*
