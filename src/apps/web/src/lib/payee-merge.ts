/**
 * The payees a merge would move: the ticked ones without the target, and none until a target is
 * chosen. Payees offers Merge only when this isn't empty ("Merge 0 payees into X?" when the only
 * ticked payee was the target).
 */
export function mergeMoves(selected: readonly string[], targetId: string): string[] {
	return targetId === '' ? [] : selected.filter((id) => id !== targetId);
}
