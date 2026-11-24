# Category preference, saved-item fallback, tap tips, AI labeller: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A generic line ("ghee") gets the raw product first by category. "salt" answers from saved "tata salt 1kg". Every hover tip opens on tap. An optional free-API labeller fills in groups for sites without categories.

**Architecture:**
- Parsers keep the site's category. `src/categories.js` turns a category plus a title into a group.
- `pickBest` refuses sweets/pooja that the line doesn't name, and orders the rest by tier: learned category, then staple, then packaged/AI-demoted.
- The store saves `category`, learns per line, and offers `savedFor` for the cached path.
- The UI gets one shared tip bubble.
- `src/ai/` labels saved titles in batches through an OpenAI-compatible API, with settings in `<data>/ai.md` and the key in `<data>/secrets.json`.

**Tech Stack:** Node 22 ESM, `node:sqlite`, `node:test`, plain HTML/JS. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-20-category-preference-design.md`. Word lists: `docs/diagnosis/2026-11-20-category-trigger-words.md`.

## Global Constraints

- One runtime dependency (`@modelcontextprotocol/sdk`). Add none.
- Saved data is never deleted. Mark it `hidden`, re-tag or add rows.
- Only SAFE title words refuse. CAT words only match inside a site category path. DROP words are never used. All three lists come from the trigger-words doc.
- AI labels only demote. They never refuse or hide.
- Only product titles go to the AI provider. The key is never logged, returned or written outside `<data>/secrets.json` (mode 600).
- `npm test` stays green offline. No live site calls in tests.
- No deploy until every task is done. One rebuild and redeploy at the end (user decision).

## Review Focus

1. **"sweet corn", "sweet lime", "mysore masoor dal", "hing" (Patanjali Peda), "frozen peas" for query "peas".** None of these may be refused by title words. The tests go in Task 1.
2. **A category path containing "sweet" for a staple** (e.g. an Instamart "Sweet Corn" leaf). Only whole category words from the CAT list count, and the line's own words always win. Test in Task 1.
3. **"salt" when a saved "black salt" or "rock salt" line exists.** It must not borrow those. Test in Task 4.
4. **The AI provider is unreachable or returns bad JSON or too few items.** The job ends with an error message, labels nothing wrong, and search is unaffected. Test in Task 6.
5. **Tapping a tip on a phone that is also a link** (product name). The link still opens and the (i) shows the tip. Checked in Task 5's screenshot step.

---

### Task 1: Groups and title rules (`src/categories.js`)

**Files:**
- Create: `src/categories.js`
- Modify: `src/normalize.js` (the PROCESSED_FORMS/CATEGORY sweets words already added become imports from categories.js)
- Test: `test/categories.test.js`, `test/matching.test.js`

**Interfaces:**
- Produces:
  - `GROUPS = ['staple','packaged','sweets','pooja']`
  - `titleGroup(name: string): 'sweets'|'pooja'|'packaged'|null`, from SAFE title words and phrases
  - `categoryGroup(path: string|null): group|null`, from CAT words matched as whole words in the path
  - `namedGroups(query: string): Set<group>`, the groups the line itself names, from the same words plus the CAT words
  - `groupOf({ name, category, aiGroup }): { group, source: 'category'|'title'|'ai'|'default', refusable: boolean }`. `refusable` is true only for sweets/pooja from title or category.
- `normalize.js` keeps refusing the sweets words it refuses today. No behaviour change there.

- [ ] Write the tests:
  - `titleGroup('Sweet Sanskriti Ghee Besan Laddu Pack 200 g') === 'sweets'`
  - `titleGroup('Shubhkart Darshana Puja Ghee Jar 500 ml') === 'pooja'`
  - `titleGroup('Haldiram Aloo Bhujia 400 g') === 'packaged'`
  - `titleGroup(x) === null` for 'Sweet Corn 2 pc', 'Sweet Lime (Mosambi) 1 kg', 'Patanjali Pachak Hing - Peda 100 g', 'Frozen Green Peas 500 g', 'BB Royal Organic Red Masoor Dal / Mysore Paruppu 1 kg', 'Gulab Filtered Groundnut Oil 1 L', 'Deepam Gingelly Oil 1 L'
  - `categoryGroup('Snacks & Branded Foods › Indian Mithai') === 'sweets'`
  - `categoryGroup('Foodgrains, Oil & Masala › Edible Oils & Ghee › Ghee & Vanaspati') === null`
  - `categoryGroup('Fruits & Vegetables › Exotic › Sweet Corn') === null`
  - `categoryGroup('Pooja Needs › Agarbatti') === 'pooja'`
  - `categoryGroup('Frozen Veg') === 'packaged'`
  - `namedGroups('ghee laddu')` has 'sweets'; `namedGroups('pooja oil')` has 'pooja'; `namedGroups('ghee').size === 0`
  - `groupOf({ name: 'Aavin Ghee 1 L', category: null })` → `{ group: 'staple', source: 'default', refusable: false }`
- [ ] Run `node --test test/categories.test.js`. Expect FAIL (module missing).
- [ ] Implement it. Words are lowercase arrays copied from the trigger-words doc tables (SAFE → title, CAT → category). Match whole words or phrases after the same tokenising as `normalize.js` (`[^a-z0-9]` → space). A category word "sweet" only counts as `sweets` when the path also lacks `corn|lime|potato` (the doc's counterexamples).
- [ ] Run `npm test`. Expect all green, including the existing matching tests.

### Task 2: Parsers keep the site category

**Files:**
- Modify: `src/engine/sites/{bigbasket,instamart,milkbasket,kpn,zepto,jiomart}.js` (each `parse`/`productRow`), `src/engine/sites/_dom.js` (keep `category` if present), `src/score.js` (`scorePlatform` copies `category`)
- Test: `test/engine-sites.test.js`

**Interfaces:**
- Produces: each row gains `category: string|null`, with the path parts joined by `' › '` and empty parts dropped. The line product gains `category`.

- [ ] Write the tests. One assertion per site on the first fixture row:
  - BigBasket: 'Foodgrains, Oil & Masala › Dals & Pulses › Toor, Channa & Moong Dal'
  - Instamart: 'Atta, Rice and Dals › Dal and Pulses › Toor Dal'
  - Zepto: 'Atta, Rice, Oil & Dals'
  - Milkbasket catalogue: 'Rice & Pulses › Arhar & Chana dal › …' (use the fixture's first row values)
  - KPN: 'Rice, Atta & Dal › Loose Provisions' or 'Rice, Atta & Dal › Pulses & Dals', with the id suffix stripped
  - JioMart: 'Toor Dal'
  - Blinkit, Amazon and Flipkart Minutes rows: `category === null`
- [ ] Run them. Expect FAIL.
- [ ] Implement the field paths listed in the spec §1 table. KPN strips `/\s*\(\d+_\d+\)$/`.
- [ ] Run `npm test`. Expect green.

### Task 3: Preference in `pickBest`

**Files:**
- Modify: `src/score.js`
- Test: `test/ranking.test.js`

**Interfaces:**
- Consumes: `groupOf`, `namedGroups` (Task 1).
- Produces:
  - `pickBest(query, products, qty = 1, prefs = {})`. `prefs = { category?: string, aiGroups?: Map<string,group> }`, where the map key is the trimmed product name.
  - `scorePlatform(platform, items, resultsByQuery, feeConfig, prefsBySite = {})` with `prefsBySite[query]`.

Logic, applied after the existing `confident`/`plausible` pools are built and before sorting:
1. Drop candidates whose `groupOf` is refusable and whose group isn't in `namedGroups(query)`. If that empties the pool, the status becomes `no-match`.
2. Tier = 0 if `prefs.category` equals the row's category. Tier = 1 if the group is staple (or a named group). Tier = 2 otherwise (packaged, or an AI-demoted group the line doesn't name).
3. Keep only the lowest tier present, then the existing `fits`/`byValue` order.

- [ ] Write the tests:
  - The ghee laddu (category 'Snacks & Branded Foods › Indian Mithai', ₹75 for 200 g) and Aavin Ghee 1 L (₹690) for "ghee" → Aavin.
  - "ghee laddu" with the same two → the laddu.
  - A Blinkit "Shubhkart Puja Ghee" (no category) for "ghee" → refused by title.
  - A frozen sweet corn (category 'Frozen Veg') plus loose sweet corn for "sweet corn" → loose.
  - Frozen only → frozen, status 'ok'.
  - `prefs.category` 'Dals & Pulses' beats a cheaper 'Organic Staples' toor dal.
  - With `aiGroups` mapping a Blinkit title to 'packaged', the staple title wins even though it costs more.
  - Existing ranking tests unchanged.
- [ ] Run. Expect FAIL.
- [ ] Implement it.
- [ ] Run `npm test`. Expect green.

### Task 4: Store (category column, learned prefs, `savedFor`, hideRefused) and wiring in `compareBasket`

**Files:**
- Modify: `src/store.js`, `src/compare.js`, `src/ui/basket.html` (cell note "saved for “X”")
- Test: `test/history-first.test.js`, `test/store.test.js`

**Interfaces:**
- Produces:
  - `prices.category TEXT` (ALTER loop), written by `recordResult` from `line.product.category`.
  - `store.prefsFor(queries: string[], sites: string[]): Record<site, Record<query, {category?: string}>>`. This is the most common non-null category among the line's visible rows whose `groupOf` is staple or a named group. It needs at least 2 rows; ties go to the newest.
  - `store.aiGroups(): Map<string, group>` (from Task 6's table; an empty map until then. The table is created here).
  - `store.savedFor(query, site): row|null`. It runs only when `latestFor` is null. Candidate lines are visible queries whose `normalizeQuery` + `canonical` word set includes all the line's words, minus pack tokens unless the line names a pack (then the pack must equal). Lines that `addsKind(query, savedLine, savedLine)` are skipped. The fewest extra words win, then the newest. It returns `latestFor(savedLine, site)` with `savedFrom: savedLine`, or null when `matchConfidence(query, {name}).refused` or the score is below the threshold.
  - `hideRefused` also hides rows whose stored category gives a refusable group the query doesn't name. `MATCH_VERSION = 3`.
- `compareBasket`:
  - computes `prefs = store?.prefsFor?.(queries, active)` and `aiGroups = store?.aiGroups?.()` once, and passes them to `scorePlatform`;
  - in the cached branch, uses `store.latestFor(...) ?? store.savedFor?.(...)` and sets `line.savedFrom` when used;
  - for `cachedHistory` on a `savedFrom` line, uses the source line.

- [ ] Write the tests:
  - "salt" ← "tata salt 1kg": status ok, price 19, `savedFrom` 'tata salt 1kg'.
  - "tata salt" ← "tata salt 1kg".
  - "salt" with only "black salt" saved → not-cached.
  - "cow ghee 1l" with only "ghee" saved → not-cached.
  - "salt 2kg" with only "tata salt 1kg" saved → not-cached.
  - `category` round-trips through `recordResult` → `latestFor` (also add `category` to the `latestFor` row).
  - `prefsFor` returns the majority staple category and ignores a single row.
  - A `hideRefused` row with category '… › Indian Mithai' under "ghee" → hidden 'no-match'; the row count is unchanged.
- [ ] Run. Expect FAIL.
- [ ] Implement it. In basket.html, add the cell note `saved for “${l.savedFrom}”` next to "saved <when>".
- [ ] Run `npm test`. Expect green.

### Task 5: Tap tips (mockup approved)

**Files:**
- Modify: `src/ui/basket.html`, `src/ui/theme.css`, `src/ui/settings.html` (if it has titles)
- Evidence: `docs/evidence/2026-11-20-ui/`

**Interfaces:**
- Produces:
  - one `#tip` bubble element (`role="status"`)
  - `showTip(anchor, text)` and `hideTip()`
  - `<button class="info" type="button" aria-label="Show details" aria-expanded="false" data-tip="…">i</button>`

