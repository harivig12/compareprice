# Second accounts, deals and the offer check (2026-11-19)

Status: **approved 2026-11-19.** Decisions:
- Popup layout option A ("Second account: sign-in popup options").
- Deals section option 1, a compact table grouped by site ("Deals section options").
- Milkbasket: one account searches products; every account (main and extra) is checked for deals.
- **Address:** a signed-in account uses the address already saved on that account. The fallback is `config.location` (Marutham Prestige), or what the user enters in settings. Never overwrite a signed-in account's address.
- **API first, browser as the fallback** (user, 2026-11-19): where a site's API answers a direct call with the account's session, use it (no Chrome per account). Where it refuses or breaks, use the browser tab as today. Which applies per site is decided by the Task 0 probe and recorded in docs/ENGINE.md. BigBasket and Blinkit are known to refuse non-browser clients and stay on the browser.
- Built in the same session (native execution), with one review of the whole branch at the end.

## Why

The user wants to see, every day, the deepest discounts any of the household's accounts can get, such as Milkbasket's ₹1 tomato (MRP ₹78), without paying for it in extra searches. Instamart may price per account, so its basket is worth searching per account. Milkbasket's extra accounts matter only for their own offers.

## Goals

1. **Second (and later) accounts on Instamart and Milkbasket.** Each account has its own Chrome profile, so cookies, site storage and device ids never mix.
2. **Instamart, every account:** the basket is searched per account. The table shows the cheapest price per item, and hovering it shows which account got it, plus the other accounts' prices.
3. **Milkbasket:**
   - **The main account searches the basket's products** (new: Milkbasket is a skipped site today). How it searches is left to the builder: replay the web app's own search call, found in a read-only recon of a real search. If no search call can be captured, fall back to the category catalogue (`fetchProductCategories` → `getCatalogProductList`).
   - **Extra accounts only look for deals** (offer feeds). They never search the product list.
4. **Deals section at the bottom of the compare page.** It lists products at **≥ 80% off MRP** (configurable, `deals.minDiscountPct`, default 80), from all sites and accounts, with any conditions (max 1 per order, minimum basket). Hovering a deal shows the account. Deals are **never counted in totals**.
5. **Offer check without product searches** for Instamart and Milkbasket, every account. It runs with each scheduled run (07:00/10:00/12:00) and from a **Check offers** button.
6. **BigBasket sign-in** (mobile + OTP), optional. If BigBasket shows its bot wall during sign-in, the sign-in stops and searches stay guest.
7. Every site works as today when no account is signed in (guest).

## Non-goals

- Zepto Pass, Super Saver and membership prices (the user dropped them).
- Adding to cart or reading checkout offers.
- Second accounts on Zepto, Amazon or BigBasket.
- The master price list over `product list.md`. That's the next project, designed after this one ships (see the end).

## Anti-goals (failure even if it "works")

- Two accounts sharing a profile, or a device id copied from one to another.
- Phone numbers, OTPs or passwords on disk or in logs. Only masked hints and the name the user typed are kept.
- Burst traffic. Accounts run one after another, never in parallel on the same site.
- A ₹1 deal pulling a site's basket total down.

## Approaches considered

| | Approach | Trade-off | Decision |
|---|---|---|---|
| 1 | **One Chrome profile per extra account** (`<data>/profiles/<site>-<account>/`), launched only for that account's work and closed after it | Real isolation and sessions that survive restarts. Costs a second Chrome launch (~20 s, ~1 GB) while it runs. | **Chosen** |
| 2 | Incognito-style contexts in one Chrome (`Target.createBrowserContext`) | Lighter, but contexts aren't saved to disk, so every restart or idle close means signing in again | Rejected |
| 3 | Swap cookies in the one profile | Site storage and device ids leak between accounts, which is exactly the anti-goal | Rejected |

Popup layout: **A**, accounts listed under each site with "+ Add account" (B, a dropdown, rejected because it hides the other accounts).

## Design

### Accounts

- `<data>/accounts.json` replaces `sessions.json`, migrated on first start:
  ```json
  { "instamart": [ { "id": "main", "name": "Main", "hint": "••••••0494", "loggedInAt": "…", "profile": "chrome-profile" },
                   { "id": "a2", "name": "Amma", "hint": "••••••0789", "loggedInAt": null, "profile": "profiles/instamart-a2" } ] }
  ```
  The main account stays in the existing `chrome-profile`, so current sign-ins keep working.
- Extra accounts are allowed only where `LOGIN_SITES[site].multiAccount` is true (instamart, milkbasket).
- **Pools:** the existing shared pool stays the main one. A small `PoolSet` keyed by profile gives each extra profile its own `BrowserPool` on its own debug port. Extra pools are launched for one step (a sign-in, an Instamart basket search, an offer check) and closed when it ends. The idle closer covers the main pool as today.
- **LoginManager** is keyed by `site + account id`; states, limits (3 OTPs per hour, 30 s gap) and the wrong-account guard apply per account. API:
  - `POST /api/login/start { site, account?, name?, id }`. With no `account`, it's the main account; `name` creates a new one.
  - `POST /api/login/verify { site, account?, otp|password }`.
  - `POST /api/accounts/remove { site, account }`: deletes that profile directory after a confirm in the popup. It isn't allowed for main.
  - `GET /api/login` returns per-site `accounts: [...]`.

### Instamart prices per account

- **`compareBasket()` stays the only place totals are made.** For Instamart it runs the site's search once per signed-in account (one after another) and merges the candidates for each query into one list, each row tagged `account`.
- The existing scorer and price check then pick the cheapest as today, so the chosen product carries `account`. The total is the cheapest per item across accounts, which is honest because each item can be bought from the account that showed it.
- A line also gets `accountPrices: [{ account, name, price }]` for the hover.
- If one account's search fails, that's a `SiteError` on that account only. The others still count, and the failure shows as a partial failure.
- History records each price with its `account` (new nullable column). Trends and ▼/▲ use the cheapest across accounts, as the table does.

