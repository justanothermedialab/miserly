import { describe, expect, it } from 'vitest';
import { Money } from '../src/money.js';

describe('Money: example-based', () => {
  it('constructs from integer paise and exposes currency', () => {
    const m = Money.fromPaise(150_00, 'INR');
    expect(m.paise).toBe(150_00);
    expect(m.currency).toBe('INR');
  });

  it('cross-currency add throws', () => {
    const inr = Money.fromPaise(100_00, 'INR');
    const usd = Money.fromPaise(100_00, 'USD');
    expect(() => inr.add(usd)).toThrow();
  });

  it('cross-currency subtract throws', () => {
    const inr = Money.fromPaise(100_00, 'INR');
    const usd = Money.fromPaise(100_00, 'USD');
    expect(() => inr.subtract(usd)).toThrow();
  });

  it('cross-currency compare throws', () => {
    const inr = Money.fromPaise(100_00, 'INR');
    const usd = Money.fromPaise(100_00, 'USD');
    expect(() => inr.compare(usd)).toThrow();
  });

  it('rejects non-integer paise amounts', () => {
    expect(() => Money.fromPaise(10.5, 'INR')).toThrow();
  });

  it('negate flips sign, isZero detects zero', () => {
    const m = Money.fromPaise(500, 'INR');
    expect(m.negate().paise).toBe(-500);
    expect(Money.zero('INR').isZero()).toBe(true);
    expect(m.isZero()).toBe(false);
  });

  it('compare returns -1/0/1', () => {
    const a = Money.fromPaise(100, 'INR');
    const b = Money.fromPaise(200, 'INR');
    expect(a.compare(b)).toBe(-1);
    expect(b.compare(a)).toBe(1);
    expect(a.compare(a)).toBe(0);
  });

  it('equals requires same currency and amount', () => {
    const a = Money.fromPaise(100, 'INR');
    const b = Money.fromPaise(100, 'USD');
    const c = Money.fromPaise(100, 'INR');
    expect(a.equals(c)).toBe(true);
    expect(a.equals(b)).toBe(false);
  });
});
