/**
 * config.ts — central app configuration (session lifetimes, cookie shape,
 * lockout policy, password policy, db file location).
 * ============================================================================
 * `dbPath()` reads `process.env.MISERLY_DB_PATH` directly — NOT SvelteKit's
 * `$env/dynamic/private` — so this module has zero dependency on the SvelteKit
 * Vite plugin. It must be importable from the standalone `test/` vitest suite
 * (vitest.config.ts deliberately runs `test/**` under plain node, no SvelteKit
 * plugin/alias resolver — see the comment there) as well as from the real app
 * via `$lib/server/config`. Being server-only code under `src/lib/server/`,
 * reading `process.env` directly carries none of the client-bundle-leak risk
 * `$env/dynamic/private` exists to guard against.
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SessionConfig } from './auth/session';

const DAY_MS = 1000 * 60 * 60 * 24;

/** 30-day absolute lifetime, 7-day idle window (H1). */
export const SESSION_CONFIG: SessionConfig = {
  absoluteMs: 30 * DAY_MS,
  idleMs: 7 * DAY_MS,
};

export const SESSION_COOKIE = 'miserly_session';

/**
 * The session cookie's name for a request. Over HTTPS (a proxy with TLS, ORIGIN=https://…) it is
 * `__Host-miserly_session`: browsers keep such a cookie to this exact host, Secure and on path
 * `/`, and never send it to another service on the same host. Over plain HTTP
 * (the desktop app on 127.0.0.1, a trusted home network) the plain name.
 */
export function sessionCookieName(url: URL): string {
  return url.protocol === 'https:' ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
}

export interface SessionCookieOptions {
  readonly path: '/';
  readonly httpOnly: true;
  readonly sameSite: 'lax';
  readonly secure: boolean;
  readonly maxAge: number;
}

/** Cookie attributes for the session cookie. `secure` should reflect the request scheme. */
export function cookieOptions(secure: boolean): SessionCookieOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: (30 * DAY_MS) / 1000, // maxAge is in SECONDS, per the Set-Cookie spec.
  };
}

/** Per-process, per-username failed-login lockout policy (see auth/users.ts). */
export const LOCKOUT = {
  maxAttempts: 10,
  windowMs: 15 * 60 * 1000,
} as const;

/** Length over complexity theatre (OWASP, NIST SP 800-63B); the whole rule is `auth/password-rule.ts`. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Resolve the app database file path, ensuring its parent directory exists.
 * `MISERLY_DB_PATH` (set by Electron/Docker/e2e globalSetup) overrides the
 * dev default of `./data/miserly.db`.
 */
export function dbPath(): string {
  const configured = process.env.MISERLY_DB_PATH;
  const resolved =
    configured && configured.length > 0
      ? path.resolve(configured)
      : path.resolve('./data/miserly.db');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}
