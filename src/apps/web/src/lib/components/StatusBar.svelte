<!--
	StatusBar — the one feedback component (Fluent 2 MessageBar / InfoBar; DL-08 FL-07).
	Tinted fill + stroke + icon, rounded-overlay, placed NEXT TO the action that caused it.
	Success auto-dismisses after ~5s (paused while hovered or focused); errors/warnings
	persist until dismissed. An optional `action` snippet carries Undo.
	Re-show it on a new result by changing `trigger` (e.g. pass the `form` object).
-->
<script lang="ts">
	import { foldIn, foldOut } from '$lib/motion';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { untrack, type Snippet } from 'svelte';
	import { CircleCheck, CircleAlert, Info, TriangleAlert, X } from '@lucide/svelte';
	import { cn } from '$lib/utils';

	type Intent = 'success' | 'error' | 'info' | 'warning';
	let {
		intent = 'success',
		trigger = undefined,
		autoDismiss = intent === 'success',
		dismissible = true,
		class: className = '',
		children,
		action,
		ondismiss
	}: {
		intent?: Intent;
		trigger?: unknown;
		autoDismiss?: boolean;
		dismissible?: boolean;
		class?: string;
		children: Snippet;
		action?: Snippet;
		/** Called when the person closes it with the X (a notice the server must forget). */
		ondismiss?: () => void;
	} = $props();

	let visible = $state(true);
	let paused = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function arm() {
		clearTimeout(timer);
		if (autoDismiss && !paused) timer = setTimeout(() => (visible = false), 5000);
	}
	// Re-show only when `trigger` changes. arm() reads `paused`; tracking it here made every
	// hover/focus change re-run the effect and undo a dismiss.
	$effect(() => {
		void trigger;
		untrack(() => {
			visible = true;
			arm();
		});
		return () => clearTimeout(timer);
	});
	function pause() {
		paused = true;
		clearTimeout(timer);
	}
	function resume() {
		paused = false;
		arm();
	}
	// Hover pauses only on a REAL pointer movement over the message: a message that appears
	// under a pointer resting where the user just clicked (e.g. a toolbar button the message
	// replaced) would otherwise never auto-dismiss (hunt H-msg-A). Browsers send synthetic
	// enter/move events after layout changes; those carry no movement.
	function onMove(e: PointerEvent) {
		if (!paused && (e.movementX !== 0 || e.movementY !== 0)) pause();
	}

	const tone: Record<Intent, string> = {
		success: 'border-pos/35 bg-pos-weak',
		error: 'border-neg/35 bg-neg-weak',
		warning: 'border-warn/35 bg-warn-weak',
		info: 'border-border bg-surface-2'
	};
	const iconTone: Record<Intent, string> = {
		success: 'text-pos',
		error: 'text-neg',
		warning: 'text-warn',
		info: 'text-brand-ink'
	};
</script>

{#if visible}
	<!-- It folds in and out, so a table below never jumps when it shows or
	     auto-dismisses. Global intro: it usually mounts with the block that shows it. -->
	<div
		in:foldIn|global
		out:foldOut
		role={intent === 'error' ? 'alert' : 'status'}
		aria-live={intent === 'error' ? 'assertive' : 'polite'}
		data-slot="status-bar"
		data-intent={intent}
		class={cn(
			'flex min-h-8 items-center gap-2 rounded-overlay border px-3 py-1.5 text-body text-text',
			tone[intent],
			className
		)}
		onpointermove={onMove}
		onpointerleave={() => paused && resume()}
		onfocusin={pause}
		onfocusout={resume}
	>
		<span class={cn('shrink-0', iconTone[intent])} aria-hidden="true">
			{#if intent === 'success'}<CircleCheck size={16} />
			{:else if intent === 'error'}<CircleAlert size={16} />
			{:else if intent === 'warning'}<TriangleAlert size={16} />
			{:else}<Info size={16} />{/if}
		</span>
		<span class="min-w-0 flex-1">{@render children()}</span>
		{#if action}{@render action()}{/if}
		{#if dismissible}
			<Tooltip label="Dismiss">
				{#snippet child({ props })}
					<button
						{...props}
						type="button"
						class="-mr-1 grid size-6 shrink-0 place-items-center rounded-control text-text-muted hover:bg-control-hover hover:text-text"
						aria-label="Dismiss"
						onclick={() => {
							visible = false;
							ondismiss?.();
						}}><X size={14} /></button
					>
				{/snippet}
			</Tooltip>
		{/if}
	</div>
{/if}
