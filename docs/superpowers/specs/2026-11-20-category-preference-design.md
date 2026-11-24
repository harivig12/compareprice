# Category preference, saved-item fallback, tap tips, optional local AI

Date: 2026-11-20. Status: approved and implemented. The AI section was revised to a free API after the local model measured 57%. See docs/diagnosis/2026-11-20-ghee-laddu-and-category-preference.md.

## Why

- A plain line like "ghee" picked Ghee Besan Laddu (KPN) and Puja Ghee (Milkbasket); "hing" picked Hing Peda. The user's rule: **a generic line gets the raw product first, chosen by category. Sweets, pooja items and packaged foods only come back when the line names them** ("pooja ghee", "ghee laddu", "ghee peda").
- "salt" and "tata salt" show nothing on the basket screen, while the history lookup finds the saved "tata salt 1kg" prices.
- On a phone, many details only appear on mouse hover (product name in history, "was ₹…", account prices, reasons).
- The user wants an optional local AI model for categorising, run as its own container and never part of the search itself.
- Saved data is never deleted. It is reused and re-tagged instead of pulled again (steering, 2026-11-20).

## Goals

1. Save each product's site category with its price row, and use it to prefer the staple over derived products.
2. Answer a line from saved rows of a more specific saved line ("salt" ← "tata salt 1kg") when the matcher accepts them.
3. Tap to see every detail that today needs a hover, with a visible (i) on history prices.
4. An optional AI labeller (free API, key entered in Settings) that labels saved products without a site category, in quiet time, many per call, with saved results.
5. Ship together with the ghee/laddu/puja/peda matcher fix (done, tested, not deployed).

## Non-goals

- No embeddings. Measured on this PC: they gave no gain in matching or categories (see "Evidence"). Immich ML is not used for the same reason.
- No paid APIs. A free API key (Groq/OpenRouter) is optional and used only by the off-by-default labeller (§5).
- No change to the green-shade ranking rule (decision 2026-11-19).
- No re-scraping to fill categories into old rows.

## Anti-goals

- Hiding a correct cheaper match because a site's category is odd: category only **reorders** the confident candidates. It refuses only sweets and pooja on a generic line.
- Calls to the AI container during a search, or the AI being required for anything to work.
- Deleting or rewriting saved rows.

## Approaches considered

| | What | Trade-off |
|---|---|---|
| **A (chosen)** | Rules plus site categories plus saved verdicts. AI is an optional extra container. | No new dependency. 6 of 9 sites send categories; Blinkit, Amazon and Flipkart Minutes rely on word rules (plus AI if switched on). |
| B | Embeddings (MiniLM / multilingual / Immich CLIP) | Measured: laddu and puja ghee land under "oils & ghee", hing peda under sweets or pooja. 300–600 MB RAM, 15–30% category accuracy. Rejected. |
| C | Free cloud LLM (Gemini / Groq) | Free terms in India allow training and human review, and limits changed several times in 2026. Rejected by the user in favour of local. |

## Design

### 1. Site category on every row

Each parser adds `category`: the site's path joined with ` › `, or `null`.

| Site | Source | Example |
|---|---|---|
| BigBasket | `category.tlc_name › mlc_name › llc_name` | Foodgrains, Oil & Masala › Dals & Pulses › Toor, Channa & Moong Dal |
| Instamart | variation `superCategory › category › subCategoryType` | Atta, Rice and Dals › Dal and Pulses › Toor Dal |
| Milkbasket | `category.name › subCategory.name › subCategory.type` | Rice & Pulses › Arhar & Chana dal › Arhar |
| KPN | `primary_navigation_category_l0 › _l1`, id suffix "(1_13)" stripped | Rice, Atta & Dal › Pulses & Dals |
| Zepto | `primaryCategoryName` (› `primarySubcategoryName` when set) | Atta, Rice, Oil & Dals |
| JioMart | `attributes["l3-category"][0]` | Toor Dal |
| Blinkit, Amazon, Flipkart Minutes | none | `null` |

- `scorePlatform` copies `category` onto the line's product.
- `prices` gets a `category TEXT` column (same `ALTER` loop), written by `recordResult`.
- Old rows keep `NULL` and gain it the next time that item is searched anyway.

### 2. Groups and preference (`src/categories.js`, new)

`groupOf(categoryText, productName)` maps to a small fixed set:

