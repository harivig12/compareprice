# BigBasket: deals, tags, coupons and card offers (research, 2026-11-24)

**Question.** How can Jhola get BigBasket's flash deals, and every product under a deal tag or category? Can it see coupons, discounts and card offers?

**Setup.**
- **Browser:** the engine's own headless Chrome and saved profile, with the guest session at the configured address (600045, Tambaram). The page confirmed `_bb_pin_code=600045`.
- **Requests:** read-only. Every API call ran inside the BigBasket tab, as the engine does. About 8 page loads in total, paced several seconds apart.
- **Not done:** no orders, no cart changes, no coupons applied.

**Stopped early.** After those 8 page loads, BigBasket's Akamai bot wall answered **"Access Denied"**, first on a guessed URL (`/sp/bank-offers/`) and then on a product page. Probing stopped there. Blocks like this have cleared within hours before (see `docs/OPERATIONS.md`). Until it clears, a scheduled BigBasket run may report `blocked`.

## Summary

| Question | Answer | Confidence |
|---|---|---|
| Can we pull every product under a deal tag? | **Yes.** Each deal tag is a "storefront" (`/sp/<id>-<slug>/`), and the same listing API the search uses returns all its products, paginated. | Verified live |
| Which deal tags exist? | The home page links to *Deals of the Week*, *Buy More Save More*, *Combos*, *Big Pack Discount* and *The ₹30 Corner*. | Verified live (at 600045, on 2026-11-24) |
| Can we tell what the deal is on each product? | **Yes.** Each product carries a discount label (`35% OFF`, `₹81 OFF`), a deal type (`price_drop` seen), campaign ids, and an apparent per-order limit at the offer price. | Verified live; the limit's meaning is inferred |
| "Flash deals" | **No section named "flash deal" or similar appeared** on the home page or in the deals storefront for this address today. Time-limited prices show up as a `deal_type` on the product (`price_drop` was seen). A dedicated flash-sale storefront may appear on some days or hours; we didn't see one. | Not verified |
| Coupons and bank / card offers | **Not reached.** `/offers/` loaded but showed no offer content to a guest, and the guessed bank-offers address hit the bot wall. These offers usually appear in the cart and at payment, which needs a signed-in account. | Not verified |

## How deal tags work

### 1. Storefronts are the tags

The home page (at 600045) links to these storefronts:

| Storefront | Path |
|---|---|
| Deals of the Week | `/sp/2311728-deals-week/` |
| Buy More Save More | `/sp/2307001-buy-more-save-more/` |
| Combos | `/sp/2306008-combos/` and `/sp/2310049-combos/` |
| Big Pack Discount | `/sp/2310048-big-pack-discount/` |
| The ₹30 Corner | `/sp/2308175-the-30-corner/` |

The ids look like campaign ids, and the banners carry dates in their image names (`…_250723_…`). So the set changes over time. Treat the home page as the source of truth, not a fixed list.

### 2. One API call per page of a storefront

Opening a storefront makes the page call the same listing service our search already uses, with a different `type`:

```
GET /listing-svc/v2/products?type=sis&slug=2311728-deals-week&page=1     (search uses type=ps&slug=<query>)
```

- The response has the same shape as search: `tabs[0].product_info.products[]`. So **the existing BigBasket parser reads it unchanged**.
- Pages hold 20 products. `product_info` gives `page`, `number_of_pages` and `total_count`. *Deals of the Week* had **63 products over 4 pages**.
- `screen_info.title` names the storefront ("Deals of the Week").
- `product_info.show_deal_type: true` marks it as a deal listing.

So "pull every product under a tag" is: read the storefront slugs from the home page, then call `type=sis&slug=<slug>&page=1…number_of_pages`.

### 3. What each product says about its deal

Seen on the 20 products of page 1 of *Deals of the Week*:

| Field (`pricing.discount.…`) | Values seen | Meaning |
|---|---|---|
| `mrp`, `prim_price.sp` | e.g. ₹1249 → ₹813 | MRP and selling price (already used) |
| `d_text` | `35% OFF`, `₹81 OFF`, `""` | The label shown on the card |
| `deal_type` | `price_drop` (2 of 20), otherwise `null` | The kind of deal. Other values probably exist (a flash or limited-time deal may be one), but only `price_drop` was seen. |
| `camp_detail.c` | campaign ids, e.g. `[4575405, 4625134]` | Which offers apply. Products in the same campaign share an id. |
| `camp_detail.d_t`, `d_v`, `c_f` | `percent`, `5`, `81` | Discount type, its value, and the rupees off |
| `camp_detail.narq` | `3` or `9999999` | **Inferred:** the most you can buy at the offer price (3), or no limit |
| `offer_available` | `true` on 6 of 20 | An extra offer is attached |
| `is_best_value` | `true` on 6 of 20 | BigBasket's "best value" flag |
| `sku_badge` | `{type: "oos", label: "sold out"}` | Out of stock, shown with a badge |
| product `bxgy`, `combo` | all `null` on this page | Buy-X-get-Y and combo details live here on other storefronts (not seen populated) |

