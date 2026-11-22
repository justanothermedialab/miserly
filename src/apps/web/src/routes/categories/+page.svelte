<!--
	Categories & groups (F2). Every GROUP carries a system KIND ∈ {Income ·
	Spending · Neutral} that charts read; categories inherit it. CRUD:
	add/rename groups & categories, change a group's kind, hide/unhide,
	delete-with-reassign.
	Layout (AUDIT-S4 F12, F13): one table on the page, each group a text header row
	(name, kind, a ⋯ menu) over its categories as plain rows (the name; a row opens the edit
	dialog). New category and New group are toolbar buttons opening small dialogs, not open fields
	under every group. No colour to pick: Reports colours categories by rank (F2 RD6 amended).
-->
<script lang="ts">
	import { PageHeader } from '$lib/components/layout';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { Ellipsis, Eye, EyeOff, Pencil, Plus, Trash2 } from '@lucide/svelte';
	import { TableFrame } from '$lib/components/layout';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { enhance } from '$app/forms';
	import { tick } from 'svelte';
	import type { ActionData, PageData } from './$types';
	import * as Select from '$lib/components/ui/select';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { TEXT_LIMITS } from '$lib/text-limits';
	import { Badge, type BadgeVariant } from '$lib/components/ui/badge';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import ToggleSwitch from '$lib/components/ToggleSwitch.svelte';
	import { Switch } from '$lib/components/ui/switch';
	import { goto } from '$app/navigation';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { keepValues } from '$lib/forms';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const KINDS = ['income', 'spending', 'investments', 'neutral'] as const;
	type Kind = (typeof KINDS)[number];

	function capitalize(s: string): string {
		return s.charAt(0).toUpperCase() + s.slice(1);
	}
	// A group's kind in plain words (ACTUAL-PARITY #22): "neutral" means left out of the reports.
	// "Investments" (C2 A) is out of income and spending too, and is what Reports' Net invested counts.
	const kindLabel = (k: string): string => (k === 'neutral' ? 'Not in reports' : k === 'investments' ? 'Invested' : capitalize(k));
	// Tinted badges, not white-on-colour (A11Y-03).
	const kindBadge: Record<Kind, BadgeVariant> = {
		income: 'positive',
		spending: 'destructive',
		neutral: 'secondary',
		investments: 'secondary'
	};

	type Group = PageData['tree'][number];
	type Category = Group['categories'][number];

	// Dialog targets are ids, re-derived from fresh data after every action.
	let editingId = $state<string | null>(null);
	let deletingCategoryId = $state<string | null>(null);
	let reassignTo = $state('');
	const deletingCategory = $derived(
		deletingCategoryId ? (data.tree.flatMap((g) => g.categories).find((c) => c.id === deletingCategoryId) ?? null) : null
	);
	let renamingGroupId = $state<string | null>(null);
	const editing = $derived.by((): { group: Group; category: Category } | null => {
		for (const group of data.tree) {
			const category = group.categories.find((c) => c.id === editingId);
			if (category) return { group, category };
		}
		return null;
	});
	const renamingGroup = $derived(data.tree.find((g) => g.id === renamingGroupId) ?? null);
	let deletingGroupId = $state<string | null>(null);
	const deletingGroup = $derived(data.tree.find((g) => g.id === deletingGroupId) ?? null);
	let newGroupKind = $state<Kind>('spending');
	let newGroupOpen = $state(false);
	let newCategoryOpen = $state(false);
	let newCategoryGroup = $state('');
	const visibleGroups = $derived(data.tree.filter((g) => !g.hidden));
	const categoryCount = $derived(data.tree.reduce((n, g) => n + g.categories.length, 0));
	function openNewCategory(groupId?: string) {
		newCategoryGroup = groupId ?? visibleGroups.find((g) => g.kind === 'spending')?.id ?? visibleGroups[0]?.id ?? '';
		newCategoryOpen = true;
	}

	// Menu actions that are a single POST go through one hidden form.
	let postForm = $state<HTMLFormElement | null>(null);
	let post = $state<{ action: string; fields: Record<string, string> }>({ action: '', fields: {} });
	async function submit(action: string, fields: Record<string, string>) {
		post = { action, fields };
		await tick();
		postForm?.requestSubmit();
	}

	const labelCls = 'text-caption font-normal text-text-muted';
	const errCls = 'text-caption text-neg';
</script>

