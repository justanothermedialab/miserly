# Epic 6 — Settings & preferences

> Small but cross-cutting. This epic discharges the **app-wide number-format rule** locked back in D1
> and provides the **container** that homes the preferences other epics produce (currencies & rates,
> dark mode). The persona is INR-first and thinks in **lakh/crore** — an app that shows "₹1.2M" for
> ₹12 lakh reads as foreign and untrustworthy — but Western grouping is an equal, available choice.

## Goal

One Settings area hosting a single, app-wide **number-format preference** (Indian lakh/crore vs Western
thousands/millions, via one shared `Intl.NumberFormat`-based formatter), plus the
[Currencies & rates](../multi-currency/MC3-display-and-rate-management.md) surface, dark mode, and a
reserved (disabled) base-currency slot.

## Scope

**In:** the Settings container; number-system preference (display-only, locale-derived default);
user-controlled long/compact with a **non-negotiable ledger-exactness guard**; a changeable
foreign-currency grouping preference; hosting MC3's rates surface and dark mode.

**Out:** custom/arbitrary separator builder (over-engineering); per-screen manual long/compact control
(context-driven instead); locale-based language/date formatting (later); **base-currency change**
(post-MVP — reserved disabled slot only).

## Features → stories

### Feature 6.1 — Settings container & number formatting
- [**SET1** — Settings & number format](SET1-settings-and-number-format.md) — the container + the
  app-wide formatter. Stored prefs: `numberSystem` (default from device locale), `compact`
  (user-controlled, guarded), `foreignGrouping`. One formatter `(amount, currency, surface)`; **ledger
  surfaces always render long-form full precision incl. paise** regardless of `compact`.

## Backbone leaned on

[Shared-service discipline](../../product/architecture.md#11-shared-service-discipline--deployment-model)
(one formatter, zero ad-hoc holdouts) · composes with
[`to_base` / native-vs-base display](../../product/architecture.md#7-multi-currency--convert-once-at-the-boundary).

## Key locked decisions

- **Long/compact = manual, user-controlled** — but a hard **ledger-exactness guard** forces full
  precision on registers/transactions/balances regardless.
- **Default number system = derived from device locale** (`en-IN` → Indian, else Western), changeable.
- **Foreign-currency grouping = manual & changeable** (default: user's system applied to all currencies;
  alt: each currency's native-locale grouping). A single global preference.
- **SET1 is the container** — hosts number format, MC3 Currencies & rates, dark mode, and a reserved
  disabled base-currency-change slot.

## Dependencies

Depends on **D1** (where the rule was locked) and **MC3** (the rates section it hosts). **Feeds every
money-rendering surface** app-wide (the one formatter) — D1–D4, registers (C1–C4), and the charts/
reports axes & labels.
