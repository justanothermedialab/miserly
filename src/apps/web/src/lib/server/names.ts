/**
 * names.ts — the canonical name normalization (the identity key of F3 payees).
 * ============================================================================
 * ONE function, `normalizeName`, is the single source of "are these two names
 * the same name?" across all of Foundations:
 *   - `payees.name_normalized` (UNIQUE) — the anti-duplication guarantee: a
 *     payee is looked up / de-duped by its normalized form, so "Amazon",
 *     " amazon " and "AMAZON" resolve to ONE row (F3: `resolvePayee`).
 *   - account-name uniqueness within (module + active set) (F1 validation).
 *   - group-name uniqueness among active groups; category-name uniqueness
 *     within a group (F2 validation).
 *
 * Because it is the identity key, its exact behaviour is load-bearing and must
 * never drift: a change here silently merges or splits existing payees. The
 * adversarial test (plan mutation (a)) drops a step here and proves the
 * dup/false-collision suite goes RED.
 *
 * The normalization, in order:
 *   1. Unicode NFC — canonical-compose so visually identical strings that
 *      differ only in composition (e.g. an accented char as one code point vs
 *      base+combining) compare equal. NFC before case-folding is the standard
 *      order for identity keys.
 *   2. trim — drop leading/trailing whitespace.
 *   3. collapse internal whitespace — any run of whitespace becomes a single
 *      ASCII space, so "Reliance   Fresh" == "Reliance Fresh".
 *   4. lowercase — locale-INDEPENDENT `toLowerCase()` (NOT `toLocaleLowerCase`,
 *      which would make identity depend on the server's locale). Case-insensitive
 *      identity: "HDFC" == "hdfc".
 *
 * The ORIGINAL, user-typed string is preserved separately as the display name
 * (`payees.display_name`, `accounts.name`, …) — normalization is ONLY the
 * comparison/identity key, never what is shown back to the user.
 * ============================================================================
 */

/**
 * The canonical identity form of a human-entered name. Two names are "the same"
 * iff their `normalizeName` outputs are `===`. Pure and deterministic.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

/**
 * True when two human-entered names denote the same identity under
 * `normalizeName`. A readability wrapper for uniqueness checks.
 */
export function namesEqual(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}
