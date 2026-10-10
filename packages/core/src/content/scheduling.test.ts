import { describe, expect, it } from "vitest";

import { SCHEDULE_MINIMUM_LEAD_MS, isDueForPublication, schedulePublication, unschedulePublication } from "./scheduling.js";

const APPROVED_AT = new Date("2026-04-01T09:00:00.000Z");

const APPROVAL = Object.freeze({
  contentId: "content_1",
  organizationId: "org_1",
  creatorPersonId: "person_creator",
  approvedBy: "person_editor",
  approvedAt: APPROVED_AT,
});

/** One day, the smallest lead this module will accept. */
const ONE_DAY_MS = 86_400_000;

describe("schedulePublication", () => {
  it("returns a frozen record carrying the publish instant as data", () => {
    const publishAt = new Date("2026-04-02T09:00:00.000Z");
    const scheduled = schedulePublication({
      contentId: "content_1",
      organizationId: "org_1",
      publishAt,
      at: APPROVED_AT,
      scheduledBy: "person_editor",
    });

    expect(scheduled).toEqual({
      contentId: "content_1",
      organizationId: "org_1",
      publishAt,
      scheduledAt: APPROVED_AT,
      scheduledBy: "person_editor",
    });
    expect(Object.isFrozen(scheduled)).toBe(true);
  });

  it("takes the publish instant from its input, not from when the call was made", () => {
    // Two decisions taken at different moments, naming the same publish instant,
    // agree on when it goes out. A schedule that read a clock could not do this,
    // and "when did this go live?" would have an answer that changed with the
    // build. `structure.test.ts` additionally greps the module source for a clock
    // read, so this is the behavioural half of a two-part guarantee.
    const publishAt = new Date("2026-04-05T09:00:00.000Z");
    const first = schedulePublication({
      contentId: "content_1",
      organizationId: "org_1",
      publishAt,
      at: APPROVED_AT,
      scheduledBy: "person_editor",
    });
    const second = schedulePublication({
      contentId: "content_1",
      organizationId: "org_1",
      publishAt,
      at: new Date("2026-04-03T22:00:00.000Z"),
      scheduledBy: "person_editor",
    });

    expect(first.publishAt.getTime()).toBe(second.publishAt.getTime());
    expect(first.publishAt.toISOString()).toBe("2026-04-05T09:00:00.000Z");
  });

  it("records when the decision was made separately from when it takes effect", () => {
    const scheduled = schedulePublication({
      contentId: "content_1",
      organizationId: "org_1",
      publishAt: new Date("2026-04-05T09:00:00.000Z"),
      at: APPROVED_AT,
      scheduledBy: "person_editor",
    });

    expect(scheduled.scheduledAt.toISOString()).toBe(APPROVED_AT.toISOString());
    expect(scheduled.publishAt.toISOString()).toBe("2026-04-05T09:00:00.000Z");
  });

  it("refuses to schedule something for a moment that has already passed", () => {
    expect(() =>
      schedulePublication({
        contentId: "content_1",
        organizationId: "org_1",
        publishAt: new Date("2026-03-31T09:00:00.000Z"),
        at: APPROVED_AT,
        scheduledBy: "person_editor",
      }),
    ).toThrow(/past|before|already/i);
  });

  it("refuses a publish time before the approval it rests on", () => {
    // Content cannot go out before the sign-off that made publishing it
    // legitimate.
    expect(() =>
      schedulePublication({
        contentId: "content_1",
        organizationId: "org_1",
        approval: APPROVAL,
        publishAt: new Date("2026-03-31T09:00:00.000Z"),
        at: APPROVED_AT,
        scheduledBy: "person_editor",
      }),
    ).toThrow(/approval|approvedAt/i);
  });

  it("refuses a publish time with no lead time at all", () => {
    // A schedule that fires at the instant it is written is a publish button
    // wearing a scheduling costume: there is no review of the plan, no chance to
    // cancel, and no time zone check.
    expect(() =>
      schedulePublication({
        contentId: "content_1",
        organizationId: "org_1",
        publishAt: APPROVED_AT,
        at: APPROVED_AT,
        scheduledBy: "person_editor",
      }),
    ).toThrow(/lead|SCHEDULE_MINIMUM_LEAD/i);
  });

  it("publishes the minimum lead time as a named constant rather than a literal", () => {
    expect(SCHEDULE_MINIMUM_LEAD_MS).toBe(ONE_DAY_MS);
  });

  it("refuses a lead one millisecond under the minimum", () => {
    const publishAt = new Date(APPROVED_AT.getTime() + ONE_DAY_MS - 1);

    expect(() =>
      schedulePublication({
        contentId: "content_1",
        organizationId: "org_1",
        publishAt,
        at: APPROVED_AT,
        scheduledBy: "person_editor",
      }),
    ).toThrow(/lead/i);
  });

  it("accepts a lead of exactly the minimum", () => {
    const publishAt = new Date(APPROVED_AT.getTime() + ONE_DAY_MS);

    expect(() =>
      schedulePublication({
        contentId: "content_1",
        organizationId: "org_1",
        publishAt,
        at: APPROVED_AT,
        scheduledBy: "person_editor",
      }),
    ).not.toThrow();
  });

  it("refuses a blank content id, organisation id or scheduler", () => {
    expect(() =>
      schedulePublication({
        contentId: " ",
        organizationId: "org_1",
        publishAt: new Date("2026-04-02T09:00:00.000Z"),
        at: APPROVED_AT,
        scheduledBy: "person_editor",
      }),
    ).toThrow(/contentId/i);

    expect(() =>
      schedulePublication({
        contentId: "content_1",
        organizationId: "",
        publishAt: new Date("2026-04-02T09:00:00.000Z"),
        at: APPROVED_AT,
        scheduledBy: "person_editor",
      }),
    ).toThrow(/organizationId/i);

    expect(() =>
      schedulePublication({
        contentId: "content_1",
        organizationId: "org_1",
        publishAt: new Date("2026-04-02T09:00:00.000Z"),
        at: APPROVED_AT,
        scheduledBy: " ",
      }),
    ).toThrow(/scheduledBy/i);
  });

  it("refuses an invalid publish time", () => {
    expect(() =>
      schedulePublication({
        contentId: "content_1",
        organizationId: "org_1",
        publishAt: new Date("never"),
        at: APPROVED_AT,
        scheduledBy: "person_editor",
      }),
    ).toThrow(/publishAt/i);
  });

  it("refuses a scheduling decision with no valid instant", () => {
    expect(() =>
      schedulePublication({
        contentId: "content_1",
        organizationId: "org_1",
        publishAt: new Date("2026-04-05T09:00:00.000Z"),
        at: new Date("never"),
        scheduledBy: "person_editor",
      }),
    ).toThrow(/at/i);
  });

  it("refuses a schedule with no tenant scope, because a global publish is how one org's content reaches another's site", () => {
    expect(() =>
      schedulePublication({
        contentId: "content_1",
        organizationId: "",
        publishAt: new Date("2026-04-02T09:00:00.000Z"),
        at: APPROVED_AT,
        scheduledBy: "person_editor",
      }),
    ).toThrow(/organizationId/i);
  });
});

