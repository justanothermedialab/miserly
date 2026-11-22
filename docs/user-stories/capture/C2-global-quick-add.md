# C2 — Global action-first quick-add

> **Epic:** Capture · **Story:** C2 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD only, zero intelligence. Reuses the C1 entry mechanics.

---

## Title
As the user, from anywhere in the app, I can summon a quick-add form (via a button or a keyboard
shortcut), pick the **account** as a field, and log a transaction without first navigating to that
account's register — so capture is never more than one action away, wherever I am.

## ELI5
Sometimes I'm looking at the dashboard, or another account, and I just remembered a charge. Instead
of clicking my way to the right account first, I hit one key (or one button), a little form pops up,
I choose the account, type the transaction, and I'm done. Same transaction, just started from
"anywhere" instead of from inside one account.

## Business context
Our locked capture model requires **both** entry surfaces: account-first (the register, C1) **and**
action-first (this global quick-add). The user personally works account-first, but action-first is
table-stakes for a modern tracker and removes friction in the "I just remembered something" moment —
which, for a completionist per-paisa logger, is exactly when a capture would otherwise be lost.

Two established patterns cover this:
1. **A persistent add affordance** — a floating action button (mobile) / header "+ Add" (desktop) —
   the single most important primary action in a finance app
   ([FAB best practice](https://mobbin.com/glossary/floating-action-button),
   [finance UI](https://procreator.design/blog/user-interface-design-for-finance-app/)).
2. **A keyboard quick-entry** — a command palette (Cmd/Ctrl+K) and/or a Things-3-style Quick Entry
   that appears over whatever you're doing
   ([command palette](https://mobbin.com/glossary/command-palette),
   [Things 3 Quick Entry](https://medium.com/design-bootcamp/command-palette-ux-patterns-1-d6b6e68f30c1)).
   Actual itself ships a `K` command palette — our keyboard-first user will expect this.

The key design difference from C1: because we're not inside a register, **account is an explicit
field** in the form. Everything else (date default, payee autocomplete, optional category with
fill-when-blank, explicit inflow/outflow, validation, atomic derived-balance save) is **the same
machinery as C1** and must not diverge.

## User workflow

### Happy path — keyboard
1. Anywhere, user presses the global **quick-add shortcut** → a compact quick-add overlay appears,
   focus in the first field.
2. Fields: **Account** (defaults to last-used), **Date** (Today), **Payee**, **Category**
   (optional), **Amount + In/Out**, **Notes**.
3. **Ctrl/Cmd+Enter** saves and closes; **Enter** (or "Save & add another") saves and resets the
   form for the next entry (carrying the date, per C1 decision #5).

### Happy path — pointer
1. User clicks the persistent **+ Add** button / FAB → same overlay.
2. Fills and saves.

### Alt path — from the command palette
- User opens the command palette (Cmd/Ctrl+K), types "add" / "new transaction" → selects it → the
  same quick-add overlay opens. (The palette is also the future home of other commands; here it's
  just one entry point.)

### Recovery path
- Same as C1: uncategorized is allowed (→ C5 inbox); invalid amount/both-columns is blocked inline;
  a failed save keeps the user's input intact.

## Acceptance criteria
- [ ] A **persistent add affordance** (FAB/header button) is reachable from every main screen.
- [ ] A **global keyboard shortcut (Cmd/Ctrl+Shift+N)** opens the quick-add overlay from anywhere
      (not just registers) — replicates YNAB's new-transaction key; Shift avoids the Cmd/Ctrl+N
      browser/Electron "new window" collision.
- [ ] A **command palette (Cmd/Ctrl+K)** — the Actual + Monarch convention — exposes "Add
      transaction" as a command that opens the same overlay.
- [ ] The overlay includes an **Account** field (required), defaulting to the **last-used account**;
      the picker lists **only the viewer's visible open accounts** (`owned ∪ member-of`). The created row
      stamps **`entered_by` = current user** (inherited from C1's shared create path).
- [ ] All other fields and rules are **identical to C1**: date defaults to Today (past/future
      allowed), payee autocomplete + create-inline (F3), optional category with fill-when-blank
      (F3), explicit inflow/outflow, notes optional.
- [ ] **Save & add another** resets the form (carrying the date) for rapid sequential entry;
      single-save closes the overlay.
- [ ] A transaction created here is **indistinguishable** from one created in the register — same
      data, same derived-balance computation, appears immediately in the account's passbook.
- [ ] Adding on a specific account's page (the C1 register inline-add) **remains available** — C2 is
      an additional path, not a replacement; the account page defaults its account to itself.
- [ ] Amount entry here may use a **single amount field + in/out toggle** (compact modal) rather than
      two columns (per C1 decision #4), but stores direction explicitly the same way.

## Validation rules
- **Account:** required; must be an **open** account (closed accounts not selectable for new entries).
- All other validation inherited from C1 (date valid; exactly one of inflow/outflow > 0; category
  must exist if set; payee dedupe rules from F3).

## Edge cases
- **No accounts exist yet:** quick-add should guide the user to create an account first (links to
  F1), rather than showing an empty account picker.
- **Last-used account is now closed/deleted:** fall back to the next sensible default (e.g. most
  recently active open account) rather than a stale selection.
- **Triggered while typing in another input** (e.g. mid-search): the global shortcut must not hijack
  text input — only fire when not focused in a text field, or use a modifier combo that's
  unambiguous.
- **Liability account selected:** inflow/outflow semantics follow the module's side, same as C1.
- **Quick-add for a holding/instrument account** (e.g. logging into an FD): allowed as a plain
  transaction in MVP; instrument-specific entry UX is the per-instrument epic, not C2.

## Failure cases
- **Shortcut conflicts** with browser/OS or with register shortcuts (`T`): the global quick-add key
  must be chosen to avoid collisions and documented in the `?` help.
- **Double-submit** (Enter pressed twice) must not create duplicates.
- **Divergence from C1:** if quick-add ever computed or stored a transaction differently from the
  register path, that's a defect — both must call the **same** create-transaction logic.

## UX considerations
- **Overlay, not navigation:** the quick-add appears over the current screen and dismisses back to
  it — the user never loses their place (Things 3 Quick Entry model).
- **Account field first and prominent** (it's the one thing the register path already knew); a fast,
  type-ahead account picker.
- **Compact and keyboard-complete:** every field tabbable; save/another/cancel all keyboard-driven;
  Esc cancels (with guard if data entered).
- **One FAB/primary add per screen** (don't multiply add buttons); on desktop a header `+ Add` is
  enough alongside the shortcut.
- **Consistency with C1** so muscle memory transfers (same field order, same payee/category behaviour).

## Operational considerations
- **Shared entry component / create-transaction service**: C1 (inline) and C2 (overlay) are two
  presentations of one underlying create path → one validation, one balance computation, zero drift.
- **Last-used-account** is a small piece of UI state to persist (per device is fine).
- **Works offline in desktop mode** (hosted = client↔server, architecture §11).

## Resolved decisions (locked 2026-06-20)
1. **Triggers = replicate the prevailing conventions** (LOCKED):
   - **Cmd/Ctrl+K** opens a command palette / search — the convention shared by **Actual** and
     **Monarch** — with "Add transaction" as a command.
   - **Cmd/Ctrl+Shift+N** is the direct global quick-add shortcut — **YNAB's** new-transaction key
     (N = new); Shift sidesteps the Cmd/Ctrl+N "new window" collision in browsers/Electron.
   - These coexist with C1's in-register `T` (new row) and Cmd/Ctrl+Enter (commit single).
2. **Default account = last-used account** (LOCKED), zero-config. The C1 account-page inline-add
   still exists and defaults to that page's own account — C2 does not replace it.
3. **Command palette is IN for MVP** (LOCKED, minimal): it hosts "Add transaction" now and is the
   natural home for more commands later; on-brand for a keyboard-first user.
   *Amended 2026-10-20:* the palette became the **title bar's search field**
   at the window's centre. Ctrl K focuses it; besides search results it runs the commands (Add
   transaction, New transfer, Add account, To categorize, the themes, Sign out) and goes to every
   page, account group, account and payee the palette did.
4. **Transfer mode in the overlay = C3 cross-reference**, not built in C2.

**Amendments (2026-10-05, each chosen from options with their evidence):**

5. **Quick Add key in the browser = N outside a field** (amends RD1). Ctrl+Shift+N stays in the
   desktop app, but Edge and Chrome keep it for InPrivate/incognito, so it never reaches a browser
   page. **N** (when focus isn't in a text field, like the register's T) opens Quick Add in both
   variants.
6. **Default account and picker** (refines RD2): the default is the account last used **for
   this kind of entry** (expense, income, transfer), else the first bank account, never a holding for
   an expense. The account list is grouped by section (S1 RD7). With "Add another" on, each save shows a
   short confirmation naming what was saved.
7. **Quick Add works like the register: no Expense / Income / Transfer tabs** (2026-10-20;
   replaces the earlier design's tabs, which came from mobile trackers). The dialog has the
   register's two amount fields side by side (Withdrawal and Deposit, or Charge and Payment on a card
   or loan; typing in one clears the other), and the Payee list ends with "Transfer → <account>" for
   every other account, as in the register's entry row and Actual. Picking one makes the save a
   linked transfer (out of the account on a Withdrawal, into it on a Deposit), through the same
   server helper as the register (`$lib/server/inline-transfer`). A transfer shows Category only when
   the pair takes one (C3 RD5) and, across currencies, asks for the other account's amount. Ctrl K's
   "New transfer" keeps the From / To form (with its rate or received choice). The default account is
   the last one used (RD6's per-kind default stays for transfers from that form). *Why:* Actual and
   YNAB don't ask for a type up front; the question was whether the tabs were annoying.
8. **"Add another" remembers its last state** (2026-10-17):
   ticked or not, the box opens the way it was last left (on this device).

## Circle addendum (Epic 8 · multi-user)

> Added 2026-06-25 by the [Circle epic](../circle/README.md) writeback (D6).

- **Account field = visible accounts only.** The action-first overlay's account picker lists only the
  user's visible set (owned ∪ member-of, [H2](../circle/H2-account-ownership-and-sharing.md)).
- **`entered_by` stamp.** Inherited from C1's shared create path — every row records who logged it.
- **AC delta:** the account picker excludes accounts the user can't see; each row carries
  `entered_by = current user`. **Folded into the canonical Acceptance criteria above (2026-06-25,
  MODE 2.5 M1).**

## Dependencies
- **Depends on:** C1 (the shared entry component + create-transaction logic + balance computation),
  F1 (accounts, for the account picker), F2 (categories), F3 (payees).
- **Blocks:** nothing hard; complements C1. C3 may extend this overlay with a transfer mode.
- **Excludes:** transfers (C3), reorder/edit (C4), inbox (C5), instrument-specific entry forms
  (per-instrument epic), cross-currency (Multi-currency epic).

---

### Research sources
- Floating action button as the primary "add" action in finance apps: https://mobbin.com/glossary/floating-action-button ; https://procreator.design/blog/user-interface-design-for-finance-app/
- Command palette pattern (Cmd/Ctrl+K), quick entry over current context (Things 3): https://mobbin.com/glossary/command-palette ; https://medium.com/design-bootcamp/command-palette-ux-patterns-1-d6b6e68f30c1
- Trigger-key conventions to replicate — **Cmd/Ctrl+K** palette in Actual & Monarch; **Cmd/Ctrl+Shift+N** add-transaction in YNAB: https://github.com/actualbudget/actual/pull/5334 ; https://help.monarch.com/hc/en-us/articles/38610714553108-CommandK-Search-Bar-and-Shortcuts ; https://support.ynab.com/en_us/keyboard-shortcuts-Skw9Xp9A9
