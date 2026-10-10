import { describe, expect, it } from "vitest";

import type { Person } from "./majority.js";
import {
  ENGAGEMENT_MINIMUM_AGE_YEARS,
  MAJORITY_AGE_YEARS,
  addYears,
  ageInYearsAt,
  isMinor,
  isUnderEngagementMinimumAge,
  majorityDate,
} from "./majority.js";

/** Born at midnight so "the eighteenth birthday" is a calendar day, not an instant of the day. */
const BIRTH = new Date("2008-03-15T00:00:00.000Z");

function person(overrides: Partial<Person> = {}): Person {
  return { personId: "person_1", birthDate: BIRTH, ...overrides };
}

describe("the age thresholds", () => {
  it("puts the age of majority at 18 and the engagement floor at 13, in one place each", () => {
    // Spec section 10: "Guardian consent for minors; under-13 blocked." Both
    // numbers appear exactly once in the module; everything else reads them.
    expect(MAJORITY_AGE_YEARS).toBe(18);
    expect(ENGAGEMENT_MINIMUM_AGE_YEARS).toBe(13);
  });

  it("keeps the engagement floor strictly below the age of majority", () => {
    // If they ever met, "minor" would be an empty set and every minor-specific
    // rule below would be dead code nobody notices is dead.
    expect(ENGAGEMENT_MINIMUM_AGE_YEARS).toBeLessThan(MAJORITY_AGE_YEARS);
  });
});

