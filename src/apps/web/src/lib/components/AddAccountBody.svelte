<!--
	The Add account dialog (F1 RD12, Q16 A; AUDIT-S4 F8), app-wide: the types on
	the left (in two columns since the launch list, S1 RD14: 14 entries no longer fit 720 px in one),
	the form on the right, Name focused, the "As of" date today. It posts to All
	accounts' `create` action from any page and, on success, opens the new account's register
	(Actual and YNAB do the same), so the first transaction is the next thing in view.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { currencySymbol, SUPPORTED_CURRENCIES } from '$lib/currencies';
	import { FOLDED_GROUPS, creatableProfiles, profileEntries, profilesByGroup } from '$lib/modules';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { focusFirstInvalid, followOtherResult } from '$lib/forms';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { TEXT_LIMITS } from '$lib/text-limits';
	import DateField from '$lib/components/DateField.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import AccountDetailsFields from '$lib/components/AccountDetailsFields.svelte';

	let { request }: { request: { type: string | null; seq: number } | null } = $props();

	const profiles = creatableProfiles();
	// Each entry is a type under one of its names (S5 RD15: "Home loan" and "Other loan" are both
	// the Loan module, the first presetting its Kind); `key` tells two entries of one type apart.
	type Entry = { key: string; type: string; label: string; preset: Readonly<Record<string, string>> };
	const creatableGroups = profilesByGroup()
		.map((g) => ({
			group: g.group,
			entries: g.profiles
				.filter((p) => !p.comingSoon)
				.flatMap((p) => profileEntries(p).map((e): Entry => ({ key: `${p.type}:${e.label}`, type: p.type, ...e })))
		}))
		.filter((g) => g.entries.length > 0);
	// Two columns, S1's group order down the first then the second (Spending, Deposits, Loans |
	// Investments, Property, Other): the first half of the open groups by count. A folded group
	// (India, O31 option A) goes last, under Other, so opening it moves nothing else.
	const openGroups = creatableGroups.filter((g) => !FOLDED_GROUPS[g.group]);
	const half = Math.ceil(openGroups.length / 2);
	const columns = [openGroups.slice(0, half), [...openGroups.slice(half), ...creatableGroups.filter((g) => FOLDED_GROUPS[g.group])]];
	const allEntries = creatableGroups.flatMap((g) => g.entries);
	const comingSoon = profilesByGroup().flatMap((g) => g.profiles.filter((p) => p.comingSoon)).map((p) => p.label);
	// Folded groups the person opened (one click on the row); one holding the picked entry shows open.
	let unfolded = $state<Record<string, boolean>>({});
	const groupOf = (key: string) => creatableGroups.find((g) => g.entries.some((e) => e.key === key))?.group;

	let open = $state(false);
	let selectedKey = $state(allEntries[0]?.key ?? 'bank:Bank account');
	const entry = $derived(allEntries.find((e) => e.key === selectedKey) ?? allEntries[0]);
	const selectedType = $derived(entry?.type ?? 'bank');
	let amount = $state('');
	// MC1: the account's currency opens on the instance's base (the setup choice).
	const base = $derived(page.data.baseCurrency ?? 'INR');
	let currency = $state(untrack(() => page.data.baseCurrency ?? 'INR'));
	let errors = $state<Record<string, string>>({});
	let submitting = $state(false);
	let nameInput = $state<HTMLInputElement | null>(null);
	let formEl = $state<HTMLFormElement | null>(null);

	const profile = $derived(profiles.find((p) => p.type === selectedType) ?? profiles[0]);
	// An Indian scheme (PPF, EPF, SGB) is always in rupees, whatever the base: shown fixed, no picker.
	const fixedCcy = $derived(profile?.currency ?? null);
	// Amount labels name the chosen currency, e.g. "Opening balance (€)" (CP-05).
	const withCcy = (label: string) => `${label} (${currencySymbol(fixedCcy ?? currency).trim()})`;
	// A start date is needed once a non-zero opening amount is entered; it defaults to today (Q16 A).
	const needsDate = $derived(amount.trim() !== '' && Number(amount) !== 0);
	function today(): string {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}
	let todayIso = $state(today());

	// Each request is a fresh object: open, fresh, on the asked type (a section's Add account).
	$effect(() => {
		const r = request;
		if (!r) return;
		// A section's Add account opens on that type's first entry (Loans: Home loan).
		selectedKey = (allEntries.find((e) => e.type === r.type) ?? allEntries[0])?.key ?? 'bank:Bank account';
		// Folded each time it opens, unless it opens on a type inside (a PPF section's Add account).
		const g = groupOf(selectedKey);
		unfolded = g && FOLDED_GROUPS[g] ? { [g]: true } : {};
		amount = '';
		currency = base;
		errors = {};
		todayIso = today();
		open = true;
	});

	async function pickEntry(key: string) {
		selectedKey = key;
		await tick();
		nameInput?.focus(); // F1 RD12: Name takes focus once a type is picked
	}

	const labelCls = 'text-caption font-normal text-text-muted';
	const errCls = 'text-caption text-neg';
	const fieldCls = 'flex flex-col gap-1';
	const inv = (key: string) =>
		errors[key] ? { 'aria-invalid': 'true' as const, 'aria-describedby': `err-${key}` } : {};
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="sm:max-w-[58rem]"
		onOpenAutoFocus={(e) => {
			e.preventDefault();
			nameInput?.focus();
		}}
	>
		<Dialog.Header>
			<Dialog.Title class="text-subtitle font-semibold">Add account</Dialog.Title>
		</Dialog.Header>
		<form
			bind:this={formEl}
			method="POST"
			action="/accounts?/create"
			use:enhance={() => {
				submitting = true;
				return async ({ result }) => {
					submitting = false;
					if (result.type === 'success') {
						const id = (result.data as { accountId?: string } | undefined)?.accountId;
						open = false;
						// Reload the layout too, or the sidebar and net worth miss the new account until a full load.
						if (id) await goto(`/accounts/${id}`, { invalidateAll: true });
						else await invalidateAll();
					} else if (result.type === 'failure') {
						errors = (result.data as { errors?: Record<string, string> } | undefined)?.errors ?? {};
						await tick();
						if (formEl) focusFirstInvalid(formEl, errors);
					} else {
						// H1: a redirect (the session ended) goes to sign-in, an error shows the line.
						await followOtherResult(result, {
							here: page.url,
							navigate: (to) => {
								open = false;
								return goto(to);
							},
							showError: (message) => (errors = { _: message }),
							message: 'Could not create the account. Try again.'
						});
					}
				};
			}}
			class="flex gap-6"
		>
			<!-- The types (F1 RD12: the list on the left), in two columns (S1 RD14). -->
			<div class="flex w-[25rem] flex-none gap-3" role="group" aria-labelledby="acc-type-label">
				<span id="acc-type-label" class="sr-only">What to track</span>
				{#each columns as col, ci (ci)}
					<div class="flex min-w-0 flex-1 flex-col gap-3">
						{#each col as grp (grp.group)}
							{@const hint = FOLDED_GROUPS[grp.group]}
							{@const shown = !hint || unfolded[grp.group] === true}
							<div>
								{#if hint}
									<!-- O31: folded, the whole row opens it (a consumer accordion), named by what's inside. -->
									<button
										type="button"
										aria-expanded={shown}
										onclick={() => (unfolded = { ...unfolded, [grp.group]: !shown })}
										class="flex h-8 w-full items-center gap-1 rounded-control px-1 text-left hover:bg-control-hover"
									>
										{#if shown}<ChevronDown class="size-4 flex-none text-text-muted" aria-hidden="true" />{:else}<ChevronRight
												class="size-4 flex-none text-text-muted"
												aria-hidden="true"
											/>{/if}
										<span class="text-body">{grp.group}</span>
										{#if !shown}<span class="ml-2 min-w-0 truncate text-caption text-text-muted">{hint}</span>{/if}
									</button>
								{:else}
									<p class="mb-1 {labelCls}">{grp.group}</p>
								{/if}
								{#each shown ? grp.entries : [] as e (e.key)}
									<button
										type="button"
										onclick={() => pickEntry(e.key)}
										aria-pressed={selectedKey === e.key}
										class="flex h-8 w-full items-center rounded-control px-2 text-left text-body {selectedKey === e.key
											? 'bg-control-hover font-semibold'
											: 'hover:bg-control-hover'}">{e.label}</button
									>
								{/each}
							</div>
						{/each}
						{#if ci === columns.length - 1 && comingSoon.length > 0}
							<p class="text-caption text-text-muted">{comingSoon.join(', ')}: add as Other asset for now.</p>
						{/if}
					</div>
				{/each}
				<input type="hidden" name="type" value={selectedType} />
			</div>

			<!-- The form (on the right). -->
			<div class="flex min-w-0 flex-1 flex-col gap-3">
				{#if profile}<p class="text-caption text-text-muted">{profile.description}</p>{/if}
				<div class={fieldCls}>
					<label for="acc-name" class={labelCls}>Name</label>
					<Input id="acc-name" name="name" required maxlength={TEXT_LIMITS.name} bind:ref={nameInput} placeholder="e.g. HDFC savings" class="w-full" {...inv('name')} />
					{#if errors.name}<span id="err-name" class={errCls}>{errors.name}</span>{/if}
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div class={fieldCls}>
						{#if fixedCcy}
							<span class={labelCls}>Currency</span>
							<input type="hidden" name="currency" value={fixedCcy} />
							<p class="flex h-8 items-center text-body">{fixedCcy}</p>
						{:else}
						<label for="acc-currency" class={labelCls}>Currency</label>
						<!-- MC1: chosen once, at creation; the base currency by default. -->
						<Select.Root type="single" name="currency" bind:value={currency}>
							<Select.Trigger id="acc-currency" class="w-full" {...inv('currency')}>{currency}</Select.Trigger>
							<Select.Content>
								{#each SUPPORTED_CURRENCIES as code (code)}<Select.Item value={code} label={code} />{/each}
							</Select.Content>
						</Select.Root>
						{/if}
						{#if errors.currency}<span id="err-currency" class={errCls}>{errors.currency}</span>{/if}
					</div>
					{#if profile?.onboarding === 'investedValue'}
						<div class={fieldCls}>
							<label for="acc-invested" class={labelCls}>{withCcy(profile.openingLabel)}</label>
							<Input id="acc-invested" name="invested" bind:value={amount} inputmode="decimal" placeholder="What you put in" class="num w-full" {...inv('invested')} />
							{#if errors.invested}<span id="err-invested" class={errCls}>{errors.invested}</span>{/if}
						</div>
						<div class={fieldCls}>
							<label for="acc-current" class={labelCls}>{withCcy('Current value')} (optional)</label>
							<Input id="acc-current" name="currentValue" inputmode="decimal" placeholder="What it's worth now" class="num w-full" {...inv('currentValue')} />
							{#if errors.currentValue}<span id="err-currentValue" class={errCls}>{errors.currentValue}</span>{/if}
						</div>
						{#if profile.child}
							<!-- S5 RD16: an EPF's EPS is made with it; its opening is what the passbook's pension column adds to. -->
							<div class={fieldCls}>
								<label for="acc-child" class={labelCls}>{withCcy(profile.child.openingLabel)} (optional)</label>
								<Input id="acc-child" name="childOpening" inputmode="decimal" placeholder="The passbook’s pension column" class="num w-full" {...inv('childOpening')} />
								{#if errors.childOpening}<span id="err-childOpening" class={errCls}>{errors.childOpening}</span>{/if}
							</div>
						{/if}
					{:else if profile?.onboarding === 'cardOutstanding' || profile?.onboarding === 'loanOutstanding'}
						<div class={fieldCls}>
							<label for="acc-outstanding" class={labelCls}>{withCcy(profile.openingLabel)}</label>
							<Input id="acc-outstanding" name="outstanding" bind:value={amount} inputmode="decimal" placeholder="Amount owed, minus if in credit" class="num w-full" {...inv('outstanding')} />
							{#if errors.outstanding}<span id="err-outstanding" class={errCls}>{errors.outstanding}</span>{/if}
						</div>
					{:else}
						<div class={fieldCls}>
							<label for="acc-opening" class={labelCls}>{withCcy(profile?.openingLabel ?? 'Opening balance')}</label>
							<Input id="acc-opening" name="opening" bind:value={amount} inputmode="decimal" placeholder="0.00" class="num w-full" {...inv('opening')} />
							{#if errors.opening}<span id="err-opening" class={errCls}>{errors.opening}</span>{/if}
						</div>
					{/if}
					{#if needsDate}
						<div class={fieldCls}>
							<label for="acc-date" class={labelCls}>As of</label>
							<DateField id="acc-date" name="openingDate" value={todayIso} required class="w-full" aria-invalid={errors.openingDate ? 'true' : undefined} aria-describedby={errors.openingDate ? 'err-openingDate' : undefined} />
							{#if errors.openingDate}<span id="err-openingDate" class={errCls}>{errors.openingDate}</span>{/if}
						</div>
					{/if}
				</div>

				<!-- Keyed by entry, so switching starts its own fields, with the entry's preset (Home loan's Kind). -->
				{#key selectedKey}
					<AccountDetailsFields fields={profile?.infoFields ?? []} values={{ ...entry?.preset }} {errors} {withCcy} />
				{/key}

				{#if errors._}<StatusBar intent="error" trigger={errors}>{errors._}</StatusBar>{/if}
				{#if errors.type}<span id="err-type" class={errCls}>{errors.type}</span>{/if}
				<div class="mt-2 flex justify-end gap-2">
					<Button type="submit" disabled={submitting}>Add account</Button>
					<Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
				</div>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