Behaviour:
- With `matchMedia('(pointer: coarse)')`, a delegated click on `[title]` that isn't a link or button calls `showTip`.
- `.info` buttons call `showTip` on every device.
- A click outside, Esc or scrolling hides it. Only one bubble shows at a time.
- History lookup rows and basket cells get `.info` holding the joined tip text (product, was ₹…, account prices, dropped reasons, saved for/when).
- Desktop `title` hover stays.

- [ ] Add the bubble, the handlers and the `.info` buttons in `cellHtml`, the phone cards and the lookup rows.
- [ ] Run `npm test` (server tests render the page).
- [ ] Capture screenshots with `node scripts/ui-screenshot.js` at 390 px and 1280 px, light and dark: the lookup "ghee" with a bubble open, and a basket cell with a bubble open. Save them to `docs/evidence/2026-11-20-ui/`. `noHorizontalScroll` must be true.

### Task 6: AI labeller (free API)

**Files:**
- Create:
  - `src/ai/settings.js`: `<data>/ai.md` read/write and `<data>/secrets.json`
  - `src/ai/label.js`: request building and parsing
  - `src/ai/job.js`: `runAiLabels`
  - `scripts/ai-groups-eval.js`
- Modify:
  - `src/store.js`: `product_groups` table, `unlabelled(limit)`, `setGroups(list, model)`
  - `src/service.js`: the `ai-labels` trigger, enqueued after an offers job finishes, or 15 min after a schedule when no offers job is queued
  - `src/server.js`: `GET/PUT /api/ai` and `POST /api/ai/check`
  - `src/ui/settings.html`: an "AI labels (optional)" section
  - `docs/API.md`, `docs/OPERATIONS.md`, `README.md`
