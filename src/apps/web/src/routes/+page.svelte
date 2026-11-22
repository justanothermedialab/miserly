<!--
	The dashboard, recomposed to the approved mock
	with AUDIT-S4's spacing fixes: one headline (net worth, D1 RD5), Assets and Liabilities over a
	split bar with the liquid share as a caption under Assets (D1 RD8), the full-width net worth
	chart (D3), then recent activity (D4) beside spending this month against last month (Q10
	chart 5) and allocation (D2). No KPI tiles and no account list (D4 RD9: the sidebar is the
	account list).

	Joint accounts count at the viewer's share (D1 RD12): the Mine / Shared switch is gone;
	under the headline, "Shared with others: ₹X (your share ₹Y)" opens the joint accounts' breakdown.
-->
<script lang="ts">
	import { foldIn, foldOut } from '$lib/motion';
	import Figure from '$lib/components/Figure.svelte';
	import { PageHeader, Section } from '$lib/components/layout';
	import { formatDate, formatDateShort, monthName } from '$lib/dates';
	import type { PageData } from './$types';
	import { formatPercent, formatShare, toneClass, spendToneClass, levelToneClass, flowToneClass } from '$lib/format';
	import { useMoney } from '$lib/format-context';
	import { sectionLabel, moduleColour } from '$lib/modules';
	import AllocationDonut from '$lib/components/AllocationDonut.svelte';
	import NetWorthLine from '$lib/components/NetWorthLine.svelte';
	import SpendingPace from '$lib/components/SpendingPace.svelte';
	import Segmented from '$lib/components/Segmented.svelte';
	import LinkSwitch from '$lib/components/LinkSwitch.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { ArrowLeftRight, ChevronDown, ExternalLink, Plus } from '@lucide/svelte';
	import ImportCard from '$lib/components/ImportCard.svelte';
	import { linkTo } from '$lib/links';
	import { rowLink } from '$lib/row-link';
	import { openAddAccount } from '$lib/add-account';

	let { data }: { data: PageData } = $props();
	const m = useMoney();

	let allocBy = $state<'class' | 'liquidity'>('class');
	let sharedOpen = $state(false);

	const figures = $derived(data.summary);
	const mtd = $derived(data.mtd);
	const history = $derived(data.history);
	const activity = $derived(data.activity);
	const shared = $derived(data.summary.sharedLine);
	const slices = $derived(allocBy === 'class' ? figures.byClass : figures.byLiquidity);
	const range = $derived(data.history.timeframe);
	const RANGES = ['1M', '3M', '6M', 'YTD', '1Y', 'ALL'] as const;

	const LIQUIDITY: Record<string, { label: string; colour: string }> = {
		// Plain words for every member (ACTUAL-PARITY #22, personas P2 and P3).
		Liquid: { label: 'Available now', colour: 'var(--cat-1)' },
		Semi: { label: 'Available soon', colour: 'var(--cat-6)' },
		Illiquid: { label: 'Locked in', colour: 'var(--cat-2)' }
	};
	// U3: a class is named as the sidebar and Reports name it ("Bank accounts", not "Bank account").
	const labelOf = $derived(allocBy === 'class' ? sectionLabel : (k: string) => LIQUIDITY[k]?.label ?? k);
	// D2 drill-in: a class slice opens its section page (the accounts in it). Availability cuts
	// across sections and has no page of its own, so its slices only show their figures.
	const hrefOf = $derived(allocBy === 'class' ? (k: string) => `/sections/${k}` : undefined);
	const colorOf = $derived(
		allocBy === 'class' ? moduleColour : (k: string) => LIQUIDITY[k]?.colour ?? 'var(--cat-other)'
	);

	const liquidShare = $derived(
		figures.assetsPaise > 0 ? figures.liquidAssetsPaise / figures.assetsPaise : null
	);
	// The split bar: assets against liabilities, by size.
	const assetShare = $derived.by(() => {
		const a = Math.max(0, figures.assetsPaise);
		const l = Math.abs(Math.min(0, figures.liabilitiesPaise));
		return a + l > 0 ? a / (a + l) : 1;
	});

	const spentSoFar = $derived(mtd.thisMonth[mtd.thisMonth.length - 1] ?? 0);
	// D1 RD9: a comparison of spending is written in words and coloured by what it means.
	const vsLast = $derived(spentSoFar - mtd.lastMonthByThisDay);
	// S6: against the average month as well (all three on one chart).
	const avg = $derived(mtd.average);
	const vsAvg = $derived(avg ? spentSoFar - avg.byThisDay : 0);
	const avgLabel = $derived(avg ? `${monthName(avg.from).slice(0, 3)} to ${monthName(avg.to).slice(0, 3)} average` : '');
	const today = $derived(`${mtd.month}-${String(mtd.day).padStart(2, '0')}`);
	// Recent activity fills its column (Microsoft's show-more technique for
	// spare space): at least 10 rows, then as many as fit beside Spending this month and Allocation,
	// so the two columns end together; 10 when the Dashboard is one column.
	const MIN_ROWS = 10;
	let recentBody: HTMLTableSectionElement | undefined = $state();
	let rightCol: HTMLDivElement | undefined = $state();
	let shown = $state(MIN_ROWS);
	$effect(() => {
		const body = recentBody;
		const col = rightCol;
		const count = activity.length;
		if (!body || !col) return;
		const fit = () => {
			const row = body.rows[0];
			const last = col.lastElementChild;
			if (!row || !last) return;
			const top = body.getBoundingClientRect().top;
			const oneColumn = col.getBoundingClientRect().top > top;
			const rows = Math.floor((last.getBoundingClientRect().bottom - top) / row.getBoundingClientRect().height);
			shown = oneColumn ? MIN_ROWS : Math.min(count, Math.max(MIN_ROWS, rows));
		};
		fit();
		// The column (window width) and each card in it (the donut loads late and grows its card).
		const ro = new ResizeObserver(fit);
		ro.observe(col);
		for (const card of col.children) ro.observe(card);
		return () => ro.disconnect();
	});
	// On a light ledger Recent activity ends above Spending this month, and Allocation goes under it
	// instead: fewer than 6 rows, 7 when the
	// average line adds its two lines, measured at every two-column size. Decided from the load data,
	// so the server renders it in place and nothing moves.
	const allocLeft = $derived(activity.length < (avg ? 7 : 6));
	// A row opens its transaction in its register.
	const txHref = (row: { accountId: string; id: string }) => `/accounts/${row.accountId}?tx=${row.id}`;
	/** The guide's address, empty (and so hidden) until the export fills `$lib/links`. */
	const guide = linkTo('userGuide');
