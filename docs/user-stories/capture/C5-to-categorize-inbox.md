# C5 — The "To categorize" inbox

> **Epic:** Capture · **Story:** C5 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD only, zero intelligence. The anti-perfectionism feature.

---

## Title
As the user, I can log transactions now and categorize them later from a single "To categorize"
inbox — clearing the backlog one row at a time or in bulk — so that never-knowing-the-category never
blocks my daily logging and an incomplete ledger never guilts me into quitting.

## ELI5
Sometimes I log a charge but don't want to stop and pick a category. So it goes into a "deal with it
later" pile. This story is that pile, plus a fast way to empty it: open the inbox, see everything
without a category, and tag them — one by one or twenty at once. When it's empty, I get a little
"all caught up" — a small win instead of a nagging chore.

## Business context
This is the deliberate **anti-perfectionism** mechanism. The #1 reason people abandon trackers is
that logging or tidying feels tedious and rigid — they quit when the app demands perfection up front
([why budgeting apps fail](https://medium.com/@stefanneculai/why-most-budgeting-apps-fail-and-what-actually-works-88904191967e),
[budget app retention](https://www.onething.design/post/budget-app-design)). For a completionist who
logs every paisa, the worst outcome is a workflow that stalls on "what category is this?" — so:

- **Category is optional at entry** (locked in C1) → an uncategorized transaction is valid.
- **C5 is where those land and get cleared**, on the user's schedule, with minimal friction.

It is essentially Actual's "**Show uncategorized**" filter + **bulk categorize**, elevated into a
first-class, always-available destination with a satisfying empty state
([Actual filters](https://actualbudget.org/docs/transactions/filters/),
[Actual bulk actions](https://actualbudget.org/docs/transactions/bulk-editing/)). The fancier
"you haven't logged in a while" nudge and auto-categorization are **AI/intelligence layer (deferred)**;
C5 is pure CRUD — a view + the existing bulk tools.

## User workflow

### Happy path — clear the backlog
1. User opens **To categorize** (from the nav; a gentle count badge shows the backlog size).
2. Sees every uncategorized transaction (across spending accounts) in one list.
3. Sets a category inline on a row → it leaves the inbox immediately.
4. Repeats, or multi-selects similar rows and **bulk sets** one category (C4 bulk action).
5. Inbox empties → "**All caught up**" empty state (a small win).

### Alt path — payee did the work
- Many rows arrive pre-categorized because the payee had a remembered category (F3 fill-when-blank),
  so the inbox only holds the genuinely-ambiguous ones.

### Alt path — "mixed / don't care"
- For a mixed purchase or trivia (e.g. a ₹1.71 charge), the user assigns a catch-all
  **General / Other** category (their existing Actual habit) — same as any categorize action.

### Recovery path
- Categorizing from the inbox is just an edit (C4) — fully undoable; a wrong bulk-categorize can be
  undone.

## Acceptance criteria
- [ ] A dedicated **To categorize** view lists all **uncategorized, non-transfer** transactions in
      **spending-type accounts** (scope confirmed in Resolved decisions).
- [ ] Setting a category on a row (inline) **removes it from the inbox** instantly.
- [ ] **Bulk categorize** works from the inbox (multi-select → set category), reusing C4's bulk action.
- [ ] A **count indicator** (badge) shows the backlog size; it is informational, not nagging.
- [ ] An **empty state** ("All caught up") shows when the inbox is clear.
- [ ] Transactions of **either direction** (inflow or outflow) appear if uncategorized (so income can
      be tagged here too).
- [ ] **Transfers never appear** (they need no category).
- [ ] Categorizing here is an ordinary edit — **undoable** (C4) and reflected everywhere immediately
      (charts, register).

## Validation rules
- Inbox membership is **derived**, not a stored flag: a transaction is "in the inbox" iff it has no
  category, is not a transfer, and belongs to an in-scope (spending) account. No separate state to
  keep in sync.
- Setting a category must obey F2 (category exists, not hidden).
- Bulk categorize obeys C4 rules (atomic; skips any transfer rows defensively).

## Edge cases
- **Holding-account entries** (FD interest, a valuation mark, a contribution): these are net-worth
  activity, not spending — **excluded** from the inbox by the spending-account scope (see Resolved decisions).
- **A transaction later edited back to "no category"** (category cleared in C4): it correctly
  reappears in the inbox (membership is derived).
- **Huge backlog after a long capture gap** (the user's weekly/late-entry rhythm): the inbox + bulk
  categorize must stay fast and pleasant at hundreds of rows; sort/group to make bulk selection easy
  (e.g. group by payee so all "Amazon" rows select together).
- **Everything already categorized** (payee prefill did its job): inbox shows the empty state, not an
  error.
- **A row whose payee gains a remembered category after the fact:** existing uncategorized rows are
  **not** retroactively auto-categorized (no rules engine in MVP) — they stay until the user acts.

## Failure cases
- **Inbox disagrees with reality** (shows a categorized row, or hides an uncategorized one): a defect
  — membership is a pure query over current data, so it cannot drift if computed live.
- **Bulk categorize partially applies:** must be atomic (C4) — no half-cleared batch.
- **Count badge stale** vs the actual list: the badge and list read from the same query; they cannot
  diverge.
- **Categorizing leaks a transfer into spending:** prevented — transfers are excluded from the inbox
  and can't be given a category.

## UX considerations
- **Frame it as progress, not guilt** — supportive copy, a clearable count, a rewarding empty state
  ("All caught up ✓"); small wins drive retention. No red nagging; the "you've been inactive" nudge is
  explicitly deferred (AI).
- **Group/sort for fast clearing** — grouping by payee (or amount) lets the user bulk-select lookalikes
  and categorize in a couple of actions; this is where the inbox earns its keep on a catch-up batch.
- **Inline + bulk both available** — quick single edits for one-offs, bulk for batches (C4 toolbar).
- **One click away** in the nav with the gentle count; not a modal the user has to hunt for.
- **Consistent with the register** — same category picker, same payee behaviour, so it feels like the
  ledger, not a separate tool.

## Operational considerations
- **No new state** — the inbox is a query: `category IS NULL AND transfer_partner_id IS NULL AND
  account is spending-type`. This is the simplest, drift-proof implementation and matches the "derived,
  not stored" discipline used throughout (F1 balances, F2 kind, C4 ordering).
- **Reuses** C4 bulk edit, F2 categories, F3 payee prefill — C5 adds a view + count, not new core
  machinery.
- **Count badge** is the same query's count; cheap to compute locally; updates reactively on any
  edit.
- **Offline-capable in desktop mode** (Electron); hosted mode is client↔server (architecture §11).

## Resolved decisions (locked 2026-06-20)
1. **Inbox scope = spending-type accounts only** (LOCKED): bank + credit card. Holding accounts
   (FD/MF/PPF/Property) track value, not spend; their entries (contributions = transfers, valuation
   marks, interest) don't demand a category and stay out of the inbox. (FD-interest-as-Income, if
   ever wanted, is a holding/instrument concern, not the spending inbox — revisit there.)
2. **Count badge = nav item only, subtle** (LOCKED): informational, not on the dashboard, not nagging.
3. **No separate "ignore" flag** (LOCKED): trivia/mixed purchases use the seeded **General/Other**
   category (the user's existing habit) — one concept fewer; the row leaves the inbox the same way.
4. **System balancing entries never enter the inbox** (locked 2026-07-12 — F1 Resolved decision 11):
   an F1 force-close adjustment is stamped with the seeded Neutral **"Adjustments → Balance
   adjustment"** category, so the derived membership rule (uncategorized ∧ non-transfer ∧ spending
   account) naturally excludes it — no special-case filter here. If the user deletes that seeded
   category, a later balancing entry degrades to uncategorized and (correctly, per the derived rule)
   appears here for the user to file.
   *Amended 2026-11-06 (after a review of the app, F2 RD9):* that category and its group can no longer be
   deleted, so a close never lands here.
5. **Rows on a closed account stay listed and can be categorised** (2026-11-06, after a
   review of the app; C4 RD8). Categorising one moves no money, so it clears the badge and Reports'
   "Uncategorized"; nothing else on the row changes.

## Dependencies
- **Depends on:** C1 (optional category at entry creates inbox items), F2 (categories to assign),
  F3 (payee prefill reduces what lands here), C4 (bulk categorize + undo).
- **Relates to:** F1 (account spending/holding type drives inbox scope).
- **Excludes / defers:** auto-categorization & rules (v2 / intelligence), the "inactive / sparse
  activity" nudge (AI), per-instrument categorization of holding accounts.

---

### Research sources
- Actual Budget — "Show uncategorized" filter, saved filters, bulk categorize (`C`):
  https://actualbudget.org/docs/transactions/filters/ ; https://actualbudget.org/docs/transactions/bulk-editing/
- Tracker abandonment / anti-perfectionism & retention (small wins, supportive copy, don't force
  rigidity): https://medium.com/@stefanneculai/why-most-budgeting-apps-fail-and-what-actually-works-88904191967e ;
  https://www.onething.design/post/budget-app-design
