# Working on compareprice

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
- **Every failure is a `SiteError` with a kind and a message that starts with the site id.** Never return `[]` to mean "something broke". `[]` means the site answered and had no match.
- **Keep the UA matched to the real Chrome version** (`matchedUserAgent`). A mismatch makes BigBasket return 403.
- **Totals are goods only** unless the user set fees (`src/fees.js` holds no fee numbers).
- **Location comes from config** (`location.lat/lng/pincode/searchText`). Never hardcode it in a site module.
- **Be gentle with live sites.** Reuse one profile and pace requests. Recon burst traffic got the IP blocked by Akamai and rate-limited by Instamart.

## Tests

- `npm test` runs offline and must stay green. Site parsers are tested against the scrubbed fixtures in `test/fixtures/sites/` (see its README to refresh them).
- `npm run test:live` hits the real sites.
- UI changes: capture evidence with `scripts/ui-screenshot.js` into `docs/evidence/<date>-ui/`, and check `noHorizontalScroll`.
