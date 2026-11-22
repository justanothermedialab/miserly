<!--
  QuickAddBody.svelte — the HEAVY quick-add surface: the Add transaction dialog (laid out like a
  register row) and its pickers. Split out of QuickAdd.svelte and LAZY-LOADED (dynamic
  import) so it doesn't ship in every page's first-load / hydration bundle; it is fetched on the
  FIRST quick-add activation. (The search that once lived here is the title bar's SearchBox.) QuickAdd.svelte (the launcher) owns the global
  keyboard shortcut + window events and drives this body via the `request` prop.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { tick, untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import Segmented from '$lib/components/Segmented.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import DateField from '$lib/components/DateField.svelte';
	import PayeeCombobox from '$lib/components/PayeeCombobox.svelte';
	import PickCombobox from '$lib/components/PickCombobox.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { TEXT_LIMITS } from '$lib/text-limits';
	import { focusFirstInvalid, followOtherResult } from '$lib/forms';
	import { useMoney } from '$lib/format-context';
	import { MODULE_PROFILES, moduleProfile, sectionLabel } from '$lib/modules';
	import { openAddAccount } from '$lib/add-account';
	import { rememberedTransferCategory, transferOptions, transferTargetOf } from '$lib/transfer-targets';

	interface Account { id: string; name: string; label: string; listLabel?: string; type: string; currency: string }
	interface Group { id: string; name: string; categories: { id: string; name: string }[] }
	interface Payee { id: string; displayName: string; nameNormalized: string; rememberedCategoryId: string | null }

	/** Activation intents from the launcher; each fire is a fresh object (new `seq`)
	 *  so the reacting $effect below re-runs even for a repeated same-kind request. */
	type QuickAddRequest = { kind: 'transaction' | 'transfer' | 'close'; seq: number };

	let {
		accounts,
		categoryGroups,
		payees,
		transferCategories,
		request
	}: { accounts: Account[]; categoryGroups: Group[]; payees: Payee[]; transferCategories: Record<string, string>; request: QuickAddRequest | null } = $props();

	// C2 RD6: the default account is the one last used for this kind of entry.
	type EntryKind = 'out' | 'in' | 'transfer';
	const LAST_ACCOUNT_KEY = 'miserly:lastAccount'; // the old key: one account for every kind
	const lastKey = (kind: EntryKind) => `${LAST_ACCOUNT_KEY}:${kind}`;
	const m = useMoney();

	// Accounts grouped by section, in the sidebar's order (S1 RD7).
	const ORDER = new Map(MODULE_PROFILES.map((p, i) => [p.type, i]));
	const accountGroups = $derived.by(() => {
		const byType = new Map<string, Account[]>();
		for (const a of accounts) byType.set(a.type, [...(byType.get(a.type) ?? []), a]);
		return [...byType.entries()]
			.sort(([x], [y]) => (ORDER.get(x) ?? 99) - (ORDER.get(y) ?? 99))
			.map(([type, list]) => ({ type, label: sectionLabel(type), accounts: list }));
	});

	let overlay = $state<null | 'transaction' | 'transfer'>(null);
	let submitting = $state(false);
	let errors = $state<Record<string, string>>({});
	// "Add another" remembers the last choice on this device (ACTUAL-PARITY #21):
	// ticked by default (C2: Enter saves and starts the next one); a member who unticks it once keeps
	// Save closing the dialog.
	const ANOTHER_KEY = 'miserly.quickAdd.addAnother';
	let saveAndAnother = $state(readLast(ANOTHER_KEY) !== 'off');
	function rememberAnother() {
		try {
			localStorage.setItem(ANOTHER_KEY, saveAndAnother ? 'on' : 'off');
		} catch {
			// Storage unavailable: it starts ticked next time.
		}
	}

	// transaction fields
	let account = $state('');
	let date = $state('');
	let payee = $state('');
	let payeeAccount = $state(''); // the transfer line picked (posted as its id)
	let category = $state('');
	// Two amount fields as in the register (no Expense / Income / Transfer
	// tabs; Actual and YNAB have Payment and Deposit, and a transfer is an account picked as the payee).
	let withdrawal = $state('');
	let deposit = $state('');
	let received = $state(''); // a transfer across currencies: the other account's amount
	const direction = $derived<'out' | 'in'>(deposit.trim() !== '' && withdrawal.trim() === '' ? 'in' : 'out');
	let notes = $state('');

	// transfer fields
	let fromId = $state('');
	let toId = $state('');
	let tAmount = $state('');
	let tNotes = $state('');
	// A transfer between a bank or card and a holding takes a category (a SIP; item 2.5).
	let tCategory = $state('');
	// MC2 cross-currency: reveal an FX row (enter the linkage rate OR the received
	// amount — exactly one; the server derives the other and freezes the rate).
	let fxMode = $state<'rate' | 'received'>('rate');
	let fxRate = $state('');
	let fxReceived = $state('');
	const fromAcct = $derived(accounts.find((a) => a.id === fromId));
	const toAcct = $derived(accounts.find((a) => a.id === toId));
	const isSpendingAcct = (a: { type: string } | undefined): boolean => moduleProfile(a?.type ?? '')?.sectionShape === 'spending';
	const transferTakesCategory = $derived(!!fromAcct && !!toAcct && isSpendingAcct(fromAcct) !== isSpendingAcct(toAcct));
	const crossCurrency = $derived(
		!!fromAcct && !!toAcct && fromAcct.currency !== toAcct.currency
	);
	// Live preview of the two native legs (display-only; the server derives + freezes).
	const fxLegs = $derived.by(() => {
		if (!crossCurrency || !fromAcct || !toAcct) return null;
		const out = Number(tAmount) || 0;
		let received = 0;
		let rate = 0;
		if (fxMode === 'rate') {
			rate = Number(fxRate) || 0;
			received = out * rate;
		} else {
			received = Number(fxReceived) || 0;
			rate = out ? received / out : 0;
		}
		return { out, received, rate, fromCur: fromAcct.currency, toCur: toAcct.currency };
	});

	// Init to null (not undefined): this is bound via `bind:inputRef={firstField}` on a
	// PickCombobox whose `inputRef` is `$bindable(null)`. Binding `undefined` to a
	// prop with a non-undefined fallback throws Svelte's `props_invalid_value` in the
	// production build, which aborted the entire quick-add "Add transaction" overlay
	// render on open (same class as the C1 register entry-row crash).
	let firstField = $state<HTMLInputElement | null>(null);

	function today(): string {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}

	function normalize(s: string): string {
		return s.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
	}
	const prefillByName = $derived(
		new Map(payees.map((p) => [p.nameNormalized, p.rememberedCategoryId]))
	);

	function readLast(key: string): string | null {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}
	/** The account last used for `kind`, else the first bank account; never a holding for an expense. */
	function lastAccount(kind: EntryKind): string {
		const fits = (a: Account) => kind !== 'out' || moduleProfile(a.type)?.sectionShape !== 'holding';
		for (const key of [lastKey(kind), ...(kind === 'out' ? [LAST_ACCOUNT_KEY] : [])]) {
			const saved = readLast(key);
			const hit = saved ? accounts.find((a) => a.id === saved) : undefined;
			if (hit && fits(hit)) return hit.id;
		}
		// First use: a bank account in the base currency before a foreign one (it opened on US Checking).
		return (
			accounts.find((a) => a.type === 'bank' && a.currency === page.data.baseCurrency) ??
			accounts.find((a) => a.type === 'bank') ??
			accounts.find(fits) ??
			accounts[0]
		)?.id ?? '';
	}
	function rememberAccount(kind: EntryKind, id: string) {
		try {
			localStorage.setItem(lastKey(kind), id);
		} catch {
			// Storage unavailable: the default falls back to the first bank account.
		}
	}
	// The "Add another" confirmation: what the last save recorded.
	let savedNote = $state<{ text: string; seq: number } | null>(null);

	async function openTransaction() {
		errors = {};
		savedNote = null;
		account = lastAccount('out');
		date = today();
		payee = '';
		payeeAccount = '';
		category = '';
		withdrawal = '';
		deposit = '';
		received = '';
		notes = '';
		overlay = 'transaction';
		await tick();
		firstField?.focus();
	}

	async function openTransfer() {
		errors = {};
		savedNote = null;
		fromId = lastAccount('transfer');
		toId = ''; // No guessed destination — the user picks it
		tAmount = '';
		tNotes = '';
		tCategory = '';
		fxMode = 'rate';
		fxRate = '';
		fxReceived = '';
		date = today();
		overlay = 'transfer';
		await tick();
		firstField?.focus();
	}

	function close() {
		overlay = null;
		savedNote = null;
	}


	/** The transfer form fills its empty category from the last transfer into the destination. */
	function fillTransferCategory(from: string, to: string) {
		if (tCategory !== '') return;
		const a = accounts.find((x) => x.id === from);
		const b = accounts.find((x) => x.id === to);
		tCategory = rememberedTransferCategory(transferCategories, a, b, 'out') ?? '';
	}

	function onPayeeChange() {
		if (transferTarget) {
			if (!transferTakesCategoryHere) category = '';
			// The category the last transfer into its destination had, when the field is empty.
			else if (category === '') category = rememberedTransferCategory(transferCategories, txAcct, transferTarget, direction) ?? '';
			return;
		}
		if (category !== '') return;
		const remembered = prefillByName.get(normalize(payee));
		if (remembered) category = remembered;
	}

	// React to the launcher's activation intents. Each `request` is a fresh object,
	// so this re-runs on every fire; untrack keeps the field mutations out of deps.
	$effect(() => {
		const r = request;
		if (!r) return;
		untrack(() => {
			if (r.kind === 'transaction') void openTransaction();
			else if (r.kind === 'transfer') void openTransfer();
			else if (r.kind === 'close') {
				close();
			}
		});
	});

	// C2: Ctrl/Cmd+Enter saves and closes from any field (even with "Add another"
	// on); plain Enter submits natively and follows the checkbox.
	let closeAfterSave = false;
	function onFormKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
		e.preventDefault();
		closeAfterSave = true;
		(e.currentTarget as HTMLFormElement).requestSubmit();
	}

	// Hosted audit H1: once the session has ended the post comes back as a redirect to sign-in;
	// go there (and back to this page after), and show a line for a server error.
	function sessionOrError(result: { type: string; location?: string }) {
		return followOtherResult(result, {
			here: page.url,
			navigate: (to) => {
				close();
				return goto(to);
			},
			showError: (message) => (errors = { _: message }),
			message: 'Could not save. Try again.'
		});
	}

	// The two amount fields are the shared inflow/outflow schema fields, so /capture
	// reuses transactionCreateSchema exactly (C1 RD4).
	function submitTransaction(formEl: HTMLFormElement) {
		return async ({ result }: { result: { type: string; location?: string; data?: { errors?: Record<string, string> } } }) => {
			submitting = false;
			const closeNow = closeAfterSave;
			closeAfterSave = false;
			if (result.type === 'success') {
				errors = {};
				rememberAccount(direction, account);
				await invalidateAll();
				if (saveAndAnother && !closeNow) {
					const acct = accounts.find((a) => a.id === account);
					const typed = direction === 'out' ? withdrawal : deposit;
					const paise = Math.round(Number(typed) * 100) * (direction === 'out' ? -1 : 1);
					const what = transferTarget
						? `a transfer ${direction === 'out' ? 'to' : 'from'} ${transferTarget.label}`
						: payee.trim() || catName(category);
					const note = {
						text: `Saved ${what}, ${m.money(paise, { currency: acct?.currency })}, ${direction === 'out' ? 'from' : 'to'} ${acct?.label ?? 'the account'}.`,
						seq: (savedNote?.seq ?? 0) + 1
					};
					const keepAccount = account;
					const keepDate = date;
					await openTransaction();
					account = keepAccount;
					date = keepDate;
					savedNote = note;
				} else {
					close();
				}
			} else if (result.type === 'failure') {
				errors = result.data?.errors ?? {};
				await tick();
				focusFirstInvalid(formEl, errors);
			} else {
				await sessionOrError(result);
			}
		};
	}

	function submitTransfer(formEl: HTMLFormElement) {
		return async ({ result }: { result: { type: string; location?: string; data?: { errors?: Record<string, string> } } }) => {
			submitting = false;
			closeAfterSave = false;
			if (result.type === 'success') {
				errors = {};
				rememberAccount('transfer', fromId);
				await invalidateAll();
				close();
			} else if (result.type === 'failure') {
				errors = result.data?.errors ?? {};
				await tick();
				focusFirstInvalid(formEl, errors);
			} else {
				await sessionOrError(result);
			}
		};
	}


	const catName = (id: string) =>
		id === ''
			? 'Uncategorized'
			: (categoryGroups.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? 'Uncategorized');
	const labelCls = 'flex flex-col gap-1 text-caption font-normal text-text-muted mb-3';
	const errCls = '-mt-2 mb-3 block text-caption text-neg'; // under its field, clear of the next label
	const payeeNames = $derived(payees.map((p) => p.displayName));
	// Account and Category are typed into like Payee: a few letters and Tab (ACTUAL-PARITY #3,
	// the Quick Add type-ahead; T5 was 28 keys to Actual's 19).
	const accountOptions = (list: Account[]) =>
		accountGroups.flatMap((g) =>
			list.filter((a) => a.type === g.type).map((a) => ({ value: a.id, label: a.listLabel ?? a.label, picked: a.label, group: g.label }))
		);
	const categoryOptions = $derived([
		{ value: '', label: 'Uncategorized' },
		...categoryGroups.flatMap((g) => g.categories.map((c) => ({ value: c.id, label: c.name, group: g.name })))
	]);
	// A transfer with no category is still a transfer, not uncategorised spending (item 2.5).
	const transferCategoryOptions = $derived([{ value: '', label: 'No category' }, ...categoryOptions.slice(1)]);
	// The register's column words: a card or a loan says Charge and Payment.
	const LIABILITY = new Set(['creditCard', 'loan', 'otherLiability']);
	const txAcct = $derived(accounts.find((a) => a.id === account));
	const outLabel = $derived(LIABILITY.has(txAcct?.type ?? '') ? 'Charge' : 'Withdrawal');
	const inLabel = $derived(LIABILITY.has(txAcct?.type ?? '') ? 'Payment' : 'Deposit');
	// "Transfer → <account>" in Payee, after the payees (Actual's list), every account but this one,
	// under a heading per section, each line posting its account's id.
	const quickPayeeOptions = $derived([...payeeNames, ...transferOptions(accounts.filter((a) => a.id !== account))]);
	const transferTarget = $derived(transferTargetOf(accounts.filter((a) => a.id !== account), payee, payeeAccount));
	const transferTakesCategoryHere = $derived(!!transferTarget && isSpendingAcct(txAcct) !== isSpendingAcct(transferTarget));
	const fxTarget = $derived(transferTarget && txAcct && transferTarget.currency !== txAcct.currency ? transferTarget : null);
</script>


<!-- One dialog for Expense, Income and Transfer: switching kind swaps the form inside it, so the
     scrim and the dialog never close and reopen (it flashed on a switch). -->
<Dialog.Root open={overlay === 'transaction' || overlay === 'transfer'} onOpenChange={(v) => { if (!v && overlay) close(); }}>
	<Dialog.Content
		class="top-[8vh] translate-y-0 sm:max-w-[30rem]"
		onOpenAutoFocus={(e) => {
			e.preventDefault();
			firstField?.focus();
		}}
	>
		<Dialog.Header><Dialog.Title>{overlay === 'transfer' ? 'New transfer' : 'Add transaction'}</Dialog.Title></Dialog.Header>
		{#if overlay !== 'transfer'}
			{#if accounts.length === 0}
				<p class="text-body text-text-muted">You need an account first. <button type="button" onclick={() => { close(); openAddAccount(); }} class="font-semibold text-brand-ink hover:underline">Create one</button></p>
			{:else}
				{#if errors._}<StatusBar intent="error" trigger={errors} class="mb-3">{errors._}</StatusBar>{/if}
				{#if savedNote && !errors._}
					<div role="status"><StatusBar trigger={savedNote.seq} class="mb-3">{savedNote.text}</StatusBar></div>
				{/if}
				<!-- The form is the boundary for Ctrl/Cmd+Enter (C2). -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<form
					method="POST"
					action="/capture?/addTransaction"
					onkeydown={onFormKeydown}
					use:enhance={({ formElement }) => {
						submitting = true;
						return submitTransaction(formElement);
					}}
				>
					<label class={labelCls}>
						Account
						<PickCombobox name="account" openOnFocus={false} bind:value={account} bind:inputRef={firstField} options={accountOptions(accounts)} aria-label="Account" />
					</label>
					{#if errors.account}<span class={errCls}>{errors.account}</span>{/if}

					<label class={labelCls}>
						Date
						<DateField name="date" bind:value={date} required class="w-full" />
					</label>

					<label class={labelCls}>
						Payee
						<PayeeCombobox name="payee" openOnFocus={false} bind:value={payee} bind:transferAccountId={payeeAccount} transferAccountName="transferAccountId" options={quickPayeeOptions} onchange={onPayeeChange} placeholder="A payee, or Transfer → an account" />
					</label>

					{#if errors.payee}<span class={errCls}>{errors.payee}</span>{/if}

					<!-- A transfer has no category unless it pairs a bank or card with a holding (item 2.5). -->
					{#if !transferTarget || transferTakesCategoryHere}
						<label class={labelCls}>
							Category
							<PickCombobox name="category" openOnFocus={false} bind:value={category} options={transferTarget ? transferCategoryOptions : categoryOptions} aria-label="Category" />
						</label>
						{#if errors.category}<span class={errCls}>{errors.category}</span>{/if}
					{/if}

					<!-- The register's two columns: type in one (typing in it clears the other). -->
					<div class="grid grid-cols-2 gap-3">
						<label class={labelCls}>
							{outLabel}
							<Input type="text" name="outflow" inputmode="decimal" bind:value={withdrawal} oninput={() => (deposit = '')} placeholder="0.00" class="num text-right" />
						</label>
						<label class={labelCls}>
							{inLabel}
							<Input type="text" name="inflow" inputmode="decimal" bind:value={deposit} oninput={() => (withdrawal = '')} placeholder="0.00" class="num text-right" />
						</label>
					</div>
					{#if errors.inflow || errors.outflow}
						<span class={errCls}>{errors.inflow ?? errors.outflow}</span>
					{/if}

					{#if fxTarget}
						<label class={labelCls}>
							Amount in {fxTarget.label} ({fxTarget.currency})
							<Input type="text" name="received" inputmode="decimal" bind:value={received} placeholder={`Amount in ${fxTarget.currency}`} class="num text-right" />
						</label>
						{#if errors.received}<span class={errCls}>{errors.received}</span>{/if}
					{/if}

					<label class={labelCls}>
						Notes
						<Input type="text" name="notes" bind:value={notes} maxlength={TEXT_LIMITS.note} />
					</label>
					{#if errors.notes}<span class={errCls}>{errors.notes}</span>{/if}

					<Dialog.Footer class="items-center">
						<label class="mr-auto flex items-center gap-2 text-body text-text">
							<!-- svelte-ignore a11y_accesskey (Windows access keys, Alt+A, underlined while Alt is held) -->
							<input type="checkbox" accesskey="a" bind:checked={saveAndAnother} onchange={rememberAnother} class="size-4 cursor-pointer accent-brand" /> <span><u class="ak">A</u>dd another</span>
						</label>
						<Button type="submit" disabled={submitting}>Save</Button>
						<Button type="button" variant="outline" onclick={close}>Cancel</Button>
					</Dialog.Footer>
				</form>
			{/if}
		{:else}
			{#if accounts.length < 2}
				<p class="text-body text-text-muted">You need at least two accounts to transfer between.</p>
			{:else}
				{#if errors._}<StatusBar intent="error" trigger={errors} class="mb-3">{errors._}</StatusBar>{/if}
				<!-- The form is the boundary for Ctrl/Cmd+Enter (C2). -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<form
					method="POST"
					action="/capture?/addTransfer"
					onkeydown={onFormKeydown}
					use:enhance={({ formData, formElement }) => {
						submitting = true;
						if (crossCurrency) {
							if (fxMode === 'rate') formData.set('rate', fxRate);
							else formData.set('received', fxReceived);
						}
						return submitTransfer(formElement);
					}}
				>
					<label class={labelCls}>
						From
						<PickCombobox name="from" openOnFocus={false} bind:value={fromId} bind:inputRef={firstField} options={accountOptions(accounts)} onpick={(v) => fillTransferCategory(v, toId)} aria-label="From" />
					</label>
					{#if errors.from}<span class={errCls}>{errors.from}</span>{/if}

					<label class={labelCls}>
						To
						<PickCombobox name="to" openOnFocus={false} bind:value={toId} options={accountOptions(accounts.filter((a) => a.id !== fromId))} onpick={(v) => fillTransferCategory(fromId, v)} aria-label="To" placeholder="Choose an account…" />
					</label>
					{#if errors.to}<span class={errCls}>{errors.to}</span>{/if}

					<label class={labelCls}>
						Amount{#if crossCurrency && fromAcct}<span class="font-normal text-text-muted"> out ({fromAcct.currency})</span>{/if}
						<Input type="text" name="amount" inputmode="decimal" bind:value={tAmount} required class="num" />
					</label>
					{#if errors.amount}<span class={errCls}>{errors.amount}</span>{/if}

					<!-- MC2: cross-currency reveals the FX row (rate OR received, GnuCash-style). -->
					{#if crossCurrency && fromAcct && toAcct}
						<div class="mb-3 rounded-overlay border border-dashed border-border-strong bg-surface-2 p-3">
							<div class="mb-2 flex items-center justify-between gap-2">
								<span class="text-caption font-normal text-text-muted">
									{fromAcct.currency} → {toAcct.currency}
								</span>
								<Segmented
									bind:value={fxMode}
									size="sm"
									ariaLabel="FX input mode"
									options={[
										{ value: 'rate', label: 'Enter rate' },
										{ value: 'received', label: 'Enter received' }
									]}
								/>
							</div>
							{#if fxMode === 'rate'}
								<!-- The hint reads in the transfer's direction: a fixed "83.10" posted $415 for ₹5. -->
								<label class={labelCls}>
									Rate ({toAcct.currency} per 1 {fromAcct.currency})
									<Input type="text" inputmode="decimal" bind:value={fxRate} placeholder="1 {fromAcct.currency} = ? {toAcct.currency}" class="num" />
								</label>
								{#if errors.rate}<span class={errCls}>{errors.rate}</span>{/if}
							{:else}
								<label class={labelCls}>
									Received ({toAcct.currency})
									<Input type="text" inputmode="decimal" bind:value={fxReceived} placeholder="0.00" class="num" />
								</label>
								{#if errors.received}<span class={errCls}>{errors.received}</span>{/if}
							{/if}
							{#if fxLegs && fxLegs.out > 0}
								<div class="mt-1 flex justify-between text-caption">
									<span class="text-neg num">−{fxLegs.out.toLocaleString()} {fxLegs.fromCur}</span>
									<span class="text-pos num">+{fxLegs.received.toLocaleString(undefined, { maximumFractionDigits: 2 })} {fxLegs.toCur}</span>
								</div>
							{/if}
							<p class="mt-1 text-caption text-text-muted">
								Each account records the amount in its own currency. This rate is saved with the transfer.
							</p>
						</div>
					{/if}

					{#if transferTakesCategory}
						<label class={labelCls}>
							Category
							<PickCombobox name="category" openOnFocus={false} bind:value={tCategory} options={transferCategoryOptions} aria-label="Category" />
						</label>
						{#if errors.category}<span class={errCls}>{errors.category}</span>{/if}
					{/if}

					<label class={labelCls}>
						Date
						<DateField name="date" bind:value={date} required class="w-full" />
					</label>
					{#if errors.date}<span class={errCls}>{errors.date}</span>{/if}

					<label class={labelCls}>
						Notes
						<Input type="text" name="notes" bind:value={tNotes} maxlength={TEXT_LIMITS.note} />
					</label>
					{#if errors.notes}<span class={errCls}>{errors.notes}</span>{/if}

					<Dialog.Footer>
						<Button type="submit" disabled={submitting}>Create transfer</Button>
						<Button type="button" variant="outline" onclick={close}>Cancel</Button>
					</Dialog.Footer>
				</form>
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>