On this page the discounts ranged from 0% to 40% off MRP. Examples: LuvLap diaper pants ₹299 (MRP ₹499, 40% OFF, limit 3), and Johnson's baby oil 500 ml ₹389 (MRP ₹580, 33% OFF, `price_drop`).

## Coupons and card offers

- **Coupons and bank / card offers are not on product listings.** None of the 20 products carried a coupon code or a bank name. The only offer fields are the campaign discounts above.
- **The `/offers/` page** loaded with a generic title and the word "OFFERS". There was no offer content in the page text or its embedded data for a guest. The content may be drawn by a script after load, or may need an account.
- **Bank and card offers** (instant discounts on a card, wallet cashback) are normally shown in the cart and on the payment step. Both need a signed-in BigBasket account and a cart.
- **No BigBasket session.** The engine's site module deliberately never signs in to BigBasket ("guest only: bot protection"), and the saved profile has no BigBasket account session.
- **Not checked:** coupons and card offers weren't checked. They can't be reached as a guest without adding items to a cart, which this research avoided.

## What can be built (if you want to go ahead)

1. **Deals pull: low risk, ready to build.**
   - **What it does:** a `jhola deals bigbasket` command and an `/api/deals` endpoint. They read the storefront list from the home page, then pull every page of each storefront through `type=sis`, using the existing parser.
   - **What it saves:** the deal fields (label, deal type, campaign, per-order limit) are saved with the price history, so "Deals of the Week" items become searchable and comparable.
   - **Pacing:** once a day, with the same per-site pacing as searches, because about 8 quick page loads triggered the bot wall today.
2. **Offer details in comparisons: low risk.**
   - **What it does:** shows `35% OFF`, "price drop" or "max 3 at this price" next to BigBasket prices in the table and the cards.
   - **Why:** a cheap price with a 3-unit limit isn't the same as a shelf price.
3. **Flash deals: needs more observation, not more code.**
   - **What it does:** log which storefronts and `deal_type` values appear on each daily pull. That shows whether a flash or limited-time storefront appears at certain hours.
   - **Why:** a dedicated flash-deals pull can only be built once one is seen.
4. **Coupons and card offers: needs a decision.**
   - **Option A:** give up on them.
   - **Option B:** let the engine sign in to BigBasket once, using the existing OTP sign-in flow, and read the cart's offer list without placing orders.
   - **Risk of B:** it changes the site module's "guest only" rule, adds a cart action, and raises the bot-wall risk.

## Evidence

- Saved locally (not committed): the home page's API calls and storefront links, the storefront's network calls, and the full page-1 listing response.
- Endpoints seen on the home page: `ui-svc/v2/header`, `ui-svc/v1/category-tree`, `ui-svc/v1/app-data`, `ui-svc/v1/door-data`, `basketService/get`, `order/v1/order/progress-bar?progress_bars=supersaver,delivery-charge` (204 for a guest).
- Endpoint for a storefront: `listing-svc/v2/products?type=sis&slug=<storefront-slug>&page=<n>`.

## Follow-up: first live storefront pull (2026-11-24, 23:15 IST)

Built as `bigbasket.offers` (see docs/ENGINE.md). One pull from the development PC, through the real engine: a fresh BigBasket profile, headless, location 600045 set with the site's picker, then the storefront API only.

- **No bot wall.** One home-page load plus about 26 storefront API calls (20 products a page) over 154 s; the Chrome stayed headless.
- **What came back:** 515 products, 347 with a discount and in stock. 94 of those came from the ended storefront below, leaving 253 on the five real ones.

| Storefront (title from the site) | Discounted items |
|---|---|
| Deals of the Week | 41 |
| Buy More Save More | 72 |
| Combos (both ids under one title) | 67 |
| Big Pack Big Discount | 38 |
| Rs. 30 Corner | 32 |

- **One storefront id has ended.** It answered with a general listing of 60 pages titled just "bigbasket" (festival items). The engine now skips a storefront with that title after one call and notes its slug.
- Discounts on the real storefronts ran from 1.1% to 85%; one item was above 80%.
- `camp_detail.narq` (the most at the offer price) was set on 96 of the 253 items, from 1 to 10 (shown as "max 3 items" and so on); `deal_type` was set on 21.
