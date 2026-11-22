/**
 * import-eps.ts: the Actual import's "EPS of …" entries in Add as (F4 RD9, O25). Outside
 * `$lib/server` so the preview (ImportCard) and the server share one rule.
 *
 * Actual keeps an EPF and its EPS as two off-budget accounts. Add as offers "EPS of <EPF>" for each
 * EPF the person will have once the import lands: an open EPF of theirs already here, or an Actual
 * account ticked and set to EPF in this preview. The choice brings the Actual account's rows into
 * that EPF's EPS (the child account), never a new account.
 */
import type { AccountChoice, AddAsOption, ImportPreview } from './server/import/actual-import';

const PREFIX = 'epsOf:';

/** The Add as key for "EPS of" an EPF here (our id) or an Actual account set to EPF (Actual's id). */
export function epsOfKey(ref: { readonly here: string } | { readonly actual: string }): string {
	return 'here' in ref ? `${PREFIX}here:${ref.here}` : `${PREFIX}actual:${ref.actual}`;
}

/** The EPF an "EPS of" key names, or null for any other key. */
export function parseEpsOf(key: string): { readonly here: string } | { readonly actual: string } | null {
	if (!key.startsWith(PREFIX)) return null;
	const rest = key.slice(PREFIX.length);
	if (rest.startsWith('here:') && rest.length > 5) return { here: rest.slice(5) };
	if (rest.startsWith('actual:') && rest.length > 7) return { actual: rest.slice(7) };
	return null;
}

type Preview = Pick<ImportPreview, 'accounts' | 'options' | 'epfsHere' | 'epsOption'>;
type Choices = Readonly<Record<string, Pick<AccountChoice, 'include' | 'addAs' | 'name'>>>;

/** The "EPS of" entries for these choices: the EPFs here first, then those set to EPF in the preview. */
export function epsOfOptions(p: Preview, choices: Choices): AddAsOption[] {
	const types = new Map(p.options.map((o) => [o.key, o.type]));
	const option = (key: string, epfName: string): AddAsOption => ({ ...p.epsOption, key, label: `EPS of ${epfName}` });
	return [
		...p.epfsHere.map((e) => option(epsOfKey({ here: e.id }), e.name)),
		...p.accounts
			.filter((a) => !a.existing && choices[a.actualId]?.include && types.get(choices[a.actualId]!.addAs) === 'epf')
			.map((a) => option(epsOfKey({ actual: a.actualId }), choices[a.actualId]!.name.trim() || a.name)),
	];
}

/** Ticked new accounts whose Add as is no longer on the list (an "EPS of" an EPF since unticked or retyped). */
export function unresolvedAddAs(p: Preview, choices: Choices): string[] {
	const keys = new Set([...p.options, ...epsOfOptions(p, choices)].map((o) => o.key));
	return p.accounts.filter((a) => !a.existing && choices[a.actualId]?.include && !keys.has(choices[a.actualId]!.addAs)).map((a) => a.actualId);
}

/** Ticked accounts that share one "EPS of" with another (an EPS takes one Actual account). */
export function sharedEpsOf(p: Preview, choices: Choices): string[] {
	const by = new Map<string, string[]>();
	for (const a of p.accounts) {
		const c = choices[a.actualId];
		if (a.existing || !c?.include || !parseEpsOf(c.addAs)) continue;
		by.set(c.addAs, [...(by.get(c.addAs) ?? []), a.actualId]);
	}
	return [...by.values()].filter((ids) => ids.length > 1).flat();
}
