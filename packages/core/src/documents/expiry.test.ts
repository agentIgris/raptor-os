import { describe, expect, it } from "vitest";

import type { ExpirableDocument } from "./expiry.js";
import {
  DAY_MS,
  DEFAULT_REMINDER_LEAD_DAYS,
  daysUntilExpiry,
  documentsExpiringWithin,
  expiryRemindersDue,
  isExpired,
} from "./expiry.js";

const ORG = "org_1";
const AS_OF = new Date("2026-06-01T00:00:00.000Z");

function doc(overrides: Partial<ExpirableDocument> = {}): ExpirableDocument {
  return {
    documentId: "doc_1",
    organizationId: ORG,
    personId: "person_1",
    documentType: "work_permit",
    title: "Work permit",
    issuedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2026-06-15T00:00:00.000Z"),
    reminderLeadDays: [30, 7],
    notifyIds: ["person_1", "hr_1"],
    ...overrides,
  };
}

describe("isExpired", () => {
  it("is false strictly before the expiry", () => {
    expect(isExpired(doc(), new Date("2026-06-14T23:59:59.999Z"))).toBe(false);
  });

  it("is TRUE at the exact instant of expiry", () => {
    // The boundary decision. A document whose expiry instant has arrived is
    // expired from that instant: `>` rather than `>=` would leave a document
    // valid for one instant past its own deadline.
    expect(isExpired(doc(), new Date("2026-06-15T00:00:00.000Z"))).toBe(true);
  });

  it("is true after the expiry", () => {
    expect(isExpired(doc(), new Date("2026-07-01T00:00:00.000Z"))).toBe(true);
  });
});

describe("daysUntilExpiry", () => {
  it("counts whole days, and is zero on the day of expiry", () => {
    expect(daysUntilExpiry(doc(), AS_OF)).toBe(14);
    expect(daysUntilExpiry(doc(), new Date("2026-06-15T00:00:00.000Z"))).toBe(0);
  });

  it("goes negative once expired, so a caller can sort by urgency either way", () => {
    expect(daysUntilExpiry(doc(), new Date("2026-06-16T00:00:00.000Z"))).toBe(-1);
  });

  it("counts exact days, not calendar days, and says so through DAY_MS", () => {
    // 24 hours exactly. A "day" here is a fixed span, matching the way the
    // reminder windows below are computed; a calendar day would make the result
    // depend on a timezone this package does not have.
    const twelveHoursOut = new Date(AS_OF.getTime() + 12 * 60 * 60 * 1000);
    expect(daysUntilExpiry(doc({ expiresAt: new Date(AS_OF.getTime() + DAY_MS) }), twelveHoursOut)).toBe(0);
    expect(daysUntilExpiry(doc({ expiresAt: new Date(AS_OF.getTime() + DAY_MS) }), AS_OF)).toBe(1);
  });
});