- Test: `test/ai.test.js`

**Interfaces:**
- `readAiSettings(dataDir): { enabled, provider, baseUrl, model, batchSize, pauseSeconds, maxCallsPerDay }`. It parses `key: value` lines from `ai.md`. If the file is missing, it writes the defaults: `enabled: no`, `provider: groq`, `base url: https://api.groq.com/openai/v1`, `model: llama-3.1-8b-instant`, `batch size: 100`, `pause seconds: 65`, `max calls per day: 50`.
- `writeAiSettings(dataDir, patch)` keeps unknown lines and comments.
- `readKey(dataDir)` / `saveKey(dataDir, key)` use mode 0o600. `keyHint(key)` returns `'••••' + last4`.
- `buildRequest(titles: string[], model)` returns an OpenAI chat body:
  - `temperature: 0`
  - `response_format: { type: 'json_object' }`
  - a system prompt that defines staple/packaged/sweets/pooja/nonfood (text from the design §5 plus the benchmark prompt, without test-item examples)
  - a user message of numbered titles
- `parseReply(json, n): Array<group|null>` checks every index and the group names. Bad or missing entries become null.
- `labelBatch({ titles, settings, key, fetchImpl }): Promise<Array<group|null>>` POSTs `{base}/chat/completions` with `Authorization: Bearer`.
- `checkConnection({ settings, key, fetchImpl })` returns `{ ok, modelListed, sample: { ok, got }, error }`.
- `runAiLabels({ store, dataDir, fetchImpl, sleep, now, log })` returns `{ labelled, calls, error }`. It stops at `maxCallsPerDay` (counted in the `meta` key `ai_calls:<date>`) or when nothing is left, and pauses `pauseSeconds` between calls. `nonfood` is stored too, and counts as `packaged` for demotion.

