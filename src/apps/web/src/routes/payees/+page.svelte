<!--
	Payees (F3) — saved, searchable entities. Rename propagates across every
	transaction; merge folds duplicates into one, moving their history.
	Layout (AUDIT-S4 S12, F14): one toolbar row (search, count; the merge
	commands while payees are selected), the table on the page, names and default category as
	plain text.
	Item 2.5 (the owner's "I can't edit payees or category"): a click anywhere in the Payee cell
	renames in place (Enter or a click away saves, Esc cancels; Actual's payees), a click anywhere
	in Default category picks it in place, and only the count opens the payee's transactions (the
	whole row did, so most clicks meant for an edit went to All transactions).
	No Hide (F3 RD3 amended): Actual has none, and one shared flag hid a
	payee from every member. Delete, Merge and Rename remain.
	Only the payees in view are drawn (RowWindow): 516 payees after an import drew 1.7 MB.
-->
<script lang="ts">
	import { foldIn, foldOut } from '$lib/motion';
	import { PageHeader, Toolbar, TableFrame } from '$lib/components/layout';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { tick, untrack } from 'svelte';
	import { formatDate } from '$lib/dates';
	import type { ActionData, PageData } from './$types';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Merge, Plus } from '@lucide/svelte';
	import { Input } from '$lib/components/ui/input';
	import { TEXT_LIMITS } from '$lib/text-limits';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import PickCombobox from '$lib/components/PickCombobox.svelte';
	import { RowWindow, runAction } from '$lib/register/grid.svelte';
	import { mergeMoves } from '$lib/payee-merge';
	import { useMoney } from '$lib/format-context';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	const m = useMoney();

	let mergeTarget = $state('');
	let mergeLosers = $state<string[]>([]);
	let search = $state('');
	let editingId = $state<string | null>(null); // inline-rename target
	let renameDraft = $state('');
	// The field opens focused with the old name selected, ready to type over.
	async function startRename(id: string, name: string) {
		catEditingId = null;
		editingId = id;
		renameDraft = name;
		await tick();
		document.querySelector<HTMLInputElement>('input[aria-label="Payee name"]')?.select();
	}
	// Enter or a click away saves (once), Esc cancels.
	let renaming = false;
	async function saveRename(id: string, old: string) {
		if (editingId !== id || renaming) return;
		const name = renameDraft.trim();
		if (name === '' || name === old) {
			editingId = null;
			return;
		}
		renaming = true;
		try {
			const res = await runAction('?/rename', { id, displayName: name });
			if (res.type === 'success') editingId = null;
		} finally {
			renaming = false;
		}
	}
	function renameKeydown(e: KeyboardEvent, id: string, old: string) {
		if (e.key === 'Enter') {
			e.preventDefault();
			void saveRename(id, old);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			editingId = null;
		}
	}

	// Default category, picked in place.
	let catEditingId = $state<string | null>(null);
	let catDraft = $state('');
	let catInput = $state<HTMLInputElement | null>(null);
	async function startCategory(id: string, current: string | null) {
		editingId = null;
		catEditingId = id;
		catDraft = current ?? '';
		await tick();
		catInput?.focus();
	}
	async function saveCategory(id: string, v: string, current: string | null) {
		catEditingId = null;
		if (v === (current ?? '')) return;
		await runAction('?/setCategory', { id, categoryId: v });
	}
	const categoryOptions = $derived([
		{ value: '', label: 'None' },
		...data.categoryGroups.flatMap((g) => g.categories.map((c) => ({ value: c.id, label: c.name, group: g.name })))
	]);
	// F3 RD7: the New payee row at the top of the table. Enter saves (in either field), Esc cancels.
	let newOpen = $state(false);
	let newName = $state('');
	let newCat = $state('');
	let newInput = $state<HTMLInputElement | null>(null);
	let creating = false;
	async function openNew() {
		editingId = null;
		catEditingId = null;
		newName = '';
		newCat = '';
		newOpen = true;
		await tick();
		newInput?.focus();
	}
	async function saveNew() {
		if (creating) return;
		if (newName.trim() === '') {
			newInput?.focus();
			return;
		}
		creating = true;
		try {
			const res = await runAction('?/create', { displayName: newName.trim(), categoryId: newCat });
			if (res.type === 'success') newOpen = false;
		} finally {
			creating = false;
		}
	}
	function newKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			void saveNew();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			newOpen = false;
		}
	}
	let deletingId = $state<string | null>(null); // delete-confirm target
	let confirmMerge = $state(false);
	const deleting = $derived(data.payees.find((p) => p.id === deletingId) ?? null);

	function lastUsedLabel(iso: string | null): string {
		return iso ? formatDate(iso) : '–';
	}

	function toggleLoser(id: string, checked: boolean) {
		mergeLosers = checked ? [...mergeLosers, id] : mergeLosers.filter((x) => x !== id);
	}

	// The payees that move: the selection without the target (the title said 2 when 1 moved). Merge
	// is offered only when one would (it asked "Merge 0 payees into X?").
	const moving = $derived(mergeMoves(mergeLosers, mergeTarget));
	const mergeCount = $derived(moving.length);
	let targetName = $derived(data.payees.find((p) => p.id === mergeTarget)?.displayName ?? '');

	const visiblePayees = $derived(
		search.trim() === ''
			? data.payees
			: data.payees.filter((p) => p.displayName.toLowerCase().includes(search.trim().toLowerCase()))
	);
	// Only the rows in view are drawn, as in the registers.
	const items = $derived(visiblePayees.map((payee) => ({ key: payee.id, payee })));
	const win = new RowWindow<{ key: string; payee: (typeof data.payees)[number] }>(() => items);
	$effect(() => win.attach());
	$effect(() => {
		void items.length;
		untrack(() => void tick().then(() => win.update()));
	});
