# Coupons and card offers in the cart: Zepto and Instamart (2026-11-25)

**Question.** Do the signed-in sites show coupons or card offers, and can Jhola read them?

**Method.** The signed-in profile in headless Chrome (the real UA), one page per site, at the configured address (Krishna Nagar, 600045). One cheap item added to the cart, the cart's offers read, the item removed. **No address was added, nothing was paid and no order was started.** Both carts were empty again afterwards.

## Zepto: reachable, and rich

Add an item (Annapurna Iodized Crystal Salt 1 kg, ₹18 against MRP ₹22), then open the cart. The cart's **Coupons & offers** block has two parts:

- **Coupons** ("View coupons"): four *auto-applied brand add-ons*, none for groceries: 5% off Baidyanath products, ₹1000 off a Fire TV Stick, ₹500 off JBL products, ₹300 off a Philips Air Fryer. Each says "Shop for ₹1 more to unlock". A "Have a code?" box is also there.
- **Payment offers** (tabs UPI, Card, Wallet, PayLater): **54 offers**, every one "Locked" at an ₹18 cart. Each has a code, a minimum order and terms ("Know more"). Minimums seen run from ₹99 (BHIM app cashback up to ₹125, then ₹75) to ₹80,000 (₹6,000 off an iPhone-priced order on some credit cards):
  - ₹199 to ₹399: UPI apps (Tata Neu ₹25 off, Bajaj Pay ₹10, Amazon Pay up to ₹25 cashback, Amazon Pay Later up to ₹100, MobiKwik), plus Indian Bank cards 15% up to ₹120 at ₹299.
  - ₹500 to ₹750: IDFC FIRST debit 20% up to ₹125, RBL / Visa Platinum / YES / DBS credit cards ₹50 to ₹100 off, SBI Visa debit 25% up to ₹200 at ₹599.
  - ₹999 and up: Kotak 10% up to ₹125, IndusInd ₹100 off, weekend-only Federal Bank offers; ₹5000: ₹1,500 off on Axis, SBI and ICICI cards.
  - Some are day-limited (HDFC Mastercard debit: Tuesdays and Thursdays; SBI and IDFC credit: Sundays).
- Other cart facts: delivery fee ₹30, free above ₹99; handling fee ₹10, shown as free; the button says "Add Address to proceed" because no delivery address is saved on this account.

Not read: whether an offer would apply to a real basket. Offers show as locked until the cart reaches the minimum, and applying one needs the payment step, which this check never reaches.

## Instamart: not reachable this way

Add an item from the search page: the page keeps a cart bar ("1 Item, ₹6 saved") and a "Go to Cart" button. The cart page (`/instamart/cart`) then shows **"Something went wrong"**, even though the cart API answers HTTP 200, and "Try Again" does not help. A fresh load of the search page afterwards showed an empty cart, so the add was never saved on the account. It may need a saved delivery address, a headed browser, or a payload the page builds itself; the cart API can't be read with a bare GET (empty body).

## What can be built

- **Zepto payment offers: yes, low risk.** The same read (add one cheap item, open the offers panel, read the list, remove the item) can run at 07:00 and 18:00, or the offers can be read from the API the page itself calls for the panel, which would avoid touching the cart. The cart is changed for a few seconds each time. Needs a decision before building.
- **Zepto coupons:** only brand add-ons for now, mostly non-grocery; low value.
- **Instamart:** needs more recon (headed, with an address saved on the account) before it can be built.
- **BigBasket:** its sign-in was failing on the OTP step; fixed the same day (see CHANGELOG), so its cart can be checked once the account is signed in.

## Follow-up: Zepto offers are now read by the app (2026-11-25, evening)

