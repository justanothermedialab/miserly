<!--
	ConfirmDialog — the one pattern for IRREVERSIBLE actions (Fluent ContentDialog;
	DL-09 FL-06). Title = the question naming the object; body leads with the
	consequence; buttons = the verb (Destructive) then Cancel, right-aligned; initial
	focus on Cancel. Confirming submits the given form action (POST) with `fields`
	as hidden inputs, through use:enhance, so the page refreshes in place.
	Reversible actions don't use this — they act immediately and offer Undo.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { enhance } from '$app/forms';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';

	let {
		open = $bindable(false),
		title,
		action,
		fields = {},
		confirmLabel,
		destructive = true,
		children,
		extra,
		onDone
	}: {
		open?: boolean;
		title: string;
		/** Form action URL, e.g. "?/delete". */
		action: string;
		fields?: Record<string, string | string[]>;
		confirmLabel: string;
		destructive?: boolean;
		children: Snippet;
		/** Fields the answer needs (e.g. where a deleted category's transactions go), in the form. */
		extra?: Snippet;
		onDone?: () => void;
	} = $props();

	let cancelBtn = $state<HTMLButtonElement | null>(null);
	let busy = $state(false);
</script>

<Dialog.Root bind:open>
	<!-- A ContentDialog for an irreversible action doesn't light-dismiss: a click on the
	     scrim must not count as an answer (hunt H-dlg-A). Esc and Cancel still close it. -->
	<Dialog.Content
		showCloseButton={false}
		interactOutsideBehavior="ignore"
		onOpenAutoFocus={(e) => {
			e.preventDefault();
			cancelBtn?.focus();
		}}
	>
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description class="text-body text-text">{@render children()}</Dialog.Description>
		</Dialog.Header>
		<form
			method="POST"
			{action}
			use:enhance={() => {
				busy = true;
				return async ({ update }) => {
					await update();
					busy = false;
					open = false;
					onDone?.();
				};
			}}
		>
			{#each Object.entries(fields) as [k, v] (k)}
				{#if Array.isArray(v)}
					{#each v as one (one)}<input type="hidden" name={k} value={one} />{/each}
				{:else}
					<input type="hidden" name={k} value={v} />
				{/if}
			{/each}
			{#if extra}<div class="mb-4">{@render extra()}</div>{/if}
			<Dialog.Footer>
				<Button
					type="submit"
					disabled={busy}
					class={destructive ? 'bg-neg text-white hover:brightness-110 dark:text-primary-foreground' : ''}
					>{confirmLabel}</Button
				>
				<Button variant="outline" bind:ref={cancelBtn} onclick={() => (open = false)}>Cancel</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
