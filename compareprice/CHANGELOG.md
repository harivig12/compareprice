# Changelog

All notable changes to compareprice. Dates are YYYY-MM-DD.

## [Unreleased] - 2026-11-23

### Added
- Product catalogue (`src/catalog.js`, `src/catalog-data.js`) with about 230 products, each a synonym set with a canonical tag, regional and transliterated names, misspellings, narrower names, brand facets and a category. Basket lines are searched, matched and saved under the canonical tag ("kismis" / "kishmish" / "dry grapes" → `raisins`). Lines naming the same product merge into one row.
- The store re-keys saved prices under the canonical product on start (`regroup()`). `suggest` also finds products by synonyms, and a new `coverage()` reports where a product has saved prices.
- Catalogue sweep (`src/sweep.js`): random 2–4 product batches at random 5–20 minute gaps, missing products first. Configured in `config.json → sweep`.
- `GET /api/catalog`, `GET /api/sweep`, `POST /api/sweep/run`. CLI commands `basket catalog` and `basket sweep-now`.
- The web page shows what was typed under the canonical item name.
- How-to guide at `/guide`, with separate website and phone tracks, a "Try it" box backed by `/api/catalog`, error kinds and troubleshooting.

### Changed
- New "Liquid Glass" look for the compare, settings and guide pages, from one shared stylesheet (`src/ui/theme.css`, served at `/theme.css`). Frosted-glass navigation sits over a soft gradient, and prices and forms are on near-opaque white so they stay readable.
- Compare page:
  - A shared top bar links Compare, Settings and Guide.
  - An empty state explains the three steps.
  - Site toggles are pills.
  - Errors show as messages near the bottom of the screen instead of `alert()` popups.
  - A site that found nothing shows "—" as its total instead of ₹0.
  - On phones, Find / Fresh / Stop sit in a bottom bar within thumb reach, and the list folds away after a search.
- Settings: section shortcuts, a sticky save bar, and catalogue sweep controls with live status and a "Sweep now" button.
- The pages use the device's system fonts and load nothing from third parties, so they work offline.
- "Add to Home screen" works as an app: a web app manifest (`/manifest.webmanifest`), an SVG icon, and 180/192/512 px PNG icons (`/apple-touch-icon.png` for iPhone). The server only serves a fixed list of these static files.

## [1.0.0] - 2026-11-19

### Changed
- Renamed the project from `comparebasket` to `compareprice` (folder, npm package name, Docker image `compareprice:latest`, docs).
- Repository moved to https://github.com/harivig12/prototype under `compareprice/`.
- The CLI command is still `basket`, and the internal `compareBasket()` entry point keeps its name.

### Included
- Warm headless-Chrome engine with per-site tabs (`src/engine/`).
- Sites: Instamart, BigBasket, Zepto, Blinkit, KPN Fresh, JioMart, Flipkart Minutes, Amazon.
- History-first search, lowest-price tracking, daily scheduler, web UI, HTTP/SSE API, MCP server.
- Offline test suite (`npm test`) and live-site tests (`npm run test:live`).
