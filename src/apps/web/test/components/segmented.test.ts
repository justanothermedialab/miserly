import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import Segmented from '$lib/components/Segmented.svelte';

// Hunt walk, session 3 part 2: clicking the selected segment again made Bits emit '' and the
// theme control posted theme "" (400). A segmented control always keeps one selection.
afterEach(cleanup);

const options = [
	{ value: 'system', label: 'System' },
	{ value: 'light', label: 'Light' },
	{ value: 'dark', label: 'Dark' }
];

describe('Segmented', () => {
	it('re-clicking the selected segment changes nothing', async () => {
		const onChange = vi.fn();
		const { getByRole } = render(Segmented, { options, value: 'light', onChange, ariaLabel: 'Theme' });
		await fireEvent.click(getByRole('radio', { name: 'Light' }));
		await fireEvent.click(getByRole('radio', { name: 'Light' }));
		expect(onChange).not.toHaveBeenCalled();
		expect(getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true');
	});

	it('a different segment reports its value once', async () => {
		const onChange = vi.fn();
		const { getByRole } = render(Segmented, { options, value: 'light', onChange, ariaLabel: 'Theme' });
		await fireEvent.click(getByRole('radio', { name: 'Dark' }));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith('dark');
	});
});
