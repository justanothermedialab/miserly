# MC2 — Cross-currency transfer

> **Epic:** Multi-currency · **Story:** MC2 · **Status:** LOCKED (2026-06-21)
> **MVP scope:** CRUD + manual valuation only, zero intelligence.

---

## Title
As the user, I can move money between two accounts in **different currencies** (sell USD from my US
brokerage, ₹ lands in my Indian bank) by recording **what left in dollars and what arrived in rupees**,
entering **either the exchange rate or the received amount** (the other auto-computes) — so both
accounts stay correct in their own money and the transfer is one linked pair, not two stray entries.

## ELI5
A normal transfer moves ₹1,000 out of A and ₹1,000 into B — same number both sides. But if A is in
dollars and B is in rupees, the two sides *aren't* the same number: $100 leaves, ₹8,200 arrives. So
Miserly asks for both amounts — or I type one plus the rate and it fills the other. It's still one
transfer (two linked rows), just with two different-currency amounts instead of one.

## Business context
This **unblocks the C3 stub** (C3 locked same-currency transfers only and showed different-currency
pairs as "coming with multi-currency"). It's the persona's real workflow: an Indian engineer
**repatriating USD RSU proceeds** to an INR bank, or funding a USD brokerage from INR.

This story owns the **transaction-linkage rate** — rule (a) in the plan, kept **deliberately distinct**
from MC1's **aggregation rate** (rule (b)). They answer different questions:
- **Linkage rate (here):** the *actual* rate of *this* transfer — "$100 became ₹8,200 ⇒ 1 USD = ₹82".
  It's a fact about one transaction, frozen on the row forever.
- **Aggregation rate (MC1):** the *current* mark used to value a *standing balance* in base for net
  worth. It changes over time and is not tied to any transaction.