describe("isDueForPublication", () => {
  const scheduled = schedulePublication({
    contentId: "content_1",
    organizationId: "org_1",
    publishAt: new Date("2026-04-02T09:00:00.000Z"),
    at: APPROVED_AT,
    scheduledBy: "person_editor",
  });

  it("is false one millisecond before the publish instant", () => {
    expect(isDueForPublication(scheduled, new Date("2026-04-02T08:59:59.999Z"))).toBe(false);
  });

  it("is true at exactly the publish instant", () => {
    // The boundary, pinned in both directions. `<=` rather than `<` is the whole
    // difference between "published on time" and "published one millisecond late",
    // and it is the single most likely way to get a scheduled-publish boundary
    // wrong. Same reasoning as `minors/majority.ts` for the eighteenth birthday.
    expect(isDueForPublication(scheduled, new Date("2026-04-02T09:00:00.000Z"))).toBe(true);
  });

  it("is true one millisecond after the publish instant", () => {
    expect(isDueForPublication(scheduled, new Date("2026-04-02T09:00:00.001Z"))).toBe(true);
  });

  it("is true arbitrarily far afterwards: a schedule that was missed is still due", () => {
    // A scheduler that was down over the publish instant must not leave content
    // stuck in `scheduled` for ever. The question is "is this moment at or after
    // the one named", not "is this moment exactly the one named".
    expect(isDueForPublication(scheduled, new Date("2027-04-02T09:00:00.000Z"))).toBe(true);
  });

  it("refuses a comparison instant that is not a date", () => {
    expect(() => isDueForPublication(scheduled, new Date("never"))).toThrow(/at/i);
  });
});

