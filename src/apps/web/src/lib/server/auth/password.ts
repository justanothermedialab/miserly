/**
 * password.ts — Argon2id password hashing (the H1 secret-storage primitive).
 * ============================================================================
 * Passwords are stored ONLY as Argon2id hashes — never plaintext, never a
 * reversible form, never logged (H1 acceptance criteria; a plaintext/weak-hash
 * store is a P0 defect). Argon2id is the OWASP-recommended algorithm (RFC 9106);
 * `@node-rs/argon2` is the lib named in H1 (Resolved decision 2).
 *
 * The encoded hash is a self-describing PHC string
 * (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`) — it carries its own params
 * and salt, so `verifyPassword` needs no external state, and `needsRehash` can
 * detect a hash made with weaker params so the caller can transparently re-hash
 * on the next successful login (H1 operational requirement — raise cost over
 * time without forcing resets).
 * ============================================================================
 */
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { Algorithm } from '@node-rs/argon2';

// `Algorithm` is an ambient `const enum`, which `verbatimModuleSyntax` forbids
// importing as a value — so we use the literal (Argon2id === 2) with a typed
// cast. This stays explicit (we do NOT rely on the library's default algorithm).
const ARGON2ID = 2 as Algorithm;

/**
 * OWASP Password Storage Cheat Sheet — Argon2id minimum:
 *   memory = 19 MiB (19456 KiB), iterations = 2, parallelism = 1.
 * Kept in ONE constant so cost can be raised over time (verify re-hashes when it
 * changes — see `needsRehash`). NOTE: `@node-rs/argon2`'s OWN defaults are weaker
 * (m=4096, t=3), so these MUST be passed explicitly.
 */
export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Hash a plaintext password with the current Argon2id params. Never logs input. */
export function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_PARAMS);
}

/**
 * Verify a plaintext password against a stored Argon2id PHC hash. Params/salt are
 * read from the encoded string, so no options are needed. Returns false (never
 * throws) on a malformed/mismatched hash, so a bad stored value fails closed.
 */
export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(encoded, password);
  } catch {
    return false;
  }
}

/**
 * True if `encoded` was produced with params weaker than the current
 * `ARGON2_PARAMS` (or a non-argon2id variant) — the caller should then re-hash
 * the (already-verified) password and persist the stronger hash. A hash that
 * can't be parsed is treated as needing a rehash (fail toward strengthening).
 */
export function needsRehash(encoded: string): boolean {
  const m = /^\$argon2(id|i|d)\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(encoded);
  if (!m) return true;
  const [, variant, memory, time, parallel] = m;
  return (
    variant !== 'id' ||
    Number(memory) < ARGON2_PARAMS.memoryCost ||
    Number(time) < ARGON2_PARAMS.timeCost ||
    Number(parallel) < ARGON2_PARAMS.parallelism
  );
}
