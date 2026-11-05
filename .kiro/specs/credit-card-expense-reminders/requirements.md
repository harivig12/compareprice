# Requirements Document

## Introduction

Credit Card Expense Reminders is an offline-first native Flutter Android application for at least three authorized household users. It replaces a household Excel spreadsheet as the working tracker for credit-card payments and recurring household expenses. A NAS hosts the authoritative shared dataset and a responsive HTML dashboard for centralized tracking; Flutter devices retain local data and reconcile changes while operating offline or when the NAS is unavailable. The spreadsheet may be used as a reference during a separately defined migration, but is not a continuing data store. Payment obligations contribute to month totals. Vendor follow-ups and claims generate reminders without contributing to payment aggregation. Card-Nudge and deq are visual and functional references only; the application must use original implementation and appropriately licensed assets.

## Glossary

- **Credit_Card_Expense_Reminders_App**: The native Flutter Android application defined by this document.
- **Authorized_Household_User**: One of at least three household users permitted to access and update shared tracker data under the selected access policy.
- **Credit_Card**: A payment card identified by a bank, display name, and, when applicable, last four digits.
- **Billing_Cycle**: A Credit_Card's bill-generation date and payment due date.
- **Payment_Obligation**: A Card_Bill or a generated Recurring_Expense payment amount that is included in a Billing_Month payment total.
- **Card_Bill**: A Payment_Obligation associated with a Credit_Card and a Billing_Month.
- **Recurring_Expense**: A payment definition with a monthly, quarterly, or yearly recurrence schedule, including LIC, school, property, PPF, maintenance, utilities, or other household expenses.
- **Vendor_Follow_Up**: A notification-only reminder to contact or check with a vendor; it does not have an aggregate amount.
- **Claim**: A notification-only reminder completed within either a date range or a calendar quarter and year; a Claim may record a reference amount that is excluded from the payment total.
- **Reminder_Rule**: A monthly, quarterly, or yearly schedule that determines when a Local_Notification occurrence is due.
- **Reminder_Occurrence**: One scheduled instance of a Reminder_Rule.
- **Local_Notification**: A notification generated and delivered by the Credit_Card_Expense_Reminders_App without requiring an external network service at delivery time.
- **Billing_Month**: The calendar month assigned to a Payment_Obligation for comparison and aggregation.
- **Paid_Status**: The status indicating that a Payment_Obligation was paid.
- **Vendor_Check_Status**: The status indicating that a Vendor_Follow_Up requires attention.
- **Claim_Window_Status**: The status indicating that a Claim is within its completion date range or completion quarter.
- **Accessible_Status_Indicator**: A text label, non-color visual indicator, and accessibility label that communicate a status.
- **NAS**: The household network-attached storage service selected to host the authoritative shared dataset and HTML_Dashboard.
- **Authoritative_Dataset**: The current shared tracker dataset hosted by the NAS after synchronization reconciliation.
- **HTML_Dashboard**: The responsive HTML interface served by the NAS for viewing and updating centralized tracker data.
- **Local_Change**: A user-created update retained on a Flutter device while the NAS is unavailable.
- **Synchronization**: The exchange and reconciliation of shared tracker changes among an Authorized_Household_User's devices and the NAS.
- **Reconciliation**: The process that incorporates compatible Local_Changes into shared tracker data and identifies incompatible changes for resolution.
- **Record_Identity**: A unique identifier that distinguishes one tracker record across all devices and the NAS.
- **Revision_Metadata**: Record version information used to detect changes and conflicts during Synchronization.
- **Synchronization_Conflict**: Incompatible changes to the same shared tracker data that require user-visible resolution under the selected conflict policy.
- **Conflict_Warning**: A visible notice that identifies a Synchronization_Conflict and requires a user resolution before conflicting data is discarded or replaced.
- **Synchronization_Health**: A visible indication of synchronization availability, latest successful result, queued Local_Changes, retry state, and unresolved Synchronization_Conflicts.
- **Data_Export**: A versioned JSON representation of tracker data for interoperable transfer or backup.
- **Backup_Snapshot**: A recoverable copy of tracker data created before a synchronization resolution or import replaces data.
- **Reference_Project**: Card-Nudge or deq, used only to inform comparable functionality, security posture, or interface direction.

