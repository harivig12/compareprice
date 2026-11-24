# Ghee → laddu / puja ghee, "salt" not found, and category preference (2026-11-20)

## Symptoms (reported)

1. Searching "ghee", the history lookup showed KPN at ₹37.5/100 g. That was "Sweet Sanskriti Ghee Besan Laddu Pack 200 g". Milkbasket showed "Shubhkart Darshana Puja Ghee Jar 500 ml" (lamp ghee). Separately, Flipkart's ₹75/100 ml was marked cheapest over the Others ₹40/100 ml.
2. "salt" and "tata salt" showed no saved price on the basket screen. The history lookup found the "tata salt 1kg" prices.
3. On a phone, product names and the other details shown on hover can't be seen.

## Root causes

1. **The matcher didn't know these words.**
   - It only knew the spelling "ladoo". KPN writes "Laddu".
   - "Puja" wasn't a category word.
   - "Peda" wasn't a form word.

   So all three passed as the staple: ghee (KPN, Milkbasket) and hing (BigBasket "Pachak Hing - Peda"). A read-only scan of every saved row found exactly these 4 wrong rows (besan/ghee on KPN, ghee on Milkbasket, hing on BigBasket).

   The Flipkart colouring was a side effect of the KPN row. Its pack was in g and everyone else's was in ml. The page only ranks by rate when every cell uses one unit, so it fell back to pack price, and the 100 ml pouch at ₹75 won.
2. **The cached path matched the line exactly.** "Find the cheapest" (`store.latestFor`) only matched the exact saved line key. The lookup also tries the closest saved line (`store.suggest`), which is why it found the prices.
3. **Hover-only.** About 25 `title` tooltips in `basket.html` had no tap equivalent.

## Fixes

- **Matcher** (`src/normalize.js`):
  - Folds laddu/laddoo/ladu → ladoo, burfi → barfi, pedha → peda and puja → pooja.
  - Adds barfi, peda and pooja as category words, and ladoo/barfi/peda as form words.
- **Categories** (`src/categories.js`, `src/score.js`, parsers, `prices.category`): see docs/ENGINE.md "Categories and product groups". Word sources are in `2026-11-20-category-trigger-words.md`.
- **Saved-line fallback:** `store.savedFor`, used only by the cached branch of `compareBasket`.
- **Tap tips:** a shared bubble and (i) buttons. Evidence is in `docs/evidence/2026-11-20-ui/`; all shots report `noHorizontalScroll: true`.
- **Existing rows:**
  - `MATCH_VERSION` 2 → 3 re-checks saved rows on start, without re-running the outlier pass.
  - Dry-run on a `VACUUM INTO` copy: exactly the 4 rows above became `hidden = 'no-match'`. Rows: 1734 before, 1734 after.

## Options measured and rejected for matching

All runs were on this PC (i5-10310U, 8 threads, no GPU), against the 1,187 saved product titles.

- **Embeddings** (transformers.js 3.8.1, q8; temporary folder, since deleted). No model ranked real ghee above the laddu and puja ghee, or real hing above the peda.

  | Model | RAM | 500 names | Category accuracy (40-row sample) |
  |---|---|---|---|
  | MiniLM-L6 | 300 MB | 7 s | 12/40 |
  | paraphrase-multilingual-L12 | 600 MB | 13 s | 11/40 |
  | multilingual-e5-small | 600 MB | 18 s | 6/40 |

  The multilingual model helped only on some regional names: curd → Thayir and Dahi, coriander → Kothamalli.
- **Immich ML container** (CLIP, already running):
  - ViT-B-32 labelled the laddu and the puja ghee "edible oils and ghee", and the hing peda "pooja".
  - nllb-siglip labelled the puja ghee "sweets" and real hing "oils and ghee".
  - The container's RAM went from 120 MB to 2.5 GB.
- **Local LLM** (Ollama 0.40.16, CPU; container, volume and the 8.5 GB image removed afterwards). Batch sizes 10/20/40 were tried on 103 hand-labelled titles (`test/fixtures/ai/labels.txt`):
  - qwen3:0.6b (523 MB): best 57% at N=10. It labelled Puja Ghee, Hing Peda and frozen corn as staple, sweet lime as sweets, and toothpaste as pooja.
  - gemma3:1b (806 MB): returned one item per batch (≤1% in batches, 35% one at a time).
  - The host was loaded (load average 6–10), so the timings are pessimistic. The accuracy is not.
- **Decision (user, 2026-11-20):** since local didn't work out, the optional labeller uses a free OpenAI-compatible API (Groq / OpenRouter). Only titles are sent, 100 per call, and labels only demote.
  - Accuracy on the 103 titles: run `scripts/ai-groups-eval.js` once a key is saved. **Not measured yet: no key.**

