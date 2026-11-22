<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { TEXT_LIMITS } from '$lib/text-limits';
	import { Label } from '$lib/components/ui/label';
	import * as Card from '$lib/components/ui/card';
	import Logomark from '$lib/components/Logomark.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { enhance } from '$app/forms';
	import { keepValues } from '$lib/forms';
	import * as Select from '$lib/components/ui/select';
	import { BASE_CURRENCY_CHOICES, DEFAULT_BASE_CURRENCY, defaultYearStartFor } from '$lib/currencies';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// MC1 RD2 amended, R1: the currency totals are in, and the month the year starts in. April
	// follows rupees and January any other currency, until the person picks a month themselves.
	let baseCurrency = $state<string>(DEFAULT_BASE_CURRENCY);
	let yearStart = $state<string>(String(defaultYearStartFor(DEFAULT_BASE_CURRENCY)));
	let yearPicked = $state(false);
	const MONTHS: Record<string, string> = { '1': 'January', '4': 'April' };
	function pickCurrency(code: string) {
		baseCurrency = code;
		if (!yearPicked) yearStart = String(defaultYearStartFor(code));
	}

	// The action returns one message; point it at the field it's about.
	const badField = $derived.by(() => {
		const m = form?.message?.toLowerCase() ?? '';
		if (m.includes('setup code')) return 'setupCode';
		if (m.includes('username')) return 'username';
		if (m.includes('password')) return 'password';
		if (m.includes('currency')) return 'baseCurrency';
		if (m.includes('year start')) return 'yearStart';
		return null;
	});

</script>

