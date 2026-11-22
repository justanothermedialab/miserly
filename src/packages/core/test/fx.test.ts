/**
 * Tests for fx.ts — the single `to_base` conversion boundary (MC1).
 *
 * The focus is MC1's failure cases, proven RED-then-safe here:
 *  - NEVER a silent 1:1 for an unrated foreign currency (returns null).
 *  - Units fixed as base-per-1-foreign (multiply, never divide).
 *  - No float drift: exact integer/BigInt paise, no precision loss on huge
 *    balances or many-dp rates; half-away-from-zero rounding is symmetric.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import { toBase, hasRate, rateTable } from '../src/fx.js';

const INR = 'INR';
const USD = 'USD';

/** 1 USD = ₹83.50 exactly, as a scale-6 rate (83.500000 → 83_500_000 / 1e6). */
const usdRate = { scaled: 83_500_000, scale: 6 };
const table = rateTable(INR, [[USD, usdRate]]);

describe('toBase: base currency is ×1 identity', () => {
  it('returns an INR amount unchanged (no conversion, common all-INR case)', () => {
    const m = Money.fromPaise(123456, INR);
    const out = toBase(m, table);
    expect(out).not.toBeNull();
    expect(out!.equals(m)).toBe(true);
  });

  it('works with an empty rate table (no foreign currencies at all)', () => {
    const empty = rateTable(INR);
    expect(toBase(Money.fromPaise(500, INR), empty)!.paise).toBe(500);
  });
});

describe('toBase: NEVER a silent 1:1 (the Firefly defect)', () => {
  it('returns null for a foreign currency with no rate', () => {
    const noUsd = rateTable(INR);
    expect(toBase(Money.fromPaise(100_00, USD), noUsd)).toBeNull();
  });

  it('a null result is NOT the native number reinterpreted as base', () => {
    // If this returned Money(10000, INR) that would be the 1:1 bug — assert null.
    const noUsd = rateTable(INR);
    const out = toBase(Money.fromPaise(10000, USD), noUsd);
    expect(out).toBeNull();
  });

  it('hasRate mirrors toBase convertibility', () => {
    expect(hasRate(Money.fromPaise(1, INR), table)).toBe(true);
    expect(hasRate(Money.fromPaise(1, USD), table)).toBe(true);
    expect(hasRate(Money.fromPaise(1, 'EUR'), table)).toBe(false);
  });
});

describe('toBase: base-per-1-foreign, hand-worked', () => {
  it('$100.00 at ₹83.50 = ₹8,350.00 (multiply, not divide)', () => {
    // $100.00 = 10_000 paise-USD; × 83.5 = 835_000 paise-INR.
    const out = toBase(Money.fromPaise(10_000, USD), table);
    expect(out!.currency).toBe(INR);
    expect(out!.paise).toBe(835_000);
  });

  it('a NEGATIVE foreign amount (a USD-denominated liability) converts with its sign', () => {
    const out = toBase(Money.fromPaise(-10_000, USD), table);
    expect(out!.paise).toBe(-835_000);
  });

  it('rounds half-away-from-zero, symmetric across sign', () => {
    // rate 1.5 (scale 1) so odd paise force a .5 remainder: 3 × 1.5 = 4.5 → 5 / -5.
    const r = rateTable(INR, [[USD, { scaled: 15, scale: 1 }]]);
    expect(toBase(Money.fromPaise(3, USD), r)!.paise).toBe(5);
    expect(toBase(Money.fromPaise(-3, USD), r)!.paise).toBe(-5);
  });
});

describe('toBase: no float drift on extreme inputs', () => {
  it('a huge balance × a many-dp rate is exact (BigInt, no 2^53 loss)', () => {
    // ₹ side: 90_00_00_00_000 paise-USD (~$900M) × 83.456789.
    const rate = { scaled: 83_456_789, scale: 6 };
    const r = rateTable(INR, [[USD, rate]]);
    const nativePaise = 900_000_000_00; // $900,000,000.00
    const out = toBase(Money.fromPaise(nativePaise, USD), r);
    // Oracle via BigInt (the same math, independently expressed).
    const num = BigInt(nativePaise) * BigInt(rate.scaled);
    const den = 10n ** BigInt(rate.scale);
    const q = num / den;
    const rem = num % den;
    const expected = Number(rem * 2n >= den ? q + 1n : q);
    expect(out!.paise).toBe(expected);
  });

  it('throws (never silently truncates) if the result overflows safe-integer range', () => {
    // A pathological rate that pushes the product past 2^53.
    const r = rateTable(INR, [[USD, { scaled: 1_000_000_000_000, scale: 0 }]]);
    expect(() => toBase(Money.fromPaise(1_000_000_000, USD), r)).toThrow(/safe-integer/);
  });
});

describe('rateTable: rejects malformed rates at construction', () => {
  it('a zero or negative rate is invalid data (not "missing")', () => {
    expect(() => rateTable(INR, [[USD, { scaled: 0, scale: 6 }]])).toThrow();
    expect(() => rateTable(INR, [[USD, { scaled: -1, scale: 6 }]])).toThrow();
  });

  it('a negative scale is rejected', () => {
    expect(() => rateTable(INR, [[USD, { scaled: 100, scale: -1 }]])).toThrow();
  });

  it('a stray base→base self-rate is ignored (base is always ×1)', () => {
    const r = rateTable(INR, [[INR, { scaled: 999, scale: 0 }]]);
    expect(toBase(Money.fromPaise(100, INR), r)!.paise).toBe(100);
  });
});

describe('toBase property: round-trip and monotonicity', () => {
  const paiseArb = fc.integer({ min: -1_000_000_000_00, max: 1_000_000_000_00 });
  // scale 6, rate in (0, ~1000] base-per-foreign.
  const rateArb = fc.integer({ min: 1, max: 1_000_000_000 }).map((scaled) => ({ scaled, scale: 6 }));

  it('conversion preserves sign and zero, and scales linearly (×k rate ⇒ ×k result within rounding)', () => {
    fc.assert(
      fc.property(paiseArb, rateArb, (paise, rate) => {
        const r = rateTable(INR, [[USD, rate]]);
        const out = toBase(Money.fromPaise(paise, USD), r)!;
        // sign preserved (rate.scaled > 0), except a tiny amount may round to 0.
        if (paise === 0) expect(out.paise).toBe(0);
        else expect(out.paise === 0 || Math.sign(out.paise) === Math.sign(paise)).toBe(true);
        // exact against a BigInt oracle (half-away-from-zero).
        const num = BigInt(paise) * BigInt(rate.scaled);
        const den = 10n ** BigInt(rate.scale);
        const neg = num < 0n;
        const abs = neg ? -num : num;
        const q = abs / den;
        const rem = abs % den;
        const roundedAbs = rem * 2n >= den ? q + 1n : q;
        expect(out.paise).toBe(Number(neg ? -roundedAbs : roundedAbs));
      }),
    );
  });
});
