# Working on Jhola

Read these first:
- `README.md`: the project overview, and `docs/USAGE.md`: everything about using it
- `docs/ENGINE.md`: how sites are searched, the error kinds, how to add or fix a site
- `docs/API.md`: HTTP and SSE contract
- `docs/OPERATIONS.md`: the running service, data dir, schedules, troubleshooting

History:
- `docs/diagnosis/2026-11-16-api-platforms-failing.md`: recon evidence, endpoints, blocks seen
- `docs/superpowers/specs/2026-11-16-basket-service-design.md`: the design
- `docs/superpowers/plans/2026-11-16-basket-service*.md`: the plan and its status

## Rules that exist for a reason

- **`compareBasket()` (`src/compare.js`) is the only entry point.** The CLI, server, job queue and MCP all call it. Don't compute totals anywhere else.
- **No tokens, cookies or device ids in source.** Sessions live in the headless browser profile (`<data>/chrome-profile`). Copy rotating headers from the page's own request (`src/engine/sites/_capture.js`).
- **Site API calls run inside the site's tab** (`pageFetch`), never from Node `fetch`. BigBasket and Blinkit block non-browser clients.
  - **Exception (user decision 2026-11-19, "API first"):** sites marked `direct: true` (Instamart, Milkbasket), which a recon showed answer direct calls, go through `apiFetch` (`src/engine/direct.js`). That sends the call from Node with the account's own session, read from its tab in memory only, and falls back to `pageFetch` the moment a site refuses. Don't mark another site `direct` without the same recon (docs/diagnosis/2026-11-19-account-offers-zepto-milkbasket.md).
- **Accounts:** each extra account (Instamart and Milkbasket only, at most 3 per site) has its own profile in `<data>/profiles/<site>-<id>` (`src/engine/poolset.js`). Never copy cookies or device ids between profiles. A signed-in account keeps the address saved on it; `config.location` only fills in where it has none.
- **BigBasket has a Chrome of its own** (`<data>/profiles/bigbasket`, user decision 2026-11-24): headless first, headed (Xvfb on a server) after two bot walls in a row (`src/engine/browser-mode.js`). Don't move it back into the shared profile.
- **Deals (80%+ off MRP) are never part of a total** (`src/deals.js`). BigBasket's storefront offers are shown at any discount, in their own groups, and never counted either.
- **Saved prices are never deleted** (user decision 2026-11-20). A wrong match (✕), a refused row or an odd price is marked in `prices.hidden` (`rejected` / `no-match` / `outlier` / `removed`) and every read skips it (`hidden IS NULL`). New reads must do the same.
- **"Others"** (`site = 'others'`, entered by the user with `source` = where bought) is a column for colours, "Best per item" and lookups, but never searched, ranked, totalled or a deal.
- **Generic lines get the raw product** (user decision 2026-11-20). Sweets and pooja items are refused unless the line names them; packaged foods sort after staples. Group words live in `src/categories.js`. Add a title word only if the saved products show no staple using it.
- **AI labels only demote, and only titles are sent** (`src/ai/`). The key lives only in `<data>/secrets.json`; it is never returned, logged or committed.
- **Every failure is a `SiteError` with a kind and a message that starts with the site id.** Never return `[]` to mean "something broke". `[]` means the site answered and had no match.
- **Keep the UA matched to the real Chrome version** (`matchedUserAgent`). A mismatch makes BigBasket return 403.
- **Totals are goods only** unless the user set fees (`src/fees.js` holds no fee numbers).
- **Location comes from config** (`location.lat/lng/pincode/searchText`). Never hardcode it in a site module.
- **Be gentle with live sites.** Reuse one profile and pace requests. Recon burst traffic got the IP blocked by Akamai and rate-limited by Instamart.

## Tests

- `npm test` runs offline and must stay green. Site parsers are tested against the scrubbed fixtures in `test/fixtures/sites/` (see its README to refresh them).
- `npm run test:live` hits the real sites.
- UI changes: capture evidence with `scripts/ui-screenshot.js` into `docs/evidence/<date>-ui/`, and check `noHorizontalScroll`.