describe("documentsExpiringWithin — the cutoff is INCLUSIVE", () => {
  const within30 = 30;

  it("includes a document expiring exactly on the cutoff", () => {
    // THE off-by-one this module exists to prevent. A deadline that falls exactly
    // on the horizon is a real deadline; excluding it silently drops a document
    // from a renewal run on precisely the day it must be renewed.
    const onCutoff = doc({ expiresAt: new Date(AS_OF.getTime() + within30 * DAY_MS) });
    expect(documentsExpiringWithin([onCutoff], AS_OF, within30)).toEqual([onCutoff]);
  });

  it("includes a document expiring one millisecond before the cutoff", () => {
    const justInside = doc({ expiresAt: new Date(AS_OF.getTime() + within30 * DAY_MS - 1) });
    expect(documentsExpiringWithin([justInside], AS_OF, within30)).toEqual([justInside]);
  });

  it("excludes a document expiring one millisecond after the cutoff", () => {
    const justOutside = doc({ expiresAt: new Date(AS_OF.getTime() + within30 * DAY_MS + 1) });
    expect(documentsExpiringWithin([justOutside], AS_OF, within30)).toEqual([]);
  });

  it("excludes documents already expired, even though their date is within the window", () => {
    // A document that expired yesterday is overdue, not upcoming. Returning it
    // from an "expiring soon" query mixes two different remediation paths in one
    // list and the caller cannot tell which action each needs.
    const expired = doc({ expiresAt: new Date("2026-05-01T00:00:00.000Z") });
    expect(documentsExpiringWithin([expired], AS_OF, within30)).toEqual([]);
  });

  it("includes a document expiring today", () => {
    const today = doc({ expiresAt: AS_OF });
    expect(documentsExpiringWithin([today], AS_OF, within30)).toEqual([today]);
  });

  it("returns an empty list for a zero-day window unless something expires exactly today", () => {
    expect(documentsExpiringWithin([doc()], AS_OF, 0)).toEqual([]);
    const today = doc({ expiresAt: AS_OF });
    expect(documentsExpiringWithin([today], AS_OF, 0)).toEqual([today]);
  });

  it("orders results by expiry date, soonest first", () => {
    const later = doc({ documentId: "doc_late", expiresAt: new Date("2026-06-20T00:00:00.000Z") });
    const sooner = doc({ documentId: "doc_soon", expiresAt: new Date("2026-06-05T00:00:00.000Z") });

    expect(documentsExpiringWithin([later, sooner], AS_OF, within30).map((d) => d.documentId)).toEqual([
      "doc_soon",
      "doc_late",
    ]);
  });

  it("breaks expiry ties by document id, so the order never depends on the input", () => {
    const sameInstant = new Date("2026-06-10T00:00:00.000Z");
    const b = doc({ documentId: "doc_b", expiresAt: sameInstant });
    const a = doc({ documentId: "doc_a", expiresAt: sameInstant });

    expect(documentsExpiringWithin([b, a], AS_OF, within30).map((d) => d.documentId)).toEqual(["doc_a", "doc_b"]);
    expect(documentsExpiringWithin([a, b], AS_OF, within30).map((d) => d.documentId)).toEqual(["doc_a", "doc_b"]);
  });

  it("scopes to one organisation when the caller names one", () => {
    const foreign = doc({ documentId: "doc_foreign", organizationId: "org_other" });
    expect(documentsExpiringWithin([foreign], AS_OF, within30, ORG)).toEqual([]);
    expect(documentsExpiringWithin([foreign], AS_OF, within30)).toEqual([foreign]);
  });

  it("rejects a negative window rather than returning everything", () => {
    expect(() => documentsExpiringWithin([doc()], AS_OF, -1)).toThrow(/withinDays/i);
  });

  it("rejects a non-integer window", () => {
    expect(() => documentsExpiringWithin([doc()], AS_OF, 1.5)).toThrow(/withinDays/i);
  });

  it("returns a frozen list", () => {
    expect(Object.isFrozen(documentsExpiringWithin([doc()], AS_OF, within30))).toBe(true);
  });

  it("is unaffected by the order documents are supplied in", () => {
    const a = doc({ documentId: "doc_a", expiresAt: new Date("2026-06-10T00:00:00.000Z") });
    const b = doc({ documentId: "doc_b", expiresAt: new Date("2026-06-12T00:00:00.000Z") });

    expect(documentsExpiringWithin([a, b], AS_OF, within30)).toEqual(documentsExpiringWithin([b, a], AS_OF, within30));
  });
});