The interaction-model is the proven GnuCash one: the Transfer dialog offers **"Exchange Rate" OR "To
Amount"** as a radio pair — enter one, the app computes the other
([GnuCash transfer dialog](https://www.gnucash.org/docs/v3/C/gnucash-help/trans-win-enter.html)).
Firefly requires the **amount in both currencies** for such a transfer
([Firefly currencies](https://docs.firefly-iii.org/tutorials/finances/currencies/)). We adopt both:
two native legs, coupled by "enter rate **or** to-amount". (An earlier prototype's `TransferCreate` already carries
`to_amount` + `exchange_rate` — reference for the shape.)

**The one genuine subtlety (researched):** a cross-currency transfer's two legs **do not net to zero in
base currency** unless the linkage rate equals the standing aggregation rate. If today's USD mark is
₹83 but you actually got ₹82, then in base terms ₹83,000 of value left and ₹82,000 arrived — a **₹1,000
realized FX effect**. This is real money (the spread/rate you actually transacted at), not a bug.
Beancount routes this through `Equity:Conversions`; GnuCash through Trading Accounts
([beancount FX](https://beancount.io/blog/2026/05/03/foreign-exchange-gain-loss-multi-currency-accounting-small-business-guide)).
We don't need a special equity account — the effect appears naturally and **honestly** as a small
net-worth movement, and is also a useful signal that the standing mark is stale. (See Resolved decisions for how
loudly to surface it.)

## User workflow

### Happy path — repatriate USD → INR
1. From the USD brokerage register (or the explicit "+ Transfer" form, C3 paths), the user picks
   **To = INR bank account**. The dialog detects **different currencies** and reveals the FX row.
2. They enter **amount out = $100** (native to source). Then **either**: type **rate 82** → "to amount"
   fills **₹8,200**, **or** type **to amount ₹8,200** → rate fills **82**.
3. Save → **two linked rows**: source **−$100 (USD)**, destination **+₹8,200 (INR)**, joined by
   `transfer_partner_id`, each carrying the shared linkage rate; excluded from spending (as all
   transfers, C3).

### Happy path — fund USD brokerage from INR (reverse)
- Out = ₹8,300 from bank; rate/“to amount” yields **+$100** into the USD account. Same machinery,
  direction reversed.

### Alt path — rate pre-filled from the standing mark
- If MC1 already has a USD→INR aggregation rate, the dialog **pre-fills** the linkage rate with it as a
  convenience; the user overrides with the **actual** rate they got. (Pre-fill is a starting point, not
  a constraint — the two rates stay independent.)

### Recovery path — edit / delete
- A cross-currency transfer is edited/deleted like any transfer (C4 carries transfer edit/convert/
  re-point/delete-both): **correcting either amount keeps the other leg's amount and re-derives the
  linkage rate** from the two (RD4); deleting removes **both** legs; undo applies. Back-dating recomputes balances on both sides (C1/C4 ordering).

## Acceptance criteria
- [ ] A transfer between accounts of **different currencies** is allowed (unblocks the C3 stub) and
      produces **two linked native-currency rows** (`transfer_partner_id`), one per account.
- [ ] The dialog captures **amount-out (source native)** plus **either the exchange rate or the
      to-amount (destination native)**; entering one **auto-computes** the other; both are shown.
- [ ] The **linkage rate is stored on the transfer** (frozen, per-transaction) and is **independent of**
      the MC1 aggregation rate (a transfer never changes the standing mark, and vice-versa).
- [ ] Each account's **native balance** updates by its own native leg amount (source −out, dest +to).
- [ ] The transfer is **excluded from spending/income** analytics (consistent with C3).
- [ ] **Base-currency net worth is value-neutral *at the linkage rate*** for the transfer itself; any
      residual net-worth movement equals the **spread between the linkage rate and the standing
      aggregation rate** applied to the remaining foreign balance — shown **honestly**, never hidden or
      forced to zero (it's a realized FX effect / stale-mark signal).
- [ ] The linkage rate may be **pre-filled** from the MC1 standing rate (if any) as a default the user
      can override.
- [ ] Edit/delete/back-date behave per C4 (correcting one amount keeps the other and re-derives the
      rate on both legs, RD4; delete removes both; correct recompute under back-dating); undo
      supported.
- [ ] All amounts respect the app-wide number-format preference, each shown in its **own** currency.

## Validation rules
- **Two currencies, two amounts:** when source and destination currencies differ, **both** native
  amounts are required (directly or via rate); same-currency transfers stay on the C3 single-amount
  path (no FX row).
- **Coupling math:** `to_amount = amount_out × rate` with `rate` = destination-per-1-source; entering
  `to_amount` instead derives `rate = to_amount ÷ amount_out`. Exactly one of {rate, to_amount} is
  user-entered; the other is computed (GnuCash radio model).
- **Positivity:** amount-out > 0, to-amount > 0, rate > 0.
- **Both legs same date & link:** the pair shares date and `transfer_partner_id`; back-dating moves both.
- **No category:** transfers are categoryless (C3/F2); the FX legs inherit that.
- **Currencies come from the accounts** (MC1, immutable per account); the transfer never redefines an
  account's currency.

## Edge cases
- **Linkage rate = standing aggregation rate:** the base-currency gap is zero — behaves just like a
  same-currency transfer (the clean case).
- **No standing aggregation rate yet for the foreign currency:** the transfer still records fine (it
  carries its own linkage rate); but base totals that include the *remaining* foreign balance still
  show MC1's "rate needed" until a mark is set — the transfer does **not** auto-set it (rates stay
  distinct).
- **Both accounts foreign, neither in base** (e.g. USD → EUR): allowed; two native legs + linkage rate
  between them; base conversion of each side uses each currency's MC1 aggregation rate.
- **Round-tripping** (USD→INR then INR→USD at different rates): each transfer honest at its own rate;
  the net effect may show a small realized FX gain/loss — correct.
- **Fees/spread embedded in the rate:** the user simply enters the *effective* rate or the *actual*
  received amount; the spread is captured implicitly (no separate fee field in MVP).
- **Tiny rounding** on the computed side: round to the destination currency's display precision; the
  stored leg amount is the source of truth (no recomputation drift).

## Failure cases
- **Forcing base-neutrality by fudging a leg** (e.g. silently rewriting the to-amount so legs net to
  zero in base): defect — it would corrupt a real native balance; the FX effect must be shown, not
  hidden.
- **Mutating the MC1 aggregation rate from a transfer** (or vice-versa): defect — the two rates are
  independent by design.
- **One leg saved without the other** (orphaned half-transfer): defect — both legs are atomic (C3).
- **Treating a different-currency transfer as same-currency** (one amount, implicit 1:1): defect — must
  require the second amount/rate (the Firefly rate=1 trap, again).
- **Spending analytics counting an FX leg:** defect — transfers excluded (C3/F2).
- **Back-dated cross-currency edit breaking one side's running balance:** defect — both sides recompute
  by `(date, sequence)` (C1/C4).

## UX considerations
- **Reveal FX only when needed:** the second-amount/rate row appears **only** when the two accounts'
  currencies differ — same-currency transfers stay as simple as C3.
- **Show both real amounts plainly** ("−$100" / "+₹8,200"), each in its own currency — never collapse to
  one number; users must trust both native balances.
- **"Rate or received amount, your choice":** mirror GnuCash's two-way entry; pre-fill the rate from the
  standing mark as a hint, but make clear the user should enter what **actually** happened.
- **Don't lecture about FX gain/loss:** if a small net-worth wobble results from the rate spread, a quiet
  factual note (optional) is enough — no accounting jargon, no advice (that's intelligence). See Resolved decisions.
- **Consistent with C3's two paths** (inline payee-as-account + explicit From→To) and C4 editing.

## Operational considerations
- **Reuses the C3 transfer engine** (two linked rows, `transfer_partner_id`, atomic create/edit/delete,
  spending-exclusion) — MC2 adds only the **second native amount + linkage rate** when currencies differ.
  One shared transfer service (the C1–C4 shared-service discipline) — no separate cross-currency path
  that could drift.
- **Stored on the pair:** each leg's native `amount` + `currency`; the shared `exchange_rate`
  (linkage) and/or `to_amount` (mirrors an earlier prototype's `TransferCreate`). No base-currency amount stored —
  base is always derived via MC1's `to_base` at read time.
- **Net-worth math is unchanged structurally:** D1 sums each account's native balance → base via MC1.
  The cross-currency transfer's base effect emerges from that same single path (no special-casing in
  aggregation) — the realized-FX wobble is a *consequence* of honest derivation, not extra code.
- **No `Equity:Conversions`/Trading-Account machinery in MVP:** unlike beancount/GnuCash we don't post a
  balancing FX account; we surface the effect as a derived net-worth delta. (A formal realized-FX
  ledger account = possible v2 if needed for reporting.)
- **Offline in desktop mode** (manual rate; no internet needed); hosted mode is client↔server.

## Resolved decisions (locked 2026-06-21)
1. **Realized-FX effect = SILENT & HONEST in MVP** (LOCKED, option a): when the linkage rate ≠ the
   standing aggregation rate, the resulting small net-worth movement simply appears in the derived
   totals — no callout, no special handling. It's real money (the spread actually transacted) and falls
   out of honest derivation. **Deferred (v2):** (b) a **quiet factual note** on the transfer ("recorded
   at ₹82; your USD mark is ₹83") as a gentle stale-mark hint; (c) a formal **realized-FX ledger line /
   Trading-Account** treatment (beancount `Equity:Conversions` style) for explicit FX gain/loss
   reporting.
2. **Pre-fill the linkage rate from the MC1 standing mark = YES** (LOCKED): the dialog seeds the rate
   with the current aggregation rate (if any) as a convenience default; the user overrides with the
   **actual** rate they got. The two rates remain independent — pre-fill is a starting hint only.
3. **No auto-prompt to update the MC1 standing mark after a transfer** (LOCKED): a transfer never offers
   to change the standing aggregation rate (keeps the linkage and aggregation rates cleanly independent;
   rate management lives in MC3).
4. **Correcting an amount keeps the other and re-derives the rate** (2026-10-16,
   decided after comparing how other apps store such transfers). Both amounts are facts from two
   statements (the USD that left, the INR that arrived); the rate is the consequence. So correcting
   either leg's amount keeps the other leg's amount and re-derives the stored linkage rate (received
   ÷ sent, 6 places, 10 below 1) on both legs; the row's rate label shows the new one. Same-currency
   transfers still mirror (C3). Why: every app found that holds two currencies in one transfer stores
   both amounts and never re-derives the other side at an old rate (Quicken: "you can change one end
   of the transfer without making the corresponding change at the other end"; MMEX, Firefly III,
   Sure), and it keeps the other account's balance matching its statement, which a wrong rate
   re-derivation broke (found in a review of the app).

## Dependencies
- **Depends on:** C3 (transfer model + both entry paths + spending-exclusion — MC2 is its
  cross-currency extension), MC1 (per-account currency + the aggregation rate used to value standing
  balances), C4 (edit/delete/back-date/undo of transfers), C1 (`(date, sequence)` ordering & derived
  balance).
- **Feeds:** MC3 (display of the two native legs + any FX note; rate management), D1/D3 (the realized-FX
  effect flows through net worth & history via MC1's `to_base`).
- **Relates to:** the future cross-currency **holding contribution** (asymmetric SIP→foreign fund) =
  MC2 × instruments, **deferred** (the plan scopes Capture/MC to symmetric ledger↔ledger transfers).
- **Excludes:** auto/historical FX (v2); a formal realized-FX ledger account / Trading Accounts (v2);
  per-transfer fee fields (spread folded into the effective rate in MVP); cross-currency contributions
  into holding modules (later).

---

### Research sources
- GnuCash — Transfer Funds dialog "Currency Transfer" pane: radio group **Exchange Rate vs To Amount**,
  enter one and it computes the other; optional Fetch Rate:
  https://www.gnucash.org/docs/v3/C/gnucash-help/trans-win-enter.html ;
  https://www.gnucash.org/docs/v3/C/gnucash-help/trans-currency-enter.html
- Firefly III — a transfer between different-currency accounts requires the amount **in both
  currencies**; only enabled currencies selectable:
  https://docs.firefly-iii.org/tutorials/finances/currencies/ ;
  https://github.com/firefly-iii/firefly-iii/issues/2291
- beancount — cross-currency entries don't balance without a conversion sink (`Equity:Conversions`);
  realized vs unrealized FX gain/loss is the core distinction (we surface the realized effect via
  derived net worth, no equity account in MVP):
  https://beancount.io/blog/2026/05/03/foreign-exchange-gain-loss-multi-currency-accounting-small-business-guide
- Ghostfolio — per-activity rate vs current-rate performance pitfalls; suggestion to pre-fill today's
  rate as an editable default on a foreign activity (our pre-fill idea):
  https://github.com/ghostfolio/ghostfolio/discussions/3141 ;
  https://github.com/ghostfolio/ghostfolio/issues/3140
