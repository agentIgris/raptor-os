/**
 * Attendance: the cutoff rule, the derived status, and the rate.
 *
 * See `./cutoff.ts` for the recovered `cutoff_time < now` rule, `./status.ts` for
 * why `late` is now computed rather than self-declared, and `./rate.ts` for the
 * single definition that replaces five disagreeing legacy surfaces.
 */

export { isPastCutoff } from "./cutoff.js";
export type { AttendanceSession } from "./cutoff.js";

export { ATTENDANCE_STATUSES, isAttendanceStatus, resolveAttendanceStatus } from "./status.js";
export type { AttendanceStatus, ResolveAttendanceStatusInput } from "./status.js";

export { computeAttendanceRate } from "./rate.js";
export type { AttendanceRate, AttendanceRateOptions, AttendanceRecord } from "./rate.js";