# Headless Comparison Engine & Deal Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a headless, on-demand quick-commerce and e-commerce price comparison engine in Node.js that queries multiple platforms concurrently, overlays profile-tier perks, tracks master price history, and records/replays test fixtures without opening visible browser windows.

**Architecture:** A modular Node.js engine with an interactive profile manager saving credentials and location to `~/.basket/profiles.json`, an HTTP transport layer with deterministic `RECORD`/`REPLAY` fixture capture, platform adapters for 10 services, a pack-size/multiplier normalizer, a membership shipping calculator, and a price history repository in `~/.basket/history.json`.

**Tech Stack:** Node.js (v20+ ESM), native `fetch` / `undici`, Playwright (silent headless mode for token challenges), standard Node test runner (`node:test`).

**Spec:** [docs/superpowers/specs/2026-11-10-headless-engine-design.md](file:///home/a/Downloads/git/compareprice/docs/superpowers/specs/2026-11-10-headless-engine-design.md)

## Global Constraints
- Node.js ESM (`import`/`export`) throughout.
- Sensitive user state (phone, tokens, lat/long) MUST live strictly in `~/.basket/` (outside git repo).
- No visible browser windows during execution (`--headless=new` or direct HTTP).
- In `RECORD=1` mode, fixtures written to `fixtures/captures/` must scrub authorization headers, cookies, phone numbers, and exact GPS coordinates.
- Do NOT touch existing production code or execute writes until explicitly instructed by the user.

## Review Focus
1. Handling 401/403 or Cloudflare Bot challenge gracefully without crashing comparison.
2. Multipack parsing (e.g., "Pack of 2 x 500g") correctly multiplying base unit quantities.
3. Accurate shipping fee threshold application for Amazon (Prime vs non-Prime) and Flipkart (VIP vs standard).
4. Profile selection picking the lowest net basket price based on membership perks.
5. Deterministic fixture mapping during `REPLAY=1` when network is disabled.

---

### Task 1: Profile & Session Store (`~/.basket/profiles.json`)

**Files:**
- Create: `src/profiles.js`
- Test: `test/profiles.test.js`

**Interfaces:**
- Produces:
  - `loadProfiles(): Promise<ProfileStore>`
  - `saveProfiles(store: ProfileStore): Promise<void>`
  - `getProfile(profileId?: string): Promise<Profile>`
  - `upsertProfile(profile: Partial<Profile>): Promise<Profile>`

- [ ] **Step 1: Write failing test in `test/profiles.test.js`**
  Verify loading, creating, and updating profiles at a custom state path (`~/.basket/profiles.json` or mock env `BASKET_HOME`).

- [ ] **Step 2: Run test to verify failure**
  Run: `node --test test/profiles.test.js` (fails with module not found).

- [ ] **Step 3: Implement `src/profiles.js`**
  Read and write JSON with default profile templates and schema validation.

- [ ] **Step 4: Run test to verify passing**
  Run: `node --test test/profiles.test.js` (passes).

---

### Task 2: HTTP Transport with Deterministic `RECORD` / `REPLAY` Fixture Harness

**Files:**
- Create: `src/http-client.js`
- Test: `test/http-client.test.js`

**Interfaces:**
- Produces:
  - `request(url: string, options: RequestOptions): Promise<HttpResponse>`
  - Sanitization logic to redact auth tokens, cookies, phone numbers, and coordinates.

- [ ] **Step 1: Write failing test in `test/http-client.test.js`**
  Verify that when `RECORD=1`, requests write sanitized JSON to `fixtures/captures/<platform>/<slug>.json`, and when `REPLAY=1`, requests resolve directly from local JSON fixtures.

- [ ] **Step 2: Run test to verify failure**
  Run: `node --test test/http-client.test.js`.

- [ ] **Step 3: Implement `src/http-client.js`**
  Implement HTTP request wrapper around native `fetch`, fixture recorder with PII scrubbing, and fixture reader.

- [ ] **Step 4: Run test to verify passing**
  Run: `node --test test/http-client.test.js`.

---

### Task 3: Pack Size & Multi-Pack Normalizer

**Files:**
- Modify: `src/normalize.js`
- Test: `test/normalize.test.js`

**Interfaces:**
- Produces:
  - `parsePackDetails(rawTitle: string): { packSize: number, packUnit: string, multiplier: number, totalQuantity: number }`

- [ ] **Step 1: Add failing test cases to `test/normalize.test.js`**
  Test multipack expressions like `"Pack of 2 x 500g"`, `"3 x 1L"`, and unit price calculations.

- [ ] **Step 2: Run test to verify failure**
  Run: `node --test test/normalize.test.js`.

- [ ] **Step 3: Enhance regex parser in `src/normalize.js`**
  Add multipack regex detection and compute total normalized volume/weight.

- [ ] **Step 4: Run test to verify passing**
  Run: `node --test test/normalize.test.js`.

---

### Task 4: Platform Adapters (Wave 1: Quick Commerce)

**Files:**
- Create:
  - `src/adapters/blinkit.js`
  - `src/adapters/zepto.js`
  - `src/adapters/instamart.js`
  - `src/adapters/bigbasket.js`
  - `src/adapters/milkbasket.js`
- Test: `test/adapters-wave1.test.js`

**Interfaces:**
- Produces:
  - `search(query: string, profile: Profile): Promise<SearchResult[]>` for each adapter.

- [ ] **Step 1: Write fixture-based tests for Wave 1 platforms**
  Using recorded sample JSON fixtures, assert standardized search outputs (`name`, `mrp`, `sellingPrice`, `packSize`, `inStock`, `url`).

- [ ] **Step 2: Implement Wave 1 adapters using `src/http-client.js`**
  Implement endpoint requests, location payload injection, and response parsing.

- [ ] **Step 3: Run test to verify passing**
  Run: `node --test test/adapters-wave1.test.js`.

---

### Task 5: Platform Adapters (Wave 2: E-Commerce & Fresh)

**Files:**
- Create:
  - `src/adapters/amazon-now.js`
  - `src/adapters/amazon-general.js`
  - `src/adapters/flipkart-minutes.js`
  - `src/adapters/flipkart-normal.js`
  - `src/adapters/kpn.js`
- Test: `test/adapters-wave2.test.js`

**Interfaces:**
- Produces:
  - Standardized search output including calculated shipping fee based on profile membership (`amazon_prime`, `flipkart_vip`).

- [ ] **Step 1: Write fixture-based tests for Wave 2 platforms**
  Verify shipping fee calculation: ₹0 when threshold or membership met, +₹40 when below threshold.

- [ ] **Step 2: Implement Wave 2 adapters**
  Implement search endpoints with membership shipping logic.

- [ ] **Step 3: Run test to verify passing**
  Run: `node --test test/adapters-wave2.test.js`.

---

### Task 6: Master History Catalog & Deal Scoring (`~/.basket/history.json`)

**Files:**
- Create: `src/history.js`
- Test: `test/history.test.js`

**Interfaces:**
- Produces:
  - `recordObservation(item: SearchResult): Promise<DealTag>`
  - `computeDealStatus(currentPrice: number, historyRecord: HistoryRecord): DealStatus`

- [ ] **Step 1: Write tests in `test/history.test.js`**
  Verify median typical price calculation, all-time low tracking, and tagging (`BEST_PRICE_EVER`, `SOLID_DISCOUNT`, `REGULAR`).

- [ ] **Step 2: Implement `src/history.js`**
  JSON read/write with rolling median calculations and deal tags.

- [ ] **Step 3: Run test to verify passing**
  Run: `node --test test/history.test.js`.

---

### Task 7: Orchestrator & Fast REST API

**Files:**
- Create: `src/orchestrator.js`
- Create: `src/api-server.js`
- Test: `test/orchestrator.test.js`

**Interfaces:**
- Produces:
  - `compareBasket(items: string[], profileId?: string): Promise<BasketComparisonResult>`
  - `POST /api/compare` endpoint taking `{"items": ["amul butter 500g", "tata salt 1kg"]}`.

- [ ] **Step 1: Write test for full orchestrator flow**
  Verify concurrent querying of all 10 adapters, pack normalization, and best deal summary.

- [ ] **Step 2: Implement orchestrator and lightweight HTTP API server**
  Implement parallel execution using `Promise.allSettled`.

- [ ] **Step 3: Run test to verify passing**
  Run: `node --test test/orchestrator.test.js`.

