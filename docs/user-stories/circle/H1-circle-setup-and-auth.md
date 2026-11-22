# H1 — Circle setup, members & authentication (admin-gated logins · sessions)

> **Epic:** Circle & shared accounts · **Story:** H1 · **Status:** LOCKED (2026-06-25)
> **MVP scope:** CRUD + auth, zero intelligence. Provenance: MODE 2 decision D6 (multi-user) + D8 (auth).

---

## Title
As the first user, I set up the **Circle** and become its **admin**; I can create a login for each
member (family, roommates, partners, co-investors…); and every member can sign in to their own private
space — so that one self-hosted instance safely serves a whole group behind individual logins.

## ELI5
Right now the app assumes one person. But a group shares one server. So before anyone can have "their
own accounts" or "our shared account," the app needs to know **who is who**. This story is "set up the
Circle, let the admin hand out logins, and let each person sign in." It's the door and the keys —
nothing about *sharing* works until there are distinct people to share between. "Circle" is deliberately
neutral — it's whoever shares the instance, not specifically a family.

## Business context
This is the **foundational brick of the multi-user model** — the analogue of F1 for identity. Three
locked decisions land here:

1. **One Circle, admin-gated membership (HH-7).** The first user to set up the instance creates the
   **Circle** and becomes its **admin**. There is **no public signup** — the admin creates each
   member's login (username + temporary password, changed on first sign-in). This matches the
   self-hosted, private positioning: we are not custodying strangers' data, so we don't need email
   verification, captchas, social login, or password-reset email flows. Firefly III (the closest
   self-hosted analogue) similarly runs a single instance with multiple users and an admin/owner role,
   and lets the operator disable open registration.

2. **Thin, owned session auth (D8).** Authentication is **server-side sessions**, not JWT: on login the
   server stores a session row in SQLite and sets an opaque `HttpOnly` cookie; every request resolves
   the cookie → session → user in a SvelteKit `hooks.server` handler. Passwords are hashed with
   **Argon2id** (the OWASP-recommended algorithm; RFC 9106). We deliberately do **not** adopt a heavy
   auth framework — the surface is tiny (login, logout, change-password, admin-create-user) and owning
   ~150 understandable, property-tested lines beats carrying a large dependency used at ~10%. (`better-auth`
   is the noted escape hatch *if* 2FA/passkeys are ever wanted.)

3. **"Circle" is vocabulary, not a heavy entity.** Exactly one Circle exists per instance, so the Circle
   *is* the instance: there is **no `circle` table carrying meaning and no per-user `circle_id` FK** (a
   one-row table / constant FK earns nothing; it would only pay off under multi-tenant SaaS, which we
   rejected). The Circle's **display name** and instance-wide preferences (base currency, number format)
   live in the **SET1 settings store, tagged instance-wide**. Schema added here is just **`users`** +
   **`sessions`** (ownership/membership land in H2).

Why this is a *story* and not just plumbing: it defines the **Circle boundary** every other story scopes
against ("the viewer", "accessible accounts"), the **admin vs member** distinction (H3), and the
**first-run** that precedes even creating the first account.

## User workflow

