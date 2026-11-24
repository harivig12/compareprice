# History-first evidence (2026-11-18)

| File | What | scrollWidth ≤ innerWidth |
|---|---|---|
| `cached-1280.png` | **Find the cheapest** on `toor dal 1 kg / sugar 1kg / maida 1kg`, served by the Docker container from saved prices. Re-captured on 19/11/26 with all 7 sites, JioMart and Flipkart Minutes included. Shows the banner, `as of 18/11/26` tags, *no saved price* cells and the greyed-out Milkbasket. | ✅ 1265 ≤ 1280 |
| `cached-390.png` | Same on a phone (cards). | ✅ 390 ≤ 390 |

Verified alongside:
- **Fast, no job:** `POST /api/compare {mode:'cached'}` answered in 0.1 s, and `/api/jobs` showed no new job, so no site was contacted.
- **Bad row pruned:** before the matcher fix, BigBasket's "toor dal" cell was **Bb Popular Moong Dal** ₹119. After the fix the service pruned it at startup ("removed 10 saved price(s)"). BigBasket now shows *no saved price* for toor dal until the next fresh run.

Regenerate:

```bash
SHOT_JS='document.getElementById("items").value="toor dal 1 kg\nsugar 1kg\nmaida 1kg"; document.getElementById("go").click();' \
  node scripts/ui-screenshot.js http://localhost:7777/ docs/evidence/2026-11-18-history-first/cached-1280.png 1280 800 2000 full
```
