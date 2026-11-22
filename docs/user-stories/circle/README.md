# Epic 8 — Circle & shared accounts

> The multi-user layer. One self-hosted instance serves a **Circle** — the small group sharing it
> (a family, a couple, roommates, co-investors, a small business). Each member has their own login, and
> **specific accounts can be shared** with chosen members. This epic adds *who* to a model that
> previously assumed a single user — without breaking privacy-by-default or the aggregation contract.

## Vocabulary (deliberately use-case-neutral)

- **Circle** — the people who share this instance. Intentionally **not** "household" (that narrows to
  families; roommates / partners / a club / a small business fit the same shape). The Circle *is* the
  instance — there is exactly one per instance, so it is **UX vocabulary + instance settings, not a
  heavy entity** (no per-user `circle_id` FK; modelling it as data would only pay off for multi-tenant
  SaaS, which we rejected).
- **Member** — a user in the Circle.
- **Shared account** — an account more than one member can see/edit (replaces the narrower "joint"). It
  is about *access sharing*, not legal joint ownership, so "shared" is the more accurate word.
- **Shared view** — the aggregate (net worth / reports) over shared accounts only.
- **Admin** — the member who set up the Circle; manages logins & membership (not data access).

## Why this epic exists (provenance)

The original 7-epic program assumed a **single user**: a `grep` of `docs/` found zero concept of users,
ownership, sharing, or permissions (every "partner" was `transfer_partner_id`). The multi-user decision
was taken in MODE 2 (stack decision **D6**) when the deployment model became **server-centric** (one
homelab server can serve a whole Circle behind logins). The domain was then fully resolved (HH-1…HH-7 in
the MODE-2 plan) before any code. This epic transcribes those locked decisions into the story spine and
is the reason a set of previously-locked stories gained a **viewer-scope** clause (see *Cross-cutting
edits*).

## Goal

Let a Circle share one instance with **individual privacy + selective sharing**: per-member logins;
**personal-by-default** accounts; an owner can grant specific members full access to specific accounts;
net worth and reports are **scoped to the viewer**; cross-member money moves through visible (usually
shared) accounts. Privacy holds for everyone — **even an admin cannot see a member's private accounts.**

## Scope

**In:** members + authentication (admin-gated, admin-creates-login, server-side sessions, Argon2id);
per-account ownership + membership (`owner_id`, `account_members`); admin vs member roles (membership
management only, not data access); cross-member transfers limited to visible accounts + settle-up via
shared accounts; the `entered_by` authorship stamp; instance-wide vs per-user settings split.

**Out / deferred:** public signup & invite-links (admin creates logins in MVP); "pay a member" direct
privacy-respecting settle-up **(B, deferred)**; Splitwise-style IOU / who-owes-whom ledger **(C, deferred
further)**; per-person *economic* attribution of a shared expense (author = who *logged* it, not a split);
encryption-at-rest (deferred v1.x); rich first-run onboarding & import (separate deferred track); 2FA /
passkeys (escape hatch noted in D8); multi-Circle / multi-tenant (this is shared-instance software, not
SaaS).

## Features → stories

### Feature 8.1 — Identity & access
- [**H1** — Circle setup, members & authentication](H1-circle-setup-and-auth.md) — the first user sets
  up the Circle and becomes admin; admin creates member logins; login/logout; server-side sessions;
  Argon2id password hashing; temp password changed on first login. The foundational brick the rest of
  the epic and all per-user scoping depend on.
- [**H2** — Account ownership & sharing](H2-account-ownership-and-sharing.md) — every account has an
  **owner**, is **private by default**; the owner adds specific members who then get **full
  view/edit/add** on that account; a "shared account" = any account with >1 member.
- [**H3** — Roles & membership management](H3-roles-and-membership.md) — **admin** (sets up the Circle,
  manages logins & membership) vs **member**; admin is **not** a data-access superuser; member-removal
  edge cases; the shared category taxonomy is collaboratively editable.

