/**
 * write-gate.ts: one long write without stopping the server. Importing Actual's
 * export is one SQLite transaction (all or nothing), but run in one go it held Node's only thread
 * for the whole import: on a low-power server a page anyone asked for waited 5.7 s. The import now gives the
 * thread back between chunks (`runImport`), so other requests are served while its transaction is
 * open. Every request shares the one database connection, so a write served then would land
 * inside the import's transaction (and go with it if the import failed). So while the import runs,
 * other requests that write (every non-GET, `hooks.server.ts`) wait here until it ends, and it
 * starts only once the writes already under way have finished. Reads go on.
 */

let held: Promise<void> | null = null;
/** Writing requests under way (not counting one that has asked to run alone). */
let active = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A request that may write: it waits while a write runs alone, and counts as under way. */
export async function writeRequest<T>(fn: () => T | Promise<T>): Promise<T> {
	while (held) await held;
	active++;
	try {
		return await fn();
	} finally {
		active--;
	}
}

/**
 * Run `fn` as the only write: later writing requests wait until it ends, and it starts once the
 * ones under way have finished. Called from inside a writing request (the import's own POST),
 * which stops counting as under way while it waits, so two imports run one after the other.
 */
export async function exclusiveWrite<T>(fn: () => Promise<T>): Promise<T> {
	active--;
	try {
		while (held) await held;
		let release!: () => void;
		held = new Promise<void>((resolve) => (release = resolve));
		try {
			while (active > 0) await sleep(10);
			return await fn();
		} finally {
			held = null;
			release();
		}
	} finally {
		active++;
	}
}

/** True while a write runs alone (for tests). */
export function writeHeld(): boolean {
	return held !== null;
}
