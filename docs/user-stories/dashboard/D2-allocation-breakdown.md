# D2 — Allocation breakdown

> **Epic:** Dashboard & net worth · **Story:** D2 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD + descriptive charts only, zero intelligence.

---

## Title
As the user, I can see how my wealth is **distributed** — by asset class and by liquidity — as a
clear allocation chart with amounts and percentages, so I understand the *shape* of my net worth
(am I over-concentrated? how much can I actually get to quickly?) at a glance.

## ELI5
The net-worth number (D1) tells me *how much*; this tells me *what it's made of*. A donut showing
the slices: this much in cash, this much in stocks, this much locked in property, this much in PPF.
I can also flip it to show how much is "easy to access" vs "locked away". My debts aren't slices —
they're shown separately, because you can't have a negative piece of a pie.

## Business context
Allocation is the second pillar of the hero ("total + growth trend + **allocation**"). It's where the
wealth-tracking purpose shows up most: a penny-precise tracker who holds *every* asset type wants to
see concentration and liquidity, which a spreadsheet makes tedious and Actual can't do at all
(instrument-blind). Two groupings matter, both derivable from metadata we already carry on every
account (`type`/module, `liquidity`, `side`):

1. **By asset class** (module/instrument type): Cash, Stocks, Mutual Funds, FD, RD, PPF, EPF,
   Property, Gold, … — the familiar "what's it invested in" view.
