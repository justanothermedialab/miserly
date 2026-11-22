<!--
	The "To categorize" inbox (C5): the count as the header's meta, one
	toolbar row (Apply all suggestions and Group by payee, or the bulk commands while rows are
	selected), the table on the page sorted by date, each row one line: the remembered
	suggestion beside the category picker (AUDIT-S4 S13, F9 to F11). Every uncategorized
	spending row in one list; categorizing is an ordinary edit, reflected everywhere at once.
	The rows come a page at a time as the list scrolls, and only the rows in view are drawn
	($lib/register/pages, RowWindow); grouping by payee and Select all load the rest first.
-->
<script lang="ts">
	import { PageHeader, TableFrame } from '$lib/components/layout';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { Lightbulb } from '@lucide/svelte';
	import { formatDateShort } from '$lib/dates';
	import { tick, untrack } from 'svelte';
	import { applyAction, enhance } from '$app/forms';
	import type { ActionResult } from '@sveltejs/kit';
	import { RowWindow, refreshNav } from '$lib/register/grid.svelte';
	import { PagedList, newestFirst } from '$lib/register/pages.svelte';
	import type { ActionData, PageData } from './$types';
	import { useMoney } from '$lib/format-context';
	import { flowToneClass } from '$lib/format';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import ToggleSwitch from '$lib/components/ToggleSwitch.svelte';
	import { Checkbox } from '$lib/components/ui/checkbox';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	const m = useMoney();
	// The first page comes with the page, the rest a page at a time as the list scrolls.
	const list = new PagedList<Row>(
		() => ({ rows: data.rows, next: data.next }),
		(after, limit) => `/inbox/rows?${new URLSearchParams({ after, limit: String(limit) })}`,
		newestFirst
	);
	const listRows = $derived(list.rows);
	// Categorized rows leave the list here, from the action's answer (its ids); only the sidebar
	// reloads (`app:nav`), never every row of the Inbox. A reload drops the patch (it's for that
	// `data.rows`); Undo reloads, as the rows come back. The counts are the server's, less the rows
	// that left.
	let gone = $state.raw<{ for: PageData['rows']; n: number; suggested: number } | null>(null);
	const goneNow = $derived(gone && gone.for === data.rows ? gone : { n: 0, suggested: 0 });
	const total = $derived(Math.max(0, data.total - goneNow.n));
	async function afterCategorize({ result, update }: { result: ActionResult; update: () => Promise<void> }) {
		const d = result.type === 'success' ? (result.data as { ids?: string[]; affected?: number } | undefined) : undefined;
		// Every row asked for changed: they leave the list. Otherwise (a stale page) it reloads.
		if (d?.ids && d.affected === d.ids.length) {
			const ids = new Set(d.ids);
			const leaving = list.rows.filter((r) => ids.has(r.id));
			gone = { for: data.rows, n: goneNow.n + leaving.length, suggested: goneNow.suggested + leaving.filter((r) => r.suggestedCategoryId).length };
			list.set(list.rows.filter((r) => !ids.has(r.id)));
			await applyAction(result);
			await refreshNav();
		} else await update();
	}

	let selected = $state<Set<string>>(new Set());
	let bulkCategory = $state('');
	let grouped = $state(false);

	// Label for the bulk-category trigger (the Bits Select shows text, not a native
	// <option>). Falls back to the placeholder when nothing is chosen.
	const bulkCategoryLabel = $derived(
		data.categoryGroups.flatMap((g) => g.categories).find((c) => c.id === bulkCategory)?.name ??
			'Choose category…'
	);

	function toggle(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}
	// Select all selects every row, the pages not yet scrolled to loaded first.
	async function toggleAll() {
		if (selected.size > 0 && selected.size >= total) {
			selected = new Set();
			return;
		}
		await list.all();
		selected = new Set(list.rows.map((r) => r.id));
	}

	// Presentation-only grouping (mirrors the register's date-group transform) —
	// a pure display fold of the already-fetched rows, no new data/server call.
	type Row = PageData['rows'][number];
	function groupByPayee(rows: Row[]): { payee: string; rows: Row[] }[] {
		const by = new Map<string, Row[]>();
		for (const r of rows) {
			const key = r.payeeName ?? '';
			const list = by.get(key);
			if (list) list.push(r);
			else by.set(key, [r]);
		}
		// Rows with no payee go last, under "No payee" (C1: a lone dash read as a missing name).
		return [...by.entries()]
			.sort((a, b) => (a[0] === '' ? 1 : 0) - (b[0] === '' ? 1 : 0) || a[0].localeCompare(b[0]))
			.map(([payee, rs]) => ({ payee: payee || 'No payee', rows: rs }));
	}
	// Newest first by date (the Date column reads in order); grouping by payee sorts by payee.
	const rows = $derived([...listRows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)));
	const payeeGroups = $derived(groupByPayee(rows));
	// Grouping by payee reads every row: the rest load first.
	$effect(() => {
		if (grouped && list.next !== null) untrack(() => void list.all());
	});

	// Only the rows in view are drawn (every row drew a checkbox, a button and a picker's
	// trigger, 16 MB of HTML at 3,300 rows); payee headings are items in the list too.
	type Item = { kind: 'group'; key: string; label: string } | { kind: 'row'; key: string; r: Row };
	const items = $derived.by((): Item[] =>
		grouped
			? payeeGroups.flatMap((g): Item[] => [
					{ kind: 'group', key: `g-${g.payee}`, label: `${g.payee} (${g.rows.length})` },
					...g.rows.map((r): Item => ({ kind: 'row', key: r.id, r }))
				])
			: rows.map((r): Item => ({ kind: 'row', key: r.id, r }))
	);
	const win = new RowWindow<Item>(() => items);
	$effect(() => win.attach());
	$effect(() => {
		void items.length;
		untrack(() => void tick().then(() => win.update()));
	});
	// The next page when the drawn window nears the end of the rows here.
	$effect(() => {
		if (list.next !== null && win.start + win.size >= items.length - 40) untrack(() => void list.more());
	});

	// How many rows have a remembered-category suggestion (F3), all of them, not only those here.
	const suggestionCount = $derived(Math.max(0, data.suggested - goneNow.suggested));

	// Keyboard nav on the FOCUSED row — ↑/↓ move, Space selects, Enter
	// applies the row's suggestion (if any). Native row focus (no scroll hijack).
	function rowKeydown(e: KeyboardEvent, r: Row) {
		// Only keys on the focused row itself: the row's checkbox and category picker own theirs.
		if (e.target !== e.currentTarget) return;
		const row = e.currentTarget as HTMLElement;
		const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-inboxrow]'));
		switch (e.key) {
			case 'ArrowDown': {
				e.preventDefault();
				const l = rows();
				l[l.indexOf(row) + 1]?.focus();
				break;
			}
			case 'ArrowUp': {
				e.preventDefault();
				const l = rows();
				l[l.indexOf(row) - 1]?.focus();
				break;
			}
			case ' ':
				e.preventDefault();
				toggle(r.id);
				break;
			case 'Enter':
				if (r.suggestedCategoryId) {
					e.preventDefault();
					const l = rows();
					const next = l[l.indexOf(row) + 1];
					row.querySelector<HTMLButtonElement>('[data-apply-suggestion]')?.click();
					next?.focus();
				}
				break;
		}
	}

	// Per-row categorize forms, keyed by row id — the Bits Select's onValueChange
	// submits the row's own form (a themed DOM popup replaces the native <select>
	// whose OS-drawn optgroups fail contrast; VP-SEED-01 /).
	// The value goes through our own hidden input: Bits updates its hidden input
	// after onValueChange, so submitting from the callback sent an empty id.
	let rowForms = $state<Record<string, HTMLFormElement>>({});
	let rowCats = $state<Record<string, string>>({});
	async function categorizeRow(id: string, categoryId: string) {
		if (!categoryId) return;
		rowCats[id] = categoryId;
		// The categorized row leaves the list; keep the keyboard on the row that takes its
		// place instead of dropping focus to <body> (hunt H-inbox-A).
		const list = Array.from(document.querySelectorAll<HTMLElement>('[data-inboxrow]'));
		const at = list.findIndex((el) => el.dataset.inboxrow === id);
		await tick();
		rowForms[id]?.requestSubmit();
		if (at < 0) return;
		const until = Date.now() + 3000;
		const settle = () => {
			if (document.querySelector(`[data-inboxrow="${id}"]`) && Date.now() < until) return requestAnimationFrame(settle);
			const a = document.activeElement;
			if (a && a !== document.body && a.id !== 'app-content' && a.isConnected) return;
			const now = Array.from(document.querySelectorAll<HTMLElement>('[data-inboxrow]'));
			now[Math.min(at, now.length - 1)]?.focus();
		};
		requestAnimationFrame(settle);
	}