<PageHeader title="Categories">
	{#snippet meta()}{categoryCount} {categoryCount === 1 ? 'category' : 'categories'} in {data.tree.length} {data.tree.length === 1 ? 'group' : 'groups'}{/snippet}
</PageHeader>

<div class="mb-2 flex min-h-8 flex-wrap items-center gap-control">
	<ToggleSwitch label="Show hidden" checked={data.includeHidden} onCheckedChange={(v) => goto(v ? '/categories?hidden=1' : '/categories', { keepFocus: true, noScroll: true })} />
	<span class="flex-1"></span>
	<Button variant="outline" onclick={() => openNewCategory()} disabled={visibleGroups.length === 0}><Plus aria-hidden="true" /> New category</Button>
	<Button variant="outline" onclick={() => (newGroupOpen = true)}><Plus aria-hidden="true" /> New group</Button>
</div>

{#if form?.message && !editing}<StatusBar intent="error" trigger={form} class="mb-2">{form.message}</StatusBar>{/if}
{#if form?.errors?.name}<StatusBar intent="error" trigger={form} class="mb-2">{form.errors.name}</StatusBar>{/if}
{#if form?.errors?.colour}<StatusBar intent="error" trigger={form} class="mb-2">{form.errors.colour}</StatusBar>{/if}

<form bind:this={postForm} method="POST" action={post.action} use:enhance hidden>
	{#each Object.entries(post.fields) as [k, v] (k)}<input type="hidden" name={k} value={v} />{/each}
</form>

<TableFrame isEmpty={data.tree.length === 0}>
	{#snippet empty()}<EmptyState icon="categories" title="No categories yet" text="Start with New group." />{/snippet}
	<table class="data-table">
		<thead><tr><th>Category</th><th class="w-20"><span class="sr-only">Actions</span></th></tr></thead>
		<tbody>
			{#each data.tree as group (group.id)}
				<tr class="group-row {group.hidden ? 'opacity-70' : ''}">
					<td>
						<span class="inline-flex items-center gap-2">
							{group.name}
							{#if group.kind !== group.name.toLowerCase()}<span class="font-normal">{kindLabel(group.kind)}</span>{/if}
							{#if group.hidden}<Badge variant="secondary">Hidden</Badge>{/if}
						</span>
					</td>
					<td class="text-right whitespace-nowrap">
						<!-- One click to add a category to this group (ACTUAL-PARITY #17; was the menu's first item). -->
						<Tooltip label={`New category in ${group.name}`}>
							{#snippet child({ props })}
								<button {...props} type="button" onclick={() => openNewCategory(group.id)} aria-label={`New category in ${group.name}`}
									class="inline-grid size-7 place-items-center rounded-control text-text-muted hover:bg-control-hover hover:text-text"><Plus size={16} aria-hidden="true" /></button>
							{/snippet}
						</Tooltip>
						<DropdownMenu.Root>
							<Tooltip label="More actions">
								{#snippet child({ props })}
									<DropdownMenu.Trigger
										{...props}
										class="inline-grid size-7 place-items-center rounded-control text-text-muted hover:bg-control-hover hover:text-text data-[state=open]:bg-control-hover"
										aria-label={`Actions for ${group.name}`}
									>
										<Ellipsis size={16} aria-hidden="true" />
									</DropdownMenu.Trigger>
								{/snippet}
							</Tooltip>
							<DropdownMenu.Content align="end" sideOffset={4}>
								<DropdownMenu.Item onSelect={() => openNewCategory(group.id)}><Plus aria-hidden="true" />New category in {group.name}…</DropdownMenu.Item>
								<DropdownMenu.Item onSelect={() => (renamingGroupId = group.id)}><Pencil aria-hidden="true" />Rename…</DropdownMenu.Item>
								<DropdownMenu.Separator />
								<DropdownMenu.Label inset>Kind</DropdownMenu.Label>
								{#each KINDS as kind (kind)}
									<DropdownMenu.Item
										inset
										disabled={group.kind === kind}
										onSelect={() => submit('?/setGroupKind', { id: group.id, kind })}
									>
										{group.kind === kind ? `${kindLabel(kind)} (current)` : kind === 'neutral' ? 'Leave out of reports' : kind === 'investments' ? 'Count as invested' : `Make ${kind}`}
									</DropdownMenu.Item>
								{/each}
								<DropdownMenu.Separator />
								<DropdownMenu.Item
									onSelect={() => submit(group.hidden ? '?/unhideGroup' : '?/hideGroup', { id: group.id })}
								>
									{#if group.hidden}<Eye aria-hidden="true" />Unhide{:else}<EyeOff aria-hidden="true" />Hide{/if}
								</DropdownMenu.Item>
								<DropdownMenu.Item class="text-neg" onSelect={() => (deletingGroupId = group.id)}><Trash2 aria-hidden="true" />Delete…</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					</td>
				</tr>
				{#each group.categories as category (category.id)}
					<!-- The whole row opens the editor (item 2.5: only the name's text did, the rest of an
					     856 px row did nothing); the button keeps it reachable by Tab. -->
					<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
					<tr class="cursor-pointer hover:bg-control-hover {category.hidden ? 'text-text-muted' : ''}" onclick={(e) => { if (!(e.target as Element).closest('button')) editingId = category.id; }}>
						<td>
							<button
								type="button"
								onclick={() => (editingId = category.id)}
								class="inline-flex items-center gap-2 text-left hover:underline"
								aria-label={`Edit ${category.name}`}
							>
								{category.name}
								{#if category.hidden}<span class="text-caption">(hidden)</span>{/if}
							</button>
						</td>
						<td></td>
					</tr>
				{/each}
			{/each}
		</tbody>
	</table>
</TableFrame>

<!-- New category (a toolbar button or a group's menu) -->
<Dialog.Root bind:open={newCategoryOpen}>
	<Dialog.Content>
		<Dialog.Header><Dialog.Title>New category</Dialog.Title></Dialog.Header>
		<form
			method="POST"
			action="?/createCategory"
			use:enhance={keepValues({ onSuccess: () => (newCategoryOpen = false) })}
			class="flex flex-col gap-3"
		>
			<div class="flex flex-col gap-1">
				<label for="new-cat-name" class={labelCls}>Name</label>
				<Input id="new-cat-name" name="name" maxlength={TEXT_LIMITS.name} placeholder="e.g. Fuel" required />
			</div>
			<div class="flex flex-col gap-1">
				<label for="new-cat-group" class={labelCls}>Group</label>
				<Select.Root type="single" name="groupId" bind:value={newCategoryGroup}>
					<Select.Trigger id="new-cat-group" class="w-full">{visibleGroups.find((g) => g.id === newCategoryGroup)?.name ?? 'Choose a group'}</Select.Trigger>
					<Select.Content>
						{#each visibleGroups as g (g.id)}<Select.Item value={g.id} label={g.name} />{/each}
					</Select.Content>
				</Select.Root>
			</div>
			<Dialog.Footer>
				<Button type="submit">Add category</Button>
				<Button variant="outline" onclick={() => (newCategoryOpen = false)}>Cancel</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- New group -->
<Dialog.Root bind:open={newGroupOpen}>
	<Dialog.Content>
		<Dialog.Header><Dialog.Title>New group</Dialog.Title></Dialog.Header>
		<form
			method="POST"
			action="?/createGroup"
			use:enhance={keepValues({ onSuccess: () => (newGroupOpen = false) })}
			class="flex flex-col gap-3"
		>
			<div class="flex flex-col gap-1">
				<label for="new-group-name" class={labelCls}>Name</label>
				<Input id="new-group-name" name="name" maxlength={TEXT_LIMITS.name} placeholder="e.g. Travel" required />
			</div>
			<div class="flex flex-col gap-1">
				<label for="new-group-kind" class={labelCls}>Kind</label>
				<Select.Root type="single" name="kind" bind:value={newGroupKind}>
					<Select.Trigger id="new-group-kind" class="w-full">{kindLabel(newGroupKind)}</Select.Trigger>
					<Select.Content>
						{#each KINDS as kind (kind)}<Select.Item value={kind} label={kindLabel(kind)} />{/each}
					</Select.Content>
				</Select.Root>
			</div>
			<Dialog.Footer>
				<Button type="submit">Create group</Button>
				<Button variant="outline" onclick={() => (newGroupOpen = false)}>Cancel</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

{#if deletingGroup}
	<ConfirmDialog
		bind:open={() => deletingGroupId !== null, (v) => { if (!v) deletingGroupId = null; }}
		title={`Delete the group ${deletingGroup.name}?`}
		action="?/deleteGroup"
		fields={{ id: deletingGroup.id }}
		confirmLabel="Delete"
	>
		The group and any hidden categories in it are deleted permanently. A group that still has visible categories can't be deleted; move or delete them first.
	</ConfirmDialog>
{/if}

<!-- Rename group -->
<Dialog.Root open={renamingGroup !== null} onOpenChange={(o) => { if (!o) renamingGroupId = null; }}>
	{#if renamingGroup}
		<Dialog.Content>
			<Dialog.Header><Dialog.Title>Rename group</Dialog.Title></Dialog.Header>
			<form
				method="POST"
				action="?/renameGroup"
				use:enhance={keepValues({ resetOnSuccess: false, onSuccess: () => (renamingGroupId = null) })}
				class="flex flex-col gap-1"
			>
				<input type="hidden" name="id" value={renamingGroup.id} />
				<label for="rename-group" class={labelCls}>Name</label>
				<Input id="rename-group" name="name" maxlength={TEXT_LIMITS.name} value={renamingGroup.name} required />
				<Dialog.Footer>
					<Button type="submit">Save</Button>
					<Button variant="outline" onclick={() => (renamingGroupId = null)}>Cancel</Button>
				</Dialog.Footer>
			</form>
		</Dialog.Content>
	{/if}
</Dialog.Root>

<!-- Edit category: one form, one Save (name, group, hidden), as every web
     form and YNAB's and Monarch's editors are; Delete… asks where its transactions go. -->
<Dialog.Root open={editing !== null} onOpenChange={(o) => { if (!o) editingId = null; }}>
	{#if editing}
		{@const category = editing.category}
		{@const group = editing.group}
		<Dialog.Content class="sm:max-w-[30rem]">
			<Dialog.Header>
				<Dialog.Title>Edit {category.name}</Dialog.Title>
				<Dialog.Description>In {group.name}{#if data.shared}. Everyone in your group uses this category.{/if}</Dialog.Description>
			</Dialog.Header>

			<form
				id="edit-category"
				method="POST"
				action="?/editCategory"
				use:enhance={keepValues({ resetOnSuccess: false, onSuccess: () => (editingId = null) })}
				class="flex flex-col gap-3"
			>
				<input type="hidden" name="id" value={category.id} />
				<div class="flex flex-col gap-1">
					<label for="cat-name" class={labelCls}>Name</label>
					<Input id="cat-name" name="name" maxlength={TEXT_LIMITS.name} value={category.name} required />
				</div>
				<div class="flex flex-col gap-1">
					<label for="cat-move" class={labelCls}>Group</label>
					<Select.Root type="single" name="newGroupId" value={group.id}>
						<Select.Trigger id="cat-move" class="w-full">{group.name}</Select.Trigger>
						<Select.Content>
							{#each data.tree as g (g.id)}<Select.Item value={g.id} label={g.name} />{/each}
						</Select.Content>
					</Select.Root>
				</div>
				<label class="flex items-center justify-between gap-3 text-body">
					<span>Hide this category<span class="block text-caption text-text-muted">Its transactions keep it</span></span>
					<Switch name="hidden" checked={category.hidden} aria-label="Hide this category" />
				</label>
				<!-- F2 RD10 (C3 A): on a holding, money in under this category is growth, not money put in. -->
				<input type="hidden" name="countsAsReturnShown" value="1" />
				<label class="flex items-center justify-between gap-3 text-body">
					<span>Counts as return (gain or loss)<span class="block text-caption text-text-muted">On an investment, money in with this category is growth, not money you put in</span></span>
					<Switch name="countsAsReturn" checked={category.countsAsReturn} aria-label="Counts as return (gain or loss)" />
				</label>
				{#if form?.message}<span class={errCls}>{form.message}</span>{/if}
			</form>

			<Dialog.Footer class="items-center">
				<Button variant="ghost" class="mr-auto text-neg" onclick={() => { deletingCategoryId = category.id; reassignTo = ''; }}>Delete…</Button>
				<Button type="submit" form="edit-category">Save</Button>
				<Button variant="outline" onclick={() => (editingId = null)}>Cancel</Button>
			</Dialog.Footer>
		</Dialog.Content>
	{/if}
</Dialog.Root>

{#if deletingCategory}
	<ConfirmDialog
		bind:open={() => deletingCategoryId !== null, (v) => { if (!v) deletingCategoryId = null; }}
		title={`Delete the category ${deletingCategory.name}?`}
		action="?/deleteCategory"
		fields={{ id: deletingCategory.id, reassignToId: reassignTo }}
		confirmLabel="Delete"
		onDone={() => { if (!form?.message) editingId = null; }}
	>
		{#if data.shared}Everyone in your group uses this category. Its transactions, including other members', move to the
		category you pick, and the category is deleted permanently.{:else}Its transactions move to the category you pick, and the
		category is deleted permanently.{/if}
		{#snippet extra()}
			<label for="cat-reassign" class="mb-1 block {labelCls}">Move its transactions to</label>
			<Select.Root type="single" bind:value={reassignTo}>
				<Select.Trigger id="cat-reassign" class="w-full">{reassignTo === '' ? 'Uncategorized' : (data.allCategories.find((t) => t.id === reassignTo)?.name ?? 'Uncategorized')}</Select.Trigger>
				<Select.Content>
					<Select.Item value="" label="Uncategorized" />
					{#each data.allCategories as target (target.id)}
						{#if target.id !== deletingCategory.id}
							<Select.Item value={target.id} label={`${target.groupName} / ${target.name}`} />
						{/if}
					{/each}
				</Select.Content>
			</Select.Root>
		{/snippet}
	</ConfirmDialog>
{/if}
