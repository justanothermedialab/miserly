# D4 — Recent activity & account summary (below the fold)

> **Epic:** Dashboard & net worth · **Story:** D4 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD + descriptive display only, zero intelligence.

---

## Title
As the user, below the net-worth hero I can see my **recent activity across all accounts** and an
**account summary grouped by type** with balances, so the dashboard both shows what just changed and
acts as the jumping-off point into any account — without becoming a place where I do data entry.

## ELI5
Under the big net-worth number and charts, two useful lists: (1) the latest things that happened —
"₹1.71 bank charge, ₹50k salary, transferred ₹20k to savings" — across everything; and (2) all my
accounts grouped by kind (Bank, Cards, FDs, Mutual Funds, …) with their balances, so I can tap into
any one. I look here to orient and navigate; I actually *log* stuff inside the accounts.

## Business context
The hero (D1) + allocation (D2) + trend (D3) answer "how am I doing?". D4 fills the rest of the
dashboard with the two things every finance home screen needs: **"what recently changed"** and
**"where's my money, by account"** — the patterns every banking/aggregator dashboard converges on
([banking dashboard best practices](https://procreator.design/blog/banking-app-ui-top-best-practices/),
[Monarch overview](https://robberger.com/monarch-money-review/)).

It reinforces the locked **wealth-view vs work-view** split: the dashboard is for **orientation and
navigation** (read-only); **logging happens in the registers/sections** (C1). So recent activity here
is **tap-to-open**, not inline-editable — tapping a row jumps to that transaction in its register
(where C4 editing lives). The account summary is the dashboard-level reflection of the **section-per-
instrument IA**; the full per-instrument pages are the per-instrument epic — D4 is the compact
grouped overview that links into them.

## User workflow

### Happy path — recent activity
1. The user scrolls below the hero/charts and sees **Recent activity**: the latest transactions across
   **all** accounts, newest first, each showing date, account, payee, category, and amount (with
   transfers and valuation marks clearly labelled).
2. Tapping a row **opens that transaction in its account register** (read → edit happens there, C4).

### Happy path — account summary
1. Below/beside recent activity, an **Account summary** lists accounts **grouped by type/module**
   (Bank, Cards, FD/RD, Mutual Funds, Stocks, PPF, EPF, Property, Gold, …), each row showing the
   account name + current balance, with **group subtotals**.
2. Tapping an account opens its **register/section**; tapping a group can open that section.

### Edge/empty path
- No transactions yet → recent activity shows a friendly "Nothing logged yet — add your first
  transaction" with a shortcut (C1/C2). No accounts → account summary shows the F1 add-account prompt.

## Acceptance criteria
- [ ] **Recent activity** lists the most recent transactions across **all open accounts in the
      viewer's visible set** (`owned ∪ member-of`), newest first, count-based (e.g. last 15 — confirm in
      Resolved decisions).
- [ ] Each activity row shows **date, account, payee, category, amount**, with **transfers** and
      **valuation marks / starting balances** clearly labelled (not shown as ordinary spending). On a
      **shared account**, the row also shows **who logged it** (`entered_by`, [H3](../circle/H3-roles-and-membership.md))
      — audit, not an economic split.
- [ ] Recent activity is **read-only**: tapping a row **navigates to that transaction in its
      register**; no inline editing on the dashboard.
- [ ] *(Superseded 2026-10-10 by RD9: the account summary is removed; this and the next criterion
      no longer apply.)* **Account summary** lists the **viewer's visible** accounts **grouped by type/module** with each
      account's current balance and **group subtotals**, as-of-today, in base currency (a member never
      sees an account they don't hold).
- [ ] Account/group rows **link** to the corresponding register/section.
- [ ] Closed accounts are **excluded** (as-of-today view, consistent with D1/D2).
- [ ] Balances shown reuse the **same derived computation** as D1 (no separate numbers that could
      drift); group subtotals reconcile to the D1/D2 totals.
- [ ] Number formatting respects the app-wide multi-format preference.

## Validation rules
- **Recent activity ordering:** by `(date, sequence)` desc (C1 ordering), so it matches register order
  and is stable.
- **Recent activity scope:** all open accounts **in the viewer's visible set** (spending + holding);
  transfers appear once per side or as a single labelled transfer entry — define (see Resolved decisions).
- **Account summary inclusion:** open accounts **in the viewer's visible set** only; grouped by
  module/type; subtotals in base currency (FX converted as in D1).
- **Read-only:** the dashboard never mutates a transaction; all edits route to the register (C4).

## Edge cases
- **A transfer in recent activity:** it touches two accounts — show as a single "Transfer A → B"
  entry, or as the row for the account being viewed? On an all-accounts feed, a single labelled
  transfer entry is cleaner (avoid showing both legs as duplicates) — confirm in Resolved decisions.
- **Valuation marks / opening balances in the feed:** they're transactions; show them but **labelled**
  ("Valuation update", "Starting balance") so they aren't mistaken for spending/income.
- **Future-dated transactions:** consistent with C1 — either shown with a clear "upcoming" marker or
  excluded from "recent" until their date; define (see Resolved decisions).
- **Many accounts:** account summary stays scannable via grouping + collapsible groups; very long
  lists may show top-N per group with "view all" into the section.
- **Empty groups** (a module with no accounts): hidden, not shown as empty headers.

## Failure cases
- **Dashboard balance ≠ register/D1 balance:** impossible by construction (shared derived
  computation); divergence is P0.
- **Recent activity order differs from the register:** defect — both sort by `(date, sequence)`.
- **A transfer double-counted** as two separate spending-looking rows in the feed: avoid (label/merge
  per the Open-Q decision).
- **Tapping a row lands on the wrong transaction/account:** navigation must target the exact row.

## UX considerations
- **Orientation, not action** — recent activity is a glanceable feed; the call-to-action is "tap to
  view", reinforcing that logging lives in the registers.
- **Label non-spending rows** distinctly (transfer, valuation, starting balance) so the feed reads
  honestly and doesn't look like a spending list.
- **Account summary mirrors the section IA** — same grouping as the nav/sections, so the dashboard is a
  faithful map of the app; tapping flows naturally into the per-instrument pages.
- **Subtotals tie back to the hero** — a user can mentally check that group subtotals add up to the
  net-worth picture above (trust through consistency).
- **Compact and skimmable** — this is below the fold; dense but clean, with "view all" affordances
  rather than infinite lists.
- Respects the app-wide number-format preference (compact in tiles, full on drill-in).

## Operational considerations
- **Shared balance computation** with D1/D2/D3 (one source of truth) for all summary balances and
  subtotals.
- **Recent activity query:** latest N transactions across accounts by `(date, sequence)` desc; cheap;
  read-only.
- **Navigation contracts:** rows/cards carry stable references (account id, transaction id) to deep-
  link into registers/sections.
- **No new mutation paths** — D4 is pure read + navigation; all writes go through C1–C4 services.
- **Offline-capable in desktop mode** (Electron); hosted mode is client↔server (architecture §11).

## Resolved decisions (locked 2026-06-20)
1. **Recent activity = last N transactions** (LOCKED), count-based (default ~15, tunable), with
   "view all" into a global activity/register.
2. **Transfers in the feed = single labelled "Transfer A → B" entry** (LOCKED). NOTE: Actual does the
   opposite (shows each leg in each account's register) — which is correct *inside a single-account
   register*, but on this **unified all-accounts feed** a merged entry avoids duplicate-looking rows.
   (Inside an individual register, the leg for that account is what shows — consistent with C1/C3.)
3. **Account summary = collapsible groups** (LOCKED), by type/module with subtotals; large groups show
   top-N + "view all" into the section.
4. **Future-dated transactions excluded from "recent"** (LOCKED) — it's recent *activity*; they remain
   reachable in the register.
5. **Responsive layout** (LOCKED): recent activity + account summary side-by-side on wide screens,
   stacked on narrow.

**Amendments (2026-10-05, each chosen from options with their evidence):**

6. **"View all" = an All transactions register, now built** (restores RD1, dropped between
   story and build). Every visible account's rows in one register with search and the same one-row
   toolbar as an account register, an Account column, linked from the sidebar and from recent
   activity's "View all". Viewer-scoped through `accountsVisibleTo` like every list.
   **Amended 2026-10-15 (to match
   Actual):** it is edited as a register, as Actual's All accounts: cells edit in place (Tab and
   Enter move on), New transaction adds a row with an Account field, rows select for Delete (with
   Undo) and Set category, and every row is loaded with only those in view drawn. Amounts sit in
   Withdrawal and Deposit columns, as the register's. A transfer or a value update opens its
   register at the row. A row's account can't be changed here (deferred).
7. **Colour** (see D1 RD7): spending rows red, income rows green, valuation updates by their
   sign; a merged "Transfer A → B" row is unsigned and stays neutral (RD2).
8. **Open question for the mocks:** with accounts back in the sidebar (S1 RD7), the account
   summary (RD3) repeats them. Whether it stays on the dashboard is settled by the dashboard mock.

**Amendments (2026-10-10, after a review of the app's screens):**

9. **The account summary is removed** (resolves RD8; retires RD3 and RD5). The
   sidebar lists every account with its balance (S1 RD7); no app in the nine checked shows the list
   both in a sidebar and on the home screen. Recent activity and the headline's
   change line already explain what moved this month. A by-section table with each section's change
   was mocked and is not built.

## Circle addendum (Epic 8 · multi-user)

> Added 2026-06-25 (MODE 2.5 correction M1). Folded directly into the Acceptance criteria + validation
> rules above (D4 had no addendum before).

- **Viewer-scoped feed + summary.** Both recent activity and the account summary are computed over the
  viewer's visible set (`owned ∪ member-of`); a member never sees an account they don't hold (or its
  existence). No all-Circle view.
- **Authorship.** Shared-account rows show **`entered_by`** (who logged it — audit, not a split, H3).
- **Empty-member state.** A member who owns nothing and has had nothing shared sees the friendly empty
  states (no activity / add-or-be-shared an account), not a misleading zero feed.

## Dependencies
- **Depends on:** D1 (shared balance computation, as-of-today, FX), F1 (accounts + type/grouping +
  status), C1 (transaction data + `(date, sequence)` ordering + `entered_by`), C3 (transfer labelling),
  C4 (tap-to-edit destination), the **Circle** visible-set service ([H2](../circle/H2-account-ownership-and-sharing.md)),
  the app-wide number-format preference.
- **Relates to:** the **per-instrument sections** epic (account summary links into those pages) — D4
  is the compact dashboard reflection; full section pages come later.
- **Excludes:** inline editing on the dashboard (work-view, lives in registers), per-instrument
  detail/performance (per-instrument epic), spending/income feeds & insights (Reports / intelligence).

---

### Research sources
- Banking/finance dashboard core surfaces — balance/net-worth KPIs + recent-activity feed across all
  accounts + account summary cards; "what recently changed" + "what to do next":
  https://procreator.design/blog/banking-app-ui-top-best-practices/ ; https://procreator.design/blog/finance-app-design-best-practices/
- Monarch / Empower — accounts grouped, everything-in-one-place overview, net-worth navigation:
  https://robberger.com/monarch-money-review/ ; https://www.financialaha.com/articles/empower-vs-monarch-money/