- **The call behind the panels:** `POST bff-gateway.zepto.com/cfs/api/v1/cart/coupons/fetch-list` with `activeTab` `COUPONS_TAB` or `PAYMENT_OFFERS_TAB`, `cartId`, `storeId` and the position. The answer is one card per offer. No click is needed, only the page's own headers (copied from its `/cfs/` request).
- **An empty cart lists nothing** (0 offers, HTTP 200). The offers are computed for the cart, so one item has to be in it. With a wrong or missing cart id the call fails ("Failed to update cart", HTTP 500). The cart id is stable and lives in `localStorage.cart.state.cartId`.
- **Putting an item in and out** is `PUT /cfs/api/v1/cart` with the item (`id`, `productVariant.id`, `mrp` from a search result, quantity 1) and then with no products. The answer carries `itemQuantityCount`, which the app checks.
- **A live run of the real code** (23 s, 5 paced calls): cart empty before and after, **55 payment offers** and **4 coupons**, all "locked" at an ₹18 cart. The payment minimums start at ₹99 (BHIM app cashback).
- **One lesson on the way:** the first probe's cleanup did not take the item out of the server-side cart (the page showed an empty cart, but offers still came back for ₹18). Only a cart update with no products did. The app therefore verifies the emptying through the cart answer, never through what the page shows.

## Correction (2026-11-25, night): the failures below were the probe's user-agent, not the sites

Earlier in this note, Instamart's cart "failed" ("Cart not found", then "Something went wrong"), and BigBasket's cart page answered "Access Denied". **Both were caused by my probe scripts, not by the accounts or the sites.** A script that drives Chrome over the debugging port sets the real-Chrome user-agent with `Network.setUserAgentOverride`, but that override only lasts while the script's connection stays open. My helper reconnected for every step, so from the second step on the pages saw `HeadlessChrome` in the user-agent: Swiggy's pages errored out, and BigBasket's Akamai walled the cart page. The app itself sets the user-agent once per tab and keeps the connection, so its own tabs were never affected (AGENTS.md already says a user-agent mismatch makes BigBasket return 403). The earlier "Instamart cart is broken for this account" conclusion above is therefore wrong. BigBasket's cart offers still have to be read (carefully, with the user-agent held for the whole run).

## Instamart cart offers, read correctly (2026-11-25, night)

Same signed-in session as the app (swiggy.com/instamart, address Marutham Prestige, Bharathidasan Nagar, Tambaram 600045), one script, user-agent held all the way:

- Entry: `https://www.swiggy.com/instamart?entryId=1234&entryName=mainTileEntry4&v=1`, then the page's own search box (a direct load of `/instamart/search` is not needed).
- Add one item (Tata Salt Superlite 1 kg, ₹71) and open the cart: it loads. The cart page shows "SAVINGS CORNER: Add ₹328 more to get upto ₹100 cashback with APAY20" and a **View all coupons & offers** link.
- **Apply Coupon sheet: 34 coupons.** 1 available at a ₹71 cart (LXMEUPI, Lxme UPI Digital Gold, for female users) and 33 locked ("Add items worth ₹N more to avail this offer"): UPI cashbacks from ₹99 (Paytm UPI, Navi UPI), ₹199 (MobiKwik, BHIM first payment, POP), ₹399 (Amazon Pay Later and Balance up to ₹100, MobiKwik wallet), bank card discounts from ₹299 (Indian Bank 15% up to ₹120) to ₹999 (SBI Visa debit 25% up to ₹300, SBI Mastercard debit ₹150, Axis MyZone 10% up to ₹200), a handful of brand coupons (Arata, plush items, Crossword), and RBL cards on phones and tablets over ₹10,000.
- Each coupon has a code (APAY20, PAYTMUPI10, IDFCDC175 …), a title, the order minimum and terms; the "short by" amount is exactly what the cart lacks.
- The probe item was taken out again with the cart's own "−" button; the page then shows "Your cart is getting lonely". The first cleanup attempt only looked for the wrong text, so the item sat in the cart for a few minutes before it was removed.
- The store showed "Temporarily UNSERVICEABLE: you can still add items and order when the store re-opens" at the time (late evening); cart and coupons work regardless.
- **instamart.in** is Instamart's separate standalone site (same API paths, its own cookies, asks for location and sign-in). It is not needed: swiggy.com/instamart gives the same data on the session the app already has.

## BigBasket (2026-11-25, night)

- The app's BigBasket Chrome (headless, user-agent held by the app) showed the signed-in account with its saved address and **5 items already in the cart**, so nothing was added or removed.
- My probe then opened `/basket/` through a connection without the user-agent override and got **Access Denied** (Akamai). Probably the same cause as above, but it is not proven: the block is real and may last a few hours, and BigBasket's page walls are sensitive to repeat loads. BigBasket's cart offers are **not read yet**.
- A profile *copy* showed a guest: BigBasket's login lives in the running Chrome (session cookies), so it can only be read there.
