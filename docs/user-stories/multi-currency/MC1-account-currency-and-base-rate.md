# MC1 — Account currency & the base-conversion rate

> **Epic:** Multi-currency · **Story:** MC1 · **Status:** LOCKED (2026-06-21)
> **MVP scope:** CRUD + manual valuation only, zero intelligence.

---

## Title
As the user, I can give each account its **own native currency** (a US-brokerage account in USD, a
bank account in INR) and set **one current exchange rate per foreign currency**, so Miserly can value
*everything* in my **base currency (INR)** for net worth, allocation, and growth — without ever
storing a converted number that could drift.

## ELI5
My salary account is in rupees, but my RSUs sit in a dollar account. To add them into one "net worth"
number, Miserly needs to know "1 USD = ₹X today". I type that one rate per foreign currency; the app
keeps every account in its own money and only converts to rupees at the very last step, when it adds
everything up. Each account still shows its real native balance — the conversion is just for the
totals.

## Business context
Multi-currency is **core MVP scope**, not a nicety: the bullseye persona is an Indian software
engineer/data scientist who holds **US RSUs / US stocks** alongside INR accounts (called out in the
persona + the "Schedule FA / foreign-RSU" voice-of-customer note). Net worth is meaningless if a USD
account can't be folded into the INR total.