</script>

{#if !data.summary.hasOpenAccounts}
	<!-- First run: a real next-step panel, not a bare sentence. -->
	<Card.Root class="mx-auto mt-8 max-w-140">
		<Card.Content class="flex flex-col gap-3 p-3">
			<h1 class="text-subtitle font-semibold">Start with your first account</h1>
			<p class="text-body text-text-muted">
				Your net worth is built from your accounts. Add one (a bank account is a good start) and
				this dashboard fills in.
			</p>
			<ol class="ml-5 list-decimal text-body leading-7 text-text-muted">
				<li>Add an account with its current balance</li>
				<li>Log transactions as they happen (click Add, or press Ctrl+Shift+N)</li>
				<li>Net worth, allocation and reports fill in as you go</li>
			</ol>
			<!-- No wizard; the Actual import beside Add account, the same one as Settings'. -->
			<div class="flex flex-wrap items-center gap-2">
				<Button variant="outline" onclick={() => openAddAccount()}><Plus aria-hidden="true" /> Add account</Button>
				<ImportCard button />
			</div>
			<p class="text-caption text-text-muted">Import from Actual opens the zip that Actual's Settings, Export data saves.</p>
			{#if guide}
				<a href={guide} target="_blank" rel="noreferrer" class="inline-flex w-fit items-center gap-1 text-body text-brand-ink underline-offset-4 hover:underline">
					User guide<ExternalLink size={14} aria-hidden="true" />
				</a>
			{/if}
		</Card.Content>
	</Card.Root>
{:else}
	<PageHeader title="Dashboard">
		{#snippet headline()}
			<div class="flex flex-wrap items-start gap-x-12 gap-y-4">
				<div>
					<div class="text-caption text-text-muted">Net worth</div>
					<div class="num text-display font-normal {levelToneClass(figures.netWorthPaise)}">
						<Figure text={m.money(figures.netWorthPaise, { compact: m.compact })} />
					</div>
					{#if m.compact}
						<div class="num text-body text-text-muted">{m.money(figures.netWorthPaise)}</div>
					{/if}
					{#if data.history.changeSinceLastMonth}
						{@const chg = data.history.changeSinceLastMonth}
						<div class="num text-body {toneClass(chg.absPaise)}">{m.signedMoney(chg.absPaise)} this month</div>
					{/if}
					{#if shared}
						<!-- D1 RD12: the joint accounts the viewer holds, net, in full and at the share; the whole
						     line opens their breakdown (an expander, as Fluent's). Hidden when there are none. -->
						<button
							type="button"
							class="num -mx-1 mt-1 inline-flex items-center gap-1 rounded-control px-1 text-body text-text-muted hover:bg-control hover:text-foreground"
							aria-expanded={sharedOpen}
							aria-controls="shared-breakdown"
							onclick={() => (sharedOpen = !sharedOpen)}
						>
							Shared with others: {m.money(shared.fullPaise, { compact: m.compact })} (your share {m.money(shared.sharePaise, { compact: m.compact })})
							<ChevronDown size={14} aria-hidden="true" class="transition-transform motion-fast ease-decelerate {sharedOpen ? 'rotate-180' : ''}" />
						</button>
					{/if}
				</div>
				<div class="w-80 max-w-full pt-1">
					<div class="flex justify-between gap-6">
						<div>
							<div class="text-caption text-text-muted">Assets</div>
							<div class="num text-body-lg font-semibold {levelToneClass(figures.assetsPaise)}">
								{m.money(figures.assetsPaise, { compact: m.compact })}
							</div>
						</div>
						<div class="text-right">
							<div class="text-caption text-text-muted">Liabilities</div>
							<div class="num text-body-lg font-semibold {levelToneClass(figures.liabilitiesPaise)}">
								{m.money(figures.liabilitiesPaise, { compact: m.compact })}
							</div>
						</div>
					</div>
					<div class="mt-2 flex h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
						<span class="h-full bg-pos" style="width: {(assetShare * 100).toFixed(1)}%"></span>
						<span class="h-full flex-1 bg-neg"></span>
					</div>
					{#if liquidShare !== null}
						<!-- D1 RD8: the liquid share, a part of Assets, as a caption under it. -->
						<div class="mt-1 text-caption text-text-muted">
							<span class="num">{m.money(figures.liquidAssetsPaise, { compact: true })}</span> available now ({formatPercent(liquidShare)})
						</div>
					{/if}
				</div>
			</div>
		{/snippet}
	</PageHeader>

	{#if shared && sharedOpen}
		<div id="shared-breakdown" class="mb-section max-w-160" in:foldIn out:foldOut>
			<table class="data-table dense">
				<thead>
					<tr><th>Account</th><th class="num">Full</th><th class="num w-24">Your share</th><th class="num">Yours</th></tr>
				</thead>
				<tbody>
					{#each shared.accounts as a (a.id)}
						<tr>
							<td class="truncate">
								<a href={`/accounts/${a.id}`} class="hover:underline">{a.name}</a>
								{#if a.side === 'Liability'}<span class="ml-2 text-text-muted">You're liable for the full amount</span>{/if}
							</td>
							<td class="num {levelToneClass(a.fullPaise)}">{m.money(a.fullPaise)}</td>
							<td class="num text-text-muted">{formatShare(a.shareBp)}</td>
							<td class="num {levelToneClass(a.sharePaise)}">{m.money(a.sharePaise)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#if figures.rateNeededCurrencies.length > 0}
		{@render RateNeededNudge(figures.rateNeededCurrencies, 'net worth')}
	{/if}

	<Section title="Net worth over time">
		{#snippet actions()}
			<LinkSwitch label="Range" items={RANGES.map((r) => ({ href: `/?range=${r}`, label: r === 'ALL' ? 'All' : r, current: range === r }))} />
		{/snippet}
		{#if history.points.length < 2}
			<p class="text-body text-text-muted">The chart starts after one full month.</p>
		{:else}
			<NetWorthLine points={history.points} />
		{/if}
		{#if history.rateNeededCurrencies.length > 0}
			{@render RateNeededNudge(history.rateNeededCurrencies, 'this history')}
		{/if}
	</Section>

	<div class="mt-section grid grid-cols-[minmax(0,7fr)_minmax(0,5fr)] gap-8 narrow:grid-cols-1">
		<!-- One column: the left column's parts join the grid, so Allocation still comes last. -->
		<div class="min-w-0 narrow:contents">
			<Section title="Recent activity" class="min-w-0">
				{#snippet actions()}
					<a href="/transactions" class="text-body text-brand-ink hover:underline">View all</a>
				{/snippet}
				{#if activity.length === 0}
					<p class="text-body text-text-muted">No activity yet.</p>
				{:else}
					<table class="data-table dense" use:rowLink>
						<colgroup><col class="w-20" /><col /><col class="w-36" /></colgroup>
						<tbody bind:this={recentBody}>
							{#each activity.slice(0, shown) as row (row.id)}
								<tr>
									<td class="date text-text-muted">{formatDateShort(row.date, today)}</td>
									<td class="truncate">
										{#if row.entryType === 'transfer'}
											<!-- D8: plain, as the register and All transactions print it (no tag). -->
											<ArrowLeftRight size={14} class="mr-1 inline align-text-bottom text-text-muted" aria-label="Transfer" />
											<!-- The other side in an account this viewer can't see reads as the person who moved the
											     money ("From Alice"), as in the registers (ACTUAL-PARITY #23), never "Unknown". -->
											<a href={txHref(row)} class="hover:underline">{row.transferFromName ?? `From ${row.enteredByName ?? 'another account'}`} &rarr; {row.transferToName ?? row.enteredByName ?? 'another account'}</a>
											{#if row.counterpartCurrency}
												<span class="text-body text-text-muted"
													>({m.moneyWithCode(row.counterpartAmountPaise ?? 0, row.counterpartCurrency)})</span
												>
											{/if}
										{:else if row.entryType === 'valuationMark'}
											<a href={txHref(row)} class="hover:underline">{row.accountName}</a>
											<span class="ml-1 text-body text-text-muted">Value update</span>
										{:else}
											<a href={txHref(row)} class="hover:underline">{row.payeeName ?? row.categoryName ?? row.accountName}</a>
											<span class="ml-1 text-body text-text-muted">{row.categoryName ?? 'Uncategorized'}</span>
										{/if}
										{#if row.isSharedAccount && row.enteredByName}<span class="ml-1 text-body text-text-muted"
												>by {row.enteredByName}</span
											>{/if}
									</td>
									<!-- Q6 B: spending red, income green, a valuation update by its sign; a merged
									     transfer is unsigned and neutral (D4 RD2, RD7). -->
									{#if row.entryType === 'transfer'}
										<td class="num">{m.money(Math.abs(row.amountPaise), { currency: row.currency })}</td>
									{:else}
										<td class="num {flowToneClass(row.amountPaise)}">
											{row.entryType === 'valuationMark'
												? m.signedMoney(row.amountPaise, { currency: row.currency })
												: m.money(row.amountPaise, { currency: row.currency })}
										</td>
									{/if}
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</Section>
			{#if allocLeft}
				<!-- The legend keeps its right-column width, so a share stays by its name. -->
				{@render allocation('narrow:order-last narrow:-mt-2 [&_.legend]:max-w-60')}
			{/if}
		</div>

		<div class="min-w-0" bind:this={rightCol}>
			<Section title="Spending this month">
				<div class="flex flex-wrap items-baseline gap-x-2">
					<span class="num text-subtitle font-semibold {spendToneClass(spentSoFar)}">{m.money(spentSoFar)}</span>
					<span class="text-caption text-text-muted">spent by {formatDate(today)}</span>
				</div>
				<!-- D1 RD9: in words, coloured by meaning (less spending is good). `text-pretty`: a narrow
				     window breaks the sentence earlier rather than leave "day" alone on a line. -->
				<div class="text-body text-pretty {vsLast < 0 ? 'text-pos' : vsLast > 0 ? 'text-neg' : 'text-text-muted'}">
					{#if vsLast === 0}
						The same as by this day in {monthName(mtd.lastMonth)}
					{:else}
						<span class="num">{m.money(Math.abs(vsLast))}</span>
						{vsLast < 0 ? 'less' : 'more'} than by this day in {monthName(mtd.lastMonth)}
					{/if}
				</div>
				{#if avg}
					<div class="text-body text-pretty {vsAvg < 0 ? 'text-pos' : vsAvg > 0 ? 'text-neg' : 'text-text-muted'}">
						{#if vsAvg === 0}
							The same as your {avgLabel} by this day
						{:else}
							<span class="num">{m.money(Math.abs(vsAvg))}</span> {vsAvg < 0 ? 'less' : 'more'} than your {avgLabel} by this day
						{/if}
					</div>
				{/if}
				<div class="mt-2">
					<SpendingPace
						thisMonth={mtd.thisMonth}
						lastMonth={mtd.lastMonthCumulative}
						thisLabel={monthName(mtd.month)}
						lastLabel={monthName(mtd.lastMonth)}
						average={avg?.cumulative ?? null}
						averageLabel={avgLabel}
					/>
				</div>
			</Section>

			{#if !allocLeft}{@render allocation()}{/if}
		</div>
	</div>
{/if}

{#snippet allocation(cls = '')}
	<Section title="Allocation" class={cls}>
		{#snippet actions()}
			<Segmented
				bind:value={allocBy}
				size="sm"
				ariaLabel="Group allocation by"
				options={[
					{ value: 'class', label: 'By class' },
					{ value: 'liquidity', label: 'By availability' }
				]}
			/>
		{/snippet}
		<AllocationDonut {slices} {labelOf} {colorOf} {hrefOf} size="sm" />
	</Section>
{/snippet}

{#snippet RateNeededNudge(currencies: string[], label: string)}
	<p class="mb-3 text-body text-warn">
		No rate for {currencies.join(', ')}, so {label} leaves {currencies.length === 1 ? 'it' : 'them'} out.
		<a href={`/settings?currency=${currencies[0]}`} class="ml-1 font-semibold hover:underline">Set rate</a>
	</p>
{/snippet}
