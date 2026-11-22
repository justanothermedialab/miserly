# Epic 3 — Dashboard & net worth

> The home overview and a deliberate differentiator — Actual has no dashboard at all. This is the
> **wealth view** (orientation + navigation, read-only); daily logging lives in the registers/sections
> (the work view). The user uses Actual for exactly two things, and **approximate net worth is one of
> them** — this epic does it better than a spreadsheet.

## Goal

Answer "how am I doing?" at a glance: total net worth now, what it's made of, how it's trending, and
what just changed — all from the **one shared aggregation service** that reads the module contract, so
no dashboard number can ever disagree with the registers.

## Scope

**In:** as-of-today net-worth hero (assets vs liabilities, base INR); allocation by asset class &
liquidity; net-worth-over-time (monthly, reconstructed from the ledger) + "change since last month";
recent-activity feed and account summary grouped by module — all read-only, drilling into registers.

**Out:** spending/income/cashflow (→ Reports), per-instrument detail/performance (→ instruments),
auto/historical FX (v2), any advice/forecast/health-score/staleness nudge (intelligence layer),
inline editing on the dashboard (work-view).

## Features → stories

### Feature 3.1 — Net worth (present & trend)
- [**D1** — Net worth command center](D1-net-worth-command-center.md) — the hero: Σ `current_value()`
  of open accounts, signed by side, as-of-today, in base INR; derived, never stored.
- [**D3** — Net worth over time](D3-net-worth-over-time.md) — monthly month-end line reconstructed
  from the ledger (no snapshots); **includes closed accounts** for periods they were open; computes the
  "change since last month" delta fed back to D1.

### Feature 3.2 — Allocation & composition
- [**D2** — Allocation breakdown](D2-allocation-breakdown.md) — donut of total assets by class and by
  liquidity (with a neutral liquid-% fact); liabilities shown separately, never as a negative slice.

### Feature 3.3 — Activity & navigation
- [**D4** — Recent activity & account summary](D4-recent-activity-and-account-summary.md) — latest-N
  cross-account feed (transfers/marks labelled) + accounts grouped by module with subtotals; tap-to-
  open into registers/sections.

## Backbone leaned on

[Aggregation contract](../../product/architecture.md#5-per-instrument-modules-behind-one-aggregation-contract)
(one service, three presentations across D1/D2/D3/D4) ·
[derived, never stored](../../product/architecture.md#1-single-source-of-truth--derived-never-stored) ·
[as-of-today](../../product/architecture.md#8-as-of-today-vs-projected) (D1/D2/D4) vs
[closed-account history](../../product/architecture.md#10-lifecycle-closed-not-archived) (D3) ·
[convert-once `to_base`](../../product/architecture.md#7-multi-currency--convert-once-at-the-boundary).

## Key locked decisions

- The aggregation **never branches on concrete instrument type** — reads `current_value`/`side`/
  `currency`/`status` only. Any divergence between hero and Σ-account-balances is a P0.
- Hero = **as-of-today only**; "change since last month" computed in **D3** (not duplicated in D1).
- **Number formatting is app-wide & multi-format** — locked here as a cross-cutting rule, later owned
  by [SET1](../settings/SET1-settings-and-number-format.md).
- D3 = **monthly points**, default 1Y, net-worth line default (toggle to assets/liabilities), historical
  FX = today's manual rate in MVP.

## Dependencies

Depends on **Foundations** (F1 metadata/balances), the **aggregation contract**, **Capture** (the
ledger, `(date, sequence)`, back-dated recompute for D3), and **Multi-currency** (`to_base` for foreign
accounts). The account summary (D4) links into the **per-instrument sections** epic and shares its
grouping taxonomy.
