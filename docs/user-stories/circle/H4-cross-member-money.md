# H4 — Cross-member money & settle-up (transfers within the visible set)

> **Epic:** Circle & shared accounts · **Story:** H4 · **Status:** LOCKED (2026-06-25)
> **MVP scope:** CRUD, zero intelligence. Provenance: MODE 2 decision D6 + domain HH-5.

---

## Title
As a member, I can move money only between accounts I can see (mine ∪ shared), and settle up with others
through a shared account — so cross-member money stays honest and private (I can never target an account
I'm not allowed to see).

## ELI5
In a Circle, money sloshes between people: I pay the landlord from our shared pot; you put your half into
that pot. This story says: **you can only move money between accounts you actually hold a key to.** You
can't shove money into my private account (you can't even see it). The normal way to "pay each other
back" is through a **shared account** everyone can see. Fancier "pay a specific person privately" and
"who-owes-whom" tracking are deliberately left for later.

## Business context
This story keeps the **transfer engine (C3) clean under multi-user** and preserves privacy. Locked
decision **HH-5**:

1. **Transfers are within the actor's visible set only.** A transfer's **both legs** (source +
   destination) must be accounts the actor can see (owned ∪ member-of, from H2). You cannot transfer
   *into* or *out of* an account you can't see — which means you can never touch someone's **private**
   account. This is the C3 invariant extended by one clause: *both legs ∈ visible set* (architecture §3
   double-entry is otherwise unchanged).

2. **Settle-up runs through shared accounts.** The normal family/flat pattern: contributions and
   repayments flow through a **shared account** everyone involved can see (e.g. "Flat Pool"). Because the
   shared account is visible to its members, both legs are legal and the money is transparent to exactly
   the people who should see it.

3. **Net worth stays invariant under transfers** (architecture §3) — moving money between two visible
   accounts (one of which may be shared) doesn't change anyone's net worth except as their visible set
   dictates; transfers remain **excluded from spending/income analytics**.

**Deferred (explicitly recorded, not built):**
- **(B) "Pay a member" — direct, privacy-respecting settle-up.** Pick a *person* + amount → it lands in
  their **designated receiving account** without you seeing that account; the server links the two legs
  *across* the visibility boundary (the one sanctioned exception, mediated server-side). A clean
  fast-follow once the core lands.
- **(C) Splitwise-style IOU / who-owes-whom ledger.** Tracking informal debts and balances between
  members — a distinct, larger feature; deferred further.

## User workflow

### Happy path — contribute to a shared account
1. Member opens **+ Transfer** (C3) → **From** = their own account, **To** = a **shared** account they
   hold. Both legs are in their visible set → allowed.
2. Two linked rows are written (C3 mechanics, unchanged); both members of the shared account see the
   inflow leg; the contributor's own account shows the outflow.

### Happy path — pay a bill / withdraw from the shared pot
1. From the **shared** account → To another visible account (or recorded as a spending transaction on the
   shared account, per normal capture). Visible-set check passes.

### Happy path — settle up between two people (MVP route)
1. Both route through the shared account: A contributes to the pool; B draws from / is reimbursed via the
   pool. The pool is the transparent meeting point. No direct A-private → B-private move exists in MVP.

### Alt path — picker only offers visible accounts
- In the C3 From/To pickers, **only the actor's visible accounts appear**. A private account of another
  member is simply absent (not greyed-out — absent, consistent with H2 "as if it doesn't exist").

### Blocked path — targeting an invisible account
- There is no UI route to select an account outside the visible set; if a crafted request references one,
  the server **rejects** it (defense in depth — not just UI filtering).

### Deferred path — "pay a member" (B)
- Not in MVP. When built: choose a person, not an account; server resolves their receiving account and
  links the legs without exposing it.

## Acceptance criteria
- [ ] A transfer is accepted **only if both legs are in the actor's visible set** (owned ∪ member-of);
      otherwise rejected **server-side**, regardless of UI.
- [ ] C3 From/To pickers list **only the actor's visible accounts**; no other member's private account is
      selectable or visible.
- [ ] Settle-up via a **shared account** works end-to-end (contribute, draw, reimburse) using the
      unchanged C3 two-linked-rows mechanics.
- [ ] Transfers remain **excluded from spending/income analytics** and keep **net worth invariant**
      (architecture §3) under the viewer-scoped aggregates (D/R).
