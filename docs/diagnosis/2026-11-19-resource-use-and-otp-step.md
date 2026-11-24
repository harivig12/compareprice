# Resource use and the missing OTP step (2026-11-19)

Measured on the running Docker service (`basket` container, data in `~/basket-data`), with no job running (`/health` showed `busy:false`).

## 1. Idle resource use

| What | Measured |
|---|---|
| Container memory | ~990 MB (docker stats), steady |
| Container CPU while idle | 49–74% of one core, across 3 samples 3 s apart |
| Chromium | 20 processes, about 1 GB in total (process RSS adds up to ~3.6 GB because shared pages count once per process) |
| Node service | 67 MB |
| Docker image | 1.44 GB (Debian chromium + fonts) |
| Chrome profile on disk | 309 MB (mostly cache) |
| History DB | 44 KB plus a 464 KB WAL (332 rows after about a day) |
| `results/` | 608 KB for 12 runs (about 50 KB per run) |
| Job time | 28–86 s for 12 items × 7 sites (paced by the per-site limiter) |

**Where the idle CPU goes.** Per tab, over 4 s, using CDP `Performance.getMetrics`:

| Tab | Main-thread task time | JS heap | DOM nodes |
|---|---|---|---|
| jiomart.com/ | **361 ms/s** | 65 MB | 11,220 |
| flipkart (search) | 35 ms/s | 56 MB | 1,334 |
| swiggy (instamart search) | 32 ms/s | 20 MB | 3,581 |
| kpnfresh.com/ | 28 ms/s | 29 MB | 1,432 |
| bigbasket.com/ | 20 ms/s | 54 MB | 10,097 |
| milkbasket.com/login | 18 ms/s | 31 MB | 840 |
| zepto (search) | 5 ms/s | 17 MB | 777 |
| blinkit (search) | 3 ms/s | 26 MB | 1,213 |

**Conclusion.**
- The Node code is light: 67 MB, about 0% CPU, SQLite in kilobytes.
- The cost is the **warm browser left open between runs**. Eight live store pages keep running their carousels, analytics and polling. JioMart's home page alone uses about a third of a core.
- Runs happen three times a day and take about a minute each, so for roughly 23 h 57 m a day this is pure waste.
- The Milkbasket login tab is still open from the attempted sign-in, even though the site is skipped for searches.

**Fix (planned, Task 6 in `docs/superpowers/plans/2026-11-19-signin-theme-trends-mcp.md`):**
- When the job queue has been empty for 5 minutes, close Chrome.
- The next job relaunches it (about 2 s) and re-warms the needed tabs in parallel (about 10–25 s).
- Cookies, location and sign-ins are in the on-disk profile, so nothing is lost.

## 2. OTP step never appeared (Milkbasket)

Found by reading the inputs, buttons and text of the service's own Chrome tab (`milkbasket.com/login`):
- **The number was entered correctly, and the OTP was sent.** The page reads "Verify Your Number · We have sent an OTP to your phone. +91-9711020494".
- **The OTP screen has 4 `tel` boxes:** the first with `maxlength=4`, the other three with `maxlength=1`.
- **`LOGIN_SITES.milkbasket.otpInput` required 4 or more boxes with `maxlength="1"`.** It evaluated to `false` on this page. So `startLogin` waited 15 s, threw `timeout … no OTP box appeared`, and the popup stayed on the number screen with that error.
- **No log lines were written** because the login flow doesn't log, so nothing showed in `docker logs`.

**Fix (planned, Task 1):**
- Detect the OTP screen by any of: the page text ("sent an OTP", "Verify Your Number", "Enter OTP"), 4 or more short `tel`/number inputs, or `autocomplete=one-time-code`.
- Type the digits as real key events into the first box, then check that all the boxes are filled.
- The popup switches to the OTP box as soon as Send OTP is clicked.
- Log every step with the number masked.

## 3. Amazon sign-in page (checked without submitting)

- `amazon.in/ap/signin` redirects to `/ax/claim`: "Sign in or create account · Enter mobile number or email · Continue".
- The existing selectors find both the box (`#ap_email_login`) and Continue.
- The page after Continue depends on the account: password, OTP or "create account". It is handled as described in Task 1 of the plan.
