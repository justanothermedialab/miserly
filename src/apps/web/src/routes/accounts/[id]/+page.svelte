<!--
	The account register (C1), rebuilt to the approved mock.
	A one-line header (the balance as the headline), one
	toolbar row (search, a Filter flyout, the count, New transaction), then the table on the page
	with Date as a column and the entry row inside the grid (C1 RD6: first row at or above
	190 px, 18 rows at 1366 x 768). Columns: Date, Payee, Category, Memo (from 1300 px),
	Withdrawal, Deposit, Balance; payee, category, memo and the amounts are cell-editable in
	place. The running balance comes straight from the server (window fn), so it is correct under
	back-dated inserts. New transaction opens the entry row; Enter saves and reopens a fresh row
	(carrying the date, C1 RD5); Ctrl/Cmd+Enter saves a single row; Esc cancels. Editing in
	place, Tab and Shift+Tab move to the next and previous cell and Enter to the same cell a row
	down, still editing (Actual; ACTUAL-PARITY #4). Future-dated rows sit
	above the rest under "Upcoming", and the header shows the projected figure beside the
	as-of-today one (C1 RD2).
-->
<script lang="ts">
	import { foldIn, foldOut } from '$lib/motion';
	import { flyoutMotion } from '$lib/motion';
	import Figure from '$lib/components/Figure.svelte';
	import { PageHeader, Section, TableFrame } from '$lib/components/layout';
	import LinkSwitch from '$lib/components/LinkSwitch.svelte';
	import ValueInvested from '$lib/components/ValueInvested.svelte';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { formatDate, formatDateShort } from '$lib/dates';
	import { infoDetails, infoValues, moduleProfile } from '$lib/modules';
	import { rememberedTransferCategory, transferOptions, transferTargetOf } from '$lib/transfer-targets';
	import AccountDetailsFields from '$lib/components/AccountDetailsFields.svelte';
	import { applyAction, enhance } from '$app/forms';
	import { withTail } from '$lib/register/patch';
	import { PagedList, ledgerOrder } from '$lib/register/pages.svelte';
	import { tick, untrack } from 'svelte';
	import type { ActionData, PageData } from './$types';
	import { formatPercent, formatRate, formatShare, toneClass, levelToneClass, balanceToneClass } from '$lib/format';
	import { useMoney } from '$lib/format-context';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { TEXT_LIMITS } from '$lib/text-limits';
	import { Badge } from '$lib/components/ui/badge';
	import ColourIcon from '$lib/components/ColourIcon.svelte';
	import { ArrowDown, ArrowLeftRight, ArrowUp, Copy, Download, ListFilter, Lock, Plus, Square, SquareCheck, Tag, Trash2, TrendingUp, X } from '@lucide/svelte';
	import { currencySymbol } from '$lib/currencies';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { OVERDRAWN_MESSAGE, PASSED_ZERO_MESSAGE, updatedAgo } from '$lib/holding-notes';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import DateField from '$lib/components/DateField.svelte';
	import PayeeCombobox from '$lib/components/PayeeCombobox.svelte';
	import PickCombobox, { type PickHow } from '$lib/components/PickCombobox.svelte';
	import ColumnResizer from '$lib/components/ColumnResizer.svelte';
	import { ColumnWidths } from '$lib/register/columns.svelte';
	import { CellEditor, FIELDS, RowSort, RowWindow, inflowStr, outflowStr, refreshNav, runAction, menuContentCls, menuItemCls, sortBtnCls, type CellField, type SortKey } from '$lib/register/grid.svelte';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { ContextMenu, Popover } from 'bits-ui';
	import { downloadCsv, rupees } from '$lib/register/csv';
	import * as Dialog from '$lib/components/ui/dialog';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	// The newest page of rows comes with the page, older ones a page at a time as the register
	// scrolls (`rows/+server.ts`); a search, a filter, a sort or Export loads the rest first.
	type ViewRow = PageData['view']['rows'][number];
	const list = new PagedList<ViewRow>(
		() => ({ rows: data.view.rows, next: data.view.next }),
		(before, limit) => `/accounts/${data.view.account.id}/rows?${new URLSearchParams({ before, limit: String(limit) })}`,
		ledgerOrder,
		() => data.view.account.id
	);
	// A save answers with this page's figures and its rows from the date it touched on
	// (`savedAnswer`); the list is patched here and only the sidebar reloads (`app:nav`), never the
	// whole list. A reload or another page's data drops the patch (it's for that `data.view`).
	let patched = $state.raw<{ for: PageData['view']; page: Partial<PageData> } | null>(null);
	const pd: PageData = $derived.by(() => {
		const base = patched && patched.for === data.view ? ({ ...data, ...patched.page } as PageData) : data;
		return { ...base, view: { ...base.view, rows: list.rows } } as PageData;
	});
	/** Patch the list from a save's answer; false when it has none (the page then reloads). */
	function patchFromSave(d: Record<string, unknown> | undefined): boolean {
		const page = d?.page as Partial<PageData> | undefined;
		const tail = d?.tail as { from: string; rows: ViewRow[] } | undefined;
		if (!page?.view || !tail) return false;
		patched = { for: data.view, page };
		list.set(withTail(list.rows, tail));
		return true;
	}
	const m = useMoney();

	const account = $derived(pd.view.account);
	// C5 C: a current holder writes (inside their dates); a member who has left only reads.
	const canWrite = $derived(pd.view.access.canWrite);
	const isOpen = $derived(account.status === 'open' && canWrite);
	const RANGES = ['1M', '3M', '6M', 'YTD', '1Y', 'ALL'] as const;
	// Field-label currency hint, e.g. "Amount (€)" — never a hard-coded ₹ (CP-05).
	const ccy = $derived(currencySymbol(account.currency).trim());
	// S5 RD8: the filled details on one line at the page's top (the name is in the title bar's path).
	const details = $derived(infoDetails(account.type, account.infoJson));
	function detailText(d: (typeof details)[number]): string {
		if (d.type === 'date') return formatDate(d.value);
		if (d.type === 'number') {
			const n = Number(d.value.replace(/[,\s₹$€£]/gu, ''));
			return Number.isFinite(n) ? m.money(Math.round(n * 100), { currency: account.currency }) : d.value;
		}
		return d.percent && !d.value.endsWith('%') ? `${d.value}%` : d.value;
	}
	type Row = PageData['view']['rows'][number];
	// ── Actual-style CELL editing (C4), shared with All transactions ($lib/register/grid): click
	// any cell in a normal row to edit that one field; Tab, Shift+Tab, Enter and Shift+Enter save
	// and move on (ACTUAL-PARITY #4). A transfer edits its date, memo and amount in place (the other
	// leg follows) and its payee, the other account (Actual: pick another account, or a payee to make
	// it an ordinary row); its ⇆ icon goes there. A value update edits its date, value (from the payee
	// cell), memo and amount (the gap its value makes) (ACTUAL-PARITY #8, item 2.5).
	// C4 RD8: on a closed account only an ordinary row's category changes (it moves no money,
	// and the row leaves To categorize); a click on any other cell says why.
	const closedCategoryOnly = (r: Row): boolean => r.kind === 'ordinary' && !r.transferPartnerId;
	// C5 C (H2 RD9): a member who has left reads the dates they held and changes nothing.
	const cellEditable = (r: Row): boolean => isOpen || (canWrite && closedCategoryOnly(r));
	// Edit account's opening field reads as Add account's: the type's own label
	// ("Amount invested", "Current outstanding") and a card or loan's outstanding as a positive
	// amount owed, posted as `outstanding` (the server stores it negative, as Add account does).
	const openingField = $derived.by(() => {
		const p = moduleProfile(account.type);
		const owed = p?.onboarding === 'cardOutstanding' || p?.onboarding === 'loanOutstanding';
		return {
			label: p?.openingLabel || 'Opening balance',
			name: owed ? 'outstanding' : 'opening',
			shown: owed ? -account.openingPaise : account.openingPaise,
			placeholder: owed ? 'Amount owed, minus if in credit' : p?.onboarding === 'investedValue' ? 'What you put in' : undefined
		};
	});
	const CLOSED_ROW = "This account is closed: only a row's category can change. Reopen it to change the rest";
	const LEFT_ROW = 'This account is no longer shared with you, so its rows can only be read';
	const TRANSFER_FIELDS: CellField[] = ['date', 'payee', 'notes', 'outflow', 'inflow'];
	// The other side in another currency (the pair carries a rate): its payee can't be re-paired here.
	const FX_TRANSFER_FIELDS: CellField[] = ['date', 'notes', 'outflow', 'inflow'];
	// The other half in an account this viewer can't see: only this leg's memo edits.
	const HIDDEN_TRANSFER_FIELDS: CellField[] = ['notes'];
	// Each reason is the whole message (the bar adds only the full stop): the notes line is this one's.
	const HIDDEN_HALF = "The other half of this transfer is in an account you can't see. Only its notes can be changed here";
	const hiddenHalf = (r: Row): string | undefined => (r.transferPartnerId && !r.counterpartAccountId && !r.partnerLeft ? HIDDEN_HALF : undefined);
	// The other half is in the account of someone who left the Circle: this half's date, memo
	// and amount are its own (a change makes it a plain row, "Bob (left)").
	const LEFT_PARTNER_FIELDS: CellField[] = ['date', 'notes', 'outflow', 'inflow'];
	const MARK_FIELDS: CellField[] = ['date', 'target', 'notes', 'outflow', 'inflow'];
	// A transfer between a bank or card and a holding takes a category, before its memo (item 2.5).
	const withCategory = (f: CellField[], r: Row): CellField[] =>
		r.takesCategory ? [...f.slice(0, f.indexOf('notes')), 'category', ...f.slice(f.indexOf('notes'))] : f;
	const ed: CellEditor<Row> = new CellEditor<Row>({
		rows: (): Row[] => [...filteredFuture, ...filteredCurrent].filter(cellEditable),
		serverRow: (id) => pd.view.rows.find((x) => x.id === id),
		editable: cellEditable,
		fields: (r) =>
			!isOpen
				? ['category']
				: r.kind === 'valuationMark'
				? (pd.holding?.markable ? MARK_FIELDS : [])
				: r.transferPartnerId
					? !r.counterpartAccountId ? (r.partnerLeft ? LEFT_PARTNER_FIELDS : HIDDEN_TRANSFER_FIELDS) : withCategory(r.fxRateScaled === null ? TRANSFER_FIELDS : FX_TRANSFER_FIELDS, r)
					: FIELDS,
		action: () => '?/editTx',
		markAction: () => '?/editMark',
		isMark: (r) => r.kind === 'valuationMark',
		payeeText: (r) => (r.transferPartnerId ? `Transfer → ${r.counterpartAccountName ?? ''}` : (r.payeeName ?? '')),
		catName: (id) => catName(id),
		reveal: (id) => win.reveal(id),
		blocked: () => editingId !== null,
		locked: (r) => hiddenHalf(r) ?? (!canWrite ? LEFT_ROW : !isOpen ? CLOSED_ROW : undefined),
		onSaved: patchFromSave
	});
	// Server rows are ledger-ascending; the passbook shows newest first. A cell edit shows at once
	// while it saves (the editor's overlay over the server row).
	const rowsDesc: Row[] = $derived(ed.apply([...pd.view.rows].reverse()));

	// Column widths (columns.svelte.ts): Category, Notes and the amounts fit their longest cell,
	// Payee takes the rest, and a drag on a heading's right edge sets a width (kept for every
	// register).
	const colWidths = new ColumnWidths(
		'register',
		[
			{ id: 'check', fixed: 40 },
			{ id: 'date', fixed: 84 },
			{ id: 'payee', fill: true, min: 140 },
			{ id: 'category', min: 96, max: 220, field: ['Uncategorized'] },
			{ id: 'notes', min: 80, max: 360 },
			{ id: 'outflow', min: 108, max: 200, squash: false },
			{ id: 'inflow', min: 108, max: 200, squash: false },
			{ id: 'balance', min: 128, max: 220, squash: false }
		],
		() => ({
			category: pd.view.rows.map((r) => (r.kind === 'valuationMark' ? '' : (r.categoryName ?? (r.transferPartnerId ? 'Transfer' : 'Uncategorized')))),
			notes: pd.view.rows.map((r) => r.notes ?? ''),
			outflow: pd.view.rows.map((r) => (r.amountPaise < 0 ? formatPaise(-r.amountPaise) : '')),
			inflow: pd.view.rows.map((r) => (r.amountPaise > 0 ? formatPaise(r.amountPaise) : '')),
			balance: pd.view.rows.map((r) => formatPaise(r.balancePaise))
		}),
		() => pd.colWidths
	);
	let tableEl = $state<HTMLTableElement | null>(null);
	$effect(() => colWidths.attach(tableEl));
	const futureRows = $derived(rowsDesc.filter((r) => r.date > pd.view.todayDate));
	const currentRows = $derived(rowsDesc.filter((r) => r.date <= pd.view.todayDate));

	// MC3: every amount on THIS page is native to the account's own currency
	// (register rows, opening, holding value/invested/return) — one small
	// wrapper so every call site stays symbol-correct without repeating
	// `{ currency: account.currency }` everywhere. The base (INR) equivalent is
	// a SEPARATE, explicit "≈" line (below) — native is always primary (MC3).
	function formatPaise(paise: number, opts?: Parameters<typeof m.money>[1]): string {
		return m.money(paise, { ...opts, currency: account.currency });
	}

	const chargeLabel = $derived(account.liability ? 'Charge' : 'Withdrawal');
	const paymentLabel = $derived(account.liability ? 'Payment' : 'Deposit');

	// ── S2/S3 holding header + valuation mark ("Update value") ──────────────────
	let markOpen = $state(false);
	// The account's own settings at its top (Monarch's Edit, YNAB's Edit account).
	let editOpen = $state(false);
	// F1 RD15: the close dialog for an account with money left.
	let closeOpen = $state(false);
	let closeTo = $state('');
	let closeAmount = $state('');
	let closeBusy = $state(false);
	const closeTarget = $derived(pd.transferTargets.find((t) => t.id === closeTo));
	// Header and toolbar flyout triggers are Standard buttons (the top bar's Add is the one
	// accent, DECISIONS-S4 D6); Popover triggers can't take the Button component, so its classes.
	const standardBtn =
		'inline-flex h-8 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-3 text-body font-semibold hover:bg-surface-2 aria-expanded:bg-surface-2';
	// The mark form's default = the current value as a positive magnitude (a
	// liability's value is stored negative; the user types the outstanding).
	const valueDefault = $derived(
		pd.holding ? (Math.abs(pd.holding.currentValuePaise) / 100).toFixed(2) : ''
	);
	function pctText(pct: number | null): string {
		return pct === null ? '' : `${pct >= 0 ? '+' : ''}${(pct * 100).toFixed(1)}%`;
	}

	/** Normalize a payee name the same way the server does (for prefill lookup). */
	function normalize(s: string): string {
		return s.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
	}
	const prefillByName = $derived(
		new Map(pd.payees.map((p) => [p.nameNormalized, p.rememberedCategoryId]))
	);

	// ── entry-row state ────────────────────────────────────────────────────────
	let adding = $state(false);
	let keepOpen = $state(true); // Enter → save & new; Ctrl/Cmd+Enter → save single
	let submitting = $state(false);

	// Seeded fresh by openEntry() each time the row opens (carrying today's date);
	// '' initial never renders because the entry row is hidden until then.
	let date = $state('');
	let payee = $state('');
	let payeeAccount = $state(''); // the transfer line picked in Payee (posted as its id)
	let category = $state('');
	let withdrawal = $state('');
	let deposit = $state('');
	let notes = $state('');
	let received = $state(''); // MC2 inline FX: amount in the target account's currency

	// Init to null (not undefined): the entry row's Payee uses `bind:ref` on the
	// shadcn Input whose `ref` prop is `$bindable(null)`. Binding `undefined` to a
	// prop that has a fallback value throws Svelte's `props_invalid_value` in the
	// production build, which aborted the entire entry-row render (C1 capture loop).
	let payeeInput: HTMLInputElement | null = $state(null);

	function resetRow(carryDate: string) {
		payee = '';
		payeeAccount = '';
		category = '';
		withdrawal = '';
		deposit = '';
		notes = '';
		received = '';
		date = carryDate;
	}

	// MC2: the inline "Transfer → X" is cross-currency when X's currency
	// differs from this account's — then the entry row reveals a "received" field
	// (amount native to X). Same-currency transfers stay single-amount (C3).
	const fxTarget = $derived.by(() => {
		const t = transferTargetOf(pd.transferTargets, payee, payeeAccount);
		return t && t.currency !== account.currency ? t : null;
	});

	async function openEntry(carryDate?: string) {
		if (!isOpen) return;
		adding = true;
		// After a save the next row keeps the date just used (C1 RD5): a batch of back-dated rows
		// doesn't retype it each time.
		resetRow(carryDate || pd.view.todayDate);
		await tick();
		payeeInput?.focus();
	}

	let newTxBtn = $state<HTMLButtonElement | null>(null);
	async function closeEntry() {
		adding = false;
		writeDraft(draftFor, null); // Esc or Cancel discards the draft (C1 RD7)
		// Esc removed the focused field; hand focus back to the button that opened the row.
		await tick();
		newTxBtn?.focus();
	}

	// ── C1 RD7: a half-filled new row is kept as a draft ────────────────────
	// Leaving the register keeps the unsaved row for this account (sessionStorage: this
	// session only, across a reload too) and coming back restores it with focus. Saving,
	// Esc or Cancel clears it. Nothing reaches the ledger until the row is saved.
	type Draft = { date: string; payee: string; category: string; withdrawal: string; deposit: string; notes: string; received: string };
	const draftKey = (id: string) => `miserly:draft:${id}`;
	function readDraft(id: string): Draft | null {
		try {
			const raw = sessionStorage.getItem(draftKey(id));
			return raw ? (JSON.parse(raw) as Draft) : null;
		} catch {
			return null;
		}
	}
	function writeDraft(id: string | null, d: Draft | null) {
		if (!id) return;
		try {
			if (d) sessionStorage.setItem(draftKey(id), JSON.stringify(d));
			else sessionStorage.removeItem(draftKey(id));
		} catch {
			// Storage unavailable: the row lives only while the page is open.
		}
	}
	// The account the open row belongs to (the page is reused when moving between registers).
	let draftFor = $state<string | null>(null);
	$effect.pre(() => {
		const id = account.id;
		untrack(() => {
			if (draftFor === id) return;
			draftFor = id;
			const d = isOpen ? readDraft(id) : null;
			if (!d) {
				adding = false;
				return;
			}
			({ date, payee, category, withdrawal, deposit, notes, received } = d);
			adding = true;
			void tick().then(() => payeeInput?.focus());
		});
	});
	$effect(() => {
		if (!adding) return;
		const d: Draft = { date, payee, category, withdrawal, deposit, notes, received };
		const filled = Boolean(d.payee || d.category || d.withdrawal || d.deposit || d.notes || d.received);
		writeDraft(untrack(() => draftFor), filled ? d : null);
	});

	/** Fill-when-blank: choosing a known payee prefills the category IF empty (C1); choosing a
	 *  "Transfer → X" prefills the category the last transfer into its destination had. */
	function onPayeeChange() {
		if (category !== '') return;
		const target = transferTargetOf(pd.transferTargets, payee, payeeAccount);
		if (target) {
			const side = deposit.trim() !== '' && withdrawal.trim() === '' ? 'in' : 'out';
			const remembered = rememberedTransferCategory(pd.transferCategories, account, target, side);
			if (remembered) category = remembered;
			return;
		}
		const remembered = prefillByName.get(normalize(payee));
		if (remembered) category = remembered;
	}

	// Ctrl+N on this page means a new row here, not Quick Add ($lib/shortcuts).
	$effect(() => {
		const claim = (e: Event) => {
			// In Chart view there's no register: Ctrl+N falls through to Quick Add.
			if (ed.cell || !isOpen || pd.chartView) return;
			e.preventDefault();
			if (adding) payeeInput?.focus();
			else void openEntry();
		};
		window.addEventListener('miserly:new', claim);
		return () => window.removeEventListener('miserly:new', claim);
	});

	// Within the entry row: Enter = save & new; Ctrl/Cmd+Enter = save single; Esc = cancel.
	let formEl: HTMLFormElement | undefined = $state();
	function onEntryKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			void closeEntry();
			return;
		}
		// Enter on a button in the row (calendar, category picker) belongs to that button.
		const t = e.target as HTMLElement | null;
		const onButton = t?.tagName === 'BUTTON' && (t as HTMLButtonElement).type !== 'submit';
		if (e.key === 'Enter' && t?.tagName !== 'TEXTAREA' && !onButton) {
			e.preventDefault();
			if (submitting) return; // already saving this row (hunt H-data-A)
			keepOpen = !(e.metaKey || e.ctrlKey);
			formEl?.requestSubmit();
		}
	}

	// After a successful add, the server returns { added }. Reopen or close per keepOpen.
	// Only a new result runs this: reading keepOpen tracked it, so Save's click (keepOpen = false)
	// after an Enter-save re-ran it on the old result and closed the row before it was sent.
	$effect(() => {
		if (form?.added) untrack(() => (keepOpen ? void openEntry(date) : void closeEntry()));
	});

	const fieldErrors = $derived((form && 'errors' in form ? form.errors : undefined) as
		| Record<string, string>
		| undefined);

	// ── C4 edit / delete / undo / reorder / bulk state ──────────────────────────
	let editingId = $state<string | null>(null);
	let selected = $state<Set<string>>(new Set());
	let bulkCategory = $state('');

	// A1: Shift-click a checkbox selects the range from the last one clicked (Gmail's
	// list); Ctrl+A on a focused row selects every row shown.
	let anchorId: string | null = null;
	let shiftHeld = false;
	function toggle(id: string) {
		const next = new Set(selected);
		const on = !next.has(id);
		const order = [...filteredFuture, ...filteredCurrent].map((r) => r.id);
		const from = anchorId ? order.indexOf(anchorId) : -1;
		const to = order.indexOf(id);
		if (shiftHeld && from >= 0 && to >= 0) {
			for (const rid of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
				if (on) next.add(rid);
				else next.delete(rid);
			}
		} else if (on) next.add(id);
		else next.delete(id);
		shiftHeld = false;
		anchorId = id;
		selected = next;
	}
	function selectAllShown() {
		selected = new Set([...filteredFuture, ...filteredCurrent].map((r) => r.id));
	}

	const editingCell = (r: Row, f: CellField) => ed.editing(r, f);
	const openCell = (r: Row, f: CellField) => ed.open(r, f);
	const commitCell = (r: Row, f: CellField, v: string) => ed.commit(r, f, v);
	const cellKeydown = (e: KeyboardEvent, r: Row, f: CellField) => ed.keydown(e, r, f);
	// A value update's payee cell holds its value: a click there edits the value.
	const cellClick = (e: MouseEvent, r: Row, f: CellField) => ed.click(e, r, f === 'payee' && r.kind === 'valuationMark' ? 'target' : f);
	const categoryPicked = (r: Row, v: string, how: PickHow) => ed.categoryPicked(r, v, how);

	// The Starting balance row edits its date and amount in place, as Actual's (it was wholly
	// read-only, its amount only in Balance; item 2.5). It saves through setOpening (F1: the opening
	// is the account's own field, not a transaction row).
	let openingCell = $state<null | 'date' | 'outflow' | 'inflow'>(null);
	let openingDraft = $state('');
	let openingInput = $state<HTMLInputElement | null>(null);
	async function openOpening(f: 'date' | 'outflow' | 'inflow') {
		if (!isOpen) return;
		openingCell = f;
		const p = account.openingPaise;
		openingDraft = f === 'date' ? (account.openingDate ?? pd.view.todayDate) : f === 'outflow' ? (p < 0 ? (-p / 100).toFixed(2) : '') : p > 0 ? (p / 100).toFixed(2) : '';
		await tick();
		openingInput?.focus();
		openingInput?.select?.();
	}
	async function saveOpening(f: 'date' | 'outflow' | 'inflow', v: string) {
		if (openingCell !== f) return;
		openingCell = null;
		const date = f === 'date' ? v : (account.openingDate ?? pd.view.todayDate);
		let paise = account.openingPaise;
		if (f !== 'date') {
			const n = Number(v.replace(/[,\s₹$€£]/gu, ''));
			if (!Number.isFinite(n)) return;
			if (v.trim() === '') {
				// Clearing the column it's in empties the balance; clearing the other one changes nothing.
				if ((f === 'outflow' && paise < 0) || (f === 'inflow' && paise > 0)) paise = 0;
			} else paise = Math.round(n * 100) * (f === 'outflow' ? -1 : 1);
		}
		if (paise === account.openingPaise && date === account.openingDate) return;
		await runAction('?/setOpening', { opening: (paise / 100).toFixed(2), openingDate: date });
	}
	function openingKeydown(e: KeyboardEvent, f: 'date' | 'outflow' | 'inflow') {
		if (e.key === 'Enter' || e.key === 'Tab') {
			e.preventDefault();
			void saveOpening(f, openingDraft);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			openingCell = null;
		} else e.stopPropagation();
	}
	// shared classes for the in-cell editors + the click-to-edit "view" affordance
	const cellInputCls =
		'h-7 rounded-control border border-input border-b-brand-mark bg-surface px-2 text-body text-foreground outline-none shadow-[inset_0_-1px_0_var(--accent)]';
	// min-h-5.5: an empty cell's target is as tall as a filled one (22 px); with no text it collapsed
	// to its 2 px padding and the hover ring drew a thin pill.
	const cellViewCls =
		'-mx-1 min-h-5.5 cursor-text rounded-control px-1 py-px text-left hover:bg-surface-2 hover:ring-1 hover:ring-border-strong';
	const catName = (id: string): string =>
		pd.categoryGroups.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? 'Uncategorized';
	// The category picker's list: Uncategorized, then each group's categories under its name.
	const categoryOptions = $derived([
		{ value: '', label: 'Uncategorized' },
		...pd.categoryGroups.flatMap((g) => g.categories.map((c) => ({ value: c.id, label: c.name, group: g.name })))
	]);
	// A transfer with no category is still a transfer, not uncategorised spending (item 2.5).
	const transferCategoryOptions = $derived([{ value: '', label: 'No category' }, ...categoryOptions.slice(1)]);
	/** The picker's list for a row: a category hidden since still shows as the row's own. */
	const withCurrent = (r: Row) => {
		const base = r.transferPartnerId ? transferCategoryOptions : categoryOptions;
		return r.categoryId && !base.some((o) => o.value === r.categoryId)
			? [{ value: r.categoryId, label: r.categoryName ?? 'Hidden category' }, ...base]
			: base;
	};
	const TYPE_LABELS: Record<FilterType, string> = {
		all: 'All', income: 'Income', expense: 'Expense',
		transfer: 'Transfers', mark: 'Value updates', uncategorized: 'Uncategorized'
	};

	// ── Register filters / find-in-account (Actual parity). All
	// client-side over the rows here; a search or filter loads the pages not yet scrolled to first.
	// Saved filters persist in localStorage (UI state, kept
	// out of the financial DB per the tech-stack "separate UI/session state" rule).
	type FilterType = 'all' | 'income' | 'expense' | 'transfer' | 'mark' | 'uncategorized';
	let q = $state('');
	let filterCategory = $state(''); // '' = any; else a category id
	let filterType = $state<FilterType>('all');
	let filterFrom = $state('');
	let filterTo = $state('');

	const filterActive = $derived(
		q.trim() !== '' || filterCategory !== '' || filterType !== 'all' || filterFrom !== '' || filterTo !== ''
	);

	function matchesFilter(r: Row): boolean {
		const isTransfer = r.transferPartnerId !== null;
		const isMark = r.kind === 'valuationMark';
		if (filterType === 'income' && !(r.amountPaise > 0 && !isTransfer && !isMark)) return false;
		if (filterType === 'expense' && !(r.amountPaise < 0 && !isTransfer && !isMark)) return false;
		if (filterType === 'transfer' && !isTransfer) return false;
		if (filterType === 'mark' && !isMark) return false;
		if (filterType === 'uncategorized' && !(r.categoryId === null && !isTransfer && !isMark)) return false;
		if (filterCategory !== '' && r.categoryId !== filterCategory) return false;
		if (filterFrom !== '' && r.date < filterFrom) return false;
		if (filterTo !== '' && r.date > filterTo) return false;
		if (q.trim() !== '') {
			const needle = q.trim().toLowerCase();
			const hay = [
				r.payeeName,
				r.categoryName,
				r.notes,
				r.counterpartAccountName,
				(Math.abs(r.amountPaise) / 100).toFixed(2)
			]
				.filter(Boolean)
				.join(' ')
				.toLowerCase();
			if (!hay.includes(needle)) return false;
		}
		return true;
	}

	function clearFilters() {
		q = '';
		filterCategory = '';
		filterType = 'all';
		filterFrom = '';
		filterTo = '';
	}
	// Another register (the page is reused): its own selection, search and filters, so Delete
	// can't act on the last register's selected rows. Declared after what it resets: an effect
	// above them ran at start-up, before they existed, and the register failed to load.
	let selectionFor = untrack(() => account.id);
	$effect.pre(() => {
		const id = account.id;
		if (id === selectionFor) return;
		selectionFor = id;
		untrack(() => {
			selected = new Set();
			clearFilters();
		});
	});

	// ACTUAL-PARITY #15: a header click sorts (Upcoming stays above To date).
	const sort = new RowSort();
	const sortText = (r: Row, key: SortKey): string =>
		key === 'payee'
			? r.kind === 'valuationMark' ? 'Value update' : (r.payeeName ?? r.counterpartAccountName ?? '')
			: key === 'category'
				? r.transferPartnerId ? (r.categoryName ?? 'Transfer') : (r.categoryName ?? '')
				: (r.notes ?? '');
	const filteredFuture = $derived(sort.apply(futureRows.filter(matchesFilter), sortText));
	const filteredCurrent = $derived(sort.apply(currentRows.filter(matchesFilter), sortText));

	const shownCount = $derived(filteredFuture.length + filteredCurrent.length);
	// Every row held here, loaded or not (the server's count).
	const totalCount = $derived(pd.view.total);
	// A search, a filter or a sort other than newest first reads every row: the rest load first.
	$effect(() => {
		if ((filterActive || sort.key !== 'date' || sort.asc) && list.next !== null) untrack(() => void list.all());
	});

	// ── ACTUAL-PARITY #1: only the rows in view are rendered ($lib/register/grid's RowWindow);
	// "Upcoming" and "To date" headings are items in the list too.
	type Item = { kind: 'group'; key: string; label: string } | { kind: 'row'; key: string; r: Row };
	const items = $derived.by((): Item[] => {
		const out: Item[] = [];
		if (filteredFuture.length > 0) {
			out.push({ kind: 'group', key: 'g-upcoming', label: 'Upcoming' });
			for (const r of filteredFuture) out.push({ kind: 'row', key: r.id, r });
			out.push({ kind: 'group', key: 'g-to-date', label: 'To date' });
		}
		for (const r of filteredCurrent) out.push({ kind: 'row', key: r.id, r });
		return out;
	});
	const win = new RowWindow<Item>(() => items);

	// ── ACTUAL-PARITY #10: Export, a CSV of the rows shown (search and filters applied): every
	// row, the pages not yet scrolled to loaded first.
	async function exportCsv() {
		await list.all();
		await tick();
		const shown = [...filteredFuture, ...filteredCurrent];
		downloadCsv(`${account.name} ${pd.view.todayDate}.csv`, [
			['Date', 'Payee', 'Category', 'Notes', chargeLabel, paymentLabel, 'Balance', 'Currency'],
			...shown.map((r) => [
				r.date,
				// As the screen says it (P4 hunt: "another account" where the row reads "From Alice").
				r.kind === 'valuationMark'
					? `Value update to ${rupees(Math.abs(r.markTargetPaise ?? 0))}`
					: r.transferPartnerId
						? `Transfer: ${transferLabel(r)}`
						: (r.payeeName ?? ''),
				r.transferPartnerId ? (r.categoryName ?? 'Transfer') : (r.categoryName ?? ''),
				r.notes ?? '',
				r.amountPaise < 0 ? rupees(-r.amountPaise) : null,
				r.amountPaise > 0 ? rupees(r.amountPaise) : null,
				rupees(r.balancePaise),
				account.currency
			])
		]);
	}

	// ── ACTUAL-PARITY #9: the row menu (right-click a row): Duplicate, Move up and Move down
	// within its day (the mouse's reorder, was Alt+arrows only), Select, Delete (with its Undo).
	// Outside a row the browser's own menu shows.
	let menuRow = $state<Row | null>(null);
	function pickMenuRow(e: MouseEvent) {
		const id = (e.target as Element | null)?.closest('tr[data-txrow]')?.getAttribute('data-txrow');
		const r = id ? rowsDesc.find((x) => x.id === id) : undefined;
		if (!r) {
			e.stopPropagation();
			return;
		}
		menuRow = r;
	}
	/** The row next to `r` on screen (dir -1 above, 1 below), if it is on the same day. */
	function sameDayNeighbour(r: Row, dir: 1 | -1): boolean {
		const i = items.findIndex((it) => it.key === r.id);
		const n = items[i + dir];
		return !!n && n.kind === 'row' && n.r.date === r.date;
	}
	async function menuAct(kind: 'dup' | 'del' | 'up' | 'down' | 'select') {
		const r = menuRow;
		if (!r) return;
		if (kind === 'select') toggle(r.id);
		else if (kind === 'up' || kind === 'down') reorder(r, kind);
		else if (kind === 'dup') await runAction('?/duplicateTx', { txId: r.id });
		else await runAction('?/deleteTx', { txId: r.id, expectedUpdatedAt: r.updatedAt });
	}
	$effect(() => win.attach());
	// A filter or a reload changes the list: place the window again.
	$effect(() => {
		void items.length;
		untrack(() => void tick().then(() => win.update()));
	});
	// The next, older page when the drawn window nears the end of the rows here.
	$effect(() => {
		if (list.next !== null && win.start + win.size >= items.length - 40) untrack(() => void list.more());
	});

	// The Filter button's count: how many of the flyout's filters are set (search is separate).
	const activeFilters = $derived(
		[filterCategory !== '', filterType !== 'all', filterFrom !== '', filterTo !== ''].filter(Boolean).length
	);
	let filterOpen = $state(false);

	// ── Saved filters (localStorage) ────────────────────────────────────────────
	interface SavedFilter {
		name: string;
		q: string;
		category: string;
		type: FilterType;
		from: string;
		to: string;
	}
	const SAVED_KEY = 'miserly:register-filters';
	let savedFilters = $state<SavedFilter[]>([]);
	$effect(() => {
		try {
			savedFilters = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]') as SavedFilter[];
		} catch {
			savedFilters = [];
		}
	});
	function persistSaved() {
		try {
			localStorage.setItem(SAVED_KEY, JSON.stringify(savedFilters));
		} catch {
			/* storage unavailable — non-fatal */
		}
	}
	function saveCurrentFilter() {
		const name = prompt('Save this filter as:')?.trim();
		if (!name) return;
		savedFilters = [
			...savedFilters.filter((f) => f.name !== name),
			{ name, q, category: filterCategory, type: filterType, from: filterFrom, to: filterTo }
		];
		persistSaved();
	}
	function applySaved(f: SavedFilter) {
		q = f.q;
		filterCategory = f.category;
		filterType = f.type;
		filterFrom = f.from;
		filterTo = f.to;
	}
	function deleteSaved(name: string) {
		savedFilters = savedFilters.filter((f) => f.name !== name);
		persistSaved();
	}

	// ── Keys on the FOCUSED row. Rows are focusable (tabindex); ↑/↓ move focus between
	// rows, F2 opens the row form, Del deletes (with its Undo) — through the per-row hidden form
	// (so undo/optimistic-concurrency still apply). No single letters and no Backspace: focus
	// comes back to the row after Esc, and a stray key there made rows (ACTUAL-PARITY #11). Native row focus,
	// so it never hijacks page scroll and stays out of the C1 entry loop.
	// Keyboard follow-through (hunt H-kb-A/B): E moves focus into the edit form and back to
	// the row when it closes; Delete / U leave focus on the row now at the same place,
	// instead of dropping it to <body> when the focused row re-renders or goes.
	const txRows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-txrow]'));
	let lastEditing: string | null = null;
	$effect(() => {
		const id = editingId;
		const prev = lastEditing;
		lastEditing = id;
		void tick().then(() => {
			if (id) {
				document.querySelector<HTMLElement>(`[data-editrow="${id}"] input:not([type=hidden])`)?.focus();
			} else if (prev && (document.activeElement === document.body || document.activeElement?.id === 'app-content' || !document.activeElement?.isConnected)) {
				document.querySelector<HTMLElement>(`[data-txrow="${prev}"]`)?.focus();
			}
		});
	});
	let refocusIndex: number | null = null;
	$effect(() => {
		void form;
		if (refocusIndex === null) return;
		const i = refocusIndex;
		refocusIndex = null;
		void tick().then(() => {
			const list = txRows();
			list[Math.min(i, list.length - 1)]?.focus();
		});
	});

	// P11: Move up / Move down left the hover bar (a layman read ↑ ↓ as "previous row"); they
	// reorder same-day rows from the keyboard, Alt+↑ / Alt+↓ on a focused row.
	let reorderForm = $state<HTMLFormElement>();
	let reorderVals = $state({ txId: '', direction: 'up' });
	function reorder(r: Row, direction: 'up' | 'down') {
		reorderVals = { txId: r.id, direction };
		void tick().then(() => reorderForm?.requestSubmit());
	}

	function rowKeydown(e: KeyboardEvent, r: Row) {
		if (!isOpen || editingId || ed.cell) return;
		// Only keys on the focused row itself: a key on a checkbox or button inside it is theirs.
		if (e.target !== e.currentTarget) return;
		const row = e.currentTarget as HTMLElement;
		const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-txrow]'));
		if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
			e.preventDefault();
			reorder(r, e.key === 'ArrowUp' ? 'up' : 'down');
			return;
		}
		if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
			e.preventDefault();
			selectAllShown();
			return;
		}
		switch (e.key) {
			case 'ArrowDown': {
				e.preventDefault();
				const list = rows();
				list[list.indexOf(row) + 1]?.focus();
				break;
			}
			case 'ArrowUp': {
				e.preventDefault();
				const list = rows();
				list[list.indexOf(row) - 1]?.focus();
				break;
			}
			case 'F2':
				if (r.kind !== 'valuationMark') {
					e.preventDefault();
					editingId = r.id;
				}
				break;
			case 'Delete':
				e.preventDefault();
				refocusIndex = rows().indexOf(row);
				row.querySelector<HTMLButtonElement>('[data-act="del"]')?.click();
				break;
		}
	}


	/** True for a transfer row whose counterpart is in a DIFFERENT currency
	 *  (MC2) — the case that needs the extra "other leg + linkage rate" chrome;
	 *  a same-currency transfer needs nothing beyond the counterpart name. */
	function isCrossCurrencyLeg(r: Row): boolean {
		return r.transferPartnerId !== null && r.counterpartCurrency !== null && r.counterpartCurrency !== account.currency;
	}

	/** "1 <source> = <rate> <dest>" — source/dest read off THIS leg's sign, so
	 *  the same stored (destination-per-1-source) rate displays correctly from
	 *  either side of the pair without any inversion arithmetic. */
	function linkageRateLabel(r: Row): string {
		if (r.fxRateScaled === null || r.fxScale === null || r.counterpartCurrency === null) return '';
		const outflow = r.amountPaise < 0; // this leg is the SOURCE
		const sourceCcy = outflow ? account.currency : r.counterpartCurrency;
		const destCcy = outflow ? r.counterpartCurrency : account.currency;
		// Said the way people quote it, one of the stronger currency: "1 USD = 84.51 INR", never
		// "1 INR = 0.011905 USD" (item 2.5). From the two legs' own amounts, which are exact.
		const mine = Math.abs(r.amountPaise);
		const theirs = Math.abs(r.counterpartAmountPaise ?? 0);
		if (mine > 0 && theirs > 0) {
			const [src, dst] = outflow ? [mine, theirs] : [theirs, mine];
			const fmt = (x: number) => x.toLocaleString('en-IN', { maximumFractionDigits: 4 });
			return dst >= src ? `1 ${sourceCcy} = ${fmt(dst / src)} ${destCcy}` : `1 ${destCcy} = ${fmt(src / dst)} ${sourceCcy}`;
		}
		return `1 ${sourceCcy} = ${formatRate(r.fxRateScaled, r.fxScale)} ${destCcy}`;
	}

	// A link to one transaction (`?tx=<id>`, from All transactions, recent
	// activity, a report or search) lands on its row: in view, focused, tinted for 2 s.
	let landedId = $state<string | null>(null);
	afterNavigate(() => {
		const id = page.url.searchParams.get('tx');
		if (!id) return;
		void tick().then(async () => {
			const tr = await win.reveal(id, 'center');
			if (!tr) return;
			tr.focus({ preventScroll: true });
			landedId = id;
			setTimeout(() => {
				if (landedId === id) landedId = null;
			}, 2100);
		});
	});

	// The last-deleted id, for the Undo affordance.
	const undoId = $derived(form && 'undoId' in form ? (form.undoId as string) : undefined);

	// ── H2 Members / Share panel ────────────────────────────────────────────────
	const shared = $derived(pd.holders.length > 1);
	// The picker offers Circle members who are neither the owner nor already a
	// holder (filtered here, client-side, per the task's UI note — the server
	// list is the full live roster).
	const holderIds = $derived(new Set(pd.holders.map((h) => h.userId)));
	const shareable = $derived(pd.circleMembers.filter((cm) => !holderIds.has(cm.id)));
	let shareTarget = $state('');
	let removing = $state<string | null>(null); // holder id pending the "Remove?" confirm
	// H2 RD8: the owner's split editor. A stated split that gives someone 0 % (added after it) opens
	// with the fields showing; otherwise "Set split" opens it. Values are percentages as typed.
	let splitOpen = $state(false);
	let splitVals = $state<Record<string, string>>({});
	let splitFrom = $state('');
	const zeroHolders = $derived(pd.split.statedFrom !== null ? pd.holders.filter((h) => h.shareBp === 0) : []);
	const showSplit = $derived(pd.isOwner && shared && (splitOpen || zeroHolders.length > 0));
	const splitVal = (h: { userId: string; shareBp: number }) => splitVals[h.userId] ?? String(h.shareBp / 100);
	const splitTotalBp = $derived(
		pd.holders.reduce((sum, h) => {
			const v = /^\d{1,3}(\.\d{1,2})?$/u.test(splitVal(h).trim()) ? Math.round(Number(splitVal(h)) * 100) : NaN;
			return sum + v;
		}, 0)
	);
	function openSplit() {
		splitVals = {};
		splitFrom = pd.view.todayDate;
		splitOpen = true;
	}
	// Payee suggestions: the known payees, then the accounts under a heading per section (C3:
	// picking "Transfer → X" creates a linked pair; the line posts X's id). Actual's order.
	const payeeOptions = $derived([...pd.payees.map((p) => p.displayName), ...transferOptions(pd.transferTargets)]);
	// In place, "Transfer → X" makes the row a transfer to X, or moves a transfer's other side there
	// (editTx; same currency only: a transfer between currencies needs both amounts).
	const cellPayeeOptions = $derived([
		...pd.payees.map((p) => p.displayName),
		...transferOptions(pd.transferTargets.filter((t) => t.currency === account.currency))
	]);
	/** A transfer's payee: the other account, or (when the viewer can't see it, P0) the person who
	 *  moved the money, "From Alice" (ACTUAL-PARITY #23); never the hidden account's name. */
	const transferLabel = (r: Row): string =>
		r.counterpartAccountName ??
		(r.partnerLeft ? `${r.amountPaise > 0 ? 'From' : 'To'} ${r.partnerLeft} (left)` : null) ??
		(r.enteredByName ?? r.enteredByUsername
			? `${r.amountPaise > 0 ? 'From' : 'To'} ${r.enteredByName ?? r.enteredByUsername}`
			: 'Transfer');
	/** The name a row is announced by (checkbox + row actions): payee, counterpart or mark. */
	const rowName = (r: Row): string =>
		r.kind === 'valuationMark'
			? 'value update'
			: r.transferPartnerId
				? `transfer to ${r.counterpartAccountName ?? 'account'}`
				: (r.payeeName ?? 'transaction');
	// Memo is a column at every width (ACTUAL-PARITY #6, DL-13 folded it below 1300 px,
	// which left a row without a memo no place to click and hid the "by" stamps): 14 %, with
	// Category, the amounts and the balance a little narrower so Payee keeps about 170 px at 1232.
	const cols = 8;
	const removingHolder = $derived(pd.holders.find((h) => h.userId === removing) ?? null);

	const errCls = 'text-caption font-normal text-neg';
