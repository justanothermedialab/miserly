/**
 * Money — an immutable, currency-tagged integer-paise value object.
 *
 * 1 rupee = 100 paise. All amounts are stored as integer paise; there is
 * NO floating-point path. Construction from a non-integer throws.
 *
 * Sign convention: negative = outflow / liability-direction, positive =
 * inflow. Zero is a valid, meaningful amount (e.g. a wash entry).
 *
 * Currency safety: `add`, `subtract`, and `compare` all throw when the two
 * operands' currencies differ. Cross-currency conversion (`to_base`) is a
 * LATER milestone and is intentionally not implemented here.
 *
 * No formatting/locale logic lives here — that belongs to a display layer
 * (e.g. Indian lakh/crore vs Western K/M/B grouping), not the domain engine.
 */

export type CurrencyCode = string;

export class Money {
  readonly paise: number;
  readonly currency: CurrencyCode;

  private constructor(paise: number, currency: CurrencyCode) {
    this.paise = paise;
    this.currency = currency;
    Object.freeze(this);
  }

  /** Construct from an integer paise amount. Throws if `paise` is not an integer. */
  static fromPaise(paise: number, currency: CurrencyCode): Money {
    if (!Number.isInteger(paise)) {
      throw new TypeError(
        `Money.fromPaise: paise amount must be an integer, got ${paise}`,
      );
    }
    return new Money(paise, currency);
  }

  static zero(currency: CurrencyCode): Money {
    return new Money(0, currency);
  }

  private assertSameCurrency(other: Money, op: string): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Money.${op}: currency mismatch (${this.currency} vs ${other.currency}); ` +
          'cross-currency operations require explicit conversion (not yet implemented).',
      );
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other, 'add');
    return new Money(this.paise + other.paise, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other, 'subtract');
    return new Money(this.paise - other.paise, this.currency);
  }

  negate(): Money {
    return new Money(-this.paise, this.currency);
  }

  /** −1 if this < other, 0 if equal, 1 if this > other. Throws on currency mismatch. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other, 'compare');
    if (this.paise < other.paise) return -1;
    if (this.paise > other.paise) return 1;
    return 0;
  }

  /** Equality of amount AND currency (never throws; different currencies are simply unequal). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.paise === other.paise;
  }

  isZero(): boolean {
    return this.paise === 0;
  }
}
