<!--
	ImportCard (F4): Settings' Import card. "From Actual Budget" opens the zip Actual's
	Export data saves; the preview lists every Actual account with a tick, what it is in Actual, its
	rows, an Add as list (the Add account entries), how plain deposits count on a holding (choice 4
	I-C), Invested and Value; a group used on transfers into holdings gets its kind; a name clash is
	editable. Nothing is written until Import. The card then lists the import with Undo import.
	The file is sent twice (preview, then import with the choices), so nothing is held on the server.
	With `button`, only the "Import from Actual" button shows (the empty dashboard): the same
	file pick and preview, posting to Settings' actions.
-->
<script lang="ts">
	import { deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { useMoney } from '$lib/format-context';
	import { formatDate } from '$lib/dates';
	import { FileArchive, Info, RotateCcw } from '@lucide/svelte';
	import { transferCounts } from '$lib/import-counts';
	import { epsOfOptions, parseEpsOf, sharedEpsOf, unresolvedAddAs } from '$lib/import-eps';
	import type { ImportPreview, AddAsOption, DepositsAre } from '$lib/server/import/actual-import';

	type LogEntry = {
		id: string;
		createdAt: string;
		fileName: string;
		accounts: number;
		transactions: number;
		categories: number;
		payees: number;
		canUndo: boolean;
		undo: { refusal: string | null; typedSince: number } | null;
	};
	type Choice = { include: boolean; addAs: string; name: string; deposits: DepositsAre };

	let {
		imports = [],
		rowCls = '',
		undoError,
		button = false
	}: {
		imports?: LogEntry[];
		rowCls?: string;
		undoError?: string | null;
		/** The empty dashboard's "Import from Actual": the same file pick and preview,
		 *  one button in place of the Settings card. */
		button?: boolean;
	} = $props();

	const fmt = useMoney();
	let fileInput = $state<HTMLInputElement | null>(null);
	let file = $state<File | null>(null);
	let preview = $state<ImportPreview | null>(null);
	let fileName = $state('');
	let choices = $state<Record<string, Choice>>({});
	let groupKinds = $state<Record<string, 'spending' | 'investments'>>({});
	let open = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let done = $state<string | null>(null);
	let undoing = $state<LogEntry | null>(null);

	/** The Add account list, with an "EPS of" entry after EPF for each EPF there will be (F4 RD9). */
	const allOptions = $derived.by(() => {
		if (!preview) return [];
		const eps = epsOfOptions(preview, choices);
		const at = preview.options.findIndex((o) => o.type === 'epf') + 1;
		return at > 0 ? [...preview.options.slice(0, at), ...eps, ...preview.options.slice(at)] : [...preview.options, ...eps];
	});
	const options = $derived(new Map(allOptions.map((o) => [o.key, o])));
	const optionGroups = $derived(
		[...new Set(allOptions.map((o) => o.group))].map((g) => ({
			group: g,
			items: allOptions.filter((o) => o.group === g)
		}))
	);

	/** The server's name rule (names.ts): one per owner and type, compared trimmed, spaced and lower-cased. */
	const norm = (s: string) => s.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();

	function clash(id: string): boolean {
		const a = preview?.accounts.find((x) => x.actualId === id);
		const c = choices[id];
		if (!a || !c || !c.include || a.existing || parseEpsOf(c.addAs)) return false;
		const type = options.get(c.addAs)?.type ?? '';
		const name = norm(c.name);
		if (name === '' || (preview?.takenNames[type] ?? []).includes(name)) return true;
		return (preview?.accounts ?? []).some(
			(b) => b.actualId !== id && !b.existing && choices[b.actualId]?.include && options.get(choices[b.actualId]!.addAs)?.type === type && norm(choices[b.actualId]!.name) === name
		);
	}

	const ticked = $derived((preview?.accounts ?? []).filter((a) => choices[a.actualId]?.include));
	const rowsToAdd = $derived(ticked.reduce((s, a) => s + a.rows, 0));
	const tickedIds = $derived(new Set(ticked.map((a) => a.actualId)));
	const transfers = $derived(transferCounts(preview?.accounts ?? [], tickedIds));
	const transferPairs = $derived(transfers.pairs);
	const payeeCount = $derived(new Set(ticked.flatMap((a) => a.payeeIds)).size);
	const splitCount = $derived(new Set(ticked.flatMap((a) => a.splitIds)).size);
	const clashes = $derived(ticked.filter((a) => clash(a.actualId)).length);
	const unresolved = $derived(preview ? unresolvedAddAs(preview, choices).length : 0);
	const sharedEps = $derived(preview ? sharedEpsOf(preview, choices).length : 0);
	const blocked = $derived(clashes > 0 || unresolved > 0 || sharedEps > 0 || rowsToAdd + ticked.filter((a) => !a.existing).length === 0);
	/** Why Import is greyed, said beside it (U5): a greyed button with no reason reads as broken. */
	const blockedReason = $derived(
		clashes > 0
			? `Rename the ${clashes === 1 ? 'account' : `${clashes} accounts`} marked in red to import`
			: unresolved > 0
				? `Choose what ${unresolved === 1 ? '1 account is' : `${unresolved} accounts are`} added as`
				: sharedEps > 0
					? 'Each EPS takes one account from Actual'
					: blocked
				? 'Tick an account with rows to import'
				: null
	);

	const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
	const list = (names: readonly string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

	async function post(action: string, body: FormData) {
		const res = await fetch(`/settings?/${action}`, { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
		return deserialize(await res.text());
	}

	async function openFile() {
		const f = fileInput?.files?.[0];
		if (!f) return;
		error = null;
		done = null;
		busy = true;
		const body = new FormData();
		body.set('file', f);
		const result = await post('importPreview', body);
		busy = false;
		if (fileInput) fileInput.value = '';
		if (result.type === 'success' && result.data?.importPreview) {
			file = f;
			preview = result.data.importPreview as ImportPreview;
			fileName = String(result.data.importFileName ?? f.name);
			const p = preview;
			const opts = new Map(p.options.map((o) => [o.key, o]));
			const moneyIn = (key: string) => (parseEpsOf(key) ? p.epsOption : opts.get(key))?.depositsMoneyIn;
			choices = Object.fromEntries(
				p.accounts.map((a) => [
					a.actualId,
					{ include: !a.startsAfterToday, addAs: a.addAs, name: a.existing?.name ?? a.name, deposits: moneyIn(a.addAs) ? 'moneyIn' : 'return' }
				])
			);
			groupKinds = Object.fromEntries(p.transferGroups.map((g) => [g.actualId, g.defaultKind]));
			open = true;
		} else if (result.type === 'failure') {
			error = String(result.data?.importError ?? 'This file could not be read.');
		} else {
			error = 'This file could not be read.';
		}
	}

	// How far the import has got, read every half second while it runs (it runs in slices,
	// so the server answers meanwhile).
	let progress = $state<{ done: number; total: number } | null>(null);
	async function runImport() {
		if (!file || blocked) return;
		busy = true;
		error = null;
		progress = null;
		const body = new FormData();
		body.set('file', file);
		body.set('choices', JSON.stringify({ accounts: choices, groupKinds }));
		const poll = setInterval(async () => {
			try {
				const res = await fetch('/settings/import-progress');
				const p = res.ok ? ((await res.json()) as { done: number; total: number } | null) : null;
				if (busy && p) progress = p;
			} catch {
				// The bar keeps its last figure; the import's own answer still comes.
			}
		}, 500);
		const result = await post('importRun', body).finally(() => clearInterval(poll));
		busy = false;
		progress = null;
		if (result.type === 'success' && result.data?.imported) {
			const r = result.data.imported as { accounts: number; transactions: number };
			open = false;
			preview = null;
			file = null;
			await invalidateAll();
			done = `Imported ${plural(r.transactions, 'transaction')}${r.accounts > 0 ? ` into ${plural(r.accounts, 'new account')}` : ''}.`;
		} else if (result.type === 'failure') {
			error = String(result.data?.importError ?? 'The import did not run.');
		} else {
			error = 'The import did not run.';
		}
	}

	function onAddAs(id: string, key: string) {
		const c = choices[id];
		if (!c) return;
		c.addAs = key;
		c.deposits = options.get(key)?.depositsMoneyIn ? 'moneyIn' : 'return';
	}

	const depositLabel = (d: DepositsAre) => (d === 'moneyIn' ? 'Money put in' : 'Return');
	const optionLabel = (o: AddAsOption | undefined) => o?.label ?? 'Choose';
</script>

{#snippet chooser(label: string)}
	<input bind:this={fileInput} type="file" accept=".zip,application/zip" class="sr-only" tabindex="-1" aria-hidden="true" onchange={openFile} />
	<Button variant="outline" disabled={busy} onclick={() => fileInput?.click()}>
		<FileArchive aria-hidden="true" />{busy && !open ? 'Reading…' : label}
	</Button>
{/snippet}

{#if button}
	{@render chooser('Import from Actual')}
	{#if error && !open}<StatusBar intent="error" trigger={error} class="basis-full">{error}</StatusBar>{/if}
{:else}
<Card.Root class="mt-3">
	<Card.Header class="flex-row items-center justify-between">
		<Card.Title class="text-body">Import</Card.Title>
		<span class="text-caption text-text-muted">Only you</span>
	</Card.Header>
	<Card.Content>
		<div class={rowCls}>
			<div class="min-w-0">
				<div class="text-body">From Actual Budget</div>
				<div class="text-caption text-text-muted">In Actual: Settings, Export data. Open the zip it saves.</div>
			</div>
			{@render chooser('Choose file')}
		</div>
		{#if error && !open}<StatusBar intent="error" trigger={error} class="mt-2">{error}</StatusBar>{/if}
		{#if done}<StatusBar trigger={done} class="mt-2">{done}</StatusBar>{/if}
		{#if undoError}<StatusBar intent="error" trigger={undoError} class="mt-2">{undoError}</StatusBar>{/if}

		{#each imports as imp (imp.id)}
			<div class={rowCls}>
				<div class="min-w-0">
					<div class="text-body [overflow-wrap:anywhere]">Imported {formatDate(imp.createdAt.slice(0, 10))} from {imp.fileName}</div>
					<div class="text-caption text-text-muted">
						{plural(imp.accounts, 'account')}, {plural(imp.transactions, 'transaction')}, {plural(imp.categories, 'category', 'categories')}, {plural(imp.payees, 'payee')}
					</div>
					{#if imp.undo?.refusal}<div class="text-caption text-warn">{imp.undo.refusal}</div>{/if}
				</div>
				{#if imp.canUndo}
					<Button variant="outline" disabled={!!imp.undo?.refusal} onclick={() => (undoing = imp)}>
						<RotateCcw aria-hidden="true" />Undo import
					</Button>
				{/if}
			</div>
		{/each}
	</Card.Content>
</Card.Root>
{/if}

{#if undoing}
	<ConfirmDialog
		bind:open={() => undoing !== null, (v) => { if (!v) undoing = null; }}
		title={`Undo the import of ${undoing.fileName}?`}
		action="/settings?/undoImport"
		fields={{ importId: undoing.id }}
		confirmLabel="Undo import"
		onDone={() => void invalidateAll()}
	>
		This removes the {plural(undoing.accounts, 'account')} it added with all their rows, and the categories and payees it made that nothing else uses.
		{#if (undoing.undo?.typedSince ?? 0) > 0}
			It also removes {plural(undoing.undo!.typedSince, 'row')} typed into those accounts since.
		{/if}
	</ConfirmDialog>
{/if}

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 sm:max-w-[min(64rem,calc(100%-2rem))]" interactOutsideBehavior="ignore">
		{#if preview}
			<Dialog.Header>
				<Dialog.Title class="text-subtitle font-semibold">Import from Actual Budget</Dialog.Title>
				<Dialog.Description class="text-body text-text-muted">
					{fileName}{#if preview.from && preview.to}, {formatDate(preview.from)} to {formatDate(preview.to)}{/if}. New accounts are made in {preview.currency}, your currency for totals. Nothing is added until you click Import.
				</Dialog.Description>
			</Dialog.Header>

			<div class="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
				<table class="data-table auto w-full max-lg:[&_:is(th,td)]:px-2">
					<thead>
						<tr>
							<th class="w-8"><span class="sr-only">Import</span></th>
							<th>Account in Actual</th>
							<th>In Actual</th>
							<th class="num">Rows</th>
							<th>Add as</th>
							<th class="w-40 whitespace-normal max-lg:w-32">Deposits typed without a transfer count as</th>
							<th class="num">Invested</th>
							<th class="num">Value</th>
						</tr>
					</thead>
					<tbody>
						{#each preview.accounts as a (a.actualId)}
							{@const c = choices[a.actualId]!}
							{@const opt = options.get(c.addAs)}
							{@const taken = clash(a.actualId)}
							<tr class={c.include ? '' : 'text-text-muted'}>
								<td>
									<Checkbox bind:checked={c.include} disabled={a.startsAfterToday} aria-label={`Import ${a.name}`} />
								</td>
								<td class="min-w-40 max-lg:min-w-32">
									{#if taken}
										<Input bind:value={c.name} aria-label={`Name for ${a.name}`} aria-invalid="true" aria-describedby={`clash-${a.actualId}`} class="h-8" />
										<div id={`clash-${a.actualId}`} class="text-caption text-neg">You have an open {opt?.label ?? 'account'} by this name. Rename it here.</div>
									{:else}
										{a.existing ? a.existing.name : c.name}
									{/if}
								</td>
								<td>
									<span class="whitespace-nowrap">{a.inActual}</span>
									{#if a.startsAfterToday}<div class="text-caption text-warn">Starts after today</div>{/if}
									{#if a.comesInOpen}<div class="text-caption text-warn">Comes in open: it has money or rows after today</div>{/if}
								</td>
								<td class="num">{a.rows.toLocaleString('en-IN')}</td>
								<td>
									{#if a.existing}
										<span class="text-text-muted">Already here{a.existing.closed ? ', closed' : ''}</span>
									{:else}
										<Select.Root type="single" value={c.addAs} onValueChange={(v) => onAddAs(a.actualId, v)} disabled={!c.include}>
											<Select.Trigger class="h-8 w-44" aria-label={`Add ${a.name} as`}>{optionLabel(opt)}</Select.Trigger>
											<Select.Content>
												{#each optionGroups as g (g.group)}
													<Select.Group>
														<Select.GroupHeading>{g.group}</Select.GroupHeading>
														{#each g.items as o (o.key)}<Select.Item value={o.key} label={o.label} />{/each}
													</Select.Group>
												{/each}
											</Select.Content>
										</Select.Root>
									{/if}
								</td>
								<td>
									{#if opt?.holding && a.plainDeposits > 0 && !a.existing}
										<Select.Root type="single" bind:value={c.deposits} disabled={!c.include}>
											<Select.Trigger class="h-8 w-36 max-lg:w-32" aria-label={`Deposits typed without a transfer on ${a.name} count as`}>{depositLabel(c.deposits)}</Select.Trigger>
											<Select.Content>
												<Select.Item value="return" label="Return" />
												<Select.Item value="moneyIn" label="Money put in" />
											</Select.Content>
										</Select.Root>
									{:else}
										<span class="text-text-muted" aria-label="None">–</span>
									{/if}
								</td>
								<td class="num">
									{#if opt?.assetHolding}{fmt.money(c.deposits === 'moneyIn' ? a.investedIfMoneyIn : a.investedIfReturn)}{/if}
								</td>
								<td class="num">{fmt.money(a.balancePaise)}</td>
							</tr>
						{/each}
					</tbody>
				</table>

				{#each preview.transferGroups as g (g.actualId)}
					<div class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1">
						<span>The group {g.name} counts as</span>
						<Select.Root type="single" bind:value={groupKinds[g.actualId]!}>
							<Select.Trigger class="h-8 w-52" aria-label={`The group ${g.name} counts as`} aria-describedby={`group-${g.actualId}`}>
								{groupKinds[g.actualId] === 'investments' ? 'Investments' : 'Spending, as in Actual'}
							</Select.Trigger>
							<Select.Content>
								<Select.Item value="spending" label="Spending, as in Actual" />
								<Select.Item value="investments" label="Investments" />
							</Select.Content>
						</Select.Root>
						<span id={`group-${g.actualId}`} class="basis-full text-caption text-text-muted">It is on transfers into {list(g.holdings)}.</span>
					</div>
				{/each}

				<p class="mt-3 flex gap-2 text-caption text-text-muted">
					<Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
					<span>Money put in counts as Invested (EPF's under Salary). Return counts as growth.</span>
				</p>

				<!-- U4: each fact on its own short line, under what comes in and what is left out. -->
				<div class="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
					<section aria-labelledby="import-in">
						<h3 id="import-in" class="text-body font-semibold">What comes in</h3>
						<ul class="mt-2 flex flex-col gap-1 text-body text-text-muted">
							<li>{plural(preview.categories, 'category', 'categories')} in {plural(preview.groups, 'group')}. Names already here are reused.</li>
							{#if preview.hiddenCategories > 0}<li>Hidden categories stay hidden.</li>{/if}
							<li>{plural(payeeCount, 'payee')}.</li>
							<li>{plural(transferPairs, 'transfer')}, each kept as a linked pair.</li>
							{#if splitCount > 0}<li>{plural(splitCount, 'split')}, each added as its parts.</li>{/if}
							{#if transfers.leftOut > 0}
								<li>{plural(transfers.leftOut, 'transfer')} to accounts left out or closed here, one row each.</li>
								<li>Those go under Transfer to Self, which reports leave out, unless they have a category in Actual.</li>
							{/if}
							{#if preview.alreadyHere}<li>Accounts already here get only their new rows.</li>{/if}
						</ul>
					</section>
					<section aria-labelledby="import-out">
						<h3 id="import-out" class="text-body font-semibold">What is left out</h3>
						<ul class="mt-2 flex flex-col gap-1 text-body text-text-muted">
							<li>Budgets, rules and schedules.</li>
							<li>Cleared and reconciled marks.</li>
							{#if preview.deletedRows > 0}<li>{plural(preview.deletedRows, 'deleted row')}.</li>{/if}
							{#if preview.alreadyHere}<li>Changes in Actual to rows imported before.</li>{/if}
						</ul>
					</section>
				</div>
			</div>

			{#if error}<StatusBar intent="error" trigger={error}>{error}</StatusBar>{/if}
			<Dialog.Footer class="items-center sm:justify-between">
				<span class="text-caption text-text-muted">You can undo the whole import from Settings.</span>
				<div class="flex items-center gap-2">
					{#if blockedReason}<span id="import-blocked" class="text-caption {clashes > 0 ? 'text-neg' : 'text-text-muted'}">{blockedReason}</span>{/if}
					<Button disabled={busy || blocked} onclick={runImport} aria-describedby={blockedReason ? 'import-blocked' : undefined}>
						{busy ? (progress ? `Importing ${fmt.count(progress.done)} of ${fmt.count(progress.total)}` : 'Importing…') : `Import ${plural(rowsToAdd, 'transaction')}`}
					</Button>
					<Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
				</div>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
