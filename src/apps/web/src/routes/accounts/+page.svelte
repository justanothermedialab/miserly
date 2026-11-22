<!--
	All accounts: one table on the page grouped by section (the
	sidebar's order), each section a text header with its subtotal (Outlook's "Today", AUDIT-S4
	F7), a foreign account with its rupee value beside it (MC3); closed accounts behind a toolbar
	toggle. Add account is the app-wide dialog (`AddAccountBody.svelte`), which opens
	over any page and lands in the new account.
-->
<script lang="ts">
	import { PageHeader, TableFrame } from '$lib/components/layout';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { Plus } from '@lucide/svelte';
	import { rowLink } from '$lib/row-link';
	import { openAddAccount } from '$lib/add-account';
	import { formatDate } from '$lib/dates';
	import type { PageData } from './$types';
	import { useMoney } from '$lib/format-context';
	import { levelToneClass, toneClass, formatShare } from '$lib/format';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import { MODULE_PROFILES, sectionLabel } from '$lib/modules';
	import { Button } from '$lib/components/ui/button';

	let { data }: { data: PageData } = $props();
	const m = useMoney();

	// ── The list ────────────────────────────────────────────────────────────────
	let showClosed = $state(false);
	const order = new Map(MODULE_PROFILES.map((p, i) => [p.type, i]));
	const groups = $derived.by(() => {
		const by = new Map<string, (typeof data.open)[number][]>();
		for (const a of data.open) by.set(a.type, [...(by.get(a.type) ?? []), a]);
		return [...by.entries()]
			.sort(([x], [y]) => (order.get(x) ?? 99) - (order.get(y) ?? 99))
			.map(([type, accounts]) => ({
				type,
				accounts: accounts.slice().sort((x, y) => x.name.localeCompare(y.name)),
				// The subtotal in base: a foreign account counts at its base value (none without a rate).
				subtotal: accounts.reduce(
					(s, a) => s + (a.currency === data.baseCurrency ? a.balancePaise : (a.baseApproxPaise ?? 0)),
					0
				)
			}));
	});

	const count = $derived(data.open.length);
	const showTrend = $derived(data.open.some((a) => a.trend));
</script>

<PageHeader title="All accounts" />

<div class="mb-2 flex min-h-8 flex-wrap items-center gap-control">
	<span class="text-caption text-text-muted">{count} {count === 1 ? 'account' : 'accounts'}</span>
	{#if data.closed.length + data.left.length > 0}
		<Button variant="ghost" onclick={() => (showClosed = !showClosed)} aria-pressed={showClosed}>
			{showClosed ? 'Hide' : 'Show'} closed ({data.closed.length + data.left.length})
		</Button>
	{/if}
	<span class="flex-1"></span>
	<Button variant="outline" onclick={() => openAddAccount()}><Plus aria-hidden="true" /> Add account</Button>
</div>

<TableFrame isEmpty={count === 0 && data.closed.length === 0 && data.left.length === 0}>
	{#snippet empty()}
		<!-- No second Add account: the toolbar's is right above (one action per view). -->
		<EmptyState icon="accounts" title="No accounts yet" text="Add a bank account, a card or an investment with Add account, above." />
	{/snippet}
	<table class="data-table" use:rowLink>
		<thead>
			<!-- N1: Last 12 months and This month, as on the section pages. -->
			<!-- The line column shows once an account has a line (two month ends). -->
			<tr><th>Account</th>{#if showTrend}<th class="w-36">Last 12 months</th>{/if}<th class="num w-36">This month</th><th class="num w-60">Balance</th></tr>
		</thead>
		<tbody>
			{#each groups as g (g.type)}
				<tr class="group-row">
					<!-- The section page (the sidebar's row folds, so the page is reached here). -->
					<td colspan={showTrend ? 3 : 2}><a href={`/sections/${g.type}`} class="hover:underline">{sectionLabel(g.type)}</a></td>
					<!-- D8: a one-account group would repeat its account's figure: no subtotal then. -->
					<td class="num {levelToneClass(g.subtotal)}">{g.accounts.length > 1 ? m.money(g.subtotal) : ''}</td>
				</tr>
				{#each g.accounts as a (a.id)}
					<tr>
						<td class="truncate">
							<a href={`/accounts/${a.id}`} class="hover:underline">{a.name}</a>
							{#if a.currency !== data.baseCurrency}<span class="ml-2 text-caption text-text-muted">{a.currency}</span>{/if}
							{#if a.shareBp !== null}<span class="ml-2 text-text-muted">Your share {formatShare(a.shareBp)}</span>{/if}
						</td>
						{#if showTrend}<td>{#if a.trend}<Sparkline values={a.trend} />{/if}</td>{/if}
						<td class="num {a.changePaise ? toneClass(a.changePaise) : 'text-text-muted'}"
							>{a.changePaise ? m.signedMoney(a.changePaise, { currency: a.currency }) : 'No change'}</td
						>
						<td class="num {levelToneClass(a.balancePaise)}">
							{#if a.baseApproxPaise !== null}<span class="mr-2 text-body text-text-muted">{m.baseApprox(a.baseApproxPaise)}</span>{/if}
							{m.money(a.balancePaise, { currency: a.currency })}
						</td>
					</tr>
				{/each}
			{/each}
			{#if showClosed && data.closed.length > 0}
				<tr class="group-row"><td colspan={showTrend ? 4 : 3}>Closed</td></tr>
				{#each data.closed as a (a.id)}
					<tr class="text-text-muted">
						<td class="truncate" colspan={showTrend ? 3 : 2}><a href={`/accounts/${a.id}`} class="hover:underline">{a.name}</a> <span class="ml-2 text-caption">{a.label}</span></td>
						<td class="num">{m.money(a.balancePaise, { currency: a.currency })}</td>
					</tr>
				{/each}
			{/if}
			{#if showClosed && data.left.length > 0}
				<!-- C5 C (H2 RD9): read-only, for the dates the viewer held them; the balance on their last day. -->
				<tr class="group-row"><td colspan={showTrend ? 4 : 3}>No longer shared with you</td></tr>
				{#each data.left as a (a.id)}
					<tr class="text-text-muted">
						<td class="truncate" colspan={showTrend ? 3 : 2}><a href={`/accounts/${a.id}`} class="hover:underline">{a.name}</a> <span class="ml-2 text-caption">{a.label}, until {formatDate(a.heldUntil)}</span></td>
						<td class="num">{m.money(a.balancePaise, { currency: a.currency })}</td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</TableFrame>
