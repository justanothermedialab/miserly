/**
 * columns.svelte.ts — the register's and All transactions' column widths.
 * ============================================================================
 * Fluent's Table model (@fluentui/react-table, `columnResizeUtils`): each column has a minimum and
 * an ideal width, and the columns fit the container, giving way toward their minimums from the
 * last one when there isn't room. Apple's macOS rule (HIG, Lists and tables): "Let people resize
 * columns." Before, Account was a fixed 128 px and read "HDFC (Bank a…" while Payee had 160 px
 * idle and an empty Notes held 16 % of the table.
 *
 * A text column's ideal width fits its longest cell, between its minimum (its heading) and its
 * maximum; a column with nothing in it keeps its minimum; the `fill` column (Payee) takes the
 * rest. Amount columns fit their widest figure too (Actual's rule; "₹22,46,700.00" ran 5 px into
 * a fixed 104 px column's padding) and never give way. Text widths come from a table of the font's
 * character widths, not a measurement, so the server draws the same widths the browser keeps:
 * nothing moves on load. A window too narrow for the ideal widths has the text columns give way
 * (Notes first) down to their minimums.
 *
 * A drag on a heading's right edge sets that column's width; a double-click there fits it again.
 * Set widths live in the `miserly_cols` cookie, so the server draws them too, with the table's
 * width when last seen, so the server squashes a narrow window's columns as the browser will.
 * ============================================================================
 */
import { untrack } from 'svelte';

export const COLS_COOKIE = 'miserly_cols';

/** 14 px Segoe UI Variable Text (the app's first font) or Arial/Inter, whichever is wider, per
 *  character, measured in Edge. Anything else counts as a digit's width. */
const CHAR_WIDTHS: [string, number][] = [
	["'", 3.2], ['ijl', 3.4], ['|', 3.6], [' ,.:;I', 3.9], ['!', 4.0], ['[]', 4.2], ['f', 4.4],
	['()`t{}', 4.7], ['r', 4.9], ['\\', 5.3], ['"/', 5.5], ['-', 5.6], ['*', 5.8], ['Jcksvxyz', 7.0],
	['0123456789$?L_ae₹', 7.8], ['hnu', 7.9], ['bdgopq', 8.2], ['#', 8.3], ['FTZ', 8.6],
	['ABEKPSVXY', 9.3], ['+<=>^~−', 9.6], ['CDHRUw', 10.1], ['N', 10.5], ['GOQ', 10.9], ['&', 11.2],
	['m', 12.1], ['%', 12.4], ['M', 12.6], ['W', 13.2], ['→…', 14.0], ['@', 14.2]
];
const WIDTH = new Map(CHAR_WIDTHS.flatMap(([chars, w]) => [...chars].map((c) => [c, w] as const)));

/** A text's width in px at the table's 14 px. */
export function textWidth(text: string): number {
	let w = 0;
	for (const c of text) w += WIDTH.get(c) ?? 7.8;
	return Math.ceil(w);
}

/** A cell's padding (12 px each side) and its edit button's (4 px each side, inside the cell). */
const CELL_PAD = 32;
/** An entry-row picker around its text: 4 px margins, 1 px borders, 10 px left padding and 28 px
 *  for the chevron (PickCombobox's `pl-2.5 pr-7`). */
const FIELD_PAD = 48;

export interface ColumnSpec {
	readonly id: string;
	/** A fixed width: the checkbox, Date, the amounts. */
	readonly fixed?: number;
	/** Takes what the other columns leave (one per table). */
	readonly fill?: boolean;
	/** A text column: never narrower (its heading fits) ... */
	readonly min?: number;
	/** ... and, fitted, never wider. */
	readonly max?: number;
	/** Extra px beside the cell's text (an icon). */
	readonly extra?: number;
	/** False: keeps its fitted width when the table is narrow (an amount is never cut). 'level':
	 *  gives way after the other text columns, together with the other 'level' columns, the widest
	 *  first (All transactions' Account and Category). */
	readonly squash?: boolean | 'level';
	/** What the entry row's picker in this column starts on ("Uncategorized"), fitted with the
	 *  picker's chevron: the cells alone left it "Uncategoriz…" (exe run). */
	readonly field?: readonly string[];
}

