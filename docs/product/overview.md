# Product overview

> Domain tier. The "what and why" behind every story. Distilled from the locked plan; the stories in
> [`../user-stories/`](../user-stories/) are the buildable output.

## Persona — the self-directed mass affluent

**Not** an HNWI. The top ~10% by wealth: comfortable, deliberately **DIY**, won't pay for management.
A penny-pincher mindset ("where every cent goes") who *also* holds every asset type — bank, cards,
mutual funds, stocks, FD/RD, PPF, EPF, NPS, property, gold, loans, and US RSUs/stocks in USD.

The bullseye is an **Indian software engineer / data scientist**: INR-first, thinks natively in
**lakh/crore**, holds **foreign-currency (USD) investments**, and currently maintains all of this by
hand in a spreadsheet or stretches Actual Budget past its limits.

The niche sits between **Monarch** (budgeting / couples) and **Kubera** (complex-asset HNWI). The
primary user is the person we're building for first; the model must not block others, but it anchors
on him.

The group members this user would add (a partner, a parent, a flatmate or co-investor),
extrapolated from this persona, are in [`personas.md`](personas.md).

## Product definition

Miserly = **expense tracking + net-worth tracking**.

- **Tracking** = categorizing where money already went (reactive). This is the core.
- **Budgeting** = proactively assigning money to envelopes ahead of time. **Out of core scope** — an
  optional layer on categories that may never be built.

The synthesis, and the wedge:

- **Actual-grade ledger** — keyboard-first entry, reliable running balances, payees/categories. This
  is **table-stakes** (parity-or-better), not the differentiator.
- **Ghostfolio-grade holdings** — cost basis, returns, allocation for the asset side.
- **India-native instruments** — FD/RD/PPF/EPF/NPS/SGB/gold/loans that the app actually *understands*.
  This is **the wedge**: Actual is *instrument-blind* (every account is a generic ledger); a tool that
  knows what a PPF or an FD *is* beats both a spreadsheet and Actual.

A second differentiator: a **dashboard / net-worth command center** — Actual notably has none.

## MVP scope (LOCKED)

**MVP = CRUD + descriptive charts only. ZERO intelligence.** Everything analytical/predictive is a
later, modular layer.

What that means concretely:

- **Single source of truth — everything is transaction-based.** Every account's balance =
  `opening + Σ(its transactions)`. Nothing stores a separate "value" that can drift. This is the
  root-cause fix for the original "inconsistent data across screens" problem.
- **Double-entry transfers** — moving money is two linked rows; net worth is invariant under transfers.
- **Manual valuation via marks** — market movement (the only thing that isn't a cash flow) is recorded
  by a **valuation mark**: the user asserts "now worth ₹X" and the system posts the gap as one
  adjustment row. Feels like a snapshot; stored as a transaction, so nothing drifts.
- **Descriptive charts only** — net-worth-over-time, income-vs-expense, spending-by-category,
  allocation-by-class, plus (2026-10-05) assets vs liabilities, net worth by
  class or account over time with a recap table, spending by category over months with a
  category × month table, and month-to-date spending vs last month. Holding value vs invested comes
  later. They visualize recorded data; they never advise or forecast.
- **Per-instrument modules stay separate** behind one **aggregation contract** (see
  [`architecture.md`](architecture.md)).
- **Multi-user — a "Circle" with private + shared accounts.** One self-hosted instance serves a group
  (family, roommates, partners, co-investors) behind individual logins. Accounts are **private by
  default** and **selectively shared**; net worth and reports are **viewer-scoped**; even the admin
  cannot see members' private accounts. ("Circle" is use-case-neutral vocabulary, not "household".) See
  [Epic 8](../user-stories/circle/README.md) and [architecture §12](architecture.md#12-members-circle--visibility-multi-user).
- **Greenfield rebuild** — server-centric (one Node server owns the data), deployable as an Electron
  desktop app and a self-hostable web app. An earlier prototype was mined for lessons only.

See [`architecture.md`](architecture.md) for the cross-cutting rules and the module model.

## Roadmap (epic order)

1. **Foundations** — accounts, categories, payees.
2. **Capture** — the keyboard-first entry/edit loop (the make-or-break).
3. **Dashboard & net worth** — the home overview.
4. **Per-instrument sections** — a page per module, instrument-shaped.
5. **Multi-currency** — native per account, convert at the boundary.
6. **Settings & preferences** — number format, currencies & rates container.
7. **Charts / reports** — spending, income/cashflow, date ranges.
8. **Circle & shared accounts** — the multi-user layer: logins, private/shared accounts, viewer-scoped
   aggregates. Cross-cuts the others (its identity brick, H1, is a structural prerequisite; the rest
   adds a viewer-scope clause to net worth/reports/transfers/payees).

The full epic → feature → story breakdown is the [user-stories index](../user-stories/README.md).

## Deferred

**Permanently deferred until explicitly re-activated:**

- **Onboarding** (a first-run experience). *Import from Actual Budget is no longer deferred:*
  undeferred 2026-11-05 and built 2026-11-10 as F4 (Actual's own export zip, read in
  the app, no `actualpy`). Other imports stay out.
- **Intelligence / AI layer** — auto-categorization that learns, recurring-transaction detection,
  cashflow forecasting, anomaly detection, FI-trajectory projection, financial-health score,
  "sparse activity" nudges, savings-rate insights.

**v2 (deferred, modular — slot in behind the same contracts):**

- Per-module **valuation from typed inputs** (allowed; not yet scoped): e.g. FD/RD/PPF/EPF
  interest accrual from the rate and dates the user typed; the India tax math (TDS, 80C, EEE, etc.).
- **Historical FX** from rates the user types per date. MVP uses one current manual rate per
  currency, applied across all history.

**Ruled out by the data hard line (2026-10-10):** reading or importing SMS, email
or bank statements, and bank or broker links: the app never reads the user's personal or financial
data. **Allowed (2026-10-10):** units × a public NAV / price (MF/Stocks/Gold/NPS) and public FX,
from whole public files with nothing about the user sent out (a caveat: most users type amounts,
not units, so it may help little); valuation computed from typed inputs, labelled an estimate, a typed
value always winning.
- Realized-gain-on-sale / FIFO; a formal realized-FX ledger line.
- **Base-currency change** (MVP base = INR, fixed).
- **View net worth in another currency** (transient display switch).

**Post-MVP "noted" items** (recorded inside individual stories; do not start unprompted):

- Asset↔liability linking & net-equity grouping ([S4](../user-stories/instruments/S4-asset-liability-linking-net-equity.md) — spec written, build deferred).
- Circle settle-up extras ([H4](../user-stories/circle/H4-cross-member-money.md)): **(B)** privacy-respecting "pay a member" direct settle-up; **(C)** Splitwise-style IOU / who-owes-whom ledger. Also: invite-links (MVP = admin-creates-login), multi-admin, encryption-at-rest, a view-only sharing tier.
- By-payee spending breakdown (R2); YNAB up/down cashflow toggle and savings-rate % (R3).
- Customizable/saved report dashboards + export; super-class allocation taxonomy (D2).
- Drag-reorder of nav sections (S1); statement/billing for credit cards (S5).
