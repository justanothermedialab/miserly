<!--
	Fluent ToggleSwitch for a toolbar: the switch, then its label, in one clickable row. The one
	pattern for an on/off view setting on a page (Group by payee, Show hidden, Shared accounts only);
	a Subtle button with aria-pressed drew as bare bold text with no visible state.
-->
<script lang="ts">
	import { Switch } from '$lib/components/ui/switch';

	let {
		label,
		checked = false,
		onCheckedChange,
		class: className = ''
	}: { label: string; checked?: boolean; onCheckedChange: (v: boolean) => void; class?: string } = $props();
</script>

<label class="flex min-h-8 cursor-pointer items-center gap-2 text-body {className}">
	<Switch {checked} {onCheckedChange} />
	{label}
</label>
