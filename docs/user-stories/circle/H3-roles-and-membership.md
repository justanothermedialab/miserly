# H3 — Roles & membership management (admin vs member · the Circle lifecycle)

> **Epic:** Circle & shared accounts · **Story:** H3 · **Status:** LOCKED (2026-06-25)
> **MVP scope:** CRUD, zero intelligence. Provenance: MODE 2 decision D6 + domain HH-6.

---

## Title
As the Circle **admin**, I can add and remove members and reset their passwords; I have no view of
anyone's private accounts, and while a reset lets me sign in as that member, they are always told
(RD9); and any member can edit the shared category taxonomy — so the Circle is manageable without
anyone becoming an unseen super-user.

## ELI5
Someone has to be the "person who runs the server" — adds people, removes people who leave, resets a
forgotten password. That's the **admin**. But "runs the server" must **not** mean "can read everyone's
private money." This story draws that line: the admin manages *people*, not *data*. It also handles the
messy part — what happens to shared accounts when someone leaves.

## Business context
This story defines **what roles can do** (and pointedly, what the admin *cannot*). Locked decision
**HH-6**:

1. **Two roles: admin + member.** The admin (H1's first user) manages **membership** — create logins
   (H1), remove members, reset passwords. Members just use the app.

2. **Admin is NOT a data-access override (the crux).** Privacy from H2 holds for *everyone*: **even the
   admin cannot see a member's private accounts.** Admin power is over *identities and membership*, never
   over *financial data*. This is the deliberate "manage the Circle without surveilling it" stance — it's
   what makes the privacy promise credible to members who'd otherwise distrust a family/flat admin.
   **What is true (RD9, 2026-11-18):** the admin's Reset password sets a temporary password, so the
   admin can sign in as that member; the app never shows the admin a member's data, but the reset is
   a way in. It is never unseen: the member is told the admin reset it and on which day.

3. **Account-level control stays with each owner (H2).** The admin does not reassign or unshare other
   people's accounts. The one place admin and ownership collide — **removing a member who owns shared
   accounts** — is resolved here (below).

4. **Shared category taxonomy is collaboratively editable.** Any member can add/edit the shared
   categories/groups (F2). Risk accepted: a rename/delete affects everyone's reports — acceptable in a
   small trusted Circle; an admin-curated/locked mode is an easy later tightening, not MVP.

## User workflow

### Happy path — manage members
1. Admin → **Settings → Members**: a list of members (username, role, last active).
2. Admin can **Add member** (H1), **Reset password** (sets a temp password, `must_change_password`), or
   **Remove member**.

### Happy path — remove a member who leaves the Circle
1. Admin → member → **Remove from Circle**.
2. System checks what the member **owns**:
   - Their **private** accounts: leave with them (still their data; simply gone from this instance's
     active set — see Resolved decisions for hard-delete vs retain).
   - Their **shared** accounts (accounts they own that others can see): **blocked** until resolved —
     admin must prompt the owner to **reassign or unshare** first (MVP: block + explain). The system
     never silently orphans a shared account or yanks it from co-members.
3. On success, the member's **logins/sessions are revoked**, and their **membership in every account is
   removed** (co-members lose that person's access; the account and its history remain for remaining
   holders; `entered_by` stamps persist).

### Alt path — edit shared categories
- Any member edits the shared taxonomy (F2). Changes are Circle-wide and immediately affect everyone's
  categorization and reports (the shared vocabulary is the point).

### Recovery path — accidental removal
- Re-add the member (H1 creates a fresh login); previously shared accounts must be **re-shared** by their
  owners (grants were tombstoned in H2). Their authored history was never deleted.

## Acceptance criteria
- [ ] Exactly **two roles** exist: **admin** and **member**; the first user is admin (H1).
- [ ] The admin can **add** members (H1), **reset** a member's password (temp + `must_change_password`),
      and **remove** members.
- [ ] The admin **cannot read** any account they are not a holder of — **no admin endpoint returns data
      outside the admin's own visible set** (same P0 rule as H2).
- [ ] Removing a member **revokes their sessions** and **removes their account memberships**; remaining
      holders keep the accounts and all history; `entered_by` stamps persist.
- [ ] Removing a member who **owns shared accounts** is **blocked** until the owner reassigns/unshares
      (MVP) — a shared account is never orphaned or silently transferred.
- [ ] The Circle can **never be left admin-less**: the last admin cannot be removed or demoted (H1 edge).
- [ ] Any member can **edit the shared category taxonomy** (F2); changes are Circle-wide.
- [ ] Membership management actions are **authorized to admin only** (members cannot add/remove others or
      change roles).

## Validation rules
- **Role:** ∈ {admin, member}; exactly one admin in MVP; promotion to a second admin is deferred
  (Resolved decisions 5).
- **Remove member:** rejected if the target is the **last admin**, or if they **solely own shared
  accounts** that aren't reassigned/unshared.
- **Reset password:** admin-only; sets a temp password + `must_change_password`; does not reveal the old
  one (it isn't recoverable — Argon2id).
- **Self-actions:** the admin cannot demote/remove themselves while sole admin; a member can change their
  own password (H1) and edit shared categories, nothing membership-related.

## Edge cases
- **Member owns a mix of private + shared accounts on removal:** private leave with them; shared block
  removal until resolved — handled per-account, not all-or-nothing.
- **Member is a co-holder (not owner) of shared accounts on removal:** no block needed; just drop their
  memberships; owners/other members are unaffected.
- **Admin tries to view "all accounts" for support:** there is no such view; admin sees only their
  visible set like anyone else (by design).
- **Two admins requested (e.g. both spouses):** deferred — MVP is single-admin; noted as an easy
  follow-up (multi-admin = a role flag + relax the last-admin guard to last-*remaining*-admin).
- **Removed member re-added later:** new login; their old shared grants are gone (tombstoned) and must be
  re-issued by owners.
- **Shared-category delete/rename by one member breaks another's mental model:** accepted in MVP;
  reassignment-on-delete from F2 still applies (no orphaned transactions).

## Failure cases
- **Admin-as-superuser leak (the P0):** any path where admin role grants visibility into private
  accounts is a **P0 privacy defect** — role checks gate *membership management*, never *data reads*.
  Data reads always go through the H2 visible-set service regardless of role.
- **Orphaned shared account:** removing an owner without reassignment, leaving co-members with an
  un-owned account, is a defect — the removal is blocked first.
- **Admin-less Circle:** any sequence that removes/demotes the last admin must be blocked (otherwise the
  instance becomes unmanageable).
- **Privilege escalation:** a member invoking an admin-only endpoint (add/remove/reset/role-change) must
  be rejected server-side, not merely hidden in the UI.
- **Session not revoked on removal:** a removed member retaining an active session is a defect — removal
  invalidates their sessions immediately.

## UX considerations
- **Members screen is small and clear:** list + Add + per-member Reset password / Remove. No permission
  grids (per-account sharing lives in H2, on the account).
- **Removal is a guided, honest flow:** if blocked by shared ownership, explain exactly which accounts
  need reassigning/unsharing and by whom — never a cryptic failure.
- **The privacy stance is stated, not hidden:** admin settings should make explicit "You manage members
  and logins. You cannot see other members' private accounts." — this reassurance is a feature.
  (RD9: the guide adds that a reset lets the admin sign in as the member, and that the member is told.)
- **Shared-category editing carries a light caution** ("changes apply to everyone in the Circle") without
  blocking — informative, not scolding (matches F2's tone).

## Operational considerations
- **Authorization layer is role-aware; the data layer is not** — membership-management endpoints check
  `role == admin`; all data queries ignore role and use the H2 visible-set service. Two separate gates,
  never conflated (§11).
- **Member removal is a transaction:** revoke sessions + tombstone account memberships + (per Resolved
  decisions) handle owned accounts, atomically — never a partial state.
- **Audit:** `entered_by` stamps survive member removal so historical authorship remains attributable to
  the remaining holders (the person is gone; the record of who logged what is not).
- **Schema:** role lives on `users.role`; no separate roles table needed at this scale. Sync-ready
  conventions as elsewhere.

## Resolved decisions (locked 2026-06-25)
1. **Two roles, admin + member** (HH-6); first user = admin (H1).
2. **Admin manages membership, never data** (HH-6) — the defining privacy guarantee; admin has no
   visibility override.
3. **Account membership stays owner-controlled** (H2); admin does not reassign/unshare others' accounts —
   except by **blocking removal** until the owner resolves shared ownership.
4. **Remove-member rule:** private accounts leave with the member; **shared accounts block removal until
   reassigned/unshared** (no orphans, no silent transfer); sessions + memberships revoked on success.
5. **Single admin in MVP; multi-admin deferred** — a small follow-up (role flag + last-*remaining*-admin
   guard). The last admin can never be removed/demoted.
6. **Shared categories collaboratively editable by any member** (HH-6); admin-curated/locked mode is a
   deferred tightening.
7. **Removed-member data retention** (private accounts): retain-as-inaccessible vs hard-delete is an
   implementation choice deferred to build (default lean: retain + tombstone, consistent with sync-ready
   soft-deletes; a true "delete my data" is a later, explicit action).
8. **The remaining holders can change their half of a transfer with someone who left** (2026-11-09,
   after a review of the app). Removing a
   member ends their stretches on every shared account that day (H2 RD9: the dates they held keep
   their split, so nobody's past figures change). A transfer between their own account and a shared
   one then reads "From Bob (left)" on the shared side, and its holders may change its date and
   amount or delete it: that half alone, which unlinks it into a plain row with the payee "Bob
   (left)" (its category stays). The other half stays, unlinked, in the departed member's account,
   which nobody can see again, so changing this one reveals nothing. ~~"Ask Bob"~~ asked someone who
   no longer exists, so a wrong amount could never be fixed. While the member is still in the
   Circle, H4 RD7 stands ("Ask Bob").
9. **A password reset is never unseen** (2026-11-18, after a security read;
   decided 2026-11-12, the migration approved 2026-11-18). Reset
   password stays: a family needs it. But a forced change asks for no current password, so the admin
   who set the temporary password can sign in as the member and has their accounts; "even the admin
   cannot see" (context 2) was not true of that path. So the reset stamps the day on the member
   (`users.password_reset_at`, migration 0016), and the first page after the member's next sign-in and
   forced change says "Your password was reset by the admin on 12 Nov" (the real day) on every page
   until they close it; closing it clears the day. The reset is also a log line. The guide says
   plainly that the admin can reset a password and so can sign in as that member, and that the member
   is always told.

## Dependencies
- **Depends on:** **H1** (roles, logins, sessions) and **H2** (ownership/membership — the thing being
  managed; the visible-set service that admin must *also* obey).
- **Blocks / feeds:** clean operation of the whole Circle epic; the **member-removal** rule is referenced
  by H2 edge cases (owner removed) and by F1/F2 (orphan avoidance, shared-taxonomy edits).
- **Related:** **F2** (shared category taxonomy editing rules), **SET1** (where Members management lives
  in the settings IA — instance-wide section).
- **Architecture:** the admin-≠-data-access rule is recorded in **architecture §12**.

---

### Research sources
- Firefly III — admin/owner role for a self-hosted multi-user instance (operator manages users; users'
  data is isolated): https://docs.firefly-iii.org/
- OWASP — Authorization Cheat Sheet (enforce authz server-side; separate role checks from data-access
  checks; deny by default): https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- Principle applied: **admin ≠ data superuser** — least-privilege for the operator role, chosen so the
  privacy promise to members is structurally true, not policy-only.
