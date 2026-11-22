<!--
	A section page (S1): one headline and its table on the page (S1 RD8, RD9;
	no KPI cards, no explainer). Asset holdings lead with value, invested and return; bank, card
	and loan sections with the balance and its change this month (a loan has no invested or
	return). A foreign-currency account shows its rupee value beside its own (MC3).
	"Add account" is a Standard button in the toolbar (the top bar's Add is the accent, D6).

	An investment section gets its value against money
	put in above the table, with the Dashboard's ranges (I1, placement A), and its return per year
	after the gain and as a Per year column (I2). Other sections get a Last 12 months line on each
	row (N1). An investment section gets one too (as Robinhood's and Monarch's
	holdings lists): a 96 px line and narrower figure columns keep 151 px for the name at 1232. The
	column shows once a row has a line (two month ends), so a new ledger has no empty column.
-->
<script lang="ts">
	import Figure from '$lib/components/Figure.svelte';
	import { PageHeader, Section, TableFrame } from '$lib/components/layout';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { Plus } from '@lucide/svelte';
	import { rowLink } from '$lib/row-link';
	import { openAddAccount } from '$lib/add-account';
	import { Button } from '$lib/components/ui/button';
	import type { PageData } from './$types';
	import { useMoney } from '$lib/format-context';
	import { toneClass, levelToneClass, formatShare, formatPercent } from '$lib/format';
	import { moduleProfile, sectionLabel } from '$lib/modules';
	import LinkSwitch from '$lib/components/LinkSwitch.svelte';
	import ValueInvested from '$lib/components/ValueInvested.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import { page } from '$app/state';
	import { notValuedNote, paidOutNote, updatedAgo, PASSED_ZERO_MESSAGE } from '$lib/holding-notes';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { formatDate } from '$lib/dates';

	let { data }: { data: PageData } = $props();
	const m = useMoney();
	const paidInOnly = (type: string): boolean => !!moduleProfile(type)?.paidInOnly;
	/** A cell starts its own text ("Today", C2); the account page keeps "Last updated today". */
	const sentenceCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

	function pctText(pct: number | null): string {
		return pct === null ? '' : `${pct >= 0 ? '+' : ''}${(pct * 100).toFixed(1)}%`;
	}
	const count = $derived(data.accounts.length);
	const showTrend = $derived(data.accounts.some((a) => a.trend));
	const RANGES = ['1M', '3M', '6M', 'YTD', '1Y', 'ALL'] as const;
	/** Why a holding shows "–" for its return per year (S2 RD6). */
	const NO_RATE = 'Shown after a year of tracking and a value update (or interest typed inside it)';
</script>

<PageHeader title={sectionLabel(data.profile.type)}>
	{#snippet headline()}
		<div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
			<span class="num text-display font-normal {levelToneClass(data.totalPaise)}"><Figure text={m.money(data.totalPaise, { compact: m.compact })} /></span>
			{#if m.compact}<span class="num text-body text-text-muted">{m.money(data.totalPaise)}</span>{/if}
			{#if data.holdingKpi}
				<span class="num text-body text-text-muted">Invested {m.money(data.holdingKpi.investedPaise)}</span>
				<span class="num text-body {toneClass(data.holdingKpi.returnPaise)}"
					>{m.signedMoney(data.holdingKpi.returnPaise)} {data.holdingKpi.returnPct !== null ? `(${pctText(data.holdingKpi.returnPct)})` : ''}</span
				>
			{:else if data.changeBasePaise !== 0}
				<span class="num text-body {toneClass(data.changeBasePaise)}">{m.signedMoney(data.changeBasePaise)} this month</span>
			{/if}
			{#if data.holdingKpi && data.annualReturn !== null}
				<span class="num text-body {toneClass(data.annualReturn)}">{formatPercent(data.annualReturn)} a year</span>
				{#if data.notValued > 0}<span class="text-caption text-text-muted">{notValuedNote(data.notValued)}</span>{/if}
			{/if}
			{#if data.holdingKpi && data.paidOut > 0}<span class="text-caption text-text-muted">{paidOutNote(data.paidOut)}</span>{/if}
			{#if data.rateNeeded || data.holdingKpi?.rateNeeded}
				<a href="/settings" class="text-caption font-semibold text-warn hover:underline">Rate needed</a>
			{/if}
		</div>
	{/snippet}
</PageHeader>

{#if data.chart && data.chart.points.length >= 2}
	<Section title="Value and invested" class="mb-section">
		{#snippet actions()}
			<LinkSwitch
				label="Range"
				items={RANGES.map((r) => ({ href: `${page.url.pathname}?range=${r}`, label: r === 'ALL' ? 'All' : r, current: data.chart?.timeframe === r }))}
			/>
		{/snippet}
		<ValueInvested points={data.chart.points} />
	</Section>
{/if}

{#each data.accounts.filter((a) => a.updated?.passedZero) as a (a.id)}
	<!-- Payments alone passed what was owed; the lender's figure puts it right. -->
	<StatusBar intent="warning" autoDismiss={false} dismissible={false} class="mb-3">{a.name}: {PASSED_ZERO_MESSAGE}</StatusBar>
{/each}

<div class="mb-2 flex min-h-8 items-center gap-control">
	<span class="text-caption text-text-muted">{count} {count === 1 ? 'account' : 'accounts'}</span>
	<span class="flex-1"></span>
	<Button variant="outline" onclick={() => openAddAccount(data.profile.type)}><Plus aria-hidden="true" /> Add account</Button>
</div>

<TableFrame isEmpty={count === 0}>
	{#snippet empty()}
		<EmptyState icon={data.profile.type} title={`No ${sectionLabel(data.profile.type).toLowerCase()} yet`} text="Add one and it appears here and in the sidebar.">
			{#snippet action()}<Button variant="outline" onclick={() => openAddAccount(data.profile.type)}>Add account</Button>{/snippet}
		</EmptyState>
	{/snippet}
	<table class="data-table" use:rowLink>
		<thead>
			<tr>
				<th>Account</th>
				{#if data.holdingKpi}
					{#if showTrend}<th class="w-30">Last 12 months</th>{/if}
					<th class="num w-36">Value</th>
					<th class="num w-36">Invested</th>
					<th class="num w-36">Return</th>
					<th class="num w-20">%</th>
					<th class="num w-24">Per year</th>
				{:else}
					{#if showTrend}<th class="w-36">Last 12 months</th>{/if}
					{#if data.tracksUpdates}<th class="w-40">Last updated</th>{/if}
					<th class="num w-44">This month</th>
					<th class="num w-48">Balance</th>
				{/if}
			</tr>
		</thead>
		<tbody>
			{#each data.accounts as a (a.id)}
				<tr>
					<!-- S5 RD16 (E2): an EPF's EPS sits right under it, indented. -->
					<td class="truncate"><a href={`/accounts/${a.id}`} class="hover:underline {a.parentId ? 'pl-5 text-text-muted' : ''}">{a.name}</a>{#if a.shareBp !== null}<span class="ml-2 text-text-muted">Your share {formatShare(a.shareBp)}</span>{/if}</td>
					{#if data.holdingKpi && a.metrics}
						{#if showTrend}<td>{#if a.trend}<Sparkline values={a.trend} width={96} />{/if}</td>{/if}
						<td class="num {levelToneClass(a.metrics.currentValuePaise)}">{m.money(a.metrics.currentValuePaise, { currency: a.currency })}</td>
						<td class="num text-text-muted">{m.money(a.metrics.costBasisPaise, { currency: a.currency })}</td>
						{#if paidInOnly(a.type)}
							<!-- S5 RD16: counted at what was paid in; it earns nothing, so no return to show. -->
							<td class="num text-text-muted" title="Counted at what was paid in">–</td>
							<td class="num text-text-muted">–</td>
							<td class="num text-text-muted">–</td>
						{:else if a.metrics.paidOutRate !== null}
							<!-- C1 A: interest paid out to the bank, so no measured return; its stated rate instead.
							     "Paid out" sits in Return (the 96 px Per year cell can't hold "7.1% paid out"). -->
							<td class="num text-text-muted" title="Interest paid out where it lands">Paid out</td>
							<td class="num text-text-muted">–</td>
							<td class="num" title="The rate from its details">{formatPercent(a.metrics.paidOutRate)}</td>
						{:else}
						<td class="num {toneClass(a.metrics.returnPaise)}">{m.signedMoney(a.metrics.returnPaise, { currency: a.currency })}</td>
						<td class="num {toneClass(a.metrics.returnPaise)}">{pctText(a.metrics.returnPct)}</td>
						{#if a.metrics.annualReturn !== null}
							<td class="num {toneClass(a.metrics.annualReturn)}">{formatPercent(a.metrics.annualReturn)}</td>
						{:else}
							<td class="num text-text-muted" title={NO_RATE}>–</td>
						{/if}
						{/if}
					{:else}
						{#if showTrend}<td>{#if a.trend}<Sparkline values={a.trend} />{/if}</td>{/if}
						{#if data.tracksUpdates}
							<td class={a.updated?.stale ? 'text-warn' : 'text-text-muted'} title={a.updated?.lastUpdated ? formatDate(a.updated.lastUpdated) : undefined}
								>{a.updated?.lastUpdated ? sentenceCase(updatedAgo(a.updated.lastUpdated, data.todayIso)) : ''}</td
							>
						{/if}
						<td class="num {a.changePaise ? toneClass(a.changePaise) : 'text-text-muted'}"
							>{a.changePaise ? m.signedMoney(a.changePaise, { currency: a.currency }) : 'No change'}</td
						>
						<td class="num {levelToneClass(a.balancePaise)}">
							{#if a.basePaise !== null}<span class="mr-2 text-body text-text-muted">{m.baseApprox(a.basePaise)}</span>{/if}
							{m.money(a.balancePaise, { currency: a.currency })}
						</td>
					{/if}
				</tr>
			{/each}
		</tbody>
	</table>
</TableFrame>
