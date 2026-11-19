# Changelog

All notable changes to compareprice. Dates are YYYY-MM-DD.

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
