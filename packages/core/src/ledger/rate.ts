/**
 * Exact exchange rates, as rationals.
 *
 * ## Why this module exists, and why it was extracted rather than written again
 *
 * ADR-0003 requires that an FX rate resolve **exactly** and that an inexact one
 * be refused rather than rounded. The ledger already enforced that, with the
 * rational arithmetic living privately inside `journal.ts`.
 *
 * A rate *book* — a stored, dated, as-of-queried set of rates — needs exactly
 * the same arithmetic: to invert a rate, to compose two hops, and to check that
 * a conversion lands on a whole number of minor units. Writing that a second time
 * is how two layers end up disagreeing about whether `1/0.012` is `83.333…` or
 * `83`, and a disagreement about FX is a disagreement about money.
 *
 * So this is **extracted**, not duplicated: `journal.ts` imports these functions
 * and its behaviour is unchanged, and `../fx/rate-book.ts` imports the same ones.
 * There is one implementation of "what is an exact rate", and a test asserts the
 * two consumers agree.
 *
 * ## Why a rational and not a decimal
 *
 * The reciprocal of a terminating decimal usually does not terminate:
 * `1 / 0.119 = 1000/119`. Rounding that to `8.40336134` makes an FX *reversal*
 * approximate, and an approximate reversal invents money — it returns slightly
 * more than it took. So a rate is carried as `numerator/denominator` in `bigint`
 * and rendered as a decimal only when one exists.
 *
 * Composition is exact for the same reason: `(a/b) · (c/d) = (ac/bd)` with no
 * rounding step at all, so a two-hop conversion carries no accumulated error.
 *
 * Pure: no clock, no I/O.
 */

const DECIMAL_RATE_PATTERN = /^\d+(\.\d+)?$/;
const FRACTION_RATE_PATTERN = /^(\d+)\/(\d+)$/;

/**
 * A rate as an exact rational.
 *
 * `numerator`/`denominator` are minor units of `to` per `denominator` minor
 * units of `from` — the same direction the ledger's `FxConversion` uses, so the
 * two are directly comparable.
 */
export interface ExactRate {
  readonly numerator: bigint;
  readonly denominator: bigint;
  /** Canonical text: one rate never has two spellings. */
  readonly text: string;
}

/**
 * Parse a rate into an exact rational, reduced to lowest terms.
 *
 * Both `0.119` and `119/1000` are accepted and both canonicalise to the same
 * text, so one economic event can never produce two different records — which is
 * what makes a stored rate comparable across systems.
 *
 * The canonical form is a decimal when the rate has one, and a fraction when it
 * does not, because the reciprocal of a terminating decimal usually does not
 * terminate and {@link invertRate} needs it exact.
 */
export function parseRate(rate: string): ExactRate {
  const text = rate.trim();
  const decimal = DECIMAL_RATE_PATTERN.exec(text);
  const fraction = decimal ? null : FRACTION_RATE_PATTERN.exec(text);

  if (!decimal && !fraction) {
    throw new Error(
      `Invalid conversion rate ${JSON.stringify(rate)}: expected a positive decimal such as "0.119" or an exact fraction such as "1000/119"`,
    );
  }

  let numerator: bigint;
  let denominator: bigint;

  if (fraction) {
    numerator = BigInt(fraction[1]!);
    denominator = BigInt(fraction[2]!);
  } else {
    const [whole = "0", fractionalPart = ""] = text.split(".");
    numerator = BigInt(`${whole}${fractionalPart}`);
    denominator = 10n ** BigInt(fractionalPart.length);
  }

  if (numerator <= 0n) {
    throw new Error(`Invalid conversion rate ${JSON.stringify(rate)}: the rate must be positive`);
  }
  if (denominator <= 0n) {
    throw new Error(`Invalid conversion rate ${JSON.stringify(rate)}: the rate's denominator must be positive`);
  }

  const divisor = greatestCommonDivisor(numerator, denominator);
  return {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
    text: canonicalRateText(numerator / divisor, denominator / divisor),
  };
}

/**
 * Render a reduced rational as a decimal if one exists, else as a fraction.
 *
 * A reduced fraction terminates in base 10 exactly when its denominator has no
 * prime factors other than 2 and 5. Anything else would need an infinite
 * expansion, so it stays a fraction rather than being truncated — a truncated
 * rate is a rate that has already lost money.
 */
export function canonicalRateText(numerator: bigint, denominator: bigint): string {
  let twos = 0;
  let fives = 0;
  let rest = denominator;
  while (rest % 2n === 0n) {
    rest /= 2n;
    twos++;
  }
  while (rest % 5n === 0n) {
    rest /= 5n;
    fives++;
  }

  if (rest !== 1n) {
    return `${numerator}/${denominator}`;
  }

  const scale = Math.max(twos, fives);
  if (scale === 0) {
    return numerator.toString();
  }

  const scaled = (numerator * 10n ** BigInt(scale)) / denominator;
  const digits = scaled.toString().padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** Greatest common divisor, by Euclid. Both arguments are positive on entry. */
export function greatestCommonDivisor(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x;
}

/**
 * The exact reciprocal, in canonical form.
 *
 * Kept in the rate vocabulary rather than computed as `1/rate` so nothing here
 * ever passes through floating point. The ledger's `reverseJournal` uses it, and
 * so does the rate book's inverse lookup — the same function, so a reversal and a
 * reverse lookup cannot disagree.
 */
export function invertRate(rate: string): string {
  const exact = parseRate(rate);
  return canonicalRateText(exact.denominator, exact.numerator);
}

/**
 * The exact product of two rates.
 *
 * Used for a two-hop conversion. Exact by construction: `(a/b)·(c/d) = ac/bd`,
 * with no intermediate rounding, so a chained conversion accumulates no error
 * that a single direct quote would not have.
 */
export function composeRates(first: string, second: string): string {
  const a = parseRate(first);
  const b = parseRate(second);
  const numerator = a.numerator * b.numerator;
  const denominator = a.denominator * b.denominator;
  const divisor = greatestCommonDivisor(numerator, denominator);
  return canonicalRateText(numerator / divisor, denominator / divisor);
}

/**
 * Apply a rate to an amount in minor units, exactly or not at all.
 *
 * Returns `null` when the result is not a whole number of minor units. It does
 * **not** throw, because the caller needs to distinguish "inexact" from
 * "malformed rate" — they are different failures with different fixes — and a
 * `null` here is a value the caller must handle rather than an exception it can
 * ignore.
 */
export function applyRateExact(minor: bigint, rate: string): bigint | null {
  const exact = parseRate(rate);
  const scaled = minor * exact.numerator;
  if (scaled % exact.denominator !== 0n) {
    return null;
  }
  return scaled / exact.denominator;
}
