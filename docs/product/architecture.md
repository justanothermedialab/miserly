# Conceptual architecture & the backbone

> The handful of cross-cutting ideas that make every story consistent. If a story ever seems to
> conflict with another, the answer is almost always one of these rules. Each is referenced by name
> throughout [`../user-stories/`](../user-stories/).

## 1. Single source of truth — derived, never stored

Every account's balance = **`opening + Σ(its transactions)`**, computed on read. There is **no stored
`value` field** anywhere that can drift from its transactions. The same applies to every aggregate:
net worth, allocation, growth, returns, report totals, and currency conversions are all **derived**
(memoised with invalidation, never persisted as a number).

This is the structural fix for the original *"inconsistent data across screens"* failure. Any place
where a displayed total disagrees with `opening + Σtx` over the same ordered set is a **P0 defect**.

## 2. Ordering key `(date, sequence)`

Transactions sort by **`(date, sequence)`**, never by row id / insert order. `sequence` is a stable
monotonic tiebreaker within a date, assigned on insert and reorderable. Every balance computation and
every register sorts this way. This is the concrete fix for an earlier prototype's `id<=up_to_id` fragility and
Actual's same-date running-balance bug (#3928), and it is what makes back-dated edits and same-date
reordering correct.

## 3. Double-entry & transfers