## Requirements

### Requirement 1: Native Offline Household Tracker

**User Story:** As a household member, I want a native Android tracker that works without a network connection, so that I can manage upcoming obligations wherever I am.

#### Acceptance Criteria

1. THE Credit_Card_Expense_Reminders_App SHALL run as a native Flutter application on Android devices.
2. WHILE a network connection is unavailable, THE Credit_Card_Expense_Reminders_App SHALL allow an Authorized_Household_User to view, create, update, and mark Paid_Status for locally stored Payment_Obligations.
3. THE Credit_Card_Expense_Reminders_App SHALL allow an Authorized_Household_User to enter required tracking data without an Excel spreadsheet.
4. WHEN an Authorized_Household_User creates or updates shared tracker data while the NAS is unavailable, THE Credit_Card_Expense_Reminders_App SHALL retain the update as a Local_Change.

### Requirement 2: Credit Card Profiles and Input Validation

**User Story:** As a cardholder, I want to maintain valid profiles for each Credit_Card, so that I can distinguish and manage multiple cards.

#### Acceptance Criteria

1. WHEN an Authorized_Household_User submits a Credit_Card, THE Credit_Card_Expense_Reminders_App SHALL validate that the Credit_Card's bank is non-empty.
2. WHEN an Authorized_Household_User submits a Credit_Card, THE Credit_Card_Expense_Reminders_App SHALL validate that the Credit_Card's display name is non-empty.
3. WHERE an Authorized_Household_User supplies last four digits for a Credit_Card, THE Credit_Card_Expense_Reminders_App SHALL validate that the last four digits contain exactly four decimal digits.
4. WHEN an Authorized_Household_User sets a Billing_Cycle, THE Credit_Card_Expense_Reminders_App SHALL validate the Credit_Card's bill-generation date.
5. WHEN an Authorized_Household_User sets a Billing_Cycle, THE Credit_Card_Expense_Reminders_App SHALL validate the Credit_Card's payment due date.
6. WHERE an Authorized_Household_User supplies a card limit for a Credit_Card, THE Credit_Card_Expense_Reminders_App SHALL validate the card limit as a non-negative monetary amount.
7. WHERE an Authorized_Household_User supplies notes for a Credit_Card, THE Credit_Card_Expense_Reminders_App SHALL record the notes.
8. WHEN an Authorized_Household_User submits a valid Credit_Card, THE Credit_Card_Expense_Reminders_App SHALL record the Credit_Card's bank and display name.
9. WHEN a Credit_Card submission contains an invalid field, THE Credit_Card_Expense_Reminders_App SHALL retain every submitted field value.
10. WHEN a Credit_Card submission contains an invalid field, THE Credit_Card_Expense_Reminders_App SHALL identify each invalid field with corrective feedback.

### Requirement 3: Card Bills and Monthly Payment Totals

**User Story:** As a cardholder, I want to record Card_Bills and see accurate monthly totals, so that I know the required payment across all cards and household obligations.

#### Acceptance Criteria

1. WHEN an Authorized_Household_User records a Card_Bill, THE Credit_Card_Expense_Reminders_App SHALL associate the Card_Bill with one Credit_Card.
2. WHEN an Authorized_Household_User records a Card_Bill, THE Credit_Card_Expense_Reminders_App SHALL validate the Card_Bill amount as a positive monetary amount.
3. WHEN an Authorized_Household_User records a Card_Bill, THE Credit_Card_Expense_Reminders_App SHALL assign the Card_Bill to a Billing_Month.
4. WHEN an Authorized_Household_User selects a Billing_Month with Payment_Obligations, THE Credit_Card_Expense_Reminders_App SHALL display the sum of every paid and unpaid Payment_Obligation amount assigned to the selected Billing_Month.
5. WHEN an Authorized_Household_User selects a Billing_Month without Payment_Obligations, THE Credit_Card_Expense_Reminders_App SHALL display a total payment obligation of zero.
6. WHEN an Authorized_Household_User marks a Card_Bill as paid, THE Credit_Card_Expense_Reminders_App SHALL assign Paid_Status to the Card_Bill.
7. WHERE the Credit_Card_Expense_Reminders_App displays paid or remaining amounts for a Billing_Month, THE Credit_Card_Expense_Reminders_App SHALL label total payment obligation, paid amount, and remaining amount as distinct values.

