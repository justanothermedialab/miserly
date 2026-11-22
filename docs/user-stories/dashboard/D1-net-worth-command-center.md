# D1 — Net worth command center (the hero)

> **Epic:** Dashboard & net worth · **Story:** D1 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD + descriptive display only, zero intelligence.

---

## Title
As the user, when I open Miserly I see my **total net worth right now** — one honest number, with
its assets-vs-liabilities breakdown — aggregated across every account in every module and converted
to my base currency, so the home screen answers "how am I doing?" at a glance before I do anything
else.

## ELI5
Net worth is everything I own minus everything I owe. This story is the big number at the top of the
home screen: add up all my accounts (bank, FDs, mutual funds, property, …), subtract my debts (credit
cards, loans), and show the total — as of today. It's the first thing I see, the "wealth view." I
don't *do* anything here; I just see where I stand.

## Business context
The dashboard hero is the product's **"how am I doing?" answer** and a deliberate differentiator —
Actual has no dashboard at all. The user uses Actual for exactly two things, and **approximate net
worth is one of them**; this story is the home for that need, done better than a spreadsheet.

It rests on locked decisions:
1. **One aggregation rule, every module.** Net worth = **Σ `current_value()` of all OPEN accounts**,
   each tagged Asset or Liability, summed in **base currency**. The aggregation **never branches on
   concrete instrument type** — it reads the contract (`current_value`, `side`, `currency`, `status`),
   which is the structural guarantee against "inconsistent data across screens." In MVP
   `current_value` = the derived ledger balance (`opening + Σtx`), so D1 needs nothing from the
   per-instrument sections to compute.
2. **As-of-today.** The headline uses the **balance as of today** (transactions dated ≤ today);
   future-dated entries are excluded from the hero (C1 decision #2: as-of-today is the honest
   number; projected is separate).
3. **Closed accounts excluded** (F1) — closing moves the balance out, so they correctly drop from net
   worth while their history survives.
