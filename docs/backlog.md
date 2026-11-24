# Backlog

Ideas agreed for later. Each entry says what it is, why, what it costs, and what was already checked, so it can be picked up without re-research.

## Product images (parked 2026-11-20)

**Why:** a thumbnail next to each pick makes a wrong match (the "ghee" → Ghee Besan Laddu case) visible at a glance, before tapping ✕.

**What the sites already send** (checked in `test/fixtures/sites/`, 2026-11-20):

| Site | Image field | Notes |
|---|---|---|
| Blinkit | `cart_item.image_url` (cdn.grofers.com) | in the search answer we already read |
| Milkbasket | `product.assets.image.url` (file.milkbasket.com) | in the catalogue answer |
| BigBasket, Instamart, Zepto, JioMart, KPN, Flipkart Minutes, Amazon | not seen | our trimmed fixtures dropped the fields. Check on the next normal search; don't run a recon burst for it |

**Plan, in two steps:**

1. **Store the address only.** It is about 100 bytes per product.
   - Add an `image` field to each parser row and copy it in `scorePlatform` (like `category`).
   - Add a `prices.image TEXT` column and write it in `recordResult`.
   - Show a 40 px thumbnail in cells, cards and the lookup, lazy-loaded with `loading="lazy"`, a fixed size so the layout doesn't jump, and `alt=""` because the product name sits next to it.
   - Cost: no search slowdown, because the address arrives with the price and search tabs keep blocking images (`browser.blockMedia`).
   - Risk: the phone loads each picture from the site's CDN, so some may be blocked or expire.
2. **Keep a small local copy (later, only once disk space allows).**
   - Fetch each new picture once, in the quiet slot after the offer check, paced like the AI labeller (a few per minute).
   - Resize to about 160 px WebP and save as `<data>/images/<sha1>.webp`, served by Jhola.
   - Estimate: 15–30 KB each, so about 20–40 MB for the current ~1,200 products.
   - **Never delete pictures.** A changed picture gets a new file, like prices (steering rule).
   - Resizing without a new dependency: use the headless Chrome we already run (draw to a canvas). Avoid `sharp`, which would be a second runtime dependency.

**Tests:** a fixture assertion per site for `image`, a store round-trip, and UI screenshots at 390 / 1280 px with `noHorizontalScroll`.

## Installing on a phone (PWA), checked 2026-11-20

- **Already done:** the manifest, icons (192 / 512 / maskable / Apple) and `theme-color` (Jhola branding).
- **Works today over `http://192.168.0.107:7777`:** Chrome → menu → *Add to home screen* creates a **shortcut** with the Jhola icon. It opens as a browser tab, may carry a small Chrome badge, and only works on the home Wi-Fi.
- **A real install** (own app window, Android app drawer, no Chrome badge, a "WebAPK") needs **HTTPS**. Chrome only installs from a secure origin, and plain LAN `http://` isn't one. Some Chrome versions also still require a service worker. This is setup, not app code:
  - **Tailscale:** `tailscale serve` on the PC gives an `https://<pc>.<tailnet>.ts.net` address that works from anywhere, without opening the app to the internet. Recommended.
  - **Or** a reverse proxy with a local certificate (Caddy/nginx). The phone must trust that certificate, which is fiddly.
- **Code needed only for extras:**
  - a ~20-line service worker, for offline "last result" and to satisfy older install checks;
  - Web Push, for price-drop and deal alerts.

  Both need HTTPS first.
- **A real APK** (Capacitor wrapper) is possible later, for a home-screen widget or "Share to Jhola" from the Zepto or Blinkit apps. The engine stays on the PC either way.

## Speed (suggested 2026-11-20, not started)

- Refresh only stale pairs. Show saved prices at once; re-search only item/site pairs older than a per-item age learned from how often each price really changes.
- Move more sites to direct calls (`direct: true`, like Instamart and Milkbasket). Candidates: Zepto, KPN, JioMart. Each needs the recon AGENTS.md requires first. BigBasket and Blinkit block non-browser clients.
- Compress page and API responses with gzip/brotli (Node's built-in `zlib`), and add `cache-control` for icons and CSS.
- Check the `prices` indexes for `(query, site, hidden)`, used by `latestFor`, `savedFor` and `prefsFor` (fine at 1,742 rows, slower later).
- Docker: see `docs/diagnosis/2026-11-20-docker-disk-cleanup.md`. Each rebuild keeps ~385 MB.

## UI/UX (suggested 2026-11-20)

**Done 2026-11-20: mockup A** (run panel, freshness, age dots, phone tabs). It differs from the mockup in two ways:
1. Cells turn live together at the end of a run, not site by site. The cross-site price check needs every site, and prices are saved at the end.
2. The button is plain **Stop**, because a stopped run saves nothing. Making either work as drawn needs engine changes (per-site saving).

Mockups B and C are still open.

Mockups (SVG source and PNG, light theme, 390 px phone) are in `docs/mockups/`:
- `2026-11-20-a-live-progress-freshness`: per-site progress chips with an estimate, saved prices showing while live ones arrive, "Stop · keep what's done", age dots per site, "Refresh only the old ones", bottom tabs.
- `2026-11-20-b-list-editor-undo-targets`: the list as chips (2× qty bubble, ◆ for no brand), suggestions from saved items, a text-box fallback, ✕ that acts at once with a 10 s Undo bar, and 44 px tap areas.
- `2026-11-20-c-shopping-view-watchlist`: "Best per item" as orders per site (one site vs split toggle, ticks, free-delivery gap, Open ↗ / Copy list), plus a watchlist with a 14-day trend, an alert price and a phone notification preview (needs HTTPS).

Not approved yet. Pick per mockup before building. Re-render the PNGs from the SVGs with headless Chrome (UTF-8 page, scrollbars hidden).

- Shopping view: "Best per item" grouped by site, with a link to each product in its app.
- List editor with item chips and suggestions from saved items.
- Live progress per site (done / searching / waiting, with an estimate). A 2-item × 7-site run took 67 s with no detail shown.
- Freshness per site ("prices 2 h old · refresh").
- Undo for ✕. Rows are only marked `hidden`, so undo is a flag reset.
- Bottom tabs on phones: Compare / Prices / Deals / Settings.
- Tap targets: raise (i) and ✕ from 24 px to 44 px.
- Watchlist with a notification on a new low (needs HTTPS and Web Push, see the PWA section).