### Requirement 4: Recurring Household Payment Obligations

**User Story:** As a household member, I want to track recurring household payments, so that upcoming LIC, school, property, PPF, maintenance, utility, and similar obligations are visible.

#### Acceptance Criteria

1. WHEN an Authorized_Household_User creates a Recurring_Expense, THE Credit_Card_Expense_Reminders_App SHALL record the Recurring_Expense's name.
2. WHEN an Authorized_Household_User creates a Recurring_Expense, THE Credit_Card_Expense_Reminders_App SHALL validate the Recurring_Expense's amount as a positive monetary amount.
3. WHEN an Authorized_Household_User creates a Recurring_Expense, THE Credit_Card_Expense_Reminders_App SHALL record one monthly, quarterly, or yearly Reminder_Rule.
4. WHEN a Recurring_Expense is due under its Reminder_Rule, THE Credit_Card_Expense_Reminders_App SHALL create exactly one Payment_Obligation for the applicable Billing_Month and recurrence occurrence.
5. WHEN a Recurring_Expense Payment_Obligation already exists for a Billing_Month and recurrence occurrence, THE Credit_Card_Expense_Reminders_App SHALL retain the existing Payment_Obligation as the sole obligation for that Recurring_Expense occurrence.
6. WHEN an Authorized_Household_User marks a Recurring_Expense Payment_Obligation as paid, THE Credit_Card_Expense_Reminders_App SHALL assign Paid_Status to the Recurring_Expense Payment_Obligation.

### Requirement 5: Vendor Follow-Ups and Claims

**User Story:** As a household member, I want reminders for vendor checks and claims, so that I complete time-sensitive follow-ups without treating them as payment totals.

#### Acceptance Criteria

1. WHEN an Authorized_Household_User creates a Vendor_Follow_Up, THE Credit_Card_Expense_Reminders_App SHALL record one monthly, quarterly, or yearly Reminder_Rule for the Vendor_Follow_Up.
2. WHEN a Vendor_Follow_Up is due under its Reminder_Rule, THE Credit_Card_Expense_Reminders_App SHALL assign Vendor_Check_Status to the Vendor_Follow_Up.
3. WHEN an Authorized_Household_User records a Claim using a completion date range, THE Credit_Card_Expense_Reminders_App SHALL validate that the start date is not after the end date.
4. WHEN an Authorized_Household_User records a Claim using a completion quarter, THE Credit_Card_Expense_Reminders_App SHALL record one calendar quarter and one calendar year.
5. WHEN an Authorized_Household_User records a Claim, THE Credit_Card_Expense_Reminders_App SHALL record either a completion date range or a completion quarter and year.
6. WHERE an Authorized_Household_User supplies a reference amount for a Claim, THE Credit_Card_Expense_Reminders_App SHALL record the Claim's reference amount.
7. WHEN the Credit_Card_Expense_Reminders_App calculates a Billing_Month payment total, THE Credit_Card_Expense_Reminders_App SHALL exclude Claim reference amounts and Vendor_Follow_Ups from the total.
8. WHEN a Claim enters its completion date range or completion quarter, THE Credit_Card_Expense_Reminders_App SHALL assign Claim_Window_Status to the Claim.
9. WHEN a Vendor_Follow_Up or Claim submission contains an invalid field, THE Credit_Card_Expense_Reminders_App SHALL retain every submitted field value.
10. WHEN a Vendor_Follow_Up or Claim submission contains an invalid field, THE Credit_Card_Expense_Reminders_App SHALL identify each invalid field with corrective feedback.

