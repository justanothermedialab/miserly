# S1 — Section IA & navigation (a page per instrument)

> **Epic:** Per-instrument sections · **Story:** S1 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD + descriptive display only, zero intelligence.

---

## Title
As the user, I navigate Miserly through a **dashboard plus a section per instrument type** (Bank,
Credit Cards, Mutual Funds, Stocks, FD/RD, PPF, EPF, Property, Gold, …), each section shaped to its
instrument and listing its accounts with the right totals — so the app is organised like a banking
app, and adding a new kind of asset is a first-class, discoverable act.

## ELI5
Instead of one undifferentiated pile of accounts, the app has a home page (the dashboard) and then a
page for each *kind* of thing I own — one for my bank accounts, one for my mutual funds, one for my
FDs, one for property, and so on. Each page knows what it's about and shows the accounts of that
kind. When I want to add, say, an SGB, I pick it from the list of supported types and its section
appears. It feels like my bank/INDmoney app, not a spreadsheet.

## Business context
This is the **structural expression of the wedge**: Actual is *instrument-blind* — every account is a
generic ledger. Miserly's whole differentiation is that it *knows what each instrument is*. The
section-per-instrument IA (banking-app / INDmoney model) is how that shows up in navigation, and it
maps 1:1 onto the **per-instrument-module architecture** (each module already wants its own page).
This story defines that IA and the navigation shell; the *content* of holding sections is S2+, and
the dashboard is the Dashboard epic.

It must honour locked decisions:
- **Module = instrument type**, each with metadata (side, liquidity, spending-vs-holding, cardinality).
- **Two section shapes:** *spending* modules (Bank, Credit Card) — the section is the **account list +
  registers** (the work view, C1); *holding* modules — the section is a **holding view** (current
  value / cost / return; detailed in S2).
- **Cardinality:** collection modules show a list; PPF/EPF (≤1 active, soft-warn — F1) show the one
  active account or a "not opened yet" state.
- **Consistency with D4:** the dashboard's account-summary groups and these sections are the *same*
  grouping — the dashboard is a map into these pages.
- **Discoverability of India instruments** is a feature: adding an account surfaces the full list of
  supported instrument types (FD, RD, PPF, EPF, SGB/Gold, …), which is exactly what a spreadsheet and
  Actual hide.

## User workflow

### Happy path — navigate
1. The user sees primary navigation: **Dashboard** + a **section per supported instrument type** —
   all shown even when empty (decision 1); grouped sensibly, e.g. Bank / Cards / Investments / Property.