4. **Wealth view, not work view** — no logging happens here (that's the registers/sections); the
   dashboard observes.

Benchmarks (Kubera, Empower, INDmoney) all lead with exactly this: a high-level assets-vs-liabilities
net-worth summary, distinct from daily spending
([Kubera review](https://www.wallstreetzen.com/blog/kubera-app-review/),
[INDmoney balance sheet](https://www.upraised.co/blog/indmoney-personal-balance-sheet/)).

## User workflow

### Happy path
1. User opens the app → lands on the dashboard.
2. The hero shows **Net worth** (large, as-of-today) with **Total assets** and **Total liabilities**
   beneath it (balance-sheet style).
3. The number reflects every open account across all modules, converted to base currency; it updates
   immediately whenever a transaction is added/edited anywhere (same derived computation as the
   registers).

### Alt path — multi-currency holdings
- Foreign-currency accounts are converted to base using the **manual current rate per currency**
  (multi-currency decisions); their contribution to net worth is shown in base. (Auto/historical FX is
  v2.)

### Edge/empty path — no accounts yet
- A first-run user with no accounts sees a **friendly empty state** ("Add your first account to see
  your net worth") linking to F1, not a misleading ₹0.

## Acceptance criteria
- [ ] The dashboard hero displays **total net worth as of today**, in base currency.
- [ ] **Total assets** and **total liabilities** are shown alongside the net-worth figure
      (net worth = assets − |liabilities|).
- [ ] The figure aggregates **all open accounts across all modules in the viewer's visible set**
      (`owned ∪ member-of`, [H2](../circle/H2-account-ownership-and-sharing.md)) via `current_value()` +
      `side`, with **no branching on concrete instrument type**. Personal + shared accounts both count
      **in full**; the visible-set filter is the only multi-user change (the contract/math are unchanged).
- [ ] *(Superseded 2026-10-20 by RD12.)* A separate **Shared view** sums **shared accounts only** (the common pot). There is **no
      all-Circle total** (it would double-count shared holders and pierce privacy — architecture §12).
- [ ] **Closed accounts are excluded**; **future-dated** transactions are excluded from the
      as-of-today figure.
- [ ] Foreign-currency accounts are converted to base using the **manual current rate**; the hero is
      a single base-currency total.
- [ ] The hero **recomputes live** from the same `opening + Σtx` source the registers use — it can
      never disagree with the sum of account balances (no cached/stored net worth).
- [ ] A **no-accounts empty state** is shown instead of a misleading zero.
- [ ] All figures respect the **app-wide number-format preference** (SET1) — Indian (lakh/crore) or
      Western grouping per the user's setting.

## Validation rules
- **Inclusion:** an account contributes iff `status = open` **and is in the viewer's visible set**
  (`owned ∪ member-of`). Asset balances add; liability balances subtract (liabilities carried
  signed-negative internally, as an earlier prototype's analytics did).
- **Currency:** every account's balance is converted to base via the current manual rate for its
  currency; base-currency accounts pass through. A missing rate for a held foreign currency must be
  surfaced (see Failure cases), not silently treated as 1.0.
- **As-of date:** only transactions with `date ≤ today` count toward the headline.

## Edge cases
- **Net worth is negative** (liabilities exceed assets): display honestly (e.g. a clear negative
  figure), no clamping to zero.
- **Only liabilities, no assets** (e.g. a new user who added a loan first): valid; shows a negative
  net worth with ₹0 assets.
- **A holding account with no recent valuation mark:** its `current_value` is simply its last known
  ledger balance (opening + Σtx incl. the last mark) — D1 doesn't know or care that it's "stale"
  (staleness nudges are AI/deferred).
- **Future-dated entries pending:** excluded from the hero; the separate projected figure (if shown)
  is D-level secondary, not the headline — confirm in Resolved decisions.
- **Many accounts / large ledgers:** the aggregate stays fast (sum of derived balances; snapshot/cache
  available if needed, per C1 ops).
- **Mid-market-hours expectation:** unlike Empower (updates during market hours), our values are
  manual marks — net worth changes only when the user records something. Set expectations in copy if
  needed.

## Failure cases
- **Net worth ≠ Σ account balances:** impossible by construction (one computation); any divergence is
  P0 — the exact "inconsistent data across screens" failure we exist to prevent.
- **Missing FX rate for a held foreign currency:** must **not** silently assume 1.0 or drop the
  account; show a clear "set a rate for <currency>" prompt and exclude-with-notice rather than corrupt
  the total.
- **A stored/cached net worth drifting from source:** disallowed — net worth is always derived.
- **Closed/archived account leaking into the total:** defect.

## UX considerations
- **The number is the page** — large, calm, unmissable; assets/liabilities as quiet supporting
  figures. This is the "command center" feel.
- **Balance-sheet clarity:** assets (green/up) vs liabilities (muted/down) so the composition reads
  instantly.
- **No actions to take here** — resist cramming controls; the hero is for orientation. Drill-downs
  (allocation D2, trend D3, recent activity D4) sit below.
- **Honest, not gamified** — for a penny-precise user, accuracy and restraint beat confetti; show the
  real number including negatives.
- **Number formatting:** Indian (lakh/crore) or Western grouping with the ₹ symbol, per the **app-wide
  preference** (SET1).
- **A "change since last month" chip** would be powerful here but depends on history (D3) — decide
  whether D1 ships the static number alone (Resolved decisions).

## Operational considerations
- **Single aggregation service** consuming the module contract (`current_value`, `side`, `currency`,
  `status`) → one net-worth computation reused by the hero, allocation (D2), and growth (D3). This is
  the "one valuation contract + one FX conversion point" guardrail from the plan.
- **FX conversion happens once**, centrally, at the aggregation boundary — modules report native
  currency + the contract converts.
- **Derived, never stored** — recomputed on read; optional memoization must invalidate on any
  transaction change.
- **Offline in desktop mode**; no internet needed (manual FX rates stored locally); hosted mode is
  client↔server (architecture §11).

## Resolved decisions (locked 2026-06-20)
1. **"Change since last month" chip = deferred to D3** (LOCKED): D1 ships the pure as-of-today number;
   the delta arrives with D3 (history) to avoid duplicating the historical computation.
2. **Hero = as-of-today only** (LOCKED): projected net worth (future-dated entries) is at most a small
   secondary line, never the headline.
3. **Number formatting = APP-WIDE, multi-format** (LOCKED, cross-cutting): Miserly supports **multiple
   international number-format systems** — Indian (lakh/crore: ₹12,34,567 long, ₹12.3L short) **and**
   Western (thousands: 12,345,678 long, 12.3M / K-M-B short) — in **both long-form and compact
   short-form**, selectable as a **user preference applied across the ENTIRE app** (hero, registers,
   charts, everywhere). D1 uses it; the preference itself is owned by **SET1** (Settings). Compact is
   used where space is tight (hero secondary figures, charts); long-form for precise
   ledger figures. Recorded as an app-wide rule in the plan.
4. **Show both gross assets and gross liabilities** beneath net worth (LOCKED): the balance-sheet
   mental model the benchmarks use.

**Amendments (2026-10-05, each chosen from options with their evidence):**

5. **Composition: one headline, then one chart**. Net worth is the page's headline at
   28 to 32 px in compact form ("₹18.8L"), the full Indian-grouped figure under it, then its change
   this month (RD1's chip, now that D3 history exists). **Assets and Liabilities** sit under it as two
   figures with a split bar (RD4 made visible). Directly under: the full-width
   net-worth-over-time chart (D3). Below that: recent activity (D4) and **month-to-date spending
   against last month** as a cumulative line. **No KPI tiles** repeating the sidebar,
   no intro sentence. *Why:* no screen had a headline (the largest text on all 13 screens was the
   sidebar's net worth), and the dashboard carried 22 repeated figures.
6. **Compact on summaries by default** (amends RD3): headlines, tiles, sidebar and chart ticks
   use the compact form; the full figure stays one glance away (under the headline, in tooltips);
   registers, tables and forms stay full with paise. The preference to show summaries in full stays
   (SET1 RD5).
7. **Colour of money = red for negative, green for positive** (chosen over a neutral rule after
   comparing the two rendered): every negative
   amount red and every positive amount green, in every list and total, the headline net worth,
   assets, liabilities and balances included. Change lines (this month, returns, valuation updates)
   keep gain and loss colours. One rule on every screen; colours are the AA-tuned `--pos` / `--neg`
   tokens, and the sign is always printed too (colour is never the only carrier).

**Amendments (2026-10-10, after a review of the app's screens):**

8. **"Liquid (spendable)" = a caption line under Assets**: "₹14.9L liquid
   (75.5%)", liquid assets ÷ total assets as D2 RD3 defines it. No KPI tile and no third headline
   figure; D2's "By liquidity" view keeps the breakdown.
9. **Spending is coloured by meaning** (clarifies RD7): spending totals print
   positive and red with the word or column name ("₹1.5L spent"); income totals positive and green.
   A comparison of spending is written in words and coloured by meaning ("₹2,790 less than by this day
   in September" in green, "more than" in red), never as a signed figure. Signed figures stay where
   the sign is the meaning: balances, net worth and its change, net, returns, valuation updates.
10. **The top bar's Add is the one accent**: page actions are Standard buttons; a
   dialog's primary stays Accent.

**Amendment (2026-10-17): built as a trial, then kept after trying it, with (a) below:**

11. **Neutral money (supersedes RD7's "every amount coloured" and RD9's red spending
   totals):** colour only where it says something. A **level** (net worth, assets, liabilities, a
   balance, a value, a subtotal, a spending total) reads in the text colour and its sign or word says
   which side; in a **list of transactions** money in is green and money out is in the text colour
   (the column or sign says it); **changes, returns and nets** (this month, gains, net cashflow) keep
   `--pos` / `--neg`; spending comparisons stay in words coloured by meaning (RD9). *Why:* with the
   frame neutral, red was the loudest thing on every screen (the register read as a red wall); Monarch,
   Kubera, Kuvera, INDmoney and YNAB colour meaning, not every figure. Code: `levelToneClass`,
   `flowToneClass`, `spendToneClass` in `$lib/format`. Headline figures show their paise raised and
   smaller (`Figure.svelte`); tables keep full-size paise.
   **Amended 2026-10-17 (after trying the trial; option (a), Actual's own register):** in a
   register and All transactions the Withdrawal and Deposit columns are both in the text colour, and
   the register's **running balance** is green at zero or above and red below (`balanceToneClass`;
   Actual's `TransactionsTable` colours its balance `numberPositive` / `numberNegative` and leaves
   Payment and Deposit plain). Headline levels, dashboard lists and the rest above are unchanged.
12. **Net worth at the viewer's share; the Shared view goes** (2026-10-20; option C of three
   ways to split a joint account, chosen 2026-10-17). A member's net worth is their own
   accounts in full plus their share (H2) of each shared account they hold. The weight is applied
   outside the aggregation contract (architecture §12), so the contract and the modules are
   unchanged. The Mine / Shared switch and the Shared view are removed. Under the headline one line
   reads "Shared with others: ₹X (your share ₹Y)", where ₹X is the full value of the shared accounts
   the viewer holds, and it opens their breakdown. There is still no all-Circle total. A joint debt
   counts at the share; its own screens note the full liability. Supersedes the Shared view
   acceptance criterion and the Circle note below.
   *Confirmed 2026-10-21 (after a web check):* ₹X is the **net** full value (assets minus
   joint debts) of the shared accounts the viewer holds, ₹Y the viewer's share of it; the line is
   **hidden** when the viewer holds no shared account. Your share as the headline follows personal
   financial statement practice (count your share, halve joint debts); the full figure beside it
   follows lenders' forms (joint items once, at full). "Only the accounts you hold" is our privacy
   rule (H2), stricter than Monarch's (everyone sees everything). No app was found with this exact
   line, so before and after pictures of the app had the final say.
13. **An account counts from its start date, in the headline as in the line** (2026-11-06,
   after a review of the app). The headline and the
   allocation leave out an open account whose start (opening) date is after today, as D3 already
   did (F1 RD10); it counts from that day on. A start after today can no longer be typed (F1
   RD19), so this covers files that already hold one. *Why:* a future start read ₹60,000 in the
   headline and ₹50,000 at the line's last point.
   *Built 2026-10-30:* the switch, the Shared view and its data are gone. The line
   sits under "this month" in the headline; the whole line is a button that opens, under the
   header, a table of those accounts (Account, Full, Your share, Yours; largest first; each name
   opens its register), a joint debt noting "You're liable for the full amount" (an expander, as
   Fluent's; no popover).
14. **EPS counts in net worth at what was paid in** (2026-11-05; built 2026-11-10, S5
    RD16): Illiquid, so it counts but is not available now, like EPF and PPF.
15. **The empty state offers the Actual import and the guide; no wizard** (2026-11-19):
    beside Add account sits "Import from Actual", the same file pick and preview as
    Settings' Import (F4), with one line saying which file it takes; under them a "User guide" link.
    The About dialog lists "User guide" and "Support Miserly". The addresses live in one place
    (`$lib/links`), empty until the export fills them, and an empty one hides its link. No prompts,
    banners or reminders.

## Circle addendum (Epic 8 · multi-user)

> Added 2026-06-25 by the [Circle epic](../circle/README.md) writeback (D6). Net worth becomes
> **viewer-scoped**; the aggregation contract and math are unchanged — only the **account set** is
> filtered.

- **Whose net worth?** The hero is computed over the **viewer's visible set** ([H2](../circle/H2-account-ownership-and-sharing.md)):
  their **personal accounts + shared accounts counted in full**. Shared balances overlap co-members —
  **never sum members** into an all-Circle total (that would double-count and pierce privacy).
- **Shared view.** A toggle/view shows net worth over **shared accounts only** (the common pot), distinct
  from the viewer's personal total. No all-Circle aggregate exists (architecture §12).
- **Contract unchanged.** Aggregation still reads only `current_value()` etc.; visibility filters the
  input account list via the one shared visible-set service.
- **AC delta:** the net-worth figure equals Σ over the viewer's visible open accounts (as-of-today); a
  separate Shared view sums shared accounts only. **Folded into the canonical Acceptance criteria + the
  Inclusion validation rule above (2026-06-25, MODE 2.5 correction M1)** — so the checklist itself is
  viewer-scoped, not only this addendum.

## Dependencies
- **Depends on:** F1 (accounts, side/status metadata, opening balance, the `opening + Σtx` balance),
  the module **aggregation contract** (structural), the **multi-currency** manual-rate mechanism for
  any foreign accounts.
- **Feeds / shares computation with:** D2 (allocation — same aggregation, bucketed), D3 (net-worth
  over time — same aggregation, historical), D4 (recent activity / account cards).
- **Excludes:** spending/income/cashflow (Reports epic), per-instrument detail pages (per-instrument
  epic), auto/historical FX (v2), staleness/insight nudges (intelligence layer).

---

### Research sources
- Net worth = assets − liabilities; track the **trend monthly** (weekly = noise, quarterly hides
  problems): https://statementsready.com/resources/personal-net-worth-statement-guide ; https://en.wikipedia.org/wiki/Net_worth
- Kubera / Empower — high-level assets-vs-liabilities net-worth dashboard, multi-currency, distinct
  from daily spending: https://www.wallstreetzen.com/blog/kubera-app-review/ ; https://www.wallstreetzen.com/blog/kubera-vs-empower-personal-dashboard-app/
- INDmoney — "personal balance sheet" net-worth summary + assets/liabilities + allocation IA (India
  instruments incl. EPF/PPF/NPS/FD): https://www.upraised.co/blog/indmoney-personal-balance-sheet/ ; https://www.indmoney.com/features/net-worth-tracker-calculator
- An earlier prototype of Miserly — `get_net_worth` (sum open accounts, liabilities signed-negative, base currency),
  `_account_balance_at` (historical from ledger) in `crud/analytics.py`.