### Requirement 6: Accessible Status Presentation

**User Story:** As a household member, I want unambiguous status presentation, so that I can recognize paid payments, vendor checks, and claim windows without relying on color.

#### Acceptance Criteria

1. WHILE a Payment_Obligation has Paid_Status, THE Credit_Card_Expense_Reminders_App SHALL display an Accessible_Status_Indicator identifying the Payment_Obligation as paid.
2. WHILE a Vendor_Follow_Up has Vendor_Check_Status, THE Credit_Card_Expense_Reminders_App SHALL display an Accessible_Status_Indicator identifying the Vendor_Follow_Up as requiring a vendor check.
3. WHILE a Claim has Claim_Window_Status, THE Credit_Card_Expense_Reminders_App SHALL display an Accessible_Status_Indicator identifying the Claim's completion date range or completion quarter.
4. THE Credit_Card_Expense_Reminders_App SHALL provide an accessibility label for every Accessible_Status_Indicator.

### Requirement 7: Local Payment, Vendor, and Claim Reminders

**User Story:** As a household member, I want local reminders for payments and follow-ups, so that I can act before due dates and claim windows close.

#### Acceptance Criteria

1. WHEN a Card_Bill reaches its configured reminder time, THE Credit_Card_Expense_Reminders_App SHALL deliver a Local_Notification identifying the Credit_Card, Card_Bill amount, and payment due date.
2. WHEN a Recurring_Expense reaches its configured reminder time, THE Credit_Card_Expense_Reminders_App SHALL deliver a Local_Notification identifying the Recurring_Expense and Payment_Obligation amount.
3. WHEN a Vendor_Follow_Up reaches its configured reminder time, THE Credit_Card_Expense_Reminders_App SHALL deliver a Local_Notification identifying the Vendor_Follow_Up.
4. WHEN a Claim enters its configured completion date range or completion quarter, THE Credit_Card_Expense_Reminders_App SHALL deliver a Local_Notification identifying the Claim and its completion date range or completion quarter.
5. WHEN the Credit_Card_Expense_Reminders_App delivers a Local_Notification for a Reminder_Occurrence, THE Credit_Card_Expense_Reminders_App SHALL record the Reminder_Occurrence as notified.
6. IF a Reminder_Occurrence is recorded as notified, THEN THE Credit_Card_Expense_Reminders_App SHALL retain the recorded notification state for that Reminder_Occurrence.
7. WHEN a Reminder_Rule recurs monthly, quarterly, or yearly, THE Credit_Card_Expense_Reminders_App SHALL schedule the next Reminder_Occurrence according to that recurrence.

### Requirement 8: Month-Wise Dashboard Comparison

**User Story:** As a household member, I want month-wise payment comparisons, so that I can compare required payment totals over time.

#### Acceptance Criteria

1. WHEN an Authorized_Household_User selects a range of Billing_Months, THE Credit_Card_Expense_Reminders_App SHALL display the Payment_Obligation total for every Billing_Month in the selected range.
2. WHEN a Payment_Obligation changes, THE Credit_Card_Expense_Reminders_App SHALL update the affected Billing_Month total and month-wise comparison.
3. WHEN an Authorized_Household_User opens the HTML_Dashboard, THE HTML_Dashboard SHALL display the Authoritative_Dataset's current Payment_Obligations, Vendor_Follow_Ups, Claims, reminders, monthly totals, and month-wise comparisons.

### Requirement 9: Central NAS Dashboard and Shared Access

**User Story:** As an Authorized_Household_User, I want a centralized dashboard and shared tracker state, so that at least three household users can track the same current data.

#### Acceptance Criteria

