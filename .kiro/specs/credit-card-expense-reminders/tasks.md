# Implementation Plan: Credit Card Expense Reminders

## Overview

This plan builds the two-part system from the design: a native Flutter Android app (offline-first local tracker, notification scheduler, sync engine) and a NAS-hosted backend plus responsive accessible HTML dashboard. Work starts with the shared JSON data contract and the pure domain layer (validation, totals, recurrence, merge/reconcile), each covered by property-based tests that encode the design's Correctness Properties. Only after the domain is proven correct do we add I/O boundaries: Drift/SQLite storage, repositories, the notification scheduler, Flutter UI, the sync transport (REST + LAN peer), export/import, auth/encryption, and finally the NAS server and dashboard. Each step builds on the previous and ends by wiring new code into the existing app, so no code is left orphaned.

Where the design permits reuse, we adapt the MIT-licensed Card-Nudge `Reference_Project` (UI screens, card/reminder domain models, and `flutter_local_notifications` wiring) rather than building from scratch, while replacing its Hive+Supabase data/sync layer with this design's Drift/SQLCipher store and NAS-container sync. The sync engine, totals/per-card breakdown, and NAS dashboard remain original.

Resolved design decisions are implemented directly (no open framing): the local store is **Drift/SQLite + SQLCipher**; the NAS backend is a **single Docker container** serving the REST API + static dashboard with bind-mounted volumes; the month-wise comparison is an **accessible card-wise bar chart** with a data-table fallback. Genuinely-open items are implemented with the design's recommended defaults, kept minimal and parameterized behind a single configuration or interface so the default can be swapped without rework. Such tasks are tagged **[Open Decision #N]**.

- App language/framework: Flutter (Dart), Android target — fixed by Req 1.1.
- Server runtime: Node/TypeScript single Docker container serving the REST API + static dashboard, with bind-mounted `/data/db`, `/data/json`, `/data/backups`, `/certs` volumes (resolved; only the specific NAS product remains a host note).
- Local store: Drift (SQLite) + SQLCipher (resolved).
- Dashboard chart: accessible card-wise bar chart + data-table fallback (resolved; only the specific chart library remains a minor note).
- Property tests use Dart `test` + a property library (e.g. `glados`/`fast_check`-style generators) for the app domain, and a JS/TS property library (e.g. `fast-check`) for the server/shared domain. Minimum 100 iterations per property.

## Tasks

- [ ] 1. Establish repository layout and shared JSON data contract
  - [ ] 1.1 Scaffold project structure
    - Create `app/` (Flutter), `server/`, `server/dashboard/`, `shared/`, and `docs/` under `/home/a/Downloads/git/dashboard`
    - Add `server/Dockerfile` (builds the single NAS container image) and a root `docker-compose.yml` that bind-mounts `/data/db`, `/data/json`, `/data/backups`, and `/certs` and wires the `CCER_DATA_DIR`, `CCER_JSON_DIR`, `CCER_BACKUP_DIR`, `CCER_CERT_DIR` env vars to NAS host directories chosen at deploy time
    - Add a `docs/open-decisions.md` log seeded from the design's Open Decisions, recording the resolved decisions (single-container NAS backend, Drift/SQLCipher local store, card-wise bar chart) and the remaining defaults
    - Initialize the Flutter app project in `app/` and a Node/TypeScript project in `server/`; ensure the shared JSON data contract (task 1.2) is established before any client code depends on it
    - _Requirements: 1.1, 1.3_

  - [ ] 1.2 Define the shared record-envelope schema and record data shapes
    - In `shared/`, author the versioned JSON schema (`schemaVersion: 1`) for the record envelope: `id`, `type`, `revision {lamport, originDevice, updatedAt}`, `deleted`, `data`
    - Define per-type `data` shapes for `credit_card`, `payment_obligation`, `recurring_expense`, `vendor_follow_up`, `claim`, `reminder_occurrence`
    - Define the REST `/sync` request/response and `Data_Export` document shapes
    - Provide shared fixtures used by both app and server tests
    - _Requirements: 10.1, 10.2, 11.1_

  - [ ]* 1.3 Vendor and adapt the Card-Nudge reference project (Card-Nudge, MIT)
    - Clone/vendor the MIT-licensed Card-Nudge `Reference_Project` into `app/reference/card-nudge/` (or `docs/reference/`), retaining its original `LICENSE` and attribution intact (Req 13.2, 13.3)
    - Identify the reusable material to adapt downstream: card-list / card-detail / reminder-entry UI screens and widgets, the card/reminder/recurrence domain models, and the `flutter_local_notifications` scheduling wiring
    - Mark the parts to REPLACE rather than reuse: Card-Nudge's Hive local storage → this design's Drift/SQLite + SQLCipher store, and its Supabase backend/sync → this design's NAS single-container sync + original offline-first sync engine
    - Record in `docs/` which files are adapted-from-Card-Nudge vs original, so the divergent parts (sync engine, totals/per-card breakdown, NAS dashboard) stay demonstrably original (Req 13.1)
    - Optional but recommended: skipping it means building the adaptable UI/model/notification wiring from scratch
    - _Requirements: 13.1, 13.2, 13.3_

  - [ ]* 1.4 Write schema validation tests for the shared contract
    - Validate representative valid and invalid envelopes; assert required fields and type enum are enforced
    - _Requirements: 10.1, 10.2, 11.1_

