import { describe, expect, it } from "vitest";

import type { AttendanceRecord } from "./rate.js";
import { computeAttendanceRate } from "./rate.js";

function statuses(...values: AttendanceRecord["status"][]): AttendanceRecord[] {
  return values.map((status, index) => ({
    sessionId: `ses_${index}`,
    organizationId: "org_1",
    playerId: "person_1",
    status,
  }));
}

describe("computeAttendanceRate", () => {
  it("computes the worked example: 3 present, 2 late, 3 absent, 1 excused, 1 auto", () => {
    const records = statuses("present", "present", "present", "late", "late", "absent", "absent", "absent", "excused", "auto");

    const rate = computeAttendanceRate(records);

    // Numerator:   present (3) + late (2)            = 5
    // Denominator: 9 countable records, `auto` excluded (it decided nothing)
    // 5 / 9 = 55.555...% -> 55.56
    expect(rate.attendanceRatePercent).toBe(55.56);
    expect(rate.attended).toBe(5);
    expect(rate.countable).toBe(9);
    expect(rate.excludedUndecided).toBe(1);
    expect(rate.breakdown).toEqual({ present: 3, late: 2, absent: 3, excused: 1 });
  });

  it("excludes `auto` from BOTH numerator and denominator, because it decided nothing", () => {
    const withAuto = computeAttendanceRate(statuses("present", "present", "absent", "auto"));
    const withoutAuto = computeAttendanceRate(statuses("present", "present", "absent"));

    // Both must be 66.67: an `auto` row is an absence of evidence, not evidence of absence.
    expect(withAuto.attendanceRatePercent).toBe(66.67);
    expect(withAuto.attendanceRatePercent).toBe(withoutAuto.attendanceRatePercent);
    expect(withAuto.excludedUndecided).toBe(1);
  });

  it("counts `late` as attended", () => {
    // One of the five legacy surfaces excluded `late`, which made the same player
    // score differently depending on which screen was asked.
    const rate = computeAttendanceRate(statuses("late", "late", "late", "absent"));
    expect(rate.attendanceRatePercent).toBe(75);
  });

  it("counts `excused` in the denominator but not the numerator", () => {
    // An excused session was still held and still recorded; excluding it entirely
    // would let an organisation improve a player's rate by excusing absences.
    const rate = computeAttendanceRate(statuses("present", "excused"));
    expect(rate.attended).toBe(1);
    expect(rate.countable).toBe(2);
    expect(rate.attendanceRatePercent).toBe(50);
  });

  it("returns zero when there are no countable records at all", () => {
    const rate = computeAttendanceRate(statuses("auto", "auto"));
    expect(rate.attendanceRatePercent).toBe(0);
    expect(rate.countable).toBe(0);
    expect(rate.excludedUndecided).toBe(2);
    expect(rate.hasDenominator).toBe(false);
  });

  it("returns zero for an empty roster rather than NaN", () => {
    const rate = computeAttendanceRate([]);
    expect(rate.attendanceRatePercent).toBe(0);
    expect(rate.hasDenominator).toBe(false);
  });

  it("reports a perfect and a zero rate distinctly", () => {
    expect(computeAttendanceRate(statuses("present", "present")).attendanceRatePercent).toBe(100);
    expect(computeAttendanceRate(statuses("absent", "absent")).attendanceRatePercent).toBe(0);
  });

  it("is order-independent, because a rate must not depend on row order", () => {
    const forwards = statuses("present", "late", "absent", "excused");
    const backwards = [...forwards].reverse();
    expect(computeAttendanceRate(backwards).attendanceRatePercent).toBe(computeAttendanceRate(forwards).attendanceRatePercent);
  });

  it("counts records for the requested organisation only, so one tenant cannot poison another's rate", () => {
    const records: AttendanceRecord[] = [
      { sessionId: "s1", organizationId: "org_1", playerId: "person_1", status: "present" },
      { sessionId: "s2", organizationId: "org_2", playerId: "person_1", status: "absent" },
      { sessionId: "s3", organizationId: "org_1", playerId: "person_1", status: "absent" },
    ];

    const rate = computeAttendanceRate(records, { organizationId: "org_1" });

    expect(rate.countable).toBe(2);
    expect(rate.attendanceRatePercent).toBe(50);
  });

  it("rejects a record whose status is outside the vocabulary, instead of counting it as anything", () => {
    const bad = [{ sessionId: "s1", organizationId: "org_1", playerId: "p1", status: "tardy" }];
    expect(() => computeAttendanceRate(bad as AttendanceRecord[])).toThrow(/tardy/);
  });
});