### Feature 8.2 — Money between members
- [**H4** — Cross-member money & settle-up](H4-cross-member-money.md) — transfers restricted to accounts
  the actor can see (own ∪ shared); normal settle-up runs through a shared account; the deferred "pay a
  member" (B) and IOU ledger (C) are recorded here.

## Cross-cutting edits (this epic modifies locked stories rather than duplicating them)

The Circle model is mostly a **scoping clause** layered onto existing logic, so these stories are
*edited*, not re-written:

- **D1/D2/D3** — net worth / allocation / growth become **viewer-scoped** (personal + shared-in-full) +
  a **Shared view**; **no all-Circle total**.
- **D4** — recent activity + account summary are **viewer-scoped** (a member never sees an account they
  don't hold); shared-account rows show **`entered_by`**; a member with nothing owned/shared sees the
  empty state.
- **R2/R3** — reports viewer-scoped (at the viewer's share since 2026-10-20); the by-member
  shared-spending breakdown was dropped 2026-10-30 (R2 RD11).
- **C1/C2** — every transaction stamps **`entered_by`**.
- **C3** — transfer legs limited to **visible accounts**.
- **F2** — categories are **Circle-shared**; last-category memory is **per-user**.
- **F3** — **one canonical deduped payee registry** + **earned-visibility** (a payee becomes visible to
  you only once recorded on an account you can access) + per-user autofill.
- **F1** — opening/creation cross-links to H2 (creator = owner).
- **SET1** — settings split into **instance-wide** (incl. the Circle's display name, base currency,
  number format) vs **per-user**.
- **architecture.md §12** — new "Members, Circle & visibility" section (the *whose net worth* scope
  clause, the new tables, auth).

## Backbone leaned on

[Single source of truth](../../product/architecture.md#1-single-source-of-truth--derived-never-stored)
(scoping filters the account *set*, the derivation is unchanged) ·
[aggregation contract](../../product/architecture.md#5-per-instrument-modules-behind-one-aggregation-contract)
(**unchanged** — visibility filters which accounts feed it, never the contract) ·
[double-entry & transfers](../../product/architecture.md#3-double-entry--transfers) (both legs must be
visible to the actor) · [shared-service discipline](../../product/architecture.md#11-shared-service-discipline--deployment-model)
(one auth/visibility gate, applied everywhere) · **§12 Members, Circle & visibility** (new).

## Key locked decisions

- **Personal-by-default, per-account membership** (HH-1): added = full access (no view-only tier).
- **Viewer-scoped net worth at each holder's share; no all-Circle total** (HH-2; amended 2026-10-20: shares replace the Shared view, see H2) — privacy by construction.
- **Authorship stamp `entered_by`** on every transaction (HH-3); the by-member shared-spending
  breakdown was dropped 2026-10-30 (R2 RD11).
- **Categories shared; payees one canonical registry with earned per-user visibility** (HH-4) — zero
  duplication, no separate per-user search indexes; client caches small reference data and filters
  locally (no per-keystroke round-trip).
- **Transfers among visible accounts only; settle-up via shared accounts** (HH-5); B & C deferred.
- **Admin manages membership, never data access** (HH-6): even admin can't see members' private accounts.
- **Admin-gated onboarding, admin-creates-login** (HH-7); invite-links deferred.
- **"Circle" is use-case-neutral vocabulary, not a DB entity** (2026-06-25) — one Circle per instance;
  the Circle *is* the instance.

## Dependencies

H1 is the **prerequisite** for the entire epic and for every viewer-scoped edit (net worth/reports/
payees can't scope to "the viewer" until members exist). H2 depends on H1 (members to add) and F1
(accounts to share). H3 depends on H1/H2. H4 depends on H2 (visibility) and C3 (the transfer engine).
The cross-cutting edits depend on H1 (a current user) + H2 (the visible-account set).