- `sweets`: from the category (mithai, sweets, dessert) or from the name (ladoo/barfi/peda/halwa, already in `normalize.js`)
- `pooja`: pooja, puja, religious
- `packaged`: snacks, namkeen, biscuits, chocolates, ready to eat or cook, instant, frozen
- `staple`: everything else

A line **names** a group when its words include that group's trigger words (laddu, peda, sweet, pooja, namkeen, frozen…).

In `pickBest`, among the confident, in-stock candidates:

1. `sweets` and `pooja` are refused unless the line names them. This is the user's rule. It has the same effect as the word rule, so sites without categories behave the same.
2. **Preference order** for the pool:
   - (a) the category this line usually lands in on this site (the most common `category` among this line's visible saved rows, `hidden IS NULL`);
   - (b) `staple`;
   - (c) `packaged`.
   The cheapest is picked from the first non-empty tier. With nothing learned yet, (b) then (c) applies. If only packaged exists (e.g. only frozen sweet corn), it is still returned.
3. A ✕ on a row hides it, so it stops counting toward (a). Learning follows the user's own corrections. No new table: (a) is read from `prices`.

### 3. Saved-item fallback for "Find the cheapest"

When `latestFor(line, site)` finds nothing, look at saved lines that contain **all** of this line's words:

- "salt" ← "tata salt 1kg"
- "tata salt" ← "tata salt 1kg"
- but "cow ghee" ✗ ← "ghee", because the saved line lacks "cow"

Take the newest visible row whose product `matchConfidence(line, product)` accepts with a compatible pack. Mark the cell "saved for 'tata salt 1kg' · <date>".

A more specific new line (the user's example, "cow ghee 1L") never reuses a generic saved line. It shows "no saved price" and goes to Get fresh prices or missing-only. This matches the user's reuse answer (fresh search for cow ghee).

### 4. Tap instead of hover

- One shared tip bubble for the whole page.
- On a touch screen (`pointer: coarse`), tapping any element that has a `title` shows the bubble; tapping elsewhere or pressing Esc closes it. This covers the ~25 existing tooltips without rewriting each.
- Where the element is also a link or a button (product names link to the site, ✕), a separate small **(i)** button shows the tip instead. History-lookup prices always get the (i), as asked.
- The (i) is a real `<button>` with `aria-label="Show details"` and `aria-expanded`; the bubble has `role="status"`. Mouse hover still works on desktop.
- Mock: see the artifact with this doc.

### 5. Optional AI labeller (off by default), revised 2026-11-20

The local model was measured first, as agreed, and did not work out (see "Evidence"): Qwen3 0.6B got 57% right and labelled Puja Ghee and Hing Peda as staples; Gemma3 1B returned one item per batch. So, per the user's fallback, the labeller calls a **free OpenAI-compatible API** instead. No container ships; the user can still point it at a local server later, because Ollama speaks the same protocol.

- **Providers:** presets for Groq (`https://api.groq.com/openai/v1`) and OpenRouter (`https://openrouter.ai/api/v1`), plus "custom" (any OpenAI-compatible base URL). The model name is editable; the preset fills a default.
- **Key:** entered once on the Settings page.
  - It is stored in `<data>/secrets.json` (file mode 600) and never in source, config.json, logs or API answers. The API only says `hasKey` and the last 4 characters.
  - It is sent only to the chosen provider's URL.
- **Check connection:** a Settings button.
  1. It calls `GET {base}/models` with the key, and reports whether the model is listed.
  2. It labels two known titles (Aavin Ghee → staple, Ghee Besan Laddu → sweets) and reports whether the JSON reply was right.
- **Sending products:** only numbered product titles are sent, many per call. **One call per batch**, not one per product, so daily/minute limits aren't hit.
  - Batch size, pause between calls and the daily call cap are read from `<data>/ai.md`, a short markdown file of `key: value` lines that the service creates with defaults and re-reads on every run. Editing that file changes them without a rebuild.
  - Defaults: `batch size: 100` titles (about 3.5k tokens, under Groq's smaller per-minute token limits), `pause seconds: 65`, `max calls per day: 50`.
  - A labelled run of the ~1,200 saved names therefore takes about 12 calls, once.
- **When it runs:** a queue job `trigger: 'ai-labels'`, after the offer check (or 15 min after a schedule when offers don't run). It needs no browser.
  - It labels saved products (any site) that have no site category and no label yet.
  - Results go into `product_groups(product, grp, source, model, labelled_at)`, keyed by product title. Rows are added or re-tagged, never deleted.
- **What a label does:** an AI label only **demotes** a product, it never hides or refuses it, because it can be wrong ("sweet lime" → sweets). Revised after the live run: it demotes only on a line known to be a staple, and never a product already saved for that line (see the diagnosis doc).
  - A product labelled `sweets`/`pooja`/`packaged` sorts after staples when the line doesn't name that group, both on a live search (Blinkit/Amazon/Flipkart candidates whose title was labelled before) and from saved prices.
  - Only staple-labelled rows count toward the learned category.
  - Refusal stays with words and the site category.
- **Eval:** `node scripts/ai-groups-eval.js` sends the 103 hand-labelled titles in `test/fixtures/ai/labels.txt` in one batch to the configured provider and prints accuracy and the misses. The result is recorded in the diagnosis doc. Turning the labeller on stays the user's choice.

## Evidence

- Embedding benchmark on this PC (i5-10310U, 1,187 saved names):
  - MiniLM: 300 MB RAM, 7 s per 500 names, 12/40 categories right.
  - Multilingual models: 600 MB, 11/40 and 6/40.
  - None of them ranked real ghee above the laddu, or real hing above the peda.
- Immich ML (CLIP ViT-B-32 and nllb-siglip) on the same cases:
  - ViT-B-32 labels laddu and puja ghee "edible oils and ghee", and hing peda "pooja".
  - nllb labels puja ghee "sweets" and hing "oils and ghee".
  - The container's RAM went from 120 MB to 2.5 GB.
- To be recorded in `docs/diagnosis/2026-11-20-ghee-laddu-and-category-preference.md`.

## Tests

- **Parsers:** a fixture test per site for `category`. New scrubbed ghee captures for BigBasket and Instamart are taken during the one paced live check.
- **`pickBest`:** laddu and puja refused for "ghee", allowed for "ghee laddu" and "pooja ghee"; learned-category tier; packaged only when nothing else.
- **Store:** `category` column migration; fallback "salt" ← "tata salt 1kg"; no "cow ghee" ← "ghee".
- **UI:** `scripts/ui-screenshot.js` evidence at 390 px and 1280 px, light and dark, `noHorizontalScroll`.

## Calls made after the builder check (mine, open to correction)

1. **Either signal can refuse.** A product is `sweets` or `pooja` if its category **or** its name says so. It is `staple` only if neither does, so a laddu filed under "Oils & Ghee" is still refused for "ghee".
2. **What tier (a) learns from.** It counts only visible rows whose group is `staple` (or the group the line names). It needs at least 2 rows; ties go to the newest. A packaged pick never becomes the learned category, and ✕ removes rows from it.
3. **How `pickBest` gets the learned category.** `pickBest`/`scorePlatform` stay pure. `compareBasket` reads a `prefs[site][query] → category` map from the store once per run (live and cached alike) and passes it in. It is not per account.
4. **`hideRefused` also applies the group rule** to rows that have a site category (not AI labels), and `MATCH_VERSION` is bumped. The rows are marked `no-match`, never deleted.
5. **Where the fallback lives.** It is a separate `store.savedFor(line, site)`, called only by the cached branch of `compareBasket`. `latestFor`, `lookup` and `suggest` are unchanged.
6. **A fallback cell is a saved price:**
   - It counts in the cached total and ranking, through `compareBasket` as now.
   - It is not "missing".
   - Its ▼/▲ badge comes from the source line's history.
   - It is never written under the new line, because cached runs don't record.
7. **How a saved line qualifies.** Its words (`normalizeQuery` + `canonical`) must include all of the line's words, and it must not add a kind word (`addsKind`, e.g. black/rock salt). If the line names a pack, the pack must match; with no pack, any pack qualifies. Among qualifying lines, the one with the fewest extra words wins, then the newest row. `matchConfidence` must still accept the product.
8. **Tier (a) is the exact category path per site.** A site renaming a category simply resets the learning.
9. **What the AI touches, and when it runs.** Superseded by the revised §5. Labels only demote a product, never hide it. It is off by default and runs as the `ai-labels` queue job.
10. **No extra live recon.** Category extraction is tested on the existing fixtures, which already carry the fields (Milkbasket from its catalogue fixture). After the deploy, one normal "ghee" search across your sites checks the reported symptom, like a run you'd start yourself.
11. **Same branch** (`feature/signin-theme-trends-mcp`), on top of the uncommitted matcher fix. No commit unless you ask.

## Left to the builder

- Exact trigger-word lists per group.
- Bubble placement near screen edges.
- The idle-worker batch size, paced to stay light.
