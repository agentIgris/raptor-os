/**
 * A metric is EITHER a number you can reproduce or an absence you can explain.
 *
 * This type is the whole of deliverable 6's discipline, and it is a closed union
 * rather than a `value: number | null` for one reason: ADR-0019 records that the
 * legacy system rendered `totalMatches * 0.7` as "Win rate" and
 * `Math.ceil(totalMatches / 5)` as "Team Ranking". Both were *numbers*. A field
 * that may hold a number will always eventually hold an invented one, because
 * there is nothing in the type that makes an invention visible.
 *
 * So the two states are separate variants, each carrying what a reader needs in
 * order to judge it:
 *
 *   * `available` carries its own `numerator` and `denominator` alongside the
 *     value. Every figure ADR-0019 rule 2 demands — "reproducible from stored raw
 *     inputs" — is then a property of the value rather than a promise about the
 *     code that computed it. A reader can check `125 / 187` without running
 *     anything.
 *   * `unavailable` carries a {@link UnavailableReason}, drawn from a CLOSED set.
 *     A reason that cannot be spelled is a reason that does not exist, which is
 *     what makes "why is this missing?" answerable in every case.
 *
 * The reasons are not decoration. `no_rule_recovered` is how the metric layer
 * reports the absence ADR-0019 is most explicit about: there is no performance
 * formula in the legacy source to recover, so anything presented as one would be
 * an invention wearing a label. Reporting it absent, with that reason, is the
 * deliverable.
 *
 * Pure: no database, no network, no clock.
 */

import { minorToDecimal } from "../money/money.js";

/** Decimal places every computed ratio is reported at. */
export const RATIO_SCALE = 4;

/** Multiplier from a real ratio to its scaled integer form. */
export const RATIO_FACTOR = 10n ** BigInt(RATIO_SCALE);

/**
 * Why a metric could not be computed.
 *
 * CLOSED, and each member is a distinct claim:
 *
 *   * `no_events_in_window` — the window is genuinely empty. The metric is not
 *     unknown; the answer is zero events, and a report that says "0%" instead
 *     turns "nothing happened" into "everything failed".
 *   * `no_decided_events` — events happened but none of them were won or lost, so
 *     a win *rate* has no denominator. Three draws in a row is a real result and
 *     a genuinely undefined rate.
 *   * `zero_denominator` — the specific input the ratio needs was never recorded.
 *     ADR-0019 lists these: deaths were never tracked in the legacy system, so a
 *     K/D ratio had no denominator to divide by.
 *   * `input_not_tracked` — the raw input does not exist in this schema at all.
 *     ADR-0019 searched exhaustively and found no ADR, no ACS, no impact rating
 *     and no headshot formula anywhere, so a metric built on one would be built
 *     on nothing.
 *   * `no_rule_recovered` — the inputs exist but NO FORMULA was recoverable, so
 *     any value would be invented. This is the reason "Team Ranking" gets.
 */
export const UNAVAILABLE_REASONS = [
  "no_events_in_window",
  "no_decided_events",
  "zero_denominator",
  "input_not_tracked",
  "no_rule_recovered",
] as const;

export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export interface AvailableMetric {
  readonly key: string;
  readonly status: "available";
  /** The counted quantity the ratio is over. Zero for a plain count. */
  readonly numerator: bigint;
  readonly denominator: bigint;
  /** Always {@link RATIO_SCALE} decimal places. Never an exponent, never a float. */
  readonly value: string;
}

export interface UnavailableMetric {
  readonly key: string;
  readonly status: "unavailable";
  readonly reason: UnavailableReason;
  /** Why the number cannot be produced, in a sentence a product owner can read. */
  readonly explanation: string;
}

export type Metric = AvailableMetric | UnavailableMetric;

/**
 * Closed-set membership test.
 *
 * `as readonly string[]` rather than a cast, for the reason `obligations` records:
 * this is the one place a value from outside the type system is admitted.
 */
export function isUnavailableReason(reason: string): reason is UnavailableReason {
  return (UNAVAILABLE_REASONS as readonly string[]).includes(reason);
}

/**
 * A metric that IS computable.
 *
 * Refuses a negative numerator or denominator. A negative count is not a
 * measurement, and accepting one would let a corrupted row produce a confident
 * negative win rate rather than a refusal at the point it entered the system.
 */
