<!--
  The one tooltip. Replaces browser `title` tooltips, which never
  show on keyboard focus and can't be styled. Fluent ToolTip behaviour: shows after a short hover
  or on keyboard focus (not on a mouse click's focus), names the keyboard shortcut when there is
  one, and enters/leaves with the Fluent motion tokens.

  Usage — the trigger is rendered by the caller through `child`, so any element or component works:
    <Tooltip label="New transaction" shortcut="T">
      {#snippet child({ props })}<Button {...props}>New transaction</Button>{/snippet}
    </Tooltip>
  The label is for sighted users; an icon-only trigger still needs its own aria-label.
-->
<script lang="ts">
	import { Tooltip } from 'bits-ui';
	import type { Snippet } from 'svelte';

	let {
		label,
		shortcut,
		side = 'bottom',
		disabled = false,
		child: trigger
	}: {
		label: string;
		shortcut?: string;
		side?: 'top' | 'right' | 'bottom' | 'left';
		disabled?: boolean;
		child: Snippet<[{ props: Record<string, unknown> }]>;
	} = $props();
</script>

<Tooltip.Provider delayDuration={500} skipDelayDuration={300}>
	<Tooltip.Root ignoreNonKeyboardFocus {disabled}>
		<Tooltip.Trigger>
			{#snippet child({ props })}{@render trigger({ props })}{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Portal>
			<Tooltip.Content
				{side}
				sideOffset={6}
				collisionPadding={8}
				class="z-60 max-w-80 rounded-control border border-border bg-popover px-2 py-1.5 text-caption text-popover-foreground shadow-[var(--shadow-pop)] data-open:animate-in data-open:fade-in-0 data-open:motion-fast data-open:ease-decelerate data-closed:animate-out data-closed:fade-out-0 data-closed:motion-faster data-closed:ease-linear"
			>
				{label}{#if shortcut}<kbd class="ml-2 font-sans text-text-muted">{shortcut}</kbd>{/if}
			</Tooltip.Content>
		</Tooltip.Portal>
	</Tooltip.Root>
</Tooltip.Provider>