1. THE NAS SHALL host the Authoritative_Dataset.
2. THE NAS SHALL provide the HTML_Dashboard for centralized tracking.
3. WHEN an Authorized_Household_User opens the HTML_Dashboard on a mobile or desktop device, THE HTML_Dashboard SHALL provide responsive access to the Authoritative_Dataset.
4. WHEN an Authorized_Household_User views tracker records in the HTML_Dashboard, THE HTML_Dashboard SHALL provide a tabular presentation of the shared tracker state.
5. THE HTML_Dashboard SHALL provide keyboard-accessible controls for its interactive functions.
6. THE HTML_Dashboard SHALL provide screen-reader-accessible names for its interactive controls and status information.
7. WHEN an Authorized_Household_User creates or updates a tracker record in the HTML_Dashboard, THE HTML_Dashboard SHALL create or update shared tracker data for Synchronization.
8. WHEN the HTML_Dashboard identifies a potentially conflicting edit, THE HTML_Dashboard SHALL display the potential conflict before the edit replaces conflicting shared data.

### Requirement 10: Offline-First Synchronization, Reconciliation, and Recovery

**User Story:** As an Authorized_Household_User, I want devices to reconcile offline changes with one another and the NAS, so that shared tracker data remains available without silent data loss.

#### Acceptance Criteria

1. THE Credit_Card_Expense_Reminders_App SHALL assign a Record_Identity to every shared tracker record.
2. THE Credit_Card_Expense_Reminders_App SHALL retain Revision_Metadata for every shared tracker record.
3. WHILE the NAS is unavailable, THE Credit_Card_Expense_Reminders_App SHALL retain Local_Changes for later Synchronization.
4. WHILE the NAS is unavailable and authorized Flutter devices can communicate on the home network, THE Credit_Card_Expense_Reminders_App SHALL synchronize Local_Changes peer-to-peer between the authorized devices.
5. WHEN NAS availability is restored, THE Credit_Card_Expense_Reminders_App SHALL reconcile queued Local_Changes with the Authoritative_Dataset.
6. WHEN Synchronization identifies compatible changes, THE Credit_Card_Expense_Reminders_App SHALL incorporate the compatible changes into synchronized tracker data.
7. WHEN Synchronization identifies incompatible changes to the same shared tracker data, THE Credit_Card_Expense_Reminders_App SHALL create a Synchronization_Conflict.
8. WHEN a Synchronization_Conflict exists, THE Credit_Card_Expense_Reminders_App SHALL display a Conflict_Warning before discarding or replacing conflicting data.
9. WHILE a Conflict_Warning is displayed, THE Credit_Card_Expense_Reminders_App SHALL retain each conflicting version until an Authorized_Household_User selects a resolution.
10. WHEN an Authorized_Household_User selects a conflict resolution that replaces tracker data, THE Credit_Card_Expense_Reminders_App SHALL create a Backup_Snapshot before applying the resolution.
11. WHEN a Synchronization attempt fails, THE Credit_Card_Expense_Reminders_App SHALL provide retry state and failure feedback through Synchronization_Health.
12. WHEN Synchronization state changes, THE Credit_Card_Expense_Reminders_App SHALL update Synchronization_Health with NAS availability, latest successful result, queued Local_Changes, retry state, and unresolved Synchronization_Conflicts.
13. IF received synchronization data is invalid or corrupt, THEN THE Credit_Card_Expense_Reminders_App SHALL preserve existing local tracker data and identify the rejected data to the Authorized_Household_User.
14. THE NAS SHALL create Backup_Snapshots of the Authoritative_Dataset according to the retention policy selected during design.

### Requirement 11: Interoperable Export and Safe Import

**User Story:** As an Authorized_Household_User, I want an interoperable data export and safe import, so that tracker data can be transferred or recovered without treating a JSON file as a concurrent database.

#### Acceptance Criteria

