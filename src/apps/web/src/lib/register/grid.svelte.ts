/**
 * The transaction grid's behaviour, shared by an account's register and All transactions
 * (ACTUAL-PARITY #1, #4, #5): editing a cell in place and moving on by Tab and Enter, saving one
 * edit at a time, and drawing only the rows in view.
 *
 * CellEditor: a click on a cell edits that one field (Actual's InputValue); blur saves, Esc
 * reverts; Tab and Shift+Tab save and open the next or previous cell (along the row, then the
 * next row's first), Enter and Shift+Enter save and open the same cell a row down or up. Outflow
 * and Deposit are two views of ONE signed amount, so editing one clears the other (Actual's
 * credit/debit). Every save posts the full row to the account's `editTx` action (validation,
 * optimistic concurrency, balance recompute), one at a time, each built from the row as the
 * server last returned it, so a Tab chain never overwrites the field saved before it; the edit
 * shows at once (an overlay over the server row) and goes when the reload arrives. Each row has
 * its own cells (`fields`): a transfer edits its date, memo and amount (editTx syncs the other
 * leg; payee and category belong to the pair), a value update its target (`editMark`), and Tab
 * and Enter skip the cells a row doesn't have (ACTUAL-PARITY #8).
 *
 * RowWindow: the rows here (a list loads by pages as it scrolls, `pages.svelte.ts`) are drawn
 * as a window around the scroll position with a spacer above and below, as Actual does: at 2,452 rows the whole table was 60,000 nodes and took 8.6 to 10.6 s
 * to open. Dense rows are one fixed height, measured once rendered; the overscan lets arrows, Tab
 * and Enter reach the next row, and `reveal` scrolls a row into the window before it's looked for.
 */
import { flyoutMotion } from '$lib/motion';
import { tick } from 'svelte';
import { selectFromStart } from '$lib/utils';
import { applyAction, deserialize } from '$app/forms';
import { invalidate, invalidateAll } from '$app/navigation';
import type { PickHow } from '$lib/components/PickCombobox.svelte';

export type CellField = 'date' | 'payee' | 'category' | 'notes' | 'outflow' | 'inflow' | 'target';
/** Tab order: the columns left to right. */
export const FIELDS: readonly CellField[] = ['date', 'payee', 'category', 'notes', 'outflow', 'inflow'];

export interface GridRow {
	readonly id: string;
	readonly date: string;
	readonly payeeName: string | null;
	readonly categoryId: string | null;
	readonly categoryName: string | null;
	readonly notes: string | null;
	readonly amountPaise: number;
	readonly updatedAt: string;
	/** A value update's asserted value (signed as the account's side). */
	readonly markTargetPaise?: number | null;
}
type CellAt<R> = { r: R; field: CellField };

/** A typed amount as a number: grouping commas, spaces and a currency sign are how people write it. */
const num = (v: string): number => Number(v.replace(/[,\s₹$€£]/gu, ''));

export const outflowStr = (r: GridRow): string => (r.amountPaise < 0 ? (Math.abs(r.amountPaise) / 100).toFixed(2) : '');
export const inflowStr = (r: GridRow): string => (r.amountPaise > 0 ? (r.amountPaise / 100).toFixed(2) : '');

export const rowSelector = (id: string) => `[data-txrow="${CSS.escape(id)}"]`;

/** Post to a page action from code (a row menu's Duplicate, Delete): the result reloads the page
 *  data and, with `apply`, reaches `form` (a delete's Undo bar). */