describe("expiryRemindersDue — what is due, when, and to whom", () => {
  it("sends only the long-lead reminder when only the long horizon has passed", () => {
    // 14 days left. The 30-day horizon was reached on 2026-05-16, so that
    // reminder is owed. The 7-day horizon falls on 2026-06-08, so that one is
    // not — and must not be pre-emptively sent.
    expect(expiryRemindersDue([doc()], AS_OF).map((r) => r.leadDays)).toEqual([30]);
  });

  it("sends nothing when the longest horizon is still in the future", () => {
    // 31 days left: even the 30-day reminder is not yet owed.
    const d = doc({ expiresAt: new Date(AS_OF.getTime() + 31 * DAY_MS) });
    expect(expiryRemindersDue([d], AS_OF)).toEqual([]);
  });

  it("sends the long-lead reminder exactly on its horizon, one millisecond early it does not", () => {
    // The horizon itself is inclusive, for the same reason the expiry cutoff is:
    // "exactly 30 days out" is when the reminder is owed, and one millisecond
    // before it is not.
    const onHorizon = doc({ expiresAt: new Date(AS_OF.getTime() + 30 * DAY_MS), reminderLeadDays: [30] });
    expect(expiryRemindersDue([onHorizon], AS_OF).map((r) => r.leadDays)).toEqual([30]);

    const oneEarly = doc({
      expiresAt: new Date(AS_OF.getTime() + 30 * DAY_MS + 1),
      reminderLeadDays: [30],
    });
    expect(expiryRemindersDue([oneEarly], AS_OF)).toEqual([]);
  });

  it("returns the 30-day reminder once the 30-day horizon is reached", () => {
    const d = doc({ expiresAt: new Date("2026-06-25T00:00:00.000Z") }); // 24 days left
    const reminders = expiryRemindersDue([d], AS_OF);

    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toEqual({
      kind: "expiring",
      documentId: "doc_1",
      recipientIds: ["person_1", "hr_1"],
      remindAt: new Date("2026-05-26T00:00:00.000Z"),
      expiresAt: new Date("2026-06-25T00:00:00.000Z"),
      daysUntilExpiry: 24,
      leadDays: 30,
    });
  });

  it("returns both reminders once both horizons are reached, long lead first", () => {
    const d = doc({ expiresAt: new Date("2026-06-05T00:00:00.000Z") }); // 4 days left
    const reminders = expiryRemindersDue([d], AS_OF);

    // Ordered by when each became due, not by how far ahead it looks: the 30-day
    // reminder fell due on 2026-05-06 and the 7-day one on 2026-05-29.
    expect(reminders.map((r) => r.leadDays)).toEqual([30, 7]);
    expect(reminders[0]?.remindAt).toEqual(new Date("2026-05-06T00:00:00.000Z"));
    expect(reminders[1]?.remindAt).toEqual(new Date("2026-05-29T00:00:00.000Z"));
  });

  it("does NOT fire a reminder in the window between horizons", () => {
    // 24 days left: past the 30-day mark, not yet at the 7-day mark. Only the
    // 30-day reminder is due; the 7-day one must not be pre-emptively sent.
    const d = doc({ expiresAt: new Date("2026-06-25T00:00:00.000Z") });
    expect(expiryRemindersDue([d], AS_OF).map((r) => r.leadDays)).toEqual([30]);
  });

  it("escalates to an expired reminder once the date has passed", () => {
    const d = doc({ expiresAt: new Date("2026-05-01T00:00:00.000Z") });
    const reminders = expiryRemindersDue([d], AS_OF);

    expect(reminders).toEqual([
      {
        kind: "expired",
        documentId: "doc_1",
        recipientIds: ["person_1", "hr_1"],
        remindAt: new Date("2026-05-01T00:00:00.000Z"),
        expiresAt: new Date("2026-05-01T00:00:00.000Z"),
        daysUntilExpiry: -31,
        leadDays: 0,
      },
    ]);
  });

  it("does not send an expired reminder and an expiring one for the same document", () => {
    // Once expired, the upcoming horizons are moot. Emitting both would leave a
    // recipient being told "expires in 30 days" about a document that expired a
    // month ago.
    const d = doc({ expiresAt: new Date("2026-05-01T00:00:00.000Z") });
    expect(expiryRemindersDue([d], AS_OF).every((r) => r.kind === "expired")).toBe(true);
  });

  it("orders reminders by due date, then document id, then lead days", () => {
    const early = doc({ documentId: "doc_a", expiresAt: new Date("2026-06-03T00:00:00.000Z") }); // both leads due
    const late = doc({ documentId: "doc_b", expiresAt: new Date("2026-06-28T00:00:00.000Z") }); // only the 30-day

    const reminders = expiryRemindersDue([late, early], AS_OF);
    // 2026-05-04 (doc_a, 30) -> 2026-05-27 (doc_a, 7) -> 2026-05-29 (doc_b, 30).
    expect(reminders.map((r) => `${r.documentId}:${r.leadDays}`)).toEqual(["doc_a:30", "doc_a:7", "doc_b:30"]);
  });

  it("uses the default lead days when a document states none", () => {
    const d = doc({ reminderLeadDays: [], expiresAt: new Date("2026-06-28T00:00:00.000Z") }); // 27 days left
    expect(expiryRemindersDue([d], AS_OF).map((r) => r.leadDays)).toEqual([DEFAULT_REMINDER_LEAD_DAYS[0]]);
    expect(DEFAULT_REMINDER_LEAD_DAYS).toContain(30);
  });

  it("returns a frozen list", () => {
    const d = doc({ expiresAt: new Date("2026-06-05T00:00:00.000Z") });
    expect(Object.isFrozen(expiryRemindersDue([d], AS_OF))).toBe(true);
  });

  it("is unaffected by the order documents are supplied in", () => {
    const a = doc({ documentId: "doc_a", expiresAt: new Date("2026-06-03T00:00:00.000Z") });
    const b = doc({ documentId: "doc_b", expiresAt: new Date("2026-06-28T00:00:00.000Z") });

    expect(expiryRemindersDue([a, b], AS_OF)).toEqual(expiryRemindersDue([b, a], AS_OF));
  });

  it("scopes reminders to one organisation when the caller names one", () => {
    const foreign = doc({ documentId: "doc_foreign", organizationId: "org_other" });
    const at = new Date("2026-06-05T00:00:00.000Z");

    // Ten days left, so only the 30-day lead is due.
    expect(expiryRemindersDue([foreign], at, ORG)).toEqual([]);
    expect(expiryRemindersDue([foreign], at).map((r) => r.leadDays)).toEqual([30]);
  });

  it("returns nothing when there are no documents at all", () => {
    expect(expiryRemindersDue([], AS_OF)).toEqual([]);
  });

  it("breaks a full tie on remindAt and document id by lead days", () => {
    // Two documents with the same expiry share the same remindAt for a given lead
    // day, so the document-id tie-break has to be followed by a lead-day one for
    // the sort to be total.
    const sameInstant = new Date("2026-06-05T00:00:00.000Z");
    const a = doc({ documentId: "doc_a", expiresAt: sameInstant, reminderLeadDays: [30, 7] });
    const b = doc({ documentId: "doc_b", expiresAt: sameInstant, reminderLeadDays: [30, 7] });

    const reminders = expiryRemindersDue([b, a], new Date("2026-06-01T00:00:00.000Z"));
    // doc_a's 30-day lead (2026-05-06) and doc_b's 30-day lead tie, as do the
    // 7-day ones (2026-05-29); within a document the earlier lead comes first.
    expect(reminders.map((r) => `${r.documentId}:${r.leadDays}`)).toEqual([
      "doc_a:30",
      "doc_b:30",
      "doc_a:7",
      "doc_b:7",
    ]);
  });

  it("breaks a tie on remindAt alone by document id", () => {
    // Two documents whose reminders fall due on the same instant but whose
    // expiry dates differ, so only the id can order them.
    const a = doc({ documentId: "doc_a", expiresAt: new Date("2026-06-20T00:00:00.000Z"), reminderLeadDays: [20] });
    const b = doc({ documentId: "doc_b", expiresAt: new Date("2026-06-21T00:00:00.000Z"), reminderLeadDays: [21] });

    const reminders = expiryRemindersDue([b, a], new Date("2026-06-01T00:00:00.000Z"));
    expect(reminders.map((r) => r.documentId)).toEqual(["doc_a", "doc_b"]);
  });
});