/** Each fitted column's cell texts. */
export type ColumnTexts = Record<string, Iterable<string>>;

/** The cookie's entry for the tables' width when last seen, `{ w: px }`: All transactions and the
 *  registers sit in the same content area, so one width serves both (a fold of the sidebar on one
 *  changes the other's too). */
export const SEEN = '_table';

/** Set widths from the cookie: `{ table: { column: px }, _table: { w: px } }`, anything else
 *  dropped. */
export function parseColsCookie(raw: string | undefined): Record<string, Record<string, number>> {
	if (!raw) return {};
	try {
		const out: Record<string, Record<string, number>> = {};
		for (const [table, cols] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
			if (!cols || typeof cols !== 'object') continue;
			const ok = Object.entries(cols as Record<string, unknown>).filter(
				(e): e is [string, number] =>
					typeof e[1] === 'number' && (table === SEEN ? e[0] === 'w' && e[1] >= 200 && e[1] <= 8000 : e[1] >= 40 && e[1] <= 1200)
			);
			if (ok.length > 0) out[table] = Object.fromEntries(ok);
		}
		return out;
	} catch {
		return {};
	}
}

/** Each fitted column's width: its longest cell, between its minimum and maximum. */
export function fittedWidths(specs: readonly ColumnSpec[], texts: ColumnTexts): Record<string, number> {
	const out: Record<string, number> = {};
	for (const s of specs) {
		if (s.fixed !== undefined || s.fill) continue;
		let w = 0;
		for (const t of texts[s.id] ?? []) w = Math.max(w, textWidth(t) + CELL_PAD + (s.extra ?? 0));
		for (const t of s.field ?? []) w = Math.max(w, textWidth(t) + FIELD_PAD);
		out[s.id] = Math.min(Math.max(w, s.min ?? 80), s.max ?? 360);
	}
	return out;
}

/**
 * Fluent's squash: when the columns' widths leave the fill column less than its minimum in a
 * `container` px wide table, the text columns give way, the last first, down to their minimums.
 */
export function fitToContainer(
	specs: readonly ColumnSpec[],
	widths: Record<string, number>,
	container: number
): Record<string, number> {
	const fill = specs.find((s) => s.fill);
	if (!fill || container <= 0) return widths;
	const out = { ...widths };
	const used = specs.reduce((sum, s) => sum + (s.fixed ?? out[s.id] ?? 0), 0);
	let over = used + (fill.min ?? 120) - container;
	for (const s of [...specs].reverse()) {
		if (over <= 0) break;
		if (s.fixed !== undefined || s.fill || s.squash === false || s.squash === 'level') continue;
		const give = Math.min(over, out[s.id]! - (s.min ?? 80));
		if (give > 0) {
			out[s.id] = out[s.id]! - give;
			over -= give;
		}
	}
	// Then the 'level' columns, one px at a time from the widest (ties: the later column), so they
	// meet at one width rather than the last being cut to its minimum.
	const level = specs.filter((s) => s.squash === 'level' && s.fixed === undefined && !s.fill);
	while (over > 0) {
		let widest: ColumnSpec | undefined;
		for (const s of level) {
			if (out[s.id]! <= (s.min ?? 80)) continue;
			if (!widest || out[s.id]! >= out[widest.id]!) widest = s;
		}
		if (!widest) break;
		out[widest.id] = out[widest.id]! - 1;
		over -= 1;
	}
	return out;
}

/**
 * The width a drag on `id`'s edge leaves on screen: the pointer's width, unless the window is too
 * narrow for it, when the column stops where the others reach their minimums (`fitToContainer`).
 * That shown width is the one kept: keeping the pointer's (exe run: 238 px kept while
 * 219 px showed) opened the column wider than it was ever seen in a wider window or after a restart.
 */
export function dragWidth(
	specs: readonly ColumnSpec[],
	widths: Record<string, number>,
	id: string,
	want: number,
	container: number
): number {
	return fitToContainer(specs, { ...widths, [id]: want }, container)[id] ?? want;
}