export async function runAction(url: string, fields: Record<string, string | string[]>, apply = true) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, x);
	const res = await fetch(url, { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
	const result = deserialize(await res.text());
	if (result.type === 'success') await invalidateAll();
	if (apply || result.type !== 'success') await applyAction(result);
	return result;
}

/** The row-menu classes (the dropdown menu's, for Bits' ContextMenu), its motion too: it popped while
 *  every other menu fades. */
export const menuContentCls =
	`z-50 min-w-44 rounded-overlay border border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-pop)] outline-none ${flyoutMotion}`;
export const menuItemCls =
	'flex h-8 cursor-default items-center gap-2 rounded-control px-2 text-body outline-hidden select-none data-highlighted:bg-control-hover data-disabled:pointer-events-none data-disabled:opacity-50';
const rowEl = (id: string) => document.querySelector<HTMLElement>(rowSelector(id));

export interface CellEditorOptions<R extends GridRow> {
	/** The rows on screen that edit in place, top to bottom (Tab and Enter walk them). */
	rows: () => R[];
	/** The row as the server last returned it. */
	serverRow: (id: string) => R | undefined;
	editable: (r: R) => boolean;
	/** Where the row's edit posts: its account's `editTx`. */
	action: (r: R) => string;
	catName: (id: string) => string;
	/** Scroll a row into the rendered window and view. */
	reveal: (id: string) => Promise<unknown>;
	/** The row's editable cells, in Tab order (default: all of FIELDS). */
	fields?: (r: R) => readonly CellField[];
	/** Where a value update's edits post (its account's `editMark`). */
	markAction?: (r: R) => string;
	/** The row is a value update (its cells post to `markAction`). */
	isMark?: (r: R) => boolean;
	/** What the payee cell holds (a transfer's is "Transfer → <the other account>"). */
	payeeText?: (r: R) => string;
	/** Another editor holds the row (the full-row form): no cell edits. */
	blocked?: () => boolean;
	/** Why a row's other cells don't edit (a transfer whose other half the viewer can't see):
	 *  a click on one shows it above the table, as an InfoBar, not a browser tooltip. */
	locked?: (r: R) => string | undefined;
	/** Fields every save posts too (All transactions: `view=all`, the row shape it answers in). */
	post?: Record<string, string>;
	/** Patch the list from a save's answer (its rows); true when it did. The sidebar then reloads
	 *  alone (`app:nav`); otherwise (a save that changed more, as a transfer re-paired) the page does. */
	onSaved?: (data: Record<string, unknown> | undefined) => boolean;
}

/** After a save the list patched itself from: only the layout reloads (the sidebar, the Inbox
 *  count, Quick add's lists; `depends('app:nav')`), never the page's whole list. */
export const refreshNav = () => invalidate('app:nav');

export class CellEditor<R extends GridRow> {
	cell = $state<{ id: string; field: CellField } | null>(null);
	draft = $state('');
	/** The account of the transfer line picked in a payee cell (the save posts its id). */
	payeeAccount = $state('');
	input = $state<HTMLInputElement | null>(null);
	/** Saved-but-not-yet-reloaded values, by row id. */
	overlay = $state<Record<string, Partial<R>>>({});
	/** Why the last save failed, in the server's words (shown above the table until the next
	 *  save works): a failed save used to revert silently and look saved. */
	error = $state<string | null>(null);
	/** Why the clicked cell can't be edited (`locked`), shown above the table; a new object per
	 *  click so the same reason shows again after it was dismissed. */
	notice = $state<{ text: string } | null>(null);
	#saving: Promise<void> = Promise.resolve();
	private o: CellEditorOptions<R>;

	constructor(o: CellEditorOptions<R>) {
		this.o = o;
	}


	/** The server rows with any unsaved edit shown over them. */
	apply(rows: readonly R[]): R[] {
		return rows.map((r) => (this.overlay[r.id] ? { ...r, ...this.overlay[r.id] } : r));
	}

	fieldsOf(r: R): readonly CellField[] {
		return this.o.editable(r) ? (this.o.fields?.(r) ?? FIELDS) : [];
	}
	/** The cell edits in place (the row edits and has this cell). */
	can(r: R, field: CellField): boolean {
		return this.fieldsOf(r).includes(field);
	}

	editing(r: R, field: CellField): boolean {
		return this.cell !== null && this.cell.id === r.id && this.cell.field === field;
	}

	current(r: R, field: CellField): string {
		switch (field) {
			case 'date': return r.date;
			case 'payee': return this.o.payeeText?.(r) ?? r.payeeName ?? '';
			case 'category': return r.categoryId ?? '';
			case 'outflow': return outflowStr(r);
			case 'inflow': return inflowStr(r);
			case 'notes': return r.notes ?? '';
			case 'target': return r.markTargetPaise != null ? (Math.abs(r.markTargetPaise) / 100).toFixed(2) : '';
		}
	}

	async open(r: R, field: CellField) {
		if (this.o.blocked?.()) return;
		if (!this.can(r, field)) {
			const why = this.o.locked?.(r);
			if (why) this.notice = { text: why };
			return;
		}
		this.notice = null;
		this.cell = { id: r.id, field };
		this.draft = this.current(r, field);
		this.payeeAccount = '';
		await tick();
		this.input?.focus();
		selectFromStart(this.input);
	}

	/** A click on a cell's empty space edits that cell (Actual: the whole cell is the target). */
	click(e: MouseEvent, r: R, field: CellField) {
		if (e.target !== e.currentTarget) {
			// A locked cell's text says why too; a link or button inside a cell keeps its own click.
			const why = this.can(r, field) ? undefined : this.o.locked?.(r);
			if (why && !(e.target as Element).closest('a, button, input')) this.notice = { text: why };
			return;
		}
		void this.open(r, field);
	}

	#along(r: R, field: CellField, dir: 1 | -1): CellAt<R> | null {
		const own = this.fieldsOf(r);
		const i = own.indexOf(field) + dir;
		if (i >= 0 && i < own.length) return { r, field: own[i]! };
		const list = this.o.rows();
		for (let k = list.findIndex((x) => x.id === r.id) + dir; k >= 0 && k < list.length; k += dir) {
			const f = this.fieldsOf(list[k]!);
			if (f.length) return { r: list[k]!, field: dir === 1 ? f[0]! : f[f.length - 1]! };
		}
		return null;
	}
	/** The same cell a row down (dir 1) or up (dir -1), skipping rows without it. */
	#down(r: R, field: CellField, dir: 1 | -1): CellAt<R> | null {
		const list = this.o.rows();
		for (let k = list.findIndex((x) => x.id === r.id) + dir; k >= 0 && k < list.length; k += dir) {
			if (this.can(list[k]!, field)) return { r: list[k]!, field };
		}
		return null;
	}

	#overlayFor(field: CellField, value: string, r?: R): Partial<GridRow> | null {
		const paise = Math.round(num(value) * 100);
		const amount = value.trim() !== '' && Number.isFinite(paise) && paise > 0;
		switch (field) {
			case 'date': return { date: value };
			case 'payee': return { payeeName: value || null };
			case 'category': return { categoryId: value || null, categoryName: value ? this.o.catName(value) : null };
			case 'notes': return { notes: value || null };
			case 'outflow': return amount ? { amountPaise: -paise } : null;
			case 'inflow': return amount ? { amountPaise: paise } : null;
			case 'target': return value.trim() !== '' && Number.isFinite(paise) && paise >= 0 ? { markTargetPaise: (r?.markTargetPaise ?? 0) < 0 ? -paise : paise } : null;
		}
	}

	async #save(id: string, field: CellField, value: string, transferAccountId = '') {
		const r = this.o.serverRow(id);
		if (!r) return;
		if (field === 'target' || this.o.isMark?.(r)) {
			// A value update: its value, date and memo. Its amount is the gap the value makes, so
			// a typed amount moves the value by the difference.
			const f: Record<string, string> = {
				markId: r.id,
				expectedUpdatedAt: r.updatedAt,
				target: this.current(r, 'target'),
				date: r.date,
				notes: r.notes ?? ''
			};
			if (field === 'target') f.target = value;
			else if (field === 'date' || field === 'notes') f[field] = value;
			else if (field === 'outflow' || field === 'inflow') {
				const typed = Math.round(num(value) * 100) * (field === 'outflow' ? -1 : 1);
				const target = (r.markTargetPaise ?? 0) + (typed - r.amountPaise);
				if (!Number.isFinite(typed) || typed === 0 || (target !== 0 && Math.sign(target) !== Math.sign(r.markTargetPaise || target))) {
					this.error = 'That amount would take the value below zero';
					return;
				}
				f.target = (Math.abs(target) / 100).toFixed(2);
			} else return;
			await this.#post(this.o.markAction?.(r) ?? '?/editMark', f, id, field, value);
			return;
		}
		const f: Record<string, string> = {
			txId: r.id,
			expectedUpdatedAt: r.updatedAt,
			date: r.date,
			payee: r.payeeName ?? '',
			category: r.categoryId ?? '',
			outflow: outflowStr(r),
			inflow: inflowStr(r),
			notes: r.notes ?? '',
			field
		};
		if (field === 'outflow') { f.outflow = value; f.inflow = ''; }
		else if (field === 'inflow') { f.inflow = value; f.outflow = ''; }
		else f[field] = value;
		if (field === 'payee' && transferAccountId) f.transferAccountId = transferAccountId;
		await this.#post(this.o.action(r), f, id, field, value);
	}

	async #post(url: string, f: Record<string, string>, id: string, field: CellField, value: string) {
		const body = new FormData();
		for (const [k, v] of Object.entries({ ...f, ...this.o.post })) body.set(k, v);
		try {
			const res = await fetch(url, { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
			const result = deserialize(await res.text());
			// Success has nothing to show, and applyAction would reset focus to the page
			// (SvelteKit's reset_focus), ending the edit the user has moved on to. A failure is
			// shown by the grid itself (applyAction put field errors under the entry row, or
			// replaced the page with an error page).
			if (result.type === 'success') {
				this.error = null;
				if (this.o.onSaved?.(result.data)) await refreshNav();
				else await invalidateAll();
			} else if (result.type === 'redirect') await applyAction(result);
			else {
				const d = (result.type === 'failure' ? result.data : undefined) as { errors?: Record<string, string>; message?: string } | undefined;
				const msg = d?.errors ? Object.values(d.errors)[0] : d?.message;
				this.error = `Not saved: ${msg ?? (result.type === 'error' ? 'this row is no longer here. Reload the page.' : 'try again.')}`;
				await invalidateAll();
			}
		} catch {
			this.error = "Not saved: the app didn't answer. Try again.";
		} finally {
			// The server's row is on screen now (or the edit failed): drop this field's overlay.
			const o = this.overlay[id];
			if (o) {
				const left: Partial<R> = { ...o };
				for (const k of Object.keys(this.#overlayFor(field, value) ?? {})) delete left[k as keyof R];
				const rest = { ...this.overlay };
				delete rest[id];
				this.overlay = Object.keys(left).length ? { ...rest, [id]: left } : rest;
			}
		}
	}

	/** Save the open cell; returns whether a save was queued (the value changed). */
	commit(r: R, field: CellField, value: string): boolean {
		// Once per edit: Enter, a blur and the date field's own change can all report the same edit.
		if (!this.editing(r, field)) return false;
		this.cell = null;
		if (value === this.current(r, field)) return false; // unchanged → no write (Actual's null-note skip too)
		const shown = this.#overlayFor(field, value, r) as Partial<R> | null;
		if (shown) this.overlay = { ...this.overlay, [r.id]: { ...this.overlay[r.id], ...shown } };
		const account = field === 'payee' ? this.payeeAccount : '';
		this.#saving = this.#saving.then(() => this.#save(r.id, field, value, account)).catch(() => {});
		return true;
	}

	/** Save, then go on. A changed date re-sorts the row, so the next cell opens once it has moved. */
	async #commitAndMove(r: R, field: CellField, value: string, target: CellAt<R> | null) {
		this.commit(r, field, value);
		// The date field saves through its own change event before the key arrives here. Focus waits
		// on the row meanwhile (on the page, a letter typed at once was an app key: N opened Quick Add).
		if (field === 'date') {
			await tick();
			rowEl(r.id)?.focus();
			await this.#saving;
		}
		const fresh = target ? this.o.rows().find((x) => x.id === target.r.id) : undefined;
		if (fresh && target) {
			await this.o.reveal(fresh.id);
			await this.open(fresh, target.field);
		} else {
			await tick();
			rowEl(r.id)?.focus();
		}
	}

	keydown(e: KeyboardEvent, r: R, field: CellField) {
		if (e.key === 'Tab') {
			e.preventDefault();
			void this.#commitAndMove(r, field, this.draft, this.#along(r, field, e.shiftKey ? -1 : 1));
		} else if (e.key === 'Enter') {
			e.preventDefault();
			void this.#commitAndMove(r, field, this.draft, this.#down(r, field, e.shiftKey ? -1 : 1));
		} else if (e.key === 'Escape') {
			e.preventDefault();
			this.cell = null;
			// Back to the row, not <body> (hunt H-cell-A).
			void tick().then(() => rowEl(r.id)?.focus());
		} else e.stopPropagation(); // typing stays in the cell
	}

	/** The category list took an item: a click saves it, Enter saves and goes a row down (Tab
	 *  arrives through `keydown`). */
	categoryPicked(r: R, v: string, how: PickHow) {
		if (how === 'click') this.commit(r, 'category', v);
		else if (how === 'Enter') void this.#commitAndMove(r, 'category', v, this.#down(r, 'category', 1));
	}
}

export class RowWindow<T extends { key: string }> {
	start = $state(0);
	// What the server renders: a screen's worth from the top (about 20 rows at 720 px); the browser
	// sizes it to the pane at once. 60 drew 200 to 300 KB of rows into a page's HTML.
	size = $state(30);
	body = $state<HTMLTableSectionElement | null>(null);
	rowH = 33;
	get visible(): T[] {
		return this.items().slice(this.start, this.start + this.size);
	}
	get padTop(): number {
		return this.start * this.rowH;
	}
	get padBottom(): number {
		return Math.max(0, this.items().length - this.start - this.size) * this.rowH;
	}

	private items: () => T[];
	private overscan: number;

	constructor(items: () => T[], overscan = 20) {
		this.items = items;
		this.overscan = overscan;
	}

	#pane() {
		return document.getElementById('app-content');
	}
	#listTop(el: HTMLElement) {
		return this.body!.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
	}

	update() {
		const el = this.#pane();
		if (!el || !this.body) return;
		const tr = this.body.querySelector<HTMLElement>('tr[data-txrow], tr[data-winrow]');
		const h = tr?.getBoundingClientRect().height;
		if (h && h > 20 && h < 60) this.rowH = h;
		const first = Math.floor((el.scrollTop - this.#listTop(el)) / this.rowH);
		const size = Math.ceil(el.clientHeight / this.rowH) + 2 * this.overscan;
		const start = Math.max(0, Math.min(first - this.overscan, this.items().length - size));
		if (start !== this.start) this.start = start;
		if (size !== this.size) this.size = size;
	}

	/** Follow the page's scroll and size; call inside an $effect, return its cleanup. */
	attach(): () => void {
		const el = this.#pane();
		if (!el) return () => {};
		let raf = 0;
		const onScroll = () => {
			if (!raf) raf = requestAnimationFrame(() => {
				raf = 0;
				this.update();
			});
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		const ro = new ResizeObserver(onScroll);
		ro.observe(el);
		return () => {
			el.removeEventListener('scroll', onScroll);
			ro.disconnect();
			cancelAnimationFrame(raf);
		};
	}

	/** Bring a row into the rendered window and into view. */
	async reveal(key: string, block: ScrollLogicalPosition = 'nearest'): Promise<HTMLElement | null> {
		const i = this.items().findIndex((it) => it.key === key);
		const el = this.#pane();
		if (i < 0 || !el || !this.body) return null;
		if (i < this.start || i >= this.start + this.size) {
			el.scrollTop = this.#listTop(el) + i * this.rowH - el.clientHeight / 2;
			this.update();
			await tick();
		}
		const tr = rowEl(key);
		tr?.scrollIntoView({ block });
		return tr;
	}
}

// ── ACTUAL-PARITY #15: click a column header to sort by it, again to reverse (Actual). Newest
// first by date is the default; text sorts A to Z first, amounts largest first, and rows without
// a figure in that column go last. Tab and Enter follow the order on screen.
export type SortKey = 'date' | 'account' | 'payee' | 'category' | 'notes' | 'outflow' | 'inflow';

export class RowSort {
	key = $state<SortKey>('date');
	asc = $state(false);

	by(key: SortKey) {
		if (this.key === key) this.asc = !this.asc;
		else {
			this.key = key;
			this.asc = !['date', 'outflow', 'inflow'].includes(key);
		}
	}
	/** aria-sort for a header. */
	aria(key: SortKey): 'ascending' | 'descending' | 'none' {
		return this.key === key ? (this.asc ? 'ascending' : 'descending') : 'none';
	}
	/** `rows` arrive newest first (date, sequence); text is what a row shows in a text column. */
	apply<R extends GridRow>(rows: readonly R[], text: (r: R, key: SortKey) => string): R[] {
		if (this.key === 'date') return this.asc ? [...rows].reverse() : [...rows];
		const key = this.key;
		const dir = this.asc ? 1 : -1;
		const amount = (r: R) => (key === 'outflow' ? -r.amountPaise : r.amountPaise);
		return rows
			.map((r, i) => ({ r, i }))
			.sort((a, b) => {
				if (key === 'outflow' || key === 'inflow') {
					const x = amount(a.r), y = amount(b.r);
					if ((x > 0) !== (y > 0)) return x > 0 ? -1 : 1; // rows without one go last
					return (x - y) * dir || a.i - b.i;
				}
				const x = text(a.r, key), y = text(b.r, key);
				if (!x !== !y) return x ? -1 : 1;
				return x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true }) * dir || a.i - b.i;
			})
			.map((x) => x.r);
	}
}

/** The header's sort button classes (the whole header cell is the target). */
export const sortBtnCls =
	'-mx-3 flex h-8 w-[calc(100%+24px)] items-center gap-1 px-3 font-semibold text-inherit hover:bg-control-hover [th.num_&]:flex-row-reverse';