- [ ] 2. Implement the pure domain model and validation (app)
  - [ ] 2.1 Define domain entities and value types
    - In `app/lib/domain/`, implement pure Dart models for `Credit_Card`, `Payment_Obligation` (unified card bill + recurring), `Recurring_Expense`, `Vendor_Follow_Up`, `Claim`, `Reminder_Rule`, `Reminder_Occurrence`, and a `ValidationResult`
    - Adapt the card/reminder/recurrence domain-model shapes from the vendored Card-Nudge reference (task 1.3) where they fit, extending them to this design's entities rather than building from scratch
    - No I/O in this layer; map cleanly to the shared contract's `data` shapes
    - _Requirements: 2.7, 2.8, 3.1, 3.3, 4.1, 5.6, 13.1_

  - [ ] 2.2 Implement input validation logic
    - Validate non-empty bank and display name; last-four exactly four decimal digits; card limit non-negative; bill/recurring amount strictly positive; bill-generation and payment due dates; claim date-range (start not after end) XOR quarter+year
    - Return all invalid fields with corrective messages while retaining submitted values
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.9, 2.10, 3.2, 4.2, 5.3, 5.4, 5.5, 5.9, 5.10_

  - [ ]* 2.3 Property test: monetary validation respects required bound
    - **Property 6: Monetary validation respects the required bound**
    - **Validates: Requirements 2.6, 3.2, 4.2**

  - [ ]* 2.4 Property test: last-four-digits validation is exact
    - **Property 7: Last-four-digits validation is exact**
    - **Validates: Requirements 2.3**

  - [ ]* 2.5 Property test: non-empty required-field validation
    - **Property 8: Non-empty required-field validation**
    - **Validates: Requirements 2.1, 2.2, 2.8**

  - [ ]* 2.6 Property test: invalid submissions retain values and flag exactly the invalid fields
    - **Property 9: Invalid submissions retain all values and flag exactly the invalid fields**
    - **Validates: Requirements 2.9, 2.10, 5.9, 5.10**

  - [ ]* 2.7 Property test: claim completion window is well-formed
    - **Property 10: Claim completion window is well-formed**
    - **Validates: Requirements 5.3, 5.5**

