<!--
	Settings (M11 SET1): each card lists its settings as rows
	(label left, control right, a hairline between), no explainer lines, page actions Standard
	(D6), card padding 12. Sections:
	  - Display: the app-wide number-format preference (Indian lakh/crore vs
	    Western thousand/million), compact or full amounts in summaries,
	    foreign-currency grouping, and theme. Each number-format
	    option shows a LIVE preview computed from the raw `$lib/format`
	    formatter (not the viewer's *current* context — a preview of what
	    picking it would look like) so the choice is never a guess.
	  - Circle (admin-only): the H1 display name for this instance.
	  - Currencies & rates (MC3, unchanged): one calm list: code · current
	    rate · "updated N days ago" · an inline edit form. Base INR sits at
	    the top as the fixed, non-editable reference (rate 1). A currency with
	    no rate reads as a helpful "rate needed" row with the SAME inline form
	    (setting it for the first time), never an error wall (MC1/MC3 "honest
	    gaps" UX). `?currency=` is the deep-link MC3 promises the dashboard's
	    "rate needed" nudge (D1/D3/D4): landing here with it pre-opens that
	    currency's edit form so the one-tap "set rate" round-trip doesn't
	    require hunting the row.
-->
<script lang="ts">
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { PageHeader } from '$lib/components/layout';
	import { formatDate } from '$lib/dates';
	import type { ActionData, PageData } from './$types';
	import { formatMoney } from '$lib/format';
	import type { NumberSystem, ForeignGrouping, Theme } from '$lib/prefs';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { TEXT_LIMITS } from '$lib/text-limits';
	import { Badge } from '$lib/components/ui/badge';
	import { Switch } from '$lib/components/ui/switch';
	import Segmented from '$lib/components/Segmented.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import ImportCard from '$lib/components/ImportCard.svelte';
	import { enhance } from '$app/forms';
	import { keepValues } from '$lib/forms';
	import { tick } from 'svelte';
	import { onMount } from 'svelte';
	import { Check, Copy, FolderOpen } from '@lucide/svelte';
	import { applyTheme, applyAccent, accentBridge } from '$lib/theme';
	import { accentTokens } from '$lib/accent';
	import type { Accent } from '$lib/prefs';
	import { usePrefsController } from '$lib/format-context';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// SET1 instant apply: the layout's live-prefs controller, driven below
	// once the display `$state` is declared.
	const prefsCtrl = usePrefsController();

	let editing = $state<string | null>(data.deepLinkCurrency);

	function ageLabel(days: number): string {
		if (days === 0) return 'Updated today';
		if (days === 1) return 'Updated yesterday';
		return `Updated ${days} days ago`;
	}

	// ── Display (SET1) ──────────────────────────────────────────────────────
	let numberSystem = $state<NumberSystem>(data.prefs.numberSystem);
	let compact = $state<boolean>(data.prefs.compact);
	let foreignGrouping = $state<ForeignGrouping>(data.prefs.foreignGrouping);
	let theme = $state<Theme>(data.prefs.theme);
	// The accent colour (SET1): instant, like the theme; the mark stays gold.
	let accent = $state<Accent>(data.prefs.accent);
	// Ink, Gold, the person's own Windows colour (desktop only: a browser can't read it), a saturated
	// Teal and Lime. Swatches show the fill each paints buttons with.
	let windowsFill = $state<string | null>(null);
	// The data file, desktop only (the shell's bridge names it; hosted has no bridge and no card).
	type DataBridge = { dataFile?: () => string; openDataFolder?: () => void };
	const dataBridge = () => (window as unknown as { miserlyDesktop?: DataBridge }).miserlyDesktop;
	let dataFile = $state('');
	let pathCopied = $state(false);
	async function copyPath() {
		try {
			await navigator.clipboard.writeText(dataFile);
			pathCopied = true;
			setTimeout(() => (pathCopied = false), 2000);
		} catch {
			pathCopied = false;
		}
	}
	onMount(() => {
		const hex = accentBridge()?.accentColor?.();
		windowsFill = hex ? (accentTokens(hex)?.fill ?? null) : null;
		dataFile = dataBridge()?.dataFile?.() ?? '';
	});
	const ACCENT_CHOICES = $derived<{ value: Accent; label: string; light: string; dark: string }[]>([
		{ value: 'ink', label: 'Ink', light: '#1f1f1f', dark: '#f0f0f0' },
		{ value: 'gold', label: 'Gold', light: '#966e00', dark: '#966e00' },
		...(windowsFill ? [{ value: 'windows' as const, label: 'Windows accent', light: windowsFill, dark: windowsFill }] : []),
		{ value: 'teal', label: 'Teal', light: '#038387', dark: '#038387' },
		{ value: 'lime', label: 'Lime', light: '#bdee63', dark: '#bdee63' }
	]);

	// Instant apply: push each display change into the layout's live prefs
	// so every figure app-wide re-renders immediately. Driven by the controls'
	// change EVENTS (not a reactive `$effect`, which — since the controller both
	// reads and writes `livePrefs` — would form an update cycle). Save still
	// persists via the POST form below.
	// One save model for the whole card — every control applies instantly AND
	// persists on change (like theme always did); there is no separate Save step.
	let displayForm = $state<HTMLFormElement | null>(null);
	async function persistDisplay() {
		await tick(); // let the hidden inputs pick up the new values
		displayForm?.requestSubmit();
	}
	const applyNumberSystem = (v: NumberSystem) => {
		prefsCtrl?.set({ numberSystem: v });
		void persistDisplay();
	};
	const applyForeignGrouping = (v: ForeignGrouping) => {
		prefsCtrl?.set({ foreignGrouping: v });
		void persistDisplay();
	};
	const applyCompact = (v: boolean) => {
		prefsCtrl?.set({ compact: v });
		void persistDisplay();
	};
	const applyThemeAndSave = (v: Theme) => {
		applyTheme(v);
		void persistDisplay();
	};

	// A representative largish amount (1,23,45,678.00 in the base currency) so both the
	// long-form grouping AND the compact abbreviation are visible in one
	// glance — the boundary right above 1 crore / 10 million.
	const PREVIEW_PAISE = 12345678_00;
	function preview(western: boolean): string {
		const currency = data.baseCurrency;
		return `${formatMoney(PREVIEW_PAISE, { western, currency })} or ${formatMoney(PREVIEW_PAISE, { western, compact: true, currency })}`;
	}
	const indianPreview = $derived(preview(false));
	const westernPreview = $derived(preview(true));
	// The short-amount switch's example, in the base and the chosen grouping (₹18.8L, $1.9M).
	const shortExample = $derived(formatMoney(18_80_000_00, { compact: true, western: numberSystem === 'western', currency: data.baseCurrency }));

	let circleName = $state<string>(data.circleName ?? '');

	// ── Members (H3, admin-only) ────────────────────────────────────────────
	let resettingId = $state<string | null>(null);
	let removingId = $state<string | null>(null);
	const removingMember = $derived(data.members.find((m) => m.id === removingId) ?? null);

	function lastActiveLabel(iso: string | null): string {
		// Under the heading Last active (C2): the date alone, or Never.
		if (!iso) return 'Never';
		return formatDate(iso);
	}

	const blockedAccounts = $derived(
		(form && 'blockedAccounts' in form ? form.blockedAccounts : undefined) as
			| { id: string; name: string }[]
			| undefined
	);

	const errCls = 'text-caption font-normal text-neg';
	// A settings row (Windows Settings): label left, control right, a hairline between rows.
	const rowCls = 'flex min-h-12 flex-wrap items-center justify-between gap-x-section gap-y-2 border-t border-divider py-2 first:border-t-0';
</script>

<PageHeader title="Settings" />

<Card.Root class="mb-3">
	<Card.Header class="flex-row items-center justify-between">
		<Card.Title class="text-body">Display</Card.Title>
		<span class="text-caption text-text-muted">Only you</span>
	</Card.Header>
	<Card.Content>
		<!-- One row per setting, label left and control right, a hairline between (Windows
		     Settings; AUDIT-S4 S15). Every control applies and saves on change. -->
		<form
			bind:this={displayForm}
			method="POST"
			action="?/setDisplay"
			use:enhance={keepValues({ resetOnSuccess: false })}
		>
			<div class={rowCls}>
				<div class="min-w-0">
					<div class="text-body">Number format</div>
					<div class="num text-caption text-text-muted">{numberSystem === 'indian' ? indianPreview : westernPreview}</div>
				</div>
				<Segmented
					options={[
						{ value: 'indian', label: 'Indian (lakh / crore)' },
						{ value: 'western', label: 'Western (thousand / million)' }
					]}
					bind:value={numberSystem}
					onChange={applyNumberSystem}
					size="sm"
					ariaLabel="Number format"
				/>
				<input type="hidden" name="numberSystem" value={numberSystem} />
			</div>

			<div class={rowCls}>
				<div class="text-body">Amounts in other currencies</div>
				<Segmented
					options={[
						{ value: 'preference', label: data.baseCurrency === 'INR' ? 'Like rupees' : `Like ${data.baseCurrency}` },
						{ value: 'native-locale', label: 'Like that currency' }
					]}
					bind:value={foreignGrouping}
					onChange={applyForeignGrouping}
					size="sm"
					ariaLabel="Amounts in other currencies"
				/>
				<input type="hidden" name="foreignGrouping" value={foreignGrouping} />
			</div>

			<div class={rowCls}>
				<div class="text-body">Theme</div>
				<Segmented
					options={[
						{ value: 'system', label: 'System' },
						{ value: 'light', label: 'Light' },
						{ value: 'dark', label: 'Dark' },
						{ value: 'black', label: 'Black' }
					]}
					bind:value={theme}
					onChange={applyThemeAndSave}
					size="sm"
					ariaLabel="Theme"
				/>
				<input type="hidden" name="theme" value={theme} />
			</div>

			<div class={rowCls}>
				<span class="min-w-0">
					<span class="block text-body" id="accent-label">Accent colour</span>
					<span class="block text-caption text-text-muted">Buttons, selection and links</span>
				</span>
				<div role="radiogroup" aria-labelledby="accent-label" class="flex items-center gap-2.5">
					{#each ACCENT_CHOICES as c (c.value)}
						<label class="relative grid size-7 cursor-pointer place-items-center rounded-full">
							<!-- The swatch's name in the one tooltip, on hover and on keyboard focus (the skill). -->
							<Tooltip label={c.label}>
								{#snippet child({ props })}
									<input {...props} type="radio" name="accent-choice" value={c.value} checked={accent === c.value}
										onchange={() => { accent = c.value; applyAccent(c.value); }}
										aria-label={c.label} class="peer absolute inset-0 m-0 cursor-pointer appearance-none rounded-full" />
								{/snippet}
							</Tooltip>
							<span aria-hidden="true"
								class="pointer-events-none size-6 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] peer-checked:shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--text)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-[var(--focus-outer)] dark:hidden"
								style="background:{c.light}"></span>
							<span aria-hidden="true"
								class="pointer-events-none hidden size-6 rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] peer-checked:shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--text)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-[var(--focus-outer)] dark:block"
								style="background:{c.dark}"></span>
						</label>
					{/each}
				</div>
			</div>

			<label class="{rowCls} cursor-pointer">
				<span class="min-w-0">
					<span class="block text-body">Short amounts ({shortExample}) in totals</span>
					<span class="block text-caption text-text-muted">In the sidebar, headlines and charts; tables keep the full amount</span>
				</span>
				<Switch bind:checked={compact} onCheckedChange={applyCompact} aria-label="Short amounts in totals" />
			</label>
			<input type="hidden" name="compact" value={compact ? 'on' : 'off'} />

			{#if form?.displayError}<StatusBar intent="error" trigger={form} class="mt-2">{form.displayError}</StatusBar>{/if}
		</form>
	</Card.Content>
</Card.Root>

{#if data.isAdmin}
	<Card.Root class="mb-3">
		<Card.Header class="flex-row items-center justify-between">
			<Card.Title class="text-body">Group</Card.Title>
			<span class="text-caption text-text-muted">Shared by everyone</span>
		</Card.Header>
		<Card.Content>
			<form
				method="POST"
				action="?/setCircleName"
				use:enhance={keepValues({ resetOnSuccess: false })}
				class={rowCls}
			>
				<div class="min-w-0">
					<label for="circle-name" class="block text-body">Group name</label>
					<div class="text-caption text-text-muted">Shown under your name in the sidebar; leave blank for none</div>
				</div>
				<div class="flex flex-wrap items-center gap-control">
					{#if form?.circleNameSaved}<StatusBar trigger={form}>Group name saved.</StatusBar>{/if}
					<Input
						id="circle-name"
						type="text"
						name="circleName"
						maxlength={TEXT_LIMITS.displayName}
						bind:value={circleName}
						placeholder="e.g. The Sharma household"
						class="w-65"
						aria-invalid={form?.circleNameError ? 'true' : undefined}
						aria-describedby={form?.circleNameError ? 'circle-name-err' : undefined}
					/>
					<Button type="submit" variant="outline">Save</Button>
				</div>
				{#if form?.circleNameError}<span id="circle-name-err" class="{errCls} basis-full text-right">{form.circleNameError}</span>{/if}
			</form>
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-3">
		<Card.Header class="flex-row items-center justify-between">
			<Card.Title class="text-body">Members</Card.Title>
			<span class="text-caption text-text-muted">Admins only</span>
		</Card.Header>
		<Card.Content>
			<div class="overflow-x-auto">
				<table class="data-table auto">
					<thead>
						<tr>
							<th>Member</th>
							<th>Role</th>
							<th>Last active</th>
							<th class="num"><span class="sr-only">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each data.members as mrow (mrow.id)}
							<tr>
								<td>{mrow.displayName} <span class="text-text-muted">@{mrow.username}</span></td>
								<td>
									<Badge variant={mrow.role === 'admin' ? 'default' : 'outline'} class="capitalize">{mrow.role}</Badge>
								</td>
								<td class="text-text-muted">{lastActiveLabel(mrow.lastActiveAt)}</td>
								<td class="num">
									{#if mrow.role !== 'admin'}
										<div class="flex flex-wrap items-center justify-end gap-control">
											{#if resettingId === mrow.id}
												<form
													method="POST"
													action="?/resetPassword"
													use:enhance={keepValues({ onSuccess: () => (resettingId = null) })}
													class="flex items-center gap-control"
												>
													<input type="hidden" name="targetUserId" value={mrow.id} />
													<Input
														type="text"
														name="tempPassword"
														placeholder="Temporary password"
														aria-label={`Temporary password for ${mrow.displayName}`}
														minlength={10} maxlength={TEXT_LIMITS.password}
														class="w-45"
													/>
													<Button type="submit" variant="outline">Save</Button>
													<Button type="button" variant="ghost" onclick={() => (resettingId = null)}>Cancel</Button>
												</form>
											{:else}
												<Button type="button" variant="outline" onclick={() => (resettingId = mrow.id)}>Reset password</Button>
											{/if}
											<Button type="button" variant="destructive" onclick={() => (removingId = mrow.id)}>Remove</Button>
										</div>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if form?.memberError}<StatusBar intent="error" trigger={form} class="mt-3">{form.memberError}</StatusBar>{/if}
			{#if blockedAccounts && blockedAccounts.length > 0}
				<StatusBar intent="error" trigger={form} class="mt-3">
					Reassign or unshare these accounts first: {blockedAccounts.map((a) => a.name).join(', ')}
				</StatusBar>
			{/if}
			{#if form?.memberAdded}<StatusBar trigger={form} class="mt-3">Member added.</StatusBar>{/if}
			{#if form?.passwordReset}<StatusBar trigger={form} class="mt-3">Password reset. They'll be asked to change it at their next sign-in.</StatusBar>{/if}
			{#if form?.memberRemoved}<StatusBar trigger={form} class="mt-3">Member removed.</StatusBar>{/if}
			{#if removingMember}
				<ConfirmDialog
					bind:open={() => removingId !== null, (v) => { if (!v) removingId = null; }}
					title={`Remove ${removingMember.displayName} from the group?`}
					action="?/removeMember"
					fields={{ targetUserId: removingMember.id }}
					confirmLabel="Remove"
				>
					They lose access to every shared account and can't sign in. Their own accounts are kept but no one can see them. This can't be undone.
				</ConfirmDialog>
			{/if}

			<h3 class="mb-2 mt-section text-body font-semibold">Add member</h3>
			<form method="POST" action="?/addMember" use:enhance={keepValues()} class="flex flex-wrap items-end gap-content">
				<div class="flex flex-col gap-1">
					<label for="add-username" class="text-caption font-normal text-text-muted">Username</label>
					<Input id="add-username" type="text" name="username" maxlength={TEXT_LIMITS.username} autocomplete="off" required placeholder="e.g. priya" class="w-40" />
				</div>
				<div class="flex flex-col gap-1">
					<label for="add-display" class="text-caption font-normal text-text-muted">Display name</label>
					<Input id="add-display" type="text" name="displayName" maxlength={TEXT_LIMITS.displayName} autocomplete="off" required class="w-40" />
				</div>
				<div class="flex flex-col gap-1">
					<label for="add-temp" class="text-caption font-normal text-text-muted">Temporary password</label>
					<Input id="add-temp" type="text" name="tempPassword" autocomplete="off" required minlength={10} maxlength={TEXT_LIMITS.password} class="w-40" />
				</div>
				<Button type="submit" variant="outline">Add member</Button>
			</form>
		</Card.Content>
	</Card.Root>
{/if}

<!-- Currencies: the base currency as a settings row (SET1 RD4's reserved slot), then the
     rates (MC3). -->
<Card.Root>
	<Card.Header class="flex-row items-center justify-between">
		<Card.Title class="text-body">Currencies</Card.Title>
		<span class="text-caption text-text-muted">Rates set by hand</span>
	</Card.Header>
	<Card.Content>
		<div class="{rowCls} mb-2">
			<div class="min-w-0">
				<div class="text-body">Currency for totals</div>
				<div class="text-caption text-text-muted">Changing it comes in a later version</div>
			</div>
			<span class="text-body font-semibold">{data.baseCurrency}</span>
		</div>
		<!-- R1: chosen at setup with the currency; PPF keeps the law's April year whatever it is. -->
		<div class="{rowCls} mb-2">
			<div class="min-w-0">
				<div class="text-body">Year starts in</div>
				<div class="text-caption text-text-muted">
					The year in reports runs {data.yearStart === 1 ? 'January to December' : 'April to March'}. Changing it comes in a later version
				</div>
			</div>
			<span class="text-body font-semibold">{data.yearStart === 1 ? 'January' : 'April'}</span>
		</div>

		<div class="overflow-x-auto">
			<table class="data-table auto">
				<thead>
					<tr>
						<th>Currency</th>
						<th class="num">1 unit = {data.baseCurrency}</th>
						<th>Status</th>
						<th class="num"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#if data.rows.length === 0}
						<tr><td colspan="4" class="px-3 py-6 text-center text-text-muted">No accounts in another currency.</td></tr>
					{/if}

					{#each data.rows as row (row.currency)}
						<tr>
							<td>{row.currency}</td>
							<td class="num">{row.rate === null ? '–' : row.rate.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')}</td>
							<td>
								{#if row.rate === null}
									<Badge variant="destructive">Rate needed</Badge>
								{:else if row.stale}
									<span class="text-caption font-semibold text-warn">{ageLabel(row.daysAgo ?? 0)}</span>
								{:else}
									<span class="text-caption text-text-muted">{ageLabel(row.daysAgo ?? 0)}</span>
								{/if}
							</td>
							<td class="num">
								{#if editing === row.currency}
									<form
										method="POST"
										action="?/setRate"
										use:enhance={keepValues({ resetOnSuccess: false, onSuccess: () => (editing = null) })}
										class="inline-flex items-center gap-control"
									>
										<input type="hidden" name="currency" value={row.currency} />
										<Input
											name="rate"
											inputmode="decimal"
											placeholder="e.g. 83.5"
											value={row.rate ?? ''}
											aria-label={`${row.currency} rate to ${data.baseCurrency}`}
											aria-invalid={form?.currency === row.currency && form?.errors?.rate ? 'true' : undefined}
											aria-describedby={form?.currency === row.currency && form?.errors?.rate ? `rate-err-${row.currency}` : undefined}
											class="num w-28"
										/>
										<Button type="submit" variant="outline">Save</Button>
										<Button type="button" variant="ghost" onclick={() => (editing = null)}>Cancel</Button>
									</form>
									{#if form?.currency === row.currency && form?.errors?.rate}
										<div id={`rate-err-${row.currency}`} class={errCls + ' mt-1 text-left'}>{form.errors.rate}</div>
									{/if}
								{:else}
									<Button type="button" variant="outline" onclick={() => (editing = row.currency)}>
										{row.rate === null ? 'Set rate' : 'Edit'}
									</Button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if form?.saved}
			<StatusBar trigger={form} class="mt-3">
				Rate saved. Every {data.baseCurrency} total now uses the new {form.currency} rate.
			</StatusBar>
		{/if}
	</Card.Content>
</Card.Root>

<!-- Import (F4): Actual Budget's export, its preview, and Undo import. -->
<ImportCard imports={data.imports} {rowCls} undoError={form && 'undoError' in form ? (form.undoError as string) : null} />

<!-- Your data ("Path should actually go to settings"): where everything
     typed lives, the file a backup copies. Last, as Actual keeps its Backups and Budget file rows. -->
{#if dataFile}
	<Card.Root class="mt-3">
		<Card.Header class="flex-row items-center justify-between">
			<Card.Title class="text-body">Your data</Card.Title>
			<span class="text-caption text-text-muted">On this computer</span>
		</Card.Header>
		<Card.Content>
			<div class={rowCls}>
				<div class="min-w-0">
					<div class="text-body">Data file</div>
					<div class="text-caption text-text-muted [overflow-wrap:anywhere]">{dataFile}</div>
				</div>
				<div class="flex gap-2">
					<Button variant="outline" onclick={copyPath}>
						{#if pathCopied}<Check aria-hidden="true" />Copied{:else}<Copy aria-hidden="true" />Copy path{/if}
					</Button>
					<Button variant="outline" onclick={() => dataBridge()?.openDataFolder?.()}>
						<FolderOpen aria-hidden="true" />Open folder
					</Button>
				</div>
				<span class="sr-only" aria-live="polite">{pathCopied ? 'Path copied' : ''}</span>
			</div>
		</Card.Content>
	</Card.Root>
{/if}
