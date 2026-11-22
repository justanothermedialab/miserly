import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import { createTV } from 'tailwind-variants';

/**
 * tailwind-merge must know the design-system utilities, or it misreads them:
 * `text-caption`/`text-body`/… look like text COLOURS to it, so a later colour
 * class (`text-text-muted`) silently dropped the font size. Register the Fluent
 * type ramp as font sizes and the radius pair as radii. Shared by `cn` and `tv`.
 */
const twMergeConfig = {
	extend: {
		classGroups: {
			'font-size': [{ text: ['caption', 'body', 'body-lg', 'subtitle', 'title', 'display'] }],
			rounded: [{ rounded: ['control', 'overlay'] }]
		}
	}
};
const twMerge = extendTailwindMerge(twMergeConfig);

/** shadcn-svelte class-merge helper. */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** `tailwind-variants` bound to the same merge config — import THIS, not the package's `tv`. */
export const tv = createTV({ twMergeConfig });

/** Select a field's whole text with its start in view. Selecting scrolls a narrow field to the
 *  end, whichever way the selection runs, so it read "(Mutual funds)" without "HDFC";
 *  only resetting the scroll after the selection brings the start back (checked in Edge). Typing
 *  still replaces it all. */
export function selectFromStart(input: HTMLInputElement | null | undefined): void {
	if (!input) return;
	try {
		input.setSelectionRange(0, input.value.length, 'backward');
	} catch {
		input.select(); // a type with no text selection
	}
	input.scrollLeft = 0;
}

/** shadcn-svelte component type helpers (canonical). */
export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, 'child'> : T;
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