describe("createExpirableDocument", () => {
  it("canonicalises the lead days: deduplicated, sorted, non-negative", async () => {
    const { createExpirableDocument } = await import("./expiry.js");
    const created = createExpirableDocument({
      documentId: "doc_1",
      organizationId: ORG,
      personId: "person_1",
      documentType: "work_permit",
      title: "Work permit",
      issuedAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2026-06-15T00:00:00.000Z"),
      reminderLeadDays: [7, 30, 7],
      notifyIds: ["hr_1"],
    });

    expect(created.reminderLeadDays).toEqual([7, 30]);
    expect(Object.isFrozen(created)).toBe(true);
  });

  it("falls back to the default lead days when none are given", async () => {
    const { createExpirableDocument } = await import("./expiry.js");
    const created = createExpirableDocument({
      documentId: "doc_1",
      organizationId: ORG,
      personId: "person_1",
      documentType: "work_permit",
      title: "Work permit",
      issuedAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2026-06-15T00:00:00.000Z"),
      notifyIds: ["hr_1"],
    });

    expect(created.reminderLeadDays).toEqual([...DEFAULT_REMINDER_LEAD_DAYS]);
  });

  it("rejects a negative lead day", async () => {
    const { createExpirableDocument } = await import("./expiry.js");
    expect(() =>
      createExpirableDocument({
        documentId: "doc_1",
        organizationId: ORG,
        personId: "person_1",
        documentType: "work_permit",
        title: "Work permit",
        issuedAt: new Date("2026-01-01T00:00:00.000Z"),
        expiresAt: new Date("2026-06-15T00:00:00.000Z"),
        reminderLeadDays: [-1],
        notifyIds: ["hr_1"],
      }),
    ).toThrow(/lead/i);
  });

  it("rejects a document with no id", async () => {
    const { createExpirableDocument } = await import("./expiry.js");
    expect(() =>
      createExpirableDocument({
        documentId: "  ",
        organizationId: ORG,
        personId: "person_1",
        documentType: "work_permit",
        title: "Work permit",
        issuedAt: new Date("2026-01-01T00:00:00.000Z"),
        expiresAt: new Date("2026-06-15T00:00:00.000Z"),
        notifyIds: ["hr_1"],
      }),
    ).toThrow(/documentId/i);
  });

  it("rejects a fractional lead day", async () => {
    const { createExpirableDocument } = await import("./expiry.js");
    expect(() =>
      createExpirableDocument({
        documentId: "doc_1",
        organizationId: ORG,
        personId: "person_1",
        documentType: "work_permit",
        title: "Work permit",
        issuedAt: new Date("2026-01-01T00:00:00.000Z"),
        expiresAt: new Date("2026-06-15T00:00:00.000Z"),
        reminderLeadDays: [7.5],
        notifyIds: ["hr_1"],
      }),
    ).toThrow(/lead/i);
  });

  it("defaults personId to null for an organisational document", async () => {
    const { createExpirableDocument } = await import("./expiry.js");
    const created = createExpirableDocument({
      documentId: "doc_1",
      organizationId: ORG,
      documentType: "insurance_certificate",
      title: "Public liability",
      issuedAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2026-06-15T00:00:00.000Z"),
      notifyIds: ["hr_1"],
    });

    expect(created.personId).toBeNull();
  });

  it("rejects a document with nobody to notify", async () => {
    const { createExpirableDocument } = await import("./expiry.js");
    expect(() =>
      createExpirableDocument({
        documentId: "doc_1",
        organizationId: ORG,
        personId: "person_1",
        documentType: "work_permit",
        title: "Work permit",
        issuedAt: new Date("2026-01-01T00:00:00.000Z"),
        expiresAt: new Date("2026-06-15T00:00:00.000Z"),
        notifyIds: [],
      }),
    ).toThrow(/notify/i);
  });

  it("rejects an expiry at or before the issue date", async () => {
    const { createExpirableDocument } = await import("./expiry.js");
    expect(() =>
      createExpirableDocument({
        documentId: "doc_1",
        organizationId: ORG,
        personId: "person_1",
        documentType: "work_permit",
        title: "Work permit",
        issuedAt: new Date("2026-06-15T00:00:00.000Z"),
        expiresAt: new Date("2026-06-15T00:00:00.000Z"),
        notifyIds: ["hr_1"],
      }),
    ).toThrow(/expiresAt/i);
  });

  it("rejects an unknown document type", async () => {
    const { createExpirableDocument, DOCUMENT_TYPES } = await import("./expiry.js");
    expect(DOCUMENT_TYPES).toContain("work_permit");
    expect(() =>
      createExpirableDocument({
        documentId: "doc_1",
        organizationId: ORG,
        personId: "person_1",
        documentType: "souvenir" as (typeof DOCUMENT_TYPES)[number],
        title: "Work permit",
        issuedAt: new Date("2026-01-01T00:00:00.000Z"),
        expiresAt: new Date("2026-06-15T00:00:00.000Z"),
        notifyIds: ["hr_1"],
      }),
    ).toThrow(/documentType/i);
  });
});