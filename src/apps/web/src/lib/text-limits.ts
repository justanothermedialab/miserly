/**
 * text-limits.ts: the one set of maxima for typed text, shared by
 * the server's checks and the inputs' `maxlength`.
 *
 * Miserly's server is shared by everyone in the Circle, so one huge name or note costs every member
 * every page and a few huge notes took the server down. The maxima follow YNAB (payee 200,
 * memo 500), Firefly III (category 100, description 1,000) and Lunch Money (payee 255). Over a limit
 * is refused with a message, never cut.
 *
 * Counted as characters a person sees (grapheme clusters, `Intl.Segmenter`), so an accented name or
 * an emoji counts once. A browser's `maxlength` counts UTF-16 units instead, which is stricter for
 * emoji and never looser, so the box and the server agree for ordinary text. A ceiling in UTF-16
 * units (8 per character) stops a "short" string built from thousands of combining marks.
 *
 * Control characters and the text-direction overrides (U+202A to U+202E, U+2066 to U+2069) are
 * refused: a NUL in a name, or a right-to-left override that makes "exe.txt" read as "txt.exe",
 * shows something other than what is stored. A note or a detail may hold line breaks and tabs.
 */

export const TEXT_LIMITS = {
	/** An account's, a category's or a group's name. */
	name: 100,
	/** A payee's name. */
	payee: 200,
	/** A transaction's note, a transfer's note, a value update's memo. */
	note: 1000,
	/** An account's details (S5 informational fields). */
	details: 4000,
	/** The Circle's name and a person's display name. */
	displayName: 100,
	username: 64,
	/** NIST SP 800-63B: allow at least 64. Counted in code points, as NIST counts. */
	password: 1024
} as const;

export type TextKind = keyof typeof TEXT_LIMITS;

// C0 controls, DEL and C1 controls; tab, line feed and carriage return are allowed where noted.
// eslint-disable-next-line no-control-regex
const CONTROL_SINGLE = /[\u0000-\u001F\u007F-\u009F]/u;
// eslint-disable-next-line no-control-regex
const CONTROL_MULTI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const BIDI = /[‪-‮⁦-⁩]/u;

let segmenter: Intl.Segmenter | undefined;

/** The number of characters a person sees in `s`, counting no further than `stop`. */
export function visibleLength(s: string, stop = Infinity): number {
	segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
	const graphemes = segmenter.segment(s)[Symbol.iterator]();
	let n = 0;
	while (n <= stop && !graphemes.next().done) n++;
	return n;
}

/** True when `s` holds at most `max` characters a person sees (and isn't padded past them). */
export function fitsLength(s: string, max: number): boolean {
	if (s.length <= max) return true; // a character is at least one UTF-16 unit
	if (s.length > max * 8) return false;
	return visibleLength(s, max) <= max;
}

/** True when `s` holds a control character or a text-direction override. */
export function hasHiddenCharacters(s: string, multiline = false): boolean {
	return (multiline ? CONTROL_MULTI : CONTROL_SINGLE).test(s) || BIDI.test(s);
}

export const HIDDEN_CHARACTERS_MESSAGE = 'Remove the hidden characters (control or text-direction marks)';

/** The message for text over `max` characters. */
export function tooLongMessage(max: number): string {
	return `Use ${max.toLocaleString('en-IN')} characters or fewer`;
}

/**
 * The problem with a typed text of this kind, in the person's words, or null when it is fine.
 * Notes and details may hold line breaks; names may not.
 */
export function textProblem(s: string, kind: Exclude<TextKind, 'password'>): string | null {
	const multiline = kind === 'note' || kind === 'details';
	if (hasHiddenCharacters(s, multiline)) return HIDDEN_CHARACTERS_MESSAGE;
	const max = TEXT_LIMITS[kind];
	if (!fitsLength(s, max)) return tooLongMessage(max);
	return null;
}
