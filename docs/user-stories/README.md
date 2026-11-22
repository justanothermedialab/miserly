# User stories — the spine

The complete **epic → feature → story** map for the active MVP program: **8 epics · 29 stories, all
LOCKED**. Each story is a self-contained spec (Title · ELI5 · Business context · Workflow · Acceptance
criteria · Validation · Edge cases · Failure cases · UX · Operational · Resolved decisions ·
Dependencies + cited research).

For context above this layer, see [`../product/`](../product/): the
[overview](../product/overview.md), the [architecture backbone](../product/architecture.md), and the
[key workflows](../product/workflows.md).

## The map

| # | Epic | Features | Stories |
|---|------|----------|---------|
| 1 | [Foundations](foundations/README.md) | Accounts · Categories · Payees · Import | F1–F4 (4) |
| 2 | [Capture](capture/README.md) | Entry · Transfers · Editing · Inbox | C1–C5 (5) |
| 3 | [Dashboard & net worth](dashboard/README.md) | Net worth · Allocation · Activity | D1–D4 (4) |
| 4 | [Per-instrument sections](instruments/README.md) | Section IA · Holding model · Linking · Profiles | S1–S5 (5) |
| 5 | [Multi-currency](multi-currency/README.md) | Currency & rate · Cross-currency transfer · Display | MC1–MC3 (3) |
| 6 | [Settings & preferences](settings/README.md) | Settings container & number format | SET1 (1) |
| 7 | [Charts / reports](reports/README.md) | Reports shell · Spending · Income/cashflow | R1–R3 (3) |
| 8 | [Circle & shared accounts](circle/README.md) | Identity & access · Money between members | H1–H4 (4) |

## All stories

### 1 · Foundations — [epic](foundations/README.md)
- [F1 — Account lifecycle](foundations/F1-account-lifecycle.md) (create · open · close · reopen)
- [F2 — Categories & groups](foundations/F2-categories-and-groups.md) (kinds: Income/Spending/Neutral)
- [F3 — Payees](foundations/F3-payees.md) (autocomplete · merge · remember-last-category)
- [F4: Import from Actual Budget](foundations/F4-import-from-actual.md) (the export zip, a preview, Undo; 2026-11-10)

### 2 · Capture — [epic](capture/README.md)
- [C1 — Quick-add in a register](capture/C1-quick-add-in-register.md) (the make-or-break entry loop)
- [C2 — Global quick-add](capture/C2-global-quick-add.md) (action-first, account as a field)
- [C3 — Transfer between accounts](capture/C3-transfer-between-accounts.md) (same currency, two linked rows)
- [C4 — Edit, delete & back-date](capture/C4-edit-delete-backdate.md) (incl. transfer-edit mechanics)
- [C5 — To-categorize inbox](capture/C5-to-categorize-inbox.md) (anti-perfectionism)

### 3 · Dashboard & net worth — [epic](dashboard/README.md)
- [D1 — Net worth command center](dashboard/D1-net-worth-command-center.md) (the hero)
- [D2 — Allocation breakdown](dashboard/D2-allocation-breakdown.md) (by class & by liquidity)
- [D3 — Net worth over time](dashboard/D3-net-worth-over-time.md) (the growth trend)
- [D4 — Recent activity & account summary](dashboard/D4-recent-activity-and-account-summary.md)

### 4 · Per-instrument sections — [epic](instruments/README.md)
- [S1 — Section IA & navigation](instruments/S1-section-ia-and-navigation.md) (a page per instrument)
- [S2 — Holding account model](instruments/S2-holding-account-model.md) (value · cost basis · return)
- [S3 — Valuation mark](instruments/S3-valuation-mark.md) (mark-to-market)
- [S4 — Asset↔liability linking & net equity](instruments/S4-asset-liability-linking-net-equity.md) (**build deferred**)
- [S5 — Instrument profiles](instruments/S5-instrument-profiles.md) (the 11-module catalogue; PPF/EPF/NPS deferred to v2)

### 5 · Multi-currency — [epic](multi-currency/README.md)
- [MC1 — Account currency & base rate](multi-currency/MC1-account-currency-and-base-rate.md) (aggregation rate)
- [MC2 — Cross-currency transfer](multi-currency/MC2-cross-currency-transfer.md) (linkage rate)
- [MC3 — Display & rate management](multi-currency/MC3-display-and-rate-management.md)

### 6 · Settings & preferences — [epic](settings/README.md)
- [SET1 — Settings & number format](settings/SET1-settings-and-number-format.md)

### 7 · Charts / reports — [epic](reports/README.md)
- [R1 — Reports shell & date range](reports/R1-reports-shell-and-date-range.md)
- [R2 — Spending by category](reports/R2-spending-by-category.md)
- [R3 — Income vs expense & cashflow](reports/R3-income-vs-expense-and-cashflow.md)

### 8 · Circle & shared accounts — [epic](circle/README.md)
- [H1 — Circle setup, members & authentication](circle/H1-circle-setup-and-auth.md) (admin-gated logins · sessions)
- [H2 — Account ownership & sharing](circle/H2-account-ownership-and-sharing.md) (personal-by-default · per-account membership)
- [H3 — Roles & membership management](circle/H3-roles-and-membership.md) (admin ≠ data super-user)
- [H4 — Cross-member money & settle-up](circle/H4-cross-member-money.md) (transfers within the visible set)

> **Cross-cutting:** Epic 8 also adds a *Circle addendum* to several locked stories (F1–F3, C1–C3,
> D1–D3, R2/R3, SET1) and a new [architecture §12](../product/architecture.md#12-members-circle--visibility-multi-user).

## Conventions

- **Status:** every active story is **LOCKED** — its design decisions are settled and recorded in a
  *Resolved decisions* block. Changing a locked story is a deliberate act, not a casual edit.
- **MVP discipline:** CRUD + descriptive charts, **zero intelligence**; manual valuation via marks. The
  cross-cutting rules every story obeys live in [`../product/architecture.md`](../product/architecture.md).
- **Deferred work** is recorded but not built — see [overview › Deferred](../product/overview.md#deferred).