- [ ] A transfer touching a **shared** account is visible to **all that account's members** (the inflow/
      outflow leg on the shared side), stamped with `entered_by` (C1/C2 edit).
- [ ] **"Pay a member" (B)** and **IOU ledger (C)** are **not present** in MVP and are recorded as
      deferred (this story is their home).
- [ ] No transfer can move money into another member's **private** account by any path.

## Validation rules
- **Both-legs-visible:** enforced server-side against the H2 visible-set service at write time (and on
  edit — C4).
- **Same-currency** in this story (cross-currency settle-up routes through the Multi-currency epic / MC2,
  which itself must also satisfy both-legs-visible).
- **Shared-account legality:** a shared account is visible to its members, so member↔shared transfers are
  legal for those members; a member who is *not* on the shared account cannot use it as a leg.
- **Edit/delete (C4):** editing a transfer cannot retarget a leg to an account outside the editor's
  visible set; the linked-row integrity rule (architecture §3) still holds. **A member who can't see
  the other leg** may edit only that row's memo (Notes on screen; their leg); its amount, date, delete, duplicate and
  re-pair are refused with "The other half of this transfer is in an account you can't see. Ask
  <who entered it> to change it." (RD7).

## Edge cases
- **Transfer between two shared accounts the actor holds:** allowed (both visible).
- **Actor is a member (not owner) of the shared account:** full access (H2) → may transfer to/from it.
- **A leg's account is later unshared from the actor** (H2 removal): past transfer rows remain (history);
  the actor simply loses visibility of that leg going forward; the partner side stays valid for those who
  can see it.
