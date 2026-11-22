# MC3 — Multi-currency display & rate management

> **Epic:** Multi-currency · **Story:** MC3 · **Status:** LOCKED (2026-06-21)
> **MVP scope:** CRUD + manual valuation only, zero intelligence.

---

## Title
As the user, I can **see foreign amounts in their own currency with the INR equivalent alongside**,
and manage my **exchange rates in one place** (set/edit each currency's current rate, see when I last
updated it) — so I always know both the real native figure and what it's worth in rupees, and I'm
never silently shown a total built on a missing or stale rate.

## ELI5
My dollar account should still say "$1,000" — that's the real number — with "(≈ ₹83,000)" next to it so
I know what it means in rupees. And all my rates ("1 USD = ₹83", "1 EUR = ₹90") live on one little page
where I can update them and see "edited 3 days ago". If a rate is missing or old, the app tells me
gently instead of pretending.

## Business context
MC1 established *that* foreign balances convert to INR (the aggregation rate) and *that* a missing rate
must flag honestly; MC2 added cross-currency transfers. **MC3 is the presentation + control layer**:
how native-vs-converted amounts render across the app, and the **single surface where rates are
viewed/edited** with a freshness signal.

The display convention is industry consensus and we adopt it: **the record's native amount is primary;
the base-currency equivalent is secondary (parenthetical/sub-line); the currency code is shown** to
disambiguate (PocketSmith shows native value with base in tooltip; Salesforce/Workday show "record
currency (corporate currency)"; the Workday currency-UX guidance stresses showing the code)
([PocketSmith multi-currency](https://learn.pocketsmith.com/article/122-multi-currency-beta-features-in-pocketsmith),
[Workday currency UX](https://medium.com/workday-design/the-ux-of-currency-display-whats-in-a-sign-6447cbc4fb88)).
This matches the plan's "native first, converted second" stance — users distrust an app that hides the
real number.

Kubera additionally lets you **view net worth in any of ~10 currencies** — a **transient display
switch**, *not* a base change ([Kubera multi-currency](https://www.kubera.com/blog/multi-currency-portfolio-tracker)).
That's the right framing given MC1 locked **base = INR, fixed**: viewing-in-another-currency is cosmetic
and reversible, never a re-denomination.

For **manual** rates (MC1 locked manual entry), the freshness risk is real: apps that don't surface
rate age leave users on stale numbers. The accepted mitigation is a **"last updated" timestamp** (not a
live nag) — consistent with the app's no-nagging principle (S2/S3) ([rate freshness discussion](https://moneymatter.app/)).

## User workflow

### Happy path — reading a foreign account
1. The user opens their USD brokerage. The header shows **$12,400** (native, primary) with
   **≈ ₹10,29,200** (INR equivalent via MC1's current rate) as a secondary line.
2. In the register, each row shows its **native** amount; running balance is native. The INR equivalent
   appears for the account total / where cross-currency context matters — never replacing the native row.

### Happy path — managing rates
1. The user opens **Settings → Currencies & rates** (the rate surface; lives in SET1 / Settings).
2. They see each **active** currency: code, **current rate to INR**, and **"updated N days ago"**.
   Base (INR) shows as the fixed reference (rate 1, not editable).
3. They edit "1 USD = ₹83 → ₹84"; the timestamp resets to today; **all** base-currency aggregates
   (D1/D2/D3) recompute via the one shared `to_base` path.

### Alt path — missing rate (from MC1)
- An active foreign currency with **no rate** shows "**rate needed**" in the rate list and on any total
  that includes it, with a one-tap "set rate" jumping to this surface. Native balances still display
  fine; the total is **never** silently computed at 1:1.

### Alt path — view net worth in another currency (transient)
- On the dashboard, the user switches the **display currency** (e.g. show everything in USD for a
  moment). All figures re-express via the existing rates; **base stays INR** underneath — it's a view
  toggle that resets, not a setting change. *(Scope decided in Resolved decisions.)*

### Recovery path — stale rate
- A rate not updated in a while is shown with its age (e.g. "updated 38 days ago"), a gentle visual hint
  — **passive, not blocking**; the user updates it when they choose (no auto-fetch in MVP per MC1).

## Acceptance criteria
- [ ] Foreign amounts display **native-primary** with the **base (INR) equivalent secondary**
      (parenthetical/sub-line), and the **currency code/symbol** is shown to disambiguate.
- [ ] An account's **register rows and running balance are in the account's native currency**; the INR
      equivalent appears at the account-total / cross-currency level, never overwriting native rows.
- [ ] A single **rate-management surface** (Settings → Currencies & rates) lists every **active**
      currency with its **current rate to INR** and a **"last updated" timestamp**; base INR is shown as
      the fixed reference (rate 1, non-editable).
- [ ] Editing a rate **updates its timestamp** and **recomputes all base-currency aggregates**
      (D1/D2/D3) through the one shared conversion path — no per-screen drift.
- [ ] A **missing rate** for an active currency surfaces as "rate needed" both in the rate list and on
      any affected total, with a one-tap path to set it; **no silent 1:1** anywhere (MC1 invariant).
- [ ] A **stale rate** is shown with its **age** as a passive hint; there is **no blocking and no nag**
      (manual-by-design; auto-fetch is the deferred MC1 option).
- [ ] Cross-currency transfer rows (MC2) display **both** native legs clearly ("−$100" / "+₹8,200");
      the linkage rate is visible on the transfer detail.
- [ ] All amounts (native and converted) respect the **app-wide number-format preference**.

## Validation rules
- **Native is canonical:** the stored/derived figure is always the native amount; the base equivalent is
  **derived for display** (`native × rate`) and never persisted (MC1 rule).
- **Rate edit:** positive number, base-per-1-foreign; on save, set `last_updated = today`.
- **Active-currency list:** shows currencies used by ≥1 account (open or, for history, previously open —
  D3); inactive currencies' rates are retained but hidden/se­condary.
- **Display-currency switch (if in scope):** affects **display only**; persists nothing to balances and
  never changes base; resets per session/view (see Resolved decisions).
- **Staleness threshold:** a display-only age hint (e.g. highlight beyond ~30 days); purely cosmetic,
  configurable later — never alters computation.

## Edge cases
- **All-INR user:** no foreign amounts, the rate surface is empty/hidden, no secondary lines — the
  common case shows zero multi-currency chrome.
- **Account whose currency = base:** shows only the native (INR) figure, no parenthetical (would be
  redundant).
- **Very long converted figures** (weak currency → huge INR number): compact short-form per number-format
  preference where space is tight (e.g. ≈ ₹1.2Cr).
- **Rate edited mid-session:** every open screen reflects the new total on next render (one source).
- **Display-currency switch to a currency with a missing cross-rate:** fall back to "rate needed" rather
  than a wrong number (same honesty rule).
- **Closed foreign account in D3 history:** its currency's rate still drives historical conversion (MC1);
  the rate surface keeps the rate even if no account is currently open in it.

## Failure cases
- **Showing only the converted figure** and hiding the native amount: defect — native is canonical and
  must always be visible on its own records.
- **Silent stale/missing rate** producing a confident wrong total: defect — age/"rate needed" must be
  surfaced (the Firefly 1:1 and stale-rate traps).
- **Display-currency switch mutating stored balances or base**: defect — it is display-only.
- **Rate edited but some screen still shows the old total** (cached divergence): defect — one shared
  `to_base`, recompute everywhere.
- **Converted figure ignoring number-format preference** while native respects it (or vice-versa):
  defect — both go through the same formatter.

## UX considerations
- **Native first, always** — the real number leads; INR equivalent is a quiet companion, not a
  replacement. This preserves trust and matches the plan.
- **One calm rates page** — a short list (code · rate · "updated N days ago" · edit); feels like setting
  facts, sibling to valuation marks (S3). No charts, no live ticker (that's v2/intelligence).
- **Gentle freshness, never nagging** — age is informational; the user updates on their schedule
  (manual-by-design). No red alerts, no modal reminders.
- **Honest gaps** — "rate needed" reads as a helpful to-do with a one-tap fix, not an error wall; native
  data stays fully usable meanwhile.
- **Disambiguate with codes** — "$" can mean many dollars; show the ISO code where ambiguity is possible
  (Workday guidance), especially on the rate surface and cross-currency transfers.
- **View-in-another-currency** (if shipped) should feel obviously **temporary** (a toggle/segment, resets)
  so it's never confused with changing base.

## Operational considerations
- **Pure presentation + the rates CRUD over MC1's rates store** — MC3 adds **no new valuation math**; it
  reads `to_base` (MC1) and the rates store, and provides the edit UI + timestamps.
- **`last_updated` per rate** added to the rates store (the only new field); everything else derived.
- **Display-currency switch** (if in scope) = a view-layer re-expression: pick a display currency D,
  show `value_in_base ÷ rate[D]` (or direct native→D); persists nothing. Cleanly layered on `to_base`.
- **Single formatter + single conversion** shared by every surface — the structural guarantee against
  per-screen divergence (continues the C1–C4 / D-series shared-service discipline).
- **Rate surface co-locates with Settings (SET1)** (the number-format preference also lives there);
  MC3 specifies the currencies/rates section of that Settings area.
- **Offline in desktop mode** (manual rates; no internet in MVP); hosted mode is client↔server.

## Resolved decisions (locked 2026-06-21)
1. **"View net worth in another currency" = DEFERRED to v2** (LOCKED, option a): MVP always displays
   base = INR for totals (each account still shows its own native figure). The Kubera-style transient
   display-currency switch is low value for an INR-first user and trivial to layer on later via the same
   `to_base`/rates path.
2. **Staleness hint = passive age label, no nag** (LOCKED): show "updated N days ago" per rate, may
   highlight beyond ~30 days as a purely cosmetic cue; **never** blocks, modals, or nags (manual-by-
   design; auto-fetch is the deferred MC1 option). Age is informational only and never alters
   computation.
3. **Rate surface lives in Settings** (LOCKED): a **"Currencies & rates"** section inside the future
   Settings story, co-located with the app-wide number-format preference — not a separate top-level page.
4. **Only a holder of a currency sets its rate** (2026-11-12, after a security read): rates
   are one table for the Circle, so a rate typed by a member moves every holder's figures in that
   currency. The save is refused unless the person holds an account in that currency (open or closed,
   the same list the section shows them): "You hold no account in USD, so you can't set its rate." The
   answer depends only on their own accounts, so it tells them nothing about anyone else's.

## Dependencies
- **Depends on:** MC1 (rates store + `to_base` + missing-rate rule — MC3 is its UI/management layer),
  MC2 (cross-currency transfer rows to display), D1/D2/D3 (the totals that re-render on rate edits),
  the app-wide number-format preference (shared formatter).
- **Feeds:** **SET1** (Settings — hosts the Currencies & rates section alongside number-format),
  every screen that shows money (native-primary/base-secondary convention).
- **Relates to:** S3 (rate edits feel like valuation marks); D4 (recent-activity rows showing foreign
  amounts).
- **Excludes:** auto-fetch / live rate ticker / historical dated rates (v2, the MC1 deferred option);
  realized-FX reporting line (MC2 v2); changing the base currency (out of MVP, MC1); rate alerts
  (intelligence).

---

### Research sources
- PocketSmith — multi-currency display: native value shown, converted base in tooltip; preference to
  flip which leads: https://learn.pocketsmith.com/article/122-multi-currency-beta-features-in-pocketsmith
- Salesforce / Workday — "record currency (corporate/base currency)" parenthetical convention; show the
  ISO code to disambiguate the symbol:
  https://help.salesforce.com/s/articleView?id=sales.admin_enable_multicurrency_implications.htm ;
  https://medium.com/workday-design/the-ux-of-currency-display-whats-in-a-sign-6447cbc4fb88
- Kubera — "view net worth in any of ~10 currencies": a transient display switch, distinct from base:
  https://www.kubera.com/blog/multi-currency-portfolio-tracker
- Rate freshness — manual rates risk staleness; "last updated"/auto-refresh as the mitigation:
  https://moneymatter.app/
