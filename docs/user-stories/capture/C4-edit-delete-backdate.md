# C4 — Edit, delete & back-date a transaction

> **Epic:** Capture · **Story:** C4 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD only, zero intelligence. Includes transfer-edit mechanics handed up from C3.

---

## Title
As the user, I can correct, re-date, reorder, bulk-edit, or delete transactions — including
transfers — and trust that the running balance and net worth always stay correct, so my ledger
matches reality after the inevitable typo, late entry, or statement reconciliation-by-eye.

## ELI5
I make mistakes and I log things late. This story is "let me fix anything." Change the amount, fix
the payee, move it to the right date, drag two same-day entries into the right order, select twenty
rows and categorize them all at once, or delete a wrong one (and undo if I delete the wrong wrong
one). The balance on the right always re-adds itself correctly, no matter what I change.

## Business context
For a completionist who logs everything — often late, from memory or bank SMS — **editing is as
important as adding**. Two things make or break it:

1. **Correctness under change.** Our locked model (balance = opening + Σtx, ordered by
   `(date, sequence)`, never by insert id) means editing a date, amount, or order **recomputes the
   running balance correctly every time**. This is the concrete payoff of the C1 ordering design and
   the fix for Actual's same-date bug (#3928) and an earlier prototype's `id<=up_to_id` fragility.

