/**
 * Exact money.
 *
 * Amounts are a `bigint` of minor units at a fixed scale of 4 decimal places,
 * matching Postgres `numeric(18,4)`. Floating point is never used for money:
 * it cannot represent 0.1 exactly, and a prize pool that loses a cent is a
 * prize pool nobody trusts.
 *
 * Every monetary value carries an ISO 4217 currency code. There is no global
 * currency and no implicit currency — combining two currencies throws rather
 * than guessing.
 */

/** Number of decimal places held by {@link Money}. */
export const MONEY_SCALE = 4;

/** Multiplier from a major-unit amount to minor units. */
export const MONEY_FACTOR = 10n ** BigInt(MONEY_SCALE);

/** An ISO 4217 alphabetic currency code, e.g. `INR`, `USD`, `EUR`. */
export type CurrencyCode = string;

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface Money {
  /** Amount in minor units (1 major unit = 10^MONEY_SCALE minor units). */
  readonly minor: bigint;
  readonly currency: CurrencyCode;

  add(other: Money): Money;
  subtract(other: Money): Money;
  multiply(factor: bigint): Money;
  negate(): Money;
  absolute(): Money;
  compare(other: Money): -1 | 0 | 1;
  equals(other: Money): boolean;
  isNegative(): boolean;
  isZero(): boolean;
  /** Render as a fixed 4-decimal string, e.g. `"1234.5600"`. */
  toDecimal(): string;
  toString(): string;
}

/**
 * Build money from a decimal string.
 *
 * Rejects more than four decimal places rather than silently rounding, because
 * a silent rounding here surfaces later as an unexplained allocation variance.
 */
export function money(amount: string | number | bigint, currency: CurrencyCode): Money {
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
    throw new Error(`Invalid currency code: ${JSON.stringify(currency)} (expected ISO 4217 alphabetic code)`);
  }

  const text =
    typeof amount === "bigint"
      ? `${amount}.0000`
      : typeof amount === "number"
        ? numberToDecimalString(amount)
        : amount.trim();

  if (!DECIMAL_PATTERN.test(text)) {
    throw new Error(`Invalid monetary amount: ${JSON.stringify(amount)}`);
  }

  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole = "0", fraction = ""] = unsigned.split(".");

  if (fraction.length > MONEY_SCALE) {
    throw new Error(
      `Amount ${text} exceeds ${MONEY_SCALE}-decimal precision supported by numeric(18,4); refusing to round silently`,
    );
  }

  const padded = fraction.padEnd(MONEY_SCALE, "0");
  const minor = BigInt(`${whole}${padded}`) * (negative ? -1n : 1n);

  return make(minor, currency);
}

function make(minor: bigint, currency: CurrencyCode): Money {
  const self: Money = {
    minor,
    currency,
    add(other: Money): Money {
      assertSameCurrency(self, other);
      return make(self.minor + other.minor, self.currency);
    },
    subtract(other: Money): Money {
      assertSameCurrency(self, other);
      return make(self.minor - other.minor, self.currency);
    },
    multiply(factor: bigint): Money {
      return make(self.minor * factor, self.currency);
    },
    negate(): Money {
      return make(-self.minor, self.currency);
    },
    absolute(): Money {
      return make(self.minor < 0n ? -self.minor : self.minor, self.currency);
    },
    compare(other: Money): -1 | 0 | 1 {
      assertSameCurrency(self, other);
      if (self.minor < other.minor) return -1;
      if (self.minor > other.minor) return 1;
      return 0;
    },
    equals(other: Money): boolean {
      return self.currency === other.currency && self.minor === other.minor;
    },
    isNegative(): boolean {
      return self.minor < 0n;
    },
    isZero(): boolean {
      return self.minor === 0n;
    },
    toDecimal(): string {
      const negative = self.minor < 0n;
      const digits = (negative ? -self.minor : self.minor).toString().padStart(MONEY_SCALE + 1, "0");
      const whole = digits.slice(0, -MONEY_SCALE);
      const fraction = digits.slice(-MONEY_SCALE);
      return `${negative ? "-" : ""}${whole}.${fraction}`;
    },
    toString(): string {
      return `${self.toDecimal()} ${self.currency}`;
    },
  };
  return Object.freeze(self);
}

/** Zero in the given currency. */
export function zero(currency: CurrencyCode): Money {
  return make(0n, currency);
}

/** Sum a list of amounts. All must share the given currency. */
export function sumMoney(values: readonly Money[], currency: CurrencyCode): Money {
  return values.reduce<Money>((acc, value) => acc.add(value), zero(currency));
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: cannot combine ${a.currency} with ${b.currency}`);
  }
}

/**
 * Parse a percentage into a `bigint` scaled by 1e4, so `"100"` becomes
 * 1_000_000 and `"30"` becomes 300_000.
 *
 * Share arithmetic stays in integer space and never touches floating point.
 */
export function parsePercent(percent: string, field: string): bigint {
  const text = percent.trim();
  if (!DECIMAL_PATTERN.test(text)) {
    throw new Error(`Invalid ${field}: ${JSON.stringify(percent)}`);
  }

  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole = "0", fraction = ""] = unsigned.split(".");

  if (fraction.length > 4) {
    throw new Error(`Invalid ${field}: ${percent} has more than 4 decimal places`);
  }

  const padded = fraction.padEnd(4, "0");
  const scaled = BigInt(`${whole}${padded}`) * (negative ? -1n : 1n);

  if (scaled < 0n) {
    throw new Error(`Invalid ${field}: ${percent} must not be negative`);
  }

  return scaled;
}

function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid monetary amount: ${value}`);
  }
  return value.toFixed(MONEY_SCALE);
}