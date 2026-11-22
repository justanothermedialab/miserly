# R1 — Reports shell & the date-range selector

> **Epic:** Charts / reports · **Story:** R1 · **Status:** LOCKED (2026-06-21)
> **MVP scope:** CRUD + descriptive charts only, zero intelligence.

---

## Title
As the user, I have a **Reports area** with a single **date-range selector** — quick presets (This
month, Last month, This FY, YTD…) plus a custom start–end range — that **every report shares**, so I
can pick a period once and see all my spending/cashflow analytics for exactly that window.

## ELI5
The Dashboard always shows "right now". Reports is the opposite: it's where I ask "what happened
*between these dates*?". So Reports needs one date control at the top — tap "This month" or "last
financial year" or pick my own dates — and all the charts below answer for that period. This story
builds that shell and the date picker; the actual charts come next (R2, R3).

## Business context
The plan locked a deliberate boundary: **"today" for Dashboard/Accounts; the date-range selector lives
*only* in Reports/Analytics.** R1 builds that container — the Reports home and the shared period
control — so R2 (spending by category) and R3 (income vs expense / cashflow) plug into one consistent
date model instead of each inventing its own.

The interaction model follows the established convention, adapted for India:
- **Presets + custom range** is the universal pattern: offer the handful of periods users actually
  return to (This/Last month, This/Last quarter, YTD, plus a custom range), not a cluttered list
  ([date-range UX](https://blog.mobiscroll.com/the-ui-of-date-ranges/),
  [Actual reports](https://actualbudget.org/docs/reports/custom-reports/)).
- **Live (relative) vs static (fixed) ranges** — Actual's useful distinction: "This month" is **live**
  (it always means the current month, recomputing as time passes), while a custom start–end is
  **static** (a fixed window) ([Actual custom reports](https://actualbudget.org/docs/reports/custom-reports/)).
- **India-native Financial Year:** Indian tax/financial life runs **Apr 1 – Mar 31**, so **"This FY" / "Last
  FY"** presets are a first-class, tax-relevant touch (a small India advantage over Western-default
  tools). YTD has two readings — calendar-YTD vs FY-YTD — resolved in the decisions below.
- **Custom range** uses a single-calendar start–end selection with the range shaded
  ([date-range UI](https://blog.mobiscroll.com/the-ui-of-date-ranges/)).

This is purely a **descriptive** shell over recorded data — no forecasts, no insights (that's the
deferred intelligence layer).

## User workflow

### Happy path — pick a period, see reports for it
1. The user opens **Reports**. A default period is already applied (e.g. **This month**) so the page is
   immediately useful.
2. A **period selector** sits at the top: preset chips (This month, Last month, This quarter, This FY,
   YTD, All time) + **Custom range**.
3. They tap **Last month**; every report below (R2/R3) recomputes for that window. The chosen period is
   shown clearly ("1–30 Jun 2026").

### Happy path — custom range
1. They tap **Custom**, pick **start** and **end** on one calendar (range shaded), confirm.
2. Reports recompute for that fixed (static) window; the selector shows the explicit dates.

### Alt path — financial-year view
- They tap **This FY** → period = **1 Apr 2026 – 31 Mar 2027**; **Last FY** = the prior Apr–Mar. Great
  for year-end / tax review.

### Alt path — empty or partial period
- A period with **no transactions** shows a clean "no activity in this period" state across reports (not
  an error); a period partially before the user's first transaction simply includes what exists.

### Recovery path — switch periods freely
- Changing the period re-runs all reports instantly (derived queries); nothing is saved/mutated. The
  selected period **persists while navigating between reports** in the session.

## Acceptance criteria
- [ ] A dedicated **Reports area** exists, separate from Dashboard, hosting the report list/links and a
      **single shared date-range selector** at the top.
- [ ] The selector offers **presets**: This month, Last month, This quarter (and/or Last quarter), This
      **FY** (Apr–Mar), Last FY, **YTD**, All time — plus **Custom range** (explicit start–end).
- [ ] Presets are **live/relative** (e.g. "This month" always means the current month) where
      applicable; **Custom** is a **static** fixed window.
- [ ] Selecting any period **drives every report** in the area (R2/R3 consume the same selected range) —
      one period model, no per-report date controls.
- [ ] The **active period is always clearly displayed** (preset name + the concrete dates it resolves
      to, e.g. "This FY · 1 Apr 2026 – 31 Mar 2027").
- [ ] **Custom range** uses a start–end picker with the selected range visually indicated; end ≥ start.
- [ ] The selected period **persists across reports within a session**; on a fresh session it resets to
      the default period.
- [ ] An **empty period** yields a calm "no activity" state (not an error) across reports.
- [ ] All period boundaries respect the **as-of-today** rule where relevant (a live range never extends
      past today for "to-date" semantics — see Validation) and the app-wide number-format preference
      applies to any figures shown in the shell.
- [ ] Reports are **read-only descriptive views**; tapping into data drills to the register (consistent
      with D4's tap-through), never edits in the report.

## Validation rules
- **Range integrity:** end date ≥ start date; both valid dates; custom ranges may span any length
  (single day to multi-year).
- **Live preset resolution:** computed against **today** at view time — "This month" = 1st→today (or
  1st→month-end for a completed sense; pick one, see Resolved decisions); "YTD" = period-start→today.
- **FY definition:** **Apr 1 – Mar 31** (India); "This FY" is the FY containing today; "Last FY" the
  prior one. (FY start is a fixed app rule in MVP; configurable FY = deferred.)
- **As-of-today guard:** to-date/live ranges do **not** include future-dated transactions (consistent
  with C1/D-series "as of today"); a custom range with a future end simply has no data beyond today.
- **Timezone/day boundaries:** periods are inclusive calendar-date ranges in the user's local date
  (date-only, no time-of-day), consistent with `(date, sequence)` ordering (C1).
- **Transfers & kinds:** the *shell* just defines the window; which rows count (exclude transfers,
  Spending vs Income vs Neutral kinds) is each report's concern (R2/R3, per F2) — R1 doesn't filter by
  kind.

## Edge cases
- **Period entirely before first transaction / after last:** empty state, no error.
- **Custom range of one day:** valid (that day's activity).
- **"All time":** from the earliest transaction (across all accounts, incl. closed — like D3) to today.
- **FY boundary spanning:** "This FY" in Jun 2026 = Apr 2026–Mar 2027; in Feb 2026 = Apr 2025–Mar 2026
  (the FY containing today).
- **Leap-year / month-length** for "This month"/"Last month": resolve to actual month lengths.
- **Very long custom range** (e.g. 5 years): allowed; reports aggregate accordingly (performance =
  derived query, memoised like balances).
- **Multi-currency (MC1):** any monetary figure shown in the shell uses base INR via `to_base`; reports
  themselves handle conversion (R2/R3) — R1 doesn't double-convert.

## Failure cases
- **A report ignoring the shared period** (using its own dates): defect — one period model drives all.
- **Live preset including future-dated rows** (breaking as-of-today): defect.
- **Off-by-one boundaries** (excluding the 1st or the end date): defect — ranges are inclusive and exact.
- **FY computed as Jan–Dec** (Western default) instead of Apr–Mar: defect for the India persona.
- **Period silently resetting** mid-session while navigating reports: defect — it must persist within
  the session.
- **Stale results** after changing the period (a report not recomputing): defect — derived, recompute on
  period change.

## UX considerations
- **One control, top of Reports** — unmistakable, always visible; presets as quick chips, Custom behind
  one tap. Don't clutter with rarely-used presets.
- **Always show the resolved dates** — a preset name alone is ambiguous; pair it with the concrete
  window so the user trusts what they're seeing.
- **India-first presets** — surface **This FY / Last FY** prominently (tax-relevant); they're a quiet
  differentiator vs Western-default tools.
- **Immediate, reversible** — switching periods is instant and safe; encourages exploration.
- **Calm empty states** — "no activity in this period" reads as information, not a problem.
- **Consistent with Dashboard split** — Reports is explicitly the "over a period" view; Dashboard stays
  "as of today". The two never blur (no date selector creeps onto the Dashboard).
- **Read-only, drill to register** — reports explain; edits happen in the register (D4 pattern).

## Operational considerations
- **A shared period state** (selected range, resolved start/end) owned by the Reports area and consumed
  by R2/R3 — the single source for "what window are we reporting on".
- **Preset → concrete-range resolver** (one function): maps each preset to `[start, end]` against today,
  incl. the **Apr–Mar FY** logic; Custom passes through. Live presets re-resolve on each view; static
  custom is fixed.
- **Reports are derived queries** over the ledger filtered by the resolved range (+ each report's
  kind/transfer rules), memoised/invalidated like balances — no report tables, no snapshots (consistent
  with D3's "reconstruct from ledger").
- **Base-currency via `to_base`** (MC1) for any cross-account totals; one conversion path.
- **Session persistence** of the selected period (in-memory/app state); default applied on fresh load.
- **Offline-capable in desktop mode** (Electron); hosted mode is client↔server (architecture §11).

## Resolved decisions (locked 2026-06-21)
1. **Default landing period = This month** (LOCKED): Reports opens on the current month (resolved as
   month-to-date, per #2) so it's immediately useful for the common spending review. *(Superseded 2026-10-05 by RD6.)*
2. **Live "to-date" semantics = month-to-date / period-to-date** (LOCKED): "This month" = **1st →
   today** (not the full calendar month); future-dated rows never included (consistent with the
   app-wide as-of-today rule). The same to-date logic governs YTD/FY-to-date.
3. **Both calendar-YTD and FY-to-date offered, via a toggle/knob** (LOCKED): the period selector exposes
   **both** "YTD" (1 Jan → today) and "FY-to-date" (1 Apr → today, India FY), clearly labelled — likely
   a small toggle/knob so the user picks which year-to-date basis they mean rather than cluttering with
   two near-identical chips. (FY = Apr–Mar fixed in MVP; configurable FY start = deferred.)
4. **Reports home = a simple fixed set** (LOCKED): the MVP reports (spending by category R2,
   income-vs-expense + cashflow R3) presented as a fixed set sharing the one date control. A
   customizable widget/card report dashboard (Actual-style) = post-MVP.
   *(Superseded 2026-10-05 by RD5.)*

**Amendments (2026-10-05, each chosen from options with their evidence):**

5. **Named-report tabs** (supersedes RD4): **Spending**, **Income vs expense** and **Net worth**,
   each with its own range control, a headline figure with its period, one full-width chart and its
   table under the chart. *Why:* Monarch, Simplifi and YNAB use tabs; one page of toggles cost 3 clicks
   to Actual's 1.
6. **Default range = trailing 6 months** for Spending and Income vs expense, **12 months** for Net
   worth (D3 RD3) (supersedes RD1). The presets add **rolling 3, 6 and 12 months** beside This
   month, YTD/FY-to-date and All time. "Last 6 months" = the current month to date plus the five full
   months before it (RD2's to-date rule still holds; no future-dated rows).
7. **Colour** (see D1 RD7): expense figures red, income green, a net figure by its sign.

**Forgotten-work sweep (2026-11-05; depth for a data analyst):**

8. **Export**, a ghost button at the right end of the tabs line (on the range row it pushed the
   row onto two lines at 1232), saves the open report's table as a CSV (as the register's
   Export): the rows and columns on screen for the range shown,
   amounts as plain numbers, shares and Saved as percent numbers, the Total, Net worth and Change
   rows included. Made in the page from what it already holds, so it carries only the viewer's
   figures (P0, at the share). Filters by account or category and a same-month-last-year
   comparison are deferred to the next version.

**Amendment (2026-11-06, after a review of the app):**

9. **"All time" starts at the first thing the reports count**: the earliest of a bank or
   card account's opening or first row, and a categorised row on any account. *Why:* the category
   decides income and spending on every account (R3 RD11), but All time began at the bank and
   card accounts, so a Salary row typed on EPF before the first bank row was left out.

**The year start (2026-11-18):**

10. **The financial year starts in the month chosen at setup: April or January** (H1 RD15; amends
    the FY definition above, which fixed April to March). "This financial year", "Last financial
    year" and "Financial year to date" follow it. With April (every instance set up before the
    choice, and INR's default) nothing changes. With January they read "This year", "Last year"
    and, since a January year to date is the calendar one, "Financial year to date" is not offered
    (its URL resolves to the same window as "Year to date (from Jan)"); the "April to March" hint is
    dropped. PPF's "Deposited this year" keeps the law's April-to-March year whatever is chosen (S5
    RD14). Changing the year start later comes after the first release.

## Dependencies
- **Depends on:** the ledger + `(date, sequence)` model (C1), F2 (kinds — used by the reports the shell
  hosts), MC1 (`to_base` for any base-currency figures), D-series conventions (as-of-today, read-only
  drill-to-register), SET1 (number-format for displayed figures).
- **Feeds:** R2 (spending by category) and R3 (income vs expense / cashflow) — both consume this shared
  period; any future reports.
- **Relates to:** D3 (also period-based but fixed timeframe chips on the Dashboard; Reports is the
  general date-range home), D4 (drill-to-register pattern).
- **Excludes:** the actual spending/cashflow charts (R2/R3); customizable report dashboards (post-MVP);
  configurable FY start (deferred); saved/named custom reports (post-MVP); export (later); forecasts /
  insights (intelligence layer, deferred).

---

### Research sources
- Actual Budget — reports tunable with filters + **live vs static** date ranges; custom-range filtering;
  Reports dashboard: https://actualbudget.org/docs/reports/custom-reports/ ;
  https://actualbudget.org/docs/reports/
- Date-range UX — presets users return to (This/Last month, quarters, YTD) + custom; single-calendar
  start–end with shaded range; avoid clutter; smart defaults:
  https://blog.mobiscroll.com/the-ui-of-date-ranges/ ;
  https://demo.mobiscroll.com/range/date-filtering-with-predefined-ranges
- India Financial Year = Apr 1 – Mar 31 (basis for This FY / Last FY / FY-to-date presets).