export function available(key: string, numerator: bigint, denominator: bigint): AvailableMetric {
  if (key.trim() === "") {
    throw new Error("A metric must carry a key: a figure nobody can name is a figure nobody can check.");
  }
  if (numerator < 0n || denominator < 0n) {
    throw new Error(
      `Metric ${key} was built from a negative count (${numerator}/${denominator}); a negative count is not a measurement and is refused here rather than rendered as a confident negative percentage`,
    );
  }
  if (denominator === 0n) {
    throw new Error(
      `Metric ${key} was built with a zero denominator; an undefined ratio must be unavailable, not ${"0.0000"}. Use unavailableMetric() and say why.`,
    );
  }

  const scaledNumerator = numerator * RATIO_FACTOR;
  return Object.freeze({
    key,
    status: "available" as const,
    numerator,
    denominator,
    value: minorToDecimal(
      roundHalfUp(scaledNumerator / denominator, scaledNumerator % denominator, denominator),
    ),
  });
}

/** A plain count. Denominator 1, so the value reads as the count itself. */
export function count(key: string, quantity: bigint): AvailableMetric {
  if (quantity < 0n) {
    throw new Error(`Count ${key} is negative (${quantity}); a negative count is not a measurement.`);
  }
  return Object.freeze({
    key,
    status: "available" as const,
    numerator: quantity,
    denominator: 1n,
    value: quantity.toString(),
  });
}

/** A metric that CANNOT be computed, and why. */
export function unavailableMetric(key: string, reason: UnavailableReason, explanation: string): UnavailableMetric {
  if (key.trim() === "") {
    throw new Error("An unavailable metric must carry a key too: 'why is this missing?' has to name something.");
  }
  if (!isUnavailableReason(reason)) {
    throw new Error(
      `Metric ${key} claims it is unavailable for an unknown reason ${JSON.stringify(reason)}; expected one of ${UNAVAILABLE_REASONS.join(", ")}. An unrecognised reason is an invented one.`,
    );
  }
  if (explanation.trim() === "") {
    throw new Error(`Metric ${key} is unavailable for ${reason} but carries no explanation; an absence nobody can read is indistinguishable from a bug.`);
  }

  return Object.freeze({ key, status: "unavailable" as const, reason, explanation });
}

/**
 * Half-up rounding to an integer, in integer space.
 *
 * `remainder * 2n >= denominator` — comparing the doubled remainder against the
 * DENOMINATOR, not against 1n. An earlier draft compared it to `1n`, which is
 * true for every non-zero remainder, so every figure rounded up: 1/3 came out as
 * `0.3334` and 0.49994 came out as `0.5000`. Both are wrong by a different rule
 * from the one a reader would apply by hand, and both are the kind of error that
 * survives review because the number still looks plausible.
 *
 * `Math.round` is not used either: it is specified on the double, and this is
 * integer arithmetic that must not go near one.
 */
function roundHalfUp(scaled: bigint, remainder: bigint, denominator: bigint): bigint {
  return remainder * 2n >= denominator ? scaled + 1n : scaled;
}

/**
 * The ratio `numerator / denominator`, or ABSENT with a reason.
 *
 * The zero-denominator branch is the whole point. Returning `0` — or, as ADR-0019
 * records of the legacy system, returning `matches * 0.7` — for a window with no
 * decided events is precisely the fabrication this package exists to prevent.
 */
export function ratioOr(
  key: string,
  numerator: bigint,
  denominator: bigint,
  explanation: string,
  reason: UnavailableReason = "no_decided_events",
): Metric {
  if (denominator === 0n) {
    return unavailableMetric(key, reason, explanation);
  }
  return available(key, numerator, denominator);
}

/** Read a metric's number, or ABSENT. Never a default, never a zero. */
export function metricValue(metric: Metric): string | undefined {
  return metric.status === "available" ? metric.value : undefined;
}

/**
 * Every metric a report shows, keyed. `metric_index` is a list rather than an
 * object because REPORT ORDER is part of the contract: a caller rendering
 * `Object.values` of a map gets insertion order for strings, and relying on that
 * is how a report ends up in an order nobody chose.
 */
export interface MetricReport {
  readonly window: { readonly from: string; readonly to: string };
  readonly metrics: readonly Metric[];
}

/**
 * Index a report by key.
 *
 * Refuses a duplicate rather than letting the second silently overwrite the
 * first: two metrics answering to one name is the same ambiguity `obligations`
 * refuses when two parts share a `partId`.
 */
export function indexReport(report: MetricReport): ReadonlyMap<string, Metric> {
  const index = new Map<string, Metric>();
  for (const metric of report.metrics) {
    if (index.has(metric.key)) {
      throw new Error(`Report contains two metrics named ${metric.key}; one name must answer to one figure.`);
    }
    index.set(metric.key, metric);
  }
  return index;
}