Money movement is **signed transactions**; a transfer is **two linked rows** (outflow in source,
inflow in destination) joined by `transfer_partner_id`. Edit one → the partner syncs; delete one →
both go, atomically. **An edit needs write access to every ledger it touches:** a member who can't
see the other leg (another member's private account) may change only that row's memo (Notes on screen); its amount,
date, delete, duplicate and re-pair are refused, so no one's row moves because of an edit they
can't see (2026-10-16; H4 RD7). Between currencies, correcting one leg's amount keeps the
other and re-derives the rate (MC2 RD4). A transfer is **excluded from all spending/income/cashflow analytics** unless
it moves money between a **spending account and a holding** (a SIP into a fund, a loan prepayment)
and the user gave it a category: that category sits on the **spending-side leg** (one fact, shown on
both legs) and counts by its kind like any row (§6). Bank ↔ bank, card bills and holding ↔ holding
take none. (Amended 2026-10-16; was "transfers carry no category".)
Net worth is therefore **invariant under any transfer** (asset→asset,
asset→liability debt-paydown, liability→asset). This is the double-entry heart of the model.

## 4. Valuation marks (mark-to-market)

The one change that *isn't* a cash flow is market movement. A **valuation mark** captures it: the user
asserts a target value ("now worth ₹X") and the system posts **one adjustment row** =
`target − running value just before`. It feels like a snapshot; it's stored as a transaction, so value
stays derived and never drifts. A mark is **non-transfer → moves value only, not cost basis** — it
*is* the unrealized gain/loss.

This is **one shared primitive** (beancount `pad`/`balance` semantics), reused by: holding onboarding
(the invested→value gap) and ongoing revaluation. v2 auto-valuation replaces *manual* marks with
*computed* ones behind the same contract. *(Reconciled 2026-07-12, M5 audit: opening balances are a
dated **column** on the account, and force-close posts a categorized **ordinary** adjustment — both
reuse the assert-value→post-gap arithmetic, but neither is a `valuationMark` row, so S3's
"marks apply to markable holdings only" holds without exception. See F1 Resolved decisions 9–11.)*

## 5. Per-instrument modules behind one aggregation contract

Each instrument is its **own module** (own business rules, captured fields, section UX) — a new asset
type is "a few new files." "Separate" stops at the **aggregation boundary**: every module exposes the
**same contract**, so net worth / allocation / growth / FX never branch on concrete type.

```
each module, as-of a date, in base currency, exposes:
  current_value()      -> the only thing net worth / allocation / growth need
  cost_basis()         -> contributions net of withdrawals (for returns)
  cash_flows(period)   -> money in/out (for cashflow + savings rate)
  + metadata: side(Asset/Liability), liquidity, currency, status(open/closed), cardinality
```

**Contract amendment (2026-11-09, decided as a change to a frozen interface):**
a transaction carries one optional flag, `countsAsReturn`, set by the app from the row's category's
"Counts as return" switch (on a transfer leg, from its partner's category). Absent, the old rule
holds: a transfer leg is money moved, any other row is growth. With it a holding tells money put in
that isn't a transfer (EPF's Salary) from growth, and a payout (a dividend sent to the bank) from a
withdrawal. Nothing else in the contract changed.

**Any `if module == 'FD'` in an aggregation path is a defect** — it breaks the modularity guarantee.
The **module registry** (the v1 set + each module's metadata) is the single source the nav,
add-account picker, sections, and aggregation all read.

### The v1 module set (15 since 2026-11-10; was 11, canonical — see [S5](../user-stories/instruments/S5-instrument-profiles.md))

Bank · Credit Card · Mutual Funds · Stocks · FD · RD · Property · Gold · Loans · Other-asset ·
Other-liability · **PPF · Sovereign Gold Bond · EPF · EPS** (launch list, built 2026-11-10, S5 RD13 and
RD16). *(Cash is intentionally excluded — only an "ATM Withdrawal" category.)* **An account may
belong to another** (`parent_account_id`, migration 0014): an EPF's EPS is its own account under the
same contract, valued at what was paid in (not markable), shown and shared with its EPF; aggregation
reads it like any account (no `if module`).

**Deferred to v2 (revised 2026-06-21; PPF, EPF and EPS undeferred and built 2026-11-10, NPS stays):** **PPF · EPF** (with **EPS** as a *sub-component* — EPS cannot
exist without EPF; EPF can exist without EPS) **· NPS**. In MVP these are merely Illiquid manual-mark
holdings, so they add nothing over the **Other-asset** catch-all except singleton machinery + the EPS
split; they return in v2 with their accrual engines. Track them as Illiquid Other-asset meanwhile —
net worth still counts them, because **`liquidity = Illiquid` is exactly "counts but not accessible
yet."**

Each module carries: **side** (Asset/Liability), **liquidity** (Liquid/Semi/Illiquid),
**spending-vs-holding**, **cardinality** (collection vs ≤1-active), and **markable?**. **Cardinality is
kept as a registry dimension even though no v1 module uses ≤1-active** — it's the slot PPF/EPF fill in
v2, which is the proof the registry is pluggable.

**Modularity limit found 2026-06-21:** the contract assumes every account has a `current_value`, so
**value-less instruments (term insurance, warranties) are out of the account model** — they're premium
*expenses* + an optional non-account "policy tracker" (a future concern). Savings/endowment insurance
and ULIP fit fine as markable holdings; crypto fits as a markable position holding.

## 6. Spending vs holding; F2 kinds

Two orthogonal classifications drive the reports:

- **Account class — spending vs holding** (type-derived). Spending accounts (Bank, Cards) feed
  cashflow/spending; holding accounts (everything else) are net-worth-only.
- **Category kind ∈ {Income, Spending, Investments, Neutral}** — set on the category *group*,
  inherited by categories (Investments added 2026-11-09, F2 RD10: Not in reports, and what R3's
  Invested reads). Charts read kind: Income → cashflow income; Spending → spending pie (signed, so refunds
  net); Investments and Neutral → excluded from both. An uncategorised transfer is excluded; a
  categorised one (§3) counts by its kind, and a bank or card row of the **Investments** kind,
  transfer or plain alike, is R3's **Invested** figure (money moved from cash into investments:
  part of what was saved, never spending; R3 RD13, 2026-11-09).

The **spending-inclusion predicate is shared** between R2 and R3 (one definition), making their totals
reconcile by construction.

## 7. Multi-currency — convert once at the boundary

One **native currency per account**; one **base currency = INR** (fixed in MVP). *Amended 2026-11-18
(MC1 RD2): the base is chosen once at setup (INR by default and for every older
instance) and read per request; "INR" below means that base.* Two *distinct* rates,
kept structurally independent:

- **Aggregation rate** (MC1) — one current `currency→INR` mark per active foreign currency, used to
  value standing balances in base. Changes over time; tied to no transaction.
- **Linkage rate** (MC2) — the actual rate of a cross-currency transfer, frozen on the row forever.

Conversion happens **once**, centrally, via **`to_base(amount, currency) = amount × rate[currency]`**
(`rate[base]=1`). No converted figure is ever stored. A **missing rate flags the total honestly**
("rate needed") — **never a silent 1:1** (the Firefly anti-pattern we explicitly reject).

A cross-currency transfer's two native legs **don't net to zero in base** when linkage ≠ aggregation
rate; that small **realized-FX effect** is real money and is shown honestly via derived totals — no
`Equity:Conversions`/Trading-Account machinery in MVP (deferred to v2).

## 8. As-of-today vs projected

Every balance display is **"as of today"** (transactions dated ≤ today). Future-dated entries are
allowed (we don't babysit users) but are **excluded from the headline** figure and shown as a separate
**projected** value. Net worth, the dashboard hero, and account balances all use as-of-today.

## 9. Time: dashboard vs reports

**"Today" for Dashboard/Accounts; the date-range selector lives *only* in Reports/Analytics.** The two
never blur — no date picker creeps onto the dashboard. (Exception: D3's net-worth-over-time uses fixed
timeframe chips, distinct from the general Reports date range.)

## 10. Lifecycle: closed, not archived

Accounts are **closed, never deleted** (Delete is deferred — it sidesteps the Firefly transfer-
corruption bug class). Closing moves the balance out (transfer or force-close adjustment), then the
account leaves net worth but keeps full history and is reopenable. **Closed accounts still count in D3
history** for the periods they were open (contrast D1/D2, which are as-of-today and open-only).

## 11. Shared-service discipline & deployment model

Every mutation path funnels through **one service** per concern: one create-transaction path (C1/C2),
one transfer service (C3/C4/MC2), one edit/delete service, one aggregation service (D1/D2/D3/D4/S1),
one `to_base`, one number formatter (SET1), **one visibility/visible-set service (§12)**. This is *why*
screens can't drift, and it is independent of where the code runs.

**Deployment = server-centric, two modes (D3).** One Node server owns the SQLite data; the browser is a
client. The same server ships as an **Electron desktop app** (bundled on `127.0.0.1`, data = a local
file, **fully offline** — no network needed for any operation, manual FX rates included) **and** as a
**self-hostable Docker image** (data on the server, open a URL, multi-device for free, no sync engine).
The **offline/"no network" guarantee is therefore a desktop-mode property**; hosted mode talks to the
server over the LAN/WAN. *(This supersedes the original local-first-in-the-browser premise.)* Full
engineering detail: [`../tech-stack.md`](../tech-stack.md).

## 12. Members, Circle & visibility (multi-user)

One instance serves a **Circle** — the small group sharing it (family, roommates, partners,
co-investors, a small business). "Circle" is **use-case-neutral vocabulary, not a database entity**:
there is exactly one per instance, so the Circle *is* the instance (its display name is an instance-wide
SET1 setting; there is no `circle` table or per-user `circle_id`). See
[Epic 8 — Circle & shared accounts](../user-stories/circle/README.md).

- **Members & auth.** Each person is a **`user`** with a role ∈ {**admin**, **member**}. Auth is
  **admin-gated** (no public signup), **server-side sessions** + **Argon2id** passwords (no JWT, no
  OAuth). The admin manages *membership only* — **admin is NOT a data-access super-user** (H1, H3).
- **Ownership & sharing.** Every account has an **`owner_id`** (its creator) and is **private by
  default**. The owner adds members to `account_members`; an added member gets **full view/edit/add**
  (no view-only tier) **for the dates they hold it** (H2 RD9, 2026-11-09): `account_holder_periods`
  (migration 0013) keeps each member's stretches, from the day added up to the day removed. Outside
  them a member sees and changes nothing ("Balance when you joined" before; read-only, nothing later,
  after they leave). A **shared account** = any account with >1 holder (H2).
- **The visible set** — the spine of every aggregate: a viewer's accounts = **`owned ∪ member-of`**.
  Implemented **once** as a shared service (`accountsVisibleTo(user)`); every scoped query reads it.
  It means "holds it now" (every write and picker); `accountsReadableBy` adds the accounts a member
  held once (the register, Reports and the net worth line, read-only), and every row a non-owner
  reads or writes must be dated inside their stretches (`viewerStretches`, `heldRowSql`).
  *Visibility* (can you read it) and *ownership* (can you manage its membership) are distinct checks,
  both **server-side** — never UI-only. A non-holder cannot see an account **exists**.
- **Whose net worth? (the scope clause).** Net worth / allocation / growth are **viewer-scoped**:
  computed over the viewer's visible set (personal + shared **counted in full**), plus a **Shared view**
  (shared accounts only). There is **no all-Circle total** (it would sum overlapping holders and pierce
  privacy). **The aggregation contract (§5) is unchanged** — visibility filters *which accounts feed it*,
  never the contract or the math.
- **Transfers (§3) gain one clause:** **both legs must be in the actor's visible set** — you can never
  move money into/out of an account you can't see (so never into someone's private account). Settle-up
  runs through **shared accounts** (H4). Cross-visibility "pay a member" and an IOU ledger are deferred.
- **Authorship.** Every transaction stamps **`entered_by`** (who logged it — audit, not economic
  attribution), shown as the "by" stamp on a register row; ~~reports can show a **by-member
  shared-spending breakdown** (H3, R2/R3)~~ dropped 2026-10-30 (R2 RD11).
- **Shared reference data.** Categories are **Circle-shared** (one taxonomy; per-user last-category
  memory). Payees are **one canonical deduped registry** with **earned per-user visibility** — a payee
  becomes visible to you only once recorded on an account you can access (filter the shared
  `account_payee` projection by your visible set); no separate per-user search indexes (F2/F3).

**Privacy is a P0 invariant:** any surface (or endpoint) that reveals an account, its balance, its
transactions, or its *existence* to a non-holder — including via the admin role — is a **P0 defect**.

---


**Joint accounts at each holder's share (2026-10-20, chosen from three ways of splitting a joint account).** A viewer's aggregate is Σ over the visible set of `weight(viewer, account, date) × contract output`: weight 1 for a sole holder, the holder's share (H2) for a shared account. Shares are dated (H2 RD8, 2026-10-21; the Effectivity pattern): today's figures use today's share, history uses the share in force at each month-end, and Reports weight each row by the share on its date. The weights come from one place, `sharesFor(viewer)` beside `accountsVisibleTo`; net worth, allocation, history and Reports multiply by them before summing. The aggregation contract and the modules are unchanged (no `if shared` inside aggregation). Each account's weighted figure is rounded half-even to the paisa, the remainder to the owner, so the holders' figures add to the account exactly. Records (registers, Recent activity, sidebar balances) show full amounts. The Shared view is gone; the shared accounts' full value is a line under the headline (D1). Still no all-Circle total. **Holders by date (2026-11-09, H2 RD8 and RD9, migration 0013):** the holders on a date are the owner and the members whose stretch covers it, so the weight is 0 for a viewer on a date they did not hold it, and a share applies only from the day someone joins.
## Glossary

| Term | Meaning |
|---|---|
| **Admin** | The member who set up the Circle; manages logins & membership only — **not** a data-access super-user (§12). |
| **Aggregation contract** | The uniform interface every module exposes so aggregation never sees concrete type (§5). |
| **Aggregation rate** | Current `currency→INR` rate valuing a standing balance in base (MC1). |
| **As-of-today** | Balance from transactions dated ≤ today; the honest headline figure (§8). |
| **Circle** | The group sharing one instance (use-case-neutral; not "household"); the Circle *is* the instance, not a DB entity (§12). |
| **Cost basis** | Σ contributions − Σ withdrawals (transfer legs into/out of a holding); the cash you committed. |
| **Derived** | Computed on read from the ledger, never stored (§1). |
| **entered_by** | Authorship stamp on every transaction — who *logged* it (audit), not economic attribution (§12). |
| **Holding account** | A net-worth-only account with value/cost/return (MF, FD, property…); markable. |
| **Kind** | Income / Spending / Neutral, set on a category group; drives report classification (§6). |
| **Linkage rate** | The actual, frozen rate of one cross-currency transfer (MC2). |
| **Mark / valuation mark** | A user-asserted value; system posts the gap as one adjustment row (§4). |
| **Member** | A user in the Circle; role ∈ {admin, member} (§12). |
| **Module** | A per-instrument code unit behind the aggregation contract (§5). |
| **Net worth** | Σ `current_value()` of OPEN accounts **in the viewer's visible set** (personal + shared in full), signed by side, base INR, as-of-today; no all-Circle total (§8, §12). |
| **Owner** | An account's creator; manages its sharing; an account is private until the owner shares it (§12). |
| **Realized-FX effect** | The base-currency spread when a transfer's linkage rate ≠ the standing mark (§7). |
| **Sequence** | Stable within-date tiebreaker for ordering and running balance (§2). |
| **Shared account** | An account with >1 holder (owner + added members); access-shared, not legal joint ownership (§12). |
| **Shared view** | Aggregate (net worth / reports) over shared accounts only (§12). |
| **Spending account** | An account whose activity feeds cashflow/spending (Bank, Cards) (§6). |
| **to_base** | The single conversion function `amount × rate[currency]` (§7). |
| **Transfer** | Two linked rows; net-worth-invariant; excluded from spending/income (§3). Both legs must be in the actor's visible set (§12). |
| **Visible set** | The accounts a viewer may read = owned ∪ member-of; the basis of every scoped aggregate (§12). |
