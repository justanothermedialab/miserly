# S2 — Holding account model (value, cost basis, simple return)

> **Epic:** Per-instrument sections · **Story:** S2 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD + manual valuation only, zero intelligence.

---

## Title
As the user, a holding account (mutual fund, stock, FD, gold, …) shows me its **current value**, what
I've **put in (cost basis)**, and my **simple return** (₹ and %), all derived from the same ledger —
so every investment tells me not just "how much" but "how much I've made", without me maintaining a
spreadsheet of buys and gains.

## ELI5
A bank account just has a balance. An investment has *two* interesting numbers: how much it's worth
now, and how much I actually put into it — the difference is my gain (or loss). This story makes a
holding account track both: money I move in counts as "invested", and when I update its value
(a "mark", S3) the extra counts as return. So my MF can say "₹5,00,000, you put in ₹3,00,000, +₹2,00,000
(+66%)".

## Business context
Holdings are the **wedge**: Actual treats an FD or MF as a dumb balance; Miserly treats it as an
investment with cost basis and return. The plan keeps MVP **manual** (no units×NAV, no price feeds —
that's v2, per the S1 decision), but the data model still yields real returns because of one clean
split:

- **Cost basis = net contributions** = Σ(money transferred **in** from your other accounts) −
  Σ(money transferred **out**). It's the cash you actually committed.
- **Current value = opening + Σ(all transactions)** — the usual derived balance (same single source
  of truth as every account), which additionally moves with **valuation marks** (S3).
- **Return = current value − cost basis** (absolute), and **% = return ÷ cost basis**. This is "total
  return" in the simple sense — anything that grew the value beyond what you put in (market gains,
  reinvested interest/dividends) shows as return ([Robinhood total return](https://robinhood.com/gb/en/support/articles/cost-basis),
  [cost-basis methods](https://www.bogleheads.org/wiki/Cost_basis_methods)).

The key mechanic: a transaction in a holding account is **either** a **contribution/withdrawal** (a
transfer leg from/to another account → moves *both* cost basis and value) **or** a **valuation
mark/adjustment** (non-transfer → moves *value only* = unrealized gain/loss). That single distinction
is what makes cost basis and return correct with zero intelligence.

Cost-basis method = **net-contributions / average** (simplest, SIP-friendly); **FIFO and
realized-gain-on-sale are deferred** (the plan already defers realized gains). Units × NAV and
auto-pricing = **v2** (S1 disclaimer: likely post-MVP revisit).

## User workflow

### Happy path — a growing investment
1. User has a Mutual Funds account. They contribute by **transferring ₹10,000 from their bank**
   (C3 transfer → the MF account): cost basis +₹10,000, value +₹10,000, return unchanged.
2. Months later they **mark** the value to ₹11,500 (S3): value +₹1,500, cost basis unchanged → the
   holding now shows **value ₹11,500, invested ₹10,000, +₹1,500 (+15%)**.

### Happy path — onboard a pre-existing holding
1. Creating a holding account, the user enters **amount invested (cost basis)** and **current value**
   (see Resolved decisions for the exact onboarding shape).
2. The account opens showing the correct invested/value/return from day one (the gap recorded as an
   initial mark), not a misleading 0%.

### Alt path — partial redemption
- User **transfers ₹5,000 out** to their bank (withdrawal): value −₹5,000 and cost basis −₹5,000
  (net-contributions method). Return on the remaining holding continues from there. (Exact realized
  gain on the sold portion is **not** separated in MVP — deferred.)

### Recovery path
- Any contribution/withdrawal is an ordinary transfer (edit/delete via C4, syncing both sides); a
  wrong mark is edited/deleted like any transaction (S3/C4). Value and return recompute.

## Acceptance criteria
- [ ] A holding account shows **current value**, **cost basis (invested)**, and **simple return**
      (absolute ₹ and %), all derived from the ledger.
- [ ] **Cost basis = Σ contributions − Σ withdrawals**, where contributions/withdrawals are
      **transfer legs** into/out of the holding (C3). Valuation marks do **not** change cost basis.
- [ ] **Current value = opening + Σ(all transactions)** (contributions, withdrawals, marks), the same
      derived computation as every account — and it equals the account's contribution to net worth (D1).
- [ ] **Return = value − cost basis**; **% = return ÷ cost basis** (guard cost basis = 0 → show value
      as return / "n/a %").
- [ ] A **pre-existing holding can be onboarded with both invested and current value**, so return is
      correct from creation (gap recorded as an initial mark) — exact UX per Resolved decisions.
- [ ] A **withdrawal** (transfer out) reduces value and cost basis by the withdrawn amount
      (net-contributions method); realized-gain separation is **not** done in MVP.
- [ ] Non-transfer increases in a holding (e.g. credited interest/dividend recorded as an adjustment)
      count toward **value/return**, not cost basis (MVP default — see Resolved decisions).
- [ ] Returns/values respect the app-wide number-format preference; negative returns display honestly.

## Validation rules
- **Holding vs spending:** this model applies to **holding-type** modules; spending accounts (Bank,
  Cards) don't show cost basis/return (their "value" is just balance).
- **Contribution/withdrawal classification:** determined by `transfer_partner_id` (a transfer leg) —
  in = contribution, out = withdrawal. Non-transfer adjustments are marks/gains.
- **Cost basis never negative:** withdrawing more than was contributed (possible after big gains) is
  allowed but cost basis floors at 0 with the excess treated as return — define edge (see Resolved decisions).
- **Currency:** value/cost/return shown in the account's native currency; converted to base only for
  aggregation (D1/D2) — the FX point is centralised, not per-holding.

## Edge cases
- **Cost basis = 0 (never contributed, only a mark — e.g. gifted/legacy asset):** % return is
  undefined; show value and "—%" rather than divide-by-zero.
- **Onboarded holding later fully redeemed:** value → 0, cost basis → 0; account can be closed (F1).
- **A holding that lost money:** value < cost basis → negative return shown honestly (red).
- **Interest/dividend reinvested vs paid out:** reinvested (stays in the holding) = a value increase
  (return); paid out to bank = a transfer out (reduces value, and per net-contributions reduces cost
  basis — approximate; acceptable for MVP). Confirm treatment (Resolved decisions).
- **Withdrawal exceeding cost basis** (sold after large gains): cost basis floors at 0; remaining is
  pure return — note the approximation (no realized/unrealized split in MVP).
- **Opening balance with no separate cost figure:** falls back to cost = value (return starts at 0).

## Failure cases
- **Value ≠ D1 contribution / register balance:** impossible by construction (one derived
  computation); divergence is P0.
- **A mark changing cost basis, or a contribution not changing cost basis:** defect — the
  transfer-vs-mark classification must be the sole, consistent driver.
- **Return that doesn't reconcile** with value − cost basis: defect (return is pure arithmetic, never
  stored).
- **Double-counting a contribution** (e.g. counting both the transfer leg and a separate row): the
  transfer is one linked pair (C3); the holding side is the single contribution.

## UX considerations
- **Three numbers, clearly ranked:** current value (primary), invested + return (secondary), matching
  the holdings convention users know from Ghostfolio/broker apps.
- **Return colour-coded honestly** (green up / red down), absolute + %; no annualisation or
  benchmarking (that's intelligence/v2).
- **"Invested" framing** is friendlier than "cost basis" for a layman; keep the term approachable.
- **Onboarding a holding** should make invested + current value feel natural ("how much have you put
  in?" / "what's it worth now?"), so existing investments show real returns immediately.
- **Manual reminder, not nagging:** value only changes when the user marks it (S3); the holding isn't
  "live". Staleness nudges are intelligence/deferred.
- Consistent with the register/passbook for the activity list within the holding.

## Operational considerations
- **Same transaction engine + derived-balance computation** as every account; the holding model is a
  *view* (value, cost basis, return) computed from the same rows — no separate holding store.
- **Cost basis computation** = sum over transfer-classified rows; return = value − cost basis; both
  derived on read (memoise with invalidation, like balances).
- **Aggregation contract:** the holding exposes `current_value()` and `cost_basis()` (and `cash_flows`)
  exactly as the plan's contract specifies, so D1/D2/D3 consume it without knowing the concrete type.
- **Initial mark on onboarding** reuses the S3 valuation-mark primitive (and the F1 opening primitive)
  — one shared mechanism.
- **Offline-capable in desktop mode** (Electron); hosted mode is client↔server (architecture §11).

## Resolved decisions (locked 2026-06-20)
1. **Onboard a pre-existing holding by capturing BOTH "amount invested" + "current value"** (LOCKED):
   cost basis = invested, value = current, the gap recorded as an initial mark → return is correct
   from day one. If only one is given, cost = value (return 0%).
2. **Show simple return (value / invested / return ₹ & %) in MVP** (LOCKED): it's descriptive
   arithmetic (zero intelligence) and the whole point of the holdings view; negative returns shown
   honestly.
3. **Cost-basis method = net-contributions / average** (LOCKED): simplest, SIP-friendly; **FIFO &
   realized-gain-on-sale deferred to v2**.
4. **Interest/dividend credited into a holding = counts as return** (LOCKED MVP default): a
   non-transfer credit increases value/return; income-classification of investment payouts is a later
   refinement.
5. **Withdrawal reduces cost basis by the withdrawn amount** (LOCKED, floor at 0); proportional cost
   basis / realized-gain separation = v2.

**Amendments (2026-10-05, each chosen from options with their evidence):**

6. **XIRR "since tracking" as a second, labelled column** (value − cost basis stays the locked
   return). Worked out on our data model and checked against the literature before it was decided:
   - **Flows** (money-weighted return, the standard XIRR form): a start flow of minus the holding's
     **value on its opening date** (opening plus any same-day mark, so RD1's initial mark counts as
     value already there, not as return); then each day's **external** flows, taken from the module's
     `cashFlows` asked one day at a time (transfer legs only; marks are not cash flows), grouped by
     day, so a switch between two holdings in the same set nets out; then plus the **value on the date
     of the last mark**. Solved by Newton's method with a bisection fallback.
   - **Label:** "XIRR since <opening date>". The onboarding lump is dated the day tracking started, so
     a lifetime figure would be wrong (a sample file's flexi-cap fund: 24.6% as recorded, 3.0% if the ₹3 lakh was
     really bought in 2021). A user who wants the lifetime figure backdates the opening and records the
     old purchases as transfers (C4).
   - **"—"** when the history is **under one year** (SEBI forbids annualising sub-year returns; a
     pre-existing gain marked two weeks after onboarding would read as 7,954% a year), when there is
     **no mark since opening**, or when the solver finds no root.
   - **Assets only** (by `side` metadata, never by module type); per holding in its own currency; a
     section-level XIRR only when every holding shares one currency (only today's FX rate is kept, so
     old foreign flows can't be converted honestly).
   - **Known gap:** interest paid out to a bank account as income never passes through the holding,
     so a payout FD's XIRR understates its return (as the absolute return does). *Closed
     2026-11-09 (S5 RD10):* a holding whose details say Payout shows its stated rate instead.
   - No contract change, no `if module ===`, no forecast (descriptive arithmetic on recorded flows).
     Sources: White Coat Investor and Wealthfolio (start-value flow),
     mStock and Zerodha Varsity (SEBI's sub-year rule), Sure issue #156, beancount portfolio-returns
     (internal vs external flows), FinanceManager PR #793 (insufficient-data and no-solution states).
7. **Holding value vs invested over time = later**: after the holdings page is
   recomposed; it needs a history view per holding.

**Chart review amendments (2026-11-04, after a review of the charts in finance and investment apps):**

8. **RD6's label is "18.3% a year"** (the approved mock; personas: plain words, no "XIRR"), beside
   the gain on the fund page and the section page, and a **Per year** column in the section's
   table; "Since <opening date>" is its hover title. "—" as RD6 says, with the reason as its title.
   A **section's** figure counts a holding with no value update since it began at its recorded value
   today (as the section's simple return does), each holding weighted by the viewer's share on each
   flow's date. Built.
9. **RD7 is built:** value against money put in, by month end, on each investment section above its
   table (placement A) and on a fund's page behind a Transactions / Chart switch, Transactions the
   default (placement B). Hover a month for Value, Invested
   and Gain.

**The fund rules (2026-11-09, after a review of the app):**

10. **What counts as money put in** (amends RD3 and RD4; F2 RD10). Money moved in or out of a
    holding is every transfer leg plus any plain row whose category's "Counts as return" switch is
    off: EPF's Salary typed inside the EPF is Invested (₹1,07,200 and ₹0 return, not ₹1,00,000 and
    ₹7,200). A payout, a transfer out whose category counts as return (a fund's dividend sent to
    the bank), is a cash flow for the return per year but leaves Invested alone, as no units were
    sold. Interest, Dividends and Balance adjustment count as return; uncategorised rows on a
    holding and value updates stay return, so no existing figure flips. Read through the contract's
    optional `countsAsReturn` flag (architecture §5); no `if module ===`.
11. **Invested after money taken out = the cost of what is still held** (amends RD3 and RD5). A withdrawal from an asset lowers Invested by Invested × withdrawn ÷
    value just before (average cost in money; without units the share of value stands in for the
    share of units, as Ghostfolio's average cost), the ratio at most 1, skipped when the value
    before is ₹0 or less; rows are walked in `(date, sequence)` order. ₹1L in, worth ₹2L, ₹1.5L
    redeemed: Invested ₹25,000 and return ₹25,000 (+100 %), where it read Invested ₹0 and "—%". The
    floor at 0 stays but no longer triggers on an asset. A liability keeps the old sum (its basis
    is never shown). A withdrawal above the recorded value still posts, and the register
    shows "More was taken out than its last recorded value. Update its value first, dated before
    the withdrawal." Realised gain as its own figure and FIFO lots stay Pro.
12. **The value is known at the last row that set it** (amends RD6 and RD8). A holding's value is known at its last value update (a ₹0 one too, S3 RD8) or its last
    positive row of growth typed inside it (interest, a dividend). The return per year ends there on
    the register and on the section alike: an FD with interest typed inside each 31 March reads
    about 7 % a year on both, where it read "—" and 5.3 %. A holding never valued since it began is
    left out of its section's rate, which says so ("Leaves out 1 holding with no value update
    yet"). The register's header says "Last updated 5 months ago" (the exact date on hover),
    amber once older than its profile's months: 3 for funds, stocks and gold, 13 for FD, RD,
    property, other assets and loans (yearly statements). A profile field, never a type check.
13. **A closed holding shows what it earned**. Once closed it holds nothing,
    so its register shows "Earned +₹14,490" (or "Lost −₹1,00,000"): its value plus money taken
    out, minus its opening and money put in. Its return per year ends where its value was last
    known, as an open one's (RD12), so Pay and close months after the last interest row doesn't
    lower it: an FD of ₹1,00,000 with ₹7,000 and ₹7,490 of interest typed inside, paid out and
    closed, reads "Earned +₹14,490, 7.0% a year" (it read ₹0 and "—%"). It ends at the close
    instead when a loss or adjustment comes after (a write-off: "—", no money ever came out) or
    when it never had a value row (a fund bought and sold: its rate from the money alone).
14. **A change of share counts as money moved** (amends RD6 for a shared holding;
    2026-11-09, after a review of the app). A section's return per year at the viewer's share weights
    every flow by the share on its date, and now also counts each change of the viewer's share
    (a split's From, a holder joining or leaving, H2 RD8 and RD9) as money moved at the holding's
    value that day (the end of the day before, as a share applies from its date): a share that falls
    is money taken out, one that rises money put in. A fund growing 18.9 % a year that Alice shares
    half of with Bob reads 18.9 % for both (it read about 0 % for Alice and "—" for Bob). A member who
    joined after the holding began is measured from their own first flow, so under a year reads "—".
    The register's own figure (the holding in full) is unchanged. Property test: a steadily growing
    fund reads its own rate for both holders whatever day it is shared
    (`test/holder-stretches.property.test.ts`). Why: XIRR counts every flow into and out of the
    investor's position; a share handed over is one (partnership accounting values it at that day's
    worth).
15. **A member who joined later reads the holding from the day they joined** (2026-11-12,
    after a security read and a read of the money logic; amends RD14's "the register's own figure is unchanged" for that member; H2 RD11).
    Their register header's Invested is the value at the end of
    the day before they joined plus what was put in since; the return, the yearly rate and "tracked
    since" run from that day; the section row is their part of it; the chart's Invested line starts
    at that day's value. The owner's figures are unchanged. A shared fund's header, row and section
    headline now read the same rate for the later member (18.9 % in the reported case, where the
    header read the fund's whole 26.0 %).

## Dependencies
- **Depends on:** F1 (account creation incl. holding onboarding; opening primitive), C1 (transactions
  + derived balance + ordering), C3 (transfers = contributions/withdrawals), S1 (holding section that
  displays this), S3 (valuation mark — the value-only adjustment), the aggregation contract.
- **Feeds:** D1/D2/D3 (current value + cost basis via the contract), S4 (Property reuses value but adds
  a linked loan), S5 (per-module specifics on top of this baseline).
- **Excludes:** units × NAV / auto-pricing (v2; S1 disclaimer), FIFO & realized-gain-on-sale (v2),
  annualised/benchmarked returns (intelligence), dividend income modelling (later).

---

### Research sources
- Ghostfolio — holding metrics (quantity, avg buy price, current value, change = (market − avg)×qty),
  % return = (current − avg value)/avg value: https://github.com/ghostfolio/ghostfolio/issues/554 ; https://github.com/ghostfolio/ghostfolio/issues/3502
- Robinhood — total return = (market − average cost) × shares; average cost as cost of current
  position: https://robinhood.com/gb/en/support/articles/cost-basis
- Cost-basis methods (average cost = simple, SIP/reinvestment-friendly; FIFO = tax-precise default):
  https://www.bogleheads.org/wiki/Cost_basis_methods ; https://corporatefinanceinstitute.com/resources/wealth-management/average-cost-basis/
- Kubera — manual "type the current value" updates for assets without feeds (our mark model): https://moneywise.com/investing/reviews/kubera-review
