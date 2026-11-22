/**
 * import-counts.ts: the Actual import preview's transfer counts, worked out in the browser as the
 * person ticks accounts (F4). Outside `$lib/server` so ImportCard can use it.
 *
 * An account's rows come in when it is ticked and isn't already here and closed (a closed
 * account's new rows are skipped). A transfer leg on such an account is a linked pair when its
 * other account's rows come in too; otherwise it comes in alone, under Transfer to Self unless
 * Actual gave it a category: its other account was left unticked, is closed here, or its other
 * half can't come in (`transferTo` holds '' for that).
 */
export interface TransferCountsAccount {
	readonly actualId: string;
	readonly transferTo: readonly string[];
	readonly existing: { readonly closed: boolean } | null;
}

export function transferCounts(accounts: readonly TransferCountsAccount[], ticked: ReadonlySet<string>): { pairs: number; leftOut: number } {
	const landing = new Set(accounts.filter((a) => ticked.has(a.actualId) && !a.existing?.closed).map((a) => a.actualId));
	let legs = 0;
	let leftOut = 0;
	for (const a of accounts) {
		if (!landing.has(a.actualId)) continue;
		for (const to of a.transferTo) {
			if (landing.has(to)) legs++;
			else leftOut++;
		}
	}
	return { pairs: Math.round(legs / 2), leftOut };
}