{#snippet usernameField()}
	<div class="flex flex-col gap-1">
		<Label for="username">Username</Label>
		<Input id="username" name="username" maxlength={TEXT_LIMITS.username} required autocomplete="username" placeholder="e.g. priya" class="border-border-strong" aria-invalid={badField === 'username' ? 'true' : undefined} />
	</div>
{/snippet}
{#snippet passwordField()}
	<div class="flex flex-col gap-1">
		<Label for="password">Password</Label>
		<Input
			id="password"
			name="password"
			type="password"
			required
			minlength={10} maxlength={TEXT_LIMITS.password}
			autocomplete="new-password"
			aria-describedby="password-hint"
			aria-invalid={badField === 'password' ? 'true' : undefined}
			class="border-border-strong"
		/>
		<span id="password-hint" class="text-caption text-text-muted">At least 10 characters, not your username.</span>
	</div>
{/snippet}
{#snippet displayNameField()}
	<div class="flex flex-col gap-1">
		<Label for="displayName">Display name <span class="text-text-muted">(optional)</span></Label>
		<Input id="displayName" name="displayName" maxlength={TEXT_LIMITS.displayName} placeholder="e.g. Priya S." class="border-border-strong" />
	</div>
{/snippet}

<div class="mx-auto max-w-245 px-6 py-10">
	<div class="mb-5">
		<div class="mb-4 flex items-center gap-3 text-body font-semibold tracking-[-0.01em]">
			<Logomark size={20} />
			Miserly
		</div>
		<!-- H1 RD amended: a login first, in plain words; the group
		     name is last and optional, for the people who share the app. -->
		<h1 class="text-subtitle font-semibold tracking-[-0.02em]">Create your login</h1>
		<p class="mt-0.5 max-w-160 text-body text-text-muted">
			You'll sign in with this. If others will use this app too, you can add them later.
		</p>
	</div>

	<div class="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
		<!-- create Circle + admin login -->
		<Card.Root>
			<Card.Content class="p-6">
				{#if form?.message}
					<StatusBar intent="error" trigger={form} class="mb-3">{form.message}</StatusBar>
				{/if}
				<form method="POST" use:enhance={keepValues({ resetOnSuccess: false })} class="flex flex-col gap-3">
					{#if data.needsCode}
						<!-- H1 RD13: a hosted instance prints this code in its log at start. The code sits beside
						     Username, and Display name beside Password, so the form has the desktop's rows and
						     Create login shows without a scroll in a 630 px high window (hosted audit H4). -->
						<div class="grid grid-cols-2 gap-3">
							<div class="flex flex-col gap-1">
								<Label for="setupCode">Setup code</Label>
								<Input
									id="setupCode"
									name="setupCode"
									required
									autocomplete="off"
									spellcheck="false"
									placeholder="e.g. K7QM-2PXD-9TRA"
									aria-describedby="setup-code-hint"
									aria-invalid={badField === 'setupCode' ? 'true' : undefined}
									class="border-border-strong"
								/>
							</div>
							{@render usernameField()}
						</div>
						<!-- Where the log is on Docker, Podman and Cockpit, the line to look for, and that
						     only the latest start's code works (a stale code was the usual mistake). -->
						<p id="setup-code-hint" class="-mt-1 text-caption text-text-muted">
							It's in the server's log, on the line “miserly setup code:”. Open the log with docker logs
							or podman logs and the container's name, or in Cockpit under Podman containers. Each start
							prints a new code: use the latest.
						</p>
						<div class="grid grid-cols-2 gap-3">
							{@render passwordField()}
							{@render displayNameField()}
						</div>
					{:else}
						<div class="grid grid-cols-2 gap-3">
							{@render usernameField()}
							{@render passwordField()}
						</div>
						{@render displayNameField()}
					{/if}

					<div class="flex flex-col gap-1">
						<Label for="circleName">Group name <span class="text-text-muted">(optional)</span></Label>
						<Input id="circleName" name="circleName" maxlength={TEXT_LIMITS.displayName} placeholder="e.g. The Sharma household" class="border-border-strong" />
						<span class="text-caption text-text-muted">If others will use this app too.</span>
					</div>

					<div class="grid grid-cols-2 gap-3">
						<div class="flex flex-col gap-1">
							<Label for="baseCurrency">Currency for totals</Label>
							<Select.Root type="single" name="baseCurrency" value={baseCurrency} onValueChange={pickCurrency}>
								<Select.Trigger
									id="baseCurrency"
									class="border-border-strong w-full"
									aria-describedby="base-currency-hint"
									aria-invalid={badField === 'baseCurrency' ? 'true' : undefined}>{baseCurrency}</Select.Trigger
								>
								<Select.Content>
									{#each BASE_CURRENCY_CHOICES as code (code)}<Select.Item value={code} label={code} />{/each}
								</Select.Content>
							</Select.Root>
							<span id="base-currency-hint" class="text-caption text-text-muted">Net worth and reports add up in this. It can't be changed yet.</span>
						</div>
						<div class="flex flex-col gap-1">
							<Label for="yearStart">Year starts in</Label>
							<Select.Root
								type="single"
								name="yearStart"
								value={yearStart}
								onValueChange={(v) => {
									yearStart = v;
									yearPicked = true;
								}}
							>
								<Select.Trigger
									id="yearStart"
									class="border-border-strong w-full"
									aria-describedby="year-start-hint"
									aria-invalid={badField === 'yearStart' ? 'true' : undefined}>{MONTHS[yearStart]}</Select.Trigger
								>
								<Select.Content>
									<Select.Item value="1" label="January" />
									<Select.Item value="4" label="April" />
								</Select.Content>
							</Select.Root>
							<span id="year-start-hint" class="text-caption text-text-muted">For the year in reports.</span>
						</div>
					</div>

					<Button type="submit" class="mt-1 w-fit">Create login</Button>
				</form>
			</Card.Content>
		</Card.Root>

		<!-- what you'll do next -->
		<Card.Root class="opacity-90">
			<Card.Header>
				<Card.Title>What you'll do next</Card.Title>
			</Card.Header>
			<Card.Content>
				<ol class="ml-5 list-decimal text-body leading-[1.9] text-text-muted">
					<li>Add your first account with its current balance</li>
					<li>Log your first transaction</li>
					<li>If others use the app, add them and choose what to share</li>
				</ol>
				<p class="mt-4 text-caption leading-[1.55] text-text-muted">
					Accounts are private until you share them.
				</p>
			</Card.Content>
		</Card.Root>
	</div>
</div>
