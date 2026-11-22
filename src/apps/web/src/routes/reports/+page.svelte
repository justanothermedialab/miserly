<!--
	Reports, rebuilt to the approved mock and its
	decisions. Named tabs (R1 RD5); one toolbar row with the range (trailing 3, 6 and 12
	months and the FY presets, the rest under More, R1 RD6), the period and the Shared switch;
	then per report a headline, one full-width chart (legend above, flush left) and its table.

	  - Spending (R2 RD5 to RD8): bars by month stacked by category (fixed colours, top 7, the
	    rest one grey "Other", Uncategorized in the warning colour), the category x month table
	    with Avg / month, Share and Total; the headline compares with the previous period in
	    words; a category row drills into its transactions. By payee (R2 RD13) shows the same
	    figures by payee: the same top 7 and Other, "No payee" in Uncategorized's grey.
	  - Income vs expense (R3 RD5, RD6): grouped bars, the month table, savings rate in the headline.
	  - Net worth (D3 RD6, RD7): classes by month (liabilities below zero) with the net line, the
	    recap table with a Change row.
-->
<script lang="ts">
	import { NET_INVESTED } from '$lib/reports/labels';
	import { savingsRate, savingsRateText, savingsRateCsv } from '$lib/reports/savings-rate';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import Figure from '$lib/components/Figure.svelte';
	import { afterNavigate } from '$app/navigation';
	import { tick } from 'svelte';
	import { PageHeader, Section, TableFrame } from '$lib/components/layout';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { formatDate, formatDateShort, monthName, monthShort } from '$lib/dates';
	import { formatPercent, formatShare, toneClass, spendToneClass, levelToneClass, flowToneClass } from '$lib/format';
	import { useMoney } from '$lib/format-context';
	import { rankCss, OTHER_COLOUR } from '$lib/swatches';
	import { moduleColour, sectionLabel } from '$lib/modules';
	import { presetHint, presetLabel, presetsFor, type Preset } from '$lib/reports/period';
	import StackedBars from '$lib/components/StackedBars.svelte';
	import IncomeExpenseBars from '$lib/components/IncomeExpenseBars.svelte';
	import DateField from '$lib/components/DateField.svelte';
	import { flyoutMotion } from '$lib/motion';
	import { Button } from '$lib/components/ui/button';
	import { Popover } from 'bits-ui';
	import { ChevronDown, Download } from '@lucide/svelte';
	import { downloadCsv, rupees } from '$lib/register/csv';
	import { rowLink } from '$lib/row-link';
	import type { PageData } from './$types';
	/** A drill's row (both drills return the same shape). */
	type ReportTransaction = NonNullable<Extract<PageData, { tab: 'spending' }>['drill']>['transactions'][number];

	// A category's transactions open below the table; bring them into view and
	// focus them, or the click looks like it did nothing.
	afterNavigate(({ from }) => {
		const q = new URL(location.href).searchParams;
		if (!from || !(q.get('cat') || q.get('flow'))) return;
		void tick().then(() => {
			const drill = document.getElementById('report-drill');
			drill?.scrollIntoView({ block: 'start' });
			drill?.focus({ preventScroll: true });
		});
	});

	let { data }: { data: PageData } = $props();
	const m = useMoney();

	const TABS = [
		{ key: 'spending', label: 'Spending' },
		{ key: 'income', label: 'Income and spending' },
		{ key: 'networth', label: 'Net worth' }
	] as const;
	const MAIN: Preset[] = ['last3m', 'last6m', 'last12m', 'thisFY', 'lastFY'];
	// A January year has no separate "financial year to date" (R1).
	const MORE = $derived(presetsFor(['thisMonth', 'lastMonth', 'thisQuarter', 'lastQuarter', 'ytd', 'fytd', 'all'], data.yearStart));

	let moreOpen = $state(false);
	let customFrom = $state('');
	let customTo = $state('');
	$effect.pre(() => {
		customFrom = data.period.from;
		customTo = data.period.to;
	});

	/** The one URL builder for this route; carries the tab and a custom range forward. */
	function href(
		over: {
			report?: string;
			preset?: string;
			by?: 'category' | 'payee';
			cat?: string | null;
			payee?: string | null;
			flow?: 'income' | 'spending' | null;
			month?: string;
		} = {}
	): string {
		const report = over.report ?? data.tab;
		const params = new URLSearchParams({ report });
		// By payee stays on while the range changes; a tab switch drops it.
		const by = over.by ?? (report === data.tab && data.tab === 'spending' ? data.by : 'category');
		if (report === 'spending' && by === 'payee') params.set('by', 'payee');
		// A tab switch drops the preset, so each tab opens on its own default range (R1 RD6).
		const preset = over.preset ?? (over.report && over.report !== data.tab ? undefined : data.period.preset);
		if (preset) params.set('preset', preset);
		if (preset === 'custom') {
			params.set('from', data.period.from);
			params.set('to', data.period.to);
		}
		if (over.cat) params.set('cat', over.cat);
		if (over.payee) params.set('payee', over.payee);
		if (over.flow) params.set('flow', over.flow);
		if ((over.cat || over.payee || over.flow) && over.month) params.set('month', over.month);
		return `?${params.toString()}`;
	}

	// The caption starts where the data does (a 12-month window over 10 months of ledger says so).
	const shownFrom = $derived(data.earliest && data.earliest > data.period.from ? data.earliest : data.period.from);
	const periodText = $derived(`${formatDate(shownFrom)} to ${formatDate(data.period.to < data.todayIso ? data.period.to : data.todayIso)}`);
	const trackingBegan = $derived(data.earliest ? `${monthName(data.earliest)} ${data.earliest.slice(0, 4)}` : null);

	// ── Spending ───────────────────────────────────────────────────────────────
	const TOP = 7;
	const byPayee = $derived(data.tab === 'spending' && data.by === 'payee');
	/** The open view's figures, by category or by payee (R2 RD13); both have the same totals. */
	const spend = $derived(data.tab === 'spending' ? (data.byMonth ?? data.byPayee) : null);
	/** One row per category or payee; `none` is Uncategorized or No payee (a grey of its own, no rank). */
	type SpendRow = { id: string; name: string; groupId: string; groupName: string; byMonth: number[]; totalPaise: number; none: boolean };
	const spendRows = $derived.by((): SpendRow[] => {
		if (data.tab !== 'spending') return [];
		if (data.byPayee)
			return data.byPayee.payees.map((p) => ({ id: p.payeeId, name: p.name, groupId: '', groupName: '', byMonth: p.byMonth, totalPaise: p.totalPaise, none: p.payeeId === '__no_payee__' }));
		return (data.byMonth?.categories ?? []).map((c) => ({
			id: c.categoryId,
			name: c.name,
			groupId: c.groupId,
			groupName: c.groupName,
			byMonth: c.byMonth,
			totalPaise: c.totalPaise,
			none: c.categoryId === '__uncategorized__'
		}));
	});
	/** A row's drill: its category's or its payee's transactions, in one month or the whole range. */
	const drillHref = (id: string, month?: string) => href(byPayee ? { payee: id, month } : { cat: id, month });
	const spendSeries = $derived.by(() => {
		if (!spend) return [];
		const positive = spendRows.filter((c) => c.totalPaise > 0);
		const top = positive.slice(0, TOP);
		const rest = positive.slice(TOP);
		// Colours by rank in this chart (R2 RD8 amended: Simplifi's and YNAB's way), so the
		// biggest seven never share a colour; Uncategorized keeps a dark grey of its own (not a swatch,
		// not Other's light grey) and takes no rank.
		let rank = 0;
		const series: { id?: string; name: string; color: string; values: number[]; parts?: { name: string; values: number[] }[] }[] = top.map((c) => ({
			id: c.id,
			name: c.name,
			color: c.none ? 'var(--text-muted)' : rankCss(rank++),
			values: c.byMonth
		}));
		if (rest.length > 0)
			series.push({
				name: 'Other',
				color: OTHER_COLOUR,
				values: spend.months.map((_, i) => rest.reduce((s, c) => s + (c.byMonth[i] ?? 0), 0)),
				parts: rest.map((c) => ({ name: c.name, values: c.byMonth }))
			});
		return series;
	});
	// Table rows grouped by category group (R2 RD1), groups by their total; payees are one list.
	const spendGroups = $derived.by(() => {
		if (!spend) return [];
		const groups = new Map<string, { name: string; total: number; rows: SpendRow[] }>();
		for (const c of spendRows) {
			const g = groups.get(c.groupId) ?? { name: c.groupName, total: 0, rows: [] };
			g.total += c.totalPaise;
			g.rows.push(c);
			groups.set(c.groupId, g);
		}
		return [...groups.values()].sort((a, b) => b.total - a.total);
	});
	const avg = (total: number, n: number) => (n > 0 ? Math.round(total / n) : 0);
	const previous = $derived(data.tab === 'spending' ? data.previous : { totalPaise: 0, label: '', complete: false });
	const spendDiff = $derived(spend ? spend.totalPaise - previous.totalPaise : 0);
	// By id, not name: a payee may share a name with a category or be called "Other".
	const colourOf = $derived(new Map(spendSeries.filter((s) => s.id !== undefined).map((s) => [s.id, s.color])));

	/** A held first column shows its edge line once its table has scrolled sideways. */
	function scrolledEdge(table: HTMLTableElement) {
		const frame = table.parentElement;
		if (!frame) return;
		const sync = () => table.toggleAttribute('data-scrolled', frame.scrollLeft > 0);
		frame.addEventListener('scroll', sync, { passive: true });
		return { destroy: () => frame.removeEventListener('scroll', sync) };
	}

	// ── Income vs expense ─────────────────────────────────────────────────────
	const cash = $derived(data.tab === 'income' ? data.cashflow : null);

	// The open drill, by tab: a category (Spending) or a month's income or spending (Income vs expense).
	const spendDrill = $derived(data.tab === 'spending' ? data.drill : null);
	const flowDrill = $derived(data.tab === 'income' ? data.drill : null);

	// U8: the spending month table in whole rupees, as the net worth table beside it is compact; the
	// export keeps the paise. Rounded to the nearest rupee, as the sidebar's rows (SET1 RD5).
	const wholeMoney = (paise: number): string => m.money(Math.round(paise / 100) * 100).replace(/\.00(?!\d)/u, '');

	// ── Net worth ─────────────────────────────────────────────────────────────
	const nw = $derived(data.tab === 'networth' ? data.networth : null);
	const nwSeries = $derived(
		(nw?.classes ?? []).map((c) => ({
			name: sectionLabel(c.type),
			// Liabilities sit below zero in the money colour for owing (the colour of money).
			color: c.side === 'Liability' ? (c.type === 'loan' ? 'var(--neg)' : 'color-mix(in srgb, var(--neg) 55%, transparent)') : moduleColour(c.type),
			values: c.values
		}))
	);
	// The open report's table as a CSV (item 4's analyst depth; the register's Export,
	// ACTUAL-PARITY #10): the rows on screen, plain numbers, made from what the page holds (P0).
	function exportCsv() {
		const tab = TABS.find((t) => t.key === data.tab)?.label ?? 'Report';
		const name = `${tab} ${shownFrom} to ${data.period.to < data.todayIso ? data.period.to : data.todayIso}.csv`;
		if (spend) {
			const months = spend.months;
			// One month: no month columns or average, as on screen (they'd repeat Total).
			const perMonth = (vals: number[], total: number) => (months.length > 1 ? [...vals.map(rupees), rupees(avg(total, months.length))] : []);
			// By payee: one Payee column in place of Group and Category (R2 RD13).
			const head = byPayee ? ['Payee'] : ['Group', 'Category'];
			downloadCsv(byPayee ? name.replace(/^Spending /u, 'Spending by payee ') : name, [
				[...head, ...(months.length > 1 ? [...months, 'Avg / month'] : []), 'Share %', 'Total'],
				...spendGroups.flatMap((g) =>
					g.rows.map((c) => [
						...(byPayee ? [] : [g.name]),
						c.name,
						...perMonth(c.byMonth, c.totalPaise),
						spend.totalPaise > 0 ? Math.round((c.totalPaise / spend.totalPaise) * 1000) / 10 : null,
						rupees(c.totalPaise)
					])
				),
				['Total', ...(byPayee ? [] : ['']), ...perMonth(spend.monthTotals, spend.totalPaise), 100, rupees(spend.totalPaise)]
			]);
		} else if (cash) {
			// R3 RD16: the same rate as on screen, a plain number; an empty cell without income.
			downloadCsv(name, [
				['Month', 'Income', 'Spending', 'Net', 'Saved %', NET_INVESTED],
				...cash.bins.map((b) => [b.month, rupees(b.incomePaise), rupees(b.expensePaise), rupees(b.netPaise), savingsRateCsv(b.incomePaise, b.netPaise), rupees(b.investedPaise)]),
				['Total', rupees(cash.totalIncomePaise), rupees(cash.totalExpensePaise), rupees(cash.netPaise), savingsRateCsv(cash.totalIncomePaise, cash.netPaise), rupees(cash.totalInvestedPaise)]
			]);
		} else if (nw) {
			downloadCsv(name, [
				['Section', ...nw.dates],
				...nw.classes.map((c) => [sectionLabel(c.type), ...c.values.map(rupees)]),
				['Net worth', ...nw.netWorth.map(rupees)],
				['Change', ...nw.netWorth.map((v, i) => (i === 0 ? null : rupees(v - (nw.netWorth[i - 1] ?? 0))))]
			]);
		}
	}

	const nwFirst = $derived(nw?.netWorth[0] ?? 0);
	const nwLast = $derived(nw?.netWorth[(nw?.netWorth.length ?? 1) - 1] ?? 0);