2. **Editing power that matches the volume.** Actual sets the bar: inline field edits, multi-select +
   **bulk** set-category/payee/notes and bulk delete, duplicate, undo
   ([Actual bulk actions](https://actualbudget.org/docs/transactions/bulk-editing/)). Bulk editing is
   what makes catch-up batches and clearing the C5 "to categorize" inbox bearable.

This story also absorbs the **transfer-edit mechanics** C3 deferred here: editing a transfer syncs
both rows; setting/clearing a payee-as-account **converts** a transaction to/from a transfer;
changing a transfer's account **re-points** the partner; deleting either side deletes both.

A genuine differentiator lands here too: **drag-reorder of same-date transactions**, a feature users
beg for in YNAB/Quicken/Moneydance and rarely get ([YNAB request](https://steamcommunity.com/app/227320/discussions/0/45350790659882342/),
[Quicken](https://community.quicken.com/discussion/7950906/)). We get it almost for free via the
`sequence` key.

## User workflow

### Happy path — edit one field
1. In the register, user clicks a cell (or presses a field key) and edits **date / payee / category /
   amount / direction / notes** inline.
2. On commit, the row updates and the running balance (and any downstream totals) recompute.

### Happy path — back-date / re-date
1. User changes a transaction's **date** to an earlier (or later) day.
2. The row re-sorts into correct `(date, sequence)` position; running balance for all affected rows
   recomputes; the as-of-today vs projected split (C1) updates if it crossed today.

### Happy path — reorder same-date
1. Two transactions share a date in the wrong order. User **drags** one above the other (or uses a
   move up/down action).
2. Their `sequence` updates; running balance reflects the new order.

### Happy path — bulk edit
1. User multi-selects rows (checkboxes; `Ctrl/Cmd+A` select-all; shift-range).
2. Applies a **bulk action**: set category, set payee, set notes, or **delete**.
3. All selected rows update atomically; balances recompute.

### Alt path — transfer edits (from C3)
- Edit amount/date/notes on a transfer → **both rows sync** (between currencies the other amount
  stays and the rate re-derives, MC2 RD4; a member who can't see the other row edits only its memo (Notes on screen),
  H4 RD7).
- Set a normal transaction's payee to "Transfer → <account>" → it **becomes a transfer** (partner
  created); clear it → **reverts** to normal (partner deleted).
- Change a transfer's account → partner **moves** to the new account.
- Delete either side → **both** are deleted.

### Recovery path — undo a delete
- After a delete, an **Undo** affordance (toast / `Ctrl/Cmd+Z`) restores the transaction(s) — for a
  transfer, restores **both** rows.

## Acceptance criteria
- [ ] Any field of a transaction can be edited inline in the register: date, payee, category, amount,
      direction (inflow/outflow), notes.
- [ ] Changing a transaction's **date** re-sorts it correctly and recomputes the running balance for
      all affected rows (back-dated and future-dated both correct).
- [ ] **Same-date transactions can be reordered** (drag or move up/down); the `sequence` persists and
      the running balance follows the new order.
- [ ] **Bulk actions** on a multi-selection: set category and delete. *(Set payee and set notes
      dropped 2026-10-21, RD4.)*
- [ ] **Delete** removes a transaction and recomputes balances; deleting a **transfer** side removes
      **both** sides (atomic, with confirmation).
- [ ] **Undo** restores the last delete (single or bulk; transfers restored as a pair).
- [ ] **Transfer edits sync** both rows (amount mirrored, date/notes copied); exceptions: MC2 RD4
      (two currencies) and H4 RD7 (the other row hidden from the editor).
- [ ] Setting a transaction's payee to a "Transfer → <account>" option **converts** it to a transfer
      (creates partner); clearing it **converts back** (deletes partner).
- [ ] Changing a transfer's account **re-points** the partner row to the new account; all affected
      balances recompute.
- [ ] After **any** edit/delete/reorder, the register running balance, account header, dashboard, and
      net worth all agree (one computation, no drift).

## Validation rules
- All field edits re-apply the **C1 validation** (exactly one of inflow/outflow > 0; valid date;
  category exists if set; payee dedupe per F3).
- **Editing into an invalid state is rejected** inline without losing the user's other edits.
- **Transfer conversion** requires a valid target open account; converting away from a transfer is
  only allowed by clearing the account-payee (not by leaving it ambiguous).
- **Reorder** only reassigns `sequence` *within the same date* — it never changes the date.
- **Bulk category/payee** on a selection that includes **transfers** must skip the transfer rows (a
  transfer can't take a category) and tell the user it did so.

## Edge cases
- **Editing the opening-balance transaction** (F1): allowed (amount/date); it remains the earliest
  anchor row; balances recompute. (This is the "fix a wrong opening balance" recovery path from F1.)
- **Back-dating across the opening balance date:** a transaction dated before the opening row — define
  ordering (opening row should stay the conceptual start, or the earlier tx genuinely precedes it).
  See Resolved decisions.
- **Bulk delete including one side of several transfers:** each transfer's partner is also removed;
  the count shown to the user should reflect the true number of rows affected.
- **Reordering when the running balance column is the user's anchor:** order changes can flip a
  balance positive/negative mid-list; that's correct, not a bug.
- **Editing amount on a transfer to a value that overdraws an account:** allowed (we don't enforce
  non-negative balances — overdrafts/credit are real); no block.
- **Undo after further edits:** define how far undo reaches (last action only vs a stack) — see Open
  Questions.
- **Converting a transaction with a category into a transfer:** the category is dropped (transfers
  have none); warn if a category was set.

## Failure cases
- **Partial bulk apply:** a bulk edit/delete must be atomic over the selection — all or nothing —
  so balances never reflect a half-applied batch.
- **Transfer desync via edit:** impossible by construction — transfer edits go through the C3 paired
  service; one side can never be edited in isolation into divergence.
- **Orphaned transfer partner after delete/convert:** impossible — partner lifecycle is tied to the
  operation atomically.
- **Balance drift after edit:** any disagreement between register/header/dashboard/net worth is P0
  (the original "inconsistent data across screens" failure mode we structurally prevent).
- **Lost edits on validation failure:** rejecting an invalid edit must preserve the rest of the
  user's input.

## UX considerations
- **Inline editing is primary** (Actual-style fast field edits with `E/P/N/C/M`); a fuller **detail
  view** is available for less-frequent edits (transfer conversion, viewing the linked partner).
- **Drag-reorder is the standout** — make same-date reordering obvious and satisfying (a drag handle
  on same-date rows, or up/down on a selected row). It's the feature competitors lack.
- **Bulk actions surface on selection** (a contextual toolbar showing count + actions), matching the
  muscle memory of switchers from Actual.
- **Undo is reassuring** — a toast "Deleted — Undo" plus `Ctrl/Cmd+Z`; critical for a completionist
  who fears losing data.
- **Transfer edits clearly communicate two-sidedness** ("This is a transfer — changes apply to both
  accounts").
- **Date edits feel safe** — the row visibly moves to its correct place; no silent balance weirdness.

## Operational considerations
- **One edit/delete service** shared by inline edits, the detail view, and bulk actions → consistent
  validation + balance recomputation, no path-specific drift (continues the C1/C2/C3 single-service
  discipline).
- **`sequence` reassignment** on reorder and on date-change is the only ordering mechanism; balances
  always sort by `(date, sequence)`.
- **Atomicity:** every mutation (single, bulk, transfer-pair, convert, re-point) is wrapped in one
  atomic write; a crash leaves a consistent state.
- **Undo** needs a lightweight reversible-operation record (at least last-action); runs in-process in
  desktop mode and via the app server in hosted mode (no extra service).
- **Performance:** recompute on edit stays O(n) at personal scale; the snapshot/cache option from C1
  applies if large registers get slow.

## Resolved decisions (locked 2026-06-20)
1. **Undo = last-action undo for deletes** (LOCKED): toast + Ctrl/Cmd+Z restores the last
   deleted transaction(s); a transfer restores as a pair. A fuller multi-step undo stack is later.
2. **Duplicate a transaction = IN** (LOCKED): clone a row (Actual's `U`) for fast repetitive entry;
   cheap and on-brand for a heavy manual logger.
3. **Reorder interaction = BOTH** (LOCKED): drag-and-drop **and** move up/down on same-date rows;
   both write the `sequence` key. (Up/down guarantees keyboard/precision; drag is the satisfying path.)
4. **Bulk actions in MVP = delete + set category + set payee + set notes** (LOCKED); bulk set-date /
   move-account deferred.
   *Amended 2026-10-21 (a review of the backlog asked why anyone would bulk-edit either):*
   bulk actions are **set category and delete** only. Bulk set payee and set notes are dropped:
   merging payees (F3) fixes a payee across rows, and notes aren't used as tags.
5. **Pre-opening-dated transactions allowed** (LOCKED): the opening-balance row sorts first on its
   own date; a transaction genuinely dated earlier sorts before it (it just means there was activity
   before the stated start). Not blocked.
6. **Nothing on a closed account changes, Undo and reorder included** (2026-11-06,
   after a review of the app). Undo of a delete (single or
   bulk, all or nothing) and a same-date reorder are refused on a closed account, as edit, delete,
   duplicate and move already were: "This account is closed. Reopen it to change its rows." *Why:*
   an Undo after the close put money back on a closed account, and a reorder past the closing row
   re-derived a value update, so a closed account held money the headline didn't count.
7. **A moved row keeps its category** (2026-11-06, after a review of the app). All transactions'
   Account cell moves an ordinary row with its category, onto a holding too (it cleared it there,
   as Actual does moving on budget to off budget); a transfer's category still goes to whichever
   leg takes one. *Why:* categorised rows on holdings count (R3 RD11), so clearing it dropped
   income: EPF's ₹7,200 Salary row moved off the bank stopped being income.
8. **A closed account's rows take a category, and nothing else** (2026-11-06, after a review
   of the app; the one exception to RD6). An ordinary row on a closed account can be categorised:
   in its register's Category cell, in To categorize, or by bulk set category. Its amount, date,
   payee, memo and account stay frozen, as do transfers and value updates; a click on another cell
   says "This account is closed: only a row's category can change. Reopen it to change the rest".
   *Why:* a category moves no money, and without it a closed account's uncategorised rows sat in
   To categorize and in Reports' "Uncategorized" for good. Actual allows every edit on a closed
   account (closing hides only Import and bank sync, checked in its source); we keep the money
   frozen.

> **Build reconciliation (2026-07-12 — see F1 Resolved decisions 9–11):** the opening balance is a
> dated **column**, not a transaction row, so "editing the opening-balance transaction" (the edge case
> above) = editing the account's opening amount/date via a small F1 surface, not a C4 row edit. The
> synthetic "Starting balance" register row renders at `opening_date`; pre-opening-dated rows (RD5)
> still sort before it by date and simply contribute from their own date.

## Dependencies
- **Depends on:** C1 (entry component, `(date, sequence)` ordering, derived balances), C3 (transfer
  pair service — edit/convert/re-point/delete-both live here), F2 (categories for bulk set-category),
  F3 (payees for bulk set-payee + transfer-conversion picker).
- **Feeds:** C5 (the inbox leans on bulk set-category to clear backlog efficiently).
- **Excludes:** cross-currency edits (Multi-currency epic), split editing (splits dropped),
  cleared/reconciliation toggles (deferred), instrument-specific edits (per-instrument epic).

---

### Research sources
- Actual Budget — Bulk actions (multi-select, Ctrl/Cmd+A, bulk set category/payee/notes, `D` delete,
  `U` duplicate): https://actualbudget.org/docs/transactions/bulk-editing/ ;
  https://actualbudget.org/docs/getting-started/tips-tricks/
- YNAB — Edit & delete transactions: https://support.ynab.com/en_us/how-to-edit-and-delete-transactions-BJG4oS1s
- Same-date reorder as an unmet need (YNAB/Quicken/Moneydance): https://steamcommunity.com/app/227320/discussions/0/45350790659882342/ ;
  https://community.quicken.com/discussion/7950906/ ; https://infinitekind.tenderapp.com/discussions/general-questions/352-reordering-transactions
- Actual Budget — Transfers (edit-syncs-both, delete-removes-both) — basis for transfer edits:
  https://actualbudget.org/docs/transactions/transfers/
