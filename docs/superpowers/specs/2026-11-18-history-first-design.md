# History-first search (2026-11-18)

**Intent.** Searching a list should not hit every site for every item when the price probably hasn't changed. Show the last stored price for each item and site first, tagged with the date (dd/mm/yy). Contact the sites only when the user asks.

**Choice (the user picked option A).** A compare shows stored prices only. Nothing is fetched until the user presses **Get fresh prices**. Items with no stored price show "no saved price"; they are not fetched automatically.

**Approaches considered**
- **A, picked:** history only, then fetch on request. Fewest site hits.
- **B:** auto-fetch only the missing or stale items. Rejected by the user.

## Design

- **Store (`src/store.js`).**
  - Each price row also keeps `pack_size`, `pack_unit`, `mrp` and `url`. Old rows are migrated by adding the columns; their pack is derived from price ÷ unit price.
  - `latestFor(query, site)` returns the most recent confident row, which is the "previous record".
  - `normalizeQuery` also folds pack spelling, so `toor dal 1 kg`, `toor dal 1kg` and `Toor Dal 1 KG` share one history. Existing keys are re-normalized when the store opens.
- **`compareBasket({ cached: true, store })`.**
  - Builds each site's results from `latestFor`, with no browser, then reuses the same scoring and ranking.
  - Each cached line gets `cachedAt`. A line with no row gets status `not-cached`.
  - The result carries `source: 'history'`, `cachedRange: { oldest, newest }` and `uncached: [{ platform, query }]`.
  - The single entry point stays.
- **API.** `POST /api/compare { mode: 'cached' }` answers `200` straight away with the result. It doesn't queue a job and isn't saved as `last-result`. The default mode stays `fresh` (`202` + job), so `run-now`, the schedules and the MCP are unchanged.
- **UI.**
  - "Find the cheapest" makes a cached request.
  - A banner reads: "Saved prices from dd/mm/yy … dd/mm/yy — sites were not contacted. [Get fresh prices]".
  - Every cached cell gets an `as of dd/mm/yy` tag. "Get fresh prices" runs the normal queued job with live progress.
- **CLI.** `basket <list> --cached` gives the same offline view.
- **Milkbasket.** Marked `skip` with the reason (app-only: no web login and no web location). The runner reports `unserviceable` without opening a tab, and the UI greys out the checkbox.

## Non-goals
- Automatic freshness rules.
- Per-item partial refresh. Possible later: the line data already says which items are uncached.