</script>

<!-- One-line header (the approved register mock): the balance as the headline, the
     section and currency as meta, Share and (a holding) Update value as flyouts. 12 px to the
     toolbar: header and toolbar are one block over the table (first row at or above 190 px). -->
{#snippet detailsLine()}
	<span>{#each details as d, i (d.key)}{i > 0 ? ', ' : ''}{#if d.showLabel}{d.label}{' '}{/if}<span class="num text-text">{detailText(d)}</span>{/each}{#each pd.workedOut as w, i (w.key)}{details.length + i > 0 ? ', ' : ''}<span
				title={w.kind === 'date' ? 'Worked out from the date you typed, by the scheme’s rule' : 'Money put in since 1 April (the rows Invested counts), of the yearly limit'}
				>{w.label}{' '}<span class="num text-text"
					>{w.kind === 'date'
						? formatDate(w.value)
						: `${m.money(w.paise, { currency: account.currency })} of ${m.money(w.limitPaise, { currency: account.currency })}`}</span
				></span
			>{/each}</span>
{/snippet}

<PageHeader title={account.name} tight meta={details.length + pd.workedOut.length > 0 ? detailsLine : undefined}>
	{#snippet headline()}
		<div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
			<span class="num text-display font-normal {levelToneClass(pd.view.asOfTodayPaise)}"
				><Figure text={formatPaise(pd.view.asOfTodayPaise)} /></span
			>
			{#if pd.holding && pd.showReturn && pd.holding.earnedPaise !== null}
				<!-- Rule 4: a closed holding holds nothing; it shows what it earned, money out minus money in. -->
				<span class="num text-body {toneClass(pd.holding.earnedPaise)}"
					>{pd.holding.earnedPaise < 0 ? 'Lost' : 'Earned'} {m.signedMoney(pd.holding.earnedPaise, { currency: account.currency })}</span
				>
				{#if pd.holding.annualReturn !== null}
					<span class="num text-body {toneClass(pd.holding.annualReturn)}" title={`Since ${formatDate(pd.holding.trackedSince ?? '')}`}
						>{formatPercent(pd.holding.annualReturn)} a year</span
					>
				{/if}
			{:else if pd.holding && pd.showReturn && pd.holding.paidOutRate !== null}
				<!-- C1 A: interest paid out where it lands (the bank), so the holding shows its stated rate. -->
				<span class="num text-body text-text-muted">Invested {formatPaise(pd.holding.costBasisPaise)}</span>
				<span class="num text-body" title="Interest paid out where it lands; the rate from its details"
					>{formatPercent(pd.holding.paidOutRate)} a year, paid out</span
				>
			{:else if pd.holding && pd.paidInOnly}
				<!-- S5 RD16 (E2): an EPS counts at what was paid in; EPFO shows no balance for it. -->
				<span class="text-body text-text-muted" title="A pension from 58 after 10 years’ service. EPFO shows no balance for it, so it counts at what was paid in."
					>EPS pension, counted at what was paid in</span
				>
			{:else if pd.holding && pd.showReturn}
				<span class="num text-body text-text-muted">Invested {formatPaise(pd.holding.costBasisPaise)}</span>
				<span class="num text-body {toneClass(pd.holding.returnPaise)}"
					>{m.signedMoney(pd.holding.returnPaise, { currency: account.currency })}{#if pd.holding.returnPct !== null}{' '}({pctText(pd.holding.returnPct)}){/if}</span
				>
				<!-- I2: return per year since tracking began (S2 RD6); nothing until there's a year and a value update. -->
				{#if pd.holding.annualReturn !== null}
					<span class="num text-body {toneClass(pd.holding.annualReturn)}" title={`Since ${formatDate(pd.holding.trackedSince ?? '')}`}
						>{formatPercent(pd.holding.annualReturn)} a year</span
					>
				{/if}
			{/if}
			<!-- C7 / rule 3: when a holding's value or a loan's outstanding was
			     last known; amber once stale. -->
			{#if pd.holding?.isHolding && pd.holding.markable && pd.holding.lastUpdated && isOpen}
				<span class="text-body {pd.holding.stale ? 'text-warn' : 'text-text-muted'}" title={formatDate(pd.holding.lastUpdated)}
					>Last updated {updatedAgo(pd.holding.lastUpdated, pd.view.todayDate)}</span
				>
			{/if}
			{#if pd.view.projectedPaise !== pd.view.asOfTodayPaise}
				<span class="num text-body text-text-muted">{formatPaise(pd.view.projectedPaise)} including upcoming</span>
			{/if}
			<!-- The section is in the top bar's path now (All accounts / Loans / HDFC), not repeated here. -->
			<span class="text-body text-text-muted">{account.currency}</span>
			{#if pd.myShare}
				<!-- H2 RD8: the register keeps the full amounts; the header says the viewer's part. -->
				<span class="num text-body text-text-muted">Your share {formatShare(pd.myShare.bp)}, {formatPaise(pd.myShare.partPaise)}</span>
				{#if pd.side === 'Liability'}
					<span class="num text-body text-text-muted">You're liable for the full {formatPaise(Math.abs(pd.view.asOfTodayPaise))}</span>
				{/if}
			{/if}
			{#if account.status !== 'open'}<Badge variant="secondary">Closed</Badge>{/if}
			<!-- MC3: native is primary; a foreign account shows its base equivalent, or an honest
			     "rate needed" with the way to set it (MC1). -->
			{#if account.currency !== pd.baseCurrency}
				{#if pd.rateNeeded}
					<span class="text-caption text-warn"
						>No {account.currency} rate. <a href={`/settings?currency=${account.currency}`} class="font-semibold hover:underline">Set rate</a></span
					>
				{:else if pd.baseApproxPaise !== null}
					<span class="num text-body text-text-muted">{m.baseApprox(pd.baseApproxPaise)}</span>
				{/if}
			{/if}
		</div>
	{/snippet}
	{#snippet actions()}
		{#if pd.holding?.isHolding && pd.holding.markable && isOpen}
			<!-- S3 valuation mark: a flyout from the header, not a card on the page. It opens under the
			     button and stays inside the page column: a long headline wraps the actions to the left
			     edge, where an end-aligned flyout lay over the sidebar. -->
			<Popover.Root bind:open={markOpen}>
				<Popover.Trigger class={standardBtn}><TrendingUp size={16} aria-hidden="true" /> Update value</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						sideOffset={4}
						align="start"
						collisionBoundary={typeof document === 'undefined' ? undefined : (document.getElementById('app-content') ?? undefined)}
						collisionPadding={8}
						class="z-50 w-80 rounded-overlay border border-border bg-popover p-4 text-popover-foreground shadow-[var(--shadow-pop)] outline-none {flyoutMotion}"
					>
						<form
							method="POST"
							action="?/mark"
							use:enhance={() => async ({ update }) => { await update(); markOpen = false; }}
							class="flex flex-col gap-3"
						>
							<label class="flex flex-col gap-1 text-caption font-normal text-text-muted">
								New value ({ccy})
								<Input name="target" inputmode="decimal" value={valueDefault} class="num" />
							</label>
							<label class="flex flex-col gap-1 text-caption font-normal text-text-muted">
								As of
								<DateField name="date" value={pd.view.todayDate} />
							</label>
							{#if fieldErrors?.target}<span class={errCls}>{fieldErrors.target}</span>{/if}
							{#if fieldErrors?.date}<span class={errCls}>{fieldErrors.date}</span>{/if}
							<div class="flex justify-end gap-2">
								<Button type="submit" variant="outline" size="sm">Save value</Button>
								<Button type="button" variant="outline" size="sm" onclick={() => (markOpen = false)}>Cancel</Button>
							</div>
						</form>
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
		{/if}
		{#if canWrite}
		<button type="button" class={standardBtn} onclick={() => (editOpen = true)}>
			<ColourIcon name="edit" size={16} /> Edit account
		</button>
		{/if}
		<Dialog.Root bind:open={editOpen}>
			<Dialog.Content class="sm:max-w-[30rem]">
				<Dialog.Header><Dialog.Title>Edit account</Dialog.Title></Dialog.Header>
				<form
					id="edit-account"
					method="POST"
					action="?/editAccount"
					use:enhance={() => async ({ result, update }) => {
						await update({ reset: false });
						if (result.type === 'success') editOpen = false;
					}}
					class="flex flex-col gap-3"
				>
					<label class="flex flex-col gap-1 text-caption font-normal text-text-muted">
						Name
						<Input name="name" value={account.name} required maxlength={TEXT_LIMITS.name} aria-invalid={fieldErrors?.name ? 'true' : undefined} />
					</label>
					{#if fieldErrors?.name}<span class={errCls}>{fieldErrors.name}</span>{/if}
					{#if account.status === 'open' && !pd.openingLocked}
					<div class="grid grid-cols-2 gap-3">
						<label class="flex flex-col gap-1 text-caption font-normal text-text-muted">
							{openingField.label} ({ccy})
							<Input name={openingField.name} inputmode="decimal" value={(openingField.shown / 100).toFixed(2)} placeholder={openingField.placeholder} class="num" />
						</label>
						<label class="flex flex-col gap-1 text-caption font-normal text-text-muted">
							As of
							<DateField name="openingDate" value={account.openingDate ?? ''} class="w-full" />
						</label>
					</div>
					{:else if pd.openingLocked}
					<!-- C5 C: the opening is from before this member joined: not shown at all. -->
					<p class="text-caption text-text-muted">The starting balance is from before this account was shared with you.</p>
					{:else}
					<!-- Nothing on a closed account changes, so its opening is shown, not edited. -->
					<div class="grid grid-cols-2 gap-3">
						<div class="flex flex-col gap-1 text-caption font-normal text-text-muted">
							<!-- The amount carries its symbol, so the label doesn't repeat it ("(₹)" over "₹0.00"). -->
							{openingField.label}
							<span class="num flex h-8 items-center text-body text-text">{formatPaise(openingField.shown)}</span>
						</div>
						<div class="flex flex-col gap-1 text-caption font-normal text-text-muted">
							As of
							<span class="flex h-8 items-center text-body text-text">{account.openingDate ? formatDate(account.openingDate) : 'None'}</span>
						</div>
					</div>
					<p class="text-caption text-text-muted">Reopen to change the opening balance.</p>
					{/if}
					{#if fieldErrors?.opening}<span class={errCls}>{fieldErrors.opening}</span>{/if}
					{#if fieldErrors?.outstanding}<span class={errCls}>{fieldErrors.outstanding}</span>{/if}
					{#if fieldErrors?.openingDate}<span class={errCls}>{fieldErrors.openingDate}</span>{/if}
					<!-- S5 RD8: the same optional details as Add account; clearing one removes it. -->
					<AccountDetailsFields
						fields={moduleProfile(account.type)?.infoFields ?? []}
						values={infoValues(account.infoJson)}
						errors={fieldErrors ?? {}}
						withCcy={(label) => `${label} (${ccy})`}
					/>
				</form>
				<Dialog.Footer class="items-center">
					<!-- F1 RD15: a zero balance closes at once (reversible: Reopen); money left asks where it goes. -->
					{#if account.status === 'open' && (pd.closeBalancePaise !== 0 || pd.closeUpcoming)}
						<Button type="button" variant="destructive" class="mr-auto" onclick={() => { editOpen = false; closeTo = ''; closeAmount = ''; closeOpen = true; }}>Close account</Button>
					{:else if account.status === 'open'}
						<form method="POST" action="?/close" use:enhance={() => async ({ update }) => { await update(); editOpen = false; }} class="mr-auto">
							<Button type="submit" variant="destructive">Close account</Button>
						</form>
					{:else}
						<form method="POST" action="?/reopen" use:enhance={() => async ({ update }) => { await update(); editOpen = false; }} class="mr-auto">
							<Button type="submit" variant="outline">Reopen account</Button>
						</form>
					{/if}
					<Button type="submit" form="edit-account">Save</Button>
					<Button type="button" variant="outline" onclick={() => (editOpen = false)}>Cancel</Button>
				</Dialog.Footer>
			</Dialog.Content>
		</Dialog.Root>
		<!-- F1 RD15: Fluent ContentDialog with three answers (move, adjust, cancel). It stays open on a
		     refusal so the message shows beside the field; it never light-dismisses. -->
		<Dialog.Root bind:open={closeOpen}>
			<Dialog.Content class="sm:max-w-[28rem]" showCloseButton={false} interactOutsideBehavior="ignore">
				{#if pd.closeUpcoming}
				<!-- Rows dated after today would stay outside the close; it waits for them. -->
				<Dialog.Header>
					<Dialog.Title>Close {account.name}?</Dialog.Title>
					<Dialog.Description class="text-body text-text">{pd.closeUpcoming}</Dialog.Description>
				</Dialog.Header>
				<Dialog.Footer>
					<Button type="button" variant="outline" onclick={() => (closeOpen = false)}>OK</Button>
				</Dialog.Footer>
				{:else}
				<Dialog.Header>
					<Dialog.Title>Close {account.name}?</Dialog.Title>
					<Dialog.Description class="text-body text-text">
						{account.name} still {pd.closeBalancePaise > 0 ? 'holds' : 'owes'}
						<span class="num">{formatPaise(Math.abs(pd.closeBalancePaise))}</span>.{#if pd.closeBalancePaise > 0}
							Move it to the account it went to. If it's gone, write it off as a loss.{:else} Move it to another account, or close with
							an adjustment that sets the balance to zero.{/if}
					</Dialog.Description>
				</Dialog.Header>
				<form
					id="close-account"
					method="POST"
					action="?/close"
					use:enhance={() => {
						closeBusy = true;
						return async ({ result, update }) => {
							await update();
							closeBusy = false;
							if (result.type === 'success') closeOpen = false;
						};
					}}
					class="flex flex-col gap-3"
				>
					<input type="hidden" name="toId" value={closeTo} />
					<label for="close-to" class="flex flex-col gap-1 text-caption font-normal text-text-muted">
						{pd.closeBalancePaise > 0 ? 'Move it to' : 'Pay it from'}
						<Select.Root type="single" bind:value={closeTo}>
							<Select.Trigger id="close-to" class="w-full">{closeTarget?.label ?? 'Choose an account'}</Select.Trigger>
							<Select.Content>
								{#each pd.transferTargets as t (t.id)}<Select.Item value={t.id} label={t.label} />{/each}
							</Select.Content>
						</Select.Root>
					</label>
					{#if fieldErrors?.closeTo}<span class={errCls}>{fieldErrors.closeTo}</span>{/if}
					{#if closeTarget && closeTarget.currency !== account.currency}
						<label class="flex flex-col gap-1 text-caption font-normal text-text-muted">
							Amount in {closeTarget.currency}
							<Input name="otherAmount" inputmode="decimal" class="num" bind:value={closeAmount} required />
						</label>
					{/if}
					{#if fieldErrors?.closeAmount}<span class={errCls}>{fieldErrors.closeAmount}</span>{/if}
				</form>
				<Dialog.Footer>
					<Button type="submit" form="close-account" name="mode" value="move" disabled={closeBusy || !closeTarget}>
						{pd.closeBalancePaise > 0 ? 'Move and close' : 'Pay and close'}
					</Button>
					<!-- The write-off says what it does (Pay or Move and close leads, as Actual's close asks for a target). -->
					<Button type="submit" form="close-account" variant="outline" name="mode" value="adjust" disabled={closeBusy}
						>{pd.closeBalancePaise > 0 ? `Write off ${formatPaise(pd.closeBalancePaise)} as a loss` : 'Close with adjustment'}</Button
					>
					<Button type="button" variant="outline" onclick={() => (closeOpen = false)}>Cancel</Button>
				</Dialog.Footer>
				{/if}
			</Dialog.Content>
		</Dialog.Root>
		<!-- H2 Members (DL-17): who has access, in a header flyout. A holder always sees the list;
		     only the OWNER can share/remove. -->
		{#if canWrite}
		<Popover.Root>
			<Popover.Trigger class={standardBtn}>
				{#if pd.holders.length > 1}
					<ColourIcon name="share" size={16} /> Shared with {pd.holders.length - 1}
				{:else if pd.isOwner}
					<ColourIcon name="share" size={16} /> Share
				{:else}
					<Lock size={16} aria-hidden="true" /> Private
				{/if}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					sideOffset={4}
					align="end"
					class="z-50 max-h-(--bits-popover-content-available-height) w-85 overflow-y-auto rounded-overlay border border-border bg-popover p-4 text-popover-foreground shadow-[var(--shadow-pop)] outline-none {flyoutMotion}"
				>
					<p class="mb-2 text-body font-semibold">People with access</p>
					<ul class="flex flex-col gap-1">
						{#each pd.holders as h (h.userId)}
							<li class="flex h-8 items-center gap-2 rounded-control px-2 text-body hover:bg-control-hover">
								<span>{h.displayName}</span>
								{#if h.isOwner}<Badge variant="secondary">Owner</Badge>{/if}
								{#if shared}<span class="num ml-auto text-text-muted">{formatShare(h.shareBp)}</span>{/if}
								{#if pd.isOwner && !h.isOwner}
									<Tooltip label="Remove">
										{#snippet child({ props })}
											<button
												{...props}
												type="button"
												onclick={() => (removing = h.userId)}
												aria-label="Remove {h.displayName ?? 'member'}"
												class="{shared ? '' : 'ml-auto'} grid size-6 place-items-center rounded-control text-text-muted hover:bg-control-hover hover:text-neg"
											><X size={14} aria-hidden="true" /></button>
										{/snippet}
									</Tooltip>
								{/if}
							</li>
						{/each}
					</ul>

					{#if pd.isOwner}
						<form
							method="POST"
							action="?/shareMember"
							use:enhance={() => async ({ update }) => { await update(); shareTarget = ''; }}
							class="mt-3 flex flex-wrap items-center gap-2"
						>
							<Select.Root type="single" name="targetUserId" bind:value={shareTarget}>
								<Select.Trigger aria-label="Share with" class="w-55">
									{shareTarget === ''
										? 'Share with…'
										: (shareable.find((cm) => cm.id === shareTarget)?.displayName ?? 'Share with…')}
								</Select.Trigger>
								<Select.Content>
									{#each shareable as cm (cm.id)}<Select.Item value={cm.id} label={cm.displayName} />{/each}
								</Select.Content>
							</Select.Root>
							<Button type="submit" variant="outline" disabled={shareTarget === ''}>Share</Button>
							{#if fieldErrors?.targetUserId}<span class={errCls}>{fieldErrors.targetUserId}</span>{/if}
						</form>
						{#if shareable.length === 0 && pd.circleMembers.length > 0}
							<p class="mt-2 text-caption text-text-muted">Everyone in your group already has access.</p>
						{/if}
					{/if}
					{#if pd.isOwner && shared}
						{#if zeroHolders.length > 0}
							<StatusBar intent="info" autoDismiss={false} dismissible={false} class="mt-3"
								>{zeroHolders.map((h) => h.displayName).join(' and ')} {zeroHolders.length === 1 ? 'has' : 'have'} 0%. Set the split.</StatusBar
							>
						{/if}
						{#if showSplit}
							<form
								in:foldIn
								out:foldOut
								method="POST"
								action="?/setShares"
								use:enhance={() => async ({ result, update }) => { await update(); if (result.type === 'success') { splitOpen = false; splitVals = {}; } }}
								class="mt-3 flex flex-col gap-2 border-t border-divider pt-3"
							>
								<p class="text-body font-semibold">Split</p>
								{#each pd.holders as h (h.userId)}
									<label class="flex items-center gap-2 text-body">
										<span class="flex-1 truncate">{h.displayName}</span>
										<Input
											name={`share_${h.userId}`}
											value={splitVal(h)}
											oninput={(e) => (splitVals[h.userId] = e.currentTarget.value)}
											inputmode="decimal"
											class="num w-20 text-right"
										/>
										<span class="text-text-muted">%</span>
									</label>
								{/each}
								<div class="flex justify-between text-body">
									<span>Total</span>
									<span class="num {splitTotalBp === 10_000 ? '' : 'text-neg'}">{Number.isNaN(splitTotalBp) ? '–' : formatShare(splitTotalBp)}</span>
								</div>
								<label class="flex flex-col gap-1 text-caption font-normal text-text-muted">
									From
									<DateField name="from" bind:value={() => splitFrom || pd.view.todayDate, (v) => (splitFrom = v)} class="w-full" />
								</label>
								<p class="text-caption text-text-muted">Earlier dates keep the split they had.</p>
								{#if fieldErrors?.split}<span class={errCls}>{fieldErrors.split}</span>{/if}
								<div class="flex justify-end gap-2">
									<Button type="submit" variant="outline" disabled={splitTotalBp !== 10_000}>Save</Button>
									{#if zeroHolders.length === 0}
										<Button type="button" variant="outline" onclick={() => (splitOpen = false)}>Cancel</Button>
									{/if}
								</div>
							</form>
						{:else}
							<div class="pt-3" in:foldIn out:foldOut><Button type="button" variant="outline" onclick={openSplit}>Set split</Button></div>
						{/if}
					{/if}
					{#if form && 'splitSaved' in form && form.splitSaved}<StatusBar trigger={form} class="mt-3">Split saved.</StatusBar>{/if}
					{#if form && 'shared' in form && form.shared}<StatusBar trigger={form} class="mt-3">Shared from today. Earlier dates stay yours.</StatusBar>{/if}
					{#if form && 'unshared' in form && form.unshared}<StatusBar trigger={form} class="mt-3">Access removed from today.</StatusBar>{/if}
					{#if removingHolder}
						<ConfirmDialog
							bind:open={() => removing !== null, (v) => { if (!v) removing = null; }}
							title={`Remove ${removingHolder.displayName} from this account?`}
							action="?/unshareMember"
							fields={{ targetUserId: removingHolder.userId }}
							confirmLabel="Remove"
						>
							From today {removingHolder.displayName} can only read this account's rows up to yesterday, and sees nothing after. You can share it with them again later.
						</ConfirmDialog>
					{/if}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
		{/if}
		{#if pd.family}
			<!-- S5 RD16: an EPF and its EPS are one page with tabs; Chart is the EPF's value against money put in. -->
			<LinkSwitch
				label="View"
				items={[
					{ href: `/accounts/${pd.family.parent.id}`, label: pd.family.parent.label, current: account.id === pd.family.parent.id && !pd.chartView },
					{ href: `/accounts/${pd.family.child.id}`, label: pd.family.child.label, current: account.id === pd.family.child.id },
					{ href: `/accounts/${pd.family.parent.id}?view=chart`, label: 'Chart', current: account.id === pd.family.parent.id && pd.chartView }
				]}
			/>
		{:else if pd.showReturn}
			<!-- I1 placement B: Transactions is the default and opens as before; Chart swaps the register out. -->
			<LinkSwitch
				label="View"
				items={[
					{ href: page.url.pathname, label: 'Transactions', current: !pd.chartView },
					{ href: `${page.url.pathname}?view=chart`, label: 'Chart', current: pd.chartView }
				]}
			/>
		{/if}
	{/snippet}
</PageHeader>

{#if pd.holding?.passedZero}
	<!-- Payments alone passed zero; the interest was never recorded. No calculation (data hard line). -->
	<StatusBar intent="warning" autoDismiss={false} dismissible={false} class="mb-3">{PASSED_ZERO_MESSAGE}</StatusBar>
{/if}
{#if pd.showReturn && pd.holding?.overdrawn && isOpen}
	<!-- A withdrawal passed the recorded value; the fix is a dated value update. -->
	<StatusBar intent="warning" autoDismiss={false} dismissible={false} class="mb-3">{OVERDRAWN_MESSAGE}</StatusBar>
{/if}

{#if pd.chartView}
	<Section title="Value and invested">
		{#snippet actions()}
			<LinkSwitch
				label="Range"
				items={RANGES.map((r) => ({ href: `${page.url.pathname}?view=chart&range=${r}`, label: r === 'ALL' ? 'All' : r, current: pd.chart?.timeframe === r }))}
			/>
		{/snippet}
		{#if pd.chart && pd.chart.points.length >= 2}
			<ValueInvested points={pd.chart.points} currency={account.currency} height={320} />
		{:else}
			<p class="text-body text-text-muted">The chart starts after one full month.</p>
		{/if}
	</Section>
{:else}
<!-- One toolbar row (the register mock): search, the Filter flyout, the count, New transaction.
     With rows selected the row holds the bulk commands instead (C4 bulk set-category / delete). -->
<div class="mb-2 flex min-h-8 flex-wrap items-center gap-control">
	{#if selected.size > 0}
		<span class="text-body">{selected.size} selected</span>
		<!-- A closed account's rows don't change (F1): no bulk commands, only Clear selection. -->
		{#if isOpen}
		<form
			method="POST"
			action="?/bulkTx"
			use:enhance={() => async ({ update }) => { await update(); selected = new Set(); }}
			class="flex items-center gap-2"
		>
			<input type="hidden" name="op" value="setCategory" />
			{#each [...selected] as id (id)}<input type="hidden" name="ids" value={id} />{/each}
			<Select.Root type="single" name="categoryId" bind:value={bulkCategory}>
				<Select.Trigger aria-label="Bulk category" class="h-8 w-50 bg-surface text-body">
					{bulkCategory === '' ? 'Category…' : catName(bulkCategory)}
				</Select.Trigger>
				<Select.Content>
					{#each pd.categoryGroups as g (g.id)}
						<Select.Group>
							<Select.GroupHeading>{g.name}</Select.GroupHeading>
							{#each g.categories as c (c.id)}<Select.Item value={c.id} label={c.name} />{/each}
						</Select.Group>
					{/each}
				</Select.Content>
			</Select.Root>
			<Button type="submit" variant="outline" disabled={bulkCategory === ''}><Tag aria-hidden="true" /> Set category</Button>
		</form>
		<!-- Reversible (soft delete) → no confirm; the result offers Undo. -->
		<form method="POST" action="?/bulkTx" use:enhance={() => async ({ update }) => { await update(); selected = new Set(); }}>
			<input type="hidden" name="op" value="delete" />
			{#each [...selected] as id (id)}<input type="hidden" name="ids" value={id} />{/each}
			<Button type="submit" variant="destructive">
				<Trash2 aria-hidden="true" /> Delete {m.count(selected.size)} {selected.size === 1 ? 'transaction' : 'transactions'}
			</Button>
		</form>
		{#if selected.size === 1 && !pd.view.rows.some((r) => selected.has(r.id) && (hiddenHalf(r) || r.kind === 'valuationMark'))}
			{@const one = [...selected][0]}
			<form method="POST" action="?/duplicateTx" use:enhance={() => async ({ update }) => { await update(); selected = new Set(); }}>
				<input type="hidden" name="txId" value={one} />
				<Button type="submit" variant="outline"><Copy aria-hidden="true" /> Duplicate</Button>
			</form>
		{/if}
		{/if}
		<Button variant="ghost" onclick={() => (selected = new Set())}><X aria-hidden="true" /> Clear selection</Button>
	{:else}
		<Input
			type="search"
			data-page-search
			bind:value={q}
			placeholder="Search payee, category, notes, amount"
			aria-label="Search this account"
			class="w-75"
		/>
		<Popover.Root bind:open={filterOpen}>
			<Popover.Trigger class={standardBtn}>
				<ListFilter size={16} aria-hidden="true" /> Filter
				{#if activeFilters > 0}<Badge variant="secondary">{activeFilters}</Badge>{/if}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					sideOffset={4}
					align="start"
					class="z-50 w-90 rounded-overlay border border-border bg-popover p-4 text-popover-foreground shadow-[var(--shadow-pop)] outline-none {flyoutMotion}"
				>
					<div class="grid grid-cols-2 gap-3">
						<label class="flex flex-col gap-1 text-caption font-normal text-text-muted">
							Type
							<Select.Root type="single" value={filterType} onValueChange={(v) => (filterType = (v ?? 'all') as FilterType)}>
								<Select.Trigger aria-label="Filter by type" class="h-8 text-body">{TYPE_LABELS[filterType]}</Select.Trigger>
								<Select.Content>
									<Select.Item value="all" label="All" />
									<Select.Item value="income" label="Income" />
									<Select.Item value="expense" label="Expense" />
									<Select.Item value="transfer" label="Transfers" />
									<Select.Item value="mark" label="Value updates" />
									<Select.Item value="uncategorized" label="Uncategorized" />
								</Select.Content>
							</Select.Root>
						</label>
						<label class="flex flex-col gap-1 text-caption font-normal text-text-muted">
							Category
							<Select.Root type="single" value={filterCategory} onValueChange={(v) => (filterCategory = v ?? '')}>
								<Select.Trigger aria-label="Filter by category" class="h-8 text-body">{filterCategory === '' ? 'Any' : catName(filterCategory)}</Select.Trigger>
								<Select.Content>
									<Select.Item value="" label="Any" />
									{#each pd.categoryGroups as g (g.id)}
										<Select.Group>
											<Select.GroupHeading>{g.name}</Select.GroupHeading>
											{#each g.categories as c (c.id)}<Select.Item value={c.id} label={c.name} />{/each}
										</Select.Group>
									{/each}
								</Select.Content>
							</Select.Root>
						</label>
						<label class="flex flex-col gap-1 text-caption font-normal text-text-muted">
							From
							<DateField bind:value={filterFrom} aria-label="From date" />
						</label>
						<label class="flex flex-col gap-1 text-caption font-normal text-text-muted">
							To
							<DateField bind:value={filterTo} aria-label="To date" />
						</label>
					</div>
					{#if savedFilters.length > 0}
						<div class="mt-3 flex flex-wrap items-center gap-2 text-caption">
							<span class="text-text-muted">Saved</span>
							{#each savedFilters as f (f.name)}
								<span class="inline-flex items-center gap-1 rounded-control border border-border bg-surface-2 px-2 py-0.75">
									<button type="button" class="hover:text-brand-ink" onclick={() => applySaved(f)}>{f.name}</button>
									<Tooltip label="Delete saved filter">
										{#snippet child({ props })}
											<button {...props} type="button" class="text-text-muted hover:text-neg" aria-label="Delete saved filter {f.name}" onclick={() => deleteSaved(f.name)}><X size={14} aria-hidden="true" /></button>
										{/snippet}
									</Tooltip>
								</span>
							{/each}
						</div>
					{/if}
					<div class="mt-4 flex justify-end gap-2">
						<Button variant="outline" size="sm" onclick={saveCurrentFilter} disabled={!filterActive}>Save filter</Button>
						<Button variant="ghost" size="sm" onclick={clearFilters} disabled={!filterActive}>Clear</Button>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
		{#if filterActive}
			<Button variant="ghost" onclick={clearFilters}>Clear filters</Button>
		{/if}
	{/if}
	<span class="flex-1"></span>
	{#if selected.size === 0 && totalCount > 0}
		<Button variant="ghost" onclick={exportCsv}><Download aria-hidden="true" /> Export</Button>
	{/if}
	<span class="text-caption text-text-muted">
		{filterActive ? `${m.count(shownCount)} of ${m.count(totalCount)}` : m.count(totalCount)}
		{totalCount === 1 ? 'transaction' : 'transactions'}
	</span>
	<!-- While rows are selected the row holds only their commands (Gmail), so it never wraps. -->
	{#if isOpen && selected.size === 0}
		<Button variant="outline" bind:ref={newTxBtn} onclick={() => openEntry()} disabled={adding}><Plus aria-hidden="true" /> New transaction</Button>
	{/if}
</div>
{/if}

{#if pd.view.access.heldUntil}
	<!-- C5 C (H2 RD9): a member who has left reads the dates they held, and nothing after. -->
	<StatusBar intent="info" autoDismiss={false} dismissible={false} class="mb-2"
		>This account was shared with you until {formatDate(pd.view.access.heldUntil)}. You can read its rows up to then; the people who hold it now can change them.</StatusBar
	>
{:else if account.status !== 'open'}
	<p class="mb-2 text-body text-text-muted">This account is closed. Reopen it from Edit account to add transactions.</p>
{/if}
{#if fieldErrors?._}
	<StatusBar intent="error" trigger={form} class="mb-2">{fieldErrors._}</StatusBar>
{/if}
<!-- A cell edit that didn't save says so (it used to revert silently and look saved). -->
{#if ed.error}<StatusBar intent="error" trigger={ed.error} class="mb-2">{ed.error}</StatusBar>{/if}
{#if ed.notice}<StatusBar intent="info" trigger={ed.notice} class="mb-2">{ed.notice.text}.</StatusBar>{/if}
<!-- Undo affordance after a delete (C4 RD1: restores the pair for a transfer). -->
{#if form && 'deleted' in form && form.deleted && undoId}
	<StatusBar trigger={form} autoDismiss={false} class="mb-2">
		Transaction deleted.
		{#snippet action()}
			<form method="POST" action="?/restoreTx" use:enhance>
				<input type="hidden" name="txId" value={undoId} />
				<Button type="submit" data-undo variant="ghost" size="xs" class="text-brand-ink">Undo</Button>
			</form>
		{/snippet}
	</StatusBar>
{/if}
{#if form && 'accountSaved' in form && form.accountSaved}<StatusBar trigger={form} class="mb-2">Account saved.</StatusBar>{/if}
{#if form?.closed}<StatusBar trigger={form} class="mb-2">Account closed.</StatusBar>{/if}
{#if form?.reopened}<StatusBar trigger={form} class="mb-2">Account reopened.</StatusBar>{/if}
{#if form && 'duplicated' in form && form.duplicated}<StatusBar trigger={form} class="mb-2">Duplicated.</StatusBar>{/if}
{#if form && 'reordered' in form && form.reordered}<StatusBar trigger={form} class="mb-2">Order updated.</StatusBar>{/if}
{#if form && 'marked' in form && form.marked}<StatusBar trigger={form} class="mb-2">Value updated.</StatusBar>{/if}
{#if form && 'bulked' in form && form.bulked}
	{#if form.op === 'delete' && form.deletedIds.length > 0}
		<StatusBar trigger={form} autoDismiss={false} class="mb-2">
			Deleted {m.count(form.deletedIds.length)} {form.deletedIds.length === 1 ? 'transaction' : 'transactions'}.{#if form.skippedHidden}{' '}{form.skippedHidden} {form.skippedHidden === 1 ? 'transfer was' : 'transfers were'} left: the other half is in an account you can't see.{/if}
			{#snippet action()}
				<form method="POST" action="?/restoreBulkTx" use:enhance>
					{#each form.deletedIds as id (id)}<input type="hidden" name="ids" value={id} />{/each}
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
{#if form && 'restored' in form && form.restored && 'restoredCount' in form}
	<StatusBar trigger={form} class="mb-2">
		Restored {m.count(form.restoredCount ?? 0)} {form.restoredCount === 1 ? 'transaction' : 'transactions'}.
	</StatusBar>
{/if}

{#if !pd.chartView}
<TableFrame>
	<!-- One table style (.data-table, dense register rows). Date is a column (the mock); Memo gets
	     its own column from 1300 px and follows the payee as a caption below that (DL-13). Row
	     actions float at the row's end on hover or focus, over the balance (Outlook's hover
	     actions), so they cost no column. -->
	<table class="data-table dense min-w-160" bind:this={tableEl}>
		<colgroup>
			{#each ['check', 'date', 'payee', 'category', 'notes', 'outflow', 'inflow', 'balance'] as id (id)}<col style={colWidths.style(id)} />{/each}
		</colgroup>
		<thead>
			<tr>
				<th class="check"><span class="sr-only">Select</span></th>
				{#each [['date', 'Date', ''], ['payee', 'Payee', ''], ['category', 'Category', ''], ['notes', 'Notes', ''], ['outflow', chargeLabel, 'num'], ['inflow', paymentLabel, 'num']] as [key, label, cls] (key)}
					<th class="relative {cls}" aria-sort={sort.aria(key as SortKey)}>
						<button type="button" class={sortBtnCls} onclick={() => sort.by(key as SortKey)}>
							{label}
							{#if sort.key === key}{#if sort.asc}<ArrowUp size={12} aria-hidden="true" />{:else}<ArrowDown size={12} aria-hidden="true" />{/if}{/if}
						</button>
						{#if colWidths.resizable(key as string)}<ColumnResizer cols={colWidths} id={key as string} label={label as string} />{/if}
					</th>
				{/each}
				<th class="num">Balance</th>
			</tr>
		</thead>
		<tbody>
			<!-- The keyboard entry row, inside the grid at the top (newest first). One form in one
			     cell, laid out on the table's own column widths so each field sits under its column. -->
			{#if adding}
				<tr class="entry-row">
					<td colspan={cols} class="!p-0">
						<!-- The form is the natural boundary for the C1 Enter/Ctrl+Enter/Esc capture loop. -->
						<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
						<form
							method="POST"
							action="?/addTransaction"
							bind:this={formEl}
							onkeydown={onEntryKeydown}
							class="entry-grid"
							style="grid-template-columns: {colWidths.template}"
							use:enhance={({ cancel }) => {
								// One save per entry: a second Enter / Ctrl+Enter / click while the first is in
								// flight would post the same row again (hunt H-data-A).
								if (submitting) {
									cancel();
									return;
								}
								submitting = true;
								return async ({ result, update }) => {
									// The answer's rows patch the list; only the sidebar reloads.
									if (result.type === 'success' && patchFromSave(result.data)) {
										await applyAction(result);
										await refreshNav();
									} else await update({ reset: false });
									submitting = false;
								};
							}}
						>
							<span></span>
							<DateField name="date" bind:value={date} aria-label="Date" required class="w-full" />
							<PayeeCombobox name="payee" options={payeeOptions} bind:inputRef={payeeInput} bind:value={payee} bind:transferAccountId={payeeAccount} transferAccountName="transferAccountId" onchange={onPayeeChange} placeholder="Payee" aria-label="Payee" />
							<PickCombobox name="category" options={categoryOptions} bind:value={category} aria-label="Category" />
							<Input type="text" name="notes" bind:value={notes} maxlength={TEXT_LIMITS.note} placeholder="Notes" aria-label="Notes" class="notes w-full" />
							<Input type="text" name="outflow" inputmode="decimal" bind:value={withdrawal} placeholder="0.00" aria-label={chargeLabel} class="num w-full text-right" />
							<Input type="text" name="inflow" inputmode="decimal" bind:value={deposit} placeholder="0.00" aria-label={paymentLabel} class="num w-full text-right" />
							{#if fxTarget}
								<!-- MC2 cross-currency inline transfer: the amount native to the OTHER account,
								     so both legs stay correct (never a silent 1:1). Before Save in the Tab order. -->
								<div class="extra flex flex-wrap items-center gap-2 text-caption text-text-muted">
									<span>Amount received in <b class="font-semibold text-text">{fxTarget.label}</b> ({fxTarget.currency})</span>
									<Input type="text" name="received" inputmode="decimal" bind:value={received} placeholder={`Amount in ${fxTarget.currency}`} aria-label={`Amount in ${fxTarget.currency}`} class="num w-38 text-right" />
								</div>
							{/if}
							<span class="save-cell flex items-center justify-end gap-1">
								<Tooltip label="Save. Enter saves and starts another" shortcut="Ctrl+Enter">
									{#snippet child({ props })}
										<Button {...props} type="submit" variant="outline" size="sm" disabled={submitting} onclick={() => (keepOpen = false)}>Save</Button>
									{/snippet}
								</Tooltip>
								<Tooltip label="Cancel" shortcut="Esc">
									{#snippet child({ props })}
										<button {...props} type="button" onclick={closeEntry} aria-label="Cancel" class="inline-grid size-8 place-items-center rounded-control text-text-muted hover:bg-control-hover hover:text-foreground"><X size={16} aria-hidden="true" /></button>
									{/snippet}
								</Tooltip>
							</span>
							{#if fieldErrors && Object.keys(fieldErrors).some((f) => f !== '_')}
								<ul class="extra space-y-1">
									{#each Object.entries(fieldErrors) as [field, message] (field)}
										{#if field !== '_'}<li class={errCls}>{message}</li>{/if}
									{/each}
								</ul>
							{/if}
						</form>
					</td>
				</tr>
			{/if}

		</tbody>
		<!-- The rows: a window around the scroll position between two spacers (ACTUAL-PARITY #1).
		     Future-dated rows sit above the as-of-today rows under "Upcoming" (C1 RD2). -->
		<ContextMenu.Root onOpenChange={(o) => { if (!o) menuRow = null; }}>
		<ContextMenu.Trigger>
		{#snippet child({ props })}
		<tbody {...props} bind:this={win.body} oncontextmenucapture={pickMenuRow}>
			{#if win.padTop > 0}<tr aria-hidden="true"><td colspan={cols} style="height:{win.padTop}px;padding:0;border:0"></td></tr>{/if}
			{#each win.visible as it (it.key)}
				{#if it.kind === 'group'}
					<tr class="group-row"><td colspan={cols}>{it.label}</td></tr>
				{:else}
					{@render passbookRow(it.r)}
				{/if}
			{/each}
			{#if win.padBottom > 0}<tr aria-hidden="true"><td colspan={cols} style="height:{win.padBottom}px;padding:0;border:0"></td></tr>{/if}

			<!-- The synthetic "Starting balance" anchor (F1 RD9: derived, not a tx row). C5 C: a member who
			     joined later sees the balance on the day they joined instead, and nothing before it. -->
			{#if list.next !== null}
				<!-- Older rows still to come: the starting balance closes the list once they're here. -->
				{#if list.failed}<tr><td colspan={cols} class="text-text-muted">The older rows didn't load. Reload the page to try again.</td></tr>{/if}
			{:else if pd.view.access.joined && !filterActive}
				<tr class="text-text-muted">
					<td class="check"></td>
					<td class="date">{formatDateShort(pd.view.access.joined.date, pd.view.todayDate)}</td>
					<td class="truncate">Balance when you joined</td>
					<td></td>
					<td></td>
					<td></td>
					<td></td>
					<td class="num">{formatPaise(pd.view.access.joined.balancePaise)}</td>
				</tr>
			{:else if (account.openingPaise !== 0 || account.openingDate) && !filterActive}
				<tr class="text-text-muted">
					<td class="check"></td>
					<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
					<td class="date" onclick={(e) => { if (e.target === e.currentTarget) void openOpening('date'); }}>
						{#if openingCell === 'date'}
							<DateField bind:value={openingDraft} bind:inputRef={openingInput} aria-label="Starting date"
								onchange={(iso) => saveOpening('date', iso)}
								onblur={() => saveOpening('date', openingDraft)} onkeydown={(e) => openingKeydown(e, 'date')}
								class="relative z-10 w-36" />
						{:else if isOpen}
							<button type="button" class="{cellViewCls} font-normal" onclick={() => openOpening('date')}>{account.openingDate ? formatDateShort(account.openingDate, pd.view.todayDate) : 'Set date'}</button>
						{:else}
							{account.openingDate ? formatDateShort(account.openingDate, pd.view.todayDate) : ''}
						{/if}
					</td>
					<td class="truncate">Starting balance</td>
					<td></td>
					<td></td>
					{#each ['outflow', 'inflow'] as const as f (f)}
						{@const shown = f === 'outflow' ? (account.openingPaise < 0 ? formatPaise(-account.openingPaise) : '') : account.openingPaise > 0 ? formatPaise(account.openingPaise) : ''}
						<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
						<td class="num" onclick={(e) => { if (e.target === e.currentTarget) void openOpening(f); }}>
							{#if openingCell === f}
								<input bind:this={openingInput} type="text" inputmode="decimal" bind:value={openingDraft} aria-label={`Starting balance, ${f === 'outflow' ? chargeLabel : paymentLabel}`}
									onblur={() => saveOpening(f, openingDraft)} onkeydown={(e) => openingKeydown(e, f)}
									class="{cellInputCls} num w-full text-right" />
							{:else if isOpen}
								<button type="button" class="{cellViewCls} num block w-[calc(100%+8px)] text-right" onclick={() => openOpening(f)} aria-label={shown ? undefined : `Starting balance, ${f === 'outflow' ? chargeLabel : paymentLabel}`}>{shown}</button>
							{:else}
								{shown}
							{/if}
						</td>
					{/each}
					<td class="num">{formatPaise(account.openingPaise)}</td>
				</tr>
			{/if}

			{#if pd.view.rows.length === 0 && account.openingPaise === 0}
				<tr>
					<!-- An empty register says so and offers the action (item 3, Monarch,
					     Copilot, the Microsoft Store): the button is the toolbar's New transaction. -->
					<td colspan={cols} class="!py-12 text-center">
						<div class="flex flex-col items-center gap-2">
							<ColourIcon name="transactions" size={32} />
							<div class="text-body-lg font-semibold">No transactions yet</div>
							<div class="text-body text-text-muted">Add the first one here.</div>
							<Button variant="outline" class="mt-1" onclick={() => openEntry()} disabled={adding}>Add transaction</Button>
						</div>
					</td>
				</tr>
			{/if}
		</tbody>
		{/snippet}
		</ContextMenu.Trigger>
		<ContextMenu.Portal>
			<ContextMenu.Content class={menuContentCls}>
				{#if menuRow}
					{@const r = menuRow}
					{#if r.kind !== 'valuationMark' && isOpen && !hiddenHalf(r)}
						<ContextMenu.Item class={menuItemCls} onSelect={() => menuAct('dup')}><Copy size={16} aria-hidden="true" />Duplicate</ContextMenu.Item>
					{/if}
					<!-- Not with a search or filter on: the server swaps with the next row of the day, which may be hidden. -->
						{#if isOpen && !filterActive && sort.key === 'date' && !sort.asc && (sameDayNeighbour(r, -1) || sameDayNeighbour(r, 1))}
						<ContextMenu.Item class={menuItemCls} disabled={!sameDayNeighbour(r, -1)} onSelect={() => menuAct('up')}><ArrowUp size={16} aria-hidden="true" />Move up</ContextMenu.Item>
						<ContextMenu.Item class={menuItemCls} disabled={!sameDayNeighbour(r, 1)} onSelect={() => menuAct('down')}><ArrowDown size={16} aria-hidden="true" />Move down</ContextMenu.Item>
					{/if}
					<ContextMenu.Item class={menuItemCls} onSelect={() => menuAct('select')}>{#if selected.has(r.id)}<Square size={16} aria-hidden="true" />Deselect{:else}<SquareCheck size={16} aria-hidden="true" />Select{/if}</ContextMenu.Item>
					{#if isOpen}
						<ContextMenu.Separator class="-mx-1 my-1 h-px bg-border" />
						<ContextMenu.Item class="{menuItemCls} text-neg" disabled={!!hiddenHalf(r)} onSelect={() => menuAct('del')}><Trash2 size={16} aria-hidden="true" />Delete</ContextMenu.Item>
						{#if hiddenHalf(r)}<p class="max-w-64 px-3 pb-1.5 text-caption text-text-muted">{hiddenHalf(r)}</p>{/if}
					{/if}
				{/if}
			</ContextMenu.Content>
		</ContextMenu.Portal>
		</ContextMenu.Root>
	</table>
</TableFrame>
{/if}

<!-- Alt+↑ / Alt+↓ (P11): the same reorder action the hover bar's arrows used. Focus stays on
     the moved row. -->
<form
	bind:this={reorderForm}
	method="POST"
	action="?/reorderTx"
	class="hidden"
	aria-hidden="true"
	use:enhance={() => async ({ update }) => {
		const id = reorderVals.txId;
		await update();
		await tick();
		document.querySelector<HTMLElement>(`[data-txrow="${id}"]`)?.focus();
	}}
>
	<input type="hidden" name="txId" value={reorderVals.txId} />
	<input type="hidden" name="direction" value={reorderVals.direction} />
</form>

{#snippet passbookRow(r: Row)}
	{#if editingId === r.id}
		<!-- Inline edit form (C4). Transfers edit amount/date/notes only; payee/category are managed
		     by the pair service, so those inputs are omitted for a transfer row. -->
		<tr class="entry-row" data-editrow={r.id}>
			<td class="check"></td>
			<td colspan={cols - 1} class="!py-2">
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<form
					method="POST"
					action="?/editTx"
					use:enhance={() => async ({ update }) => { await update(); editingId = null; }}
					onkeydown={(e) => {
						// Esc cancels the edit (a calendar or list inside that took the Esc keeps it).
						if (e.key === 'Escape' && !e.defaultPrevented) {
							e.preventDefault();
							editingId = null;
						}
					}}
					class="flex flex-wrap items-center gap-2"
				>
					<input type="hidden" name="txId" value={r.id} />
					<input type="hidden" name="expectedUpdatedAt" value={r.updatedAt} />
					<DateField name="date" value={r.date} aria-label="Date" required class="w-38" />
					{#if r.transferPartnerId}
						<span class="inline-flex items-center gap-1 text-body"><ArrowLeftRight size={14} class="text-text-muted" aria-hidden="true" />{r.counterpartAccountName ?? 'Transfer'}</span>
						{#if r.takesCategory}<PickCombobox name="category" options={withCurrent(r)} value={r.categoryId ?? ''} aria-label="Category" class="w-45" />{/if}
					{:else}
						<PayeeCombobox name="payee" options={payeeOptions} value={r.payeeName ?? ''} transferAccountName="transferAccountId" placeholder="Payee" aria-label="Payee" class="w-40" />
						<PickCombobox name="category" options={categoryOptions} value={r.categoryId ?? ''} aria-label="Category" class="w-45" />
					{/if}
					<Input type="text" name="outflow" inputmode="decimal" value={outflowStr(r)} placeholder={chargeLabel} aria-label={chargeLabel} class="num w-25 text-right" />
					<Input type="text" name="inflow" inputmode="decimal" value={inflowStr(r)} placeholder={paymentLabel} aria-label={paymentLabel} class="num w-25 text-right" />
					<Input type="text" name="notes" value={r.notes ?? ''} maxlength={TEXT_LIMITS.note} placeholder="Notes" aria-label="Notes" class="w-40" />
					<Button type="submit" variant="outline" size="sm">Save</Button>
					<Button type="button" variant="ghost" size="sm" onclick={() => (editingId = null)}>Cancel</Button>
				</form>
			</td>
		</tr>
	{:else}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<tr
			data-txrow={r.id}
			tabindex="0"
			onkeydown={(e) => rowKeydown(e, r)}
			data-selected={selected.has(r.id) ? '' : undefined}
			data-landed={landedId === r.id ? '' : undefined}
			class="group"
		>
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<td class="check" onpointerdown={(e) => (shiftHeld = e.shiftKey)} onmousedown={(e) => { if (e.shiftKey) e.preventDefault(); }}>
				<Checkbox
					checked={selected.has(r.id)}
					onCheckedChange={() => toggle(r.id)}
					aria-label={`Select ${rowName(r)}, ${formatDateShort(r.date, pd.view.todayDate)}`}
				/>
			</td>
			<!-- P11: the date edits in place like the other cells (Actual, YNAB, any spreadsheet). -->
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
			<td class="date" onclick={(e) => cellClick(e, r, 'date')}>
				{#if editingCell(r, 'date')}
					<!-- A typed date commits on Enter, Tab or blur; a date picked in the calendar commits at once. -->
					<DateField bind:value={ed.draft} bind:inputRef={ed.input} aria-label="Date"
						onchange={(iso) => commitCell(r, 'date', iso)}
						onblur={() => commitCell(r, 'date', ed.draft)} onkeydown={(e) => cellKeydown(e, r, 'date')}
						class="relative z-10 w-36" />
				{:else if ed.can(r, 'date')}
					<button type="button" class="{cellViewCls} font-normal" onclick={() => openCell(r, 'date')}>{formatDateShort(r.date, pd.view.todayDate)}</button>
				{:else}
					{formatDateShort(r.date, pd.view.todayDate)}
				{/if}
			</td>
			<!-- Payee: the payee (click to edit), or the transfer counterpart / the valuation update
			     (pair- or mark-managed, read-only). -->
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
			<td class="truncate" title={r.payeeName ?? r.counterpartAccountName ?? undefined} onclick={(e) => cellClick(e, r, 'payee')}>
				<!-- The payee takes the free space and truncates; the stamp keeps its width and an 8 px gap
				     (a floated stamp let the full-width payee button run under it). -->
				<div class="flex min-w-0 items-center gap-2">
				<div class="min-w-0 flex-1 truncate">
				<!-- Who entered it, on a shared account: in the Payee cell, as in All transactions. -->
				{#if r.kind === 'valuationMark'}
					{#if editingCell(r, 'target')}
						<span class="inline-flex items-center gap-2">Value update to
							<input bind:this={ed.input} type="text" inputmode="decimal" bind:value={ed.draft} aria-label="New value"
								onblur={() => commitCell(r, 'target', ed.draft)} onkeydown={(e) => cellKeydown(e, r, 'target')}
								class="{cellInputCls} num w-36 text-right" /></span>
					{:else if ed.can(r, 'target')}
						<button type="button" class="{cellViewCls} block max-w-full truncate font-normal" onclick={() => openCell(r, 'target')}>Value update to {formatPaise(r.markTargetPaise ?? 0)}</button>
					{:else}
						<span class="block truncate">Value update to {formatPaise(r.markTargetPaise ?? 0)}</span>
					{/if}
				{:else if r.transferPartnerId && editingCell(r, 'payee')}
					<PayeeCombobox bind:inputRef={ed.input} bind:value={ed.draft} bind:transferAccountId={ed.payeeAccount} options={cellPayeeOptions}
						aria-label="Payee" onpick={(v) => commitCell(r, 'payee', v)}
						onblur={() => editingCell(r, 'payee') && commitCell(r, 'payee', ed.draft)} onkeydown={(e) => cellKeydown(e, r, 'payee')}
						class="w-full" />
				{:else if r.transferPartnerId}
					<!-- The ⇆ icon goes to the other account at this transfer (Actual); the name edits. -->
					<span class="inline-flex max-w-full min-w-0 items-center gap-1">
						{#if r.counterpartAccountId}
							<Tooltip label={`Go to ${r.counterpartAccountName}`}>
								{#snippet child({ props })}<a {...props} href="/accounts/{r.counterpartAccountId}?tx={r.transferPartnerId}" class="-m-1 inline-grid flex-none place-items-center rounded-control p-1 text-text-muted hover:bg-control-hover hover:text-brand-ink"
									aria-label={`Go to ${r.counterpartAccountName}`}><ArrowLeftRight size={14} aria-hidden="true" /></a>{/snippet}
							</Tooltip>
						{:else}
							<ArrowLeftRight size={14} class="flex-none text-text-muted" aria-hidden="true" />
						{/if}
						{#if ed.can(r, 'payee')}
							<button type="button" class="{cellViewCls} min-w-0 truncate font-normal" onclick={() => openCell(r, 'payee')}>{transferLabel(r)}</button>
						{:else}
							<span class="min-w-0 truncate">{transferLabel(r)}</span>
						{/if}
					</span>
					{#if isCrossCurrencyLeg(r)}
						<span class="ml-1 text-body text-text-muted">
							{m.moneyWithCode(r.counterpartAmountPaise ?? 0, r.counterpartCurrency ?? '')}, {linkageRateLabel(r)}
						</span>
					{/if}
				{:else if editingCell(r, 'payee')}
					<PayeeCombobox bind:inputRef={ed.input} bind:value={ed.draft} bind:transferAccountId={ed.payeeAccount} options={cellPayeeOptions}
						aria-label="Payee" onpick={(v) => commitCell(r, 'payee', v)}
						onblur={() => editingCell(r, 'payee') && commitCell(r, 'payee', ed.draft)} onkeydown={(e) => cellKeydown(e, r, 'payee')}
						class="w-full" />
				{:else if ed.can(r, 'payee')}
					<button type="button" class="{cellViewCls} max-w-full truncate font-normal" onclick={() => openCell(r, 'payee')}>{r.payeeName ?? 'No payee'}</button>
				{:else}
					{r.payeeName ?? 'No payee'}
				{/if}
				</div>
				{#if shared && (r.enteredByName ?? r.enteredByUsername) && !editingCell(r, 'payee') && !editingCell(r, 'target')}<span class="flex-none text-body text-text-muted">by {r.enteredByName ?? r.enteredByUsername}</span>{/if}
				</div>
			</td>
			<!-- Category: plain text (click to edit); Uncategorized in the warning colour; a transfer
			     reads "Transfer" (the mock), or its category when it takes one (a SIP into a fund). -->
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
			<td class="truncate" onclick={(e) => cellClick(e, r, 'category')}>
				{#if r.kind !== 'valuationMark' && (!r.transferPartnerId || r.takesCategory)}
					{#if editingCell(r, 'category')}
						<PickCombobox bind:inputRef={ed.input} bind:value={ed.draft} options={withCurrent(r)}
							aria-label="Category" inputClass="h-7"
							onpick={(v, how) => categoryPicked(r, v, how)}
							onblur={() => commitCell(r, 'category', ed.draft)} onkeydown={(e) => cellKeydown(e, r, 'category')}
							class="relative z-10 w-full min-w-33" />
					{:else if !ed.can(r, 'category')}
						<span class={r.categoryName ? '' : r.transferPartnerId ? 'text-text-muted' : 'text-warn'}>{r.categoryName ?? (r.transferPartnerId ? 'Transfer' : 'Uncategorized')}</span>
					{:else if r.categoryName}
						<button type="button" onclick={() => openCell(r, 'category')} class="{cellViewCls} max-w-full truncate font-normal" title={r.categoryName}>{r.categoryName}</button>
					{:else if r.transferPartnerId}
						<!-- A transfer with no category is still a transfer, not uncategorised spending. -->
						<button type="button" onclick={() => openCell(r, 'category')} class="{cellViewCls} max-w-full truncate font-normal text-text-muted">Transfer</button>
					{:else}
						<button type="button" onclick={() => openCell(r, 'category')} class="{cellViewCls} max-w-full truncate font-normal text-warn">Uncategorized</button>
					{/if}
				{:else if r.transferPartnerId}
					<span class="text-text-muted">Transfer</span>
				{/if}
			</td>
			<!-- Notes (click to edit on ordinary rows). -->
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
			<!-- One line: the notes truncate. The wrapper lets clicks through to the cell (the whole cell
			     edits the notes); the text itself is a target. -->
			<td onclick={(e) => cellClick(e, r, 'notes')}>
				{#if editingCell(r, 'notes')}
					<input bind:this={ed.input} type="text" bind:value={ed.draft} maxlength={TEXT_LIMITS.note} placeholder="Notes" aria-label="Notes"
						onblur={() => commitCell(r, 'notes', ed.draft)} onkeydown={(e) => cellKeydown(e, r, 'notes')}
						class="{cellInputCls} block w-full" />
				{:else}
					<div class="pointer-events-none flex min-w-0 items-center gap-2 whitespace-nowrap">
						{#if r.notes && ed.can(r, 'notes')}
							<button type="button" onclick={() => openCell(r, 'notes')} class="pointer-events-auto min-w-0 truncate text-left text-text-muted hover:text-text" title={r.notes}>{r.notes}</button>
						{:else if r.notes}
							<span class="min-w-0 truncate text-text-muted" title={r.notes}>{r.notes}</span>
						{/if}
					</div>
				{/if}
			</td>
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
			<td class="num" onclick={(e) => cellClick(e, r, 'outflow')}>
				{#if editingCell(r, 'outflow')}
					<input bind:this={ed.input} type="text" inputmode="decimal" bind:value={ed.draft} aria-label={chargeLabel}
						onblur={() => commitCell(r, 'outflow', ed.draft)} onkeydown={(e) => cellKeydown(e, r, 'outflow')}
						class="{cellInputCls} num w-full text-right" />
				{:else if ed.can(r, 'outflow')}
					<button type="button" class="{cellViewCls} num block w-[calc(100%+8px)] text-right" onclick={() => openCell(r, 'outflow')} aria-label={r.amountPaise < 0 ? undefined : `${chargeLabel} for ${rowName(r)}`}>{r.amountPaise < 0 ? formatPaise(-r.amountPaise) : ''}</button>
				{:else}
					{r.amountPaise < 0 ? formatPaise(-r.amountPaise) : ''}
				{/if}
			</td>
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
			<td class="num" onclick={(e) => cellClick(e, r, 'inflow')}>
				{#if editingCell(r, 'inflow')}
					<input bind:this={ed.input} type="text" inputmode="decimal" bind:value={ed.draft} aria-label={paymentLabel}
						onblur={() => commitCell(r, 'inflow', ed.draft)} onkeydown={(e) => cellKeydown(e, r, 'inflow')}
						class="{cellInputCls} num w-full text-right" />
				{:else if ed.can(r, 'inflow')}
					<button type="button" class="{cellViewCls} num block w-[calc(100%+8px)] text-right" onclick={() => openCell(r, 'inflow')} aria-label={r.amountPaise > 0 ? undefined : `${paymentLabel} for ${rowName(r)}`}>{r.amountPaise > 0 ? formatPaise(r.amountPaise) : ''}</button>
				{:else}
					{r.amountPaise > 0 ? formatPaise(r.amountPaise) : ''}
				{/if}
			</td>
			<td class="num relative {balanceToneClass(r.balancePaise)}">
				{formatPaise(r.balancePaise)}
				<!-- No buttons in rows (Actual has none): cells edit in place, the
				     toolbar acts on selected rows. This hidden form keeps the Delete key working, with
				     its Undo. -->
				{@render PostBtn({ action: '?/deleteTx', label: 'Delete', fields: { txId: r.id, expectedUpdatedAt: r.updatedAt }, act: 'del' })}
			</td>
		</tr>
	{/if}
{/snippet}

<!-- A hidden one-button form per row action, clicked by the row's Delete key. -->
{#snippet PostBtn(props: { action: string; label: string; fields: Record<string, string>; act?: string })}
	<form method="POST" action={props.action} use:enhance hidden>
		{#each Object.entries(props.fields) as [k, v] (k)}<input type="hidden" name={k} value={v} />{/each}
		<button type="submit" data-act={props.act} tabindex="-1" aria-hidden="true">{props.label}</button>
	</form>
{/snippet}


<style>
	/* The entry row's fields on the table's own column widths (check, date, payee, category, memo,
	   withdrawal, deposit, balance), so each field sits under its column, on one line at every
	   width (ACTUAL-PARITY #6: Memo is a column at 1232 px too). */
	:global(.entry-row > td) {
		background: var(--brand-weak);
	}
	.entry-grid {
		display: grid; /* columns: the table's own widths (colWidths.template) */
		align-items: center;
		row-gap: 4px;
		padding: 4px 0;
	}
	.entry-grid > :global(*) {
		margin: 0 4px;
		min-width: 0;
	}
	.entry-grid > :global(.extra) {
		grid-column: 3 / -1;
	}
	.entry-grid > .save-cell {
		grid-row: 1;
		grid-column: -2 / -1;
	}
</style>
