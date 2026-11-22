# S4 — Asset↔liability linking & net equity (property / secured loans)

> **Epic:** Per-instrument sections · **Story:** S4 · **Status:** LOCKED (2026-06-20) — linking
> **DEFERRED to post-MVP**; MVP fallback (standalone accounts) confirmed below.
> **MVP scope:** CRUD + manual valuation only, zero intelligence.

---

## Title
As the user, I can **link a secured loan to the asset it financed** (home loan → flat, car loan →
car) so a section can show me **net equity** (asset value − loan outstanding) in one place — while my
net worth stays correct whether or not I bother to link them.

## ELI5
My flat is worth ₹1 crore but I still owe ₹40 lakh on the home loan. Both already count in my net
worth (the flat adds ₹1cr, the loan subtracts ₹40L, so it nets to ₹60L either way). This story just
lets me *tie them together* so I can see "Flat: ₹1cr − ₹40L loan = ₹60L equity" as one tidy unit,
instead of an asset on one page and a loan on another.

## Business context
On a personal balance sheet, an asset is recorded at **full value** and its loan at **full
outstanding**; net worth = Σassets − Σliabilities nets them automatically
([Britannica](https://www.britannica.com/money/personal-balance-sheet),
[Experian car equity](https://www.experian.com/blogs/ask-experian/what-does-it-mean-to-have-equity-in-your-car/)).
So the crucial point: **net worth is already correct without linking** — the asset is a markable
holding (S2/S3) and the loan is a markable holding-liability whose **outstanding** the user marks
(S3). What this story adds is **presentational**: an optional **link** so a section/card shows
**net equity** together, the way Kubera ties a home value to its mortgage
([Kubera](https://moneywise.com/investing/reviews/kubera-review)).

Per the user's own framing, the link is **cosmetic and may be partly deferred** — it must never be a
*prerequisite* for correctness. It also **generalises beyond property** (the original "Property + loan"
framing): any **secured loan ↔ asset** (car, gold loan, loan-against-securities, …); an **unsecured**
loan (personal loan) simply has no linked asset and stands alone.

## User workflow

### Happy path — without linking (always works)
1. User adds a **Property** account (markable holding; onboard with purchase cost + current value, S2)
   and a **Home loan** account (holding-liability; marks the outstanding, S3).
2. Net worth already reflects flat value − loan outstanding correctly; each appears in its section.

### Happy path — with linking (the nicety)
1. On the asset (or loan), the user picks **"link a loan"** (or "link to an asset") and selects an
   existing account (or creates one).
2. The asset's section/card now shows **value, linked loan outstanding, and net equity** together.
3. Marking either side (S3) updates the equity figure; net worth is unchanged by the link itself.

### Edge/empty path
- An unsecured loan (personal loan) has no link — shown as a standalone liability.
- An asset with no loan shows value = equity (nothing to subtract).

## Acceptance criteria
- [ ] **Net worth is correct without any link** — a property/car asset and its loan, as independent
      accounts, net correctly in D1/D2/D3 (asset full value, loan full outstanding).
- [ ] A user can **link a liability account to an asset account** (1:1 in MVP — see Resolved decisions); the link
      is **optional** and purely presentational.
- [ ] A linked asset's section/card shows **asset value − linked loan outstanding = net equity**.
- [ ] **Marking** either side (S3) updates the equity display; the link changes **no** net-worth math.
- [ ] **Unlinking** is possible and leaves both accounts intact and still correct.
- [ ] Generalises to any **secured loan ↔ asset** pair (home, car, gold-loan, LAS), not just property;
      **unsecured loans** stand alone with no link.
- [ ] Removing/closing one side handles the link gracefully (no dangling link — see Failure cases).
- [ ] Figures respect the app-wide number-format preference.

## Validation rules
- **Link constraint (MVP):** one asset ↔ one loan (1:1). Multi-loan-per-asset / multi-asset-per-loan
  deferred (see Resolved decisions).
- **Link types:** the liability side must be a **liability** account; the asset side an **asset**
  account. The app may suggest sensible pairs (home loan ↔ property) but doesn't enforce module pairing
  (a user could link a personal loan to an asset if they wish).
- **Equity = asset current value − linked loan outstanding**, both in the asset's display currency
  (cross-currency pairs convert at the aggregation rate; flag if mismatched — consistent with D1).
- **No double counting:** the link must not alter how either account contributes to net worth (they
  already count independently).

## Edge cases
- **Loan outstanding exceeds asset value** (underwater / negative equity): show negative equity
  honestly (e.g. a car worth less than its loan).
- **Asset sold but loan remains** (or vice-versa): unlink; each continues independently; closing the
  asset (F1) must not silently delete the loan.
- **Top-up loan / second loan on the same asset:** not representable under 1:1 in MVP — both loans
  still count in net worth, just not grouped; revisit with multi-link (Resolved decisions).
- **Gold loan against gold holding:** same pattern (secured loan ↔ gold asset) — works generically.
- **Linking accounts in different currencies:** equity display converts; note the approximation
  (manual current rate, as elsewhere).

## Failure cases
- **Link makes net worth wrong:** defect — the link is presentational only; net worth must be
  identical linked or unlinked.
- **Dangling link** after one side is closed/deleted: must be cleaned up (link removed, other side
  intact); never a reference to a missing account.
- **Equity ≠ value − outstanding:** defect (pure arithmetic, derived).
- **Forced linking blocking account creation:** must not happen — assets and loans are always usable
  unlinked.

## UX considerations
- **Link is opt-in and discoverable, never required** — "link a loan" on a property feels like a
  helpful tidy-up, not a setup chore.
- **Equity shown as the headline for the linked pair** ("₹60L equity") with value and loan as the
  supporting breakdown — the balance-sheet story at a glance.
- **Negative equity shown honestly** (red), no hiding.
- **Generic language** — "linked loan" / "secured against", not property-specific, so car/gold loans
  feel first-class.
- **Don't overbuild** — given this is cosmetic, a simple link + equity line is enough for MVP; richer
  amortisation/interest breakdowns are v2/intelligence.

## Operational considerations
- **Link = a lightweight reference** between two account ids (asset.linked_liability or a small join);
  it carries **no balance** and feeds **no aggregation** — D1/D2/D3 ignore it entirely (they already
  count both accounts).
- **Equity is derived** (asset value − loan outstanding) at display time; never stored.
- **Lifecycle hooks:** closing/deleting either account clears the link (F1 close path aware of it).
- **Offline-capable in desktop mode** (Electron); hosted mode is client↔server (architecture §11).

## Resolved decisions (locked 2026-06-20)
1. **Asset↔liability linking + net-equity display = DEFERRED to post-MVP** (LOCKED). Net worth is
   already correct without it, so MVP ships **no explicit link**. **MVP fallback (confirmed):** a
   property/car asset is a markable holding (S2/S3) and its loan is a standalone **markable
   holding-liability** (S3); both count independently in net worth (D1/D2/D3). The grouped
   "value − loan = equity" view is the only thing deferred. This whole story is the **spec for when
   it's built later** (1:1 link, equity line, generalised to any secured loan↔asset).
2. **Unsecured loans are first-class in MVP WITHOUT any of S4** (LOCKED, explicit): a personal loan
   (or any unsecured loan) is just a standalone markable liability account — mark its outstanding
   (S3), it lives in a Loans section (S1), it subtracts from net worth (D1). No link, no asset
   needed. Secured loans behave identically in MVP (standalone); they merely *gain* the optional
   equity grouping once S4 linking ships post-MVP.
3. **When built (post-MVP):** 1:1 link cardinality first (multi-loan/top-up later); suggest sensible
   pairs (home loan ↔ property) but allow any asset↔liability link; Property needs only an optional
   note/label beyond cost (S2) + marks (S3); rent = ordinary inflow.

> **Net effect for MVP:** S4 contributes **no build work** — it records that net worth is correct via
> standalone accounts and defers the cosmetic equity grouping. Loan modules themselves (secured +
> unsecured) are specified in **S5**.

## Dependencies
- **Depends on:** S2 (asset as markable holding incl. onboarding value/cost), S3 (marking the loan's
  outstanding and the asset's value), F1 (account lifecycle, close clears link), D1 (net worth already
  nets both — the link adds nothing to it), S1 (sections showing the equity grouping).
- **Relates to:** S5 (Property and loan module profiles — captured fields, section shaping).
- **Excludes:** amortisation schedules / interest split (v2), multi-loan-per-asset (later), LTV or
  equity-trend insight (intelligence).

---

### Research sources
- Personal balance sheet — asset at full value + loan at full outstanding; equity = asset − loan; net
  worth nets both: https://www.britannica.com/money/personal-balance-sheet
- Vehicle/car equity = resale value − loan balance (the same pattern, non-property):
  https://www.experian.com/blogs/ask-experian/what-does-it-mean-to-have-equity-in-your-car/
- Kubera — linking a home value to mortgage data to show home equity: https://moneywise.com/investing/reviews/kubera-review ; https://www.wallstreetzen.com/blog/kubera-app-review/
