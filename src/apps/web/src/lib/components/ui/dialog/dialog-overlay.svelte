<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DialogPrimitive.OverlayProps = $props();
</script>

<!-- A press on the scrim must not take focus out of the open dialog (it doesn't dismiss a
     confirm dialog). preventDefault on pointerdown keeps focus where it
     is; Bits still sees the press for light-dismiss dialogs. -->
<DialogPrimitive.Overlay
	bind:ref
	data-slot="dialog-overlay"
	onpointerdown={(e: PointerEvent) => e.preventDefault()}
	class={cn("bg-[var(--smoke)] data-open:animate-in data-open:motion-normal data-open:ease-decelerate data-closed:motion-fast data-closed:ease-linear data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 isolate z-50", className)}
	{...restProps}
/>
