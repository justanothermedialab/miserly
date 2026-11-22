<!--
	Figure — a headline amount with its paise raised and smaller (₹9,11,697⁰⁰), as Mercury sets cents
	and Q5 asked (item 3). Headlines only: in 12-14 px rows the paise would fall
	under the 12 px floor, so tables keep full-size paise. Takes the already formatted string, so the
	ledger-exactness guard (SET1) stays in the formatter; a compact amount has no paise and renders
	as is. The full figure stays in the accessibility tree as one string.
-->
<script lang="ts">
	let { text }: { text: string } = $props();
	const parts = $derived(text.match(/^([\s\S]*\d)(\.\d{2})([\s\S]*)$/));
</script>

{#if parts}<span class="sr-only">{text}</span><span aria-hidden="true">{parts[1]}<span class="paise">{parts[2]}</span>{parts[3]}</span>{:else}{text}{/if}

<style>
	.paise {
		font-size: 0.72em;
		vertical-align: 0.27em; /* the paise's top on the digits' cap line */
		line-height: 0;
		letter-spacing: 0.01em;
	}
</style>
