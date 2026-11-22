<!--
  AccountMenu.svelte — you, top right of the title bar, just left of the window buttons (owner
  Microsoft's title-bar guidance puts the person picture there, as Teams, Excel, Mercury,
  Ghostfolio and Kite do). About the account only, as Teams' profile menu is: your name, login and
  group, Change password (a dialog: three fields, like Add account), Switch account, Sign out.
  Settings is in the "…" beside it (MoreMenu); Categories and Payees are places in the sidebar.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { redirectDestination } from '$lib/forms';
	import { KeyRound, LogOut, Users } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { TEXT_LIMITS } from '$lib/text-limits';
	import { Label } from '$lib/components/ui/label';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { memberColour } from '$lib/member-colour';

	type User = { username: string; displayName?: string | null; role?: string } | null;
	const user = $derived((page.data as { user?: User }).user ?? null);
	const circleName = $derived((page.data as { circleName?: string | null }).circleName ?? null);
	const name = $derived(user?.displayName ?? user?.username ?? '');
	const initials = $derived(
		(name.trim().split(/\s+/).length > 1
			? name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('')
			: name.trim().slice(0, 2)
		).toUpperCase()
	);
	let signOutForm = $state<HTMLFormElement | null>(null);
	let switchForm = $state<HTMLFormElement | null>(null);

	// Change password: the /change-password action, without leaving the page. That page stays for
	// the forced change after a reset or a first sign-in (DECISIONS-S4 D7).
	let pwOpen = $state(false);
	// Labels as every other dialog's (12 px muted; the shadcn Label is 14 px text for the signed-out pages).
	const fieldLabel = 'text-caption leading-4 text-text-muted';
	let pwMessage = $state<string | null>(null);
	let pwDone = $state(false);
	let pwBusy = $state(false);
	function openPassword() {
		pwMessage = null;
		pwDone = false;
		pwOpen = true;
	}
</script>

{#if user}
	<DropdownMenu.Root>
		<Tooltip label={name} side="bottom">
			{#snippet child({ props })}
				<DropdownMenu.Trigger
					{...props}
					class="grid size-8 shrink-0 place-items-center rounded-full hover:bg-control-hover data-[state=open]:bg-control-hover"
					aria-label="Account menu for {name}"
				>
					<span
						class="grid size-6 place-items-center rounded-full text-caption font-semibold text-white"
						style="background:{memberColour(user.username)}"
						aria-hidden="true">{initials}</span
					>
				</DropdownMenu.Trigger>
			{/snippet}
		</Tooltip>
		<DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="min-w-56">
			<DropdownMenu.Label>
				<span class="block text-body font-semibold text-foreground">
					{name}
					{#if user.role === 'admin'}
						<span class="ml-1 inline-flex items-center rounded-full border border-border bg-surface-2 px-1 py-px text-caption font-normal text-text-muted">Admin</span>
					{/if}
				</span>
				<span class="block">Signed in as {user.username}</span>
				{#if circleName}<span class="block">{circleName}</span>{/if}
			</DropdownMenu.Label>
			<DropdownMenu.Item onSelect={openPassword}>
				<KeyRound size={16} aria-hidden="true" />
				Change password
			</DropdownMenu.Item>
			<DropdownMenu.Separator />
			<DropdownMenu.Item onSelect={() => switchForm?.requestSubmit()}>
				<Users size={16} aria-hidden="true" />
				Switch account
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={() => signOutForm?.requestSubmit()}>
				<LogOut size={16} aria-hidden="true" />
				Sign out
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
	<form bind:this={signOutForm} method="POST" action="/signout" hidden></form>
	<!-- Switch account: sign out, then a clean sign-in for another member. -->
	<form bind:this={switchForm} method="POST" action="/signout?switch=1" hidden></form>

	<Dialog.Root bind:open={pwOpen}>
		<Dialog.Content class="sm:max-w-[24rem]">
			<Dialog.Header><Dialog.Title>Change password</Dialog.Title></Dialog.Header>
			{#if pwDone}
				<StatusBar intent="success" autoDismiss={false}>Password changed. Your other devices are signed out.</StatusBar>
				<div class="mt-3 flex justify-end"><Button onclick={() => (pwOpen = false)}>Close</Button></div>
			{:else}
				{#if pwMessage}
					<StatusBar intent="error" trigger={pwMessage} class="mb-3">{pwMessage}</StatusBar>
				{/if}
				<form
					method="POST"
					action="/change-password"
					class="flex flex-col gap-3"
					use:enhance={() => {
						pwBusy = true;
						return async ({ result }) => {
							pwBusy = false;
							// A redirect to sign-in means the session had ended (H1), not that the password changed.
							if (result.type === 'redirect' && new URL(result.location, page.url).pathname === '/signin') {
								pwOpen = false;
								await goto(redirectDestination(result.location, page.url));
							} else if (result.type === 'redirect' || result.type === 'success') pwDone = true;
							else if (result.type === 'failure') pwMessage = String((result.data as { message?: string } | undefined)?.message ?? 'Could not change the password');
							else pwMessage = 'Could not change the password';
						};
					}}
				>
					<div class="flex flex-col gap-1">
						<Label for="pw-current" class={fieldLabel}>Current password</Label>
						<Input id="pw-current" name="currentPassword" type="password" required autocomplete="current-password" />
					</div>
					<div class="flex flex-col gap-1">
						<Label for="pw-new" class={fieldLabel}>New password</Label>
						<Input id="pw-new" name="newPassword" type="password" required minlength={10} maxlength={TEXT_LIMITS.password} autocomplete="new-password" aria-describedby="pw-hint" />
						<span id="pw-hint" class="text-caption text-text-muted">At least 10 characters, not your username.</span>
					</div>
					<div class="flex flex-col gap-1">
						<Label for="pw-confirm" class={fieldLabel}>Confirm new password</Label>
						<Input id="pw-confirm" name="confirmPassword" type="password" required minlength={10} maxlength={TEXT_LIMITS.password} autocomplete="new-password" />
					</div>
					<div class="mt-1 flex justify-end gap-2">
						<!-- Primary first, Cancel last, as every other dialog here and Fluent's (F5). -->
						<Button type="submit" disabled={pwBusy}>Change password</Button>
						<Button type="button" variant="outline" onclick={() => (pwOpen = false)}>Cancel</Button>
					</div>
				</form>
			{/if}
		</Dialog.Content>
	</Dialog.Root>
{/if}
