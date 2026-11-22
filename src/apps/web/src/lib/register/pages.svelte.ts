/**
 * pages.svelte.ts: a long list loaded by pages as the person scrolls. The page
 * load sends the first page and where it ended (`next`); the list asks its `rows` endpoint for the
 * next page when the drawn window nears its end (`RowWindow`), and for the rest when something
 * needs every row (a column sort, a search inside the page, Export, Select all).
 *
 * The rows are kept per page load, as the save patches are (`patch.ts`): a reload or a new search
 * gives a new `base` and the list starts again from it, then loads back to the length it had, so a
 * reload after a delete doesn't throw the person back to the top.
 */
import { untrack } from 'svelte';
import { LIST_PAGE, MAX_PAGE } from '$lib/list-pages';

export interface ListBase<R> {
	readonly rows: R[];
	readonly next: string | null;
}

export class PagedList<R extends { readonly id: string }> {
	#got = $state.raw<{ for: readonly R[]; rows: R[]; next: string | null } | null>(null);
	loading = $state(false);
	/** A page request failed (a lost session, the server gone): no more asked until a reload. */
	failed = $state(false);
	#base: () => ListBase<R>;
	#url: (after: string, limit: number) => string;
	#merge: (rows: R[], page: R[]) => R[];

	/**
	 * @param base  the page load's first page and cursor
	 * @param url   the endpoint for the page after a cursor
	 * @param merge the list with a page added (in the list's own order); ids already here are left
	 *              out of the page before it is called
	 * @param key   what the list is of (an account, a search): a new first page of the same list
	 *              (a reload) loads back to the length it had; another list starts from its first
	 */
	constructor(
		base: () => ListBase<R>,
		url: (after: string, limit: number) => string,
		merge: (rows: R[], page: R[]) => R[],
		key: () => unknown = () => null
	) {
		this.#base = base;
		this.#url = url;
		this.#merge = merge;
		let lastFor: readonly R[] | null = null;
		let lastKey: unknown = null;
		let lastCount = 0;
		$effect(() => {
			const b = this.#base();
			const k = key();
			const count = this.rows.length;
			untrack(() => {
				if (lastFor !== null && b.rows !== lastFor && k === lastKey && lastCount > b.rows.length && b.next) {
					void this.more(Math.min(MAX_PAGE, lastCount - b.rows.length));
				}
			});
			lastFor = b.rows;
			lastKey = k;
			lastCount = count;
		});
	}

	#current() {
		const b = this.#base();
		return this.#got && this.#got.for === b.rows ? this.#got : { for: b.rows, rows: b.rows, next: b.next };
	}
	get rows(): R[] {
		return this.#current().rows;
	}
	get next(): string | null {
		return this.#current().next;
	}
	/** Every row is here. */
	get complete(): boolean {
		return this.next === null;
	}

	/** The list after a save's patch (its rows changed in place). */
	set(rows: R[]): void {
		const c = this.#current();
		this.#got = { for: c.for, rows, next: c.next };
	}

	#inflight: Promise<void> | null = null;

	/** The next page (rows after the last one's place). A page that adds nothing (rows the viewer
	 *  doesn't hold on those dates) asks again, a few times. One request at a time: a second call
	 *  waits for the first. */
	more(limit = LIST_PAGE): Promise<void> {
		if (this.#inflight) return this.#inflight;
		if (this.failed || this.next === null) return Promise.resolve();
		this.loading = true;
		this.#inflight = this.#fetchPages(limit).finally(() => {
			this.#inflight = null;
			this.loading = false;
		});
		return this.#inflight;
	}

	async #fetchPages(limit: number): Promise<void> {
		for (let tries = 0; tries < 5; tries++) {
			const start = this.#current();
			if (start.next === null) return;
			let page: { rows: R[]; next: string | null };
			try {
				const res = await fetch(this.#url(start.next, limit));
				if (!res.ok) throw new Error(String(res.status));
				page = (await res.json()) as { rows: R[]; next: string | null };
			} catch {
				this.failed = true;
				return;
			}
			// A reload while it was on its way: that page belongs to the old list.
			if (this.#current().for !== start.for) return;
			const known = new Set(this.rows.map((r) => r.id));
			const added = page.rows.filter((r) => !known.has(r.id));
			this.#got = { for: start.for, rows: this.#merge(this.rows, added), next: page.next };
			if (added.length > 0) return;
		}
	}

	/** Every remaining page, the largest a request takes (for a sort, a search in the page, Export). */
	async all(): Promise<void> {
		while (this.next !== null && !this.failed) {
			if (this.#inflight) {
				await this.#inflight;
				continue;
			}
			const before = this.next;
			await this.more(MAX_PAGE);
			if (this.next === before) return;
		}
	}
}

/** A register's rows, oldest first by (date, sequence): an older page goes before them. */
export function ledgerOrder<R extends { readonly date: string; readonly sequence: number }>(rows: R[], page: R[]): R[] {
	return [...page, ...rows].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.sequence - y.sequence));
}

/** Rows newest first by date, a row keeping its place among its date's (All transactions, Inbox). */
export function newestFirst<R extends { readonly date: string }>(rows: R[], page: R[]): R[] {
	return [...rows, ...page].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
}