</script>

<PageHeader title="Reports" />

<!-- Named tabs (R1 RD5): links, so each report has its own URL. -->
<div class="flex items-end gap-1 border-b border-divider">
<nav aria-label="Reports" class="flex gap-1">
	{#each TABS as t (t.key)}
		<a
			href={href({ report: t.key })}
			aria-current={data.tab === t.key ? 'page' : undefined}
			class="relative px-3 pb-2.5 pt-2 text-body {data.tab === t.key
				? "font-semibold text-foreground after:absolute after:inset-x-3 after:-bottom-px after:h-0.75 after:rounded-full after:bg-brand-mark after:content-['']"
				: 'text-text-muted hover:text-foreground'}">{t.label}</a
		>
	{/each}
</nav>
<!-- Export sits on the tabs' line (it exports the open tab), so the range row stays one line at 1232. -->
{#if data.earliest !== null}
	<Button variant="ghost" class="mb-1 ml-auto" onclick={exportCsv}><Download aria-hidden="true" /> Export</Button>
{/if}
</div>

<!-- One toolbar row: the range, More and the period. -->
<div class="mt-3 flex min-h-8 flex-wrap items-center gap-control">
	<nav aria-label="Range" class="inline-flex gap-0.5 rounded-control border border-border bg-card-2 p-0.75">
		{#each MAIN as p (p)}
			<Tooltip label={presetHint(p, data.yearStart) ?? ''} disabled={!presetHint(p, data.yearStart)}>
			{#snippet child({ props })}<a
				{...props}
				href={href({ preset: p })}
				aria-current={data.period.preset === p ? 'true' : undefined}
				class="rounded-control px-3 py-1 text-body {data.period.preset === p
					? 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-control-hover dark:shadow-none'
					: 'text-text-muted hover:bg-control hover:text-foreground'}">{presetLabel(p, data.yearStart)}</a
			>{/snippet}
			</Tooltip>
		{/each}
	</nav>
	<Popover.Root bind:open={moreOpen}>
		<Popover.Trigger
			class="inline-flex h-8 items-center gap-1 rounded-control border border-border-strong bg-surface px-3 text-body font-semibold hover:bg-surface-2 aria-expanded:bg-surface-2 {MORE.includes(data.period.preset) || data.period.preset === 'custom' ? 'text-brand-ink' : ''}"
		>
			{MORE.includes(data.period.preset) || data.period.preset === 'custom' ? presetLabel(data.period.preset, data.yearStart) : 'More'}
			<ChevronDown size={14} aria-hidden="true" />
		</Popover.Trigger>
		<Popover.Portal>
			<Popover.Content
				sideOffset={4}
				align="start"
				class="z-50 w-80 rounded-overlay border border-border bg-popover p-2 text-popover-foreground shadow-[var(--shadow-pop)] outline-none {flyoutMotion}"
			>
				<ul class="flex flex-col">
					{#each MORE as p (p)}
						<li>
							<Tooltip label={presetHint(p, data.yearStart) ?? ''} disabled={!presetHint(p, data.yearStart)} side="right">
							{#snippet child({ props })}<a
								{...props}
								href={href({ preset: p })}
								onclick={() => (moreOpen = false)}
								class="flex h-8 items-center rounded-control px-2 text-body hover:bg-control-hover {data.period.preset === p ? 'font-semibold' : ''}"
								>{presetLabel(p, data.yearStart)}</a
							>{/snippet}
							</Tooltip>
						</li>
					{/each}
				</ul>
				<form method="GET" class="mt-2 flex flex-col gap-2 border-t border-divider px-2 pt-3" onsubmit={() => (moreOpen = false)}>
					<input type="hidden" name="report" value={data.tab} />
					{#if byPayee}<input type="hidden" name="by" value="payee" />{/if}
					<input type="hidden" name="preset" value="custom" />
					<span class="text-caption font-normal text-text-muted">Custom range</span>
					<div class="grid grid-cols-2 gap-2">
						<DateField name="from" bind:value={customFrom} aria-label="From" required class="w-full" />
						<DateField name="to" bind:value={customTo} aria-label="To" required class="w-full" />
					</div>
					<div class="flex justify-end"><Button type="submit" variant="outline" size="sm">Apply</Button></div>
				</form>
			</Popover.Content>
		</Popover.Portal>
	</Popover.Root>
	<span class="text-body text-text-muted">{periodText}</span>
	{#if data.tab === 'spending' && data.earliest !== null}
		<!-- R2 RD13: the same spending, by category or by payee; the range's switch style. -->
		<nav aria-label="Spending by" class="ml-auto inline-flex gap-0.5 rounded-control border border-border bg-card-2 p-0.75">
			{#each [{ by: 'category', label: 'By category' }, { by: 'payee', label: 'By payee' }] as const as v (v.by)}
				<a
					href={href({ by: v.by })}
					aria-current={data.by === v.by ? 'true' : undefined}
					class="rounded-control px-3 py-1 text-body {data.by === v.by
						? 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-control-hover dark:shadow-none'
						: 'text-text-muted hover:bg-control hover:text-foreground'}">{v.label}</a
				>
			{/each}
		</nav>
	{/if}
</div>

<!-- Nothing recorded yet: one empty state, not three empty reports. -->
{#if data.earliest === null}
	<EmptyState icon="reports" title="Nothing to report yet" text="Reports fill in as you add transactions.">
		{#snippet action()}<Button variant="outline" onclick={() => window.dispatchEvent(new CustomEvent('miserly:quickadd'))}>Add transaction</Button>{/snippet}
	</EmptyState>
{:else}
{#if spend}
	{@const months = spend.months}
	<!-- One month in range: its column and Avg / month would repeat Total (census). -->
	{@const multi = months.length > 1}
	{#if spendRows.length === 0}
		<!-- One empty state, not three zero figures and three sentences. -->
		<p class="mt-section text-body text-text-muted">
			{trackingBegan ? 'No spending in this period.' : 'No spending yet. Add transactions and this report fills in.'}
		</p>
	{:else}
	<!-- Headline (R2 RD7): the total, the monthly average, the previous period in words. -->
	<div class="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
		<span class="num text-display font-normal {spendToneClass(spend.totalPaise)}"><Figure text={m.money(spend.totalPaise, { compact: m.compact })} /></span>
		<!-- The exact figure only when the headline is compact (it repeated itself, ACTUAL-PARITY #19). -->
		{#if m.compact}<span class="num text-body text-text-muted">{m.money(spend.totalPaise)} spent</span>{/if}
		<span class="flex-1"></span>
		{#if multi}<span class="text-body text-text-muted"><span class="num">{m.money(avg(spend.totalPaise, months.length))}</span> a month on average</span>{/if}
	</div>
	<div class="text-body">
		{#if !previous.complete}
			<span class="text-text-muted">{trackingBegan ? `Tracking began in ${trackingBegan}` : 'No earlier spending to compare with'}</span>
		{:else if spendDiff === 0}
			<span class="text-text-muted">The same as {previous.label}</span>
		{:else}
			<!-- D1 RD9: in words, coloured by meaning (less spending is good). -->
			<span class={spendDiff < 0 ? 'text-pos' : 'text-neg'}
				><span class="num">{m.money(Math.abs(spendDiff))}</span> {spendDiff < 0 ? 'less' : 'more'} than {previous.label}</span
			>
		{/if}
	</div>
	{#if spend.rateNeededCurrencies.length > 0}{@render RateNeededNudge(spend.rateNeededCurrencies)}{/if}

		<div class="mt-3">
			<StackedBars
				keys={months}
				labels={months.map(monthShort)}
				series={spendSeries}
				hrefOf={(si, ki) => {
					// A segment opens the same drill as its table cell (the category or payee in that month).
					const id = spendSeries[si]?.id;
					return id ? drillHref(id, months[ki]) : null;
				}}
			/>
		</div>
		<TableFrame class="mt-4">
			<table class="data-table auto sticky-first" use:rowLink use:scrolledEdge>
				<thead>
					<tr>
						<th>{byPayee ? 'Payee' : 'Category'}</th>
						{#if multi}
							{#each months as mo (mo)}<th class="num">{monthShort(mo)}</th>{/each}
							<th class="num">Avg / month</th>
						{/if}
						<th class="num">Share</th>
						<th class="num">Total</th>
					</tr>
				</thead>
				<tbody>
					{#each spendGroups as g (g.name)}
						{#if !byPayee && !(g.rows.length === 1 && g.rows[0]!.name === g.name)}
							<tr class="group-row"><td colspan={multi ? months.length + 4 : 3}><span class="held">{g.name}</span></td></tr>
						{/if}
						{#each g.rows as c (c.id)}
							<tr data-selected={(spendDrill?.payeeId ?? spendDrill?.categoryId) === c.id ? '' : undefined}>
								<td class="truncate">
									<a href={drillHref(c.id)} class="inline-flex items-center gap-2 hover:underline">
										<span
											class="size-2.5 flex-none rounded-full"
											style="background: {colourOf.get(c.id) ?? OTHER_COLOUR}"
											aria-hidden="true"
										></span>{c.name}
									</a>
								</td>
								{#if multi}
									{#each c.byMonth as v, i (i)}
										<!-- A month's figure lists that month's rows (item 2.5: it listed the whole range). -->
										<td class="num {v ? '' : 'text-text-muted'}">{#if v}<a href={drillHref(c.id, months[i])} class="hover:underline" aria-label={`${c.name}, ${monthShort(months[i]!)}: ${wholeMoney(v)}`}>{wholeMoney(v)}</a>{:else}–{/if}</td>
									{/each}
									<td class="num text-text-muted">{wholeMoney(avg(c.totalPaise, months.length))}</td>
								{/if}
								<td class="num text-text-muted">{spend.totalPaise > 0 ? formatPercent(c.totalPaise / spend.totalPaise) : '–'}</td>
								<td class="num">{wholeMoney(c.totalPaise)}</td>
							</tr>
						{/each}
					{/each}
					<tr class="font-semibold">
						<td>Total</td>
						{#if multi}
							{#each spend.monthTotals as v, i (i)}<td class="num {spendToneClass(v)}">{wholeMoney(v)}</td>{/each}
							<td class="num {spendToneClass(spend.totalPaise)}">{wholeMoney(avg(spend.totalPaise, months.length))}</td>
						{/if}
						<td class="num">100%</td>
						<td class="num {spendToneClass(spend.totalPaise)}">{wholeMoney(spend.totalPaise)}</td>
					</tr>
				</tbody>
			</table>
		</TableFrame>
	{/if}

	{#if spendDrill}{@render drillList(spendDrill.name, spendDrill.transactions, href({ cat: null }))}{/if}

{/if}

{#if cash}
	<!-- R3 RD16: the range's savings rate; the sentence only when there is income to divide by. -->
	{@const pct = savingsRate(cash.totalIncomePaise, cash.netPaise) === null ? null : savingsRateText(cash.totalIncomePaise, cash.netPaise)}
	{@const inv = cash.bins.some((b) => b.investedPaise !== 0)}
	<div class="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
		<span class="num text-display font-normal {toneClass(cash.netPaise)}"><Figure text={m.signedMoney(cash.netPaise, { compact: m.compact })} /></span>
		<!-- The full figure beside the compact one; with compact amounts off they'd be the same (P4D). -->
		<span class="num text-body text-text-muted">{#if m.compact}{m.signedMoney(cash.netPaise)}{' '}{/if}net</span>
		{#if pct !== null}<span class="text-body text-text-muted">Saved {pct} of income</span>{/if}
		<span class="flex-1"></span>
		<span class="num text-body text-pos">{m.money(cash.totalIncomePaise)} in</span>
		<span class="num text-body text-neg">{m.money(cash.totalExpensePaise)} out</span>
		{#if inv}<span class="num text-body text-text-muted">{m.money(cash.totalInvestedPaise)} {NET_INVESTED.toLowerCase()}</span>{/if}
	</div>
	{#if cash.rateNeededCurrencies.length > 0}{@render RateNeededNudge(cash.rateNeededCurrencies)}{/if}
	{#if cash.bins.every((b) => b.incomePaise === 0 && b.expensePaise === 0 && b.investedPaise === 0)}
		<p class="mt-section text-body text-text-muted">No income or spending in this period.</p>
	{:else}
		<div class="mt-3"><IncomeExpenseBars cashflow={cash} hrefOf={(month, flow) => href({ flow, month })} /></div>
		<TableFrame class="mt-4">
			<table class="data-table" use:rowLink>
				<thead>
					<tr><th>Month</th><th class="num">Income</th><th class="num">Spending</th><th class="num">Net</th><th class="num">Saved</th>{#if inv}<th class="num">{NET_INVESTED}</th>{/if}</tr>
				</thead>
				<tbody>
					{#each cash.bins as b (b.month)}
						{@const label = `${monthName(b.month)} ${b.month.slice(0, 4)}`}
						<tr data-selected={flowDrill?.month === b.month ? '' : undefined}>
							<td>{label}</td>
							<!-- R3 RD10: a month's figure lists its transactions, as Spending's cells do. -->
							<td class="num {toneClass(b.incomePaise)}">{#if b.incomePaise !== 0}<a href={href({ flow: 'income', month: b.month })} class="hover:underline" aria-label={`Income, ${label}: ${m.money(b.incomePaise)}`}>{m.money(b.incomePaise)}</a>{:else}{m.money(b.incomePaise)}{/if}</td>
							<td class="num {spendToneClass(b.expensePaise)}">{#if b.expensePaise !== 0}<a href={href({ flow: 'spending', month: b.month })} class="hover:underline" aria-label={`Spending, ${label}: ${m.money(b.expensePaise)}`}>{m.money(b.expensePaise)}</a>{:else}{m.money(b.expensePaise)}{/if}</td>
							<td class="num {toneClass(b.netPaise)}">{m.signedMoney(b.netPaise)}</td>
							<td class="num text-text-muted">{savingsRateText(b.incomePaise, b.netPaise)}</td>
							{#if inv}<td class="num">{m.money(b.investedPaise)}</td>{/if}
						</tr>
					{/each}
					<tr class="font-semibold">
						<td>Total</td>
						<td class="num {toneClass(cash.totalIncomePaise)}">{#if cash.totalIncomePaise !== 0}<a href={href({ flow: 'income' })} class="hover:underline">{m.money(cash.totalIncomePaise)}</a>{:else}{m.money(cash.totalIncomePaise)}{/if}</td>
						<td class="num {spendToneClass(cash.totalExpensePaise)}">{#if cash.totalExpensePaise !== 0}<a href={href({ flow: 'spending' })} class="hover:underline">{m.money(cash.totalExpensePaise)}</a>{:else}{m.money(cash.totalExpensePaise)}{/if}</td>
						<td class="num {toneClass(cash.netPaise)}">{m.signedMoney(cash.netPaise)}</td>
						<td class="num text-text-muted">{savingsRateText(cash.totalIncomePaise, cash.netPaise)}</td>
						{#if inv}<td class="num">{m.money(cash.totalInvestedPaise)}</td>{/if}
					</tr>
				</tbody>
			</table>
		</TableFrame>
	{/if}
	{#if flowDrill}{@render drillList(flowDrill.name, flowDrill.transactions, href({ flow: null }))}{/if}
{/if}

{#if nw}
	<div class="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
		<span class="num text-display font-normal {levelToneClass(nwLast)}"><Figure text={m.money(nwLast, { compact: m.compact })} /></span>
		{#if m.compact}<span class="num text-body text-text-muted">{m.money(nwLast)}</span>{/if}
		<span class="flex-1"></span>
		{#if nw.dates.length > 1}
			<span class="num text-body {toneClass(nwLast - nwFirst)}"
				>{m.signedMoney(nwLast - nwFirst)} since {monthName(nw.dates[0]!)} {nw.dates[0]!.slice(0, 4)}</span
			>
		{/if}
	</div>
	{#if nw.rateNeededCurrencies.length > 0}{@render RateNeededNudge(nw.rateNeededCurrencies)}{/if}
	{#if nw.classes.length === 0}
		<p class="mt-section text-body text-text-muted">No accounts in this period.</p>
	{:else}
		<div class="mt-3">
			<StackedBars keys={nw.dates} labels={nw.dates.map(monthShort)} series={nwSeries} line={nw.netWorth} lineName="Net worth" height={240} />
		</div>
		<TableFrame class="mt-4">
			<table class="data-table auto sticky-first" use:scrolledEdge>
				<thead>
					<tr>
						<th>Class</th>
						{#each nw.dates as d (d)}<th class="num">{monthShort(d)}</th>{/each}
					</tr>
				</thead>
				<tbody>
					{#each nw.classes as c (c.type)}
						<tr>
							<td class="truncate">
								<span class="inline-flex items-center gap-2"
									><span class="size-2.5 flex-none rounded-full" style="background: {nwSeries.find((s) => s.name === sectionLabel(c.type))?.color}" aria-hidden="true"></span>{sectionLabel(c.type)}</span
								>
							</td>
							{#each c.values as v, i (i)}<td class="num {levelToneClass(v)}">{m.money(v, { compact: true })}</td>{/each}
						</tr>
					{/each}
					<tr class="font-semibold">
						<td>Net worth</td>
						{#each nw.netWorth as v, i (i)}<td class="num {levelToneClass(v)}">{m.money(v, { compact: true })}</td>{/each}
					</tr>
					<!-- D3 RD7: month-on-month change (YNAB's itemised change). -->
					<tr>
						<td class="text-text-muted">Change</td>
						{#each nw.netWorth as v, i (i)}
							<td class="num {i === 0 ? 'text-text-muted' : toneClass(v - (nw.netWorth[i - 1] ?? 0))}"
								>{i === 0 ? '–' : m.signedMoney(v - (nw.netWorth[i - 1] ?? 0), { compact: true })}</td
							>
						{/each}
					</tr>
				</tbody>
			</table>
		</TableFrame>
	{/if}
{/if}
{/if}

{#snippet drillList(name: string, transactions: ReportTransaction[], closeHref: string)}
	<div id="report-drill" tabindex="-1" class="scroll-mt-4 outline-none">
	<Section title={`${name}: transactions`}>
		{#snippet actions()}<a href={closeHref} class="text-body text-brand-ink hover:underline">Close</a>{/snippet}
		{#if transactions.length === 0}
			<p class="text-body text-text-muted">No transactions in this period.</p>
		{:else}
			<TableFrame>
				<table class="data-table dense" use:rowLink>
					<thead><tr><th class="w-24">Date</th><th>Payee</th><th>Account</th><th class="num w-36">Amount</th></tr></thead>
					<tbody>
						{#each transactions as t (t.id)}
							<tr>
								<td class="date text-text-muted">{formatDateShort(t.date, data.todayIso)}</td>
								<td class="truncate"><a href={`/accounts/${t.accountId}?tx=${t.id}`} class="hover:underline">{t.payeeName ?? t.categoryName ?? t.accountName}</a></td>
								<td class="truncate text-text-muted">{t.accountName}{#if t.shareBp !== null}<span class="ml-2">Your share {formatShare(t.shareBp)}</span>{/if}</td>
								<td class="num {flowToneClass(t.amountPaise)}">{m.money(t.amountPaise, { currency: t.currency })}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</TableFrame>
		{/if}
	</Section>
	</div>
{/snippet}

{#snippet RateNeededNudge(currencies: string[])}
	<p class="mt-2 text-caption text-warn">
		No rate for {currencies.join(', ')}, so this report leaves {currencies.length === 1 ? 'it' : 'them'} out.
		<a href={`/settings?currency=${currencies[0]}`} class="ml-1 font-semibold hover:underline">Set rate</a>
	</p>
{/snippet}
