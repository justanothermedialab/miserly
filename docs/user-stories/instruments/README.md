# Epic 4 — Per-instrument sections

> The structural expression of **the wedge**. Actual is *instrument-blind* — every account is a generic
> ledger. Miserly's whole differentiation is that it *knows what each instrument is*: an FD has a
> maturity and a rate, a PPF has a cap and a lock-in, a loan has an outstanding. This epic is the
> banking-app / INDmoney IA and the thin per-module profiles that make it feel native.

## Goal

A dashboard-plus-a-section-per-instrument navigation, a uniform **holding model** (value / cost basis /
return) and **valuation mark** shared by all holdings, and a per-module **profile catalogue** — all on
one transaction engine and one aggregation contract, so a new instrument is "a few new files."

## Scope

**In:** section IA & the add-account discovery picker; the holding view (value/invested/return) derived
from the ledger; the valuation-mark primitive (assets + holding-liabilities); the **11-module v1 profile
catalogue** (PPF/EPF/NPS deferred to v2; metadata + captured fields + display-only informational
fields); standalone secured/
unsecured loans.

**Out (MVP):** **all auto-valuation** — units×NAV, price/NAV lookup, interest accrual, maturity/cap
alerts (v2, behind the same contract); the India tax math (v2 reference in the plan); asset↔liability
**linking/equity grouping** ([S4](S4-asset-liability-linking-net-equity.md) — spec written, **build
deferred**); statement/billing for cards (deferred); FIFO/realized-gain-on-sale (v2).

## Features → stories

### Feature 4.1 — Section IA & navigation
- [**S1** — Section IA & navigation](S1-section-ia-and-navigation.md) — Dashboard + a visible section
  per instrument type (shown even when empty, to advertise capability); add-account surfaces the **full
  module list**; **Bank and Credit Cards are separate sections**; grouping matches D2/D4.

### Feature 4.2 — Holding valuation model
- [**S2** — Holding account model](S2-holding-account-model.md) — value = `opening + Σtx`; **cost basis
  = net contributions** (transfer legs); **return = value − cost basis** (₹ & %); onboard with
  invested + current value.
- [**S3** — Valuation mark](S3-valuation-mark.md) — assert "now worth ₹X" → post the gap as one
  non-transfer adjustment (value only, not cost basis); markable holdings incl. **loan outstanding**.

### Feature 4.3 — Asset↔liability linking *(build deferred)*
- [**S4** — Asset↔liability linking & net equity](S4-asset-liability-linking-net-equity.md) — optional
  1:1 link (home loan ↔ flat, car loan ↔ car) showing **net equity**; **purely presentational** — net
  worth is already correct via standalone accounts. The full spec for when it's built post-MVP.

### Feature 4.4 — Instrument profiles
- [**S5** — Instrument profiles](S5-instrument-profiles.md) — the **11-module v1 catalogue**: Bank,
  Credit Card, Mutual Funds, Stocks, FD, RD, Property, Gold, Loans, Other-asset, Other-liability
  (**PPF/EPF/NPS deferred to v2**) — each with side/liquidity/spending-vs-holding/cardinality/markable,
  plus captured & display-only fields.

## Backbone leaned on

[Per-instrument modules + aggregation contract](../../product/architecture.md#5-per-instrument-modules-behind-one-aggregation-contract)
· [valuation marks](../../product/architecture.md#4-valuation-marks-mark-to-market) ·
[single source of truth](../../product/architecture.md#1-single-source-of-truth--derived-never-stored) ·
[spending vs holding](../../product/architecture.md#6-spending-vs-holding-f2-kinds) ·
[closed-not-archived](../../product/architecture.md#10-lifecycle-closed-not-archived).

## Key locked decisions

- **All valuation is manual marks** in MVP; informational fields (rate, maturity, cap) are **display-
  only — never computed on**. Auto-valuation engines are v2, slotting in behind `current_value()`.
- **NPS in v1**; **Other-asset / Other-liability** catch-alls in v1 (so nothing is un-trackable).
- **Stocks/MF in MVP = value-marks + cashflow cost basis (no units)** — units×price a likely post-MVP
  revisit (no one reliably remembers units).
- S4 linking **deferred**; net worth correct via standalone accounts; unsecured loans first-class.

## Dependencies

Depends on the **module registry** (architecture), **F1** (creation/metadata/cardinality), **Capture**
(ledger + transfers = contributions), and **D1/D2** (metadata-driven aggregation). Feeds the Dashboard
via the contract. Cross-currency holding contributions (SIP → foreign fund) = MC2 × instruments,
deferred.
