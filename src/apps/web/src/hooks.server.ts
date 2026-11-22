/**
 * hooks.server.ts — THE ONE AUTH GATE (H1).
 * ============================================================================
 * Exactly one `handle`. Every request resolves its session ONCE here and the
 * rest of the app reads `event.locals.user` — no route re-implements this
 * (H1 failure case: "missing auth gate on a route" is a security defect; the
 * gate lives in one place, per shared-service discipline / architecture §11).
 *
 * Route classes, in priority order:
 *   1. Asset paths (`/_app/...` and the named files of static/) pass through. Nothing else
 *      does, a dotted path included.
 *   2. No admin yet (fresh instance): every path except `/setup` redirects to
 *      `/setup` (first-run ceremony); `/setup` itself is allowed through.
 *   3. An admin exists and the path IS `/setup`: redirect to `/` (single
 *      Circle — the ceremony cannot be repeated).
 *   4. `/signin`: if already authenticated, redirect to `/`; otherwise allow.
 *   5. Everything else is PROTECTED: unauthenticated → redirect to
 *      `/signin?redirectTo=<pathname+search>` (deep-link preserved).
 *   6. Forced password change: an authenticated user with `must_change_password`
 *      is redirected to `/change-password` for every path except
 *      `/change-password` and `/signout` (so a forced user can still log out).
 * ============================================================================
 */
import { redirect } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit';
import { validateSession } from '$lib/server/auth/session';
import { adminExists, mustChangePassword } from '$lib/server/auth/users';
import { closeDb, getDb } from '$lib/server/db/instance';
import { SESSION_CONFIG, sessionCookieName } from '$lib/server/config';
import { getUserPrefs } from '$lib/server/settings';
import { TZ_COOKIE, withTimeZone } from '$lib/server/clock';
import { inLedgerScope } from '$lib/server/ledger-cuts';
import { writeRequest } from '$lib/server/write-gate';
import { ACCENTS, type Accent } from '$lib/prefs';
import { accentCss, accentTokens, WINDOWS_ACCENT_COOKIE } from '$lib/accent';
import { currentSetupCode, setupCodeRequired } from '$lib/server/auth/setup-code';

// At start, a hosted instance with no admin prints its setup code to the log (H1 RD13, S8).
export const init: ServerInit = async () => {
  if (setupCodeRequired() && !(await adminExists(getDb().db))) currentSetupCode();
  // Adapter-node emits this once the server has stopped taking requests (SIGTERM or SIGINT,
  // after open requests finish or SHUTDOWN_TIMEOUT closes them). Closing the database then folds
  // its write-ahead file in, so a stop leaves one complete file.
  process.once('sveltekit:shutdown', closeDb);
};

// Only SvelteKit's built assets and the files in static/ skip the gate. Any other path, a dotted
// one included, is gated: a pattern for "looks like a file" let `/accounts/x.y` through
// unsigned, held only by each route's own check. A file added to static/
// is added here too (test/hosted-security.test.ts compares the two). SvelteKit's data fetches
// (`/route/__data.json`) carry route data and always go through the gate.
const STATIC_FILES = new Set(['/favicon.svg', '/manifest.webmanifest', '/robots.txt', '/THIRD-PARTY-NOTICES.txt']);

const SIGNED_OUT_BODY_LIMIT = 64 * 1024;

function isAssetPath(pathname: string): boolean {
  return pathname.startsWith('/_app/') || STATIC_FILES.has(pathname);
}

// The last signed-in theme on this device, so the signed-out screens (sign-in, setup) paint in
// it too. Without it a Light app on a dark Windows opened on a dark sign-in screen, then turned
// light after signing in (the owner's "black then white", seen in the real window, part 2).
const THEME_COOKIE = 'miserly_theme';
type Theme = 'light' | 'dark' | 'black';
const isTheme = (t: string | undefined): t is Theme => t === 'light' || t === 'dark' || t === 'black';
// The accent colour (SET1) rides the same first byte, so nothing flashes Ink
// before a chosen accent. Ink is the CSS default and needs no attribute.
const ACCENT_COOKIE = 'miserly_accent';
const isAccent = (a: string | undefined): a is Accent => !!a && a !== 'ink' && (ACCENTS as readonly string[]).includes(a);

// "Windows accent": the desktop shell puts the person's Windows colour in a
// cookie; its tokens are solved here and written into the first byte with the attribute. Without the
// cookie (a browser) the choice falls back to Ink.
function windowsAccentStyle(event: Parameters<Handle>[0]['event']): string | null {
  const t = accentTokens(event.cookies.get(WINDOWS_ACCENT_COOKIE) ?? '');
  return t ? `<style id="win-accent">${accentCss('windows', t)}</style>` : null;
}

function withTheme(theme: Theme | undefined, event: Parameters<Handle>[0]['event'], resolve: Parameters<Handle>[0]['resolve'], accent?: Accent) {
  const winStyle = accent === 'windows' ? windowsAccentStyle(event) : null;
  if (accent === 'windows' && !winStyle) accent = undefined;
  if ((!theme && !accent) || event.isDataRequest) return resolve(event);
  const attrs = (theme ? ` data-theme="${theme}"` : '') + (accent ? ` data-accent="${accent}"` : '');
  return resolve(event, {
    transformPageChunk: ({ html }) => {
      const out = html.replace('<html lang="en">', `<html lang="en"${attrs}>`);
      return winStyle ? out.replace('</head>', `${winStyle}</head>`) : out;
    },
  });
}

