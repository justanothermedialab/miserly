# Epic 1 — Foundations

> The first bricks. Nothing else (transactions, transfers, net worth, charts) can exist without the
> reference entities defined here. Independent of each other where possible; all three block Capture.

## Goal

Establish the three standalone entities the rest of the app references: **accounts** (the money
containers, transaction-based from birth), **categories** (the classification taxonomy with kinds),
and **payees** (the reusable "who", with a light remember-last-category helper).

## Scope

**In:** account creation within a module + opening balance as a transaction + close/reopen (closed,
not deleted); user-defined category groups/categories carrying a kind (Income/Spending/Neutral); payee
entities with autocomplete, merge, and a deterministic remembered-category pre-fill.

**Out:** transaction entry itself (→ Capture), budgets/limits/envelopes (permanently out), a rules
engine / behaviour-learning auto-categorization (v2), account Delete (deferred — Close only), tags.

## Features → stories

### Feature 1.1 — Accounts & lifecycle
- [**F1** — Account lifecycle](F1-account-lifecycle.md) — create in a module; opening balance as the
  first transaction (no stored value); close-by-transfer or force-close; reopen; PPF/EPF ≤1-active
  soft-warn; type & currency immutable in MVP.

### Feature 1.2 — Categories & kinds
- [**F2** — Categories & groups](F2-categories-and-groups.md) — two-level Group→Category; **kind** on
  the group (Income/Spending/Neutral), inherited; hide vs delete-with-reassignment; optional colour;
  signed-within-kind nets refunds. *The correctness backbone every report reads.*

### Feature 1.3 — Payees
- [**F3** — Payees](F3-payees.md) — first-class entities; fast autocomplete; rename-propagates; merge
  duplicates; **remember-last-category = fill-when-blank** (never auto-overwrites); the unified picker
  also surfaces "Transfer → <account>" (no shadow payee rows).

### Feature 1.4 — Import
- [**F4** — Import from Actual Budget](F4-import-from-actual.md) — Actual's export zip; a preview
  (Add as, plain deposits, Invested and Value) before anything is written; re-import by Actual's
  ids; Undo import (2026-11-10).

## Backbone leaned on

[Single source of truth](../../product/architecture.md#1-single-source-of-truth--derived-never-stored)
(opening balance is a transaction) · [valuation-mark primitive](../../product/architecture.md#4-valuation-marks-mark-to-market)
(shared with opening/force-close) · [module registry](../../product/architecture.md#5-per-instrument-modules-behind-one-aggregation-contract)
· [F2 kinds](../../product/architecture.md#6-spending-vs-holding-f2-kinds) · [closed-not-archived](../../product/architecture.md#10-lifecycle-closed-not-archived).

## Key locked decisions

- Opening balance = the account's **first transaction** ("Starting balance"), single-sided origin (no
  `Equity:Opening-Balances` account) — zero drift, one code path.
- **Close only, no Delete** in MVP — sidesteps the Firefly transfer-corruption bug class.
- Account **type & currency immutable** after creation (MVP).
- Category **kind editable** after creation; **seed** a starter set on first run; **fill-when-blank**
  payee category is the antidote to "annoyingly set".

## Dependencies

Blocks all of **Capture (C1–C5)** and every downstream chart. F2/F3 share referential integrity (a
payee's remembered category is an F2 category id). The entry-time picker needs F1 accounts to exist.
