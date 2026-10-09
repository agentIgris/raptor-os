/**
 * The attendance cutoff: when a session stops accepting attendance.
 *
 * Recovered verbatim from `automation-scripts/02-session-attendance-automation.sql:88-139`
 * as `cutoff_time < CURRENT_TIME` (ADR-0016 §1). Two properties of that rule are
 * load-bearing and are reproduced exactly:
 *
 * 1. **Strict less-than.** The instant of the cutoff itself is still open. One
 *    millisecond later it is closed. The legacy system shipped an off-by-one at
 *    this boundary because it compared timestamps as *strings*; comparing epoch
 *    milliseconds cannot reproduce that class of bug.
 * 2. **The session's start time is never consulted.** `cutoff_time` is an
 *    independent column on the session row, not derived from its start. There is
 *    no offset, no grace period, and no "cutoff is start + N minutes" anywhere.
 *
 * Both are pinned by tests, because a boundary that is only correct by reading
 * is a boundary that drifts the first time someone "tidies up" the comparison.
 *
 * This module is pure: `now` is an argument. Reading the clock here would make
 * every caller untestable and would hide the fact that the caller's idea of "now"
 * may be a transaction timestamp, a replayed request, or a test fixture.
 */

/** The fields of a session the cutoff rule needs, and nothing more. */
export interface AttendanceSession {
  readonly id: string;
  readonly organizationId: string;
  /** Scheduled start. Present for the record; deliberately never compared against. */
  readonly startTime: Date;
  /** The instant attendance closes. Compared strictly against `now`. */
  readonly cutoffTime: Date;
}

/**
 * Whether a session is past its attendance cutoff.
 *
 * Returns `true` only when `cutoffTime` is **strictly before** `now`. At exactly
 * the cutoff instant it returns `false`: the session is still open.
 *
 * Takes `now` as an argument and never reads a clock. That is what allows the
 * cutoff automation to be tested at the millisecond, which is the only way the
 * boundary is worth having.
 */
export function isPastCutoff(session: AttendanceSession, now: Date): boolean {
  const { cutoffTime } = session;

  assertValidDate(cutoffTime, "cutoffTime");
  assertValidDate(session.startTime, "startTime");
  assertValidDate(now, "now");

  if (cutoffTime.getTime() < session.startTime.getTime()) {
    // Not in the recovered rule, which compared only cutoff against now. Enforced
    // because a cutoff before the session begins is a data error, and reading it
    // as "closed" would mark an entire roster absent for a session that has not
    // started. Failing loudly beats a plausible wrong answer.
    throw new Error(
      `Session ${session.id} has a cutoffTime before its startTime; the cutoff is an independent column and must not precede the session`,
    );
  }

  return cutoffTime.getTime() < now.getTime();
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`Invalid ${field}: expected a valid Date`);
  }
}