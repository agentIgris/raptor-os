/**
 * Attendance rate — with exactly one definition.
 *
 * The legacy system computed this figure on **five** surfaces and the five did
 * not agree. Some counted `late` as attended; one excluded it. The `'auto'`
 * sentinel was treated as *present* in one endpoint, *absent* in another, and as
 * *neither* in a third (ADR-0016, "Deliberately NOT carried"). The practical
 * consequence was that the same player, on the same day, was shown a different
 * attendance rate depending on which screen they asked.
 *
 * That is not a set of options to be chosen between. It is one metric that was
 * never defined, so it is defined here, once:
 *
 * > **Numerator**   = records with status `present` or `late`.
 * > **Denominator** = every record whose status is `present`, `late`, `absent`
 * >                  or `excused`.
 * > **Rate**        = numerator / denominator, as a percentage to two decimals.
 *
 * Two decisions follow, and each is deliberate:
 *
 * - **`late` counts as attended.** Lateness is a conduct question, not an
 *   attendance one. A player who showed up forty minutes late attended; whether
 *   that is acceptable is a separate policy that must not be smuggled into the
 *   denominator of a metric that claims to measure attendance.
 * - **`auto` is excluded from both sides.** `auto` is the sentinel the three
 *   conflicting `auto_mark_absent_after_cutoff` triggers wrote. It means the
 *   system reached no conclusion. Counting it as present rewards a bug; counting
 *   it as absent punishes a player for the system's indecision. It is excluded,
 *   and its volume is reported separately as `excludedUndecided` so it is
 *   visible rather than silently dropped.
 *
 * `excused` stays in the denominator. Excusing an absence is an administrative
 * act; if it also removed the session from the metric, an organisation could
 * raise any player's rate by excusing them.
 *
 * The result is a plain number rather than a percentage `bigint`: it is a
 * reporting statistic displayed to a manager, it never becomes money, and ADR-0003
 * governs monetary amounts. The underlying counts are returned alongside it so a
 * caller can always see the derivation, and `hasDenominator` distinguishes a
 * genuine 0% from "nothing to measure yet".
 */

import type { AttendanceStatus } from "./status.js";
import { ATTENDANCE_STATUSES } from "./status.js";

/** One player's recorded status for one session. */
export interface AttendanceRecord {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly playerId: string;
  readonly status: AttendanceStatus;
}

export interface AttendanceRateOptions {
  /** When given, records from other tenants are ignored before counting. */
  readonly organizationId?: string;
}

export interface AttendanceRate {
  /** `present` + `late`. */
  readonly attended: number;
  /** Every record that represents a decision: all but `auto`. */
  readonly countable: number;
  /**
   * Percentage to two decimal places, or `0` when `countable` is `0`.
   * Use {@link AttendanceRate.hasDenominator} to tell "attended nothing" from
   * "has nothing to measure".
   */
  readonly attendanceRatePercent: number;
  readonly excludedUndecided: number;
  /** False when `countable` is 0, so a 0% can be read as "unknown", not "awful". */
  readonly hasDenominator: boolean;
  /** Per-status counts, excluding `auto`, which is reported on its own field. */
  readonly breakdown: Readonly<Record<Exclude<AttendanceStatus, "auto">, number>>;
}

const ZERO_BREAKDOWN: AttendanceRate["breakdown"] = { present: 0, late: 0, absent: 0, excused: 0 };

/**
 * Compute an attendance rate under the single definition documented above.
 *
 * Pure: no clock, no I/O. Records are validated against the status vocabulary so
 * an unexpected value is a loud error rather than a silently uncounted row.
 */
export function computeAttendanceRate(
  records: readonly AttendanceRecord[],
  options: AttendanceRateOptions = {},
): AttendanceRate {
  const scope = options.organizationId;
  const inScope = scope === undefined ? records : records.filter((record) => record.organizationId === scope);

  const breakdown = { ...ZERO_BREAKDOWN };
  let excludedUndecided = 0;

  for (const record of inScope) {
    const status = record.status;

    if (!isKnownStatus(status)) {
      throw new Error(
        `Attendance record ${record.sessionId}/${record.playerId} has unknown status ${JSON.stringify(status)}; expected one of ${ATTENDANCE_STATUSES.join(", ")}`,
      );
    }

    if (status === "auto") {
      excludedUndecided += 1;
      continue;
    }

    breakdown[status] += 1;
  }

  const attended = breakdown.present + breakdown.late;
  const countable = attended + breakdown.absent + breakdown.excused;

  return {
    attended,
    countable,
    attendanceRatePercent: countable === 0 ? 0 : percentToTwoDecimals(attended, countable),
    excludedUndecided,
    hasDenominator: countable > 0,
    breakdown,
  };
}

function isKnownStatus(value: string): value is AttendanceStatus {
  return (ATTENDANCE_STATUSES as readonly string[]).includes(value);
}

/**
 * `attended / countable` as a percentage to exactly two decimals.
 *
 * Computed as `attended * 10000 / countable` in integer `bigint` arithmetic and
 * only then converted to a `number`, rather than as `(a / b) * 100` in floats.
 * The float route is where a rate starts printing 55.55 on one run and 55.56 on
 * the next for the identical input, and a statistic that is not reproducible is
 * not a statistic.
 *
 * Rounding is half-up on the exact rational, computed entirely in integers.
 */
function percentToTwoDecimals(attended: number, countable: number): number {
  // Both are record counts, so both are non-negative and `countable` is known
  // non-zero by the caller's guard. There is no sign handling here because there
  // is no negative case to handle — a rate that could go negative would be a bug
  // upstream, not something to paper over at the rounding step.
  const numerator = BigInt(attended) * 10_000n;
  const denominator = BigInt(countable);

  // floor((2n + d) / 2d) is round-half-up on the exact rational n / d.
  const hundredths = (numerator * 2n + denominator) / (denominator * 2n);

  return Number(hundredths) / 100;
}