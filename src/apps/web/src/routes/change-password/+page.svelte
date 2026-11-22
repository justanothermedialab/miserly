<!--
	Change password (H1): the sign-in screen's layout, a centred form
	with no sidebar or top bar, so the forced first-sign-in change (every path redirects here) and
	the voluntary one look the same. The submit is the screen's one accent; Cancel goes back when
	the change isn't forced, Sign out is the way out when it is.
-->
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
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The action returns one message; point it at the field it's about.
	const badField = $derived.by(() => {
		const m = form?.message?.toLowerCase() ?? '';
		if (m.includes('current')) return 'current';
		if (m.includes('match')) return 'confirm';
		if (m.includes('at least')) return 'new';
		return null;
	});

	// Back to where the user came from; the dashboard when the page was opened directly.
	function cancel(e: MouseEvent) {
		if (history.length > 1) {
			e.preventDefault();
			history.back();
		}
	}
</script>

<div class="grid min-h-screen place-items-center p-6">
	<div class="w-[min(400px,94vw)]">
		<!-- The splash's mark and name, in the same place: launch to sign-in,
		     nothing moves; no title-bar rule on signed-out pages. -->
		<div class="mb-4 flex flex-col items-center gap-3.5">
			<Logomark size={44} />
			<span class="text-body font-semibold tracking-[-0.01em]">Miserly</span>
		</div>
		<h1 class="mb-5 text-center text-body font-normal text-text-muted">
			{data.forced ? 'Set your own password to continue' : 'Change password'}
		</h1>

		<Card.Root class="py-0">
			<Card.Content class="p-6">
				{#if form?.message}
					<StatusBar intent="error" trigger={form} class="mb-3">{form.message}</StatusBar>
				{/if}
				<form method="POST" use:enhance={keepValues({ resetOnSuccess: false })} class="flex flex-col gap-3">
					{#if !data.forced}
						<div class="flex flex-col gap-1">
							<Label for="current">Current password</Label>
							<Input
								id="current"
								name="currentPassword"
								type="password"
								required
								autocomplete="current-password"
								class="border-border-strong"
								aria-invalid={badField === 'current' ? 'true' : undefined}
							/>
						</div>
					{/if}
					<div class="flex flex-col gap-1">
						<Label for="new">New password</Label>
						<Input
							id="new"
							name="newPassword"
							type="password"
							required
							minlength={10} maxlength={TEXT_LIMITS.password}
							autocomplete="new-password"
							aria-describedby="new-hint"
							class="border-border-strong"
							aria-invalid={badField === 'new' ? 'true' : undefined}
						/>
						<span id="new-hint" class="text-caption text-text-muted">At least 10 characters, not your username.</span>
					</div>
					<div class="flex flex-col gap-1">
						<Label for="confirm">Confirm new password</Label>
						<Input
							id="confirm"
							name="confirmPassword"
							type="password"
							required
							minlength={10} maxlength={TEXT_LIMITS.password}
							autocomplete="new-password"
							class="border-border-strong"
							aria-invalid={badField === 'confirm' ? 'true' : undefined}
						/>
					</div>
					<Button type="submit" class="mt-1 w-full">Change password</Button>
				</form>
			</Card.Content>
		</Card.Root>

		<div class="mt-4 text-center text-body">
			{#if data.forced}
				<form method="POST" action="/signout">
					<button type="submit" class="text-brand-ink hover:underline">Sign out</button>
				</form>
			{:else}
				<a href="/" onclick={cancel} class="text-brand-ink hover:underline">Cancel</a>
			{/if}
		</div>
	</div>
</div>