2. **By liquidity** (Liquid / Semi-liquid / Illiquid): the wealth-tracking value-add, and the basis
   for the **liquid-net-worth** notion (how much you could reach quickly) — a recognised personal-
   finance metric ([NerdWallet liquid net worth](https://www.nerdwallet.com/finance/learn/liquid-net-worth)).

**Allocation charts are an *assets* composition.** Slices are positive and sum to total assets;
**liabilities are not slices** (a pie can't show negatives — an earlier prototype forced them in via `abs()`,
which we drop). Liabilities are shown as a separate figure, consistent with D1's balance-sheet split.
This is a **descriptive** chart only — it shows the split; any "you're too concentrated / too
illiquid" judgement is the **intelligence layer (deferred)**. A neutral "X% liquid" label is fine
because it states a fact, not advice.

## User workflow

### Happy path
1. On the dashboard, below the net-worth hero, the user sees an **allocation donut** of their assets,
   defaulting to **by asset class**, with a legend: each slice's label, base-currency amount, and %.
2. User toggles to **by liquidity** → the same assets re-bucket into Liquid / Semi-liquid / Illiquid,
   with a neutral "**X% liquid**" summary.
3. User hovers/taps a slice → sees the accounts that compose it (drill-in).

### Alt path — multi-currency
- Each account's value is converted to base (manual current rate) before bucketing, so slices are
  comparable in one currency.

### Edge/empty path
- No asset accounts → friendly empty state ("Add accounts to see your allocation"), not an empty
  donut. Liabilities-only → allocation is empty, liabilities figure still shown.

## Acceptance criteria
- [ ] An allocation chart (donut/pie + legend) shows the composition of **total assets** as-of-today,
      in base currency.
- [ ] **Two groupings, toggleable: by asset class** (module) **and by liquidity** (Liquid /
      Semi-liquid / Illiquid).
- [ ] Each slice shows **label, amount (base currency), and % of total assets**; percentages sum to
      100% of assets.
- [ ] **Liabilities are excluded from the pie** and shown as a **separate figure** (not a negative
      slice).
- [ ] The liquidity view shows a neutral **liquid-% summary** (liquid assets ÷ total assets), stated
      as a fact, with **no judgement/recommendation**.
- [ ] A slice can be **drilled into** to reveal the accounts composing it.
- [ ] Allocation uses the **same aggregation service** as D1 (`current_value` + metadata, as-of-today,
      **open accounts in the viewer's visible set** `owned ∪ member-of`) — it can never disagree with
      the net-worth hero's asset total.
- [ ] *(Superseded 2026-10-20 by RD6.)* A **Shared view** buckets **shared accounts only**, mirroring D1; **no all-Circle total**.
- [ ] Number formatting respects the app-wide multi-format preference (compact in the chart, full on
      drill-in).

## Validation rules
- **Inclusion:** open accounts **in the viewer's visible set** only; assets only for the pie
  (`side = Asset`); liabilities aggregated separately for the standalone figure.
- **Bucketing:** "by asset class" buckets on the account's **module/type**; "by liquidity" buckets on
  the account's **liquidity** metadata. Every account must carry both (set by its module at creation,
  F1) so nothing falls into an "unknown" bucket — if something can't be classified, surface it as an
  explicit "Unclassified" slice rather than dropping it.
- **Currency:** convert to base before bucketing; missing FX rate handled as in D1 (surface, don't
  assume 1.0).
- **Percentage base:** % is of **total assets** (not net worth), so slices sum to 100%.

## Edge cases
- **A single account dominates** (e.g. property = 80%): show honestly; tiny slices may need grouping
  into an "Other" slice for legibility (define threshold — see Resolved decisions).
- **Zero total assets** (only liabilities): empty pie + the liabilities figure; liquid-% is N/A.
- **An account exactly on a liquidity boundary** (e.g. an FD near maturity): it sits in whatever
  liquidity its module assigns; reclassification logic is a v2/instrument concern.
- **Many small accounts** in one class: aggregate into the class slice; drill-in lists them.
- **Negative asset balance** (e.g. an asset account overdrawn): rare; decide whether it nets within
  its class or is flagged — see Resolved decisions.

## Failure cases
- **Pie asset total ≠ D1 asset total:** impossible by construction (shared aggregation); divergence
  is P0.
- **Percentages don't sum to 100%** (rounding): must reconcile (largest-remainder or show the
  rounding on one slice) so the legend is trustworthy.
- **An account silently missing from all buckets:** disallowed — everything classifiable must appear;
  unclassifiable goes to an explicit "Unclassified" slice.
- **Liabilities leaking into the asset pie:** defect.

## UX considerations
- **Donut over pie** (cleaner with a center label, e.g. total assets or liquid-%); legend with
  amounts + %; consistent slice colours (tie to the F2 category colour idea where sensible, or a
  stable class palette).
- **Toggle is prominent and memorable** (asset-class ⇄ liquidity) — both are one tap apart; remember
  the last choice.
- **Drill-in feels connected** to the rest of the app (tapping a class slice can route to that
  section/account list).
- **Liabilities shown with restraint** nearby (a small "You owe ₹X" figure), so the picture is
  complete without polluting the asset composition.
- **Neutral liquid-% framing** — "42% of assets are liquid", never "⚠ too illiquid".
- Respects the app-wide number-format preference.

## Operational considerations
- **Same single aggregation service** as D1/D3, with a `groupBy` (class | liquidity) and an
  assets/liabilities split — one computation, three presentations.
- **Buckets are derived** from account metadata at read time; no stored allocation.
- **Class taxonomy:** in MVP a "class" = the account's **module** (each module declares its class
  label); a coarser super-class rollup (Equity/Debt/Real-Estate/Cash/Gold) is a later enhancement
  — confirm in Resolved decisions.
- **Offline-capable in desktop mode** (Electron); hosted mode is client↔server (architecture §11).

## Resolved decisions (locked 2026-06-20)
1. **Default grouping = by asset class** (LOCKED); one tap to the liquidity view.
2. **Asset-class granularity = by module / granular** (LOCKED): Cash, Stocks, MF, FD, RD, PPF, EPF,
   Property, Gold, … each its own slice. A coarser super-class rollup (Equity/Debt/Real-Estate/
   Cash/Gold) is a later enhancement.
3. **Liquid-% headline = liquid ÷ total assets** (LOCKED, keeps pie slices summing to 100%);
   **also show the classic liquid ÷ net-worth ratio** as a secondary labelled metric.
4. **"Other" slice** (LOCKED, default): roll slices below ~2–3% into an expandable "Other" for
   legibility (exact cutoff tunable in build).
