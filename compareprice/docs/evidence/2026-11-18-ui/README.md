# UI evidence, 2026-11-18

These screenshots come from headless Chrome over CDP, at a device scale factor of 1. Each capture also measured `document.documentElement.scrollWidth` against `innerWidth`, to check that there is no horizontal scroll.

| File | What | Viewport | scrollWidth ≤ innerWidth |
|---|---|---|---|
| `compare-1280.png` | Compare page after a live native run: 6 items × 6 sites (Instamart, BigBasket, Blinkit, KPN, Zepto, JioMart) at Marutham Prestige 600045 | 1280 | ✅ 1265 ≤ 1280 |
| `compare-390.png` | Same result on a phone, where items turn into cards | 390 | ✅ 390 ≤ 390 |
| `settings-1280.png` | Settings page | 1280 | ✅ |
| `progress-1280.png` | The page opened while that job was running | 1280 | ✅ |
| `docker-compare-1280.png` | Compare page served by the Docker container after its smoke job | 1280 | ✅ |
| `docker-settings-1280.png` | Settings page in Docker, showing the `daily-check` 07:00/09:00/12:00 schedule | 1280 | ✅ |

**What `compare-1280.png` shows**
- **Colours:** the cheapest cell per item is dark green (`#0f5323`), the second cheapest is light green (`#1f3d27`), and the winning basket total is green.
- **Failed site:** JioMart failed every query. It stays in the table with its error kind (`parse`) and appears in "Site problems" with the exact message.
- **Run time and Instamart:** the run took 163 s. Instamart showed "not found" for toor dal because of rate limiting during heavy testing. Later the engine learned to recognise that response (`blocked … rate limited`).

**Changes after these captures**
- The `first seen` history badge was removed from first sightings, because it was noise.
- Badges now only appear once there is a previous low to compare against.

**To regenerate:** start the service and run a comparison, then:

```bash
node scripts/ui-screenshot.js http://localhost:7777/ docs/evidence/2026-11-18-ui/compare-1280.png 1280 800 2500 full
node scripts/ui-screenshot.js http://localhost:7777/ docs/evidence/2026-11-18-ui/compare-390.png 390 844 2500 full
```

The script prints `{ scrollWidth, innerWidth, noHorizontalScroll }` for each capture.
