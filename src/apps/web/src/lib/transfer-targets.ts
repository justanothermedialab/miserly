/**
 * transfer-targets.ts — the accounts a payee field offers as "Transfer → X" (C3's inline path).
 * ============================================================================
 * P0: the payee list had one flat "Transfer → HDFC" per account and the
 * server took the text, so with a bank and a fund both called HDFC a move went into whichever id
 * sorted first. Now the list has a heading per section in the sidebar's order ("Transfer: Bank",
 * "Transfer: Mutual funds", as Actual's "Transfer To/From" under Payees), each line carries its
 * account id, and the server takes the id; typed text naming two accounts is refused.
 * C8: a co-member's account reads "HDFC (Bob's)" and a closed one "HDFC (closed)", here and
 * wherever a transfer names its other side, so no two lines read the same.
 * Two accounts the viewer sees with one name in different sections (a
 * bank and a fund both "HDFC") read "HDFC (Bank accounts)" / "HDFC (Mutual funds)" wherever an
 * account is named; lists already under a section heading show the name without it (`listLabel`).
 * Pure, so the pages and the server share it.
 * ============================================================================
 */
import { MODULE_PROFILES, moduleProfile, sectionLabel } from '$lib/modules';

export const TRANSFER_PREFIX = 'Transfer → ';

export interface TransferTarget {
	readonly id: string;
	readonly name: string;
	/** The name wherever an account is named: "HDFC", "HDFC (Bob's)", "HDFC (Mutual funds)". */
	readonly label: string;
	/** The name under a section heading: the label without its section ("HDFC (Bob's)"). */
	readonly listLabel?: string;
	readonly type: string;
	readonly currency: string;
}

/** One line of a payee list: a payee (no `accountId`), or an account to transfer to. */
export interface PayeeOption {
	/** What the line shows ("HDFC" under its heading). */
	readonly label: string;
	/** What the field holds once it's picked ("Transfer → HDFC"). */
	readonly value: string;
	readonly group?: string;
	readonly accountId?: string;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** Two names are one when they differ only in case and spaces (as F1's own name check). */
const nameKey = (name: string) => name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();

/** The names (as `nameKey`) that accounts in two or more sections share, among `accounts`,
 *  which is every account the viewer sees, open or closed. */
export function sharedNames(accounts: readonly { readonly name: string; readonly type: string }[]): Set<string> {
	const sections = new Map<string, Set<string>>();
	for (const a of accounts) {
		const k = nameKey(a.name);
		sections.set(k, (sections.get(k) ?? new Set()).add(sectionLabel(a.type)));
	}
	return new Set([...sections].filter(([, s]) => s.size > 1).map(([k]) => k));
}

/** The name with its section when another account the viewer sees has it too. */
export function sectionedName(a: { readonly name: string; readonly type: string }, shared: ReadonlySet<string>): string {
	return shared.has(nameKey(a.name)) ? `${a.name} (${sectionLabel(a.type)})` : a.name;
}

/** C8: an account's name as a list or a transfer row shows it, telling apart a co-member's
 *  account and a closed one from the viewer's own open one of the same name; with `shared`
 *  one in another section too. */
export function accountLabel(
	a: { readonly name: string; readonly type: string; readonly ownerId: string; readonly status: string },
	ownerName: string | null,
	viewerId: string,
	shared: ReadonlySet<string> = NO_NAMES
): string {
	let label = sectionedName(a, shared);
	if (a.ownerId !== viewerId && ownerName) label += ` (${ownerName}'s)`;
	if (a.status === 'closed') label += ' (closed)';
	return label;
}

const ORDER = new Map(MODULE_PROFILES.map((p, i) => [p.type, i]));

/** The transfer lines, a heading per section in the sidebar's order (S1 RD7), names A to Z; a
 *  line shows the name without its section, the field the whole label once it's picked. */
export function transferOptions(targets: readonly TransferTarget[]): PayeeOption[] {
	return [...targets]
		.sort((a, b) => (ORDER.get(a.type) ?? 99) - (ORDER.get(b.type) ?? 99) || a.label.localeCompare(b.label))
		.map((t) => ({ label: t.listLabel ?? t.label, value: `${TRANSFER_PREFIX}${t.label}`, group: `Transfer: ${sectionLabel(t.type)}`, accountId: t.id }));
}

/**
 * The account a payee field names: the picked line's id, else the one account whose name (or
 * label) the typed text is. Null for a payee, or for text naming none or two.
 */
export function transferTargetOf<T extends TransferTarget>(
	targets: readonly T[],
	payee: string,
	accountId: string | null | undefined
): T | null {
	if (!payee.startsWith(TRANSFER_PREFIX)) return null;
	if (accountId) return targets.find((t) => t.id === accountId) ?? null;
	const hits = namedBy(targets, payee);
	return hits.length === 1 ? hits[0]! : null;
}

/** A bank or card on one side and a holding on the other: the pair takes a category (C3 RD5). */
export function pairTakesCategory(typeA: string, typeB: string): boolean {
	const spending = (t: string) => moduleProfile(t)?.sectionShape === 'spending';
	return spending(typeA) !== spending(typeB);
}

/**
 * The category a new transfer fills in when its field is empty, from `remembered` (the
 * destination account's id → the category this user's latest transfer into it had; the server's
 * `rememberedTransferCategories`). `here` is the account the row is typed in, `other` the one
 * picked; money out goes to `other`, money in to `here` (a row whose side isn't typed yet is
 * money out, as most are typed from the bank). Null when the pair takes no category.
 */
export function rememberedTransferCategory(
	remembered: Readonly<Record<string, string>>,
	here: { readonly id: string; readonly type: string } | null | undefined,
	other: { readonly id: string; readonly type: string } | null | undefined,
	direction: 'out' | 'in'
): string | null {
	if (!here || !other || !pairTakesCategory(here.type, other.type)) return null;
	return remembered[direction === 'out' ? other.id : here.id] ?? null;
}

/** The accounts typed text after "Transfer → " names, by label or by name. */
export function namedBy<T extends TransferTarget>(targets: readonly T[], payee: string): T[] {
	const text = payee.slice(TRANSFER_PREFIX.length).trim();
	return targets.filter((t) => t.label === text || t.listLabel === text || t.name === text);
}
