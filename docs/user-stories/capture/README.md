# Epic 2 — Capture

> The make-or-break. The user logs *everything*, manually, by choice — so if entry is slower or
> clunkier than Actual's keyboard-driven register, he won't switch, and an incomplete ledger is
> worthless to him. Parity-or-better with Actual's register is the bar; the running balance must be
> bulletproof.

## Goal

A keyboard-first entry/edit loop that's faster and nicer than Actual, with a running balance that's
**always correct** — including under back-dated inserts and same-date reordering — plus the
double-entry transfer mechanism and an anti-perfectionism categorization inbox.

## Scope

**In:** in-register quick-add and a global action-first quick-add (one shared create path); explicit
inflow/outflow columns; same-currency transfers (two linked rows, both creation paths); edit / delete
/ back-date / reorder / bulk-edit / undo, incl. transfer-edit mechanics; the To-categorize inbox.

**Out:** cross-currency transfers (→ Multi-currency), splits (dropped), cleared/reconciliation
(deferred), cash machinery (ignored — only an "ATM Withdrawal" category), asymmetric contribution-to-
holding (→ instruments), auto-categorization/rules (v2).

## Features → stories

### Feature 2.1 — Transaction entry
- [**C1** — Quick-add in a register](C1-quick-add-in-register.md) — the core loop: `T` opens a row,
  Enter commits-and-continues, two inflow/outflow columns, passbook running balance, `(date, sequence)`
  ordering (beats Actual #3928).
- [**C2** — Global quick-add](C2-global-quick-add.md) — action-first overlay (Cmd/Ctrl+K palette,
  Cmd/Ctrl+Shift+N), account as a field, **same machinery as C1** (no divergence).

### Feature 2.2 — Transfers
- [**C3** — Transfer between accounts](C3-transfer-between-accounts.md) — same-currency, two linked
  rows (`transfer_partner_id`), inline + From→To paths, excluded from spending, net-worth-invariant.

### Feature 2.3 — Editing & correction
- [**C4** — Edit, delete & back-date](C4-edit-delete-backdate.md) — inline edits, back-date/reorder
  (the standout same-date drag), bulk actions, undo; absorbs the transfer edit/convert/re-point/
  delete-both mechanics deferred from C3.

### Feature 2.4 — Categorization workflow
- [**C5** — To-categorize inbox](C5-to-categorize-inbox.md) — a derived view (no stored flag) of
  uncategorized non-transfer spending rows; clear inline or in bulk; "all caught up".

## Backbone leaned on

[`(date, sequence)` ordering](../../product/architecture.md#2-ordering-key-date-sequence) ·
[double-entry transfers](../../product/architecture.md#3-double-entry--transfers) ·
[single source of truth](../../product/architecture.md#1-single-source-of-truth--derived-never-stored) ·
[shared-service discipline](../../product/architecture.md#11-shared-service-discipline--deployment-model) ·
[as-of-today vs projected](../../product/architecture.md#8-as-of-today-vs-projected).

## Key locked decisions

- **Inflow/Outflow = two literal columns** in the register (a single amount + toggle is fine only for
  the C2 modal); direction is never inferred from category or sign.
- **Enter-loop carries the date only**; same-date order = newest on top; reorder via drag **and** up/down.
- **Fluid normal ↔ transfer conversion** via the payee field (principle in C3, mechanics in C4).
- **Inbox scope = spending-type accounts only**; membership is a live query, not a stored state.

## Dependencies

Depends on **Foundations** (F1 accounts, F2 categories, F3 payees + unified picker). Feeds the
Dashboard (recent activity, balances), Reports (the ledger), and the per-instrument holding model
(contributions are transfers). Cross-currency transfers extend C3 in [MC2](../multi-currency/MC2-cross-currency-transfer.md).