## Verification

- `npm test`: 294 tests, 293 pass, 1 skipped (as before).
- Pre-deploy, on a copy of the live data at port 7788:
  - `/api/lookup?q=ghee` has no laddu or puja row.
  - Cached "salt" and "tata salt" give 7 sites with "saved for “tata salt 1kg”" (BigBasket: "iodised salt", the same product).
  - Cached "cow ghee 1l" is not-cached everywhere.
- Correction: the "interrupted" deploy of the matcher fix had actually completed at 15:42 IST. Its start had already marked the 4 rows `no-match` (`match_version=2`). The final dry run therefore changed 0 rows: 1742 before, 1742 after.

## After deploy (2026-11-20, image 34a30d62, one deploy)

- Startup: `match_version=3`, the `prices.category` column was added, 1742 rows kept.
- `/api/lookup?q=ghee` lists Others, Zepto, JioMart, Instamart, Blinkit, BigBasket and Flipkart Minutes. No laddu or puja row.
- Cached "salt" and "tata salt" give 7/7 sites "saved for “tata salt 1kg”" (BigBasket: "iodised salt" for "salt"). Cached "cow ghee 1l" is not-cached on 7/7 sites.
- `/health` answers on 192.168.0.107:7777. `/data/ai.md` was written with defaults (off); 1,183 titles are waiting for labels.
- **One live "ghee" search** (job 70, manual, through the queue): every site answered.

  | Site | Pick | Price | Site category |
  |---|---|---|---|
  | KPN | KPN Fresh Cow Ghee 500 ml | ₹357 | Edible Oil & Ghee › Ghee |
  | Instamart | Supreme Harvest Cow Ghee 1 ltr | ₹689 | Edible Oils and Ghee › Ghee › Cow Ghee |
  | BigBasket | Heritage Cow Ghee 1 L | ₹728 | Foodgrains, Oil & Masala › Edible Oils & Ghee › Ghee & Vanaspati |
  | Zepto | Godrej Jersey Cow Ghee 1 L | ₹670 | Atta, Rice, Oil & Dals |
  | JioMart | Aavin Ghee 1 L | ₹690 | Ghee |
  | Blinkit | Milky Mist Cow Ghee 1 ltr | ₹724 | none |
  | Flipkart Minutes | Godrej Jersey Ghee Pouch 100 ml | ₹75 | none |

  KPN used to pick the laddu; it now picks real ghee. The categories are now saved, so the learned preference starts from this run.
- Not verified: an AI provider call. No key has been saved yet. Once one is, run `scripts/ai-groups-eval.js` and add the score here.

## AI labeller, live (2026-11-20, after the key was added)

- **Check connection:** ok. `openai/gpt-oss-20b` is listed on Groq, and the ghee/laddu sample came back right (1.2 s).
- **First real call failed.** 100 titles in plain JSON mode gave HTTP 400 `json_validate_failed` with an empty generation: gpt-oss is a reasoning model. Fix: a strict `json_schema` plus `reasoning_effort: "low"`, falling back once to plain JSON mode for providers that refuse those fields. After the fix, 100 titles took 1.9 s and used ~3,000 tokens (Groq free limit: 8,000 tokens/min), with 100/100 labelled.
- **Accuracy** (`scripts/ai-groups-eval.js`, 104 hand-labelled titles, 2 calls): **96/104 (92.3%)**, none missing, **0 sweets/pooja called staple**. The misses:
  - condensed milk ×2 → packaged;
  - Hing Peda → sweets (labelled packaged);
  - Haldiram moong dal namkeen, bread mix, spiced buttermilk, boiled moth beans → staple (labelled packaged);
  - mosquito incense → pooja (labelled nonfood).
- **Labelling job 72:** 1,183 saved titles in 12 calls, 65 s apart (13 min), 0 failures. Result: staple 794, nonfood 256, packaged 123, pooja 8, sweets 2. The container was back to 68 MB afterwards. Job 71, started before the fix, failed with the 400 above and labelled nothing.
- **Second fix, found by auditing the labels against saved picks.** The model calls whole staple kinds "packaged" (garam masala, rasam/sambar powder, honey, bread, rusk, condensed milk, plain makhana). It is also inconsistent within a kind: one brown bread "packaged", others "staple". Demoting on every label would have changed a real pick (Blinkit "brown bread 400g": Britannia → Modern).

  The rule is now narrower:
  1. Labels demote only on a line known to be a staple.
  2. They never demote a product already saved for that line.
  3. A line whose products are mostly "packaged" (honey) treats that as its normal kind.

  Re-measured over every saved line with 2+ products on a site: **0 of 57 picks change**. A simulated new "Ghee Roast Masala Paste" (labelled packaged) is still placed below real ghee.