// The second line if a first one fails later: no sniffing a type, no
// address sent to another site, and no other site may frame the app. A full
// Content-Security-Policy is left out until the desktop window can be checked with it.
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
};

// Every request runs in the viewer's time zone, so "today" is their calendar day.
export const handle: Handle = async ({ event, resolve }) => {
  let tz: string | undefined;
  try {
    tz = decodeURIComponent(event.cookies.get(TZ_COOKIE) ?? '') || undefined;
  } catch {
    tz = undefined;
  }
  // One request, one sum of the ledger (`inLedgerScope`): the layout and the page share it.
  const run = () => withTimeZone(tz, () => inLedgerScope(() => gate({ event, resolve })));
  // A request that writes waits while an import runs alone (`write-gate.ts`); reads go on.
  const method = event.request.method;
  const response = await (method === 'GET' || method === 'HEAD' ? run() : writeRequest(run));
  try {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!response.headers.has(name)) response.headers.set(name, value);
    }
  } catch {
    // A response with fixed headers is served as it is rather than failing the request.
  }
  return response;
};

const gate: Handle = async ({ event, resolve }) => {
  if (!event.isDataRequest && isAssetPath(event.url.pathname)) {
    return resolve(event);
  }

  const { db } = getDb();

  // 1. Resolve identity ONCE.
  const token = event.cookies.get(sessionCookieName(event.url));
  let user = null;
  if (token) {
    user = await validateSession(db, token, SESSION_CONFIG);
    if (!user) {
      event.cookies.delete(sessionCookieName(event.url), { path: '/' });
    }
  }
  event.locals.user = user;

  // A body sent with no session is turned away before anything reads it, unless it is small and
  // says how small. The server's limit is 64 MB for the import's zip, but the
  // only forms a signed-out person sends (sign-in, setup) need a few hundred bytes.
  if (!user && event.request.method !== 'GET' && event.request.method !== 'HEAD') {
    const declared = event.request.headers.get('content-length');
    if (declared === null) return new Response('Length required', { status: 411 });
    const bytes = Number(declared);
    if (!Number.isFinite(bytes) || bytes > SIGNED_OUT_BODY_LIMIT) {
      return new Response('Request too large', { status: 413 });
    }
  }

  const savedTheme = event.cookies.get(THEME_COOKIE);
  const signedOutTheme = isTheme(savedTheme) ? savedTheme : undefined;
  const savedAccent = event.cookies.get(ACCENT_COOKIE);
  const signedOutAccent = isAccent(savedAccent) ? savedAccent : undefined;

  // Route-class checks compare against the PAGE path: a data request for
  // `/signin` arrives as `/signin/__data.json` and must classify identically.
  const pathname = event.url.pathname.replace(/\/__data\.json$/u, '') || '/';
  const hasAdmin = await adminExists(db);

  // 2 / 3. First-run ceremony gate.
  if (!hasAdmin) {
    if (pathname !== '/setup') {
      throw redirect(303, '/setup');
    }
    return withTheme(signedOutTheme, event, resolve, signedOutAccent);
  }
  if (pathname === '/setup') {
    throw redirect(303, '/');
  }

  // 4. Sign-in page.
  if (pathname === '/signin') {
    if (user) throw redirect(303, '/');
    return withTheme(signedOutTheme, event, resolve, signedOutAccent);
  }

  // 5. Everything else requires a session.
  if (!user) {
    const redirectTo = encodeURIComponent(pathname + event.url.search);
    throw redirect(303, `/signin?redirectTo=${redirectTo}`);
  }

  // 6. Forced password change wins over normal protected access.
  if (pathname !== '/change-password' && pathname !== '/signout') {
    if (await mustChangePassword(db, user.id)) {
      throw redirect(303, '/change-password');
    }
  }

  // Paint the viewer's explicit Light/Dark choice in the first HTML byte. Applied only by the
  // client after hydration, a Light app on a dark OS (or the reverse) loaded dark, then
  // flipped to light on every launch and reload (hunt H-theme-A). 'system' needs nothing:
  // the CSS follows prefers-color-scheme from the first paint.
  const { theme, accent } = await getUserPrefs(db, user.id);
  if (isAccent(accent)) {
    if (savedAccent !== accent) {
      event.cookies.set(ACCENT_COOKIE, accent, { path: '/', httpOnly: true, sameSite: 'lax', secure: event.url.protocol === 'https:', maxAge: 365 * 24 * 3600 });
    }
  } else if (savedAccent) {
    event.cookies.delete(ACCENT_COOKIE, { path: '/' });
  }
  if (isTheme(theme)) {
    if (savedTheme !== theme) {
      event.cookies.set(THEME_COOKIE, theme, { path: '/', httpOnly: true, sameSite: 'lax', secure: event.url.protocol === 'https:', maxAge: 365 * 24 * 3600 });
    }
  } else if (savedTheme) {
    event.cookies.delete(THEME_COOKIE, { path: '/' });
  }
  return withTheme(isTheme(theme) ? theme : undefined, event, resolve, isAccent(accent) ? accent : undefined);
};