</script>

<PageHeader title="Payees" />

{#if form?.message}<StatusBar intent="error" trigger={form} class="mb-3">{form.message}</StatusBar>{/if}
{#if form?.errors?.displayName}<StatusBar intent="error" trigger={form} class="mb-3">{form.errors.displayName}</StatusBar>{/if}

<!-- One toolbar row (AUDIT-S4 S12): search and the count; while payees are selected,
     the merge commands take its place (as the Inbox's bulk commands do). -->
<Toolbar>
	{#if mergeLosers.length > 0}
		<span class="text-body">{mergeLosers.length} selected</span>
		<span class="text-body text-text-muted">Merge into</span>
		<Select.Root type="single" bind:value={mergeTarget}>
			<Select.Trigger aria-label="Merge into" class="w-50">
				{mergeTarget === '' ? 'Choose a payee…' : targetName}
			</Select.Trigger>
			<Select.Content>
				{#each data.payees as payee (payee.id)}<Select.Item value={payee.id} label={payee.displayName} />{/each}
			</Select.Content>
		</Select.Root>
		<Button variant="outline" disabled={mergeCount === 0} onclick={() => (confirmMerge = true)}><Merge aria-hidden="true" /> Merge</Button>
		<Button variant="ghost" onclick={() => { mergeLosers = []; mergeTarget = ''; }}>Clear selection</Button>
	{:else}
		<label for="payee-search" class="sr-only">Search payees</label>
		<Input id="payee-search" type="search" data-page-search placeholder="Search payees…" bind:value={search} class="w-65" disabled={data.payees.length === 0} />
		<span class="text-caption text-text-muted">
			{search.trim() === '' ? `${data.payees.length} ${data.payees.length === 1 ? 'payee' : 'payees'}` : `${visiblePayees.length} of ${data.payees.length} payees`}
		</span>
		<span class="flex-1"></span>
		<Button variant="outline" onclick={openNew} disabled={newOpen}><Plus aria-hidden="true" /> New payee</Button>
	{/if}
</Toolbar>

<ConfirmDialog
	bind:open={confirmMerge}
	title={`Merge ${mergeCount} ${mergeCount === 1 ? 'payee' : 'payees'} into ${targetName}?`}
	action="?/merge"
	fields={{ targetId: mergeTarget, loserIds: moving }}
	confirmLabel="Merge"
	onDone={() => { if (!form?.message) { mergeLosers = []; mergeTarget = ''; } }}
>
	Their transactions will move to {targetName} and the merged payees will be deleted permanently. This can't be undone.
</ConfirmDialog>
{#if deleting}
	<ConfirmDialog
		bind:open={() => deletingId !== null, (v) => { if (!v) deletingId = null; }}
		title={`Delete the payee ${deleting.displayName}?`}
		action="?/delete"
		fields={{ id: deleting.id }}
		confirmLabel="Delete"
	>
		The payee is deleted permanently. Its {m.count(deleting.txnCount)} {deleting.txnCount === 1 ? 'transaction stays' : 'transactions stay'}, with no payee.
	</ConfirmDialog>
{/if}

<TableFrame isEmpty={data.payees.length === 0 && !newOpen}>
	{#snippet empty()}<EmptyState icon="payees" title="No payees yet" text="Payees are added when you enter a transaction, or with New payee." />{/snippet}
			<!-- Fixed columns, so the drawn window never changes their widths as it moves. -->
			<table class="data-table min-w-160 table-fixed">
				<thead>
					<tr>
						<th class="check"><span class="sr-only">Select</span></th>
						<th>Payee</th>
						<th class="num w-28">Transactions</th>
						<th class="w-45">Default category</th>
						<th class="w-30">Last used</th>
						<th class="w-24"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#if newOpen}
						<!-- The row folds open and shut: each cell's content folds, the cells
						     carry no padding of their own (.fold-row), so the rows below glide. -->
						<tr class="fold-row bg-surface-2">
							<td class="check"></td>
							<td>
								<div class="fold-cell" in:foldIn out:foldOut>
									<input bind:this={newInput} bind:value={newName} maxlength={TEXT_LIMITS.payee} aria-label="New payee name" placeholder="Payee name" onkeydown={newKeydown}
										class="h-7 w-full rounded-control border border-input border-b-brand-mark bg-surface px-2 text-body text-foreground outline-none shadow-[inset_0_-1px_0_var(--accent)]" />
								</div>
							</td>
							<td class="num text-text-muted"><div class="fold-cell" in:foldIn out:foldOut>0</div></td>
							<td>
								<div class="fold-cell" in:foldIn out:foldOut>
									<PickCombobox bind:value={newCat} options={categoryOptions} aria-label="Default category for the new payee" placeholder="None" inputClass="h-7" openOnFocus={false}
										onpick={(_v, how) => { if (how === 'Enter') void saveNew(); }}
										onkeydown={newKeydown} />
								</div>
							</td>
							<td class="date text-text-muted"><div class="fold-cell" in:foldIn out:foldOut>–</div></td>
							<td class="!px-2">
								<div class="fold-cell justify-end gap-1 [&>*]:flex-none" in:foldIn out:foldOut>
									<Button type="button" size="xs" variant="outline" onclick={saveNew}>Save</Button>
									<Button type="button" size="xs" variant="ghost" onclick={() => (newOpen = false)}>Cancel</Button>
								</div>
							</td>
						</tr>
					{/if}
				</tbody>
				<tbody bind:this={win.body}>
					{#if win.padTop > 0}<tr aria-hidden="true"><td colspan="6" style="height:{win.padTop}px;padding:0;border:0"></td></tr>{/if}
					{#each win.visible as { payee } (payee.id)}
						<tr data-winrow data-selected={mergeLosers.includes(payee.id) ? '' : undefined}>
							<td class="check">
								<Checkbox
									disabled={payee.id === mergeTarget}
									checked={mergeLosers.includes(payee.id)}
									onCheckedChange={(v) => toggleLoser(payee.id, v === true)}
									aria-label={`Select ${payee.displayName}`}
								/>
							</td>
								<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
								<td class="truncate" onclick={(e) => { if (e.target === e.currentTarget && editingId !== payee.id) void startRename(payee.id, payee.displayName); }}>
									{#if editingId === payee.id}
										<input bind:value={renameDraft} maxlength={TEXT_LIMITS.payee} aria-label="Payee name"
											onkeydown={(e) => renameKeydown(e, payee.id, payee.displayName)}
											onblur={() => saveRename(payee.id, payee.displayName)}
											class="h-7 w-full rounded-control border border-input border-b-brand-mark bg-surface px-2 text-body text-foreground outline-none shadow-[inset_0_-1px_0_var(--accent)]" />
									{:else}
										<!-- A click anywhere in the cell renames it, as Actual's payees (ACTUAL-PARITY #18);
										     only the count opens its transactions. -->
										<button type="button" onclick={() => startRename(payee.id, payee.displayName)} class="-mx-1 max-w-full cursor-text truncate rounded-control px-1 text-left hover:bg-surface-2 hover:ring-1 hover:ring-border-strong" aria-label={`Rename ${payee.displayName}`}>{payee.displayName}</button>
									{/if}
								</td>
								<td class="num text-text-muted"><a href={`/transactions?q=${encodeURIComponent(payee.displayName)}`} class="hover:text-brand-ink hover:underline" aria-label={`${m.count(payee.txnCount)} ${payee.txnCount === 1 ? 'transaction' : 'transactions'} with ${payee.displayName}`}>{m.count(payee.txnCount)}</a></td>
								<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
								<td class="truncate" onclick={(e) => { if (e.target === e.currentTarget && catEditingId !== payee.id) void startCategory(payee.id, payee.rememberedCategoryId); }}>
									{#if catEditingId === payee.id}
										<PickCombobox bind:inputRef={catInput} bind:value={catDraft} options={categoryOptions} aria-label={`Default category for ${payee.displayName}`} inputClass="h-7"
											onpick={(v) => saveCategory(payee.id, v, payee.rememberedCategoryId)}
											onkeydown={(e) => { if (e.key === 'Escape') catEditingId = null; }}
											onblur={() => { if (catEditingId === payee.id) void saveCategory(payee.id, catDraft, payee.rememberedCategoryId); }} />
									{:else}
										<button type="button" onclick={() => startCategory(payee.id, payee.rememberedCategoryId)} class="-mx-1 max-w-full cursor-text truncate rounded-control px-1 text-left hover:bg-surface-2 hover:ring-1 hover:ring-border-strong {payee.rememberedCategoryName ? '' : 'text-text-muted'}" aria-label={`Default category for ${payee.displayName}`}>{payee.rememberedCategoryName ?? '–'}</button>
									{/if}
								</td>
							<td class="date text-text-muted">{lastUsedLabel(payee.lastUsedAt)}</td>
							<td class="!px-2">
								<div class="row-actions flex items-center justify-end gap-1">
									<Button type="button" size="xs" variant="destructive" onclick={() => (deletingId = payee.id)} aria-label={`Delete ${payee.displayName}`}>Delete</Button>
								</div>
							</td>
						</tr>
					{/each}
					{#if win.padBottom > 0}<tr aria-hidden="true"><td colspan="6" style="height:{win.padBottom}px;padding:0;border:0"></td></tr>{/if}
				</tbody>
			</table>
</TableFrame>
