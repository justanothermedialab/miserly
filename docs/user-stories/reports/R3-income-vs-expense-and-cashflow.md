# R3 — Income vs expense & cashflow

> **Epic:** Charts / reports · **Story:** R3 · **Status:** LOCKED (2026-06-21)
> **MVP scope:** CRUD + descriptive charts only, zero intelligence.

---

## Title
As the user, I can see **how much came in vs how much went out** over the selected period — income vs
expense per month, and the **net cashflow** (in − out) — so I know whether I'm running a surplus or a
deficit, month by month, without any budgeting.

## ELI5
Money comes in (salary, interest), money goes out (spending). This report puts the two side by side for
each month and tells me the difference — did I end the month up or down? It's not my net worth (that
includes my investments going up and down); it's just "earned minus spent". Moving money into
investments isn't "spending" — that's a transfer — so a good saver shows a healthy surplus here.

## Business context
This is the second product-defining MVP chart (plan: *income-vs-expense per month, bar*), the
companion to R2. Where R2 answers "where did spending go?", R3 answers "am I net positive?". It lives in
Reports (R1) and answers for the **shared selected period**, binned by month.

Conventions adopted from the field:
- **Income vs expense, month by month, with a net per month** — YNAB's Income v Expense (income green /
  expense red, net inflow per month, period totals) and Monarch's Cash Flow trends (grouped/stacked
  bars over time, click → transactions)
  ([YNAB income v expense](https://support.ynab.com/en_us/income-v-expense-Byu1BYWRq),
  [Monarch cash flow](https://help.monarch.com/hc/en-us/articles/20504904768020-Cash-Flow)).
- **Bar/column visualization** with income and expense per period and a **net** indicator
  ([Actual reports](https://actualbudget.org/docs/reports/)).
- **Drill to transactions** from any bar/segment (D4 pattern).

**Correctness backbone (F2 kinds, same discipline as R2):**
- **Income = Income-kind** inflows; **Expense = Spending-kind** outflows (R2's exact spending predicate,
  shared so the two reports' spending totals reconcile).
- **Transfers excluded** (categoryless, C3) and **Neutral excluded** (e.g. Investments) — so **moving
  money into a holding is neither income nor expense**; it's a transfer between your own accounts.
- **Net cashflow = income − expense** for the period — pure descriptive arithmetic.

**Crucial distinction (a failure mode to prevent): net cashflow is NOT net-worth change.** Net worth
(D1/D3) also moves with **valuation marks** (unrealized gains) and counts **all** accounts; cashflow is
only realized in/out via Income and Spending. A month can have negative cashflow but rising net worth
(markets up), or positive cashflow that's all sitting as a transfer into an FD. Both are correct; the
report must not conflate them. **Savings-rate (%)** is explicitly **deferred** (plan: savings-rate =
later/intelligence); R3 shows the raw net figure only.

## User workflow

### Happy path — multi-month trend
1. The user sets the period to **This FY** (R1). R3 shows a **bar per month**: income vs expense, with
   the **net** for each month (surplus green / deficit red) and a clear running sense of the trend.
2. The header shows **period totals**: total income, total expense, **net cashflow**.
3. Hovering a month shows its income, expense, and net; tapping drills to that month's transactions.

### Happy path — single month (default)
- With the default **This month**, R3 shows **that month's** income vs expense and net (a compact
  in/out/net summary + bar), still useful ("this month: +₹1.2L in, −₹80k out, net +₹40k"). A trailing
  context option may show recent months (see Resolved decisions).

### Alt path — view options
- Toggle bar style (**grouped** income-vs-expense vs **stacked**/paired) per Resolved decisions; changing the R1
  period re-bins by month.

### Edge/empty path
- **No activity:** calm "no income or spending in this period" state.
- **Income-only or expense-only month:** shows the one side, net = that side.

### Recovery path
- Read-only; corrections via drill-to-register; re-categorizing or fixing a kind (F2) updates the report
  immediately (derived).

## Acceptance criteria
- [ ] An **Income vs expense** report renders for the **R1 period**, **binned by month**, over the
      **viewer's visible accounts** (`owned ∪ member-of`; a **Shared view** restricts to shared accounts
      only; **no all-Circle aggregate**), showing income and expense per month and the **net (income −
      expense)** per month. ~~On shared accounts, a **by-member (`entered_by`)** split is available (H3).~~
      **Dropped 2026-10-30 (RD9; never built).**
- [ ] **Period totals** are shown: total income, total expense, and **net cashflow** for the whole range.
- [ ] **Income = Income-kind inflows; Expense = Spending-kind outflows** (the shared R2 predicate);
      **transfers and Neutral are excluded** — investment contributions never count as income/expense.
- [ ] **Net is signed honestly**: surplus vs deficit visually distinct (e.g. green/red); a deficit month
      is shown plainly.
- [ ] **Refunds net within expense; income reversals net within income** (F2 signed-within-kind) — totals
      are net, not gross.
- [ ] **Drill to transactions** from a month/segment (read-only → register, D4).
- [ ] **Multi-currency** converted to base INR via `to_base` (MC1); missing rate → "rate needed" (MC1),
      never a wrong total.
- [ ] Figures respect the **number-format preference** (SET1); compact on axes, full in totals/legend.
- [ ] **Net cashflow is presented distinctly from net-worth change** — the report does not label or imply
      that net cashflow equals the change in net worth (D1/D3).
- [ ] The report is **derived** (no stored aggregates); edits/recategorizations reflect immediately.
- [ ] **Empty period** → calm empty state.

## Validation rules
- **Income inclusion:** account activity whose category group **kind = Income** (inflows). **Expense
  inclusion:** identical to R2 (Spending account, non-transfer, Spending-kind or uncategorized spending).
  **Both are restricted to the viewer's visible accounts** (`owned ∪ member-of`).
- **Exclusions:** transfers (C3), Neutral-kind (investments and the like), valuation marks (S3, never a
  cash flow) — none appear in income or expense.
- **Monthly binning:** by calendar month within the R1 range, using `(date)` (date-only); the current
  month is **partial (month-to-date)** consistent with R1's as-of-today semantics.
- **Net:** `net = income − expense` per month and for the period total; can be negative.
- **Conversion & format:** `to_base` (MC1); SET1 number format.
- **Reconciliation:** R3's total expense for a period **equals** R2's total spending for the same period
  (shared predicate) — a hard invariant.

## Edge cases
- **Partial current month** (default This month): shown as month-to-date; not annualized or extrapolated
  (extrapolation = intelligence, deferred).
- **Large one-off income** (bonus, asset sale proceeds landing as income vs as a transfer): if it's a
  transfer from a holding (selling an investment → bank), it's **not income** (correct); only true
  Income-kind inflows count. (This prevents inflating "income" with portfolio liquidations.)
- **Deficit month / all months negative:** shown honestly; no euphemism.
- **Surplus entirely transferred to investments:** cashflow shows the surplus; the transfer out to the
  holding is excluded — so surplus doesn't "vanish" into looking like spending.
- **Refund larger than month's spend in a category:** expense nets down (possibly a negative expense
  contribution) — handle in totals without breaking the bar geometry (mirror R2's net-negative note).
- **Multi-currency income/expense:** each converted via `to_base`; missing rate surfaces (MC1).
- **Single-day or very short range:** one (partial) month bin; still valid.

## Failure cases
- **Net cashflow presented/implied as net-worth change:** defect — they are different quantities (the
  headline must not say "your net worth changed by net cashflow").
- **Transfers or Neutral counted as income/expense:** defect — inflates both sides and breaks the
  in-vs-out story (a common competitor bug).
- **Investment liquidation counted as income** (a transfer from a holding to bank): defect — it's a
  transfer, not income.
- **R3 expense total ≠ R2 spending total** for the same period: defect — shared predicate must agree.
- **Gross instead of net** (refunds/reversals not subtracting): defect.
- **Valuation marks leaking into cashflow:** defect — marks are not cash flows (S3).
- **Current month shown as full** (not month-to-date) misleadingly: defect.

## UX considerations
- **In vs out at a glance** — paired income/expense bars per month with an obvious **net** (surplus
  green / deficit red), period totals up top; the YNAB/Monarch mental model users know.
- **Name it carefully** — "Income vs expense" / "Cashflow", never "net worth change"; a small caption can
  clarify "earned minus spent — excludes transfers & investment value changes" so the distinction from
  D1/D3 is explicit.
- **Single-month default is still useful** — a compact in/out/net; offer (optionally) a trailing-months
  context so the trend isn't lost on the default period (Resolved decisions).
- **Drill to truth** — any bar → the transactions behind it (read-only → register).
- **Honest deficits** — red, plain, no judgment (advice = intelligence, deferred).
- **Surplus framing without budgeting** — "net +₹40k" describes; it does not prescribe envelopes/targets.
- Period + currency context always visible (R1/MC3).

## Operational considerations
- **Derived query** over the ledger: filter by R1 range, classify each row as income/expense via the
  shared kind predicate, exclude transfers/Neutral/marks, convert via `to_base`, bin by month, sum net;
  memoised/invalidated like balances. No aggregate tables.
- **Shared spending predicate with R2** (one definition; R3 adds the symmetric income predicate) — the
  structural guarantee that R2 and R3 reconcile.
- **Monthly binning helper** reused (same calendar-month logic as D3's monthly points, though D3 is
  net-worth and R3 is cashflow — distinct measures, shared time-binning).
- **Net-worth-change separation:** R3 never reads holding values/marks; it only sees Income/Spending
  flows — keeping it structurally distinct from D1/D3.
- **Drill** reuses the register/list components (D4).
- **Offline-capable in desktop mode** (Electron); hosted mode is client↔server (architecture §11).

## Resolved decisions (locked 2026-06-21)
1. **Single-month default = show just that month** (LOCKED, option a): when the period is one month (R1
   default "This month"), R3 shows that month's income/expense/net compactly — strict consistency with
   R1's one-period model. The multi-month trend appears when the user picks a multi-month range (3M/6M/
   FY/etc.). A "show recent months" context affordance may be added later (non-blocking). *(Moot since 2026-10-05: R1 RD6 opens on 6 months, so the trend is the default.)*
2. **Bar style = GROUPED (income vs expense side-by-side) + net indicator** (LOCKED default). **Deferred
   (noted):** a **YNAB-style up/down toggle** (income up / expense down) as a selectable knob — not in
   MVP, recorded as a post-MVP view option behind the same data.
3. **Savings-rate (%) = DEFERRED** (LOCKED): R3 shows raw **net cashflow (₹)** only — no %/rate in MVP.
   **Deferred (noted):** savings-rate (net ÷ income %) and its trend = later/intelligence layer.
   *Amended by RD6 (2026-10-10) and RD16 (2026-11-19): the rate is shown.*
4. **Net cashflow caption = YES** (LOCKED): include a short clarifying caption ("earned minus spent —
   excludes transfers & investment value changes") so it's never conflated with net-worth change (D1/D3).

**Amendments (2026-10-05, each chosen from options with their evidence):**

5. **Its own report tab with its own range** (R1 RD5, RD6), the table under the chart; income green,
   expense red, net by its sign (D1 RD7).

**Amendments (2026-10-10, after a review of the app's screens):**

6. **Savings rate in the headline** (amends RD3): "Saved 72% of income", net ÷
   income for the period, beside the net figure; the table's Saved column stays. Descriptive (a ratio
   of recorded figures), as Monarch and Lunch Money show it.
7. **Invested beside income and spending** (2026-10-16; C3 RD5): R3 adds
   an **Invested** figure, net per month: categorised transfers of a Neutral (Investments) kind from
   the spending accounts into holdings, minus redemptions back. It's shown only when the period has
   any (a column in the table, a figure beside "in" and "out"). Net and the savings rate are unchanged
   (income − spending): investing is part of what was saved, as in a cash-flow statement's split of
   operating from investing activity. Descriptive only.
8. **Income, spending and saving at the viewer's share** (2026-10-20; option C of three ways
   to split a joint account, chosen 2026-10-17). As R2: a shared account's income,
   spending and invested amounts count at the viewer's share (H2), rounded the same way, so
   partners' figures add to the household's and the savings rate is the viewer's own. The "Shared
   accounts only" toggle is removed. Supersedes the Shared view text above and the Circle note
   below.
9. **No by-member split** (2026-10-30; R2 RD11 has the reasons and the competitor check).
   Income and expense have no "who logged it" table; it was never built.

**Forgotten-work sweep (2026-11-05; the one click-through rule):**

10. **A month drills into its transactions**, as R2's cells do: a month's Income or Spending figure
   in the table, or its bar in the chart, lists that month's income or spending rows below the
   table (date, payee, account with "Your share" on a joint one, amount), newest first; the Total
   row's figures list the whole range. Same predicate as the figures, so the rows add up to the
   figure clicked (at the share). Net, Saved and Invested don't drill.

## Circle addendum (Epic 8 · multi-user)

> Added 2026-06-25 by the [Circle epic](../circle/README.md) writeback (D6).

- **Viewer-scoped cashflow.** Income-vs-expense + cashflow bars cover the viewer's visible accounts
  (personal + shared in full), mirroring [R2](R2-spending-by-category.md); a **Shared view** restricts to
  shared accounts. No all-Circle aggregate. The shared spending/income predicate is unchanged (totals
  still reconcile with R2).
- ~~**By-member breakdown** on shared accounts via `entered_by`, consistent with R2.~~ Dropped
  2026-10-30 (RD9).
- **AC delta:** monthly bins are computed over the viewer's visible set; shared-account view offers a
  per-member split. **Folded into the canonical Acceptance criteria + Income/Expense inclusion rules
  above (2026-06-25, MODE 2.5 M1).**

11. **The category decides, on every account** (2026-11-05: income is a category,
    with subcategories like salary and interest). Income and
    spending read categorised rows on **any** of the viewer's accounts, not only bank and card: a
    Salary row typed on EPF or Interest typed inside an FD is income. An uncategorised row counts as
    spending only on a bank or card account; on a holding it moves value and stays out, as value
    updates always do. "All time" starts at the first categorised row on any account, or a bank or
    card account's first activity (R1 RD9, amended 2026-11-06).
    R2 and R3 keep one predicate (R2 RD12 is the same rule), so they still reconcile.
    *Amended 2026-11-06 (after a review of the app):* moving a row to a holding keeps its category (C4 RD7),
    so a Salary row typed on the bank by mistake and moved to EPF stays income.
12. **Money put straight into a holding is Invested** (2026-11-09, after a
    review of the app; S2 RD10). A plain row on a holding whose category doesn't count as return adds to
    Invested by its amount (money taken out the same way subtracts): EPF's ₹7,200 Salary typed
    inside the EPF is ₹7,200 of income and ₹7,200 invested, as the holding counts it. Interest
    typed inside a holding stays income only.
13. **Invested reads the Investments kind, transfers and plain rows alike** (2026-11-09,
    after a review of the app; F2 RD10). A row on a bank or card whose category's group is
    of the Investments kind counts as invested whether it's a transfer to a fund or a plain row (an
    SIP typed on the bank, money gone to a fund the app doesn't track, "same as ATM withdrawal"); a
    redemption back subtracts. The person's own Not-in-reports groups ("Lent to Ravi") stay out,
    and so does a transfer categorised under one (it counted before). A transfer's category sits on
    its bank leg only, so nothing counts twice. *Why:* the SIP typed as a plain bank row was in
    neither Spending nor Invested.
14. **The figure reads "Net invested"** (2026-11-09, after a review of the app): in the headline
    ("₹X net invested"), the month table's column and the CSV. It is money moved into investments
    in the period, net of money taken back; a holding's "Invested" is the cost of what it still
    holds (S2 RD11), so the two differ on purpose and keep different names.
15. **The category stays the one control for Net invested** (2026-11-11, after a
    read of the money logic). A transfer from a bank or card into a holding typed with no category is in no
    figure, as RD7 and RD13 say, and is not in To categorize; neither is changed, and rows already
    typed or imported with no category are left alone. What changed is the capture side: a transfer
    remembers its category per destination account (F3 RD9), so it is picked once and filled in
    after that. The guide says that Net invested counts what is filed under Investments.
16. **The savings rate, one rule** (2026-11-19, after a sweep of deferred items; amends RD3,
    settles RD6). Net over income, for each month (the table's Saved column) and for the range
    (the Total row and the headline's "Saved 72.0% of income"), as a percentage with one decimal,
    a deficit with the minus sign. Where there is no income to divide by (none, or reversals
    beyond it) the cell shows the en dash the app uses for a figure it can't work out, the CSV
    leaves the cell empty, and the headline leaves the sentence out (the Total row still shows
    the dash). No green or red: it is muted text in every case, descriptive arithmetic on
    recorded rows, not a judgement. One helper (`$lib/reports/savings-rate.ts`) rounds once for
    the screen and the CSV, so they never disagree. *Why:* the sweep took RD3's "later /
    intelligence" for a still-open deferral; RD6 had already shown the rate in October with two
    rounding paths (the screen's and the CSV's), now one.

## Dependencies
- **Depends on:** R1 (shared period + monthly binning context), F2 (kinds — income/expense/neutral
  classification), R2 (shared spending predicate; reconciliation), C3 (transfers excluded), S3
  (valuation marks excluded), MC1 (`to_base`), SET1 (number format), D4 (drill-to-register), the ledger
  + derived-query model (C1).
- **Relates to:** D3 (net-worth-over-time — the *wealth* trend, explicitly distinct from cashflow), R2
  (the spending half of the same period).
- **Feeds:** any future savings-rate / cashflow-forecast / FI-trajectory features (all intelligence,
  deferred).
- **Excludes:** savings-rate % and trends (deferred), forecasting/extrapolation (intelligence),
  budgeting/targets (out of scope), by-category income/expense drill beyond the month→transactions path
  (the category breakdown is R2's job), export/saved reports (post-MVP).

---

### Research sources
- YNAB — Income v Expense: income (green) vs expense (red) month by month, net inflow per month
  (over/under coloured), period totals; current month partial:
  https://support.ynab.com/en_us/income-v-expense-Byu1BYWRq ; https://www.ynab.com/blog/ynab-reports-and-data
- Monarch — Cash Flow: inflows/outflows overview, Trends bar chart (grouped or stacked) over time,
  click a bar → transactions: https://help.monarch.com/hc/en-us/articles/20504904768020-Cash-Flow ;
  https://help.monarch.com/hc/en-us/articles/21846787088916-Using-Reports
- Actual Budget — cash flow / reports: separate income & expense visualizations over time:
  https://actualbudget.org/docs/reports/ ; https://actualbudget.org/docs/tour/reports/