export class ColumnWidths {
	/** Widths the person set by dragging a heading's edge. */
	user = $state<Record<string, number>>({});
	/** The table's width: measured once it's in the page; before that (on the server, and in the
	 *  browser until it's measured) its width when last seen, kept in the cookie, so a window too
	 *  narrow for the ideal widths gets the same squash from the server and nothing moves on load
	 *  (Category drawn 142 px, squashed to 137 px once the page woke). 0 if never seen. */
	container = $state(0);
	readonly #specs: readonly ColumnSpec[];
	readonly #texts: () => ColumnTexts;
	readonly #table: string;

	/** `saved`: the parsed cookie (every table's set widths and the width when last seen). */
	constructor(table: string, specs: readonly ColumnSpec[], texts: () => ColumnTexts, saved: () => Record<string, Record<string, number>> | undefined) {
		this.#table = table;
		this.#specs = specs;
		this.#texts = texts;
		const all = untrack(saved) ?? {};
		this.user = { ...all[table] };
		this.container = all[SEEN]?.w ?? 0;
	}

	readonly widths = $derived.by(() => {
		const fitted = fittedWidths(this.#specs, this.#texts());
		return fitToContainer(this.#specs, { ...fitted, ...this.user }, this.container);
	});

	/** A `<col>`'s style: its width in px, none for the fill column. */
	style(id: string): string | undefined {
		const s = this.#specs.find((x) => x.id === id);
		if (!s || s.fill) return undefined;
		return `width: ${s.fixed ?? this.widths[id]}px`;
	}

	/** The entry row's grid columns, the table's own widths. */
	readonly template = $derived.by(() =>
		this.#specs.map((s) => (s.fill ? 'minmax(0, 1fr)' : `${s.fixed ?? this.widths[s.id]}px`)).join(' ')
	);

	/** Can a drag on this heading's edge set the width (text columns only)? */
	resizable(id: string): boolean {
		const s = this.#specs.find((x) => x.id === id);
		return !!s && s.fixed === undefined && !s.fill;
	}

	/** Tracks the table's width (Fluent's container fit). */
	attach(table: HTMLElement | null): (() => void) | undefined {
		if (!table) return;
		const measure = () => {
			const w = table.clientWidth;
			if (w <= 0 || w === this.container) return;
			this.container = w;
			this.#save();
		};
		const ro = new ResizeObserver(measure);
		ro.observe(table.parentElement ?? table);
		measure();
		return () => ro.disconnect();
	}

	/** A drag on a heading's right edge (pointer captured until it's let go). */
	startResize(e: PointerEvent, id: string): void {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);
		const s = this.#specs.find((x) => x.id === id)!;
		const x0 = e.clientX;
		const w0 = this.widths[id] ?? s.min ?? 80;
		const move = (ev: PointerEvent) => {
			const want = Math.round(Math.min(Math.max(w0 + ev.clientX - x0, s.min ?? 80), 800));
			const widths = { ...fittedWidths(this.#specs, this.#texts()), ...this.user };
			this.user = { ...this.user, [id]: dragWidth(this.#specs, widths, id, want, this.container) };
		};
		const up = () => {
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', up);
			handle.removeEventListener('pointercancel', up);
			this.#save();
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', up);
		handle.addEventListener('pointercancel', up);
	}

	/** A double-click on the edge: fitted to its text again. */
	reset(id: string): void {
		const next = { ...this.user };
		delete next[id];
		this.user = next;
		this.#save();
	}

	#save(): void {
		const raw = document.cookie.split('; ').find((c) => c.startsWith(`${COLS_COOKIE}=`))?.slice(COLS_COOKIE.length + 1);
		const all = parseColsCookie(raw ? decodeURIComponent(raw) : undefined);
		if (Object.keys(this.user).length > 0) all[this.#table] = { ...this.user };
		else delete all[this.#table];
		if (this.container > 0) all[SEEN] = { w: this.container };
		document.cookie = `${COLS_COOKIE}=${encodeURIComponent(JSON.stringify(all))}; path=/; max-age=31536000; samesite=lax`;
	}
}
