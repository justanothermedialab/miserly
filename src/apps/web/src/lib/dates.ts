/**
 * dates.ts — the ONE display-date format (DL-06). CLIENT-SAFE (no server imports).
 * ============================================================================
 * Every user-facing date renders through here: `6 Aug 2026` everywhere, and the
 * compact `06 Aug` in dense lists (registers, activity feeds) — with the year
 * appended when it isn't the current one, so an old row is never ambiguous.
 * Inputs are ISO `YYYY-MM-DD` (the ledger's PlainDate string) or a full ISO
 * timestamp (only its date part is used). No Intl/locale machinery: the format
 * is fixed by the design language, not by the OS locale.
 * ============================================================================
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * True when `s` is exactly 'YYYY-MM-DD' and a day of the calendar: '2026-02-31' and '2026-13-01'
 * are not (such a date stored once stopped every page that reads its account,
 * because the engine parses each row's date). The one check every date that comes in goes
 * through. Plain arithmetic, so it costs the browser no Temporal; test/real-dates.test.ts holds
 * it to Temporal's own answer.
 */
export function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days;
}

/**
 * A stored 'YYYY-MM-DD' that is not a day of the calendar, read as the nearest day of its year
 * and month that is: '2026-02-31' as '2026-02-28', '2026-13-01' as '2026-12-01'. Every write
 * refuses such a date (`isRealDate`), so only a hand edit of the file or a bug can store one; the
 * read side takes it this way so the row still counts and every page still loads for its holder,
 * where the register shows the stored text and the person can give it a real date (hosted audit
 * H2). A real date, or text not shaped 'YYYY-MM-DD', comes back unchanged.
 */
export function nearestRealDate(s: string): string {
  if (isRealDate(s)) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(s);
  if (!m) return s;
  const y = Math.max(1, Number(m[1]));
  const mo = Math.min(12, Math.max(1, Number(m[2])));
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  const d = Math.min(days, Math.max(1, Number(m[3])));
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parts(iso: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/u.exec(iso);
  if (!m) return null;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return [Number(m[1]), mo, Number(m[3])];
}

/** `2026-08-06` → `6 Aug 2026`. Unparseable input is returned unchanged. */
export function formatDate(iso: string): string {
  const p = parts(iso);
  if (!p) return iso;
  const [y, mo, d] = p;
  return `${d} ${MONTHS[mo - 1]} ${y}`;
}

/**
 * Dense-list form: `2026-08-06` → `06 Aug` in the current year, `06 Aug 2025`
 * otherwise. `todayIso` (YYYY-MM-DD) decides the current year; it defaults to
 * the client clock.
 */
export function formatDateShort(iso: string, todayIso?: string): string {
  const p = parts(iso);
  if (!p) return iso;
  const [y, mo, d] = p;
  const thisYear = todayIso ? Number(todayIso.slice(0, 4)) : new Date().getFullYear();
  const base = `${String(d).padStart(2, '0')} ${MONTHS[mo - 1]}`;
  // Another year shows two digits ("18 Aug 23"): four overflowed the 84 px Date column into Payee,
  // where a click 3 px into Payee opened the date (item 2.5).
  return y === thisYear ? base : `${base} ${String(y % 100).padStart(2, '0')}`;
}

/**
 * Lenient day-first parser for typed dates (the DateField). Accepts `6 Aug 2026`,
 * `6 aug` (current year), `06/08/2026`, `6-8-26`, `6.8.2026` and ISO `2026-08-06`.
 * Returns ISO `YYYY-MM-DD`, or null when the text isn't a real calendar date.
 */
export function parseDate(text: string, todayIso?: string): string | null {
  const t = text.trim().toLowerCase();
  if (t === '') return null;
  const thisYear = todayIso ? Number(todayIso.slice(0, 4)) : new Date().getFullYear();
  let y: number, mo: number, d: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(t);
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = /^(\d{1,2})[\s-]+([a-z]{3,})\.?(?:[\s,-]+(\d{2,4}))?$/u.exec(t))) {
    const idx = MONTHS.findIndex((n) => (m![2] ?? '').startsWith(n.toLowerCase()));
    if (idx < 0) return null;
    d = Number(m[1]);
    mo = idx + 1;
    y = m[3] ? Number(m[3]) : thisYear;
  } else if ((m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/u.exec(t))) {
    d = Number(m[1]);
    mo = Number(m[2]);
    y = m[3] ? Number(m[3]) : thisYear;
  } else {
    return null;
  }
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > dim) return null;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `2026-09` (or a full ISO date) → `September`. */
export function monthName(ym: string): string {
  return MONTHS_LONG[Number(ym.slice(5, 7)) - 1] ?? ym;
}

/** `2026-09` → `Sep 26` (chart ticks and table headers). */
export function monthShort(ym: string): string {
  return `${MONTHS[Number(ym.slice(5, 7)) - 1] ?? ''} ${ym.slice(2, 4)}`;
}
