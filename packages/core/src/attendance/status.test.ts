import { describe, expect, it } from "vitest";

import type { ResolveAttendanceStatusInput } from "./status.js";
import { ATTENDANCE_STATUSES, isAttendanceStatus, resolveAttendanceStatus } from "./status.js";

const START = new Date("2026-06-15T06:00:00.000Z");
const MINUTE = 60_000;

/** The threshold every test uses unless it is specifically about the threshold. */
const FIFTEEN_MINUTES = 15 * MINUTE;

function input(overrides: Partial<ResolveAttendanceStatusInput> = {}): ResolveAttendanceStatusInput {
  return {
    sessionStartAt: START,
    arrivalAt: START,
    lateThresholdMs: FIFTEEN_MINUTES,
    ...overrides,
  };
}

function at(offsetMs: number): Date {
  return new Date(START.getTime() + offsetMs);
}

describe("the attendance status vocabulary", () => {
  it("is exactly the five legacy literals, in the order the schema declared them", () => {
    expect(ATTENDANCE_STATUSES).toEqual(["present", "late", "absent", "excused", "auto"]);
  });

  it("narrows an untrusted string from the database", () => {
    expect(isAttendanceStatus("late")).toBe(true);
    expect(isAttendanceStatus("auto")).toBe(true);
    expect(isAttendanceStatus("absent ")).toBe(false);
    expect(isAttendanceStatus("tardy")).toBe(false);
  });
});

describe("resolveAttendanceStatus", () => {
  it("derives `present` for an arrival exactly at the scheduled start", () => {
    expect(resolveAttendanceStatus(input({ arrivalAt: at(0) }))).toBe("present");
  });

  it("derives `present` for an arrival exactly on the threshold, because lateness is strictly greater", () => {
    expect(resolveAttendanceStatus(input({ arrivalAt: at(FIFTEEN_MINUTES) }))).toBe("present");
  });

  it("derives `late` one millisecond past the threshold", () => {
    expect(resolveAttendanceStatus(input({ arrivalAt: at(FIFTEEN_MINUTES + 1) }))).toBe("late");
  });

  it("derives `present` for an early arrival, because turning up early is not a fault", () => {
    expect(resolveAttendanceStatus(input({ arrivalAt: at(-90 * MINUTE) }))).toBe("present");
  });

  it("derives `absent` when no arrival was recorded at all", () => {
    expect(resolveAttendanceStatus(input({ arrivalAt: null }))).toBe("absent");
  });

  it("treats a zero threshold as strict, so only a late arrival is late", () => {
    expect(resolveAttendanceStatus(input({ lateThresholdMs: 0, arrivalAt: at(0) }))).toBe("present");
    expect(resolveAttendanceStatus(input({ lateThresholdMs: 0, arrivalAt: at(1) }))).toBe("late");
  });

  it("never derives `excused` or `auto`, across the whole arrival space", () => {
    // `excused` is a manager's judgement and `auto` is the legacy system's own
    // indecision. Neither is an observation about a player's arrival, so neither
    // may come out of a function that only sees an arrival timestamp. If one ever
    // does, a player has been penalised by a rule that never asked a question.
    const arrivals = [null, at(-60 * MINUTE), at(0), at(FIFTEEN_MINUTES), at(FIFTEEN_MINUTES + 1), at(6 * 60 * MINUTE)];

    // Widened deliberately: the return type is already `"present" | "late" |
    // "absent"`, so these two members are rejected at compile time. This test
    // re-checks them at runtime, where the value came off a database row rather
    // than off the type checker.
    const derived = new Set<string>(arrivals.map((arrivalAt) => resolveAttendanceStatus(input({ arrivalAt }))));

    expect([...derived].sort()).toEqual(["absent", "late", "present"]);
    expect(derived.has("excused")).toBe(false);
    expect(derived.has("auto")).toBe(false);
  });

  it("does not read the system clock, so a result can be recomputed years later", () => {
    const before = resolveAttendanceStatus(input({ arrivalAt: at(FIFTEEN_MINUTES + 1) }));
    const after = resolveAttendanceStatus(input({ arrivalAt: at(FIFTEEN_MINUTES + 1) }));
    expect(before).toBe(after);
    expect(before).toBe("late");
  });
});

describe("resolveAttendanceStatus input validation", () => {
  it("rejects an invalid arrival or start date rather than comparing NaN", () => {
    expect(() => resolveAttendanceStatus(input({ arrivalAt: new Date("nonsense") }))).toThrow(/arrivalAt/);
    expect(() => resolveAttendanceStatus(input({ sessionStartAt: new Date("nonsense") }))).toThrow(/sessionStartAt/);
  });

  it("rejects a negative threshold, which would mark every on-time arrival late", () => {
    expect(() => resolveAttendanceStatus(input({ lateThresholdMs: -1 }))).toThrow(/lateThresholdMs/);
  });

  it("rejects a fractional threshold, so the boundary is always an exact instant", () => {
    expect(() => resolveAttendanceStatus(input({ lateThresholdMs: 100.5 }))).toThrow(/lateThresholdMs/);
  });

  it("rejects a non-finite threshold", () => {
    expect(() => resolveAttendanceStatus(input({ lateThresholdMs: Number.NaN }))).toThrow(/lateThresholdMs/);
  });
});