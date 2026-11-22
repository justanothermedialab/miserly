# R2 — Spending by category

> **Epic:** Charts / reports · **Story:** R2 · **Status:** LOCKED (2026-06-21)
> **MVP scope:** CRUD + descriptive charts only, zero intelligence.

---

## Title
As the user, I can see **where my money went** over the selected period — a breakdown of spending by
category group (Food, Transport, Bills…), drillable into individual categories and then the actual
transactions — so I understand my outflows without any budgeting machinery.

## ELI5
Over the period I picked (R1), this shows a donut of my spending: the big slices are my biggest expense
groups. I tap "Food" to see it split into "Groceries / Eating out / …", and tap again to see the exact
transactions. It only counts real spending — transfers and money I put into investments don't show up
as "spending", because they're not.

## Business context
This is one of the two product-defining MVP charts (plan: *spending-by-category pie*), and it's the
heart of the **expense-tracking** half of Miserly — the per-paisa persona's "where did it all go?"
question. It sits in the Reports area (R1) and answers for the **shared selected period**.

The conventions are well-established and adopted:
- **Donut for parts-of-a-whole** with a **horizontal-bar alternative** — exactly Actual's "Breakdown:
  donut or horizontal bar"; tooltip shows **amount + % of total**
  ([Actual custom reports](https://actualbudget.org/docs/reports/custom-reports/),
  [spending-report UX](https://getfinny.app/blog/best-expense-tracking-apps-charts-visualizations)).
- **Drill: group → category → transactions** — click a slice/legend row to descend, ending at the real
  register rows ([Monarch reports](https://help.monarch.com/hc/en-us/articles/21846787088916-Using-Reports)).
- **Read-only, drill to the register** to edit — consistent with D4.

The **correctness backbone** comes from F2's kind model, which makes "spending" unambiguous with zero
intelligence:
- Count only **Spending-kind** groups/categories; **exclude Income and Neutral** (e.g. "Investments")
  and **exclude transfers** (categoryless, C3) — contributions to holdings are transfers/Neutral, never
  spending.
- **Refunds net within a category** via F2's signed-amount-within-kind (a grocery refund *reduces*
  Groceries) — so the report shows **net** spend, not inflated gross.
This is why the report needs no rules engine: the ledger + kinds already classify everything.

## User workflow

### Happy path — see the breakdown
1. In Reports (period = This month, R1), the **Spending by category** report shows a **donut** of
   spending grouped by **category group**, with a legend (group · amount · % of total) sorted largest-first.
2. Hovering/tapping a slice shows its **amount and % of total spend**.
3. The center/total shows **total spending** for the period.

### Happy path — drill down
1. The user taps **Food** → the view descends to **categories within Food** (Groceries, Eating out…)
   as a second-level breakdown.
2. They tap **Groceries** → the **list of transactions** in that category/period (read-only), tapping
   any row opens it in its register (D4 pattern).

### Alt path — switch view / level
- Toggle **donut ↔ horizontal bar**; optionally switch the top level between **group** and **category**
  (see Resolved decisions). Changing the R1 period re-renders everything.

### Edge/empty path
- **No spending in the period:** a calm "no spending in this period" state (not an error).
- **Uncategorized spending exists:** shown as its own **"Uncategorized"** slice so it's visible (nudging
  the user to clear the C5 inbox) — see Resolved decisions.

### Recovery path
- Nothing to edit here; corrections happen by drilling to the register. Re-categorizing a transaction
  there immediately changes the breakdown (derived).

## Acceptance criteria
- [ ] A **Spending by category** report renders for the **R1 selected period**, over the **viewer's
      visible accounts** (`owned ∪ member-of`; a **Shared view** restricts to shared accounts only; **no
      all-Circle report**), showing spending broken down by **category group** (default top level),
      largest-first.
- ~~On **shared accounts**, spending can be broken down **by `entered_by`** (who logged it from the
      shared pot — audit, not an economic split; ships in MVP, [H3](../circle/H3-roles-and-membership.md)).~~
      **Dropped 2026-10-30 (RD11).**
- [ ] Default visual = **donut**, with a **horizontal-bar** toggle; each segment/row shows **amount and
      % of total spending**; the **period total** is shown.
- [ ] **Only Spending-kind** categories count; **Income, Neutral (e.g. Investments), and transfers are
      excluded** (per F2/C3) — contributions to holdings never appear as spending.
- [ ] **Refunds net within their category** (F2 signed-within-kind) — the report shows **net** spend; a
      category whose refunds exceed spend nets toward/at zero (handled gracefully, see Edge cases).
- [ ] **Drill-down works: group → category → transactions**, the leaf being a **read-only** transaction
      list that taps through to the **register** (D4) for any edit.
- [ ] **Uncategorized** spending (category IS NULL on a Spending-account outflow, per C5) is represented
      so it's not silently dropped (as its own slice/row — see Resolved decisions).
- [ ] **Multi-currency:** amounts are converted to **base INR via `to_base`** (MC1) before aggregation;
      a missing rate surfaces the MC1 "rate needed" state rather than a wrong total.
- [ ] Figures respect the **app-wide number-format preference** (SET1); compact form on tight chart
      labels, full form in the legend/list per SET1's rules.
- [ ] **Empty period** → calm "no spending" state.
- [ ] The report is **derived** from the ledger (no stored aggregates); re-categorizing or editing a
      transaction updates it immediately.

## Validation rules
- **Inclusion rule:** a transaction counts iff (account is a **Spending** account) AND (account is in
  the **viewer's visible set**) AND (it is **not** a transfer) AND (its category's group **kind =
  Spending**, or it is uncategorized on a spending account). Income/Neutral excluded.
- **Sign/netting:** spending magnitude = outflows minus refunds within the same category (F2
  signed-within-kind); the report sums **net** per category.
- **Grouping:** default aggregate by **group**; drill to **category**; leaf = transactions. (Top-level
  group vs category default — see Resolved decisions.)
- **Small-slice handling:** very small slices may be folded into an **"Other"** bucket for readability
  (reuse D2's ~2–3% convention), expandable on drill — display-only, never hides data.
- **Period & conversion:** window from R1 (month-to-date etc.); base-currency via `to_base` (MC1);
  number format via SET1.
- **Read-only:** no edits in the report; drill-through to register only.

## Edge cases
- **Category net-negative** (refunds > spend in the period, e.g. a returned big purchase): show it
  honestly (a negative/zero contribution); don't let it distort the donut into nonsense — represent
  net-negative categories in the list with a clear sign, excluded from the positive-slice geometry (a
  donut can't show a negative slice) — note in UX.
- **All spending uncategorized:** the donut is essentially one "Uncategorized" slice — a strong nudge to
  categorize (C5).
- **Single category dominates** (one huge slice): fine; legend still lists the rest.
- **Many tiny categories:** "Other" bucket keeps the donut readable; drill to expand.
- **Mixed currencies in the period:** each converted via `to_base`; if any contributing currency lacks a
  rate, surface "rate needed" (MC1) rather than undercount.
- **Transfers / investment contributions in the period:** correctly **absent** from spending (a common
  competitor bug is counting transfers as spend — explicitly avoided).
- **Closed accounts:** spending from an account that was open during the period **still counts** for that
  period (consistent with history semantics), even if later closed.

## Failure cases
- **Transfers or Neutral/investment outflows counted as spending:** defect — the inclusion rule must
  exclude them (the core correctness guarantee).
- **Gross instead of net** (refunds not subtracting): defect — netting within category is required.
- **Uncategorized spending silently dropped** (total ≠ sum of slices): defect — it must be represented;
  slices + Other + Uncategorized must reconcile to the period total.
- **Double counting** a split/linked row: N/A (splits are out of MVP); a transfer is categoryless so
  cannot be counted.
- **Breakdown total ≠ R3 spending total for the same period:** defect — both derive from the same
  inclusion rule; they must agree.
- **Drill leaf not matching its slice** (transactions don't sum to the slice amount): defect.

## UX considerations
- **Donut first, glanceable** — biggest slices obvious; legend sorted largest-first with amount + %.
  Horizontal bar as the alternative for users who prefer ranked bars (Actual parity).
- **Drill is the story** — group → category → transactions feels like progressive disclosure; always a
  one-tap path to the real rows (trust through traceability).
- **Uncategorized is visible, not nagging** — a neutral "Uncategorized" slice with a gentle "categorize
  these" affordance (links to C5), never a guilt-trip.
- **Honest netting** — refunds reduce a category; if a category nets negative, say so plainly rather than
  hiding it.
- **Consistent colours** — ideally reuse category/group colours (F2 optional colour field) so the same
  category is the same colour across the app.
- **No advice** — this describes spending; "you spent too much on X" is intelligence, deferred.
- Period and currency context always visible (from R1/MC3) so the number is never ambiguous.

## Operational considerations
- **Pure derived query** over the ledger: filter by R1 range + inclusion rule, convert via `to_base`,
  group by group→category, sum net; memoised/invalidated like balances. No report/aggregate tables.
- **Shared inclusion predicate** with R3 (and the spending definition generally) so totals reconcile —
  one definition of "spending", not per-report copies.
- **Drill state** is view-only navigation (group → category → tx); the leaf reuses the register/list
  components (D4).
- **Colours** sourced from F2 category/group metadata when present; deterministic fallback palette
  otherwise.
- **Small-slice "Other"** is a display rollup computed after aggregation; underlying data intact for
  drill.
- **Offline-capable in desktop mode** (Electron); hosted mode is client↔server (architecture §11).

## Resolved decisions (locked 2026-06-21)
1. **Default top level = by GROUP** (LOCKED): the donut/bar aggregates by category **group** first
   (fewer, cleaner slices), drilling group → category → transactions (Actual's model).
2. **Default chart = DONUT** (LOCKED): donut is the default visual, with a **horizontal-bar** toggle as
   the alternative; segments show amount + % of total, center shows the period total.
3. **"By payee" breakdown = DEFERRED (noted)** (LOCKED): not in MVP — category/group is the locked MVP
   spending chart. **Noted for post-MVP:** add a "by payee/merchant" split (Actual offers it; cheap to
   add later behind the same period + inclusion predicate). *Built 2026-11-19: RD13.*
4. **Uncategorized spending = its OWN slice** (LOCKED): uncategorized spending (and the General/Other
   catch-all) appears as its own slice/row so slices always reconcile to the period total, with a gentle
   link to the C5 inbox to categorize — never dropped, never a guilt-trip.

**Note, 2026-11-05 (forgotten-work sweep):** RD2's donut and bar toggle was superseded in a
rebuild by the approved mock (approved 2026-10-10): stacked bars by month for the top 7 categories plus "Other" (RD5, RD8), the
category x month table under them. The donut component (`SpendingBreakdown.svelte`) was deleted
unused. The share of each category is the table's Share column (RD6); a segment opens its drill. RD1 (by group first) holds in the table's grouping.

**Amendments (2026-10-05, each chosen from options with their evidence):**

5. **Spending by category over months, with a category × month table**: beside the
   donut, a monthly view per category (or group), and under the chart a table with one row per
   category, one column per month, then **Average** and **Total**. Default range 6 months (R1 RD6).

**Amendments (2026-10-10, after a review of the app's screens):**

6. **Two more columns in the category × month table: Avg / month and Share**,
   as YNAB, Copilot and Actual show them.
7. **The headline compares with the previous period, in words** ("₹1.2L less than the 6 months
   before", coloured by meaning, D1 RD9); "tracking began in January" when there is no full previous
   period.
8. **Category colours are fixed** (F2 RD6): each category keeps its stored colour on
   every chart and period; the top 7 of the period are coloured, the rest fold into one grey
   "Other". **Amended 2026-11-05 (after web research): colours by rank in the
   chart.** The top 7 of the range take 7 fixed, well-spread colours in order of size (cyan,
   orange, violet, pink, blue, brown, magenta), the table's dots match, the rest stay one grey
   "Other", Uncategorized keeps its dark grey. Never a repeat; a category may change colour when
   the range changes. *Why:* stored colours repeated (19 categories, 10 swatches: Rent, Household
   help and Education all one teal). Simplifi and YNAB colour by rank; dataviz guidance (ONS,
   Grafana) prefers one colour per category across a series of charts, but this is Miserly's only
   chart with category colours. The swatches' Light colours now all reach 3:1 on the page and
   Dark's near-twins are apart (same hues, `app.css`).
9. **A categorised transfer counts by its kind** (2026-10-16, decided after
   comparing how other apps count them; amends the "transfers excluded" rule, architecture §3,
   §6): a transfer between a spending account and a holding may carry a category on its
   spending-side leg (C3 RD5). The shared predicate excludes only an *uncategorised* transfer; a
   Spending-kind category (a loan prepayment filed as spending, Actual's way) is spending, a
   Neutral-kind one (Investments: SIP) is not. The holding's leg is never in a report, so a transfer
   counts once. Why: investment contributions are a movement of the user's own money, not
   consumption (Monarch, Simplifi, Firefly III, MMEX keep them out of spending); YNAB and Actual count
   them as spent because they budget, which Miserly doesn't.
10. **Spending at the viewer's share** (2026-10-20; option C of three ways to split a
   joint account, chosen 2026-10-17). A transaction on a shared account counts at the
   viewer's share (H2), so partners' spending adds up to the household's. Each account's total is
   rounded half-even to the paisa, the remainder going to the account's owner so the holders'
   figures add to the account exactly. Transaction lists in a drill-down show full amounts with the
   share noted. The "Shared accounts only" toggle is removed (built 2026-10-30, with the `?scope=`
   parameter and every shared-only path behind it). Supersedes the Shared view text above
   and the Circle note below.
11. **No by-member table** (2026-10-30, after a competitor check). The "Shared
   spending by member" table (who *logged* each row on shared accounts, in full, with a Share
   column) is removed, and R3's income version is not built. Why: with every figure at the
   viewer's share (RD10) a full-amount table on the same page answers a different question and
   adds up to nothing on it; "logged" is not "spent" (a partner may type another's bill); its
   Share column clashed with "your share". No app checked has a who-logged-it report (Monarch,
   Kubera, Splitwise, Honeydue, Monzo, Lunch Money, YNAB, Actual, Goodbudget, Money Lover, Spendee,
   Wallet); where people ask for one (Monzo, Lunch Money, Spendee) they want *whose* spending it
   is, which Monarch and Honeydue answer with a label per row set by the user. Who logged a row
   stays visible as the "by Alice" stamp in the register's Payee cell. A per-row owner label
   (Monarch's mine / theirs / shared) is noted for later, not planned.

## Circle addendum (Epic 8 · multi-user)

> Added 2026-06-25 by the [Circle epic](../circle/README.md) writeback (D6). Reports are
> **viewer-scoped**; the spending-inclusion predicate is unchanged.

- **Viewer-scoped spending.** The pie covers transactions on the viewer's visible accounts (personal +
  shared in full); a **Shared view** restricts to shared accounts only. No all-Circle report.
- **By-member shared-spending breakdown (dropped 2026-10-30, RD11; was: ships in MVP, [H3](../circle/H3-roles-and-membership.md)):** on
  shared accounts, spending can be broken down by **`entered_by`** (who logged it) — "who spent what from
  the shared pot". This is *who logged it* (audit), not splitwise-style economic attribution (deferred).
- **AC delta:** category totals are computed over the viewer's visible set; a shared-account view offers
  a per-member breakdown by `entered_by`. **Folded into the canonical Acceptance criteria + Inclusion
  rule above (2026-06-25, MODE 2.5 M1).**

12. **The category decides, on every account** (2026-11-05; R3 RD11 has the rule): spending
    by category reads categorised rows on any of the viewer's accounts; the Uncategorized slice is
    bank and card rows only.
13. **By payee, beside by category** (2026-11-19, after a sweep of deferred items;
    amends RD3). A By category | By payee switch on the Spending report's toolbar shows the same
    spending by payee: the same rule (this story's predicate, so the transfers and Not-in-reports
    rows stay out and a refund nets within its payee), the same bars by month with the top 7 and a
    grey Other, the same table (Payee, the months, Avg / month, Share, Total; no group rows) and the
    same drill (a payee's row, cell or bar lists its transactions). Rows with no payee are one "No
    payee" bar in Uncategorized's grey, with no rank. Each month and the total equal the by-category
    ones to the paisa, at the viewer's share (RD10): the payees of one account, day and category
    divide that group's figure, any rounding paisa going to the largest. Export follows the switch
    (one Payee column, the file named "Spending by payee"). The switch stays on when the range
    changes and is dropped on a tab change; viewer-scoped through `accountsVisibleTo` (P0), so a
    payee used only on another member's private account never shows. *Why:* the primary user (P1) is a
    data analyst and Actual offers it; it is a second grouping of recorded rows, not
    intelligence.

## Dependencies
- **Depends on:** R1 (the shared period/window), F2 (groups, categories, kinds — the inclusion rule +
  optional colours), C3 (transfers categoryless → excluded), C5 (uncategorized definition), MC1
  (`to_base` conversion), SET1 (number format), D4 (read-only drill-to-register pattern), the ledger +
  derived-query model (C1).
- **Feeds:** R3 (shares the spending inclusion predicate so spending totals reconcile); any future
  spending insights (intelligence, deferred).
- **Relates to:** D2 (allocation donut — similar donut/"Other" conventions, but D2 is asset composition
  as-of-today, R2 is spending over a period; distinct).
- **Excludes:** budgeting/limits (out of scope), by-payee/by-merchant breakdown (deferred — see
  Resolved decisions), saved custom reports & export (post-MVP), spending advice/anomaly detection
  (intelligence).

---

### Research sources
- Actual Budget — spending split by Category/Group/Payee/Account/Month; **Breakdown = donut or
  horizontal bar**; drill group → category → transactions via slice or legend:
  https://actualbudget.org/docs/reports/custom-reports/ ; https://actualbudget.org/docs/reports/
- Monarch / spending-report UX — donut for parts-of-whole, tooltip amount + % of total, click a slice
  to view its transactions; drill to detail:
  https://help.monarch.com/hc/en-us/articles/21846787088916-Using-Reports ;
  https://getfinny.app/blog/best-expense-tracking-apps-charts-visualizations
- Quicken spending report — donut overview + drill into category transactions:
  https://info.quicken.com/sim/spending-report