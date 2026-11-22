/**
 * setup-code.ts: a one-time code for the first-run setup of a hosted instance (H1 RD13, owner
 * 2026-11-12). Until an admin exists, every path leads to /setup for
 * anyone who can reach the port, so the first visitor would own the instance. With
 * MISERLY_SETUP_CODE=on (the Docker image sets it), the server prints a code to its own log at
 * start and /setup asks for it: only someone who can read the server's log can set it up. The
 * desktop app leaves it off (its server listens on 127.0.0.1 only).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

// Crockford's base32 without I, L, O, U: nothing to misread when typed from a log.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let code: string | null = null;

/** True when this server asks for a setup code (the Docker image sets the variable). */
export function setupCodeRequired(): boolean {
  return /^(on|1|true|yes)$/iu.test(process.env.MISERLY_SETUP_CODE ?? '');
}

function newCode(): string {
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => ALPHABET[b % 32]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

/**
 * The code for this run, made and printed to the log the first time it is asked for (at start,
 * from the `init` hook, when no admin exists). The same code holds until the server stops.
 */
export function currentSetupCode(): string {
  if (code === null) {
    code = newCode();
    console.warn(
      `${new Date().toISOString()} miserly setup code: ${code} (type it on the setup page to create the first login)`,
    );
  }
  return code;
}

const canonical = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/gu, '');

/** Whether `typed` is this run's code (dashes, spaces and case don't matter). */
export function setupCodeMatches(typed: string): boolean {
  const want = Buffer.from(canonical(currentSetupCode()));
  const got = Buffer.from(canonical(typed));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Forget the code once the admin exists, so it can't be used again. */
export function retireSetupCode(): void {
  code = null;
}