- **Shared account closed (F1):** existing transfers stay in history; new transfers to it are blocked
  (closed accounts don't accept new activity).
- **Cross-visibility transfer partner:** a transfer where one leg is shared and the partner leg is the
  actor's private account — fine (actor sees both). The *other* members of the shared account see only
  the shared leg, **not** the actor's private partner account (H2 privacy preserved on the partner side).
- **Crafted/replayed request referencing an invisible account id:** rejected server-side (the picker
  never offered it).

## Failure cases
- **Visible-set bypass (the P0):** any accepted transfer with a leg outside the actor's visible set is a
  **P0 privacy + integrity defect** — it would let a member discover or fund an account they can't see.
  Enforcement is server-side, not UI-only.
- **Spending-analytics contamination:** a settle-up/contribution transfer leaking into spending/income
  totals is a defect (transfers are categoryless and excluded — architecture §3, §6).
- **Net-worth drift under settle-up:** if a transfer changes a viewer's net worth other than by moving
  money between *their* visible accounts, the aggregation is wrong (re-derive, don't cache).
- **Linked-row asymmetry across visibility:** the two legs must stay linked even when different members
  can see different legs. An edit by someone who sees **both** legs syncs the partner (architecture
  §3); someone who sees only one can't change the amount, date or existence of the pair (RD7), so a
  member's edit never rewrites a row in an account they can't see (a review of the app found carol's
  edit dropping alice's private balance by ₹10,000; amended 2026-10-16).
- **Accidental "pay a member" expectations:** since B is deferred, the UI must not imply you can pay a
  person directly — settle-up is via shared accounts in MVP (avoid a dead affordance).

## UX considerations
- **The transfer form is the C3 form, just scoped:** identical UX; the only difference is the account
  pickers contain the visible set. No new "cross-member" mode in MVP.
- **Shared accounts are the visible meeting point** — a "Flat Pool"-style account is the intuitive,
  discoverable way to settle up; the UX should make creating/sharing such an account easy (H2 Share).
- **`entered_by` is surfaced** on shared-account rows so co-members can see *who* logged a contribution/
  payment (the by-member breakdown that built on this was dropped 2026-10-30, R2 RD11).
- **No IOU/owed-balance UI** in MVP — don't tease a who-owes-whom panel; (C) is deferred. A small note in
  settings/roadmap is enough.
- **Honest privacy on partner legs:** when a member views a shared account, a counterpart leg sitting in
  someone's private account is shown only as "Transfer" without exposing the private account's identity.

## Operational considerations
- **One transfer service (C3) + one visible-set check (H2)** — the both-legs-visible rule is added to the
  single transfer path, not sprinkled across callers (§11). Edit/delete (C4) reuse the same check.
- **Defense in depth:** UI filters pickers *and* the server validates legs; never rely on the client.
- **`entered_by` stamping** is shared with C1/C2 (one author-stamp mechanism), so transfer legs carry
  authorship like any transaction.
- **Deferred-B note for the future:** "pay a member" will need a server-mediated cross-visibility link
  (the only sanctioned exception) + a per-user "receiving account" setting — recorded now so the schema/
  service boundaries (a transfer can be *brokered* by the server) aren't designed in a way that precludes
  it. No code now.
- **Cross-currency settle-up** defers to MC2, which must also honor both-legs-visible.

## Resolved decisions (locked 2026-06-25)
1. **Transfers limited to the actor's visible set — both legs** (HH-5); enforced server-side; you can
   never target an invisible (private) account.
2. **Settle-up via shared accounts** is the MVP pattern (transparent to exactly the right people); no
   direct private→private move exists.
3. **C3 mechanics unchanged** — two linked rows, net-worth-invariant, excluded from spending (architecture
   §3/§6); H4 only adds the visibility clause.
4. **(B) "Pay a member" deferred** — privacy-respecting direct settle-up via a server-mediated
   cross-visibility link + a receiving-account setting; a clean fast-follow, not MVP.
5. **(C) IOU / who-owes-whom ledger deferred further** — a distinct larger feature; not in MVP.
6. **`entered_by` on transfer legs** (shared with C1/C2) so shared-account activity is attributable.
7. **A member can't change the half they can't see** (2026-10-16, decided after
   comparing how shared finance apps handle it). On a transfer whose other leg is outside the
   editor's visible set: the memo edits their leg only; amount, date, delete, duplicate and re-pair
   are refused with a message naming who entered the row (a name the row already shows), and the
   register offers none of them (the cells say why on hover; Delete is off). Bulk delete leaves such
   rows and says so. The owner of the hidden account changes it from their own register, where the
   pair syncs as before. The page never carries the hidden leg's row id. Why: an edit needs write
   access to every ledger it touches (least privilege; no silent change to another person's books).
   Every shared app found either shares all accounts (YNAB, Monarch, Lunch Money, Actual) or lets
   no one edit another's data (Honeydue, INDmoney); Sure, the one with per-account sharing, requires
   access to both accounts to edit a transfer. Sure unlinks on delete instead; Miserly refuses,
   because an unlinked half would break the double-entry pair net worth relies on.
8. **Except when the other half's holder has left the Circle** (2026-11-09, after a review of the app; H3
   RD8): nobody can ever change that half, so the holders of this one may change its date and amount
   or delete it alone; the pair unlinks and this half becomes a plain row, "Bob (left)". The register
   reads it "From Bob (left)" until then and offers its date, memo and amount. A transfer whose other
   half is in an account the actor held once (H2 RD9) stays readable on both sides ("To Joint
   (Alice's)") and says "…in Joint, which is no longer shared with you. Ask Alice to change it."; the
   owner sharing it again gives the member their earlier dates back, so they can fix it.

## Dependencies
- **Depends on:** **H2** (the visible-set service — the whole rule), **C3** (the transfer engine being
  scoped), **C1/C2** (`entered_by` stamping), **F1** (accounts, incl. shared ones to settle through).
- **Feeds:** ~~the **by-member shared-spending breakdown** in the **R2/R3** edits (who contributed/spent on
  shared accounts) and the **Shared view** in **D1/D2/D3**~~ (both dropped: R2 RD11, D1 RD12).
- **Related / deferred-here:** **(B)** pay-a-member and **(C)** IOU ledger live in this story's deferred
  set; **MC2** handles the cross-currency variant (also subject to both-legs-visible).
- **Architecture:** the both-legs-visible transfer rule is recorded in **architecture §12** alongside the
  visibility model.

---

### Research sources
- Splitwise — shared-expense / who-owes-whom model (the (C) pattern we explicitly defer): https://www.splitwise.com/
- Double-entry transfer correctness (two linked legs, net-worth-invariant) — GnuCash / beancount /
  Firefly III, already cited in C3; H4 adds only the visibility constraint.
- Principle applied: **capability = visibility** — you can only act on what you can see, enforced
  server-side (OWASP Authorization Cheat Sheet, deny-by-default): https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
