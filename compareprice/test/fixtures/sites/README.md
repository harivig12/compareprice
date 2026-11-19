# Site parser fixtures

These are trimmed search payloads for testing the parsers in `src/engine/sites/*` offline. All of them were captured in the engine's headless Chrome, as a guest, at the configured location: Marutham Prestige, Tambaram, 600045.

**Trimming and scrubbing**
- Arrays are cut to 5 items.
- Analytics, images and tracking fields are dropped.
- Id-like keys (device, session, request, csrf, token) are set to `"scrubbed"`.
- Long opaque base64 blobs are replaced with `"scrubbed"`.
- No cookies, tokens or phone numbers are stored.

| File | Captured | Notes |
|---|---|---|
| `instamart-ok.json` | 2026-11-18, `toor dal 1kg` | `POST /api/instamart/search/v2` |
| `zepto-ok.json` | 2026-11-18, `toor dal 1kg` | `bff-gateway.zepto.com/search-federator-service/api/v1/search`, Krishna Nagar store |
| `blinkit-ok.json` | 2026-11-18, `toor dal 1kg` | `POST /v1/layout/search` |
| `kpn-ok.json` | 2026-11-18, `toor dal` | `__NEXT_DATA__` from `/search?q=` |
| `bigbasket-raw.json` | 2026-11-16, `moong dal` | Raw `listing-svc` response. One row is a ₹1 first-order promo, which the parser must drop. |
| `bigbasket-ok.json` | derived | The same structure as `bigbasket-raw.json`. Brand, name, pack, price and stock values come from the 2026-11-18 live run at 600045. It wasn't captured raw because BigBasket's Akamai blocked the IP after heavy recon. Replace it with a raw capture when convenient. |

To refresh a fixture, run a live search through `BrowserPool` and save the JSON that the site's `search()` parses. Then trim it the same way as above.
