<!--
  MoreMenu.svelte — "Settings and more", the title bar's "…" left of your initials (as
  Teams moved Settings, Zoom, Keyboard shortcuts and About out of its profile menu into
  a title-bar menu the same way, MC254084): Settings, the window's zoom (desktop only: a browser
  has its own), Keyboard shortcuts and About Miserly.
  About (Windows Terminal's About): the name and what it is, the version
  with Copy for a bug report, then links and the legal line. The links appear once each has a target
  (the licence, the public repo and the site come at the release); the data file's path is on
  Settings.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { Check, Copy, Ellipsis, ExternalLink, Keyboard, Info, Minus, Plus, ZoomIn } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Dialog from '$lib/components/ui/dialog';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import ColourIcon from '$lib/components/ColourIcon.svelte';
	import Logomark from '$lib/components/Logomark.svelte';
	import { Button } from '$lib/components/ui/button';
	import { aboutLinks, legalLinks } from '$lib/links';
	import { version } from '../../../package.json';

	type Bridge = { zoom?: (step: number) => number };
	const bridge = () => (typeof window === 'undefined' ? undefined : (window as unknown as { miserlyDesktop?: Bridge }).miserlyDesktop);
	let zoom = $state<number | null>(null);
	const step = (n: number) => (zoom = bridge()?.zoom?.(n) ?? null);

	let shortcutsOpen = $state(false);
	let aboutOpen = $state(false);

	// The addresses live in `$lib/links` (filled at the export); an empty one hides its link.
	const LINKS = aboutLinks();
	const LEGAL = legalLinks();
	let copied = $state(false);
	async function copyDetails() {
		const where = bridge() ? 'desktop app' : 'browser';
		try {
			await navigator.clipboard.writeText(`Miserly ${version}, ${where}, ${navigator.userAgent}`);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			copied = false;
		}
	}

	const SHORTCUTS: [string, string][] = [
		['Ctrl K', 'Search or jump to'],
		['Ctrl Shift N', 'Add a transaction'],
		['Ctrl N', 'New row in a register, else Add a transaction (desktop)'],
		['Ctrl F', "The page's own search, else the title bar's"],
		['Tab, Enter', 'Next cell in a register'],
		['Esc', 'Cancel an edit, or close a menu or dialog'],
		['F2', 'Edit the focused row'],
		['Alt ↑, Alt ↓', 'Move a row within its day'],
		['Ctrl Z', 'Undo a delete'],
		['Ctrl Enter', 'Save and close in a dialog'],
		['F6', 'Move between the title bar, the sidebar and the page'],
		['Alt + letter', 'The underlined letter (shown while Alt is held)'],
		['Ctrl +, Ctrl −, Ctrl 0', 'Zoom in, out, back to 100 % (desktop)']
	];
</script>

<DropdownMenu.Root onOpenChange={(o) => o && (zoom = bridge()?.zoom?.(NaN) ?? null)}>
	<Tooltip label="Settings and more" side="bottom">
		{#snippet child({ props })}
			<DropdownMenu.Trigger
				{...props}
				class="grid size-8 shrink-0 place-items-center rounded-control text-text-muted hover:bg-control-hover hover:text-text data-[state=open]:bg-control-hover"
				aria-label="Settings and more"
			>
				<Ellipsis size={16} aria-hidden="true" />
			</DropdownMenu.Trigger>
		{/snippet}
	</Tooltip>
	<DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="min-w-56">
		<DropdownMenu.Item onSelect={() => goto('/settings')}>
			<ColourIcon name="settings" size={16} />
			Settings
		</DropdownMenu.Item>
		{#if zoom !== null}
			<!-- An icon like the rows around it, so "Zoom" starts where their labels do (F9). -->
			<div class="flex h-8 items-center gap-2 px-2 text-body">
				<ZoomIn size={16} aria-hidden="true" />
				<span class="flex-1">Zoom</span>
				<button type="button" class="grid size-7 place-items-center rounded-control hover:bg-control-hover" aria-label="Zoom out" onclick={() => step(-1)}><Minus size={14} /></button>
				<button type="button" class="w-12 rounded-control py-0.5 text-center tabular-nums hover:bg-control-hover" aria-label="Reset zoom to 100 %" onclick={() => step(0)}>{zoom} %</button>
				<button type="button" class="grid size-7 place-items-center rounded-control hover:bg-control-hover" aria-label="Zoom in" onclick={() => step(1)}><Plus size={14} /></button>
			</div>
		{/if}
		<DropdownMenu.Separator />
		<DropdownMenu.Item onSelect={() => (shortcutsOpen = true)}>
			<Keyboard size={16} aria-hidden="true" />
			Keyboard shortcuts
		</DropdownMenu.Item>
		<DropdownMenu.Item onSelect={() => (aboutOpen = true)}>
			<Info size={16} aria-hidden="true" />
			About Miserly
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>

<Dialog.Root bind:open={shortcutsOpen}>
	<Dialog.Content class="sm:max-w-[32rem]">
		<Dialog.Header><Dialog.Title>Keyboard shortcuts</Dialog.Title></Dialog.Header>
		<table class="w-full text-body">
			<tbody>
				{#each SHORTCUTS as [keys, what] (keys)}
					<tr class="border-b border-divider last:border-b-0">
						<td class="whitespace-nowrap py-1.5 pr-4 font-semibold">{keys}</td>
						<td class="py-1.5 text-text-muted">{what}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={aboutOpen}>
	<Dialog.Content class="sm:max-w-[24rem]">
		<Dialog.Header><Dialog.Title>About Miserly</Dialog.Title></Dialog.Header>
		<div class="flex flex-col items-center gap-3 py-2 text-center">
			<Logomark size={44} />
			<div>
				<div class="text-body-lg font-semibold">Miserly</div>
				<div class="text-body text-text-muted">Expense and net worth tracker</div>
			</div>
			<div class="flex items-center gap-1 text-body text-text-muted">
				Version {version}
				<!-- No Tooltip: one inside a dialog takes its focus scope (dialog-content.svelte). -->
				<Button variant="ghost" size="icon-sm" aria-label="Copy version details" onclick={copyDetails}>
					{#if copied}<Check aria-hidden="true" />{:else}<Copy aria-hidden="true" />{/if}
				</Button>
				<span class="sr-only" aria-live="polite">{copied ? 'Copied' : ''}</span>
			</div>
			{#if LINKS.length > 0}
				<div class="flex flex-wrap justify-center gap-x-4 gap-y-1 text-body">
					{#each LINKS as l (l.label)}
						<a href={l.href} target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 text-brand-ink underline-offset-4 hover:underline">
							{l.label}<ExternalLink size={14} aria-hidden="true" />
						</a>
					{/each}
				</div>
			{/if}
			<div class="flex flex-wrap justify-center gap-x-3 text-caption text-text-muted">
				<span>© 2026 JAM Lab</span>
				{#each LEGAL as l (l.label)}
					<a href={l.href} target="_blank" rel="noreferrer" class="text-brand-ink underline-offset-4 hover:underline">{l.label}</a>
				{/each}
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
