/**
 * forms.ts — the one form behaviour (miserly-desktop-shell "Form behaviour").
 * ============================================================================
 * `use:enhance={keepValues()}`: on a validation failure the typed values stay put
 * (no reset, no full reload) and focus moves to the first invalid field; on success
 * the form resets (unless `resetOnSuccess: false`) and the page data refreshes.
 * The first invalid field is the first `[aria-invalid="true"]` control, else the
 * first control named in the action's `errors` object.
 * ============================================================================
 */
import type { SubmitFunction } from '@sveltejs/kit';
import { tick } from 'svelte';

const FOCUSABLE = 'input:not([type=hidden]), select, textarea, button, [tabindex]:not([tabindex="-1"])';

/** Focus the first invalid control in `form` (see the module comment). */
export function focusFirstInvalid(form: HTMLFormElement, errors?: Record<string, unknown>): void {
	let el = form.querySelector<HTMLElement>('[aria-invalid="true"]');
	if (!el && errors) {
		for (const key of Object.keys(errors)) {
			const named = form.querySelector<HTMLElement>(`[name="${CSS.escape(key)}"]`);
			if (!named) continue;
			// A hidden value input (DateField, Bits Select) → its visible sibling control.
			el =
				named instanceof HTMLInputElement && named.type === 'hidden'
					? (named.parentElement?.querySelector<HTMLElement>(FOCUSABLE) ?? null)
					: named;
			if (el) break;
		}
	}
	el?.focus();
}

/**
 * Where a `redirect` result goes. A post made after the session ended is sent to sign-in by the
 * hook with the action's own address to come back to (`/capture?/addTransaction`), which is no
 * page; the person comes back to the page they were on instead.
 */
export function redirectDestination(location: string, here: URL): string {
	const to = new URL(location, here);
	if (to.origin === here.origin && to.pathname === '/signin') {
		return `/signin?redirectTo=${encodeURIComponent(here.pathname + here.search)}`;
	}
	return location;
}

/**
 * For a dialog whose own save handler reads only `success` and `failure` (hosted audit H1): a
 * `redirect` (the session ended) is followed, an `error` shows `message` in the dialog. Returns
 * true when it handled the result. Forms using `keepValues` get this from `update()`.
 */
export async function followOtherResult(
	result: { type: string; location?: string },
	opts: { here: URL; navigate: (to: string) => Promise<unknown>; showError: (message: string) => void; message: string }
): Promise<boolean> {
	if (result.type === 'redirect' && result.location) {
		await opts.navigate(redirectDestination(result.location, opts.here));
		return true;
	}
	if (result.type === 'error') {
		opts.showError(opts.message);
		return true;
	}
	return false;
}

export function keepValues(
	opts: {
		resetOnSuccess?: boolean;
		onSuccess?: () => void;
		/** Runs after the failed result renders; return true if it moved focus itself. */
		onFailure?: (form: HTMLFormElement) => boolean | void;
	} = {}
): SubmitFunction {
	return ({ formElement }) =>
		async ({ result, update }) => {
			const ok = result.type === 'success';
			await update({ reset: ok && opts.resetOnSuccess !== false });
			if (ok) {
				opts.onSuccess?.();
			} else if (result.type === 'failure') {
				await tick();
				if (opts.onFailure?.(formElement) === true) return;
				const data = result.data as { errors?: Record<string, unknown> } | undefined;
				focusFirstInvalid(formElement, data?.errors ?? data);
			}
		};
}
