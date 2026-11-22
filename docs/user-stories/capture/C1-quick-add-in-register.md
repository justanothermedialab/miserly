# C1 — Quick-add a transaction in an account register

> **Epic:** Capture · **Story:** C1 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD only, zero intelligence. This is the make-or-break entry loop.

---

## Title
As the user, sitting in an account's register, I can add a transaction in seconds using the
keyboard — date, payee, optional category, and an explicit inflow/outflow amount — and immediately
see a correct running balance, so that logging even a ₹1.71 bank charge is faster and nicer than
Actual Budget.

## ELI5
The register is the cheque-book page for one account — a list of every transaction with the
balance after each. This story is "let me type a new line fast." I hit a key, a blank row opens
with today's date, I type who/how much, hit Enter, and it's saved — and if I want to add ten in a
row, Enter just keeps opening the next blank row. The balance on the right is always right, even
if I slot one in on an old date.

## Business context
This is **the** story the whole product hinges on. The user logs *everything*, manually, by
choice — so if entry is slower or clunkier than Actual's keyboard-driven register, he won't switch,
and an incomplete ledger is worthless to him. Parity-or-better with Actual's register is the bar
(it's table-stakes, not the wedge — the instrument modules are the wedge — but failing it kills
adoption regardless).

Two things must be true at once:
1. **Entry is keyboard-first and fast.** Match Actual's model: `T` opens a new transaction with the
   date picker ready; **Enter commits and immediately opens the next blank row** (rapid sequential
   logging); `Ctrl/Cmd+Enter` commits a single transaction without opening another; field keys jump
   to date/payee/category/amount ([Actual tips & tricks](https://actualbudget.org/docs/getting-started/tips-tricks/),
   [single-entry shortcut #3060](https://github.com/actualbudget/actual/issues/3060)).
2. **The running balance is always correct** — including when a transaction is added on a past (or
   future) date. Actual has an open bug where **same-date transactions sort wrong and corrupt the
   running balance** ([#3928](https://github.com/actualbudget/actual/issues/3928)); the only
   workaround is manually re-dating. Our locked data model (balance = opening + Σtx, derived, never
   cached-to-drift) plus an explicit ordering key lets us **beat** the incumbent here.

This story covers **single-account register entry only**. Global quick-add = C2; transfers = C3;
edit/delete/reorder/back-date mechanics = C4; the uncategorized inbox = C5.

## User workflow

### Happy path — add one
1. User is in an account register. Presses **`T`** (or clicks **Add**) → a blank entry row opens
   with **Date = Today**, cursor ready.
2. Tabs/types through: **Payee** (autocomplete, F3) → **Category** (optional; pre-fills from payee
   if blank, F3) → **Inflow** *or* **Outflow** amount → optional **Notes**.
3. Presses **`Ctrl/Cmd+Enter`** → transaction saved; row closes; running balance updates.

### Happy path — add many (the power loop)
1. Press `T`, fill the row, press **Enter** → saved **and a new blank row opens** with Date = the
   same/just-used date, cursor at the first field.
2. Repeat rapidly. The user can log a batch (e.g. a week of catch-up from bank SMS) without
   touching the mouse.

### Alt path — back-dated or future-dated entry
- User changes Date to a past date (catch-up) or a future date (known upcoming charge — allowed per
  F1). On save, the row lands in correct date order and the running balance recomputes correctly for
  all rows (no manual re-dating, unlike Actual). Future-dated handling for "today's balance" — see
  Resolved decisions.

### Recovery path — incomplete entry
- User saves with no category → transaction persists as **uncategorized** and surfaces in the C5
  inbox (entry never blocks on categorization — anti-perfectionism).
- User enters both inflow and outflow, or neither → validation stops the save with a clear inline
  message (see Validation).

## Acceptance criteria
- [ ] `T` (and an Add button) opens a new entry row with **Date defaulted to Today** and focus ready.
      *(Amended 2026-10-15, to match Actual: no single-letter row keys; the New
      transaction button, or Ctrl+N, opens the row.)*
- [ ] **Enter** commits and opens the next blank row; **Ctrl/Cmd+Enter** commits without opening a
      new row.
- [ ] A transaction can be saved with only **date + an amount in exactly one of Inflow/Outflow**;
      payee, category, and notes are all optional.
- [ ] **Inflow and Outflow are two explicit fields/columns** (not a signed amount, not inferred from
      category) — our locked direction model.
- [ ] Payee field autocompletes existing payees and can create a new one inline (F3); selecting a
      payee with a remembered category **pre-fills the category only if the category field is empty**
      (F3 fill-when-blank).
- [ ] The register shows a **running balance** column that is correct after every row.
- [ ] Adding a transaction on a **past date** inserts it in correct date order and the running
      balance for all affected rows is recomputed correctly (explicitly beats Actual #3928).
- [ ] **Same-date** transactions have a deterministic, stable order (via a sequence key), so the
      running balance is unambiguous and reproducible.
- [ ] The account's displayed balance is always recomputed from `opening + Σtx` (never a cached
      value that can drift).
- [ ] Amounts are entered in the **account's native currency** (no conversion here; multi-currency
      epic handles base conversion).
- [ ] Every created transaction stamps **`entered_by` = the current user** (authorship/audit, not an
      economic split); on a **shared** account the register may surface it so co-members see who logged a
      row ([H3](../circle/H3-roles-and-membership.md)).

## Validation rules
- **Date:** required; defaults to Today; may be past or future (F1-consistent). Must be a valid date.
- **Amount:** exactly **one** of Inflow / Outflow must be non-empty and > 0. Both-filled or
  both-empty → reject with inline message. Amount precision = currency's minor units (₹ → 2 dp).
- **Payee:** optional; if typed-new, creates a payee (F3 rules: trim, case-insensitive dedupe).
- **Category:** optional; must be an existing non-hidden category if set (F2); may be left blank
  (→ inbox).
- **Notes:** optional free text.
- **Sign convention:** Inflow increases the account's balance in its natural direction; Outflow
  decreases it. For a **liability** account (e.g. credit card), the module defines how inflow/outflow
  map to "owe more / owe less" — the register labels must read correctly for liabilities (see Edge
  cases).

## Edge cases
- **Liability register wording:** on a credit card, an "Outflow" (a purchase) *increases* what you
  owe. Labels/columns must make sense for liabilities, not just asset accounts (e.g. "Charge" vs
  "Payment", or clear inflow/outflow semantics tied to the module's side).
- **Zero / negative typed amount:** reject (amount must be > 0 in its chosen column; direction is
  expressed by which column, never by a minus sign).
- **Future-dated transaction:** appears in the register (above today's rows in date-desc order); its
  effect on the *displayed account balance today* is handled by the as-of-today / projected split
  (see Resolved decisions).
- **Many same-date entries (catch-up batch):** all share a date; the sequence key preserves entry
  order; running balance stays correct and stable across reloads.
- **Very large register (years of per-paisa data):** recompute/display must stay fast — derived
  balance with on-demand computation; periodic snapshot/caching is a known optimisation if needed
  (not premature in MVP).
- **Decimal/locale input:** accept Indian-format input gracefully; store canonical decimal.
- **Opening-balance row** (F1) is the first/earliest row and anchors the running balance.

## Failure cases
- **Save fails mid-write:** entry must be atomic — either the transaction is fully persisted and the
  balance reflects it, or nothing is saved and the row stays open with the user's input intact (never
  lose typed data).
- **Running balance disagrees with the account/dashboard balance:** must be impossible by
  construction — one computation (`opening + Σtx` over the same ordered set) feeds both. Any
  divergence is a P0 (this is the original "inconsistent data across screens" failure we are
  structurally preventing).
- **Autocomplete/category lookup latency** must not block typing — fields stay responsive; a slow
  lookup degrades to plain text, never freezes the row.
- **Duplicate accidental Enter** (double-commit) must not create a phantom duplicate row.

## UX considerations
- **The Enter-to-continue loop is the single most important interaction** — it must be flawless and
  feel faster than Actual. Focus management on the new blank row has to be perfect (cursor in the
  first field, sensible date carried over).
- **Date = Today with a "Today" affordance** (not just a date string) — removes friction for the
  overwhelmingly common case ([NN/g date input](https://www.nngroup.com/articles/date-input/)).
- **Inflow/Outflow as two columns** keeps direction explicit and glanceable in the register, matching
  the mental model of a cheque book; keyboard flow should let the user land in the right column fast.
- **Fast numeric amount entry** (numpad-friendly on touch; no steppers for money) — money is typed,
  not nudged ([fintech UX](https://www.theuxda.com/blog/top-20-financial-ux-dos-and-donts-to-boost-customer-experience)).
- **Running balance visible by default — make the register read like a bank passbook** (LOCKED):
  a clean, familiar date / particulars / withdrawal / deposit / balance layout. Actual hides the
  running balance behind a toggle; we lead with it, because the passbook metaphor is exactly the
  mental model our user has and it makes the "balance is always right" promise visible at a glance.
- **Keyboard help (`?`)** discoverable, listing the shortcuts.
- **No "cleared/reconciled" column** (deferred) — keep the row lean.

## Operational considerations
- **Ordering key:** every transaction carries `(date, sequence)` where `sequence` is a stable
  monotonic tiebreaker within a date (assigned on insert; reorderable in C4). All balance
  computations and the register sort by `(date, sequence)` — **never by row id / insert order**.
  This is the concrete fix for an earlier prototype's `id<=up_to_id` fragility and Actual #3928.
- **Single balance computation** shared by register running-balance, account header, net worth, and
  dashboard — one function, one source of truth.
- **Performance:** O(n) recompute on change is fine at personal scale; design the computation so a
  snapshot/cache layer can be added later without changing the contract.
- **Offline in desktop mode:** entry, autocomplete, and balance update need no internet; in hosted mode
  the client talks to the app server (architecture §11).

## Resolved decisions (locked 2026-06-20)
1. **Same-date ordering = newest entry on top** within a date (date-desc view) (LOCKED). A stable
   `sequence` tiebreaker is created on insert now; **manual drag-reorder UI is deferred to C4**.
2. **Future-dated transactions = option (b)** (LOCKED): the account shows a **"balance as of today"**
   (Σtx where date ≤ today) **plus** a separate **projected balance**; future-dated rows appear above
   a divider in the register. Net worth and dashboard use the as-of-today figure. *(This convention
   propagates to every balance display app-wide.)*
3. **Running balance shown by default, styled like a bank passbook** (LOCKED): date / particulars /
   withdrawal / deposit / balance. Not an opt-in toggle.
4. **Inflow/Outflow = two literal columns** in the register (LOCKED). A single amount + direction
   toggle is acceptable for the global quick-add form (C2), but the register table uses two columns.
5. **Enter-loop carry-over = date only** (LOCKED): the next blank row keeps the date; payee,
   category, amount, notes all start empty to avoid accidental wrong-payee entries.

**Amendments (2026-10-05, each chosen from options with their evidence):**

6. **Density target: at least 18 rows at 1366×768**: the first transaction row at or above
   190 px, 32 px rows, **date as a column** (no date header rows), the account's name and balance on
   one line, a **one-row toolbar** (search, a filter button opening a popover, New) instead of the
   filter card, and the **new-transaction row inside the grid**. Done when a re-count of the
   rows confirms it.
7. **A half-filled new row is kept as a draft**: navigating away keeps the unsaved row
   for that account and restores it, with focus, on return (also across a reload in the same session).
   Saving, Esc or an explicit discard clears it. Nothing is written to the ledger until it is saved.
8. **Colour** (see D1 RD7): the Withdrawal column red, the Deposit column green; the running
   balance column stays muted, as in the option chosen.

## Circle addendum (Epic 8 · multi-user)

> Added 2026-06-25 by the [Circle epic](../circle/README.md) writeback (D6). Entry gains an **authorship
> stamp** and is scoped to visible accounts.

- **`entered_by` stamp.** Every transaction created here records **who logged it** (the current user) —
  audit/history, **not** economic attribution. One author-stamp mechanism shared with C2/C3.
- **Visible accounts only.** A member can only open/enter into accounts in their visible set (owned ∪
  member-of, [H2](../circle/H2-account-ownership-and-sharing.md)); a private account of another member
  is not reachable.
- **Surfacing on shared accounts:** the register may show `entered_by` so co-members can see who logged a
  row (the by-member breakdown it fed in [R2/R3](../reports/R2-spending-by-category.md) was dropped
  2026-10-30, R2 RD11). Personal
  reference data (payee autocomplete, last-category) stays per-user ([F3](../foundations/F3-payees.md)).
- **AC delta:** each created row carries `entered_by = current user`. **Folded into the canonical
  Acceptance criteria above (2026-06-25, MODE 2.5 M1).**

## Dependencies
- **Depends on:** F1 (accounts + opening balance + the `opening + Σtx` model), F2 (categories for the
  optional category), F3 (payee autocomplete + fill-when-blank pre-fill + unified picker).
- **Blocks / precedes:** C2 (global quick-add reuses this entry component), C3 (transfers add a
  second linked row via the same register), C4 (edit/delete/reorder builds on this row + the
  `(date, sequence)` ordering), C5 (the inbox consumes uncategorized rows created here).
- **Excludes:** transfers (C3), splits (dropped), cleared/reconciliation (deferred), cash machinery
  (ignored), cross-currency entry (Multi-currency epic), and the *reorder UI* (C4).

---

### Research sources
- Actual Budget — keyboard shortcuts / fast entry (`T`, Enter-continues, field keys), single-entry
  shortcut: https://actualbudget.org/docs/getting-started/tips-tricks/ ;
  https://github.com/actualbudget/actual/issues/3060
- Actual Budget — running balance column (opt-in, date-desc only): docs tips & tricks (above)
- Actual Budget — **same-date ordering / running-balance bug** (#3928) we explicitly beat:
  https://github.com/actualbudget/actual/issues/3928
- Running-balance correctness — effective/transaction date over insert order; snapshots/caching for
  history; transaction-level integrity: https://www.blnkfinance.com/blog/understanding-balances-in-ledgers
- Entry UX — date defaults to "Today"; numeric input best practice: https://www.nngroup.com/articles/date-input/ ;
  https://www.theuxda.com/blog/top-20-financial-ux-dos-and-donts-to-boost-customer-experience
