# D3 — Net worth over time (the growth trend)

> **Epic:** Dashboard & net worth · **Story:** D3 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD + descriptive charts only, zero intelligence.

---

## Title
As the user, I can see my **net worth plotted over time** with a selectable timeframe, plus a simple
"change since last month" figure, so I can watch the trend that actually matters — is my wealth
growing? — instead of just today's snapshot.

## ELI5
D1 is "how much right now." This is "how it got here" — a line going (hopefully) up and to the right.
I pick a window (last year, all time, …) and see my net worth at each month, so I can tell if I'm
making progress or treading water. It also tells me how much I went up or down since last month.

## Business context
The growth trend is the third pillar of the hero ("total + **growth trend** + allocation") and,
arguably, the emotional payoff of tracking — the whole point of logging every paisa is to see the
line move. The personal-finance consensus is that **net worth is a trend, tracked monthly**
("weekly creates noise; quarterly hides problems too long")
([net-worth tracking guide](https://statementsready.com/resources/personal-net-worth-statement-guide)).

This is where Miserly's **transaction-based model pays a dividend a snapshot app can't match**:
because every balance is `opening + Σtx`, **history is reconstructable from the ledger itself** —
net worth at any past month-end = Σ over accounts of `balance_at(month-end)` (liabilities signed).
No separate monthly snapshots to capture, no "we only have data since you installed us." An account
opened mid-history simply contributes **0 before it existed**, so the line is correct with no
backfilling (an earlier prototype already had `_account_balance_at`). The deferred **"change since last month"**
delta from D1 is computed here and surfaced back on the hero.

Pure description: the line shows what happened. Forecasting/projection of the *future* trend is the
**intelligence layer (deferred)**.

## User workflow

### Happy path
1. On the dashboard, below/with the hero, the user sees a **net-worth line chart** over a default
   timeframe (e.g. 1Y), one point per month-end.
2. User picks a **timeframe** (1M / 3M / 6M / YTD / 1Y / ALL); the line rescales.
3. User hovers/taps a point → sees net worth (and assets/liabilities) at that month.
4. A **"change since last month"** figure (amount + %) is shown and also fed to the D1 hero.

### Alt path — show composition over time
- User toggles to show **assets vs liabilities** (two series / stacked area) instead of the single
  net-worth line, to see what's driving the change.

### Edge/empty path
- **< 2 months of history:** the chart shows what exists (a short line or single point) with a gentle
  "your trend will build as you track" note, rather than looking broken.

## Acceptance criteria
- [ ] A net-worth-over-time chart renders with **monthly month-end data points**, in base currency.
- [ ] A **timeframe selector** (1M / 3M / 6M / YTD / 1Y / ALL) windows the data; ALL spans from the
      first transaction in the ledger.
- [ ] Each month-end value is computed **from the ledger** (`Σ account balance_at(month-end)`,
      liabilities signed) **over the viewer's visible set** (`owned ∪ member-of`) — no stored snapshots;
      matches D1 exactly at the current month. A **Shared view** plots **shared accounts only**; **no
      all-Circle line**.
- [ ] An account that didn't exist at a given month contributes **0** to that month (no backfill, no
      error). *(Under the opening-as-column build: `balance_at(d)` counts `opening_paise` only when
      `d ≥ opening_date` — F1 Resolved decision 10, locked 2026-07-12.)*
- [ ] A **"change since last month"** figure (absolute + %) is shown and provided to the D1 hero.
- [ ] A point can be inspected to reveal **net worth / assets / liabilities** at that month.
- [ ] A toggle shows **assets vs liabilities** composition over time (multi-line or stacked area).
- [ ] **< 2 months** of data shows a graceful state, not a broken chart.
- [ ] Number formatting respects the app-wide multi-format preference (compact axis labels, full on
      hover).

## Validation rules
- **Points:** month-end (last calendar day) values; the current month uses **today's** as-of value so
  the latest point equals the D1 hero.
- **Inclusion:** open *and historically-relevant* accounts **within the viewer's visible set** — an
  account closed last year still contributed to past months (its history counts up to when its balance
  went to 0 on closing); D3 is historical, so it must include now-closed accounts for the periods they
  were open, **but only those the viewer holds/held**. (Contrast D1/D2, which are as-of-today and
  exclude closed accounts.)
- **FX (MVP):** historical native balances are converted using the **current manual rate** per
  currency (auto + historical FX = v2). This makes foreign-holding history approximate; acceptable for
  MVP and noted in-product if material (see Resolved decisions).
- **As-of-today vs projected:** the line uses as-of (date ≤ point); future-dated transactions only
  affect points on/after their date (and the projected figure, if shown).

## Edge cases
- **Closed accounts in history:** must appear in the months they were open (else past net worth is
  understated) — this is the key difference from D1/D2's open-only rule.
- **Back-dated transaction edits (C4):** recompute history correctly — a back-dated entry changes past
  month-end values; the chart reflects it (derived, never cached-stale).
- **A valuation mark** (mark-to-market) lands on its date and steps the line at that month — correct;
  the line is a step-wise reflection of recorded reality, not interpolated guesses between marks.
- **Very long history (years):** monthly points keep it light; ALL stays performant.
- **Mid-month large change:** only reflected at the month-end point (monthly granularity) — except the
  current month, which is live. Confirm monthly granularity is acceptable vs finer for short windows
  (Resolved decisions).
- **Currency added later:** months before any foreign holding existed are unaffected.

## Failure cases
- **Latest point ≠ D1 hero:** impossible by construction (same computation at `today`); divergence is
  P0.
- **History changes that don't propagate** after a back-dated edit/delete: defect — history is always
  recomputed from the ledger.
- **Misleading interpolation:** the chart must not invent values between real changes in a way that
  implies precision we don't have (stepwise vs linear choice — define; avoid implying daily marks that
  don't exist).
- **Dropped closed-account history** understating past net worth: defect.

## UX considerations
- **Up-and-to-the-right is the reward** — make the trend the visual hero of this section; keep it
  clean and calm (this is a wealth view, not a trading terminal).
- **Timeframe chips** familiar from stock apps (1M/3M/6M/YTD/1Y/ALL); remember the last choice.
- **"Change since last month" prominent** — it's the most motivating single number after the total;
  colour up/down honestly (incl. red downs).
- **Composition toggle** (net worth line ⇄ assets/liabilities) for users who want the "why".
- **Graceful early state** — a new user with one month shouldn't see a sad empty chart; frame it as
  "your trend starts here".
- **Hover/scrub** reveals the month's figures; respects the number-format preference.

## Operational considerations
- **Same aggregation service** as D1/D2, parameterised by an as-of date and iterated over month-ends
  → one net-worth computation, evaluated at N points. (An earlier prototype's `get_growth` +
  `_account_balance_at` are the reference.)
- **History is derived** from the ledger every time (or memoised with invalidation on any transaction
  change) — never a separate snapshot table that could drift.
- **Performance:** N month-end evaluations; for long ALL ranges, an incremental running-sum or a
  cached prior-months series (immutable once a month closes, except on back-dated edits) is the
  optimisation path — not premature in MVP.
- **FX:** single conversion point; swapping in historical FX later (v2) changes only that point, not
  the chart contract.
- **Offline-capable in desktop mode** (Electron); hosted mode is client↔server (architecture §11).

## Resolved decisions (locked 2026-06-20)
1. **Monthly points everywhere** (LOCKED) for MVP — including short timeframes (1M may show ~1–2
   points); adaptive daily/weekly granularity is a later revisit if short windows feel bare.
2. **Net-worth line default, toggle to assets/liabilities composition** (LOCKED).
3. **Default timeframe = 1Y** (LOCKED), ALL one tap away.
4. **Historical FX = today's manual rate** (LOCKED, MVP): foreign-holding history is approximate, with
   a small in-product note when foreign holdings exist; true historical FX = v2.
5. **Straight-line interpolation** between exact monthly month-end points (LOCKED).

**Amendments (2026-10-05, each chosen from options with their evidence):**

6. **Net worth by class or by account over time, with a recap table** (extends RD2): the
   composition view stacks the monthly points by class (or by account), and a **month × account recap
   table** sits under the chart (the spreadsheet persona's own format). It lives on the **Net worth**
   report tab (R1 RD5); the dashboard keeps the single line. Default range stays 1Y (RD3; R1 RD6).

**Amendments (2026-10-10, after a review of the app's screens):**

7. **A Change row in the recap table**: month-on-month change of net worth under
   the Net worth row, signed and coloured by sign (YNAB's "itemized month over month change").
8. **History at the viewer's share** (2026-10-20; option C of three ways to split a joint
   account, chosen 2026-10-17). Every point weights each shared account by the
   viewer's share (H2). Shares are dated (H2 RD8, 2026-10-21): each month-end uses the share in
   force on that date, so a change of split moves the line only from its date on, and the current
   month still matches D1 exactly. The Shared view is removed.
   Supersedes the Shared view text above and the Circle note below.
   **Holders by date (2026-11-09; H2 RD8, RD9):** a point counts an
   account at the viewer's share only on the dates they held it, so the line no longer moves the
   owner's past when they share an account, a member's line starts the day they joined, and a member
   who has left keeps their share of the months they held it (0 after). Where a section's return per
   year reads the same weights, a change of share counts as money moved at that day's value (S2
   RD14).
9. **The line never starts after today** (2026-11-06, after a review of
   the app). With every account starting later, the line is one
   point today at ₹0 (it threw before); D1 RD13 makes the headline agree.

## Circle addendum (Epic 8 · multi-user)

> Added 2026-06-25 by the [Circle epic](../circle/README.md) writeback (D6).

- **Viewer-scoped history.** The net-worth-over-time line is computed over the viewer's visible set
  (personal + shared in full), mirroring [D1](D1-net-worth-command-center.md); a **Shared view** plots
  shared accounts only. No all-Circle line.
- **Closed shared accounts** still count for the periods they were open (the locked closed-not-archived
  history rule), **within the viewer's scope** — i.e. only if the viewer was a holder.
- **AC delta:** each historical point sums the viewer's visible open-at-that-date accounts. **Folded
  into the canonical Acceptance criteria + Inclusion rule above (2026-06-25, MODE 2.5 M1).**

## Dependencies
- **Depends on:** D1 (aggregation service, as-of-today, FX point), F1 (accounts incl. closed-account
  history; opening balance as the earliest ledger anchor), C4 (back-dated edits recompute history),
  the app-wide number-format preference.
- **Feeds:** D1 hero (the "change since last month" delta originates here).
- **Excludes:** future-trend **forecasting/projection** (intelligence layer), true historical FX
  (v2), allocation-over-time (later), per-account return/performance charts (per-instrument epic).

---

### Research sources
- Net worth is a **monthly trend**, not a snapshot; timeframe-selector conventions (1M/3M/6M/YTD/1Y/
  ALL): https://statementsready.com/resources/personal-net-worth-statement-guide
- Long-horizon net-worth tracking examples (monthly cadence, multi-year lines): https://budgetsaresexy.com/net-worth/ ; https://getfiledrop.com/how-to-create-a-monthly-net-worth-tracker-using-charts-in-google-sheets/
- Stacked-area assets-vs-liabilities-over-time + downloadable history (Lunch Money net worth):
  https://lunchmoney.app/features/net-worth
- An earlier prototype of Miserly — `get_growth` (month-by-month points, liabilities signed) + `_account_balance_at`
  (historical balance from ledger/valuations) in `crud/analytics.py`.
