/**
 * holding-notes.ts: the words a holding's register and section say about its figures (red team
 * step 3). Pure data, safe on server and client, so the tests and the
 * pages read one wording.
 */

/** An asset holding reads below zero (more was taken out than its recorded value). */
export const OVERDRAWN_MESSAGE =
	'More was taken out than its last recorded value. Update its value first, dated before the withdrawal.';

/**
 * C7: how long ago a holding's value was last known, in plain words ("today", "12 days ago",
 * "5 months ago", "2 years ago"); `stale` colours it amber. Whole calendar months, as a person
 * counts them; the exact date is the element's title.
 */
export function updatedAgo(lastIso: string, todayIso: string): string {
	const [ly, lm, ld] = lastIso.split('-').map(Number) as [number, number, number];
	const [ty, tm, td] = todayIso.split('-').map(Number) as [number, number, number];
	let months = (ty - ly) * 12 + (tm - lm);
	if (td < ld) months -= 1;
	if (months <= 0) {
		const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(ly, lm - 1, ld)) / 86_400_000);
		return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
	}
	if (months < 24) return months === 1 ? '1 month ago' : `${months} months ago`;
	return `${Math.floor(months / 12)} years ago`;
}

/** A section's rate leaves out holdings never valued since they began. */
export function notValuedNote(n: number): string {
	return n === 1 ? 'Leaves out 1 holding with no value update yet' : `Leaves out ${n} holdings with no value update yet`;
}

/** C1 A: a section's rate leaves out holdings paid out at their own stated rate. */
export function paidOutNote(n: number): string {
	return n === 1 ? '1 paid out, at its own rate' : `${n} paid out, at their own rates`;
}

/** A loan's payments have passed what was owed (an EMI's interest was never recorded). */
export const PASSED_ZERO_MESSAGE =
	"Payments have passed what was owed. Update the outstanding from your lender's statement.";
