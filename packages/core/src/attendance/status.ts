/**
 * Attendance status, and how `late` finally becomes computable.
 *
 * The legacy system had five status literals and computed exactly one of them.
 * `absent` was the only status any system decided on its own; `late` was a
 * button the player clicked (`components/attendance/session-attendance.tsx:163-178`)
 * and no arrival timestamp was ever stored, so *after the fact* the difference
 * between `late` and `present` was unrecoverable. Two players, one present on
 * time and one forty minutes in, held byte-identical rows (ADR-0016 §2).
 *
 * A self-declared status cannot be used to decide anything, so it is not an
 * input here. `resolveAttendanceStatus` takes the recorded arrival instant and
 * derives the status. That is the whole point of ADR-0016's conclusion: the
 * schema needs a recorded arrival instant, and once it has one, `late` stops
 * being a matter of trust.
 *
 * The lateness threshold is a *parameter*. The legacy system had no threshold at
 * all — `late` meant "the player said so" — so no number here is recovered from
 * the source. Picking one per call site is what keeps that honest: the value is
 * a policy decision of the tenant, stated where it is applied, rather than a
 * constant that silently becomes "the rule" after the first caller.
 *
 * This module is pure. It reads no clock: the arrival instant and the scheduled
 * start are both inputs.
 */

/**
 * The five status literals, in the order the legacy schema declared them.
 *
 * A closed vocabulary rather than free text, because `attendances.status` in the
 * legacy database was a `text` column written by four different surfaces with
 * four different meanings. `isAttendanceStatus` is the narrowing used at the
 * read boundary.
 *
 * - `present` — arrived within the threshold.
 * - `late` — arrived, but after the threshold. Now derived, never self-declared.
 * - `absent` — no arrival recorded.
 * - `excused` — **not supported by the legacy system for player sessions.** It
 *   exists in the schema vocabulary but nothing wrote it, so any `excused` row in
 *   a legacy database was hand-inserted or a typo. It is modelled here because
 *   an organisation that wants it needs it to be a first-class status that rate
 *   arithmetic can reason about, not a free-text escape hatch.
 * - `auto` — the sentinel the conflicting `auto_mark_absent_after_cutoff`
 *   triggers wrote. ADR-0016 lists it as genuinely undecidable: it was read as
 *   *present* in one endpoint, *absent* in another, and as *neither* in a third.
 *   It is kept in the vocabulary only so legacy rows round-trip; it is never
 *   produced by {@link resolveAttendanceStatus} and never counts as attendance
 *   (see `./rate.ts`).
 */
export const ATTENDANCE_STATUSES = ["present", "late", "absent", "excused", "auto"] as const;

export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set(ATTENDANCE_STATUSES);

/** Narrows an untrusted string to an {@link AttendanceStatus}. Used at read boundaries. */
export function isAttendanceStatus(value: string): value is AttendanceStatus {
  return STATUS_SET.has(value);
}

export interface ResolveAttendanceStatusInput {
  /** When the session was scheduled to begin. */
  readonly sessionStartAt: Date;
  /**
   * When the player actually arrived, or `null` when no arrival was recorded.
   *
   * `null` is not the same as "arrived late" and is not the same as "did not
   * attend": it means nobody wrote an arrival down. It resolves to `absent`
   * because that is the only status the legacy system ever decided on its own,
   * and because an unrecorded arrival cannot be argued about later.
   */
  readonly arrivalAt: Date | null;
  /** Milliseconds after `sessionStartAt` within which an arrival is still on time. */
  readonly lateThresholdMs: number;
}

/**
 * Derive an attendance status from a recorded arrival.
 *
 * Returns only `present`, `late` or `absent`. It cannot return `excused` or
 * `auto`: those are human judgements, and a function that could emit them would
 * let an unobserved status be manufactured from a timestamp.
 *
 * Lateness is **strictly greater than** the threshold, so an arrival exactly on
 * the threshold is `present`. The boundary is pinned by a test because the
 * legacy system got a boundary of its own wrong, comparing timestamps as strings.
 */
export function resolveAttendanceStatus(input: ResolveAttendanceStatusInput): "present" | "late" | "absent" {
  const { sessionStartAt, arrivalAt, lateThresholdMs } = input;

  assertValidDate(sessionStartAt, "sessionStartAt");
  assertValidDate(arrivalAt, "arrivalAt");
  assertValidThreshold(lateThresholdMs);

  if (arrivalAt === null) return "absent";

  const deadline = sessionStartAt.getTime() + lateThresholdMs;
  return arrivalAt.getTime() > deadline ? "late" : "present";
}

function assertValidDate(value: Date | null, field: string): void {
  if (value === null) return;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`Invalid ${field}: expected a valid Date or null`);
  }
}

function assertValidThreshold(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    // A fractional or negative threshold makes the on-time boundary depend on
    // float comparison order, which is how a "you were late" dispute starts.
    throw new Error(`Invalid lateThresholdMs: expected a non-negative integer number of milliseconds, got ${String(value)}`);
  }
}