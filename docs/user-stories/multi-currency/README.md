# Epic 5 — Multi-currency

> **Core MVP scope, not a nicety.** The bullseye persona is an Indian engineer holding **US RSUs / US
> stocks in USD** alongside INR accounts — net worth is meaningless if a USD account can't fold into the
> INR total. The whole epic is built on one discipline: **convert once, at the aggregation boundary,
> and never store a converted number.**

## Goal

Give each account its own native currency, value everything in base **INR** via a single `to_base`
function, support cross-currency transfers honestly, and present native-primary/INR-secondary
everywhere with one calm rate-management surface — without ever showing a total built on a missing or
silently-assumed rate.

## Scope

**In:** per-account native currency (default INR, immutable in MVP); one current **aggregation rate**
per active foreign currency (manual); cross-currency transfers carrying a frozen **linkage rate**;
native/converted display convention; the rates surface with a "last updated" freshness label.

**Out:** auto-fetch + **historical (dated) FX** (v2 — MVP applies one current rate across all history);
**base-currency change** (MVP base = INR fixed); **view-net-worth-in-another-currency** (v2 transient
switch); a formal realized-FX ledger line / Trading Accounts (v2); per-account rate override (v2);
cross-currency contributions into holdings (later).

## Features → stories

### Feature 5.1 — Currency & base conversion
- [**MC1** — Account currency & base rate](MC1-account-currency-and-base-rate.md) — the **aggregation
  rate**; `to_base(amount, currency) = amount × rate`; missing rate → "rate needed" (**never a silent
  1:1**); one rate per currency across all history.

### Feature 5.2 — Cross-currency transfers
- [**MC2** — Cross-currency transfer](MC2-cross-currency-transfer.md) — extends C3 to two native legs
  coupled by GnuCash's "enter rate **or** to-amount"; the **linkage rate** is frozen per-transaction and
  independent of MC1's aggregation rate; the realized-FX spread shows honestly via derived totals.

### Feature 5.3 — Display & rate management
- [**MC3** — Display & rate management](MC3-display-and-rate-management.md) — native-primary + INR-
  secondary with currency codes; one "Currencies & rates" surface (lives in [Settings](../settings/SET1-settings-and-number-format.md))
  with a passive age label; adds no new math.

## Backbone leaned on

[Convert-once `to_base`](../../product/architecture.md#7-multi-currency--convert-once-at-the-boundary)
· [single source of truth](../../product/architecture.md#1-single-source-of-truth--derived-never-stored)
(no stored conversions) · [double-entry transfers](../../product/architecture.md#3-double-entry--transfers)
(MC2 extends C3) · [shared-service discipline](../../product/architecture.md#11-shared-service-discipline--deployment-model).

## Key locked decisions

- **Two rates kept structurally independent** — aggregation (MC1, standing balances) vs linkage (MC2,
  one transfer). A transfer never mutates the standing mark, and vice-versa.
- **Rate entry fully manual** in MVP (auto-fetch current spot = v2 option, public data/no account access).
- **Base = INR, fixed**; **no per-account rate override**.
- **Realized-FX effect silent & honest** in MVP (no `Equity:Conversions` machinery); linkage rate
  pre-fills from the standing mark but is overridable.

## Dependencies

Depends on **F1** (currency at creation), the **aggregation contract**, **C3/C4** (transfer model MC2
extends), and **D1/D2/D3** (the aggregates that consume `to_base`). The rates UI is hosted by
[**SET1**](../settings/SET1-settings-and-number-format.md). All money figures compose with SET1's
number-format preference.
