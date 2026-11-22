/**
 * clock.ts — "today" for the request being served.
 * ============================================================================
 * A hosted server runs on UTC (Docker), so its own date is yesterday for an Indian user from
 * 00:00 to 05:29. The browser writes its IANA time zone to the `miserly_tz` cookie (app.html);
 * hooks.server.ts runs every request inside `withTimeZone`, and every server "today" reads
 * `appClock()`. The desktop app's server and browser share one zone, so nothing changes there.
 * No cookie yet (the very first request) or an unknown zone: the server's own zone.
 * ============================================================================
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isTimeZone, systemClock, type Clock } from '@miserly/core';

export const TZ_COOKIE = 'miserly_tz';

const store = new AsyncLocalStorage<string | undefined>();
const known = new Map<string, boolean>();

function valid(tz: string | undefined): string | undefined {
  if (!tz || tz.length > 64) return undefined;
  let ok = known.get(tz);
  if (ok === undefined) {
    ok = isTimeZone(tz);
    if (known.size < 500) known.set(tz, ok);
  }
  return ok ? tz : undefined;
}

/** Run `fn` with "today" read in `timeZone` (the viewer's), if it is a real zone. */
export function withTimeZone<T>(timeZone: string | undefined, fn: () => T): T {
  return store.run(valid(timeZone), fn);
}

/** The clock for the current request: the viewer's zone, else the server's. */
export function appClock(): Clock {
  return systemClock(store.getStore());
}