1. WHEN an Authorized_Household_User exports tracker data, THE Credit_Card_Expense_Reminders_App SHALL create a Data_Export in JSON format that includes Record_Identities and Revision_Metadata.
2. WHEN an Authorized_Household_User imports valid Data_Export data, THE Credit_Card_Expense_Reminders_App SHALL process the data through Reconciliation.
3. WHEN an Authorized_Household_User imports Data_Export data that would replace tracker data, THE Credit_Card_Expense_Reminders_App SHALL create a Backup_Snapshot before applying the resulting resolution.
4. IF imported Data_Export data is invalid or corrupt, THEN THE Credit_Card_Expense_Reminders_App SHALL preserve existing tracker data and identify the rejected data to the Authorized_Household_User.

### Requirement 12: Privacy, Access Control, and Encryption

**User Story:** As a household member, I want only authorized household users to access shared financial tracker data, so that shared data remains private and protected.

#### Acceptance Criteria

1. THE Credit_Card_Expense_Reminders_App SHALL restrict tracker-data access and Synchronization participation to Authorized_Household_Users.
2. THE HTML_Dashboard SHALL restrict Authoritative_Dataset access and update capability to Authorized_Household_Users.
3. WHEN an access request does not satisfy the selected authorization policy, THE Credit_Card_Expense_Reminders_App SHALL deny the requested tracker-data access or Synchronization action.
4. WHEN the HTML_Dashboard receives an access request that does not satisfy the selected authorization policy, THE HTML_Dashboard SHALL deny the requested Authoritative_Dataset access or update action.
5. WHERE the encryption design decision is satisfied, THE Credit_Card_Expense_Reminders_App SHALL protect tracker data with encryption at rest and during Synchronization according to the encryption design decision.
6. WHERE the encryption design decision is satisfied, THE NAS SHALL protect the Authoritative_Dataset with encryption at rest and during authorized access according to the encryption design decision.

### Requirement 13: Original and Licensed Product Material

**User Story:** As a product owner, I want the application to use original and permitted material, so that reference projects inform the work without unauthorized copying.

#### Acceptance Criteria

1. THE Credit_Card_Expense_Reminders_App SHALL use original application logic and user-interface material rather than copying source code or non-commercially restricted assets from a Reference_Project.
2. WHEN the Credit_Card_Expense_Reminders_App includes material from a third party, THE Credit_Card_Expense_Reminders_App SHALL include only material whose license permits the intended use.

## Open Decisions

The following decisions are intentionally unresolved and must be confirmed during design or requirement refinement:

1. The NAS technology, hosting arrangement, dashboard serving approach, backup-snapshot retention policy, and recovery process.
2. The authentication, authorization, privacy, credential-recovery, and encryption model for at least three Authorized_Household_Users.
3. The peer-discovery and peer-to-peer transport approach for authorized Flutter devices on the home network.
4. The Synchronization_Conflict merge and resolution policy, including available user choices, record-level or field-level behavior, and post-resolution history retention.
5. The exact local reminder configuration, including default lead times, multiple reminders per obligation, time-zone behavior, notification-permission handling, and delivery behavior after device restart.
6. Whether an Excel import capability is required for one-time migration, and which spreadsheet columns and historical records it must support.
7. The supported JSON schema versions, export/import location flow, and Data_Export recovery behavior beyond invalid or corrupt data rejection.
8. The exact supported Android versions and device range.
9. Whether Hive is suitable for Flutter local storage after evaluating reliability, migrations, query needs, offline synchronization behavior, encryption compatibility, and Data_Export interoperability.
10. The dashboard comparison and chart types, selectable date ranges, and whether category or per-card breakdowns are required.


### Requirement 14: Fixed Deposits and Bond Payments

**User Story:** As a household member, I want to record fixed deposits and bond payouts with their important dates and values, so that I can track investment maturity and expected bond payments alongside my household finances.

#### Acceptance Criteria