describe("unschedulePublication", () => {
  const scheduled = schedulePublication({
    contentId: "content_1",
    organizationId: "org_1",
    publishAt: new Date("2026-04-02T09:00:00.000Z"),
    at: APPROVED_AT,
    scheduledBy: "person_editor",
  });

  it("appends a cancellation record and leaves the schedule untouched", () => {
    const cancelled = unschedulePublication({
      schedule: scheduled,
      at: new Date("2026-04-01T18:00:00.000Z"),
      cancelledBy: "person_editor",
      reason: "embargo moved",
    });

    expect(cancelled.contentId).toBe("content_1");
    expect(cancelled.publishAt).toEqual(scheduled.publishAt);
    expect(Object.isFrozen(cancelled)).toBe(true);

    // The schedule still stands as a record. Cancelling is appending.
    expect(scheduled.publishAt.toISOString()).toBe("2026-04-02T09:00:00.000Z");
  });

  it("requires a reason: a cancelled publication with no reason cannot be explained", () => {
    expect(() =>
      unschedulePublication({
        schedule: scheduled,
        at: new Date("2026-04-01T18:00:00.000Z"),
        cancelledBy: "person_editor",
        reason: "  ",
      }),
    ).toThrow(/reason/i);
  });

  it("refuses a cancellation dated before the schedule it cancels", () => {
    expect(() =>
      unschedulePublication({
        schedule: scheduled,
        at: new Date("2026-03-31T00:00:00.000Z"),
        cancelledBy: "person_editor",
        reason: "too early",
      }),
    ).toThrow(/before|predate/i);
  });

  it("refuses a cancellation with no actor", () => {
    expect(() =>
      unschedulePublication({
        schedule: scheduled,
        at: new Date("2026-04-01T18:00:00.000Z"),
        cancelledBy: "",
        reason: "embargo moved",
      }),
    ).toThrow(/cancelledBy/i);
  });

  it("refuses a cancellation with no valid instant", () => {
    expect(() =>
      unschedulePublication({
        schedule: scheduled,
        at: new Date("never"),
        cancelledBy: "person_editor",
        reason: "embargo moved",
      }),
    ).toThrow(/at/i);
  });

  it("is in time one millisecond before the publish instant, and not at it", () => {
    // Exactly one rule at the boundary, and it is the rule `isDueForPublication`
    // already follows: the instant itself belongs to publication. Two functions
    // disagreeing about the same instant is how a cancelled post goes out anyway.
    expect(() =>
      unschedulePublication({
        schedule: scheduled,
        at: new Date("2026-04-02T08:59:59.999Z"),
        cancelledBy: "person_editor",
        reason: "embargo moved",
      }),
    ).not.toThrow();

    expect(() =>
      unschedulePublication({
        schedule: scheduled,
        at: scheduled.publishAt,
        cancelledBy: "person_editor",
        reason: "embargo moved",
      }),
    ).toThrow(/already published/i);
  });

  it("refuses a cancellation long after the publish instant", () => {
    expect(() =>
      unschedulePublication({
        schedule: scheduled,
        at: new Date("2026-04-05T00:00:00.000Z"),
        cancelledBy: "person_editor",
        reason: "too late to matter",
      }),
    ).toThrow(/after|published|publish/i);
  });
});