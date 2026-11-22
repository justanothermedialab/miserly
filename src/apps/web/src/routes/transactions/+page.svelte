<!--
	All transactions (D4 RD6): one list of every visible account's rows, a one-row toolbar with
	search (Ctrl+F), and the table on the page (Q9 A). ACTUAL-PARITY #5: it works as
	Actual's All accounts and as the register: a click on a cell edits it in place, Tab and Enter
	move on, New transaction adds a row with an Account field, rows select for Delete and Set
	category, and only the rows in view are drawn ($lib/register/grid, shared with the register).
	The rows come a page at a time as the list scrolls ($lib/register/pages).
	A transfer reads "to" or "from" the other account and edits its date, memo and amount (its
	payee opens the register at the row); a value update opens its register, where its value edits. Amounts follow the
	colour of money (Q6 B) in each row's own currency.
-->
<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { deserialize, enhance } from '$app/forms';
	import { tick, untrack } from 'svelte';
	import { PageHeader, TableFrame } from '$lib/components/layout';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { Input } from '$lib/components/ui/input';
	import { TEXT_LIMITS } from '$lib/text-limits';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Select from '$lib/components/ui/select';
	import { ArrowDown, ArrowLeftRight, ArrowUp, Copy, Download, Plus, Square, SquareCheck, Tag, Trash2, X } from '@lucide/svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import DateField from '$lib/components/DateField.svelte';
	import PayeeCombobox from '$lib/components/PayeeCombobox.svelte';
	import PickCombobox from '$lib/components/PickCombobox.svelte';
	import ColumnResizer from '$lib/components/ColumnResizer.svelte';
	import { withAnswer } from '$lib/register/patch';
	import { PagedList, newestFirst } from '$lib/register/pages.svelte';
	import { CellEditor, FIELDS, RowSort, RowWindow, refreshNav, runAction, menuContentCls, menuItemCls, sortBtnCls, type CellField, type SortKey } from '$lib/register/grid.svelte';
	import { ColumnWidths } from '$lib/register/columns.svelte';
	import { ContextMenu } from 'bits-ui';
	import { downloadCsv, rupees } from '$lib/register/csv';
	import { formatDateShort } from '$lib/dates';
	import { flowToneClass } from '$lib/format';
	import { useMoney } from '$lib/format-context';
	import { MODULE_PROFILES, sectionLabel } from '$lib/modules';
	import { transferOptions, transferTargetOf } from '$lib/transfer-targets';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	const m = useMoney();
	type Row = PageData['rows'][number];
	// Payees, accounts and categories: the layout's (Quick add's) lists, current after each save.
	const qa = $derived(data.quickAdd!);
	// The first page comes with the page, the rest a page at a time as the list scrolls, from
	// `rows/+server.ts` with the same search.
	const list = new PagedList<Row>(
		() => ({ rows: data.rows, next: data.next }),
		(after, limit) => `/transactions/rows?${new URLSearchParams({ after, limit: String(limit), ...(data.q ? { q: data.q } : {}) })}`,
		newestFirst,
		() => data.q
	);
	const listRows: Row[] = $derived(list.rows);
	// A save answers with its rows in this list's shape (`view=all`); the list is patched
	// here and only the sidebar reloads (`app:nav`), never these thousands of rows. A reload or a new
	// search drops the patch (it's for that `data.rows`).
	/** Patch the list from a save's answer; false when it has none (the page then reloads). */
	function patchFromSave(d: Record<string, unknown> | undefined): boolean {
		const answer = d?.activity as Row[] | undefined;
		if (!answer) return false;
		list.set(withAnswer(listRows, answer));
		return true;
	}

	// ── search (server-side: payee, category, account, memo) ──────────────────────
	let q = $state('');
	$effect.pre(() => {
		q = data.q;
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	function search() {
		clearTimeout(timer);
		timer = setTimeout(() => {
			const url = q.trim() ? `/transactions?q=${encodeURIComponent(q.trim())}` : '/transactions';
			goto(url, { keepFocus: true, noScroll: true, replaceState: true });
		}, 250);
	}

	// ── reference data ───────────────────────────────────────────────────────────
	const catName = (id: string): string =>
		qa.categoryGroups.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? 'Uncategorized';
	const categoryOptions = $derived([
		{ value: '', label: 'Uncategorized' },
		...qa.categoryGroups.flatMap((g) => g.categories.map((c) => ({ value: c.id, label: c.name, group: g.name })))
	]);
	// A transfer with no category is still a transfer, not uncategorised spending (item 2.5).
	const transferCategoryOptions = $derived([{ value: '', label: 'No category' }, ...categoryOptions.slice(1)]);
	/** The picker's list for a row: a category hidden since still shows as the row's own. */
	const pickList = (r: Row) => {
		const base = r.entryType === 'transfer' ? transferCategoryOptions : categoryOptions;
		return r.categoryId && !base.some((o) => o.value === r.categoryId)
			? [{ value: r.categoryId, label: r.categoryName ?? 'Hidden category' }, ...base]
			: base;
	};
	const ORDER = new Map(MODULE_PROFILES.map((p, i) => [p.type, i]));
	const accountOptions = $derived(
		[...qa.accounts]
			.sort((a, b) => (ORDER.get(a.type) ?? 99) - (ORDER.get(b.type) ?? 99))
			.map((a) => ({ value: a.id, label: a.listLabel ?? a.label, picked: a.label, group: sectionLabel(a.type) }))
	);
	const payeeNames = $derived(qa.payees.map((p) => p.displayName));
	const prefillByName = $derived(new Map(qa.payees.map((p) => [p.nameNormalized, p.rememberedCategoryId])));
	const normalize = (s: string) => s.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();

	// ── the grid: edit in place, the row window ───────────────────────────────────
	// As in the register: a transfer edits its date, memo, amount and payee (the other account; its
	// ⇆ icon goes there), a value update its date, value, memo and amount (ACTUAL-PARITY #8, item 2.5).
	const editable = (_r: Row) => true;
	const TRANSFER_FIELDS: CellField[] = ['date', 'payee', 'notes', 'outflow', 'inflow'];
	const FX_TRANSFER_FIELDS: CellField[] = ['date', 'notes', 'outflow', 'inflow'];
	// The other half in an account this viewer can't see: only this leg's memo edits.
	const HIDDEN_TRANSFER_FIELDS: CellField[] = ['notes'];
	// Each reason is the whole message (the bar adds only the full stop): the notes line is this one's.
	const HIDDEN_HALF = "The other half of this transfer is in an account you can't see. Only its notes can be changed here";
	// Nothing on a closed account changes, so a transfer with one doesn't either.
	const CLOSED_HALF = 'The other half of this transfer is in a closed account. Reopen it to change this row';
	const hiddenHalf = (r: Row): string | undefined =>
		r.entryType !== 'transfer' ? undefined : !r.counterpartAccountId ? HIDDEN_HALF : r.counterpartClosed ? CLOSED_HALF : undefined;
	const MARK_FIELDS: CellField[] = ['date', 'target', 'notes', 'outflow', 'inflow'];
	// A transfer between a bank or card and a holding takes a category, before its memo (item 2.5).
	const withCategory = (f: CellField[], r: Row): CellField[] =>
		r.takesCategory ? [...f.slice(0, f.indexOf('notes')), 'category', ...f.slice(f.indexOf('notes'))] : f;
	const ed: CellEditor<Row> = new CellEditor<Row>({
		rows: (): Row[] => rows.filter(editable),
		serverRow: (id) => listRows.find((x) => x.id === id),
		editable,
		fields: (r) =>
			r.entryType === 'valuationMark'
				? MARK_FIELDS
				: r.entryType === 'transfer'
					? !r.counterpartAccountId ? HIDDEN_TRANSFER_FIELDS : r.counterpartClosed ? [] : withCategory(r.counterpartCurrency === null ? TRANSFER_FIELDS : FX_TRANSFER_FIELDS, r)
					: FIELDS,
		action: (r) => `/accounts/${r.accountId}?/editTx`,
		markAction: (r) => `/accounts/${r.accountId}?/editMark`,
		isMark: (r) => r.entryType === 'valuationMark',
		payeeText: (r) => (r.entryType === 'transfer' ? `Transfer → ${otherName(r) ?? ''}` : (r.payeeName ?? '')),
		catName,
		reveal: (id) => win.reveal(id),
		locked: (r) => hiddenHalf(r),
		post: { view: 'all' },
		onSaved: patchFromSave
	});
	// ACTUAL-PARITY #15: a header click sorts.
	const sort = new RowSort();
	/** A transfer's other account's name (null when this viewer can't see it, P0). */
	const otherName = (r: Row): string | null => (r.amountPaise < 0 ? r.transferToName : r.transferFromName);
	/** A cell's payee list: "Transfer → X" for the viewer's other accounts in the row's currency, then
	 *  the payees (picking an account makes the row a transfer, or moves a transfer's other side). */
	const cellPayeeOptions = (r: Row) => [
		...payeeNames,
		...transferOptions(qa.accounts.filter((a) => a.id !== r.accountId && a.currency === r.currency))
	];
	/** A transfer's other side: the account, or (hidden from this viewer, P0) the person who moved it. */
	const otherSide = (r: Row): string => {
		// Direction from the leg's sign (comparing names flipped it for two accounts of one name).
		const outflow = r.amountPaise < 0;
		const name = outflow ? r.transferToName : r.transferFromName;
		return `${outflow ? 'To' : 'From'} ${name ?? r.enteredByName ?? 'another account'}`;
	};
	const sortText = (r: Row, key: SortKey): string =>
		key === 'account'
			? r.accountName
			: key === 'payee'
				? r.entryType === 'transfer' ? otherSide(r) : r.entryType === 'valuationMark' ? 'Value update' : (r.payeeName ?? '')
				: key === 'category'
					? r.entryType === 'transfer' ? (r.categoryName ?? 'Transfer') : (r.categoryName ?? '')
					: (r.notes ?? '');
	const rows: Row[] = $derived(sort.apply(ed.apply(listRows), sortText));
	// A sort by another column, or oldest first, needs every row: the rest load first.
	$effect(() => {
		if ((sort.key !== 'date' || sort.asc) && list.next !== null) untrack(() => void list.all());
	});

	// Column widths (columns.svelte.ts): Account, Category, Notes and the amounts fit their longest
	// cell, Payee takes the rest, and a drag on a heading's right edge sets a width. Narrow, Notes gives way
	// first, then Account and Category together (Category was cut to "Uncateg…" at 1232).
	const cols = new ColumnWidths(
		'transactions',
		[
			{ id: 'check', fixed: 40 },
			{ id: 'date', fixed: 84 },
			{ id: 'account', min: 96, max: 280, squash: 'level' },
			{ id: 'payee', fill: true, min: 140 },
			{ id: 'category', min: 96, max: 220, field: ['Uncategorized'], squash: 'level' },
			{ id: 'notes', min: 80, max: 360 },
			{ id: 'outflow', min: 104, max: 200, squash: false },
			{ id: 'inflow', min: 104, max: 200, squash: false }
		],
		() => ({
			account: listRows.map((r) => r.accountName),
			category: listRows.map((r) => r.categoryName ?? (r.entryType === 'transfer' ? 'Transfer' : r.entryType === 'valuationMark' ? '' : 'Uncategorized')),
			notes: listRows.map((r) => r.notes ?? ''),
			outflow: listRows.map((r) => (r.amountPaise < 0 ? m.money(-r.amountPaise, { currency: r.currency }) : '')),
			inflow: listRows.map((r) => (r.amountPaise > 0 ? m.money(r.amountPaise, { currency: r.currency }) : ''))
		}),
		() => data.colWidths
	);
	let tableEl = $state<HTMLTableElement | null>(null);
	$effect(() => cols.attach(tableEl));
	const win = new RowWindow<{ key: string; r: Row }>(() => items);
	const items = $derived(rows.map((r) => ({ key: r.id, r })));
	$effect(() => win.attach());
	$effect(() => {
		void items.length;
		untrack(() => void tick().then(() => win.update()));
	});
	// The next page when the drawn window nears the end of the rows here.
	$effect(() => {
		if (list.next !== null && win.start + win.size >= items.length - 40) untrack(() => void list.more());
	});
	const cellInputCls =
		'h-7 rounded-control border border-input border-b-brand-mark bg-surface px-2 text-body text-foreground outline-none shadow-[inset_0_-1px_0_var(--accent)]';
	// min-h-5.5: an empty cell's target is as tall as a filled one (22 px); with no text it collapsed
	// to its 2 px padding and the hover ring drew a thin pill.
	const cellViewCls =
		'-mx-1 min-h-5.5 cursor-text rounded-control px-1 py-px text-left hover:bg-surface-2 hover:ring-1 hover:ring-border-strong';

	// ── the Account cell: move a row ───────────────────────────────────
	let moving = $state<string | null>(null);
	let moveInput = $state<HTMLInputElement | null>(null);
	// The picker opens focused, its list open (openOnFocus), as a register cell does.
	$effect(() => {
		if (moving && moveInput) moveInput.focus();
	});
	const canMove = (r: Row) => r.entryType !== 'valuationMark' && !(r.entryType === 'transfer' && !r.counterpartAccountId);
	/** Accounts in the row's currency, its own first; never a transfer's other side. */
	const moveOptions = (r: Row) => accountOptions.filter((o) => {
		const a = qa.accounts.find((x) => x.id === o.value);
		return a !== undefined && a.currency === r.currency && o.value !== r.counterpartAccountId;
	});
	async function moveTo(r: Row, accountId: string) {
		moving = null;
		if (accountId && accountId !== r.accountId) await runAction('?/moveTx', { txId: r.id, accountId, updatedAt: r.updatedAt });
	}

	// ── selection (Delete, Set category) ─────────────────────────────────────────
	let selected = $state<Set<string>>(new Set());
	let bulkCategory = $state('');
	function toggle(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}
	const undoIds = $derived(form && 'bulked' in form && form.op === 'delete' ? form.deletedIds : []);

	// ACTUAL-PARITY #10: Export, a CSV of the rows shown (with the search applied): every row, the
	// pages not yet scrolled to loaded first.
	async function exportCsv() {
		await list.all();
		await tick();
		const d = new Date();
		const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
		downloadCsv(`All transactions ${stamp}.csv`, [
			['Date', 'Account', 'Payee', 'Category', 'Notes', 'Withdrawal', 'Deposit', 'Currency'],
			...rows.map((r) => [
				r.date,
				r.accountName,
				r.entryType === 'transfer'
					? // A side the viewer can't see reads as the screen does: the member who entered it.
						`Transfer: ${r.transferFromName ?? r.enteredByName ?? 'another account'} → ${r.transferToName ?? r.enteredByName ?? 'another account'}`
					: r.entryType === 'valuationMark'
						? 'Value update'
						: (r.payeeName ?? ''),
				r.entryType === 'transfer' ? (r.categoryName ?? 'Transfer') : (r.categoryName ?? ''),
				r.notes ?? '',
				r.amountPaise < 0 ? rupees(-r.amountPaise) : null,
				r.amountPaise > 0 ? rupees(r.amountPaise) : null,
				r.currency
			])
		]);
	}

	// ACTUAL-PARITY #9: the row menu (right-click a row): Duplicate, Select, Delete (with Undo).
	let menuRow = $state<Row | null>(null);
	function pickMenuRow(e: MouseEvent) {
		const id = (e.target as Element | null)?.closest('tr[data-txrow]')?.getAttribute('data-txrow');
		const r = id ? rows.find((x) => x.id === id) : undefined;
		if (!r) {
			e.stopPropagation();
			return;
		}
		menuRow = r;
	}
	async function menuAct(kind: 'dup' | 'del' | 'select') {
		const r = menuRow;
		if (!r) return;
		if (kind === 'select') toggle(r.id);
		else if (kind === 'dup') await runAction(`/accounts/${r.accountId}?/duplicateTx`, { txId: r.id }, false);
		else await runAction('?/bulkTx', { op: 'delete', ids: [r.id] });
	}

	// Arrows move between rows (focus stays on rows; the window follows).
	function rowKeydown(e: KeyboardEvent) {
		if (ed.cell || e.target !== e.currentTarget) return;
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		e.preventDefault();
		const list = Array.from(document.querySelectorAll<HTMLElement>('[data-txrow]'));
		const i = list.indexOf(e.currentTarget as HTMLElement);
		list[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
	}

	// ── New transaction: a row with an Account field (Actual's All accounts) ───────
	let adding = $state(false);
	let saving = $state(false);
	let nAccount = $state('');
	let nDate = $state('');
	let nPayee = $state('');
	let nPayeeAccount = $state(''); // the transfer line picked (posted as its id)
	let nCategory = $state('');
	let nNotes = $state('');
	let nOut = $state('');
	let nIn = $state('');
	// A transfer between currencies also takes the amount in the other account's currency (MC2), as
	// the register's entry row does; without it the save failed with nowhere to type it.
	let nReceived = $state('');
	const fxTarget = $derived.by(() => {
		const t = transferTargetOf(qa.accounts.filter((a) => a.id !== nAccount), nPayee, nPayeeAccount);
		const self = qa.accounts.find((a) => a.id === nAccount);
		return t && self && t.currency !== self.currency ? t : null;
	});
	let nErrors = $state<Record<string, string>>({});
	let accountInput = $state<HTMLInputElement | null>(null);
	let payeeInput = $state<HTMLInputElement | null>(null);
	let newBtn = $state<HTMLButtonElement | null>(null);
	const today = () => {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	};
	// Payee offers the payees, then the other accounts under a heading per section, as in the
	// register (C3).
	const entryPayees = $derived([...payeeNames, ...transferOptions(qa.accounts.filter((a) => a.id !== nAccount))]);
	async function openEntry() {
		adding = true;
		nErrors = {};
		nDate = today();
		nPayee = nPayeeAccount = nCategory = nNotes = nOut = nIn = nReceived = '';
		if (!nAccount) nAccount = qa.accounts.find((a) => a.type === 'bank' && a.currency === data.baseCurrency)?.id ?? qa.accounts[0]?.id ?? '';
		await tick();
		accountInput?.focus();
	}
	async function closeEntry() {
		adding = false;
		await tick();
		newBtn?.focus();
	}
	function onPayeeChange() {
		if (nCategory !== '') return;
		const remembered = prefillByName.get(normalize(nPayee));
		if (remembered) nCategory = remembered;
	}
	async function saveEntry() {
		if (saving) return;
		if (!nAccount) {
			nErrors = { _: 'Choose an account' };
			return;
		}
		saving = true;
		const body = new FormData();
		for (const [k, v] of Object.entries({ date: nDate, payee: nPayee, transferAccountId: nPayeeAccount, category: nCategory, notes: nNotes, outflow: nOut, inflow: nIn, received: nReceived, view: 'all' })) body.set(k, v);
		try {
			const res = await fetch(`/accounts/${nAccount}?/addTransaction`, { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
			const result = deserialize(await res.text());
			if (result.type === 'success') {
				// The answer's row patches the list; only the sidebar reloads. A transfer typed
				// here answers with nothing to patch: the page reloads.
				if (patchFromSave(result.data)) await refreshNav();
				else await invalidateAll();
				// The next row: the same account and date, from Payee (as the register).
				nErrors = {};
				nPayee = nPayeeAccount = nCategory = nNotes = nOut = nIn = nReceived = '';
				await tick();
				payeeInput?.focus();
			} else if (result.type === 'failure') {
				nErrors = ((result.data as { errors?: Record<string, string> } | undefined)?.errors ?? { _: 'Not saved' });
			} else nErrors = { _: 'Not saved' };
		} finally {
			saving = false;
		}
	}
	function entryKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !e.defaultPrevented) {
			e.preventDefault();
			void closeEntry();
			return;
		}
		const t = e.target as HTMLElement | null;
		const onButton = t?.tagName === 'BUTTON';
		if (e.key === 'Enter' && !onButton && !e.defaultPrevented) {
			e.preventDefault();
			void saveEntry();
		}
	}
	const errCls = 'text-caption font-normal text-neg';
</script>

<PageHeader title="All transactions" />

<!-- One toolbar row: search, the count, New transaction; with rows selected, their commands. -->
<div class="mb-2 flex min-h-8 flex-wrap items-center gap-control">
	{#if selected.size > 0}
		<span class="text-body">{selected.size} selected</span>
		<form method="POST" action="?/bulkTx" use:enhance={() => async ({ update }) => { await update(); selected = new Set(); }} class="flex items-center gap-2">
			<input type="hidden" name="op" value="setCategory" />
			{#each [...selected] as id (id)}<input type="hidden" name="ids" value={id} />{/each}
			<Select.Root type="single" name="categoryId" bind:value={bulkCategory}>
				<Select.Trigger aria-label="Bulk category" class="h-8 w-50 bg-surface text-body">{bulkCategory === '' ? 'Category…' : catName(bulkCategory)}</Select.Trigger>
				<Select.Content>
					{#each qa.categoryGroups as g (g.id)}
						<Select.Group>
							<Select.GroupHeading>{g.name}</Select.GroupHeading>
							{#each g.categories as c (c.id)}<Select.Item value={c.id} label={c.name} />{/each}
						</Select.Group>
					{/each}
				</Select.Content>
			</Select.Root>
			<Button type="submit" variant="outline" disabled={bulkCategory === ''}><Tag aria-hidden="true" /> Set category</Button>
		</form>
		<form method="POST" action="?/bulkTx" use:enhance={() => async ({ update }) => { await update(); selected = new Set(); }}>
			<input type="hidden" name="op" value="delete" />
			{#each [...selected] as id (id)}<input type="hidden" name="ids" value={id} />{/each}
			<Button type="submit" variant="destructive"><Trash2 aria-hidden="true" /> Delete {m.count(selected.size)} {selected.size === 1 ? 'transaction' : 'transactions'}</Button>
		</form>
		<Button variant="ghost" onclick={() => (selected = new Set())}><X aria-hidden="true" /> Clear selection</Button>
	{:else}
		<Input
			type="search"
			data-page-search
			aria-label="Search transactions"
			placeholder="Search payee, category, account, notes"
			bind:value={q}
			oninput={search}
			class="w-75"
		/>
	{/if}
	<span class="flex-1"></span>
	{#if selected.size === 0 && listRows.length > 0}
		<Button variant="ghost" onclick={exportCsv}><Download aria-hidden="true" /> Export</Button>
	{/if}
	<span class="text-caption text-text-muted">
		{m.count(listRows.length)}{list.next !== null ? '+' : ''} {listRows.length === 1 ? 'transaction' : 'transactions'}
	</span>
	{#if selected.size === 0 && qa.accounts.length > 0}
		<Button variant="outline" bind:ref={newBtn} onclick={openEntry} disabled={adding}><Plus aria-hidden="true" /> New transaction</Button>
	{/if}
</div>

{#if form && 'errors' in form && form.errors?._}<StatusBar intent="error" trigger={form} class="mb-2">{form.errors._}</StatusBar>{/if}
<!-- A cell edit that didn't save says so (it used to revert silently and look saved). -->
{#if ed.error}<StatusBar intent="error" trigger={ed.error} class="mb-2">{ed.error}</StatusBar>{/if}
{#if ed.notice}<StatusBar intent="info" trigger={ed.notice} class="mb-2">{ed.notice.text}.</StatusBar>{/if}
{#if form && 'bulked' in form && form.bulked}
	{#if form.op === 'delete' && undoIds.length > 0}
		<StatusBar trigger={form} autoDismiss={false} class="mb-2">
			Deleted {m.count(undoIds.length)} {undoIds.length === 1 ? 'transaction' : 'transactions'}.{#if form.skippedHidden}{' '}{form.skippedHidden} {form.skippedHidden === 1 ? 'transfer was' : 'transfers were'} left: the other half is in an account you can't see.{/if}
			{#snippet action()}
				<form method="POST" action="?/restoreBulkTx" use:enhance>
					{#each undoIds as id (id)}<input type="hidden" name="ids" value={id} />{/each}
					<Button type="submit" data-undo variant="ghost" size="xs" class="text-brand-ink">Undo</Button>
				</form>
			{/snippet}
		</StatusBar>
	{:else if form.op === 'delete' && form.skippedHidden}
		<StatusBar intent="warning" trigger={form} class="mb-2">Nothing deleted.{#if form.skippedHidden}{' '}{form.skippedHidden} {form.skippedHidden === 1 ? 'transfer was' : 'transfers were'} left: the other half is in an account you can't see.{/if}</StatusBar>
	{:else if form.op !== 'delete'}
		<StatusBar intent={form.affected === 0 ? 'warning' : 'success'} trigger={form} class="mb-2">
			Updated {m.count(form.affected)} {form.affected === 1 ? 'transaction' : 'transactions'}{#if form.skippedTransfers}; {form.skippedTransfers} {form.skippedTransfers === 1 ? 'transfer takes' : 'transfers take'} no category{/if}.
		</StatusBar>
	{/if}
{/if}
{#if form && 'restored' in form && form.restored}
	<StatusBar trigger={form} class="mb-2">Restored {m.count(form.restoredCount)} {form.restoredCount === 1 ? 'transaction' : 'transactions'}.</StatusBar>
{/if}

<TableFrame isEmpty={listRows.length === 0 && !adding}>
	{#snippet empty()}
		{#if data.q}
			<EmptyState title="No transactions match" text={`Nothing matches "${data.q}".`}>
				{#snippet action()}<Button variant="outline" href="/transactions">Clear search</Button>{/snippet}
			</EmptyState>
		{:else}
			<EmptyState icon="transactions" title="No transactions yet" text="Add the first one here.">
				{#snippet action()}<Button variant="outline" onclick={openEntry} disabled={adding}>Add transaction</Button>{/snippet}
			</EmptyState>
		{/if}
	{/snippet}
	<!-- Fixed columns, so the drawn window never changes their widths as it moves. -->
	<table class="data-table dense table-fixed" bind:this={tableEl}>
		<colgroup>
			{#each ['check', 'date', 'account', 'payee', 'category', 'notes', 'outflow', 'inflow'] as id (id)}<col style={cols.style(id)} />{/each}
		</colgroup>
		<thead>
			<tr>
				<th class="check"><span class="sr-only">Select</span></th>
				{#each [['date', 'Date', ''], ['account', 'Account', ''], ['payee', 'Payee', ''], ['category', 'Category', ''], ['notes', 'Notes', ''], ['outflow', 'Withdrawal', 'num'], ['inflow', 'Deposit', 'num']] as [key, label, cls] (key)}
					<th scope="col" class="relative {cls}" aria-sort={sort.aria(key as SortKey)}>
						<button type="button" class={sortBtnCls} onclick={() => sort.by(key as SortKey)}>
							{label}
							{#if sort.key === key}{#if sort.asc}<ArrowUp size={12} aria-hidden="true" />{:else}<ArrowDown size={12} aria-hidden="true" />{/if}{/if}
						</button>
						{#if cols.resizable(key as string)}<ColumnResizer {cols} id={key as string} label={label as string} />{/if}
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#if adding}
				<tr class="entry-row">
					<td colspan="8" class="!p-0">
						<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
						<form class="all-entry" style="grid-template-columns: {cols.template}" onkeydown={entryKeydown} onsubmit={(e) => { e.preventDefault(); void saveEntry(); }}>
							<span></span>
							<DateField bind:value={nDate} aria-label="Date" required class="w-full" />
							<PickCombobox bind:value={nAccount} bind:inputRef={accountInput} options={accountOptions} aria-label="Account" />
							<PayeeCombobox bind:value={nPayee} bind:transferAccountId={nPayeeAccount} bind:inputRef={payeeInput} options={entryPayees} onchange={onPayeeChange} placeholder="Payee" aria-label="Payee" />
							<PickCombobox bind:value={nCategory} options={categoryOptions} aria-label="Category" />
							<Input type="text" bind:value={nNotes} maxlength={TEXT_LIMITS.note} placeholder="Notes" aria-label="Notes" class="w-full" />
							<Input type="text" inputmode="decimal" bind:value={nOut} placeholder="0.00" aria-label="Withdrawal" class="num w-full text-right" />
							<Input type="text" inputmode="decimal" bind:value={nIn} placeholder="0.00" aria-label="Deposit" class="num w-full text-right" />
							<div class="extra flex items-center justify-end gap-2">
								{#if fxTarget}
									<label class="mr-auto flex items-center gap-2 text-body">Amount in {fxTarget.currency}
										<Input type="text" inputmode="decimal" bind:value={nReceived} aria-label={`Amount in ${fxTarget.currency}`} class="num w-28 text-right" />
									</label>
								{/if}
								{#if Object.keys(nErrors).length}
									<span class="{errCls} mr-auto">{Object.values(nErrors).join(' ')}</span>
								{/if}
								<Button type="submit" variant="outline" size="sm" disabled={saving}>Save</Button>
								<Tooltip label="Cancel" shortcut="Esc">
									{#snippet child({ props })}
										<button {...props} type="button" onclick={closeEntry} aria-label="Cancel" class="inline-grid size-8 place-items-center rounded-control text-text-muted hover:bg-control-hover hover:text-foreground"><X size={16} aria-hidden="true" /></button>
									{/snippet}
								</Tooltip>
							</div>
						</form>
					</td>
				</tr>
			{/if}
		</tbody>
		<ContextMenu.Root onOpenChange={(o) => { if (!o) menuRow = null; }}>
		<ContextMenu.Trigger>
		{#snippet child({ props })}
		<tbody {...props} bind:this={win.body} oncontextmenucapture={pickMenuRow}>
			{#if win.padTop > 0}<tr aria-hidden="true"><td colspan="8" style="height:{win.padTop}px;padding:0;border:0"></td></tr>{/if}
			{#each win.visible as { r } (r.id)}
				{@render row(r)}
			{/each}
			{#if win.padBottom > 0}<tr aria-hidden="true"><td colspan="8" style="height:{win.padBottom}px;padding:0;border:0"></td></tr>{/if}
		</tbody>
		{/snippet}
		</ContextMenu.Trigger>
		<ContextMenu.Portal>
			<ContextMenu.Content class={menuContentCls}>
				{#if menuRow}
					{#if menuRow.entryType !== 'valuationMark' && !hiddenHalf(menuRow)}
						<ContextMenu.Item class={menuItemCls} onSelect={() => menuAct('dup')}><Copy size={16} aria-hidden="true" />Duplicate</ContextMenu.Item>
					{/if}
					<ContextMenu.Item class={menuItemCls} onSelect={() => menuAct('select')}>{#if selected.has(menuRow.id)}<Square size={16} aria-hidden="true" />Deselect{:else}<SquareCheck size={16} aria-hidden="true" />Select{/if}</ContextMenu.Item>
					<ContextMenu.Separator class="-mx-1 my-1 h-px bg-border" />
					<ContextMenu.Item class="{menuItemCls} text-neg" disabled={!!hiddenHalf(menuRow)} onSelect={() => menuAct('del')}><Trash2 size={16} aria-hidden="true" />Delete</ContextMenu.Item>
					{#if hiddenHalf(menuRow)}<p class="max-w-64 px-3 pb-1.5 text-caption text-text-muted">{hiddenHalf(menuRow)}</p>{/if}
				{/if}
			</ContextMenu.Content>
		</ContextMenu.Portal>
		</ContextMenu.Root>
	</table>
</TableFrame>

{#if list.failed}
	<p class="mt-content text-body text-text-muted">The rest of the list didn't load. Reload the page to try again.</p>
{/if}

{#snippet row(r: Row)}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<tr data-txrow={r.id} tabindex="0" onkeydown={rowKeydown} data-selected={selected.has(r.id) ? '' : undefined}>
		<td class="check" onmousedown={(e) => { if (e.shiftKey) e.preventDefault(); }}>
			<Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)} aria-label={`Select ${r.payeeName ?? 'transaction'}, ${formatDateShort(r.date)}`} />
		</td>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<td class="date" onclick={(e) => ed.click(e, r, 'date')}>
			{#if ed.editing(r, 'date')}
				<DateField bind:value={ed.draft} bind:inputRef={ed.input} aria-label="Date"
					onchange={(iso) => ed.commit(r, 'date', iso)}
					onblur={() => ed.commit(r, 'date', ed.draft)} onkeydown={(e) => ed.keydown(e, r, 'date')}
					class="relative z-10 w-36" />
			{:else if ed.can(r, 'date')}
				<button type="button" class="{cellViewCls} font-normal" onclick={() => ed.open(r, 'date')}>{formatDateShort(r.date)}</button>
			{:else}
				{formatDateShort(r.date)}
			{/if}
		</td>
		<!-- A click picks another account and moves the row there (Actual's All accounts). Not
		     a value update (it belongs to its holding), nor a transfer whose other side is hidden. -->
		<td class="truncate text-text-muted" title={r.accountName}>
			{#if moving === r.id}
				<PickCombobox value={r.accountId} bind:inputRef={moveInput} options={moveOptions(r)} aria-label="Account" inputClass="h-7"
					onpick={(v) => moveTo(r, v)} onblur={() => (moving = null)}
					onkeydown={(e) => { if (e.key === 'Escape') moving = null; }}
					class="relative z-10 w-full min-w-33" />
			{:else if canMove(r)}
				<button type="button" class="{cellViewCls} max-w-full truncate font-normal" onclick={() => (moving = r.id)}>{r.accountName}</button>
			{:else}
				{r.accountName}
			{/if}
		</td>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<td class="truncate" onclick={(e) => ed.click(e, r, r.entryType === 'valuationMark' ? 'target' : 'payee')}>
			<!-- The payee takes the free space and truncates; the stamp keeps its width and an 8 px gap
			     (a floated stamp let the full-width payee button run under it). -->
			<div class="flex min-w-0 items-center gap-2">
			<div class="min-w-0 flex-1 truncate">
			{#if r.entryType === 'valuationMark'}
				{#if ed.editing(r, 'target')}
					<span class="inline-flex items-center gap-2">Value update to
						<input bind:this={ed.input} type="text" inputmode="decimal" bind:value={ed.draft} aria-label="New value"
							onblur={() => ed.commit(r, 'target', ed.draft)} onkeydown={(e) => ed.keydown(e, r, 'target')}
							class="{cellInputCls} num w-36 text-right" /></span>
				{:else}
					<button type="button" class="{cellViewCls} block max-w-full truncate font-normal" onclick={() => ed.open(r, 'target')}>Value update to {m.money(Math.abs(r.markTargetPaise ?? 0), { currency: r.currency })}</button>
				{/if}
			{:else if r.entryType === 'transfer' && !ed.editing(r, 'payee')}
				<!-- The ⇆ icon goes to the other account at this transfer (Actual); the name edits. -->
				<span class="inline-flex max-w-full min-w-0 items-center gap-1">
					{#if r.counterpartAccountId}
						<Tooltip label={`Go to ${otherName(r)}`}>
							{#snippet child({ props })}<a {...props} href="/accounts/{r.counterpartAccountId}?tx={r.transferPartnerId}" class="-m-1 inline-grid flex-none place-items-center rounded-control p-1 text-text-muted hover:bg-control-hover hover:text-brand-ink"
								aria-label={`Go to ${otherName(r)}`}><ArrowLeftRight size={14} aria-hidden="true" /></a>{/snippet}
						</Tooltip>
					{:else}
						<ArrowLeftRight size={14} class="flex-none text-text-muted" aria-hidden="true" />
					{/if}
					{#if ed.can(r, 'payee')}
						<button type="button" class="{cellViewCls} min-w-0 truncate font-normal" onclick={() => ed.open(r, 'payee')}>{otherSide(r)}</button>
					{:else}
						<span class="min-w-0 truncate">{otherSide(r)}</span>
					{/if}
				</span>
			{:else if ed.editing(r, 'payee')}
				<PayeeCombobox bind:inputRef={ed.input} bind:value={ed.draft} bind:transferAccountId={ed.payeeAccount} options={cellPayeeOptions(r)} aria-label="Payee" onpick={(v) => ed.commit(r, 'payee', v)}
					onblur={() => ed.editing(r, 'payee') && ed.commit(r, 'payee', ed.draft)} onkeydown={(e) => ed.keydown(e, r, 'payee')}
					class="w-full" />
			{:else}
				<button type="button" class="{cellViewCls} max-w-full truncate font-normal" onclick={() => ed.open(r, 'payee')}>{r.payeeName ?? 'No payee'}</button>
			{/if}
			</div>
			{#if r.isSharedAccount && r.enteredByName && !ed.editing(r, 'payee') && !ed.editing(r, 'target')}<span class="flex-none text-body text-text-muted">by {r.enteredByName}</span>{/if}
			</div>
		</td>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<td class="truncate" onclick={(e) => ed.click(e, r, 'category')}>
			{#if r.entryType === 'transfer' && !ed.can(r, 'category')}
				<span class={r.categoryName ? '' : 'text-text-muted'}>{r.categoryName ?? 'Transfer'}</span>
			{:else if r.entryType === 'valuationMark'}
				<span></span>
			{:else if ed.editing(r, 'category')}
				<PickCombobox bind:inputRef={ed.input} bind:value={ed.draft} options={pickList(r)}
					aria-label="Category" inputClass="h-7"
					onpick={(v, how) => ed.categoryPicked(r, v, how)}
					onblur={() => ed.commit(r, 'category', ed.draft)} onkeydown={(e) => ed.keydown(e, r, 'category')}
					class="relative z-10 w-full min-w-33" />
			{:else}
				<!-- A transfer with no category is still a transfer, not uncategorised spending. -->
				<button type="button" onclick={() => ed.open(r, 'category')} class="{cellViewCls} max-w-full truncate font-normal {r.categoryName ? '' : r.entryType === 'transfer' ? 'text-text-muted' : 'text-warn'}" title={r.categoryName ?? undefined}>{r.categoryName ?? (r.entryType === 'transfer' ? 'Transfer' : 'Uncategorized')}</button>
			{/if}
		</td>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<td class="truncate text-text-muted" onclick={(e) => ed.click(e, r, 'notes')} title={r.notes ?? undefined}>
			{#if ed.editing(r, 'notes')}
				<input bind:this={ed.input} type="text" bind:value={ed.draft} maxlength={TEXT_LIMITS.note} placeholder="Notes" aria-label="Notes"
					onblur={() => ed.commit(r, 'notes', ed.draft)} onkeydown={(e) => ed.keydown(e, r, 'notes')}
					class="{cellInputCls} block w-full" />
			{:else if ed.can(r, 'notes')}
				<button type="button" onclick={() => ed.open(r, 'notes')} class="block max-w-full truncate text-left hover:text-text">{r.notes ?? ''}</button>
			{:else}
				{r.notes ?? ''}
			{/if}
		</td>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<td class="num" onclick={(e) => ed.click(e, r, 'outflow')}>
			{#if ed.editing(r, 'outflow')}
				<input bind:this={ed.input} type="text" inputmode="decimal" bind:value={ed.draft} aria-label="Withdrawal"
					onblur={() => ed.commit(r, 'outflow', ed.draft)} onkeydown={(e) => ed.keydown(e, r, 'outflow')}
					class="{cellInputCls} num w-full text-right" />
			{:else if ed.can(r, 'outflow')}
				<button type="button" class="{cellViewCls} num block w-[calc(100%+8px)] text-right" onclick={() => ed.open(r, 'outflow')}>{r.amountPaise < 0 ? m.money(-r.amountPaise, { currency: r.currency }) : ''}</button>
			{:else if r.amountPaise < 0}
				<span class={r.entryType === 'valuationMark' ? flowToneClass(r.amountPaise) : ''}>{m.money(-r.amountPaise, { currency: r.currency })}</span>
			{/if}
		</td>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<td class="num" onclick={(e) => ed.click(e, r, 'inflow')}>
			{#if ed.editing(r, 'inflow')}
				<input bind:this={ed.input} type="text" inputmode="decimal" bind:value={ed.draft} aria-label="Deposit"
					onblur={() => ed.commit(r, 'inflow', ed.draft)} onkeydown={(e) => ed.keydown(e, r, 'inflow')}
					class="{cellInputCls} num w-full text-right" />
			{:else if ed.can(r, 'inflow')}
				<button type="button" class="{cellViewCls} num block w-[calc(100%+8px)] text-right" onclick={() => ed.open(r, 'inflow')}>{r.amountPaise > 0 ? m.money(r.amountPaise, { currency: r.currency }) : ''}</button>
			{:else if r.amountPaise > 0}
				{m.money(r.amountPaise, { currency: r.currency })}
			{/if}
		</td>
	</tr>
{/snippet}

<style>
	/* The entry row's fields on the table's own column widths, so each sits under its column;
	   Save and Cancel on a second line at the right (no balance column here). */
	:global(.entry-row > td) {
		background: var(--brand-weak);
	}
	.all-entry {
		display: grid; /* columns: the table's own widths (cols.template) */
		align-items: center;
		row-gap: 4px;
		padding: 4px 0;
	}
	.all-entry > :global(*) {
		margin: 0 4px;
		min-width: 0;
	}
	.all-entry > :global(.extra) {
		grid-column: 3 / -1;
	}
</style>
