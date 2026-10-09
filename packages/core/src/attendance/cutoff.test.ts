import { describe, expect, it } from "vitest";

import type { AttendanceSession } from "./cutoff.js";
import { isPastCutoff } from "./cutoff.js";

const START = new Date("2026-06-15T06:00:00.000Z");
const CUTOFF = new Date("2026-06-15T06:15:00.000Z");

function session(overrides: Partial<AttendanceSession> = {}): AttendanceSession {
  return {
    id: "ses_1",
    organizationId: "org_1",
    startTime: START,
    cutoffTime: CUTOFF,
    ...overrides,
  };
}

describe("isPastCutoff", () => {
  it("is false strictly before the cutoff", () => {
    expect(isPastCutoff(session(), new Date("2026-06-15T06:14:59.999Z"))).toBe(false);
  });

  it("is false exactly AT the cutoff, because the rule is a strict less-than", () => {
    // The pinned boundary. Legacy compared timestamps as strings and shipped an
    // off-by-one at this exact instant; `cutoff_time < now` is strict, so the
    // instant of the cutoff itself is still open.
    expect(isPastCutoff(session(), CUTOFF)).toBe(false);
  });

  it("is true one millisecond after the cutoff", () => {
    expect(isPastCutoff(session(), new Date("2026-06-15T06:15:00.001Z"))).toBe(true);
  });

  it("is true well after the cutoff", () => {
    expect(isPastCutoff(session(), new Date("2026-06-15T18:00:00.000Z"))).toBe(true);
  });

  it("never consults the session start time, which the legacy rule also ignored", () => {
    // A cutoff that started three hours ago and cut off an hour after it began
    // is past cutoff on its own terms. The start time is not an input to the
    // comparison, and no offset or grace period is applied.
    const shifted = session({
      startTime: new Date("2026-06-15T03:00:00.000Z"),
      cutoffTime: new Date("2026-06-15T04:00:00.000Z"),
    });

    expect(isPastCutoff(shifted, new Date("2026-06-15T03:30:00.000Z"))).toBe(false);
    expect(isPastCutoff(shifted, new Date("2026-06-15T04:00:00.001Z"))).toBe(true);
  });

  it("agrees with a plain numeric comparison, which is what the string comparison got wrong", () => {
    const now = new Date("2026-06-15T06:15:00.000Z");
    expect(isPastCutoff(session(), now)).toBe(CUTOFF.getTime() < now.getTime());
  });

  it("is pure: the same session and now always give the same answer", () => {
    const now = new Date("2026-06-15T06:20:00.000Z");
    expect(isPastCutoff(session(), now)).toBe(isPastCutoff(session(), now));
  });

  it("rejects an invalid cutoff rather than comparing NaN and silently answering false", () => {
    expect(() => isPastCutoff(session({ cutoffTime: new Date("nonsense") }), new Date())).toThrow(/cutoffTime/);
  });

  it("rejects an invalid `now`, so a caller cannot ask the question with a broken clock", () => {
    expect(() => isPastCutoff(session(), new Date("nonsense"))).toThrow(/now/);
  });

  it("rejects a cutoff that precedes the session start, which no scheduler can mean", () => {
    const inverted = session({
      startTime: new Date("2026-06-15T10:00:00.000Z"),
      cutoffTime: new Date("2026-06-15T06:00:00.000Z"),
    });

    expect(() => isPastCutoff(inverted, new Date())).toThrow(/cutoffTime/);
  });
});