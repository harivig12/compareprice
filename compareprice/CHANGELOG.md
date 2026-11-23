# Changelog

All notable changes to compareprice. Dates are YYYY-MM-DD.

## [Unreleased] - 2026-11-23

### Added
- Product catalogue (`src/catalog.js`, `src/catalog-data.js`) with about 230 products, each a synonym set with a canonical tag, regional and transliterated names, misspellings, narrower names, brand facets and a category. Basket lines are searched, matched and saved under the canonical tag ("kismis" / "kishmish" / "dry grapes" → `raisins`). Lines naming the same product merge into one row.
- The store re-keys saved prices under the canonical product on start (`regroup()`). `suggest` also finds products by synonyms, and a new `coverage()` reports where a product has saved prices.
- Catalogue sweep (`src/sweep.js`): random 2–4 product batches at random 5–20 minute gaps, missing products first. Configured in `config.json → sweep`.
- `GET /api/catalog`, `GET /api/sweep`, `POST /api/sweep/run`. CLI commands `basket catalog` and `basket sweep-now`.
- The web page shows what was typed under the canonical item name.

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
