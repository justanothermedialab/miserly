import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CORE_READY } from '../src/index.js';

describe('M0 smoke test', () => {
  it('CORE_READY is true', () => {
    expect(CORE_READY).toBe(true);
  });

  it('fast-check harness runs (trivial reflexivity property)', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => n === n),
    );
  });
});
