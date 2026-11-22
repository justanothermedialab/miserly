# S3 — Valuation mark (mark-to-market)

> **Epic:** Per-instrument sections · **Story:** S3 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD + manual valuation only, zero intelligence.

---

## Title
As the user, I can update a holding's value by simply typing **"it's now worth ₹X"**, and Miserly
records the difference as a single adjustment so the holding's value, my returns, and my net worth
all update — it *feels* like a snapshot but is stored as a transaction, so nothing ever drifts.

## ELI5
My mutual fund or property goes up and down, but no cash actually moves — so there's no transaction to
log. The "mark" is how I tell Miserly the new value: I type today's worth, and it quietly writes the
gain (or loss) as one line in the ledger. To me it's "set the value"; underneath it's still a
transaction, which is why every screen always agrees.

## Business context
The valuation mark is the **one piece of machinery that lets a pure-ledger app track market
movement**. Everything else is cash flows (contributions, withdrawals, spending); unrealized gain/loss
is the only change that *isn't* a cash flow, and the mark captures it. This is the mechanism the plan
locked instead of a snapshot model: **type a target value → the system posts the gap as one adjustment
transaction**, so value is always derived (`opening + Σtx`) and can never disagree across screens.

It's the same proven pattern as beancount's `pad` + `balance` directive (assert a balance; synthesize
the adjustment to reach it) — validated back in F1 — and the manual "type the current value" update
Kubera offers for assets without live feeds
([beancount](https://academy.beanhub.io/intro/beancount-and-double-entry/),
[Kubera](https://moneywise.com/investing/reviews/kubera-review)).

It is a **shared primitive**, reused by:
- **S2** holding onboarding (the initial invested→value gap is a mark),
- and ongoing **re-valuation** of any holding.
- *(Reconciled 2026-07-12 — see F1 Resolved decisions 9–11: the F1 opening balance is a dated
  **column**, and force-close posts a categorized **ordinary** adjustment; both share the
  assert-value→post-gap arithmetic but are NOT mark rows, so this story's "markable holdings only"
  rule stands with no carve-out.)*

Because a mark is a **non-transfer** adjustment, it moves **value only, not cost basis** (S2) — i.e.
it *is* the unrealized gain/loss. Auto-valuation (units×NAV, price lookup, accrual engines) replaces
manual marks with computed ones in **v2**, leaving this contract unchanged.

## User workflow

### Happy path — re-value a holding
1. In a holding's detail (S2), the user taps **Update value**.
2. Enters the **current value** (default = current derived value) and a **date** (default today).
3. Saves → Miserly posts one **adjustment row** = `target − value-just-before-this-point`; the
   holding's value becomes the target, return recomputes (value − cost basis), net worth updates.

### Happy path — it dropped
- The user marks a lower value → the adjustment is negative → value and return fall; shown honestly.

### Alt path — back-dated mark
- The user marks a value as of a past date; the adjustment is computed so the running value **at that
  point** equals the target, and later rows stack on top (consistent with C1 `(date, sequence)` and
  D3 history, which steps at the mark).

### Recovery path — wrong value
- A mark is an ordinary transaction: edit it (re-enter the target → gap re-derives) or delete it
  (value reverts), via C4. Undo applies.

## Acceptance criteria
- [ ] On a **holding account**, the user can "update value" by typing a **target value** and a date.
- [ ] Saving posts **exactly one adjustment transaction** = `target − running value immediately
      before this row`, so the running value after it **equals the target**.
- [ ] The mark is a **non-transfer adjustment**: it changes **value only, not cost basis** (S2), and
      is **excluded from spending/income** analytics (it's not a cash flow).
- [ ] Marks can be **positive or negative** and **back- or future-dated** (consistent with C1/F1).
- [ ] After a mark, the holding's **value, return, D1 net worth, D3 history, and the register** all
      reconcile (one derived computation; no drift).
- [ ] A mark is **editable/deletable** like any transaction (C4), with the target re-deriving the gap;
      undo supported.
- [ ] The asserted **target value and date are recorded** (so the row reads "Valuation update → ₹X"),
      distinct from contributions/withdrawals in the register.
- [ ] Marks apply to **markable holding accounts only** (not transactional spending/bank/card
      accounts, whose value is real recorded cash).

## Validation rules
- **Target value:** a number ≥ 0 for an asset holding (a holding can be marked to 0 = worthless);
  for liability holdings the sign follows the module (see Edge cases). Same-as-current → no-op (Open
  Qs).
- **Date:** valid; defaults today; past/future allowed; the gap is computed against the running value
  at the mark's `(date, sequence)` position.
- **Account type:** only **markable** (holding) accounts; spending/transactional accounts reject
  marking (their balance is reconciled by real transactions, not asserted).
- **Currency:** the target is in the **holding's native currency**; the adjustment is native; base
  conversion happens only at aggregation (D1), never here.

## Edge cases
- **Zero-gap mark** (target = current value): treat as a no-op (don't create a row) or record a
  "confirmed on date" zero entry? See Resolved decisions.
- **Back-dated mark with later activity:** the adjustment makes the value correct *at that date*;
  subsequent contributions/marks stack — the user may need a fresh mark for "today" if today's value
  also changed. Make this intuitive (the Update-value default = current value).
- **Mark on a liability holding** (e.g. a loan's outstanding incl. accrued interest): the mark adjusts
  the owed balance toward the stated figure; sign handled by the module. (Loan-with-property specifics
  = S4; general loan modelling = S5.)
- **Marking to 0:** valid (a holding became worthless / fully matured and moved out) — then the
  account can be closed (F1).
- **Repeated marks same day:** allowed; ordered by `(date, sequence)`; each computes against the prior
  running value.
- **Editing a contribution after a mark:** changes the running value; the mark's *target* is its
  intent — decide whether a mark re-derives its gap when prior rows change (Resolved decisions).

## Failure cases
- **Mark changing cost basis:** defect — a mark is non-transfer and must never touch cost basis (S2).
- **Mark leaking into spending/income:** defect — adjustments are excluded from cashflow analytics.
- **Value after mark ≠ target:** defect — the gap math must make running-value-after = target exactly.
- **Drift between holding value, net worth, history:** impossible by construction; any divergence is P0.
- **Marking a spending/bank account:** must be rejected (those reconcile via real transactions).

## UX considerations
- **It must feel like a snapshot, not accounting** — "Update value → ₹X" with the current value
  pre-filled; the user never thinks about "adjustments". The transaction underneath is invisible
  (shown in the register as "Valuation update", labelled distinctly per D4/S2).
- **Gain/loss feedback** — after marking, surface the change ("+₹1,500 since last value") as a small,
  factual confirmation (no advice — that's intelligence).
- **One obvious action per holding** — Update value sits alongside contribute/withdraw; clearly the
  "the market moved" path vs the "I moved cash" path.
- **Honest down-marks** — losses shown plainly; no euphemism.
- **Manual, on the user's schedule** — no nagging to re-mark (staleness nudges = intelligence/deferred).
- Respects the app-wide number-format preference.

## Operational considerations
- **One shared "assert value → post gap" primitive** implements S3, the S2 onboarding gap, and the F1
  opening/force-close adjustments — a single, well-tested mechanism (beancount `pad`/`balance`
  semantics).
- **Adjustment row** carries: amount (the gap), date, type = valuation-mark (non-transfer), and the
  asserted target value (metadata for display/audit and for re-derivation on edit).
- **Gap computation** uses the same `(date, sequence)` ordering as balances; value-after = target by
  construction.
- **Derived everywhere** — no stored "current value" field; the mark just adds a row.
- **Offline-capable in desktop mode** (Electron); hosted mode is client↔server (architecture §11).

## Resolved decisions (locked 2026-06-20)
1. **Re-derivation = keep the asserted target, re-derive the gap** (LOCKED): a mark means "it was
   worth ₹X on that date", so if prior rows change (e.g. a back-dated contribution is edited), the
   mark holds its target and recomputes its gap so value-after-mark still equals the target. Slightly
   more complex, but correct.
2. **Marking liabilities IS in MVP — loan outstanding is important** (LOCKED): any holding-liability
   (home loan, personal loan, car loan, other) can be **marked to its real outstanding** (which
   includes accrued interest and rarely equals opening − payments). Markable scope = holding accounts,
   **assets and holding-liabilities**; spending/bank/card accounts are never marked (real cash,
   reconciled by transactions).
3. **Zero-gap mark = skip** (LOCKED, default): no row created; an optional "confirm value" affordance
   can come later.
4. **Store the asserted target value on the row** (LOCKED): register shows "Valuation update → ₹X";
   editing the target re-derives the gap.

**Amendments (2026-11-06, after a review of the app):**

5. **RD1 covers the opening too**. Editing an account's opening balance or Invested
   re-derives its value updates in the same write, so "worth ₹1.5L on 31 Oct" stays ₹1.5L and
   the return moves instead. *Why:* the opening was the one write that skipped the re-derivation;
   correcting Invested from ₹1,00,000 to ₹1,20,000 moved the value to ₹1,70,000.
6. **Editing a value update checks its sign as posting one does**: an asset's value can't
   go below zero, a loan's outstanding can't go above it. *Why:* the edit skipped the check, so a
   gold holding could be edited to minus ₹60,000.
7. **A value update can't be dated before the account's start**: posting one, or
   moving one's date, before the opening date is refused ("A value update can't be dated before
   the account's start (23 Oct 2026)"). One already there (say, an apartment valued 5 Oct and
   opened 23 Oct) keeps its date and still takes a new value. *Why:* it states a value for money
   the account didn't hold yet.

**Amendments (2026-11-09, after a review of the app):**

8. **A value update that matches records a ₹0 row** (amends RD3). "Update value" to the
   value already recorded writes a value-update row of ₹0 with its target, so "Last updated" and
   the return per year see the confirmation (S2 RD12). It moves nothing. *Why:* a property valued
   at what it cost every year left no trace, so its value never read as known.
9. **A loan says when its outstanding was last updated, and when payments pass zero** (amends
   RD2). A loan's register and the Loans section show "Last updated 12 months ago"
   (the last Update value, else the day it was added), amber after 13 months (S5 RD11). When a
   loan (any liability that takes an Update value; a card can't) reads above zero, its payments
   alone have passed what was owed, because each EMI counts in full and its interest arrives only
   with an Update value: the register and the section show "Payments have passed what was owed.
   Update the outstanding from your lender's statement." Nothing is calculated (the data hard
   line); typing the interest as its own row ("Loan interest", F2 RD11) also keeps it right.
   *Why:* ₹5L over 60 EMIs read ₹1,22,740 in credit, net worth ₹1.23 lakh high, with no word.
10. **An imported reconciliation adjustment is a value update** (2026-11-10, F4). Actual records an
    investment's new value by reconciling, which adds "Reconciliation balance adjustment". On a
    holding it comes in as a value update on its own date, stating the value Actual reached then
    (the sample's Kuvera MF: Invested ₹7,90,000, Value ₹8,48,230); on a bank or card, a Balance
    adjustment row. One dated before the account's start stays a row (RD7).

### Deferred note — secured-loan ↔ asset attachment (net equity)
The user flagged that a **secured loan should be attachable to an asset** — existing or new (home loan
↔ property, car loan ↔ car, etc.) — so the app can show **net equity** (asset value − linked loan).
This **generalises beyond property**: it's an asset↔liability link, not a property-only feature.
Captured here as the conceptual home of "outstanding"; the **linking mechanism + net-equity display
is specified in S4** (reframed from "Property + loan" to general asset↔liability linking, property as
the lead example). Marking the loan's outstanding (this story) is the prerequisite; the *attachment*
itself may be partially deferred/cosmetic in MVP — see S4.

## Dependencies
- **Depends on:** S2 (holding model — marks move value not cost basis; return = value − cost basis),
  C1 (transactions + `(date, sequence)` ordering + derived balance), C4 (edit/delete/undo of a mark),
  F1 (shares the opening/adjustment primitive), S1 (invoked from the holding detail).
- **Feeds:** D1/D2/D3 (value/net-worth/history move with marks), S4 (property revaluation uses marks),
  S5 (each holding module exposes "update value").
- **Excludes:** auto-valuation — units×NAV, price/NAV lookup, accrual engines (all **v2**, replace
  manual marks with computed ones, same contract); re-mark reminders / staleness (intelligence).

---

### Research sources
- beancount `pad` + `balance` — assert a balance, synthesize the adjustment transaction to reach it
  (the exact mark mechanism; validated in F1): https://academy.beanhub.io/intro/beancount-and-double-entry/
- Kubera — manual "type the current value" updates for assets without live feeds: https://moneywise.com/investing/reviews/kubera-review
- (Cost-basis vs value separation established in S2; this story is the value-only side.)
