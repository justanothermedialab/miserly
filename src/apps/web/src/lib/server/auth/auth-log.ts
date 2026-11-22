/**
 * auth-log.ts: one line in the server's log for each sign-in failure, lock, password reset and
 * member added or removed, so a guessing run or a reset leaves a trace in
 * `docker logs`. Never a password. Usernames are typed by whoever sends the form, so each is
 * quoted, escaped and cut short: a name with a newline can't write a second line.
 */
export type AuthEvent = 'sign-in failed' | 'sign-in locked' | 'password reset' | 'member added' | 'member removed';

const quoted = (s: string) => JSON.stringify(s.slice(0, 64));

/** The client's address, or "unknown" where the server can't tell (a test, an odd adapter). */
export function clientAddress(event: { getClientAddress?: () => string }): string {
  try {
    return event.getClientAddress?.() ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function logAuthEvent(what: AuthEvent, fields: { username: string; address: string; by?: string }): void {
  const by = fields.by === undefined ? '' : `, by ${quoted(fields.by)}`;
  const address = fields.address.replace(/[^0-9a-fA-F.:[\]%a-zA-Z-]/gu, '?');
  console.warn(`${new Date().toISOString()} miserly ${what}: username ${quoted(fields.username)}${by}, address ${address}`);
}