</script>

<PageHeader title="To categorize">
	<!-- Empty, the table says it once ("Every transaction has a category"). -->
	{#snippet meta()}
		{total === 0 ? '' : `${m.count(total)} ${total === 1 ? 'transaction' : 'transactions'}`}
	{/snippet}
</PageHeader>

{#if total > 0}
	<!-- One toolbar row: the page's commands, or the bulk commands while rows are selected. -->
	<div class="mb-2 flex min-h-8 flex-wrap items-center gap-control">
		{#if selected.size > 0}
			<form method="POST" action="?/categorize" use:enhance={() => async (o) => { await afterCategorize(o); selected = new Set(); bulkCategory = ''; }} class="flex flex-wrap items-center gap-control">
				<span class="text-body">{selected.size} selected</span>
				<Select.Root type="single" name="categoryId" bind:value={bulkCategory}>
					<Select.Trigger aria-label="Category for the selected transactions" class="min-w-48">
						{bulkCategoryLabel}
					</Select.Trigger>
					<Select.Content>
						{#each data.categoryGroups as g (g.id)}
							<Select.Group>
								<Select.GroupHeading>{g.name}</Select.GroupHeading>
								{#each g.categories as c (g.id + c.id)}
									<Select.Item value={c.id} label={c.name} />
								{/each}
							</Select.Group>
						{/each}
					</Select.Content>
				</Select.Root>
				{#each [...selected] as id (id)}<input type="hidden" name="ids" value={id} />{/each}
				<Button type="submit" variant="outline" disabled={bulkCategory === ''}>
					Categorize {selected.size} selected
				</Button>
				<Button type="button" variant="ghost" onclick={() => (selected = new Set())}>Clear selection</Button>
			</form>
		{:else}
			{#if suggestionCount > 0}
				<form method="POST" action="?/applySuggestions" use:enhance class="inline">
					<Button type="submit" variant="outline"
						><Lightbulb size={16} aria-hidden="true" /> Apply all suggestions ({m.count(suggestionCount)})</Button
					>
				</form>
			{/if}
			<ToggleSwitch label="Group by payee" checked={grouped} onCheckedChange={(v) => (grouped = v)} />
		{/if}
	</div>
{/if}

{#if form && 'categorized' in form && form.categorized}
	<!-- Undo: a categorized row leaves the list at once, so a slip needs a way
	     back here (Gmail's archive). Ctrl+Z works too (data-undo). -->
	<StatusBar trigger={form} autoDismiss={false} class="mb-2">
		Categorized {m.count(form.affected)} {form.affected === 1 ? 'transaction' : 'transactions'}.
		{#snippet action()}
			<form method="POST" action="?/uncategorize" use:enhance>
				{#each form.ids as id (id)}<input type="hidden" name="ids" value={id} />{/each}
				<Button type="submit" data-undo variant="ghost" size="xs" class="text-brand-ink">Undo</Button>
			</form>
		{/snippet}
	</StatusBar>
{/if}
{#if form && 'restored' in form && form.restored}
	<StatusBar trigger={form} class="mb-2">
		Back in To categorize: {m.count(form.restoredCount)} {form.restoredCount === 1 ? 'transaction' : 'transactions'}.
	</StatusBar>
{/if}

<TableFrame isEmpty={total === 0 && listRows.length === 0} emptyRule={false}>
	{#snippet empty()}<EmptyState icon="inbox" title="All caught up" text="Every transaction has a category." />{/snippet}
	<!-- Fixed columns, so the drawn window never changes their widths as it moves. -->
	<table class="data-table no-hover min-w-180 table-fixed">
		<thead>
			<tr>
				<th class="check">
					<Checkbox
						checked={selected.size > 0 && selected.size >= total}
						indeterminate={selected.size > 0 && selected.size < total}
						onCheckedChange={toggleAll}
						aria-label="Select all"
					/>
				</th>
				<th class="w-24">Date</th>
				<th>Payee</th>
				<!-- Payee takes what's left (fixed layout): at 1180 px wide it had 46 px, "Bl…".
				     Account and Category narrowed so Payee keeps about 140 px there. -->
				<th class="w-32">Account</th>
				<th class="num w-32">Amount</th>
				<th class="w-80">Category</th>
			</tr>
		</thead>
		<tbody bind:this={win.body}>
			{#if win.padTop > 0}<tr aria-hidden="true"><td colspan="6" style="height:{win.padTop}px;padding:0;border:0"></td></tr>{/if}
			{#each win.visible as it (it.key)}
				{#if it.kind === 'group'}
					<tr class="group-row"><td colspan="6">{it.label}</td></tr>
				{:else}
					{@render inboxRow(it.r)}
				{/if}
			{/each}
			{#if win.padBottom > 0}<tr aria-hidden="true"><td colspan="6" style="height:{win.padBottom}px;padding:0;border:0"></td></tr>{/if}
		</tbody>
	</table>
</TableFrame>

{#snippet inboxRow(r: Row)}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<tr
		data-inboxrow={r.id}
		data-winrow
		tabindex="0"
		onkeydown={(e) => rowKeydown(e, r)}
		data-selected={selected.has(r.id) ? '' : undefined}
	>
		<td class="check">
			<Checkbox
				checked={selected.has(r.id)}
				onCheckedChange={() => toggle(r.id)}
				aria-label={`Select ${r.payeeName ?? 'transaction'}, ${formatDateShort(r.date)}`}
			/>
		</td>
		<td class="date text-text-muted">{formatDateShort(r.date)}</td>
		<td class="truncate" title={r.notes ? `${r.payeeName ?? 'No payee'}, ${r.notes}` : undefined}>
			{r.payeeName ?? 'No payee'}
			{#if r.notes}<span class="ml-2 text-caption text-text-muted">{r.notes}</span>{/if}
		</td>
		<td class="truncate text-text-muted">{r.accountName}</td>
		<td class="num {flowToneClass(r.amountPaise)}">{m.money(r.amountPaise)}</td>
		<td>
			<!-- One line: the category picker, and the remembered suggestion beside it (F3). -->
			<div class="flex items-center gap-2">
				<form method="POST" action="?/categorize" use:enhance={() => afterCategorize} bind:this={rowForms[r.id]} class="w-40 flex-none">
					<input type="hidden" name="ids" value={r.id} />
					<input type="hidden" name="categoryId" value={rowCats[r.id] ?? ''} />
					<Select.Root type="single" onValueChange={(v) => categorizeRow(r.id, v)}>
						<Select.Trigger aria-label={`Category for ${r.payeeName ?? 'transaction'}`} class="h-7 w-full">
							Pick category…
						</Select.Trigger>
						<Select.Content>
							{#each data.categoryGroups as g (g.id)}
								<Select.Group>
									<Select.GroupHeading>{g.name}</Select.GroupHeading>
									{#each g.categories as c (g.id + c.id)}<Select.Item value={c.id} label={c.name} />{/each}
								</Select.Group>
							{/each}
						</Select.Content>
					</Select.Root>
				</form>
				{#if r.suggestedCategoryId}
					<form method="POST" action="?/categorize" use:enhance={() => afterCategorize} class="min-w-0">
						<input type="hidden" name="ids" value={r.id} />
						<input type="hidden" name="categoryId" value={r.suggestedCategoryId} />
						<Tooltip label="Use the payee's usual category" shortcut="Enter">
							{#snippet child({ props })}
								<Button {...props} type="submit" size="xs" variant="ghost" class="max-w-full min-w-0" data-apply-suggestion
									><Lightbulb aria-hidden="true" /> <span class="truncate">Use {r.suggestedCategoryName}</span></Button
								>
							{/snippet}
						</Tooltip>
					</form>
				{/if}
			</div>
		</td>
	</tr>
{/snippet}