2. Selecting a section opens that instrument's page: a header with the section's **total** (sum of its
   accounts' current value in base currency) and the **list of accounts** in that module.
3. Selecting an account opens its **register** (spending) or **holding detail** (holding, S2).

### Happy path — add an account / discover instruments
1. The user invokes **+ Add account** (global, or from a section).
2. A picker lists **all supported instrument types**, grouped/labelled (Bank, Credit Card, Mutual
   Funds, Stocks, FD, RD, PPF, EPF, Property, Gold/SGB, …) with short descriptions.
3. Choosing a type opens the F1 create-account flow for that module; on save, the account appears in
   its section (the section is always visible per decision 1; it now populates).

### Alt path — singleton sections (PPF / EPF)
- The section shows the **one active** account (or "You haven't added a PPF yet"); adding a second
  active triggers the F1 soft-warn but is allowed.

### Edge/empty path
- A user with only a bank account still sees Dashboard + **all** supported sections (decision 1): the
  Bank section is populated, while every other section shows an "add your first X" empty state —
  visible but empty, advertising what Miserly can track.

## Acceptance criteria
- [ ] Primary navigation = **Dashboard + a section per instrument type the user holds, each listing
      the user's accounts by name with a section subtotal** (RD7; no liquidity-group level).
- [ ] Each section page shows a **header total** (Σ current value of its accounts, base currency,
      as-of-today) and the **list of accounts** in that module.
- [ ] **Spending sections** (Bank, Credit Card) list accounts and lead into their **registers** (C1).
- [ ] **Holding sections** lead into the **holding view** (S2).
- [ ] **+ Add account** surfaces **all supported instrument types** (discoverability), each routing to
      the F1 create flow for that module.
- [ ] **(v2 — deferred 2026-06-21)** PPF/EPF singleton sections are deferred *with those modules*; MVP
      ships **no ≤1-active UI**. `cardinality` stays a registry dimension for when they land. (See
      Resolved decision 6.)
- [ ] Section grouping **matches D4's** account-summary groups (one consistent taxonomy).
      *(D4's account summary was removed, D4 RD9; the sidebar, All accounts and the allocation
      donut share the section taxonomy instead.)*
- [ ] Section/account totals reuse the **shared derived computation** (no numbers that can drift from
      the dashboard or registers).
- [ ] Closed accounts are not listed in the active section (reachable via a "closed accounts" view per
      F1); number formatting respects the app-wide preference.

## Validation rules
- **Section membership** is derived from an account's **module/type** — an account appears in exactly
  one section.
- **Section total** = Σ current value of that module's **open** accounts, base currency (FX as D1).
- **Add-account picker** lists every module the app supports (the v1 module set), regardless of
  whether the user currently holds any — that's the discovery mechanism.
- **Cardinality** rules (PPF/EPF ≤1 active soft-warn) are enforced at create (F1), reflected here.

## Edge cases
- **A module with no accounts:** decide hidden-from-nav vs shown-as-discoverable (Resolved decisions); the
  add-account picker always lists it regardless.
- **Many accounts in one section** (e.g. several bank accounts): the section list stays scannable;
  consistent with D4's collapsible/top-N treatment.
- **Mixed currencies within a section:** each account shows native; the section header total is in base
  (converted), with the same missing-FX handling as D1.
- **A spending account the user wants treated as net-worth-only** (the plan's possible manual
  override): out of scope for S1 (type-derived only); revisit if needed.
- **Reordering sections / accounts** within nav: nice-to-have; define if in MVP (Resolved decisions).

## Failure cases
- **Section total ≠ sum of its accounts (or ≠ dashboard):** impossible by construction (shared
  computation); divergence is P0.
- **An account missing from every section / in two sections:** defect — membership is exactly one,
  derived from module.
- **Add-account picker missing a supported type:** the discovery promise breaks; the picker must list
  the full module registry.
- **Navigating to a section with no accounts erroring:** must show a clean empty/discover state.

## UX considerations
- **Banking-app familiarity** — left/primary nav of sections, each a clean page; this is the mental
  model our user already has from his bank/INDmoney.
- **Section header earns its place** — the class total + a small allocation hint ties back to D2 so the
  section feels connected to the wealth view.
- **Add-account is a showcase** — presenting the full instrument list (with India-native types) is a
  selling moment; group them (Cash, Investments, Deposits, Retirement, Property, Gold) with one-line
  descriptions so users discover what Miserly can track that a spreadsheet won't.
- **Spending vs holding sections look different on purpose** — a spending section is a ledger/list; a
  holding section foregrounds value/return (S2). The difference signals "this app knows what this is."
- **Singletons read naturally** — PPF/EPF show "your PPF" not "PPF accounts (1)".
- Respects the app-wide number-format preference.

## Operational considerations
- **Module registry** (the v1 module set + each module's metadata: label, side, liquidity,
  spending/holding, cardinality, section-shape) is the single source the nav, add-picker, sections,
  and aggregation all read — defined as part of the greenfield architecture (referenced by F1, D1, D2,
  D4 too).
- **Section totals** reuse the D1 aggregation service with a `module` filter — one computation.
- **Routing**: stable per-section and per-account routes (deep-linkable, consistent with D4's links).
- **Offline in desktop mode** (hosted = client↔server); adding a module type is a code update (new
  module), not user config — per the architecture.

## Resolved decisions (locked 2026-06-20)
1. **Unused sections in nav = SHOW ALL supported sections always**: every supported instrument type
   has a visible nav entry whether or not the user holds one — exactly how bank apps work (the FD/RD
   link isn't hidden just because you have none). Rationale (user): an *absent* page makes a layman
   think the instrument **isn't supported**; visible-but-empty sections advertise capability and
   invite adding. Empty sections show an "add your first X" state. *(Superseded 2026-10-05 by RD7: the nav lists held sections only; discovery lives wholly in the Add account picker.)*
2. **Separate section per instrument type** — including **Bank Accounts** and **Credit Cards as their
   own distinct sections** (NOT a combined "Cash & Cards"). Rationale (user): a dedicated Credit Cards
   section makes **total current card usage / liability** visible at a glance; it also keeps assets
   (bank) cleanly apart from liabilities (cards) for the balance-sheet framing. This is consistent
   with decision #1 (every instrument type is its own visible section).
3. **Nav lightly grouped** (e.g. Cash / Cards / Investments / Deposits / Retirement / Property /
   Gold) for scannability, mirroring D2/D4 taxonomy — within the "show all sections" rule. *(Superseded 2026-10-05 by RD7: grouped by section, no liquidity-group level.)*
4. **Manual section/account reordering = deferred** (later, a Settings feature); MVP uses a fixed
   **Indian-user default group order: Spending → Deposits → Loans → Investments → Property → Other**
   (revised 2026-06-21 — everyday cash first, then safe deposits, then debt, then market investments;
   matches how the target persona prioritises). Only the *customisable* reordering is deferred.
5. **Stocks/MF valuation in MVP = value-marks + cashflow cost basis (no units)** — carried into S2/S5
   (see S2). DISCLAIMER: manual units + price is a likely **post-MVP refactor revisit** (no one
   reliably remembers units), recorded so the model can accommodate it later without rework.
6. **Sidebar = sections-only; PPF/EPF/NPS deferred → 11-module nav** (LOCKED 2026-06-21): the sidebar
   lists the **11** v1 sections and is **sections-only — no per-account dropdowns** (accounts live on
   the section page; click an account → its register/holding detail). The add-account picker may
   surface PPF/EPF/NPS as **"coming soon."** No singleton-section UI in MVP; `cardinality` remains a
   registry dimension. See [S5](S5-instrument-profiles.md) Resolved decision 6.
   *(Superseded 2026-10-05 by RD7: accounts return to the sidebar.)*

**Amendments (2026-10-05, each chosen from options with their evidence):**

7. **Sidebar = the user's accounts by name, under their section** (supersedes RD1, RD3 and RD6).
   One level of sections (Bank, Credit cards, Mutual funds, …) with a subtotal each, and the accounts
   under it; no liquidity-group level; each section collapsible. Only **held** sections appear; the
   Add account picker is the "what can I track" showcase. Clicking an account opens its register or
   holding page; clicking a section opens its section page. Subtotals use the compact summary format
   (SET1 RD5). The sidebar also carries **All transactions** (D4 RD6). The `/sections` index page is
   redundant and goes. *Why:* every app with grouped totals (Actual, Quicken Classic, Simplifi, Lunch
   Money, Monarch) puts accounts at the bottom level; a level of types with nothing under it repeated
   the same totals (the loan twice on every screen).
8. **Section page = one headline and its table**: the section's value, invested and return as
   the headline, the accounts or holdings as a table on the page (no KPI card row, no intro sentence),
   "Add" in a one-row toolbar. Holdings tables gain an XIRR column (S2 RD6).
   *Amended 2026-10-10 (after testing the desktop app):* every section starts **folded at each launch**; one the user opens stays open until the app closes (a session cookie). Categories and Payees leave the pane's foot for the account menu (they are visited rarely; the pane keeps its rows for accounts).

**Amendments (2026-10-10, after a review of the app's screens):**

9. **Liability and cash sections lead with the balance and its change** (amends RD8):
   bank, card and loan sections show the section's balance and its change this month;
   invested, return and XIRR belong to holding sections only. A foreign-currency account shows its
   rupee value beside its own (MC3). The section's "Add account" is a Standard button.

**Amendments (2026-10-17 to 2026-10-20, recorded 2026-10-21):**

10. **The sidebar's figures, width and motion** (amends RD7's
    "compact summary format"): account rows show **whole rupees**; the net worth at the top shows
    raised paise; an **open group keeps its subtotal**; the pane is **drag-resizable** from 240 px to a
    third of the window (default 280, double-click resets, remembered); figures show on **every row
    or none** (all hide together when any would cut its name); collapsing is the **Fluent slide**
    (icons fixed in one column, labels clipped, 167 ms). Since 2026-10-30 every figure is at the
    viewer's share of a joint account, the row marked with the share (H2 RD8), so rows add to the
    subtotal and subtotals to the net worth.
11. **Categories and Payees are back at the pane's foot** as places (2026-10-20; reverses
    RD8's 2026-10-10 move into the account menu). The account menu moved to the title bar's top
    right (Change password, Switch account, Sign out); Settings is in the "…" menu beside it.
12. **A narrow window's pane is the same sidebar, opened over the title bar** (2026-10-27,
    picked from mocked options): below 1,100 px the
    sidebar is a 48 px icon rail; its menu button opens the full pane over the page for the window's
    full height, in the docked sidebar's colour in every theme, with its own mark and menu button where
    the title bar's are; it slides out of the rail and back into it. The page is not dimmed; a click on it closes the pane; a click in the title bar
    closes the pane and does its own thing at once. A push pane (the page narrows beside it) waits for a
    decision on small screens (deferred).
13. **The pane's motion: text fades, icons glide, nothing jumps** (2026-10-30;
    amends RD10's "labels clipped" and RD12's slide). Collapsing, the labels, figures, net worth and
    the "Accounts" label fade out in 83 ms at the slide's start; expanding, they fade in over 167 ms
    once the width has mostly opened. The parts the rail drops (the net worth block, the "Accounts"
    label, an open group's rows) shrink their height over the slide, so the icons move with it. Icons
    keep x 16 and every row is 36 px in both states (the rail's were 32, a group's 44). The overlay
    pane opens and closes the same way, and closes on the docked collapse's curve
    (2026-10-30; amends RD12: on the leaving curve its edge held still, then snapped shut). The page
    beside it resizes with the slide on every frame, nothing on it jumping. A group's rows fold open and shut over 167 ms
    (2026-10-30: things that open inline never jump). None of it with reduced motion.
14. **Add account lists its types in two columns** (2026-11-05, the launch list; built
    2026-11-10). Fourteen entries no longer fit a 720 px window in one column: the groups
    run down two columns (Spending, Deposits, Loans | Investments, Property, Other), the form on the
    right, the dialog 58rem. PPF sits under Deposits (RD4's groups unchanged); a type may show under
    more than one name (Home loan, Other loan: S5 RD15). Since 2026-11-10, short of room the
    title bar's path folds from the root, keeping the page just above ("… / Fixed deposits / SBI FD
    (payout)"), and unfolds again when the window widens.
15. **An account that belongs to another shows in its section** (2026-11-10, S5 RD16): an EPF's
    EPS is never a section of its own (`/sections/eps` is not found); it is a row right after its
    EPF in the EPF section, indented, and the section's figures add both. Its page and the EPF's
    share EPF | EPS | Chart tabs; the path reads "All accounts / EPF / EPS of …". NPS Tier II, its
    own account, likewise shows in the NPS section (`/sections/npsTier2` is not found; S5 RD17).
16. **Add account's India group** (2026-11-18, so a user outside India isn't puzzled by the
    acronyms; place picked 2026-11-19 from mocked options; amends RD14). PPF, EPF (its EPS comes with
    it), Sovereign Gold Bond, NPS Tier I and NPS Tier II leave Deposits and Investments for one
    group, India, in one fixed place for everyone: last, at the foot of the right column under
    Other. It is folded, one row "India  PPF, EPF, SGB, NPS", and a click anywhere on the row opens
    it (it opens by itself when the dialog starts on one of its types, from that section's Add
    account). FD, RD, Home loan and Gold stay where they were. The Actual import's Add as lists the
    same groups in the same order, India last. The sidebar is unchanged (it doesn't read these
    groups).

## Dependencies
- **Depends on:** the **module registry** (architecture), F1 (accounts, type/metadata, cardinality,
  closed-accounts view), D1 (aggregation for section totals), D2/D4 (consistent grouping), app-wide
  number-format preference.
- **Precedes / frames:** S2 (holding section content), S3 (mark, reached from holding detail), S4
  (Property), S5 (instrument profiles per module).
- **Excludes:** holding valuation/return detail (S2/S3), property-loan equity (S4), per-instrument
  captured fields & auto-valuation (S5 / v2), manual spending-vs-holding override.

---

### Research sources
- INDmoney / banking-app section IA (net-worth summary + sections per instrument, India instruments
  incl. EPF/PPF/NPS/FD): https://www.upraised.co/blog/indmoney-personal-balance-sheet/ ; https://www.indmoney.com/features/track-all-investments
- Kubera — manual multi-asset organisation, add any asset type: https://moneywise.com/investing/reviews/kubera-review
- Ghostfolio — holdings organised by position/account, drill-into-detail pattern (informs holding
  section shape, detailed in S2): https://github.com/ghostfolio/ghostfolio
- (Per-instrument valuation/tax math already captured in the plan's "India instrument rules" — Tier A.)