### Deals

Two sources, one store table `deals (site, account, product, pack, price, mrp, pct, conditions, url, seenAt, source)`:

1. **From searches (all sites):** any candidate with `price ≤ (1 − minDiscountPct/100) × mrp`, including ones the price check removed as suspect, is recorded as a deal. It's still left out of totals, exactly as today.
2. **From offer feeds (Instamart and Milkbasket, every account), no product search:**
   - **Milkbasket:** `getMegaFlashDeal` → `getMegaFlashDealProducts` (all pages, 15 per page; 36 records seen). Also `getFlashDealsProducts` if it returns items. Fields are listed in the diagnosis doc: `price.price.value`, `price.mrp.value`, `discount.percent`, `weight.text`, `availability.maxQuantity`.
   - **Instamart:** the source is **not known yet**. The builder's first step is a read-only recon of the signed-in Instamart home and offer pages, using the same method as the Milkbasket pass. If no offer feed exists, Instamart deals come only from source 1.
   - Feed calls run **inside that account's tab** (`pageFetch`), replaying the page's own captured request (`_capture.js`), with no hardcoded ids.
- **The page: option 1, a compact table**, below the comparison table.
  - Heading: "Deals · 80%+ off · not in totals · checked HH:MM".
  - Grouped by site, with each site's conditions on its heading line ("max 1 item · basket ₹9+").
  - One row per deal: product · pack, ₹price, ~~₹MRP~~, and a green "% off" pill. The first few rows show, then "+ N more" expands the rest.
  - Hovering a row shows which accounts saw it (names and masked hints) and when.
  - A site with no deals says "No 80%+ deals in the last check (HH:MM)". A "From searches" group lists deals found in basket runs in the last 24 h.
  - A deal not seen in the latest check of that account is dropped from view (kept in history).
  - At 390 px, each row wraps to two lines with no sideways scroll.
- **MCP:** a `deals()` tool returns the same list.

### Offer check

- `checkOffers({ sites, accounts })` per site/account pair, one after another, through the same request budget (`src/limits.js`) as searches.
- It runs after each scheduled basket run, and as its own job from **Check offers** on the page and `POST /api/offers/run`. A Milkbasket offer check costs about 3–5 GraphQL calls per account.
- Failures are `SiteError`s per site and account and show on the Deals section ("Milkbasket · Amma: session expired, sign in again").

### BigBasket sign-in

- Mobile + OTP from its own sign-in sheet, added to `LOGIN_SITES` like the others, with no extra accounts.
- If the page shows an Akamai "Access Denied" or bot wall, the sign-in stops with `blocked` and makes no retry.
- After signing in, searches use the session. If a signed-in search gets 403, the site reports `blocked` as today, and the user can sign out.

## Constraints

AGENTS.md rules apply:
- `compareBasket()` is the only place totals are made.
- Site calls run in the site's tab.
- Every failure is a `SiteError` naming its site.
- Location comes from config.
- No secrets in source, fixtures or logs.
- The UA matches the real Chrome version.
- Be gentle with the live sites.

`npm test` stays offline and green. UI changes get screenshots in `docs/evidence/<date>-ui/` with `noHorizontalScroll`.

## Location

- A signed-in account delivers to the address saved on it. The engine reads it and doesn't overwrite it: location cookies and pickers apply only when the site has no address of its own.
- With no saved address, the fallback is `config.location` (Marutham Prestige, editable in settings).
- Instamart prices from any account count in the total; the user confirmed the accounts share this address.

## API first, browser as the fallback

- For each site and account, the engine tries a direct API call with that account's session (cookies held in memory, read from its profile; never written elsewhere).
- If the site refuses (403, a bot wall, HTML instead of JSON, or `Failed to fetch`), that site falls back to the browser tab for the rest of the run, and the reason is logged.
- The Task 0 probe records which mode each site supports. The AGENTS.md rule "site API calls run inside the site's tab" stays for every site the probe doesn't clear; its exceptions are listed in docs/ENGINE.md.

## Calls made while writing this (open to correction)

- **Request budget stays per site**, shared by that site's accounts: being gentle matters more than speed. At most **3 accounts per site**. Before an Instamart run, the page shows the estimated extra time (accounts × items × the site's gap).
- **Which deals are shown:**
  - Feed deals: the latest offer check of each site and account replaces that pair's feed deals.
  - Search deals: shown for 24 hours from when they were seen.
  - Both are kept in history.
- **Sign out:**
  - The main account clears one site's own cookies and storage in the shared profile (`Storage.clearDataForOrigin` for that site's origins only, so other sites keep their sessions).
  - An extra account is removed together with its profile directory.
- **Order of work:** the backend (accounts, pools, offer check, deals table, BigBasket sign-in) comes first. The Deals section UI waits for its mockup to be approved.

## Left to the builder

File layout inside `src/engine/`, debug ports for extra pools, the exact `accounts.json` migration, SQL for the new column and table, tests and fixtures (scrubbed), and the Instamart offer recon method.

## Next project (not in this design): master price list

Run every line of `product list.md` (about 150 lines, about 200 queries once comma variants like the 10 rice types are expanded) through every site on a slow schedule, to build a base price list. Open questions for then:
- Should comma lists become separate items?
- Which pack size, when none is given?
- How long a run may take (for example 200 queries × 8 sites at 1 per 30 s per site is about 2 hours).
- Should Milkbasket use its category catalogue (`fetchProductCategories` → `getCatalogProductList`) instead of searches?