- [ ] 3. Implement totals, recurrence, and due-status domain services (app)
  - [ ] 3.1 Implement TotalsService
    - Pure `monthTotal(month)` (sum of all paid and unpaid obligations; zero for empty), `breakdown(month)` returning distinct labeled `{total, paid, remaining}` with `remaining = total - paid`, and `rangeComparison(start, end)` with zero-filled empty months
    - Implement `cardMonthBreakdown(start, end)` producing, per `Billing_Month` in the inclusive range, the per-`Credit_Card` sum of that card's obligations plus a stable "Household / non-card" series for recurring obligations (which have no owning card) and the combined month total; zero-backfill empty months and absent (month, card) cells so the sum of all per-card and non-card series for a month equals that month's overall total
    - Exclude claim reference amounts and vendor follow-ups by construction
    - _Requirements: 3.4, 3.5, 3.7, 5.7, 8.1, 8.2_

  - [ ]* 3.2 Property test: monthly total equals the sum of all obligations
    - **Property 1: Monthly total equals the sum of all obligations**
    - **Validates: Requirements 3.4, 3.5, 8.1, 8.2**

  - [ ]* 3.3 Property test: totals exclude claim reference amounts and vendor follow-ups
    - **Property 2: Totals exclude claim reference amounts and vendor follow-ups**
    - **Validates: Requirements 5.7**

  - [ ]* 3.4 Property test: paid/remaining breakdown is consistent
    - **Property 3: Paid/remaining breakdown is consistent**
    - **Validates: Requirements 3.7**

  - [ ]* 3.5 Property test: per-card month breakdown sums to the overall month total
    - **Property 26: Per-card month breakdown sums to the overall month total**
    - **Validates: Requirements 8.1, 8.2, 3.4**

  - [ ] 3.6 Implement RecurrenceEngine and mark-paid semantics
    - Generate exactly one `Payment_Obligation` per (expense, billing month, occurrence) using a stable `occurrence_key`; re-running is idempotent
    - Implement idempotent `markPaid` assigning `Paid_Status`
    - Implement due-status assignment: `Vendor_Check_Status` when the rule is due; `Claim_Window_Status` when the current date is within range or quarter
    - _Requirements: 3.6, 4.4, 4.5, 4.6, 5.2, 5.8_

  - [ ]* 3.7 Property test: recurrence generates exactly one obligation per occurrence (idempotent)
    - **Property 4: Recurrence generates exactly one obligation per occurrence (idempotent)**
    - **Validates: Requirements 4.4, 4.5**

  - [ ]* 3.8 Property test: mark-paid assigns Paid_Status and is idempotent
    - **Property 5: Mark-paid assigns Paid_Status and is idempotent**
    - **Validates: Requirements 3.6, 4.6**

  - [ ]* 3.9 Property test: due status assignment matches the schedule and window
    - **Property 11: Due status assignment matches the schedule and window**
    - **Validates: Requirements 5.2, 5.8**

