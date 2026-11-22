# Epic 7 — Charts / reports

> The expense-tracking payoff. Where the Dashboard answers "how am I doing *right now*?", Reports
> answers "what happened *between these dates*?". Two product-defining charts (spending-by-category,
> income-vs-expense/cashflow) over one shared, India-aware date range. Purely **descriptive** — no
> forecasts, no advice (that's the deferred intelligence layer).

## Goal

A dedicated Reports area with **one shared date-range selector** driving every report, plus the two MVP
charts — all **derived queries** over the ledger (no aggregate/snapshot tables), reconciling with each
other and with the Dashboard by construction.

## Scope

**In:** the Reports shell + shared period (presets incl. India FY Apr–Mar, live vs static, custom
range); spending-by-category (donut + bar, drill group→category→transactions); income-vs-expense per
month + net cashflow; drill-to-register; the shared spending-inclusion predicate.

**Out:** customizable/saved report dashboards & export (post-MVP); by-payee breakdown (R2, noted);
YNAB up/down toggle & savings-rate % (R3, noted); configurable FY start (deferred); forecasting/
insights (intelligence layer).

## Features → stories

### Feature 7.1 — Reports shell & date range
- [**R1** — Reports shell & date range](R1-reports-shell-and-date-range.md) — the area + the one
  period control all reports share; presets (This/Last month, quarter, **This FY/Last FY**, YTD &
  FY-to-date, All time) + Custom; default This month, month-to-date semantics.

### Feature 7.2 — Spending by category
- [**R2** — Spending by category](R2-spending-by-category.md) — donut (default) / horizontal bar,
  aggregate by group, drill to category then transactions; only Spending-kind, refunds net within
  category, uncategorized as its own slice.

### Feature 7.3 — Income vs expense & cashflow
- [**R3** — Income vs expense & cashflow](R3-income-vs-expense-and-cashflow.md) — income vs expense
  binned by month + net cashflow; **shares R2's spending predicate** (reconciliation invariant);
  excludes transfers/Neutral/marks; a caption keeps it distinct from net-worth change.

## Backbone leaned on

[Spending vs holding / F2 kinds](../../product/architecture.md#6-spending-vs-holding-f2-kinds)
(shared predicate) · [derived queries, never stored](../../product/architecture.md#1-single-source-of-truth--derived-never-stored)
· [double-entry transfers excluded](../../product/architecture.md#3-double-entry--transfers) ·
[convert-once `to_base`](../../product/architecture.md#7-multi-currency--convert-once-at-the-boundary)
· [time: date-range only in Reports](../../product/architecture.md#9-time-dashboard-vs-reports).

## Key locked decisions

- **One shared period** drives all reports; date-ranging lives **only** here, never on the Dashboard.
- **India FY = Apr 1 – Mar 31** is first-class; both calendar-YTD and FY-to-date offered.
- **R2 default = donut, by group**; uncategorized = its own slice; by-payee deferred (noted).
- **R3 grouped bars + net**; single-month default shows just that month; **net cashflow ≠ net-worth
  change** (required clarifying caption); YNAB up/down toggle & savings-rate % deferred (noted).
- **Hard reconciliation invariant:** R3 expense total == R2 spending total for the same period.

## Dependencies

Depends on **Capture** (the ledger + `(date, sequence)`), **F2** (kinds), **C3** (transfers excluded),
**S3** (marks excluded), **MC1** (`to_base`), **SET1** (number format), and **D4** (drill-to-register).
Relates to **D3** (the *wealth* trend — explicitly distinct from cashflow).
