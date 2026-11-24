# Changelog

All notable changes to compareprice are listed here, newest first.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Dates are YYYY-MM-DD.

## [Unreleased]

Nothing yet.

## [1.1.0] - 2026-11-23

A product catalogue so one product has one name, a background sweep that fills in missing prices, a new look, and a how-to guide you can read in the app or on a public page.

### Added
- **Product catalogue** (`src/catalog.js`, `src/catalog-data.js`): about 230 products, each a synonym set with a canonical tag, regional and transliterated names (Hindi, Tamil, Telugu, Kannada), common misspellings, narrower names, brand facets and a category. Basket lines are searched, matched and saved under the canonical tag, so `kismis`, `kishmish`, `khismis` and `dry grapes` are all `raisins`, and `gud`, `vellam` and `jagrey` are all `jaggery`. Lines naming the same product merge into one row, and the page shows what you typed under it.
  - A line is rewritten only when it is the product plus brands, pack sizes and plain modifiers. `britannia good day cashew` stays as typed, and brands are never swapped for another.
  - A listing called "Kishmish" or "Dry Grapes" now matches a search for raisins.
  - On start the store regroups saved prices under the canonical name. Search suggestions also find products by their other names, and `coverage()` reports where a product has saved prices.
- **Catalogue sweep** (`src/sweep.js`): every 5–20 minutes at random, queues 2–4 catalogue products with no saved price (or an old one), at most once a day each. It never starts while another job is running. Configure it in `config.json → sweep` or on the settings page.
- **How-to guide** at `/guide`: website and phone tracks, a "Try it" box backed by `/api/catalog`, the error kinds and troubleshooting.
- **Public landing page**: `npm run build:site` turns the guide into a static site (`site/`), which the Pages workflow publishes to https://harivig12.github.io/compareprice/. The app itself still runs on your own machine.
- `GET /api/catalog`, `GET /api/sweep`, `POST /api/sweep/run`, and the CLI commands `basket catalog` and `basket sweep-now`.
- "Add to Home screen" installs it as an app: a web app manifest, an SVG icon, and 180 / 192 / 512 px PNG icons. The server serves only a fixed list of these static files.
- Repository files: root `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, issue and pull-request templates, CI that runs the offline tests, Dependabot, and a 1280×640 social preview image.

### Changed
- **New "Liquid Glass" look** for the compare, settings and guide pages, from one shared stylesheet (`src/ui/theme.css`). Frosted-glass navigation sits over a soft gradient, and prices and forms are on near-opaque white so they stay readable.
  - Compare page: a shared top bar (Compare, Settings, Guide), an empty state that explains the three steps, site toggles as pills, and messages near the bottom of the screen instead of `alert()` popups. On phones, Find / Fresh / Stop sit in a bar within thumb reach, and the list folds away after a search.
  - Settings page: section shortcuts, a sticky save bar, and the sweep controls with live status and a "Sweep now" button.
- The pages use the device's system fonts and load nothing from third parties, so they work offline.
- `package.json` points at this repository (it still named the old `prototype` repo) and gets a description, keywords and a homepage.

### Fixed
- A site that found nothing showed a ₹0 total. It now shows "—".

## [1.0.0] - 2026-11-19

### Changed
- Renamed the project from `comparebasket` to `compareprice` (folder, npm package name, Docker image `compareprice:latest`, docs).
- The CLI command is still `basket`, and the internal `compareBasket()` entry point keeps its name.

### Included
- Warm headless-Chrome engine with per-site tabs (`src/engine/`).
- Sites: Instamart, BigBasket, Zepto, Blinkit, KPN Fresh, JioMart, Flipkart Minutes, Amazon.
- History-first search, lowest-price tracking, daily scheduler, web UI, HTTP/SSE API, MCP server.
- Offline test suite (`npm test`) and live-site tests (`npm run test:live`).
