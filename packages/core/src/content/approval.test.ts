import { describe, expect, it } from "vitest";

import { approveContent, recordReviewRequest } from "./approval.js";

const AT = new Date("2026-04-01T09:00:00.000Z");

/** A creator is a `personId` — the identity root ADR-0018 settled on. */
const CONTENT = Object.freeze({
  contentId: "content_1",
  organizationId: "org_1",
  creatorPersonId: "person_creator",
  title: "Grand final highlights",
  createdAt: new Date("2026-03-20T08:00:00.000Z"),
});

describe("approveContent", () => {
  it("returns a frozen approval record naming the item, the approver and the instant", () => {
    const approval = approveContent({ content: CONTENT, approvedBy: "person_editor", at: AT, notes: "checked figures" });

    expect(approval).toEqual({
      contentId: "content_1",
      organizationId: "org_1",
      creatorPersonId: "person_creator",
      approvedBy: "person_editor",
      approvedAt: AT,
      notes: "checked figures",
    });
    expect(Object.isFrozen(approval)).toBe(true);
  });

  it("omits notes entirely when none were given, rather than storing an empty string", () => {
    const approval = approveContent({ content: CONTENT, approvedBy: "person_editor", at: AT });

    expect("notes" in approval).toBe(false);
  });

  it("refuses approval by the item's own author", () => {
    // Separation of duties, the same principle `tryout/state-machine.ts` applies
    // to `evaluated -> selected`: the person who wrote it may not sign it off.
    // Legacy had no such check anywhere in editorial, which meant an author could
    // approve their own piece and nothing in the record would say so.
    expect(() => approveContent({ content: CONTENT, approvedBy: "person_creator", at: AT })).toThrow(
      /separation of duties|may not approve|person_creator/i,
    );
  });

  it("names the approver, the item and the control in the refusal, so the conflict is diagnosable", () => {
    expect(() => approveContent({ content: CONTENT, approvedBy: "person_creator", at: AT })).toThrow(
      /separation of duties/i,
    );
    expect(() => approveContent({ content: CONTENT, approvedBy: "person_creator", at: AT })).toThrow(/person_creator/);
    expect(() => approveContent({ content: CONTENT, approvedBy: "person_creator", at: AT })).toThrow(/content_1/);
  });

  it("compares the person id after trimming, so padded spelling is not a way past the guard", () => {
    // `" person_creator"` is a different string from `"person_creator"`, and a
    // naive identity check would let it through. That is not a defence of the
    // control; it is a spelling of the same person.
    expect(() => approveContent({ content: CONTENT, approvedBy: "  person_creator  ", at: AT })).toThrow(
      /separation of duties/i,
    );
  });

  it("allows a genuinely different person whose id merely resembles the creator's", () => {
    // The guard is exact identity, not a prefix or a fuzzy match: person ids are
    // opaque and one person having a similar id to another is not a conflict.
    expect(() => approveContent({ content: CONTENT, approvedBy: "person_creator_2", at: AT })).not.toThrow();
  });

  it("allows approval by any other person", () => {
    expect(() => approveContent({ content: CONTENT, approvedBy: "person_compliance", at: AT })).not.toThrow();
  });

  it("refuses a blank approver", () => {
    expect(() => approveContent({ content: CONTENT, approvedBy: "   ", at: AT })).toThrow(/approvedBy/i);
  });

  it("refuses an invalid instant", () => {
    expect(() => approveContent({ content: CONTENT, approvedBy: "person_editor", at: new Date("never") })).toThrow(
      /at/i,
    );
  });

  it("refuses an approval dated before the item existed", () => {
    expect(() =>
      approveContent({ content: CONTENT, approvedBy: "person_editor", at: new Date("2026-03-01T00:00:00.000Z") }),
    ).toThrow(/before|predate/i);
  });

  it("allows approval at the exact instant the item was created", () => {
    // The boundary: same instant is not "before".
    expect(() =>
      approveContent({ content: CONTENT, approvedBy: "person_editor", at: CONTENT.createdAt }),
    ).not.toThrow();
  });

  it("refuses blank content identity fields rather than approving something unnamed", () => {
    expect(() => approveContent({ content: { ...CONTENT, contentId: " " }, approvedBy: "person_editor", at: AT })).toThrow(
      /contentId/i,
    );
    expect(() =>
      approveContent({ content: { ...CONTENT, creatorPersonId: "" }, approvedBy: "person_editor", at: AT }),
    ).toThrow(/creatorPersonId/i);
    expect(() =>
      approveContent({ content: { ...CONTENT, organizationId: "" }, approvedBy: "person_editor", at: AT }),
    ).toThrow(/organizationId/i);
  });

  it("refuses whitespace-only notes, which is the same as saying nothing", () => {
    expect(() => approveContent({ content: CONTENT, approvedBy: "person_editor", at: AT, notes: "   " })).toThrow(
      /notes/i,
    );
  });
});

describe("recordReviewRequest", () => {
  it("returns a frozen record naming who asked and when", () => {
    const request = recordReviewRequest({ content: CONTENT, requestedBy: "person_creator", at: AT });

    expect(request).toEqual({
      contentId: "content_1",
      organizationId: "org_1",
      requestedBy: "person_creator",
      requestedAt: AT,
    });
    expect(Object.isFrozen(request)).toBe(true);
  });

  it("lets the author request their own review", () => {
    // Asking for review is not approving it. Only the approval carries the
    // separation-of-duties guard, because only approval confers the standing.
    expect(() => recordReviewRequest({ content: CONTENT, requestedBy: "person_creator", at: AT })).not.toThrow();
  });

  it("refuses a requester with no identity and an invalid instant", () => {
    expect(() => recordReviewRequest({ content: CONTENT, requestedBy: "", at: AT })).toThrow(/requestedBy/i);
    expect(() => recordReviewRequest({ content: CONTENT, requestedBy: "person_creator", at: new Date("nope") })).toThrow(
      /at/i,
    );
  });
});