### Happy path — first-run (set up the Circle)
1. A fresh instance has **no users**. The first load shows a **Set up your Circle** screen.
2. The user sets the **admin username + password** (and an optional **Circle display name**, e.g. "Flat
   4B" or "The Sharmas" — free text, no semantics).
3. On save: the admin `user` is created with an Argon2id password hash, the Circle name is stored as an
   instance-wide setting, a session is started, and the user lands in the normal (empty) app — which
   then flows into F1 (add your first account).

### Happy path — admin creates a member
1. Admin → **Settings → Members → Add member**.
2. Admin enters the member's **username** and a **temporary password** (or the system generates one).
3. The member `user` is created with `must_change_password = true`. The admin communicates the temp
   credential out-of-band (it's a private network; no email machinery).

### Happy path — member signs in (first time)
1. Member opens the instance URL → **Sign in** → enters username + temp password.
2. Because `must_change_password` is set, they're immediately required to **set a new password** before
   reaching the app.
3. After changing it, a session is started and they land in their own (private, possibly empty) space.

### Happy path — sign in / sign out (returning)
- **Sign in:** username + password → on success, a new session row + cookie; on failure, a generic
  "invalid username or password" (never reveal which).
- **Sign out:** deletes the current session row and clears the cookie (revocation is immediate because
  sessions are server-side).

### Alt path — change own password
- Any signed-in user → **Settings → Change password** *(since 2026-10-20: the account menu,
  top right → Change password, a dialog; the `/change-password` page stays for the forced change)*:
  verify current password, then set a new one;
  **all *other* sessions for that user are invalidated** (current one rotated/kept).

### Recovery path — forgotten password (no email)
- **Admin resets it:** admin sets a new temporary password for the member (`must_change_password = true`
  again). This is the MVP recovery path — deliberate, given no email flows. **Edge: the admin's own
  forgotten password** → recoverable only via a documented CLI/server-side reset (operator access to the
  box), since no one can reset the admin from inside the app.

## Acceptance criteria
- [ ] On a fresh instance (zero users), the only reachable screen is **set up Circle + admin**; all app
      routes redirect there until an admin exists.
- [ ] Exactly **one Circle** exists per instance (MVP); the creator is its **admin**. The Circle name is
      stored as an **instance-wide setting** (SET1), not as a dedicated entity.
- [ ] Passwords are stored only as **Argon2id** hashes — never plaintext, never a reversible form;
      the raw password is never logged.
- [ ] The admin can create a member login (username + temp password); the new user has
      `must_change_password = true`.
- [ ] A user with `must_change_password` is forced through **set-new-password** before any app route is
      usable.
- [ ] Sign-in success creates a **server-side session row** + sets an **`HttpOnly`, `SameSite=Lax`**
      cookie (`Secure` in hosted/HTTPS mode); sign-in failure returns a **generic** error.
- [ ] Sign-out deletes the session row and clears the cookie; the session is immediately unusable.
- [ ] Every non-auth route requires a valid session; an unauthenticated request is redirected to
      sign-in (deep-link preserved as redirect target).
- [ ] Changing one's password invalidates the user's **other** sessions.
- [ ] Sessions **expire** after an absolute lifetime and are **rotated** on login; expired/return checks
      happen centrally in one `hooks.server` gate (shared-service discipline).
- [ ] A signed-in request exposes the **current user + role** to the rest of the app as the basis for
      all visibility scoping (H2/D/R/F).

## Validation rules
- **Username:** required, non-empty trimmed, **unique within the Circle**, case-insensitive compare;
  a sensible charset/length limit.
- **Password (set/change):** at least 10 characters, not the username, not a common password (RD11;
  per OWASP and NIST, favour length over complexity
  theatre); reject the known temp password on first change; no maximum so low it truncates Argon2 input.
- **Circle display name:** optional free text; no uniqueness/semantics (it labels the instance only).
- **Temp password:** single-use intent — `must_change_password` forces replacement before app access.
- **Role:** ∈ {admin, member}; exactly one admin in MVP (see Resolved decisions for multi-admin).
- **Session:** opaque high-entropy id; server stores a **hash** of the token (so a DB read can't
  impersonate); absolute expiry; bound to the user.

## Edge cases
- **Fresh instance / no users:** must not 500 or expose app data — only the set-up-Circle flow.
- **Second "set up Circle" attempt** once an admin exists: blocked (single Circle, MVP).
- **Admin creates a username that collides** with an existing (active) user: rejected with a clear
  message.
- **Member never changes the temp password:** they remain stuck on the change-password screen; no app
  access leaks.
- **Concurrent sessions** (same user, two devices): allowed; each is its own row; sign-out affects only
  the current one (except password-change, which clears the others).
- **Clock/expiry boundary:** a session exactly at expiry is treated as expired (fail closed).
- **Admin removes/relabels themselves:** must not be able to leave the Circle admin-less (block the
  last-admin demotion/removal — overlaps H3).
- **Last-admin lockout (forgotten admin password):** only the documented server-side/CLI reset recovers
  it — called out so it isn't a surprise.

## Failure cases
- **Plaintext or weak-hash storage:** a **P0 defect** — passwords are Argon2id only. (Echoes the §1
  "derived/never-stored" discipline: secrets are never stored in a recoverable form.)
- **User-enumeration leak:** sign-in, password-reset, and create-user errors must not reveal whether a
  username exists (generic messages).
- **Session fixation:** the session id must be **regenerated on login** (never reuse a pre-login id).
- **Missing auth gate on a route:** any route reachable without the central session check is a security
  defect — the gate lives in **one** place (`hooks.server`), never re-implemented per route.
- **Token stored unhashed server-side:** a DB read would then equal account takeover — store a hash.
- **Local/desktop mode false-sense-of-security:** Electron binds the server to `127.0.0.1`; auth still
  applies (a Circle may share the desktop too), but the threat model differs from hosted — documented,
  not skipped.

## UX considerations
- **First-run is a one-screen ceremony**, then it hands off to F1 (add first account) — the multi-user
  setup must not bury the make-or-break "log your first transaction" moment.
- **Member management is plain and unscary:** a Members list, an Add button, a Reset-password action —
  no role matrices or permission grids (permissions are per-account, set elsewhere in H2).
- **Forced password change is explained**, not abrupt ("Set your own password to continue").
- **Sign-in is minimal:** username, password, one button; generic error; no social buttons, no "sign up"
  link (there is no public signup).
- **Desktop mode:** if a single person uses Electron, sign-in should be quick (remember the session via
  the cookie); a Circle sharing one desktop still benefits from distinct logins.
- **"Circle" copy stays neutral** — never assume "family"; the optional Circle name lets users self-label
  (a flat, a couple, a business).

## Operational considerations
- **One central auth gate** (`hooks.server`) resolves the session and attaches `currentUser` — this is
  the shared service every scoped query reads; no route re-implements it (§11).
- **Argon2id parameters** (memory/iterations/parallelism) follow current OWASP guidance and live in one
  config constant so they can be tuned/raised over time; password verification should transparently
  **re-hash on login** if parameters change.
- **Sessions/users tables** are part of the schema baked in now, with the sync-ready conventions (UUID
  PKs, timestamps, soft-delete where relevant) used elsewhere. **No `circle` entity** — the Circle name
  is an instance-wide SET1 setting.
- **No telemetry / phone-home** (consistent with the local-first privacy ethos): auth events may be
  logged locally only.
- **Backup:** users/sessions live in the same SQLite file that is the canonical backup; a restore brings
  identities back intact (sessions may be invalidated on restore — acceptable).
- **Hosted vs desktop:** `Secure` cookie + HTTPS expected in hosted mode; documented reverse-proxy
  guidance is an ops concern, not a story requirement.

## Resolved decisions (locked 2026-06-25)
1. **Server-side sessions, not JWT** — revocable, simple, one server with the DB right there; logout and
   password-change invalidation are trivial. (D8)
2. **Argon2id password hashing** (`@node-rs/argon2`), parameters per OWASP, re-hash-on-login when tuned.
3. **Admin-gated, admin-creates-login; no public signup, no OAuth, no email/reset flows** (HH-7) — the
   private-instance model. Member password recovery = admin reset; admin recovery = server-side/CLI.
4. **Thin owned auth, not a framework** (D8) — tiny surface, property-tested; `better-auth` is the noted
   escape hatch only if 2FA/passkeys are later wanted.
5. **One Circle per instance (MVP); "Circle" is use-case-neutral vocabulary, not a DB entity** — the
   Circle *is* the instance; its name is an instance-wide setting. Multi-Circle/tenant is out of scope.
6. **Exactly one admin in MVP**, with **block-the-last-admin-removal** safety; promoting a second admin
   is a small, easy follow-up (noted in H3), not built now.
7. **Temp-password + forced change** on first sign-in; `must_change_password` gates all app access.
8. **Session token stored hashed**, regenerated on login (anti-fixation), absolute expiry, central gate.

**Amendments (2026-10-10, after a review of the app's screens):**

9. **The first-run screen leads with the login in plain words.** Title "Create your login", button
   "Create login"; the same fields; the Circle name comes last as "Group name (optional), if others
   will use this app too" (Settings names it the same). The screen no longer opens on the group
   concept, which a solo desktop user meets first. Happy path step 1's "Set up your Circle" title is
   superseded; the steps are otherwise unchanged. When set, the name shows under the user's name in
   the sidebar and atop the account menu. *(Amended 2026-10-21: the sidebar's user footer
   went with the title-bar redesign; the name shows in the account menu only.)*
10. **On screen it is "group", never "Circle"** (2026-10-10). Settings' card
    is "Group", sign-in says "Ask your group's admin for a login", the share flyout says "Everyone
    in your group already has access", removing a member asks "Remove … from the group?". "Circle"
    stays the name in the specs and the code (H1 to H4, `getCircleName`); it is not UI copy.
11. **One password rule: 10 characters, not the username, not a common password**
    (2026-11-12, after a security read). Every password set or changed (setup, add member, a
    reset's temporary one, change password) is at least 10 characters, is not the username (nor the
    username repeated), and is not in a built-in list of the most common passwords (9,113 entries
    of 10 characters or more from the UK NCSC's top 100,000, as kept in SecLists, MIT; a file in
    the app, nothing looked up). No composition rules ("a capital and a digit"), as NIST SP 800-63B
    advises. Existing passwords keep working: the rule applies when one is set. The messages: "Use
    at least 10 characters.", "The password can't be your username.", "That password is one of the
    most common. Choose another." The list was added under "best practices" and may be
    dropped. Replaces the 8-character minimum.
12. **Sign-in tries are counted before the password is checked** (after a security read): the eleventh
    try in 15 minutes is refused however the tries are timed, and at most two password checks run
    at once. Each failed sign-in, a lock, a reset and a member added or removed writes one line to
    the server's log (time, username, address; never a password).
13. **A setup code for a hosted instance** (2026-11-12, after a security read). Until an
    admin exists, anyone who reaches the port is sent to setup and would own the instance. With
    `MISERLY_SETUP_CODE=on`, which the Docker image sets, the server prints a one-time code to its
    log at start ("miserly setup code: K7QM-2PXD-9TRA") and the setup screen asks for it first
    ("Setup code", "Printed in the server's log when it started"). A missing or wrong code is
    refused and makes nothing. The code is forgotten once the admin exists, and a restart before
    that prints a new one. The desktop app leaves it off: its server listens on 127.0.0.1 only. Two
    setups sent at the same moment make one admin (the check and the insert are one step).
14. **HTTPS behind a proxy is the normal way to host; plain HTTP is for a trusted home network**
    (2026-11-12, after a security read). The compose file binds Miserly's port to
    127.0.0.1 and carries a commented Caddy service and `Caddyfile.example` (a host name of its own,
    TLS); the guide says the same and calls plain HTTP fit only for a network where every device is
    trusted. The app does not refuse HTTP. Over HTTPS the session cookie is named
    `__Host-miserly_session`, which browsers keep to that one host name (Secure, path `/`), so other
    apps on the same machine never receive it; over HTTP it keeps the plain name.
15. **Setup asks for the currency for totals and the year start** (2026-11-18; MC1
    RD2, R1 RD10). Under the group name, two fields side by side: "Currency for totals" (the
    supported currencies with two decimals, INR first and chosen; not JPY) and "Year starts in"
    (January or April). April is chosen while INR is picked and January for any other currency,
    until the person picks a month themselves. Both are written in the same transaction as the
    first admin (`circle.base_currency`, `circle.year_start` in `instance_settings`; no schema
    change). An instance set up before this has neither row and reads INR and April, so nothing
    it shows changes. Neither can be changed after setup in the first release.

## Dependencies
- **Depends on:** the server-centric architecture (D3) + SvelteKit full-stack (D7) + Drizzle/SQLite
  (D9) — auth is a server concern with a DB; there is no browser-only auth path. The Circle name reuses
  the **SET1** settings store.
- **Blocks:** the **entire Circle epic** (H2 needs members to add; H3 needs roles; H4 needs visibility)
  **and every viewer-scoped edit** (D1/D2/D3, R2/R3, F2/F3, C1/C2 `entered_by`) — none can reference
  "the current user / the viewer's visible set" until users + sessions exist.
- **Related / shared primitive:** the **current-user + visible-account-set** resolved here is the input
  to H2's membership checks and is consumed by the aggregation service (architecture §12).
- **Precedes (does not include):** rich first-run onboarding & import (separate deferred track); H1 is
  only the identity ceremony, not the data-onboarding experience.

---

### Research sources
- OWASP — Password Storage Cheat Sheet (Argon2id recommended; tuning guidance): https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP — Session Management Cheat Sheet (server-side sessions, fixation, expiry, cookie flags): https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP — Authentication Cheat Sheet (generic errors / anti-enumeration, password policy): https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- RFC 9106 — Argon2 memory-hard password hashing (Argon2id): https://www.rfc-editor.org/rfc/rfc9106
- Firefly III — self-hosted multiple users, admin/owner role, registration control (the closest self-hosted multi-user analogue): https://docs.firefly-iii.org/
- SvelteKit — server hooks (`handle`) for centralised session resolution & route protection: https://svelte.dev/docs/kit/hooks