- [ ] 4. Implement the pure sync/reconcile domain (app + shared logic)
  - [ ] 4.1 Implement revision metadata and operation log model
    - Pure Lamport-counter revision logic (`lamport = max(seen) + 1`), `origin_device`, tombstones, and an op-log representation (`create|update|delete` with payload)
    - Assign stable per-record UUID `Record_Identity` on create; keep it stable across updates
    - _Requirements: 10.1, 10.2, 10.3_

  - [ ] 4.2 Implement reconciliation and conflict detection with merge policy
    - Apply compatible ops; detect concurrent incompatible edits as `Synchronization_Conflict`; retain all versions until resolution
    - Implement the per-record-type merge policy (field-level for profiles, paid-wins for paid flag, LWW-with-conflict for amounts/claims/vendors) behind a single policy interface so it can be swapped **[Open Decision #4]**
    - Validate incoming payloads against the shared schema before any write; reject corrupt payloads without mutating state
    - _Requirements: 10.5, 10.6, 10.7, 10.8, 10.9, 10.13_

  - [ ]* 4.3 Property test: every shared record has stable identity and monotonic revision
    - **Property 16: Every shared record has stable identity and monotonic revision**
    - **Validates: Requirements 10.1, 10.2**

  - [ ]* 4.4 Property test: synchronization converges
    - **Property 18: Synchronization converges**
    - **Validates: Requirements 10.4, 10.5, 10.6**

  - [ ]* 4.5 Property test: incompatible concurrent edits create a surfaced conflict
    - **Property 19: Incompatible concurrent edits create a surfaced conflict**
    - **Validates: Requirements 9.8, 10.7, 10.8**

  - [ ]* 4.6 Property test: conflicting versions are retained until resolution (no silent loss)
    - **Property 20: Conflicting versions are retained until resolution**
    - **Validates: Requirements 10.9**

  - [ ]* 4.7 Property test: corrupt input preserves existing data
    - **Property 22: Corrupt input preserves existing data**
    - **Validates: Requirements 10.13, 11.4**

- [ ] 5. Checkpoint - domain layer complete
  - Ensure all domain and property tests pass, ask the user if questions arise.

- [ ] 6. Implement local storage with Drift/SQLite + SQLCipher (app)
  - [ ] 6.1 Define Drift schema and SQLCipher-encrypted database
    - Create tables for cards, obligations, recurring expenses, vendor follow-ups, claims, reminder occurrences, `sync_meta`, `op_log`, and `backup_snapshot`
    - Configure SQLCipher with a key generated on first run and stored in the Android Keystore; versioned migrations
    - _Requirements: 1.2, 12.5_

  - [ ] 6.2 Implement SQL totals queries
    - Implement the `SUM`/`GROUP BY` month aggregation query backing `TotalsService`, with zero-fill for empty months in a range
    - _Requirements: 3.4, 3.5, 8.1_

  - [ ]* 6.3 Write integration tests for storage and totals queries
    - Test migrations, encrypted open/close, and that SQL totals match the pure `TotalsService` on shared fixtures
    - _Requirements: 1.2, 3.4, 12.5_

- [ ] 7. Implement repositories and backup service (app)
  - [ ] 7.1 Implement CardRepository, ObligationRepository, RecurrenceEngine wiring, VendorClaimRepository
    - CRUD + validation wiring to the domain layer; `markPaid`, `listByMonth`, `listDue(date)`; obligation generation persisted via `occurrence_key` dedupe
    - Enqueue every mutation as a durable `Local_Change` in the op-log inside a single transaction
    - _Requirements: 1.2, 1.4, 2.x, 3.1, 3.3, 3.6, 4.1, 4.4, 4.5, 4.6, 5.1, 5.2, 5.6, 5.8, 10.3_

  - [ ] 7.2 Implement BackupService (backup-before-replace)
    - `snapshot(reason)` persists a `Backup_Snapshot` capturing prior state inside the same transaction that applies a replacing resolution or import; `restore(id)`
    - _Requirements: 10.10, 11.3_

  - [ ]* 7.3 Property test: offline changes are retained until synchronized
    - **Property 17: Offline changes are retained until synchronized**
    - **Validates: Requirements 1.4, 10.3**

  - [ ]* 7.4 Property test: a backup exists before any replacing resolution or import
    - **Property 21: A backup exists before any replacing resolution or import**
    - **Validates: Requirements 10.10, 11.3**

- [ ] 8. Implement the notification scheduler (app)
  - [ ] 8.1 Implement NotificationScheduler
    - Adapt the `flutter_local_notifications` scheduling wiring from the vendored Card-Nudge reference (task 1.3) as a starting point, extending it to this design's occurrence model
    - Schedule a `Local_Notification` per `Reminder_Occurrence` via `flutter_local_notifications` (zoned/exact alarms); payload carries the identifying fields for each type (card/amount/due; expense/amount; vendor; claim + window)
    - De-duplicate per `occurrence_key`, mark `notified=true` on delivery, never re-deliver a notified occurrence; compute and schedule the next occurrence by recurrence
    - Request `POST_NOTIFICATIONS` on Android 13+ and exact-alarm permission where required; use a single config object for default lead times so defaults can be swapped **[Open Decision #5, #8]**
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [ ] 8.2 Implement boot-time rescheduling
    - Add a boot receiver (`android_alarm_manager_plus` / `RECEIVE_BOOT_COMPLETED`) calling `rescheduleAll()` so pending occurrences survive restart
    - _Requirements: 7.5, 7.6, 7.7_

  - [ ]* 8.3 Property test: notification payload identifies its subject
    - **Property 13: Notification payload identifies its subject**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4**

  - [ ]* 8.4 Property test: notification delivery is recorded and never duplicated
    - **Property 14: Notification delivery is recorded and never duplicated**
    - **Validates: Requirements 7.5, 7.6**

  - [ ]* 8.5 Property test: next occurrence follows the recurrence
    - **Property 15: Next occurrence follows the recurrence**
    - **Validates: Requirements 7.7**

- [ ] 9. Implement accessible status presentation (app)
  - [ ] 9.1 Implement AccessibleStatusPresenter and status chip widget
    - For paid, vendor-check, and claim-window statuses, build a text label + non-color visual indicator (icon/shape) + non-empty accessibility label; never status-by-color-alone
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ]* 9.2 Property test: every status indicator is accessible
    - **Property 12: Every status indicator is accessible**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

- [ ] 10. Implement Flutter UI screens
  - [ ] 10.1 Build card list and card detail screens
    - Adapt the card-list / card-detail / reminder-entry screens and widgets from the vendored Card-Nudge reference (task 1.3) as a visual/structural starting point, rewiring them to this design's repositories and Drift store rather than Card-Nudge's Hive/Supabase layer
    - Multi-card list (bank, display name, masked last four, due-date hint); detail with profile fields, notes, associated bills, add-bill action
    - _Requirements: 1.2, 2.7, 2.8, 3.1, 13.1_

  - [ ] 10.2 Build bill, recurring, and vendor/claim entry screens with inline validation
    - Field-level corrective feedback that retains all submitted values and flags exactly the invalid fields; claim date-range XOR quarter+year; optional reference amount
    - _Requirements: 2.9, 2.10, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 5.1, 5.3, 5.4, 5.5, 5.6, 5.9, 5.10_

  - [ ] 10.3 Build dashboard/summary screen
    - Month total and distinct paid/remaining breakdown; recompute on obligation change
    - Render the month-wise comparison as an accessible **card-wise bar chart**: one series/group per `Credit_Card` plus a "Household / non-card" series for recurring obligations plus the combined month total, sourced from `TotalsService.cardMonthBreakdown`; distinguish series by text label + non-color marker (pattern/shape), never color alone; provide an equivalent accessible data-table fallback with the same per-card month values; keyboard-operable, screen-reader names for series/values, and honor `prefers-reduced-motion` (only the specific chart renderer is a minor note)
    - Render accessible status chips from task 9
    - _Requirements: 3.4, 3.5, 3.7, 8.1, 8.2, 6.1, 6.2, 6.3_

  - [ ]* 10.4 Write widget tests for validation and accessibility
    - Assert invalid submissions retain values and flag invalid fields; assert chips expose accessible names
    - _Requirements: 2.9, 2.10, 5.9, 5.10, 6.4_

- [ ] 11. Implement the app sync engine and transports
  - [ ] 11.1 Implement SyncEngine core
    - `enqueue(op)`, apply reconcile results, surface `Synchronization_Conflict`, `resolveConflict(choice)` invoking BackupService before any replace
    - Derive `Synchronization_Health` (NAS availability, last success, queued count, retry state, unresolved conflicts) recomputed on every state change; exponential backoff retry
    - _Requirements: 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 10.12_

  - [ ] 11.2 Implement REST sync transport to the NAS
    - `POST /auth` token handling and `POST /sync` push/pull using the shared payloads over TLS; update health on success/failure
    - _Requirements: 10.5, 10.6, 10.11, 10.12, 12.1_

  - [ ] 11.3 Implement peer-to-peer LAN sync
    - mDNS/DNS-SD discovery (`_ccer-sync._tcp`) and mutually-authenticated HTTP-over-TLS peer exchange reusing REST payloads; isolate transport behind an interface so it can be swapped **[Open Decision #3]**
    - _Requirements: 10.4_

  - [ ]* 11.4 Property test: synchronization health reflects true state
    - **Property 23: Synchronization health reflects true state**
    - **Validates: Requirements 10.11, 10.12**

  - [ ] 11.5 Build the sync health and conflict-resolution UI
    - Show NAS availability, queued changes, retry state, unresolved conflicts, and a resolution UI showing all conflicting versions with a `Conflict_Warning` before replace
    - _Requirements: 10.8, 10.9, 10.11, 10.12_

- [ ] 12. Implement export/import and auth/encryption baseline (app)
  - [ ] 12.1 Implement ExportImportService
    - `export()` produces a versioned JSON `Data_Export` including every record's identity and revision; `import(json)` validates `schemaVersion`, snapshots via BackupService, then feeds records through the reconciliation path; corrupt input leaves local data unchanged and is surfaced
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [ ] 12.2 Implement AuthService and authorization gate
    - Per-user credentials exchanged for a bearer token; gate local sync participation and tracker-data access on a valid authorized user; deny otherwise; keep the provider behind an interface with the default bearer-token implementation **[Open Decision #2]**
    - Ensure SQLCipher key provisioning and no hardcoded secrets
    - _Requirements: 12.1, 12.3, 12.5_

  - [ ]* 12.3 Property test: export includes identity and revision; export/import round-trips
    - **Property 24: Export includes identity and revision; export/import round-trips**
    - **Validates: Requirements 11.1, 11.2**

  - [ ]* 12.4 Property test: access is granted only to authorized users
    - **Property 25: Access is granted only to authorized users**
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4**

- [ ] 13. Checkpoint - app complete
  - Ensure all app tests pass, ask the user if questions arise.

- [ ] 14. Implement the NAS backend service (server)
  - [ ] 14.1 Implement the authoritative dataset store (encrypted at rest)
    - Persist the `Authoritative_Dataset` with record envelopes, sync_meta, and op-log under `CCER_DATA_DIR` (`/data/db`) on an encrypted volume / field encryption; read all storage locations from env vars so no application state is baked into the container image; keep the store behind an interface
    - Reuse the shared reconciliation/merge logic (ported or shared) so server and app resolve identically
    - _Requirements: 9.1, 12.6_

  - [ ] 14.2 Implement `/auth` and `/sync` endpoints
    - `/auth` issues/verifies bearer tokens for authorized users; `/sync` accepts op-logs, reconciles against the dataset, returns merged records + conflicts + serverLamport; deny unauthorized requests
    - Validate payloads against the shared schema; reject corrupt input without mutating the dataset
    - _Requirements: 9.7, 10.5, 10.6, 10.7, 10.8, 10.13, 12.2, 12.4_

  - [ ] 14.3 Implement `/export`, backup-before-replace, and scheduled backups
    - `/export` returns a versioned JSON `Data_Export` written under `CCER_JSON_DIR` (`/data/json`); import reads portable JSON from the same bind mount; snapshot before any replacing resolution/import, writing `Backup_Snapshot`s under `CCER_BACKUP_DIR` (`/data/backups`); scheduled backups with a retention policy exposed as config
    - _Requirements: 10.10, 10.14, 11.1_

  - [ ]* 14.4 Write integration tests for the sync/auth/export endpoints
    - Reconcile a two-client op-log scenario end-to-end; assert convergence, conflict surfacing, auth denial, corruption rejection, and that a backup precedes replacement
    - _Requirements: 10.5, 10.6, 10.7, 10.13, 10.14, 11.3, 12.2, 12.4_

- [ ] 15. Implement the responsive accessible HTML dashboard (server/dashboard)
  - [ ] 15.1 Build the dashboard shell and data wiring
    - Server-rendered + progressive-enhancement HTML/CSS/JS reading the authoritative dataset through the API; apply the design's visual tokens (navy `#1E40AF`, blue `#3B82F6`, amber `#D97706`, red `#DC2626`, background `#F8FAFC`, Fira Sans/Fira Code)
    - KPI summary cards (month total, paid, remaining, active reminders/conflicts) and the month-comparison chart rendered as an accessible **card-wise bar chart**: one series/group per `Credit_Card` plus a "Household / non-card" recurring series plus the combined month total, driven by the server's per-card month breakdown; grouped or stacked bars present the per-card breakdown per billing month
    - Distinguish series by text label + non-color marker (pattern/shape) with programmatic accessible names (never color alone); keep the chart behind a thin interface with an equivalent accessible data-table fallback presenting the same per-card month values; keyboard-operable, screen-reader accessible, honoring `prefers-reduced-motion` (resolved; only the specific lightweight chart library remains a minor note)
    - _Requirements: 8.1, 8.2, 8.3, 9.2, 9.3, 9.4_

  - [ ] 15.2 Implement the accessible shared-state table and reminders/vendor/claim panel
    - Sortable table with proper header associations; status column rendered with text label + non-color indicator + accessible name (never color alone); attention panel with accessible status chips
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 9.4_

  - [ ] 15.3 Implement dashboard edit + conflict surfacing and accessibility/responsiveness
    - Dashboard create/update submits shared changes for reconciliation; show a potential-conflict notice before replacing shared data
    - Keyboard operability with visible focus, screen-reader names, `prefers-reduced-motion`, responsive 320–1920px with no page-level horizontal scroll
    - _Requirements: 8.2, 8.3, 9.3, 9.5, 9.6, 9.7, 9.8_

  - [ ]* 15.4 Write dashboard accessibility and responsiveness tests
    - Automated keyboard/screen-reader audit, color-independence of status, reduced-motion behavior, and no-horizontal-scroll at 320/768/1920
    - _Requirements: 9.5, 9.6, 9.8_

- [ ] 16. Integration, wiring, and end-to-end verification
  - [ ] 16.1 Containerize and wire the server
    - Finalize `server/Dockerfile` (single image, no application state baked in) and the root `docker-compose.yml` so one container serves the REST API + static dashboard with bind-mounted volumes: `CCER_DATA_DIR=/data/db` (authoritative dataset), `CCER_JSON_DIR=/data/json` (JSON exports/imports + contract snapshots), `CCER_BACKUP_DIR=/data/backups` (`Backup_Snapshot`s), `CCER_CERT_DIR=/certs` (TLS key/cert, mounted read-only)
    - The authoritative dataset and all portable JSON live on these bind mounts, not in the image; secrets (TLS key/cert, token-signing) are injected at deploy via mounted files/env, never committed; the auth provider default stays swappable **[Open Decision #2]**
    - Host note: the specific NAS product (Synology / TrueNAS / plain Linux) and its host directory mapping are chosen at deploy time
    - _Requirements: 9.1, 9.2, 12.6_

  - [ ]* 16.2 End-to-end sync + dashboard smoke test
    - Build the Flutter app and run its test suite; start the server; run an automated smoke that pushes ops from two simulated clients, confirms convergence and conflict handling via `/sync`, and renders the dashboard against the authoritative dataset
    - _Requirements: 1.1, 8.3, 9.3, 10.4, 10.5_

  - [ ]* 16.3 Licensing and originality review
    - Verify that any reused/adapted Card-Nudge material retains its MIT license text and attribution (Req 13.2, 13.3), and that the divergent parts (Drift/SQLCipher store, sync engine, totals/per-card breakdown, NAS dashboard) are original work (Req 13.1); confirm all third-party material is under a permitting license; record findings in `docs/`
    - _Requirements: 13.1, 13.2, 13.3_

- [ ] 17. Final checkpoint - full system
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests, setup-heavy, or review items) and can be skipped for a faster MVP; core implementation tasks are never optional. The Card-Nudge vendoring task (1.3) is optional-but-recommended: skipping it means building the adaptable UI/model/notification wiring from scratch.
- Resolved design decisions are implemented directly: single-container NAS backend with bind-mounted `/data/db`, `/data/json`, `/data/backups`, `/certs` volumes; Drift/SQLite + SQLCipher local store; accessible card-wise bar chart + data-table fallback for the month-wise comparison.
- Tasks tagged **[Open Decision #N]** implement the design's recommended default behind a single config or interface so the default can be swapped without rework. Remaining open items: auth provider (#2), peer transport (#3), conflict policy (#4), notification lead-times (#5), Excel import (#6), Android range (#8).
- Each task references the specific requirement sub-clauses it satisfies for traceability.
- Property tests use a minimum of 100 generated iterations per property and each references its design property number.
- The pure domain layer (tasks 2–4) is proven correct before any I/O boundary is added, so totals, recurrence, and merge bugs are caught early.
- Excel one-time import (Open Decision #6) is intentionally not scheduled; add a dedicated import task if that scope is confirmed.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4", "2.1"] },
    { "id": 3, "tasks": ["2.2", "3.1", "4.1"] },
    { "id": 4, "tasks": ["2.3", "2.4", "2.5", "2.6", "2.7", "3.2", "3.3", "3.4", "3.5", "3.6", "4.2"] },
    { "id": 5, "tasks": ["3.7", "3.8", "3.9", "4.3", "4.4", "4.5", "4.6", "4.7"] },
    { "id": 6, "tasks": ["6.1"] },
    { "id": 7, "tasks": ["6.2", "6.3", "7.1"] },
    { "id": 8, "tasks": ["7.2", "7.3", "7.4", "8.1", "9.1"] },
    { "id": 9, "tasks": ["8.2", "8.3", "8.4", "8.5", "9.2", "10.1"] },
    { "id": 10, "tasks": ["10.2", "10.3", "11.1"] },
    { "id": 11, "tasks": ["10.4", "11.2", "11.3", "12.1", "12.2"] },
    { "id": 12, "tasks": ["11.4", "11.5", "12.3", "12.4"] },
    { "id": 13, "tasks": ["14.1"] },
    { "id": 14, "tasks": ["14.2"] },
    { "id": 15, "tasks": ["14.3", "14.4", "15.1"] },
    { "id": 16, "tasks": ["15.2", "15.3"] },
    { "id": 17, "tasks": ["15.4", "16.1"] },
    { "id": 18, "tasks": ["16.2", "16.3"] }
  ]
}
```


## Scope Amendment: Fixed Deposits and Bond Payments (Requirement 14)

- [ ] 18. Implement fixed-deposit and bond-payment support
  - [ ] 18.1 Extend the shared data contract and pure domain model
    - Add `fixed_deposit` and `bond_payment` record-envelope types and fixtures to `shared/`; add `FixedDeposit` and `BondPayment` entities plus validation for identifiers, positive principal/expected amounts, valid maturity/payment dates, non-negative interest values, and `annual_rate_percent | fixed_amount` interest-value kinds.
    - Include both record types in operation logs, revision metadata, reconciliation, JSON export/import, and access controls; keep them distinct from `Payment_Obligation`.
    - _Requirements: 10.1, 10.2, 11.1, 12.1, 14.1, 14.2, 14.3, 14.4, 14.5, 14.10_

  - [ ] 18.2 Preserve investment-total exclusion
    - Extend `TotalsService` and storage queries so fixed-deposit principal/interest and bond-payment expected amounts cannot contribute to total, paid, remaining, range, or card-wise series calculations.
    - _Requirements: 3.4, 3.7, 8.1, 14.9_

  - [ ] 18.3 Extend encrypted persistence, sync, and notifications
    - Add Drift/NAS dataset tables and JSON mappings for fixed deposits and bond payments; persist them with the standard sync metadata and backups.
    - Schedule maturity/payment reminders through the existing notification scheduler using the configurable lead time; include the required FD/bond fields in notification payloads and preserve occurrence de-duplication.
    - _Requirements: 7.5, 7.6, 10.3, 10.5, 10.13, 12.5, 12.6, 14.6, 14.7_

  - [ ] 18.4 Add Flutter and NAS dashboard investment views
    - Provide accessible create/edit forms and an Investments panel/table for FD number, principal, interest rate/amount, maturity date, bond identifier, expected payment amount, and payment date.
    - Render upcoming maturity/payment state with visible text, a non-color marker, and an accessibility label; keep investment records separate from payment-total cards and card-wise bar charts.
    - _Requirements: 6.4, 8.3, 9.3, 9.4, 9.5, 9.6, 14.8, 14.10_

  - [ ]* 18.5 Add investment correctness tests
    - Property 27: investment records never change payment totals; Property 28: investment validation and reminder payloads are complete.
    - Add integration tests for app/NAS JSON round trips and synchronization of fixed deposits and bond payments.
    - _Requirements: 3.4, 3.7, 8.1, 10.5, 11.1, 14.1–14.10_

  - [ ] 18.6 Extend end-to-end smoke verification
    - Verify an authorized user can add an FD and bond payment on one client, synchronize to the NAS, view them in the HTML dashboard, and receive the correct upcoming reminder state without changing the monthly payment total or bar-chart data.
    - _Requirements: 9.3, 10.5, 12.1, 14.1–14.9_


## Scope Amendment: Portfolio Groups (Requirement 15)

- [ ] 19. Implement portfolio groups for cards and investments
  - [ ] 19.1 Extend shared schema, domain, and reconciliation
    - Add `portfolio_group` and `portfolio_group_membership` record types to the JSON contract, fixtures, Dart/TypeScript domain models, Drift and NAS schemas, operation logs, export/import, and synchronization.
    - Model membership as a unique `(groupId, memberRecordId)` many-to-many association supporting `credit_card`, `fixed_deposit`, and `bond_payment`; make duplicate insertion idempotent and preserve member records when a membership is removed.
    - Use field-level group-name merge and idempotent membership-set semantics while preserving conflict visibility for concurrent group-name edits.
    - _Requirements: 10.1, 10.2, 10.5, 10.7, 11.1, 15.1, 15.2, 15.3, 15.4, 15.8, 15.9_

  - [ ] 19.2 Preserve aggregation neutrality
    - Ensure total, paid, remaining, range-comparison, and card-wise bar-chart queries are based on intrinsic payment-obligation sources and count records once regardless of zero, one, or multiple Group_Memberships.
    - _Requirements: 3.4, 3.7, 8.1, 15.7_

  - [ ] 19.3 Add accessible Flutter and NAS dashboard group management
    - Add group create/rename, member add/remove, and group-filter controls for cards, FDs, and bonds; show group detail lists with accessible labels, visible focus, and non-color status indicators.
    - A selected group filters visible records without changing household payment-total KPIs or the complete card-wise comparison computation.
    - _Requirements: 6.4, 9.3, 9.4, 9.5, 9.6, 15.5, 15.6, 15.9_

  - [ ]* 19.4 Add group-correctness tests
    - Property 29: group membership is idempotent and aggregation-neutral; include synchronization/export round trips and removal-preserves-member coverage.
    - _Requirements: 10.5, 11.1, 15.2–15.8_

  - [ ] 19.5 Extend end-to-end verification
    - Verify a user can create Group 1 and Group 2, assign listed FDs/cards/bonds, synchronize group membership through the NAS, filter either dashboard, and confirm the monthly totals and bar-chart values remain unchanged.
    - _Requirements: 9.3, 10.5, 15.1–15.8_