1. WHEN an Authorized_Household_User creates a Fixed_Deposit, THE Credit_Card_Expense_Reminders_App SHALL record the Fixed_Deposit number, principal amount, maturity date, and one interest value.
2. WHEN an Authorized_Household_User records a Fixed_Deposit interest value, THE Credit_Card_Expense_Reminders_App SHALL record whether the interest value is an annual percentage rate or a fixed monetary amount.
3. WHEN an Authorized_Household_User creates a Fixed_Deposit, THE Credit_Card_Expense_Reminders_App SHALL validate that its number is non-empty, its principal amount is positive, its maturity date is valid, and its interest value is non-negative.
4. WHEN an Authorized_Household_User creates a Bond_Payment, THE Credit_Card_Expense_Reminders_App SHALL record the bond name or identifier, payment date, and expected payment amount.
5. WHEN an Authorized_Household_User creates a Bond_Payment, THE Credit_Card_Expense_Reminders_App SHALL validate that the bond name or identifier is non-empty, its payment date is valid, and its expected payment amount is positive.
6. WHEN a Fixed_Deposit reaches its configured maturity reminder time, THE Credit_Card_Expense_Reminders_App SHALL deliver a Local_Notification identifying the Fixed_Deposit number, maturity date, and principal amount.
7. WHEN a Bond_Payment reaches its configured payment reminder time, THE Credit_Card_Expense_Reminders_App SHALL deliver a Local_Notification identifying the bond name or identifier, payment date, and expected payment amount.
8. WHEN an Authorized_Household_User views the Flutter dashboard or HTML_Dashboard, THE applicable dashboard SHALL display upcoming Fixed_Deposit maturity dates and Bond_Payment dates with accessible status information.
9. WHEN the Credit_Card_Expense_Reminders_App calculates a Billing_Month payment total, THE Credit_Card_Expense_Reminders_App SHALL exclude Fixed_Deposit principal amounts, Fixed_Deposit interest values, and Bond_Payment expected payment amounts from the total.
10. WHEN a Fixed_Deposit or Bond_Payment submission contains an invalid field, THE Credit_Card_Expense_Reminders_App SHALL retain every submitted field value and identify each invalid field with corrective feedback.


### Requirement 15: Portfolio Groups

**User Story:** As a household member, I want to organize credit cards, fixed deposits, and bond payments into named groups, so that I can view related financial records together without changing their values or totals.

#### Acceptance Criteria

1. WHEN an Authorized_Household_User creates a Portfolio_Group, THE Credit_Card_Expense_Reminders_App SHALL record a non-empty group name.
2. WHEN an Authorized_Household_User adds a supported financial record to a Portfolio_Group, THE Credit_Card_Expense_Reminders_App SHALL record the Group_Membership between the Portfolio_Group and the selected Credit_Card, Fixed_Deposit, or Bond_Payment.
3. WHEN an Authorized_Household_User adds a financial record that is already a member of a Portfolio_Group to the same Portfolio_Group, THE Credit_Card_Expense_Reminders_App SHALL retain one Group_Membership only.
4. WHEN an Authorized_Household_User removes a financial record from a Portfolio_Group, THE Credit_Card_Expense_Reminders_App SHALL remove only the selected Group_Membership and SHALL retain the financial record.
5. WHEN an Authorized_Household_User views a Portfolio_Group in the Flutter dashboard or HTML_Dashboard, THE applicable dashboard SHALL display the Portfolio_Group name and its member Credit_Cards, Fixed_Deposits, and Bond_Payments.
6. WHEN an Authorized_Household_User filters the Flutter dashboard or HTML_Dashboard by a Portfolio_Group, THE applicable dashboard SHALL display only records that are members of the selected Portfolio_Group.
7. WHEN the Credit_Card_Expense_Reminders_App calculates payment totals, paid or remaining amounts, or card-wise comparison series, THE Credit_Card_Expense_Reminders_App SHALL calculate every financial record once regardless of its Group_Memberships.
8. WHEN the Credit_Card_Expense_Reminders_App synchronizes or exports a Portfolio_Group or Group_Membership, THE Credit_Card_Expense_Reminders_App SHALL retain its Record_Identity and Revision_Metadata.
9. WHEN a Portfolio_Group or Group_Membership submission contains an invalid field, THE Credit_Card_Expense_Reminders_App SHALL retain every submitted field value and identify each invalid field with corrective feedback.