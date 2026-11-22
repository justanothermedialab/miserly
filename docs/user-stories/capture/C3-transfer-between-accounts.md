# C3 — Transfer between accounts (same currency)

> **Epic:** Capture · **Story:** C3 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD only, zero intelligence. Same-currency ledger↔ledger transfers only.

---

## Title
As the user, I can move money between two of my own accounts as a single action — either inline
(by setting a transaction's payee to the destination account) or via an explicit From→To form — and
Miserly records it as **two linked rows** that stay in lockstep, never count as spending or income,
and leave my net worth unchanged.

## ELI5
A transfer is moving my own money from one pocket to another — savings → checking, or paying my
credit-card bill from savings. It's not spending (I still have the money) and it's not income. So
Miserly writes it as two matched lines: money leaves one account and the same money arrives in the
other. Change or delete one line and the other follows automatically, so the two can never disagree.

## Business context
Transfers are the **double-entry heart** of the locked data model. They are the mechanism that keeps
net worth correct when money sloshes between accounts, and the reason "balance = opening + Σtx" works
across the whole portfolio. Getting them right (and impossible to desync) is what prevents the
original "inconsistent data across screens" problem at the structural level.

Locked decisions this story implements:
1. **Two linked rows** — an outflow in the source account and an inflow in the destination, linked by
   a `transfer_partner_id`. Updating one **auto-updates** the other; deleting one **deletes both**
   ([Actual transfers](https://actualbudget.org/docs/transactions/transfers/)).
2. **Both creation paths:** (a) **inline** — in a register, set the **payee to "Transfer →
   <account>"** (the F3 unified picker); (b) **explicit "+ Transfer"** From→To form. Both produce the
   same linked pair. We take Actual's *UX* (transfer-as-payee) without its *data* (no shadow payee
   rows — the picker simply offers accounts).
3. **Excluded from spending and income** — transfers carry **no category** and are filtered out of
   cashflow/spending/income analytics. Net worth is **invariant** under a transfer
   ([Firefly](https://docs.firefly-iii.org/explanation/financial-concepts/transactions/)).
4. **Same currency only** in C3. Cross-currency transfers (rate/`to_amount` coupling) are the
   **Multi-currency epic**; the asymmetric contribution-to-holding (e.g. SIP → MF units) is the
   **per-instrument epic**. Both are explicitly out of scope here.

## User workflow

### Happy path — inline (payee as account)
1. In the source account's register, user adds a row, sets **Payee = "Transfer → Savings"** (picked
   from the unified autocomplete, F3).
2. Enters the **amount** as an outflow; saves.
3. Miserly creates the matching inflow row in **Savings**, linked to this one. Both registers now
   show the transfer; neither shows a category; spending/income are unaffected.

### Happy path — explicit From→To form
1. User opens **+ Transfer** (from the global add / a transfer command).
2. Form: **From** account, **To** account, **Amount**, **Date** (Today default), **Notes** (optional).
3. Saves → the same linked pair is created.

### Alt path — edit
- Editing the **amount**, **date**, or **notes** on either row **syncs to the partner** instantly
  (amounts mirror opposite; date/notes copy). The two can never diverge.

### Recovery path — delete
- Deleting either row prompts that **both sides will be removed**, then deletes the pair atomically;
  both account balances and net worth recompute correctly.

## Acceptance criteria
- [ ] A transfer can be created **inline** by setting a transaction's payee to a "Transfer →
      <account>" option; the matching partner row is created automatically in the target account.
- [ ] A transfer can be created via an **explicit From→To form** (From, To, Amount, Date, Notes).
- [ ] A transfer is stored as **two rows linked by `transfer_partner_id`**: an outflow in From, an
      inflow in To, equal amounts (same currency).
- [ ] Transfers have **no category** and are **excluded** from spending, income, and cashflow
      analytics.
- [ ] **Net worth is unchanged** by any transfer (verified for asset→asset, asset→liability
      (debt paydown), and liability→asset cases).
- [ ] Editing **amount / date / notes** on one side **propagates to the partner**; the pair stays
      consistent.
- [ ] Deleting either side **deletes both**, atomically, with a clear confirmation.
      *(Amended: no confirmation; the delete is followed by Undo, which restores the pair (C4), as
      every delete in the app.)*
- [ ] From and To must be **different open accounts** (no self-transfer; no closed accounts), and
      **both legs must be in the actor's visible set** (`owned ∪ member-of`, [H2](../circle/H2-account-ownership-and-sharing.md))
      — you can never move money into/out of an account you can't see (enforced **server-side**); both
      legs stamp **`entered_by` = current user**.
- [ ] Both accounts must share the **same currency** in C3; a different-currency pair is blocked with
      a message pointing to the (future) multi-currency capability.
- [ ] Each side's "payee" displays as the **counterpart account** (auto), not a real payee entity.

## Validation rules
- **From ≠ To:** self-transfer rejected.
- **Accounts:** both must be open (closed accounts not selectable) **and in the actor's visible set**
  (a transfer with any leg outside it is rejected server-side).
- **Same currency:** required in C3; mismatched currencies blocked (deferred to Multi-currency epic).
- **Amount:** > 0; applied as outflow in From and inflow in To (mirrored).
- **Direction for liabilities:** the module's side governs meaning — e.g. savings→credit-card reduces
  the card's outstanding balance (debt paydown); the register wording must read correctly on both
  sides.
- **No category / no inflow+outflow ambiguity:** a transfer row is unambiguously one direction per
  account; it never carries a category.

## Edge cases
- **Asset → liability (credit-card payment):** savings −X, card debt −X (less negative); net worth
  change = 0. Must be representable and correct.
- **Liability → asset / between liabilities:** e.g. balance transfer between two cards; still a
  linked pair, net worth invariant.
- **Back-dated / future-dated transfer:** both rows take the same date; ordering + running balance on
  both registers follow C1's `(date, sequence)` rule and the as-of-today/projected convention.
- **Editing one side's account** (re-point the transfer to a different account): the partner row
  moves to the new account; balances on the old/new/this accounts all recompute. (UI for this may be
  limited in MVP — see Resolved decisions.)
- **Converting a normal transaction ↔ transfer** by changing its payee to/from an account: powerful
  but edge-heavy — see Resolved decisions (likely deferred to C4).
- **Deleting an account that is a transfer partner** (F1): blocked/handled so the partner row never
  dangles — this is the Firefly corruption class we explicitly avoid.

## Failure cases
- **Orphaned half:** it must be impossible to have one transfer row without its partner. Create,
  edit, and delete are all atomic over the pair; a crash mid-operation leaves either a complete pair
  or nothing.
- **Desynced pair** (amounts/dates differ between the two sides): impossible by construction — one
  edit path updates both; any divergence is a P0.
- **Transfer leaking into spending/income charts:** a defect — transfers must be filtered everywhere
  analytics aggregate categories.
- **Net worth drift after a transfer:** impossible by construction; if observed, P0.

## UX considerations
- **Inline transfer feels like a normal entry** — the only difference is the payee is an account
  ("Transfer → Savings"), visually distinct in the picker (↔ icon) so it's never confused with a
  real payee (F3).
- **Explicit From→To form** is the clear, deliberate path for the "I'm moving money" mindset; reachable
  from the global add (C2) and a transfer command.
- **Both registers show the transfer** with the counterpart account as the "payee", so each account's
  passbook reads naturally ("Transfer → Savings" / "Transfer ← Checking").
- **Edit/delete clearly communicate the two-sided nature** ("This is a transfer — changes affect both
  accounts" / "Deleting removes both sides").
- **No category field** shown for a transfer row (it would be meaningless).

## Operational considerations
- **`transfer_partner_id`** links the two rows (mutual reference). All create/edit/delete operations
  treat the pair as one transaction-level unit, wrapped in a single atomic write.
- **Analytics filter:** every spending/income/cashflow query excludes rows where
  `transfer_partner_id IS NOT NULL` (carried from an earlier prototype's analytics, which already did
  this).
- **One create path:** the inline and From→To forms both call the same "create transfer" service →
  no divergence (mirrors the C1/C2 shared-service discipline).
- **Balance computation unchanged:** each side is just a signed transaction in its account; the
  existing `opening + Σtx` handles it with no special case beyond the analytics exclusion.
- **Offline-capable in desktop mode** (Electron); hosted mode is client↔server (architecture §11).

## Resolved decisions (locked 2026-06-20)
1. **Fluid normal ↔ transfer conversion = YES, Actual-like** (LOCKED, best-UX call): setting an
   existing transaction's payee to a "Transfer → <account>" option converts it to a transfer
   (creates the partner); clearing it converts back (deletes the partner). C3 establishes the
   principle and the inline **create**-as-transfer path; the **edit-driven conversion mechanics**
   (create/delete partner on edit) are specified in **C4**. Rationale: consistency — the same payee
   action behaves the same on a new row and an existing one.
2. **Re-pointing a transfer's account via edit = YES** (LOCKED, best-UX call): changing the
   destination/source account moves the partner row to the new account (all affected balances
   recompute). Better UX than delete+recreate. Mechanics specified in **C4**; amount/date/notes
   edits sync as in C3.
3. **Fields synced between the two rows = amount (mirrored), date, notes** (LOCKED). Each side's
   counterpart-account "payee" is derived, not stored as a real payee.
4. **Different-currency pair = shown but blocked on save** with a clear "coming with multi-currency"
   message (LOCKED), so the user knows it's planned rather than silently missing.
5. **A transfer between a spending account and a holding takes a category** (2026-10-16,
   decided after comparing how Actual and Sure file such transfers; amends the "transfers carry
   no category" rule, architecture §3). Which: one side a bank or card, the other a holding or
   liability (fund, stocks, FD, RD, gold, property, loan, other), either way, read from module
   metadata (`transferTakesCategory`); bank ↔ bank, card bills and holding ↔ holding take none (the
   server refuses one). Where: on the **spending-side leg** only (Actual's on-budget leg, Sure's
   outflow leg), shown on both legs and editable from either register, All transactions, the entry
   row and Quick Add; a member who can't see that leg can neither see nor set it (P0). Default:
   blank, and a blank one is still a transfer ("Transfer", muted), never "Uncategorized" or in the C5
   inbox (Actual counts it as uncategorised; Miserly doesn't nag). Re-pairing a transfer keeps the
   category only if the new pair takes one; a category never changes an amount, so net worth is
   untouched. Meaning in reports: R2 RD9, R3 RD7.
6. **The payee list names accounts by id, under a heading per section** (2026-11-06,
   after a review of the app). The payee field (the
   register's entry row and its cells, All transactions, Quick Add) lists the payees under
   "Payees", then the accounts under one heading per section in the sidebar's order and with the
   sidebar's names ("Transfer: Bank accounts", "Transfer: Mutual funds"), as Actual's "Transfer
   To/From" under Payees. Each account line carries its id, which the server takes; the field
   reads "Transfer → HDFC". Text typed by hand still works when it names one account, and is
   refused when it names two ("Two accounts are called HDFC: pick one from the list"); the
   edit-in-place lookup never picks the row's own account. A co-member's account reads "HDFC
   (Bob's)" and a closed one "HDFC (closed)", in the list and wherever a transfer names its other
   side; All transactions names a closed other side (it read as a hidden account) and locks the
   row. When the viewer sees one name in two sections, the field and the transfer text add the
   section, "Transfer → HDFC (Mutual funds)", while the list keeps "HDFC" under its heading (F1
   RD22, 2026-11-06). *Why:* names are unique per owner and type only (F1), so a bank "HDFC" and a fund
   "HDFC" shared one line of text and a bank-to-bank move landed in the fund as money invested.

## Circle addendum (Epic 8 · multi-user)

> Added 2026-06-25 by the [Circle epic](../circle/README.md) writeback (D6). Transfers gain a
> **both-legs-visible** constraint; the two-linked-rows mechanics are otherwise unchanged.

- **Both legs in the visible set.** A transfer is accepted only if **source AND destination** are in the
  actor's visible set (owned ∪ member-of, [H2](../circle/H2-account-ownership-and-sharing.md)) — so you
  can never move money into/out of an account you can't see (never into someone's private account).
- **Pickers list visible accounts only**, and the rule is **re-checked server-side** on save and on
  edit (C4) — UI filtering alone is not the gate (defense in depth).
- **Settle-up via shared accounts** is the MVP pattern (transparent to exactly the right people). Direct
  privacy-respecting "pay a member" (B) and an IOU ledger (C) are deferred — see
  [H4](../circle/H4-cross-member-money.md).
- **Cross-visibility partner legs:** when one leg sits in a member's private account and the other in a
  shared account, co-members of the shared account see only the shared leg as "Transfer", never the
  private partner account. `entered_by` is stamped on both legs.
- **AC delta:** a transfer with any leg outside the actor's visible set is rejected server-side.
  **Folded into the canonical Acceptance criteria + validation rules above (2026-06-25, MODE 2.5 M1).**

## Dependencies
- **Depends on:** C1 (entry mechanics, `(date, sequence)` ordering, derived balances), F1 (accounts;
  transfer-partner-aware delete), F3 (unified picker offering "Transfer → <account>").
- **Relates to:** C2 (the explicit transfer form can live in / beside the global quick-add), C4
  (edit/delete builds on the pair; payee-based conversion deferred there).
- **Excludes:** cross-currency transfers (**Multi-currency epic**), asymmetric contribution-to-holding
  e.g. SIP→MF units (**per-instrument epic**), splits (dropped), cleared/reconciliation (deferred).

---

### Research sources
- Actual Budget — Transfers (two linked transactions, edit-syncs-both, delete-removes-both,
  transfer-as-payee): https://actualbudget.org/docs/transactions/transfers/ ;
  https://actualbudget.org/docs/transactions/payees/
- Firefly III — Transactions & transfers (source→destination; internal-consistency, treated apart
  from spending): https://docs.firefly-iii.org/explanation/financial-concepts/transactions/
- GnuCash — double-entry transfer concept (money never gained/lost; equal-and-opposite movement):
  https://code.gnucash.org/website/docs/v1.6/C/x2527.html
- An earlier prototype of Miserly — `transfer_partner_id` + analytics excluding transfers
  (`transfer_partner_id == None` filters in cashflow/spending).
