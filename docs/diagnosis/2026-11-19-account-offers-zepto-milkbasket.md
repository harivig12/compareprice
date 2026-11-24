# Account-specific offers: Zepto and Milkbasket, signed in (2026-11-19)

**Question:** now that Zepto and Milkbasket are signed in (one account each, same mobile number), does the account see different prices or offers than a guest?

**Method:**
- A read-only pass on a copy of the service's Chrome profile, in `/tmp`. The copy was deleted afterwards.
- One search per site plus the home and account pages, about 1 minute apart.
- Nothing was added to a cart. No personal-detail API answers were printed.
- One Zepto-only live run through the service (job 13).

## Zepto

- **The account has no Zepto Pass.** `/api/v1/pass/overview` returns `membership: null`, `isPassEligible: false` and `userCohort: "R0"`. Zepto Cash is ₹0. The only banner is "Unlock free delivery".
- **Search prices are the same as for a guest.** Every product in the signed-in search has these fields:
  - `zeptoPassPrice: 0`, meaning no Pass price is offered to this account.
  - `superSaverSellingPrice`, equal to `sellingPrice`, with `showSuperSaverPrice: false`.
  - `valueBasedDiscount.nonPassDiscountTier: "TIER_2"` and `nonPassTotalDiscount`, which is simply MRP minus the selling price.
- Example: BestValue Toor Dal 1 kg is ₹154 signed in, the same ₹154 the guest run saved at 15:34.
- **Where account offers would show up:**
  - `zeptoPassPrice` (non-zero for Pass members)
  - `superSaverSellingPrice` / `showSuperSaverPrice`
  - `pricingCampaigns`, `zeptoPassPricingCampaigns`, `promos`, `productCardTags`
  - The engine's `parse()` reads none of these today.
- **Breakage found: signed-in Zepto uses a different search API.**
  - Signed in, the page searches with `POST bff-gateway.zepto.com/user-search-service/api/v3/search`.
  - Before, it used `GET …/search-federator-service/api/v1/search`.
  - The engine waits for the old request to copy its headers, so job 13 failed with `zepto: page never issued a search request to copy headers from`.
  - The v3 answer has the same product shape (`product`, `productVariant`, `sellingPrice`, …), so `parse()` already reads it (41 products). Only the capture and the request need to change.

## Milkbasket

- **Signing in fixed the location.** The catalogue is now the local Chennai hub, with names like "Tomato Desi (Naatu Thakalli)" and "Potato (Urulai Kilangu)", and Aavin milk. Guests were stuck on the default city.
- **Account-specific offers seen:**
  - **Membership expired.** `getUserMembershipInfo` shows `popupType: "EXPIRED"`; it renews at ₹99/month (plans ₹249 for 3 months, ₹449 for 6, ₹849 for a year). Benefits listed: no delivery fee (otherwise ₹15 below ₹99), cashback on subscriptions, "more savings".
  - **A sample deal for this account:** "Choose up to 1 product from the list" (Tomato Desi 1 kg for ₹1, Potato 1 kg for ₹1, and others), with a basket of ₹9 or more.
  - **Subscription cashback** (`getSubscriptionOffer`): 4% for 1 item, 6% for 2 and 8% for 3 or more, or a flat amount per item (e.g. ₹2.2 per 500 ml Aavin milk).
  - **Wallet credit** (`fetchUserBalance`): main and cashback credits. The amount isn't recorded here.
  - **Nothing for this account:** coupons (`getCouponList` is empty), the coupon and reward strips, and the value pass.
  - **Small cart fee:** ₹15 below ₹99 (`getExtraFeeStrips`).
- **Search still isn't wired.**
  - `/search?q=` renders collections, not results.
  - The search bar is a rotating-text element. A scripted click hit the membership banner instead of opening search, so no search GraphQL call was captured.
  - Supporting it needs the search operation captured from a real search.

## What this means

- For these accounts, **search prices aren't account-specific**. The differences are memberships (Zepto Pass, Milkbasket membership), one-off sample deals, subscription cashback and wallet credit, and they mostly apply at checkout. Comparing two accounts would show something only if one of them has a membership or a targeted deal.
- Reading `zeptoPassPrice` / `superSaverSellingPrice` and Milkbasket's membership state would let the table flag "member price" or "offer for this account" without adding to a cart.
- **Needs fixing:** Zepto search is broken when signed in (the v3 POST), and it will fail in the scheduled runs too.

## Milkbasket: where products and deals come from (second pass, 2026-11-19)