5. **Overdrawn/negative asset account = net within its class** (LOCKED) for MVP.
6. **Allocation at the viewer's share** (2026-10-20; option C of three ways to split a
   joint account, chosen 2026-10-17). Each shared account enters its class at the
   viewer's share (H2), the same weight as D1's headline, so the slices still add to net worth. The
   Shared view is removed. Supersedes the Shared view acceptance criterion and the Circle note
   below.

**Forgotten-work sweep (2026-11-05; a check of the acceptance criteria found the drill-in was
never built):**

7. **The drill-in opens the class's section page.** A click on a slice or anywhere on its legend
   row, By class, opens that section (`/sections/<type>`), which lists the accounts in it with their
   figures; hover still shows the slice's figure in the centre. "Other" and the By
   availability view lead nowhere: availability cuts across sections and has no page of its own.
   Satisfies the drill-in criterion and workflow step 3 without a second list on the Dashboard.
8. **A class below zero is listed, not drawn, and the centre reads Assets** (2026-11-06,
   after a review of the app; extends RD5). When a class nets
   below zero (an overdrawn bank), the ring draws the positive classes only, with shares of what
   is drawn, and the class is listed under the legend with an outline swatch, its amount and "not
   drawn"; it still opens its section. The centre (and its full figure on hover) is the sum of
   every class, Assets, as the headline. *Why:* the slice was rolled into an "Other" below zero and
   dropped without a word, and the centre read the drawn classes, ₹30,444 above Assets on the
   owner's file.
9. **PPF and Sovereign Gold Bonds are classes of their own** (2026-11-10, S5 RD13). A class is a
   type, so each is its own slice and opens its own section (RD7); folding SGB into Gold would have
   opened the Gold section without the bonds. Colours: the asset donut never shows the liability
   slots, so PPF takes 6 and SGB 8 rather than repeat FD's and Gold's.
10. **EPF and its EPS** (2026-11-10, S5 RD16): each its own class, so EPS is a slice of its own,
    counted at what was paid in; it shares EPF's colour (one family; the ten swatches are taken).

## Circle addendum (Epic 8 · multi-user)

> Added 2026-06-25 by the [Circle epic](../circle/README.md) writeback (D6).

- **Viewer-scoped allocation.** Allocation by class/liquidity is computed over the viewer's visible set
  (personal + shared in full), mirroring [D1](D1-net-worth-command-center.md); a **Shared view** buckets
  shared accounts only. No all-Circle total. The bucketing math is unchanged.
- **AC delta:** allocation totals reconcile with the viewer-scoped D1 asset total. **Folded into the
  canonical Acceptance criteria + Inclusion rule above (2026-06-25, MODE 2.5 M1).**

## Dependencies
- **Depends on:** D1 (the aggregation service + as-of-today + FX), F1 (account `type`/module +
  `liquidity` + `side` metadata, set at creation), the app-wide number-format preference.
- **Shares computation with:** D1 (asset total must match), D3 (history could later animate
  allocation over time — not in MVP).
- **Excludes:** allocation-over-time (later), super-class taxonomy (later), any "ideal allocation /
  rebalancing advice" (intelligence layer), per-instrument detail (per-instrument epic).

---

### Research sources
- Liquid vs illiquid net worth; liquid-net-worth ratio as a recognised metric: https://www.nerdwallet.com/finance/learn/liquid-net-worth ; https://www.epwealth.com/blog/balancing-liquid-illiquid-assets-wealth-portfolio
- Asset-class allocation categories (equities / cash / real estate / bonds / alternatives) and
  benchmark mixes: https://www.longangle.com/research/high-net-worth-asset-allocation ; https://www.paladinregistry.com/blog/investing/high-net-worth-individuals-asset-allocation-breakdown/
- An earlier prototype of Miserly — `get_allocation` liquidity buckets (Liquid / Semi-liquid / Illiquid /
  Liabilities), % on abs(total) — we keep the buckets but exclude liabilities from the pie.
