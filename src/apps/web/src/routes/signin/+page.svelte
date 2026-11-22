<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Card from '$lib/components/ui/card';
	import Logomark from '$lib/components/Logomark.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { keepValues } from '$lib/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// A failed sign-in keeps the username, clears the password and puts the
	// cursor back in it (or in the username when that's empty).
	function onFailure(f: HTMLFormElement): boolean {
		const user = f.querySelector<HTMLInputElement>('#username');
		const pass = f.querySelector<HTMLInputElement>('#password');
		if (pass) pass.value = '';
		(user && user.value.trim() === '' ? user : pass)?.focus();
		return true;
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
		<p class="mb-5 text-center text-body text-text-muted">{page.url.searchParams.has('switch') ? 'Sign in as another member' : 'Sign in'}</p>

		<Card.Root class="py-0">
			<Card.Content class="p-6">
				{#if form?.message}
					<StatusBar intent="error" trigger={form} class="mb-3">{form.message}</StatusBar>
				{/if}
				<form
					method="POST"
					action={`?redirectTo=${encodeURIComponent(data.redirectTo)}`}
					use:enhance={keepValues({ resetOnSuccess: false, onFailure })}
					class="flex flex-col gap-3"
				>
					<div class="flex flex-col gap-1">
						<Label for="username">Username</Label>
						<Input id="username" name="username" required autocomplete="username" placeholder="e.g. priya" class="border-border-strong" />
					</div>
					<div class="flex flex-col gap-1">
						<Label for="password">Password</Label>
						<Input
							id="password"
							name="password"
							type="password"
							required
							autocomplete="current-password"
							aria-invalid={form?.message ? 'true' : undefined}
							class="border-border-strong"
						/>
					</div>
					<Button type="submit" class="mt-1 w-full">Sign in</Button>
				</form>

				<!-- No "set up a new instance" link: hooks only serve /signin once an admin
				     exists, so /setup would just bounce back (CP-08). One line (AUDIT-S4 F17). -->
				<p class="mt-4 text-center text-caption text-text-muted">Ask your group's admin for a login.</p>
			</Card.Content>
		</Card.Root>
	</div>
</div>