Read-only, on a `/tmp` copy of the signed-in profile (deleted afterwards). One home page load; nothing added to the basket.

- **The home page is collections, not the catalogue.** `fetchHomeDashboardSchema` (`cityId`/`hubId` from the account, `page.limit: 999`) returns about 100 panels and 95 `Collection`s. Each collection's products come from a separate `getCollectionProductList({ collection: { id, leafId, listId, displayType } })` call; the one seen returned 7 products.
- **₹1 deals:** `getMegaFlashDeal({ id })`, then `getMegaFlashDealProducts({ listId, showInStockOnly, page: { page, limit: 15 } })`. It holds 36 records (`pages.hasNextPage`). Each item is `{ product, variant }`:
  - `product.price.mrp.value` and `product.price.price.value`
  - `discount.percent` and `dealDiscount`
  - `product.weight.text` (e.g. "1 KG - 1.1 KG Approx")
  - `availability.maxQuantity: 1`
  - Example: Tomato Desi 1 kg at ₹1 against MRP ₹78 (98.72% off).
  - This can be read directly, with no product search.
- **The whole catalogue without searching:** the web app's own scripts define `fetchProductCategories`, `fetchSubcategoriesList`, `getCatalogProductList` and `getCollectionAllProducts` (137 operations in total). A category → subcategory → products walk looks possible. **Not called yet**, so whether it returns everything is still unverified.
- Related offer operations seen: `getFlashDealsProducts`, `getFlashDealDetail`, `getOfferProductDetailList`, `getProductOffers`, `fetchActiveOffers`.

## Instamart sign-in

- Added 2026-11-19. The flow, from the user: swiggy.com → Sign in → Login → mobile → OTP.
- The login config lists both clicks in `open`; each is tried only while the number box is missing.
- Not yet run live. The user is signing in next; after that, compare signed-in and guest prices, and find Instamart's offer and deal sources.

## Task 0 recon: direct API vs browser (2026-11-19, for docs/superpowers/plans/2026-11-19-accounts-deals.md)

Read-only, on a `/tmp` copy of the signed-in profile (deleted afterwards). "From Node" means a plain `fetch` in Node with the account's cookies, plus the headers the page itself sent, all held in memory.

| Site | Call | From Node? | Notes |
|---|---|---|---|
| Milkbasket | `getMegaFlashDealProducts { listId, page, showInStockOnly }` | **Yes**, HTTP 200 | 36 records. Page 2 answered too (15 items). `pages.pages` grew from 2 to 3 as it paged, so the page count isn't reliable: page until `hasNextPage` is false or a page comes back empty. |
| Milkbasket | `fetchProductCategories` (no variables) | **Yes** | 38 categories, 250 subcategories. |
| Milkbasket | `getCatalogProductList { hubId, cityId, page, filters: { subCategoryId } }` | **Yes** | "Arhar & Chana dal" (360) returned 20 products with `price.price.value`, `price.mrp.value`, `discount.percent` and `weight.text`. **The whole catalogue can be read without searching.** |
| Milkbasket | typed search | not captured | The search element opens the membership-plans page while the membership is expired. The app's 137 operations include no product-search query, so search is likely REST or in-app only. **Not needed:** the catalogue covers it. |
| Instamart | `POST /api/instamart/search/v2` (the page's headers and body) | **Yes**, HTTP 200 JSON | Signed-in search works off-browser. |
| Instamart | `GET /api/instamart/home/v2` | **Yes**, HTTP 200 JSON | 23 items in its widgets, with the same `variations[].price.{offerPrice,mrp}` shape as search. The best was 47% off; **none at 80% or more**. No separate deal or offer feed showed up (calls seen: launch, home/v2, im-footer, checkout/v2/cart). |

**Session headers:**
- Milkbasket's GraphQL needs `authorization`, `cityid`, `hubid`, `appversion`, `binaryversion`, `appplatform`, `role`, `mblitetype` and `mbexpress`, plus cookies.
- They come from the page's own request. One page load per account per run captures them, along with the mega-deal id that the home page asks for (`getMegaFlashDeal { id }`).

**Decision for the build:**
- Instamart and Milkbasket run **API first**. One page load per account captures the session, then all data calls go direct.
- If a direct call is refused, fall back to `pageFetch` in the tab.
- BigBasket, Blinkit and the rest stay browser-only, as AGENTS.md says.
- Fixtures added: `test/fixtures/sites/milkbasket-{flashdeal,catalog,categories}.json`, trimmed and scrubbed; image URLs replaced.
- Query documents: `src/engine/sites/milkbasket/queries.js`.
