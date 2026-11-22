# S5 — Instrument profiles (per-module MVP definitions)

> **Epic:** Per-instrument sections · **Story:** S5 · **Status:** LOCKED (2026-06-20)
> **MVP scope:** CRUD + manual valuation only, zero intelligence.

---

## Title
As the user, each instrument type (Bank, Credit Card, Mutual Funds, Stocks, FD, RD, PPF, EPF,
Property, Gold, Loans, …) behaves like *itself* — the right metadata, the right captured fields, the
right section shaping — even though in MVP they all share one transaction engine and manual valuation,
so the app clearly "knows what each thing is" without me hand-maintaining a spreadsheet of rules.

## ELI5
A mutual fund, an FD, and a home loan are different beasts. This story is the catalogue that says, for
each one: is it an asset or a debt? liquid or locked? do I track its value with marks? what extra
details does it show (maturity date, interest rate, the ₹1.5L PPF cap)? In MVP none of those details
*do* anything clever — they're just shown — but having them is what makes Miserly feel instrument-aware
instead of one big bucket of accounts (which is exactly Actual's weakness).

## Business context
This story operationalises the **per-instrument-module architecture** for MVP. The plan's promise:
each instrument is its own module, but they share a transaction engine + valuation-mark + aggregation
contract, so a new instrument is "a few new files" as long as aggregation never branches on concrete
type. S5 defines, **per module**, the thin profile that sits on top of S2 (holding model) / S3 (marks)
/ C1–C4 (ledger) / S1 (section):

- **Metadata:** side (Asset/Liability), liquidity (Liquid/Semi/Illiquid), spending-vs-holding,
  cardinality (collection vs ≤1-active), markable?
- **Captured fields:** what F1 collects at creation + any **informational** instrument fields.
- **Section shaping:** spending register vs holding view (S1/S2).

**The defining MVP rule:** instrument-specific fields (maturity date, interest rate, contribution cap,
lock-in) are **displayed only — never computed on**. There is **no auto-accrual, no units×NAV, no
price/NAV lookup, no maturity alerts** in MVP; valuation is uniformly **manual marks** (S3). Those
engines are **v2** (the plan's per-module auto-valuation layer), and they slot in without changing the
aggregation contract. (The exact India valuation/tax math for each — PPF 7.1%, EPF 8.25%, FD/RD
quarterly compounding, SGB ~2.5%, etc. — is already captured in the plan's "India instrument rules"
and is the v2 reference, not MVP behaviour.)

## v1 module profiles (MVP)

| Module | Side | Liquidity | Class | Markable? | Cardinality | Captured at creation (MVP) | Informational fields (display-only) | Deferred to v2 |
|---|---|---|---|---|---|---|---|---|
| **Bank** (Savings/Checking) | Asset | Liquid | Spending | No (real cash) | collection | name, currency, opening balance | — | — |
| **Credit Card** | Liability | Liquid | Spending | No (real cash) | collection | name, currency, opening outstanding | credit limit (optional) | billing cycle, statement, min-due |
| **Mutual Funds** | Asset | Semi-liquid | Holding | Yes | collection | name, currency, invested + current value | fund name/folio (note) | units × NAV, NAV lookup, SIP automation |
| **Stocks/Brokerage** | Asset | Semi-liquid (RD9) | Holding | Yes | collection | name, currency, invested + current value | ticker (note) | units × price, price lookup, dividends |
| **Fixed Deposit (FD)** | Asset | Semi-liquid | Holding | Yes | collection | name, currency, principal (invested) + current value | interest rate, maturity date, cumulative/payout | interest accrual, maturity auto-value, TDS |
| **Recurring Deposit (RD)** | Asset | Semi-liquid | Holding | Yes | collection | name, currency, invested + current value | monthly installment, rate, maturity date | installment accrual, maturity auto-value |
| **PPF** *(v2 — deferred)* | Asset | Illiquid | Holding | Yes | **≤1 active (soft-warn)** | name, current value | ₹1.5L/yr cap, 15y lock-in, rate (7.1%) | annual interest accrual, cap enforcement |
| **EPF** *(v2 — deferred; EPS = sub-component)* | Asset | Illiquid | Holding | Yes | **≤1 active (soft-warn)** | name, current value | rate (8.25%), UAN (note) | EPS split, contribution/interest accrual |
| **Property** | Asset | Illiquid | Holding | Yes | collection | purchase cost (invested) + current value | address/note | linked loan → equity (S4, post-MVP), rent modelling |
| **Gold** | Asset | Semi-liquid | Holding | Yes | collection | invested + current value | sub-type (ETF/digital/physical/SGB), SGB maturity | live 24K price, SGB ~2.5% interest auto |
| **Loans** (home/car/personal/gold-loan/LAS) | Liability | Illiquid/Semi | Holding | Yes (mark **outstanding**) | collection | name, current outstanding | original principal, rate, secured-vs-unsecured, linked asset (S4, post-MVP) | amortisation, interest split |

Notes: **NPS** fits the market-linked-holding profile (like MF) and is a trivial add — include or defer
per Resolved decisions. **Cash** is intentionally **not** a module (only an "ATM Withdrawal" category, per Capture).

## User workflow
- **Adding any instrument** uses F1's create flow, shaped by the module's profile (e.g. FD asks for
  maturity date; PPF soft-warns a 2nd active; a holding asks invested + current value per S2).
- **Using it** = the section (S1) + register/holding view (S2) + marks (S3) + ledger ops (C1–C4),
  uniform across modules; the profile just decides which fields/labels/section shape appear.
- **Informational fields** show on the account (e.g. "matures 12 Mar 2027", "rate 7.1%") but trigger
  no computation or alert in MVP.

## Acceptance criteria
- [ ] Each v1 module exists with the **metadata** in the table (side, liquidity, spending/holding,
      cardinality, markable) — consumed by F1 (creation), S1 (section), D1/D2 (aggregation/bucketing).
- [ ] Each module collects its **MVP captured fields** at creation; holding modules collect
      **invested + current value** (S2 onboarding); Loans collect **current outstanding**.
- [ ] **Informational fields** (maturity, rate, cap, sub-type, etc.) are stored and **displayed**, and
      explicitly **drive no computation, valuation, or alert** in MVP.
- [ ] **(v2 — deferred 2026-06-21)** PPF & EPF (≤1-active soft-warn, singleton sections) ship in v2,
      not MVP; `cardinality` stays a registry dimension. Track as Illiquid **Other-asset** meanwhile.
- [ ] **Credit Card** and **Loans** behave as **liabilities** (correct sign in net worth, register
      wording); Loans are **markable to outstanding** (S3); Credit Card is **not** markable
      (reconciled by real transactions).
- [ ] **Secured and unsecured loans** are both supported as standalone liability accounts (S4 link
      deferred); secured-vs-unsecured is an informational field.
- [ ] Adding a **new instrument type** is a **new module profile** (few files) with **no change to the
      aggregation contract** (the plan's modularity guarantee).
- [ ] All valuation is **manual marks** (S3); **no** auto-accrual / units×NAV / price lookup / maturity
      alerts anywhere in MVP.

## Validation rules
- **Module metadata is fixed by the module** (not user-editable — F1: type immutable in MVP).
- **Captured fields** follow each module's profile; holding onboarding requires at least current value
  (invested optional, defaults to value → 0% return) per S2.
- **Informational fields are optional** and validated lightly (e.g. maturity date is a valid date if
  given); they never block.
- **Markable rule** (S3) applies per the table; non-markable modules (Bank, Credit Card) reject marks.
- **Cardinality** (PPF/EPF ≤1 active) enforced via F1 soft-warn.

## Edge cases
- **An instrument the user wants that isn't a module yet** (e.g. crypto, ESOPs, art): not in v1; the
  architecture allows adding it as a new profile later. In MVP the user could approximate with the
  closest holding module (e.g. a generic "Other asset") — decide whether to ship a generic
  catch-all holding module (Resolved decisions).
- **FD/RD past maturity:** in MVP nothing auto-happens; the user marks/moves the matured value
  manually (v2 auto-matures).
- **PPF/EPF over the contribution cap:** not enforced in MVP (cap is informational); the soft-warn is
  only on a 2nd active account.
- **Gold sub-types:** all manual marks in MVP regardless of sub-type; SGB interest/maturity are
  informational (the ~2.5% interest is recorded by the user as a credit = return, S2).
- **Loan with no movement, only accruing interest:** the user marks the outstanding (S3) to keep it
  honest; payments are transfers from bank (C3).

## Failure cases
- **Aggregation branching on concrete type:** forbidden — D1/D2/D3 must read only the contract
  (`current_value`/`cost_basis`/metadata); any `if module == 'FD'` in aggregation is a defect and
  breaks the modularity guarantee.
- **An informational field silently driving a number** (e.g. FD rate auto-accruing): defect in MVP —
  those are display-only until v2.
- **A liability module counted as an asset** (sign error) in net worth: P0.
- **Markable rule mismatch** (a bank account accepting a mark, or a holding refusing one): defect.

## UX considerations
- **Each section feels native to its instrument** — an FD shows maturity & rate; a property shows
  value & (later) equity; a loan shows outstanding; an MF shows value/invested/return — the
  "knows what it is" feeling that beats a generic ledger.
- **Informational fields are clearly passive** in MVP — shown as facts, not as live/auto figures, so
  the user isn't misled into thinking the FD is auto-accruing.
- **Add-account discovery (S1)** presents these modules with friendly descriptions — the India-native
  set (PPF/EPF/FD/RD/SGB/Loans) is the showcase.
- **Consistent labels** — "invested / current value / return" across holdings; "outstanding" for
  loans; familiar from S2/S3.
- Respects the app-wide number-format preference.

## Operational considerations
- **Module registry** (introduced in S1) holds each profile: metadata + captured-field schema +
  section-shape + informational fields. One declarative place; the rest of the app reads it.
- **Thin profiles over shared mechanics** — S2 (holding), S3 (mark), C1–C4 (ledger), F1 (lifecycle)
  do the work; a module profile is mostly declaration + a section view.
- **v2 valuation engines** attach per module behind the same `current_value()` contract (accrual for
  PPF/EPF/FD/RD; units×NAV + price lookup for MF/Stocks/Gold/NPS) — no change to consumers.
- **India math reference** lives in the plan; not implemented in MVP.
- **Offline-capable in desktop mode** (Electron); hosted mode is client↔server (architecture §11).

## Resolved decisions (locked 2026-06-20)
1. **NPS is IN v1** (LOCKED): added as a market-linked holding profile (same shape as Mutual Funds —
   invested + current value, manual marks); common for the persona, trivial to include.
2. **Generic "Other asset" & "Other liability" catch-all holding modules are IN** (LOCKED, markable):
   so users can track anything without a dedicated profile yet (crypto, ESOPs, art, misc) instead of
   being blocked. Cheap; prevents "I can't track X".
3. **Informational fields are display-only in MVP** (LOCKED): no accrual, no alerts, no cap
   enforcement; the per-module valuation/accrual engines (India math) are v2.
4. **Gold = one module + a sub-type field** (ETF/digital/physical/SGB) (LOCKED; **SGB moved to its own type by RD13, 2026-11-10**), all manual marks in
   MVP; SGB interest/maturity informational.
5. **Credit Card statement/billing (cycle, min-due, statement balance) = deferred** (LOCKED): MVP is a
   plain liability ledger.
6. **PPF, EPF, NPS deferred to v2 → v1 = 11 modules** (LOCKED 2026-06-21; **PPF undeferred by RD13 and EPF with its EPS by RD16, 2026-11-05; NPS undeferred by RD17, 2026-11-18**): in MVP they are merely
   Illiquid manual-mark holdings — no marginal value over the **Other-asset** catch-all, but they carry
   singleton machinery + the EPS split. Track them meanwhile as Illiquid Other-asset (net worth still
   counts them; **`liquidity = Illiquid` *is* "counts but not accessible yet"**). **EPS = a
   sub-component of EPF** (EPS cannot exist without EPF; EPF can exist without EPS) — modelled *inside*
   the EPF module when built, never a separate top-level module. **Modularity limit noted:** the
   aggregation contract assumes every account has `current_value`, so **value-less instruments (term
   insurance, warranties) are out of the account model** (they're premium *expenses* + a future
   non-account "policy tracker"); ULIP / endowment insurance / crypto fit as markable holdings. This
   **supersedes** decision 1's inclusion of NPS and the PPF/EPF rows in the table above (kept as the v2
   spec).

**Amendments (2026-10-05, each chosen from options with their evidence):**

7. **XIRR is profile-agnostic** (defined in S2 RD6): every asset-side holding profile gets it
   from the shared computation over the contract; no profile adds code for it. Loans and Other
   liability show none (liability side).

**Amendment (2026-10-21; a check of the acceptance criteria found the "displayed" half of the
informational-fields criterion never built):**

8. **Informational fields: optional, shown only when filled, editable later.** They stay optional
   in Add account ("Details (optional)"; a blank one isn't stored). The account's page shows the
   filled ones on one line under its name, by their plain labels ("Interest rate 7.1 %, Maturity
   date 14 Mar 2027"), never internal keys; with none filled, nothing shows (no heading, no empty
   label). Edit account carries the same fields to add, change or clear one. Still display-only
   (RD3). *Why:* "some people might like it, but also keep it optional." **Built 2026-11-05**
   (forgotten-work sweep; it was due earlier and missed): the line sits at the top of the
   account's page (its name is in the title bar's path), labels without their unit ("Interest rate
   7.1%"), amounts in the account's currency, dates written out; a select can be set back to None.

**Amendment (2026-11-05, from the research for the launch list):**

9. **Stocks are Semi-liquid, not cash.** "how are stocks available now? i cant buy a can of pepsi
   with stocks". Shares must be sold and settled before the money can be spent, so Stocks sit with
   Mutual funds in the Semi band; "available now" (D2's By availability, the Dashboard's assets bar)
   is the bank balances. Module metadata only (`stocks.ts`), no contract change.

**The fund rules (2026-11-09, after a review of the app):**

10. **A paid-out FD shows its stated rate** (amends RD3's "display-only" for one read). Interest paid out is typed where it lands (the bank, as Interest), so the FD itself never
    moves and measured +₹0 (0.0 %). A holding whose details say Payout shows "7.1% a year, paid out"
    from its Interest rate field in place of the measured return, on its register and its section
    row; the section's rate leaves it out and says so ("1 paid out, at its own rate"). The interest
    counts once, at the bank. A profile declares it (`paidOut`: which field, which value, which
    rate field; FD only today), so nothing checks a type. SGB's 2.5 % is not covered (its return is
    gold's price), and a cumulative FD still measures its return from the interest typed inside.
11. **Stale after 3 or 13 months** (S2 RD12): each holding profile carries `staleAfterMonths`,
    3 for Mutual funds, Stocks and Gold, 13 for FD, RD, Property, Other asset, Loans and Other
    liability; "Last updated" turns amber past it. *Amended 2026-11-09:* a
    holding paid out under RD10 never turns amber: its interest leaves, so its
    value is its principal and can't go stale.
12. **A choice in the details line shows its value alone** (2026-11-09). RD8's line
    read "Interest rate 7.1%, Payout Payout": a choice field's value names itself, so it reads
    "Interest rate 7.1%, Payout" (likewise "Secured", "SGB"); typed values keep their label.
13. **PPF and Sovereign Gold Bond are their own types** (2026-11-05, the launch list; built
    2026-11-10; amends RD4 and RD6). PPF: Deposits,
    Illiquid, markable, its deposits transfers from a bank, the passbook balance by Update value,
    "Opened on" its one detail, stale after 13 months. Sovereign Gold Bond: Investments, Semi-liquid,
    markable, details Grams, Issue date, Issue price a gram, Price you paid a gram, stale after 3
    months; its 2.5 % interest is paid into a bank (RBI) and typed there, never on the bond. Both
    are new core modules over the shared holding rule: no contract change, no migration. Gold keeps
    "SGB" only for accounts already made that way. Each is its own slice in Allocation (D2 RD9).
14. **Figures worked out from what was typed, labelled** (2026-11-10; amends RD3 for
    these reads; the data hard line allows values computed from typed inputs). A profile declares
    them; the details line shows each with a tooltip saying how: PPF "Matures" (1 April, 15 years
    after the end of the financial year it opened in: opened June 2019, matures 1 Apr 2035) and
    "Deposited this year" (money moved in by transfer since 1 April) of ₹1,50,000; SGB "Matures"
    (8 years after issue) and "Early exit from" (the 5th anniversary). Never an interest amount.
    **Amended (2026-11-11, after a read of the money logic):** "Deposited this year" counts the rows
    Invested counts since 1 April, not transfers only: a transfer in (unless its category counts as
    return) and a plain row whose category doesn't count as return (an imported deposit under
    Investments, Other; one typed under such a category). Interest under a category that counts as
    return, and an uncategorised row (growth), are not deposits. The tooltip now reads "Money put in
    since 1 April (the rows Invested counts), of the yearly limit".
15. **Home loan by name** (2026-11-05; built 2026-11-10). Add account lists "Home loan"
    and "Other loan", both the Loan module; Home loan presets a new Kind detail (Home, Car,
    Personal, Education, Gold, Other loan), shown on the details line. The Loans section, net worth
    and allocation are unchanged.
16. **EPF with its EPS** (2026-11-05: EPS "is still your money, even if inaccessible till
    retirement", counted at what was paid in, Illiquid, the EPS tab; built 2026-11-10;
    amends RD6). EPF: Deposits, Illiquid, markable; contributions are income rows from the employer
    under Salary, which C3 counts as money put in; Employer its one detail; any number of EPF
    accounts (one per past employer is normal, so RD6's "at most one active" is dropped). Its EPS
    is its own account of type `eps`, made with it in Add account ("EPS paid in so far"), named
    "EPS of" + the EPF's name and linked by `parent_account_id` (migration 0014): Illiquid, NOT
    markable (EPFO shows no balance for it), its rows Salary, so value = Invested = paid in and it
    earns nothing. It is never listed or made on its own: it sits in the EPF's section right after
    it, its return as dashes, left out of the section's rate; the two pages share EPF | EPS |
    Chart tabs. It is shared, unshared, renamed and reopened with its EPF; the EPF closes only once
    its EPS holds nothing ("Close that first, on its tab"), then both close. Both new core modules
    use the shared holding rule; no contract change.
17. **NPS, Tier I and Tier II as separate accounts** (2026-11-18: in the first release;
    2026-11-19: separate accounts, after research found Tier II has no lock-in; amends
    RD6). Two types, two core modules on the shared holding rule, no
    contract or schema change: `nps`, "NPS Tier I", Illiquid (locked until 60, or 15 years for
    non-government subscribers), and `npsTier2`, "NPS Tier II", Semi (no lock-in, a withdrawal
    reaches the bank in about 3 days, as a fund's does), so the dashboard's By availability counts
    Tier II as available soon. Both markable: the value is typed from the CRA statement (Protean,
    KFintech or CAMS; units × NAV across the schemes). Both are listed in Add account and the Actual
    import's Add as; Tier II is added only by someone who has one, never made with Tier I (unlike an
    EPS). Both sit in one NPS section (Tier II shows in it, `sectionOf`, and has no section of its
    own). Opening "Amount invested", one detail "PRAN or note", stale after 3 months (prices move
    daily), in rupees whatever the base (MC1 RD2 amended). Your own contributions are transfers in
    from a bank; the employer's, paid straight in, are rows under Salary (money put in, as EPF's), and
    the import counts an Actual NPS's plain deposits that way by default. Tier II takes a shade of
    Tier I's colour. Nothing is worked out (no exit age, annuity or tax: the rules changed in December
    2025 and differ by sector). Other asset's description now invites anything not listed.

> **v1 module set (17 since 2026-11-19, RD13, RD16 and RD17; was 11, revised 2026-06-21):** Bank, Credit Card, Mutual Funds, Stocks, FD, RD,
> Property, Gold, Loans, **Other asset**, **Other liability**, **PPF**, **Sovereign Gold Bond**, **EPF** and its **EPS** (RD16), **NPS Tier I** and **NPS Tier II** (RD17). (Cash excluded — only an "ATM Withdrawal"
> category.)
>
> **Nothing of RD6 is deferred any more:** PPF, EPF and EPS were built 2026-11-10, NPS 2026-11-19.
> Anything else without a type of its own goes in as an Illiquid *Other asset* (net worth still
> counts it — `liquidity = Illiquid` *is* "counts but not yet accessible").

## Dependencies
- **Depends on:** S1 (module registry + sections), S2 (holding model), S3 (marks; loan outstanding),
  F1 (creation, metadata, cardinality soft-warn, type immutability), C1–C4 (ledger ops), D1/D2
  (metadata-driven aggregation/bucketing), the plan's India-instrument rules (v2 reference).
- **Relates to:** S4 (Property/Loan equity linking — deferred), the app-wide number-format preference.
- **Excludes:** all auto-valuation engines & India tax math (v2), statement/billing (deferred),
  instruments beyond v1 (added later as new profiles), maturity/cap alerts (intelligence).

---

### Research sources
- Per-instrument valuation/tax mechanics (PPF/EPF/FD/RD/NPS/Gold/SGB) — **already captured in the
  plan's "India instrument rules" (Tier A research)**; that is the **v2** implementation reference, not
  MVP behaviour (MVP = manual marks).
- Holding model & marks (S2/S3) and their sources (Ghostfolio/Robinhood/beancount/Kubera) underpin the
  uniform mechanics these profiles sit on.
- Vehicle/secured-loan equity & balance-sheet treatment (S4): https://www.experian.com/blogs/ask-experian/what-does-it-mean-to-have-equity-in-your-car/ ; https://www.britannica.com/money/personal-balance-sheet