describe("addYears", () => {
  it("adds calendar years, not 365-day blocks", () => {
    expect(addYears(new Date("2000-01-01T00:00:00.000Z"), 18).toISOString()).toBe("2018-01-01T00:00:00.000Z");
  });

  it("clamps a 29 February birthday to 28 February in a common year", () => {
    // 2008-02-29 + 18 years lands on a year with no 29 February. Every
    // jurisdiction has a rule here and they mostly agree on the clamp; without
    // one, Date's own rollover gives 1 March, which silently delays majority by
    // a day for one birthdate and nobody would ever find out.
    expect(addYears(new Date("2008-02-29T00:00:00.000Z"), 18).toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });

  it("preserves the time of day", () => {
    expect(addYears(new Date("2008-03-15T13:45:30.500Z"), 18).toISOString()).toBe("2026-03-15T13:45:30.500Z");
  });

  it("handles a 29 February landing in a leap year", () => {
    expect(addYears(new Date("2008-02-29T00:00:00.000Z"), 16).toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });

  it("rejects an invalid date rather than producing NaN years", () => {
    expect(() => addYears(new Date("nonsense"), 18)).toThrow(/date/i);
  });
});

describe("majorityDate", () => {
  it("is the eighteenth birthday", () => {
    expect(majorityDate(person()).toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });

  it("rejects a person with no birth date: age is not derivable from a null", () => {
    expect(() => majorityDate(person({ birthDate: undefined as unknown as Date }))).toThrow(/birthDate/i);
  });

  it("rejects a malformed birth date rather than returning a NaN date", () => {
    expect(() => majorityDate(person({ birthDate: new Date("nonsense") }))).toThrow(/birthDate/i);
  });
});

describe("isMinor — the boundary, to the millisecond", () => {
  it("is true the day before the eighteenth birthday", () => {
    expect(isMinor(person(), new Date("2026-03-14T23:59:59.999Z"))).toBe(true);
  });

  it("is TRUE at the eighteenth birthday itself, right up to the instant", () => {
    // The threshold instant itself belongs to the minor side. Majority begins at
    // the instant the eighteenth birthday is reached, so `at < threshold` is the
    // predicate — `<=` would hand adulthood to the first person born one second
    // after midnight on their birthday.
    expect(isMinor(person(), new Date("2026-03-15T00:00:00.000Z"))).toBe(false);
  });

  it("is false one millisecond after the eighteenth birthday", () => {
    expect(isMinor(person(), new Date("2026-03-15T00:00:00.001Z"))).toBe(false);
  });

  it("is still true one millisecond before it", () => {
    expect(isMinor(person(), new Date("2026-03-14T23:59:59.999Z"))).toBe(true);
  });

  it("is true throughout the whole day before", () => {
    for (const hour of ["00:00:00.000", "06:00:00.000", "12:00:00.000", "23:59:59.999"]) {
      expect(isMinor(person(), new Date(`2026-03-14T${hour}Z`))).toBe(true);
    }
  });

  it("is false throughout the whole eighteenth-birthday day once reached", () => {
    // A person born at 00:00 turns 18 at 00:00, so the whole day belongs to the
    // adult side. The time-of-day rule is pinned separately below for people
    // born mid-day.
    for (const hour of ["00:00:00.000", "06:00:00.000", "12:00:00.000", "23:59:59.999"]) {
      expect(isMinor(person(), new Date(`2026-03-15T${hour}Z`))).toBe(false);
    }
  });

  it("respects the time of day for someone born mid-morning", () => {
    const midday = person({ birthDate: new Date("2008-03-15T12:00:00.000Z") });
    // Turns 18 at 12:00, not at midnight. This is why the threshold is an
    // instant comparison and not a calendar-date comparison.
    expect(isMinor(midday, new Date("2026-03-15T11:59:59.999Z"))).toBe(true);
    expect(isMinor(midday, new Date("2026-03-15T12:00:00.000Z"))).toBe(false);
  });

  it("is true on the day a person is born", () => {
    expect(isMinor(person({ birthDate: new Date("2026-03-15T00:00:00.000Z") }), new Date("2026-03-15T00:00:00.000Z"))).toBe(true);
  });

  it("uses the supplied date, not the current one", () => {
    // The whole point of the parameter: the same person is a minor in 2020 and
    // an adult in 2030, and both answers are reproducible.
    expect(isMinor(person(), new Date("2020-01-01T00:00:00.000Z"))).toBe(true);
    expect(isMinor(person(), new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("handles the 29 February case: majority lands on 28 February", () => {
    const leapling = person({ birthDate: new Date("2008-02-29T00:00:00.000Z") });
    expect(isMinor(leapling, new Date("2026-02-27T23:59:59.999Z"))).toBe(true);
    expect(isMinor(leapling, new Date("2026-02-28T00:00:00.000Z"))).toBe(false);
    // 1 March must not reopen the question.
    expect(isMinor(leapling, new Date("2026-03-01T00:00:00.000Z"))).toBe(false);
  });
});

describe("isUnderEngagementMinimumAge", () => {
  const twelveYearOld = person({ birthDate: new Date("2014-03-15T00:00:00.000Z") });

  it("is true the day before the thirteenth birthday", () => {
    expect(isUnderEngagementMinimumAge(twelveYearOld, new Date("2027-03-14T23:59:59.999Z"))).toBe(true);
  });

  it("is false at the thirteenth birthday", () => {
    expect(isUnderEngagementMinimumAge(twelveYearOld, new Date("2027-03-15T00:00:00.000Z"))).toBe(false);
  });

  it("agrees with isMinor for a 15-year-old: a minor above the floor still needs a guardian", () => {
    const fifteen = person({ birthDate: new Date("2011-03-15T00:00:00.000Z") });
    const at = new Date("2026-03-14T00:00:00.000Z");
    expect(isUnderEngagementMinimumAge(fifteen, at)).toBe(false);
    expect(isMinor(fifteen, at)).toBe(true);
  });
});

describe("ageInYearsAt", () => {
  it("reports the completed years, not the years elapsed since birth", () => {
    expect(ageInYearsAt(person(), new Date("2026-03-14T00:00:00.000Z"))).toBe(17);
    expect(ageInYearsAt(person(), new Date("2026-03-15T00:00:00.000Z"))).toBe(18);
  });

  it("reports 0 on the day of birth", () => {
    expect(ageInYearsAt(person({ birthDate: new Date("2026-01-01T00:00:00.000Z") }), new Date("2026-01-01T00:00:00.000Z"))).toBe(0);
  });

  it("reports a negative age before birth rather than pretending it is zero", () => {
    // Silently clamping to 0 would make a data-entry typo look like a newborn,
    // and a newborn is under the engagement floor — so the typo would block the
    // person rather than being noticed.
    expect(ageInYearsAt(person({ birthDate: new Date("2027-01-01T00:00:00.000Z") }), new Date("2026-01-01T00:00:00.000Z"))).toBe(-1);
  });
});