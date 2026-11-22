/**
 * listed-notes.ts: how much of a transaction's note a list carries.
 *
 * Before the limits, a note could be any size: an 8 MB one made every page that listed it
 * 25 to 30 MB, and a few took the hosted server down, so the row couldn't even be opened to delete
 * it. Lists (a register, All transactions, Inbox, Recent activity) now read at most
 * `LISTED_NOTE_CHARS` of a note from SQLite. A note within the limit (1,000 characters a person
 * sees) fits whole; only an older, over-long one is cut, and its row opens, edits and deletes.
 *
 * The grid posts the whole row on every cell save, the note as the list showed it. A note posted
 * exactly as listed is untouched (`isUntouchedNote`): the save leaves the stored one alone, so a cut
 * note is never written back over the full one, and a change to the amount isn't refused for the
 * length of a note the person didn't touch. Editing the note itself replaces it, within the limit.
 */
import type { Database } from 'better-sqlite3';

/** Code points (SQLite's `substr` counts characters, not bytes): twice the note limit, so a note
 *  within it fits whole even when many of its characters are several code points. */
export const LISTED_NOTE_CHARS = 2000;

/** The SQL for a note column as lists carry it. */
export const listedNoteSql = (column: string): string => `substr(${column}, 1, ${LISTED_NOTE_CHARS})`;

/** True when `posted` is row `id`'s note as lists carry it (blank for none): the save didn't touch it. */
export function isUntouchedNote(sqlite: Database, id: string, posted: string): boolean {
	const row = sqlite.prepare(`SELECT ${listedNoteSql('notes')} AS shown FROM transactions WHERE id = ?`).get(id) as
		| { shown: string | null }
		| undefined;
	if (!row) return false;
	return (row.shown ?? '').trim() === posted.trim();
}
