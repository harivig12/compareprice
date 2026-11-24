# Main screen evidence (2026-11-19)

Layout: the approved artifact (verdict boxes plus an items × sites table with product names, cheapest dark green, second light green), combined with option 2's clean-ups:
- the list folds into "Your list · N items"
- failed sites become one "N down" column
- a "Site problems" strip at the bottom
- greyed cells are shown but not counted

| File | What | Width check |
|---|---|---|
| `main-1280.png` | **Find the cheapest** from saved prices, plus the **Check a saved price** lookup for "onion" (rate per 100 g by site, with dates and the lowest seen). Greyed cells: "bigger pack than asked · not counted". | ✅ nothing wider than 1280 |
| `main-390.png` | The same on a phone (one card per item, sites sorted by price) | ✅ nothing wider than 390 |

Regenerate (with the service on :7777):

```bash
SHOT_JS='document.getElementById("go").click(); setTimeout(()=>{const q=document.getElementById("q");q.value="onion";q.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter"}))},800)' \
  node scripts/ui-screenshot.js http://localhost:7777/ docs/evidence/2026-11-19-main-screen/main-1280.png 1280 800 3000 full
```

`widest` in the script's output names any element sticking out past the width.