Every mature ledger/portfolio tool models this the same way, and we adopt the consensus:
- **One native currency per account** (GnuCash commodity per account; Firefly "asset accounts have one
  main currency"; Ghostfolio per-account currency; Kubera per-asset currency)
  ([GnuCash guide](https://www.gnucash.org/docs/v5//C/gnucash-guide/currency_manual.html),
  [Firefly currencies](https://docs.firefly-iii.org/how-to/firefly-iii/features/currencies/)).
- **A single base/report currency** into which all aggregates convert (GnuCash "Default Report
  Currency"; Firefly "primary currency"; Ghostfolio/Kubera "base/portfolio currency"). Ours = **INR**.
- **Convert only at the aggregation boundary** — Ghostfolio recomputes position value in base at the
  current rate; its shared-portfolio bug (values *not* converted for a viewer) is exactly the
  "convert once, centrally" lesson ([Ghostfolio #6963](https://github.com/ghostfolio/ghostfolio/issues/6963)).

Two **pitfalls** the research surfaced, which this story explicitly avoids:
1. **GnuCash:** a total across mixed currencies is *uncomputable* without a rate — so a missing rate
   must **block/flag the total honestly**, never guess
   ([GnuCash multi-currency](https://gnucash-docs-rst.readthedocs.io/en/latest/guide/C/ch_currency.html)).
2. **Firefly:** when no rate exists it silently falls back to **rate = 1**, yielding wrong-but-plausible
   net worth — a defect we must not replicate
   ([Firefly exchange rates](https://docs.firefly-iii.org/explanation/financial-concepts/exchange-rates/)).

This story owns the **aggregation rate** (rule (b) in the plan: "current per-currency rate to value a
foreign account's *balance* in base"). The **transaction-linkage rate** for a cross-currency transfer
(rule (a)) is **MC2**; how foreign amounts *display* and where rates are managed/refreshed is **MC3**.
Per the plan + D3, MVP uses **one current rate per currency applied across all of history**; true
historical (period-correct) rates and auto-fetch of a dated series = **v2**.

## User workflow

### Happy path — add a foreign-currency account
1. Creating an account (F1), the user picks its **currency** (default = base INR). They choose **USD**.
2. The account's register, opening balance, and balance all read in **USD** (its native money).
3. Because USD is now an **active foreign currency**, Miserly needs a **current rate** (1 USD = ₹X).
   The user enters it once (a **currency rate mark**); net worth, allocation (D1/D2) and history (D3)
   now include the USD account, converted to INR.

### Happy path — second account, same currency
- Adding another USD account reuses the **existing USD→INR rate** (rate is per-currency, not
  per-account). No re-entry.

### Alt path — rate not yet set
- A foreign account exists but its currency has **no rate**. The account still shows its native
  balance correctly; but any **base-currency total that includes it is flagged "rate needed"** (with
  a one-tap "set USD rate") — the total is **never silently computed at 1:1**.

### Recovery path — update / correct the rate
- The user re-enters the current rate (e.g. USD moved); the **single current rate is replaced** and
  all base-currency aggregates recompute. (Editing rates / staleness surface = MC3.)

## Acceptance criteria
- [ ] Each account has a **native currency** chosen at creation (default = base **INR**); the
      account's opening balance, transactions, and derived balance are all in that native currency.
- [ ] There is **one base currency = INR** for the whole app; all cross-account aggregates (D1 net
      worth, D2 allocation, D3 history) are expressed in it.
- [ ] Each **active foreign currency** (one used by ≥1 account) carries **one current
      `currency→INR` rate**, entered manually; the rate is **per-currency, shared across all accounts**
      in that currency.
- [ ] Conversion happens **once, at the aggregation boundary** — `value_in_base = native_value × rate`
      — and **no converted figure is ever stored** (derived, same single-source-of-truth rule as
      balances).
- [ ] A **missing rate** for an active foreign currency **flags any affected total** ("rate needed")
      and offers to set it; the total is **never computed at an implicit 1:1**.
- [ ] An account whose currency **equals base (INR)** needs no rate and converts trivially (×1).
- [ ] Setting/replacing a rate **recomputes all base-currency aggregates** consistently across every
      screen (one shared conversion path; no per-screen drift).
- [ ] In MVP, the **single current rate is applied across all of history** (consistent with D3's
      "historical FX = today's rate"); true historical rates = v2.
- [ ] All converted figures respect the app-wide number-format preference.

## Validation rules
- **Account currency:** required; chosen from a supported ISO-4217 list; defaults to base. **Immutable
  after creation in MVP** (like account *type* in F1 — re-denominating an existing ledger is out of
  scope; the path is close + recreate). See Resolved decisions.
- **Rate value:** a positive number (> 0); units are **base per 1 unit of foreign** (₹ per 1 USD).
  Zero/negative rejected.
- **Rate scope:** exactly **one current rate per active foreign currency**; base→base is always 1 and
  not editable.
- **Rate required for totals, not for entry:** a foreign account is fully usable (register, balance)
  **without** a rate; the rate is only required to fold it into a **base-currency total**.
- **Currency lifecycle:** a currency becomes **active** when an account adopts it and **inactive** when
  no open account uses it (its rate is retained but unused) — mirrors Firefly/Ghostfolio "currencies
  follow accounts".

## Edge cases
- **All accounts in base (INR):** no rates exist, nothing to convert — the multi-currency machinery is
  invisible (the common case must add zero friction).
- **Foreign account with a rate, then rate cleared:** totals revert to "rate needed"; native balances
  unaffected.
- **Closed foreign account (F1):** excluded from D1/D2 like any closed account, but **D3 history still
  needs its currency's rate** for the periods it was open (D3 includes closed accounts) — the retained
  rate covers this.
- **Currency with many accounts:** all share the one rate; updating it moves them together (no
  per-account override in MVP — see Resolved decisions).
- **Very large/small rates** (e.g. a weak foreign currency, 1 unit = ₹0.006): stored at adequate
  precision; display respects number-format + sensible decimals.
- **Base currency itself appearing as a "foreign" pick:** selecting INR on an account just means native
  = base; never asks for a rate.

## Failure cases
- **Silent 1:1 fallback** (the Firefly defect): a missing rate must **never** be treated as 1 — the
  total must flag instead. P0.
- **Storing a converted balance** that later disagrees with `native × current_rate`: defect — base
  values are always derived, never persisted.
- **Per-screen conversion divergence** (D1 says one INR total, D3 another for the same instant): defect
  — one shared conversion function, one rate source.
- **Rate applied upside-down** (dividing instead of multiplying, or foreign-per-base vs base-per-foreign
  confusion): defect — units are fixed as **base per 1 foreign** everywhere.
- **Editing an account's native currency re-interpreting historical rows** (₹ amounts suddenly read as
  $): prevented by currency immutability in MVP.

## UX considerations
- **Invisible until needed:** an all-INR user never sees a currency picker default change or a rate
  prompt; multi-currency must not tax the common case.
- **Native first, converted second:** an account always leads with its **real native balance**; the INR
  equivalent is secondary/parenthetical (detail in MC3). Users distrust apps that hide the real number.
- **"Rate needed" is a gentle, actionable nudge**, not an error wall — show the native balances fine,
  mark just the *total* with a one-tap "set USD rate". Honesty over false precision (the GnuCash stance,
  not the Firefly one).
- **One rate, one place:** entering "1 USD = ₹X" should feel like setting a fact, akin to a valuation
  mark — reuse that mental model (a **currency rate mark** is conceptually a sibling of the S3 holding
  mark).
- **Currency code affordance** (Kubera-style "type the code") is a nice fast-path for power users; the
  picker is the default.

## Operational considerations
- **Data model:** `account.currency` (ISO-4217, immutable in MVP). A small **rates store**:
  `currency → current_rate_to_base` (one row per active foreign currency); base has implicit rate 1.
  No converted amounts stored anywhere.
- **One conversion function** `to_base(amount, currency) = amount × rate[currency]` (rate[base]=1) is
  the **single** place D1/D2/D3 and the aggregation contract's `current_value()`-in-base go through —
  the structural guard against per-screen drift.
- **Aggregation contract tie-in:** the contract already declares `currency` metadata and "convert to
  base for every aggregate"; MC1 supplies the rate that makes `current_value()` expressible in base.
  Modules never see rates — they report native; conversion is at the boundary.
- **Missing-rate signal** propagates up: an aggregate over a currency with no rate returns a
  "incomplete / rate needed" state rather than a number.
- **MVP simplicity:** one current rate per currency (no dated series); reused for all of history (D3).
  v2 swaps the rates store for a dated/auto-fetched series behind the same `to_base` interface.
- **Offline in desktop mode** (manual rates need no internet; auto-fetch of the current spot rate is
  deferred to v2 — see Resolved decisions); hosted mode is client↔server.

## Resolved decisions (locked 2026-06-21)
1. **Rate entry = FULLY MANUAL in MVP** (LOCKED): the user types the one current `currency→INR` rate per
   active foreign currency (simplest, fully offline). **Deferred option (v2):** auto-fetch the current
   spot rate per active currency from a free public source (Frankfurter / ECB / exchangerate.host) with
   **manual override + manual fallback offline** — public FX data, **no account access**, consistent
   with the persona's public-price-lookup stance. Either way, **historical (dated, period-correct)**
   FX stays v2 — MVP applies the single current rate across all of history (per D3).
2. **Base currency = FIXED at INR in MVP** (LOCKED): not user-changeable in this phase (changing base
   re-values every aggregate = a heavy one-time operation, deferred). *Display-in-another-currency*
   (Kubera's "view net worth in any currency") remains a separate **MC3 display** concern, not a base
   change, and is unaffected by this lock.
   **Amended (2026-11-18): the base currency is chosen at setup** (H1 RD15), from the
   supported currencies with two decimals (not JPY: money is whole hundredths). INR stays the
   default, and an instance set up before the choice reads INR. Everything above that says INR
   means the instance's base: a rate is "one unit of X in base"; the rate list shows every held
   currency that is not the base, INR included when the base is another; a new account, and every
   account the Actual import makes, opens in the base. Indian instruments' own amounts (PPF's
   ₹1.5 lakh a year) stay rupees. Changing the base after setup still comes later (the re-valuing
   reason above); a display switch is MC3's and is unaffected.
   **Amended (2026-11-19): an Indian scheme opens in rupees whatever the base.** PPF,
   EPF with its EPS, Sovereign Gold Bond and NPS are always INR: Add account shows the currency
   fixed, with no picker, and the server sets it whatever is posted (the profile's `currency`), so
   PPF's ₹1.5 lakh a year counts rupees on a dollar instance. Every other type opens on the base, as
   above. The Actual import still opens every account in the base (its amounts are in the base).
3. **No per-account rate override** (LOCKED): exactly one current rate per active currency, shared by
   all accounts in that currency; a per-account override is a power-user edge deferred to v2.

## Dependencies
- **Depends on:** F1 (account creation — currency chosen here, immutability mirrors account type),
  the aggregation contract (`currency` metadata + convert-at-boundary), D1/D2/D3 (the aggregates that
  consume `to_base`).
- **Feeds:** MC2 (cross-currency transfer — uses native currencies + the linkage rate, distinct from
  this aggregation rate), MC3 (display of native vs converted, rate-management surface, staleness),
  D3 (historical FX = this current rate in MVP).
- **Relates to:** S3 (a currency rate mark is conceptually a sibling of the valuation mark), **SET1**
  (Settings — hosts base-currency change and rate management).
- **Excludes:** auto + historical (dated, period-correct) FX series (v2); transaction-linkage rate
  (MC2); display/staleness/management UI (MC3); re-denominating an account's currency (out of MVP).

---

### Research sources
- GnuCash — one currency (commodity) per account; "Default Report Currency"; a total across mixed
  currencies is uncomputable until exchange rates are set:
  https://www.gnucash.org/docs/v5//C/gnucash-guide/currency_manual.html ;
  https://gnucash-docs-rst.readthedocs.io/en/latest/guide/C/ch_currency.html
- Firefly III — asset accounts have one main currency; a primary currency; all amounts calculated back
  to base; **no rate ⇒ rate = 1** (the anti-pattern we reject); rates from exchangerate.host:
  https://docs.firefly-iii.org/how-to/firefly-iii/features/currencies/ ;
  https://docs.firefly-iii.org/explanation/financial-concepts/exchange-rates/
- Ghostfolio — per-account currency converted to base at the current rate, refreshed with market data;
  users supply historical rates; convert-at-the-boundary (shared-portfolio non-conversion bug):
  https://github.com/ghostfolio/ghostfolio/issues/6963 ;
  https://github.com/ghostfolio/ghostfolio/discussions/3141
- Kubera — per-asset currency, a "portfolio currency", type a currency code before a balance, view net
  worth in any of ~10 currencies (a display concern → MC3):
  https://www.kubera.com/blog/multi-currency-portfolio-tracker
