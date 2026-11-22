import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';

const paiseArb = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 });

describe('Money property: paise round-trip', () => {
  it('constructing from an integer paise amount preserves it exactly', () => {
    fc.assert(
      fc.property(paiseArb, (paise) => {
        const m = Money.fromPaise(paise, 'INR');
        expect(m.paise).toBe(paise);
      }),
    );
  });
});

describe('Money property: add is associative and commutative (same currency)', () => {
  it('commutative: a.add(b) === b.add(a)', () => {
    fc.assert(
      fc.property(paiseArb, paiseArb, (a, b) => {
        const ma = Money.fromPaise(a, 'INR');
        const mb = Money.fromPaise(b, 'INR');
        expect(ma.add(mb).equals(mb.add(ma))).toBe(true);
      }),
    );
  });

  it('associative: (a.add(b)).add(c) === a.add(b.add(c))', () => {
    fc.assert(
      fc.property(paiseArb, paiseArb, paiseArb, (a, b, c) => {
        const ma = Money.fromPaise(a, 'INR');
        const mb = Money.fromPaise(b, 'INR');
        const mc = Money.fromPaise(c, 'INR');
        const left = ma.add(mb).add(mc);
        const right = ma.add(mb.add(mc));
        expect(left.equals(right)).toBe(true);
      }),
    );
  });
});

describe('Money property: negate is an involution', () => {
  it('negate(negate(x)) === x', () => {
    fc.assert(
      fc.property(paiseArb, (p) => {
        const m = Money.fromPaise(p, 'INR');
        expect(m.negate().negate().equals(m)).toBe(true);
      }),
    );
  });
});

describe('Money property: construction rejects non-integers', () => {
  it('throws for any non-integer finite number', () => {
    const nonIntegerArb = fc
      .double({ noNaN: true, noDefaultInfinity: true, min: -1_000_000, max: 1_000_000 })
      .filter((n) => !Number.isInteger(n));

    fc.assert(
      fc.property(nonIntegerArb, (n) => {
        expect(() => Money.fromPaise(n, 'INR')).toThrow();
      }),
    );
  });
});

describe('Money property: cross-currency operations throw', () => {
  const currencyPairArb = fc
    .tuple(fc.constantFrom('INR', 'USD', 'EUR'), fc.constantFrom('INR', 'USD', 'EUR'))
    .filter(([a, b]) => a !== b);

  it('add throws across differing currencies', () => {
    fc.assert(
      fc.property(currencyPairArb, paiseArb, paiseArb, ([curA, curB], a, b) => {
        const ma = Money.fromPaise(a, curA);
        const mb = Money.fromPaise(b, curB);
        expect(() => ma.add(mb)).toThrow();
      }),
    );
  });

  it('subtract and compare also throw across differing currencies', () => {
    fc.assert(
      fc.property(currencyPairArb, paiseArb, paiseArb, ([curA, curB], a, b) => {
        const ma = Money.fromPaise(a, curA);
        const mb = Money.fromPaise(b, curB);
        expect(() => ma.subtract(mb)).toThrow();
        expect(() => ma.compare(mb)).toThrow();
      }),
    );
  });
});
