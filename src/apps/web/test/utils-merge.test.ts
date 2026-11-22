/**
 * utils-merge.test.ts — `cn` / `tv` know the design-system utilities: the type
 * ramp is a FONT SIZE (a later colour class must not drop it) and the radius
 * pair is a radius.
 */
import { describe, expect, it } from 'vitest';
import { cn, tv } from '../src/lib/utils';

describe('cn (tailwind-merge with the design tokens)', () => {
	it('keeps a ramp size next to a text colour', () => {
		expect(cn('text-caption', 'text-text-muted')).toBe('text-caption text-text-muted');
		expect(cn('text-body text-primary-foreground')).toBe('text-body text-primary-foreground');
	});
	it('lets a later ramp size win over an earlier one', () => {
		expect(cn('text-body', 'text-caption')).toBe('text-caption');
	});
	it('treats rounded-control / rounded-overlay as one radius group', () => {
		expect(cn('rounded-control', 'rounded-overlay')).toBe('rounded-overlay');
	});
});

describe('tv (tailwind-variants bound to the same config)', () => {
	it('keeps the base size when a variant adds a colour', () => {
		const b = tv({ base: 'text-body', variants: { v: { a: 'text-primary-foreground' } } });
		expect(b({ v: 'a' })).toBe('text-body text-primary-foreground');
	});
});