- [ ] Write the tests, with a fake fetch:
  - Defaults are written to `ai.md`, and an edited `batch size: 40` is read back.
  - The key file is mode 600, and `GET /api/ai` never contains the key.
  - 230 unlabelled titles with `batch size: 100` → 3 calls, 2 sleeps of 65 s (fake sleep), 230 rows in `product_groups`.
  - Bad JSON → `{ error }`, 0 rows.
  - A reply missing items → only valid indices are stored.
  - `maxCallsPerDay: 1` → 1 call.
  - Only titles appear in the request body (assert the body has no `site`, `price` or `url`).
  - `checkConnection` → ok / not ok.
- [ ] Run. Expect FAIL.
- [ ] Implement it. The Settings section has: provider select (Groq / OpenRouter / Custom), base URL, model, key (password field, write-only, shows the hint), "Save" and "Check connection", plus a note that only product titles are sent and that batch settings live in `<data>/ai.md`.
- [ ] Run `npm test`. Expect green.

### Task 7: Docs, one deploy, verification

**Files:**
- Create: `docs/diagnosis/2026-11-20-ghee-laddu-and-category-preference.md` (the evidence: reproduction, embedding/CLIP/Ollama measurements, dry run, after-deploy check)
- Modify: `docs/ENGINE.md` (category field, groups), `docs/API.md`, `docs/OPERATIONS.md` (ai.md, secrets.json, ai-labels job, MATCH_VERSION), `README.md`, `CHANGELOG.md`, `AGENTS.md` (rule: AI labels only demote; only titles sent)

- [ ] Write the docs.
- [ ] Run `npm test` (offline). Expect all pass.
- [ ] Dry-run the startup clean-up on a `VACUUM INTO` copy of the live DB. List the changed rows; the row count must be unchanged.
- [ ] Rebuild and redeploy once, keeping the LAN port: `docker build -q -t compareprice:latest . && docker rm -f basket && docker run -d --name basket --restart unless-stopped -p 7777:7777 -v /home/a/basket-data:/data -e TZ=Asia/Kolkata --shm-size=1g compareprice:latest`
- [ ] Verify the reported symptoms on the live service:
  - `/api/lookup?q=ghee`: no laddu or puja row.
  - Cached "ghee", ranked with the page rule: no laddu or puja.
  - Cached "salt" and "tata salt" return the saved Tata rows with `savedFrom`.
  - Cached "cow ghee 1l" is not-cached.
  - `/health` on 192.168.0.107.
- [ ] Run one normal live "ghee" search across the configured sites (paced, through the queue, like a user's run). Record each site's pick and its category in the diagnosis doc.
- [ ] Do not commit unless the user asks.
