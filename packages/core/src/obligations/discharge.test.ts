import { describe, expect, it } from "vitest";

import { createObligation } from "./obligation.js";
import type { Obligation, ObligationPart } from "./obligation.js";
import { recordEvidence, retractEvidence } from "./evidence.js";
import type { EvidenceOrigin, EvidenceRecord, EvidenceRetraction, RecordEvidenceInput } from "./evidence.js";
import {
  compareDischargeClaim,
  computeDischarge,
  createDischargeClaim,
  isObligationDischarged,
  latePartsAsOf,
} from "./discharge.js";
import type { ObligationDischargeClaim } from "./discharge.js";

/**
 * The design spec's sponsorship, part for part: *"4 streams, 2 social posts,
 * appear at the final"*. Three parts, three different kinds, three different
 * quantities, so that a rule which passes on a single part cannot hide behind it.
 */
const PARTS: readonly ObligationPart[] = Object.freeze([
  Object.freeze({
    partId: "obl_1_streams",
    kind: "live_stream" as const,
    promisedQuantity: 4,
    dueAt: new Date("2026-06-30T23:59:59.000Z"),
    description: "Four co-streams.",
  }),
  Object.freeze({
    partId: "obl_1_posts",
    kind: "social_post" as const,
    promisedQuantity: 2,
    dueAt: new Date("2026-06-30T23:59:59.000Z"),
    description: "Two Instagram posts.",
  }),
  Object.freeze({
    partId: "obl_1_final",
    kind: "appearance" as const,
    promisedQuantity: 1,
    dueAt: new Date("2026-07-12T18:00:00.000Z"),
    description: "Appear at the grand final.",
  }),
]);

const OBLIGATION_INPUT = {
  obligationId: "obl_1",
  organizationId: "org_1",
  partnerId: "partner_1",
  contractVersionId: "contract_version_3",
  title: "Season 6 title sponsorship",
  parts: PARTS,
} as const;

const OBLIGATION: Obligation = createObligation(OBLIGATION_INPUT);

let sequence = 0;

/** A single machine-derived observation of one instance. */
function stream(partId: string, overrides: Partial<RecordEvidenceInput> = {}): EvidenceRecord {
  sequence += 1;
  return recordEvidence({
    evidenceId: `ev_stream_${String(sequence)}`,
    obligationId: "obl_1",
    partId,
    organizationId: "org_1",
    kind: "live_stream",
    quantity: 1,
    observedAt: new Date("2026-05-01T10:00:00.000Z"),
    description: "Co-stream, verified against the ingest export.",
    provenance: {
      capturedBy: "system:stream-ingest",
      capturedAt: new Date("2026-05-01T12:00:00.000Z"),
      origin: "machine_derived" as EvidenceOrigin,
      method: "twitch_exports_csv_v2",
    },
    ...overrides,
  });
}

function post(partId: string, overrides: Partial<RecordEvidenceInput> = {}): EvidenceRecord {
  sequence += 1;
  return recordEvidence({
    evidenceId: `ev_post_${String(sequence)}`,
    obligationId: "obl_1",
    partId,
    organizationId: "org_1",
    kind: "social_post",
    quantity: 1,
    observedAt: new Date("2026-05-01T10:00:00.000Z"),
    description: "Instagram post, screenshot taken by the account manager.",
    provenance: {
      capturedBy: "person_account_manager",
      capturedAt: new Date("2026-05-01T12:00:00.000Z"),
      origin: "human_asserted" as EvidenceOrigin,
    },
    ...overrides,
  });
}

function appearance(partId: string, overrides: Partial<RecordEvidenceInput> = {}): EvidenceRecord {
  sequence += 1;
  return recordEvidence({
    evidenceId: `ev_appearance_${String(sequence)}`,
    obligationId: "obl_1",
    partId,
    organizationId: "org_1",
    kind: "appearance",
    quantity: 1,
    observedAt: new Date("2026-05-01T10:00:00.000Z"),
    description: "Appeared on stage at the final.",
    provenance: {
      capturedBy: "person_event_manager",
      capturedAt: new Date("2026-05-01T12:00:00.000Z"),
      origin: "human_asserted" as EvidenceOrigin,
    },
    ...overrides,
  });
}

/** The full promise, delivered. */
const COMPLETE: readonly EvidenceRecord[] = [
  ...Array.from({ length: 4 }, () => stream("obl_1_streams")),
  post("obl_1_posts"),
  post("obl_1_posts"),
  appearance("obl_1_final"),
];

describe("isObligationDischarged", () => {
  it("is false for an obligation with no evidence at all", () => {
    // The defect in one line: the legacy-shaped "fulfilled" checkbox with nothing
    // behind it. There is no call shape that returns true here.
    expect(isObligationDischarged(OBLIGATION, [], [])).toBe(false);
  });

  it("is false while any single part is short, no matter how much of the rest is done", () => {
    const three = [stream("obl_1_streams"), stream("obl_1_streams"), stream("obl_1_streams"), post("obl_1_posts"), post("obl_1_posts"), appearance("obl_1_final")];

    expect(isObligationDischarged(OBLIGATION, three, [])).toBe(false);
  });

  it("is true only when every part is exactly met", () => {
    expect(isObligationDischarged(OBLIGATION, COMPLETE, [])).toBe(true);
  });

  it("counts quantities, not evidence records: one record of four is four", () => {
    const batched = [
      stream("obl_1_streams", { quantity: 4, description: "Season export, four broadcasts in one pass." }),
      ...COMPLETE.slice(4),
    ];

    expect(isObligationDischarged(OBLIGATION, batched, [])).toBe(true);
  });

  it("does not read any stored flag, because there is not one to read", () => {
    // The structural guarantee, exercised rather than described: `OBLIGATION` has
    // no fulfilment property, so no input to this function can smuggle one in.
    // `compareDischargeClaim` below is where somebody's *claim* lives, and it is
    // a separate argument this function is never given.
    expect(Object.keys(OBLIGATION)).not.toContain("fulfilled");
    expect(Object.keys(OBLIGATION)).not.toContain("discharged");
    expect(isObligationDischarged(OBLIGATION, COMPLETE, [])).toBe(true);
    expect(isObligationDischarged(OBLIGATION, [], [])).toBe(false);
  });
});

describe("what may discharge a part", () => {
  it("requires the evidence kind to match the promised kind", () => {
    // The difference between a fulfilment check and a checkbox. Four evidence
    // records exist; none of them is about a live stream.
    const wrongKinds = [
      post("obl_1_streams"),
      post("obl_1_streams"),
      post("obl_1_streams"),
      post("obl_1_streams"),
      post("obl_1_posts"),
      post("obl_1_posts"),
      appearance("obl_1_final"),
    ];

    expect(isObligationDischarged(OBLIGATION, wrongKinds, [])).toBe(false);

    const report = computeDischarge(OBLIGATION, wrongKinds, []);
    const streams = report.parts.find((p) => p.partId === "obl_1_streams");
    expect(streams?.evidencedQuantity).toBe(0);
    expect(streams?.excludedEvidenceIds).toHaveLength(4);
  });

  it("names the kinds it excluded, so a mismatch is a report rather than a silent zero", () => {
    const report = computeDischarge(OBLIGATION, [post("obl_1_streams")], []);

    expect(report.parts[0]?.excludedEvidenceIds).toHaveLength(1);
    expect(report.parts[0]?.evidencedQuantity).toBe(0);
    expect(report.parts[0]?.state).toBe("outstanding");
  });

  it("ignores evidence that names no part of this obligation", () => {
    const report = computeDischarge(OBLIGATION, [stream("obl_1_unknown_part")], []);

    expect(report.parts.every((part) => part.evidencedQuantity === 0)).toBe(true);
    expect(report.unattachedEvidenceIds).toEqual(["ev_stream_" + sequence]);
  });

  it("ignores evidence belonging to a different obligation entirely", () => {
    const foreign = stream("obl_1_streams", { obligationId: "obl_other", organizationId: "org_1" });

    expect(isObligationDischarged(OBLIGATION, [foreign], [])).toBe(false);
  });

  it("ignores evidence belonging to a different organisation", () => {
    // Tenancy is the discriminator for every read in this package (ADR-0011); a
    // cross-tenant record that happened to satisfy the shape would otherwise let
    // one organisation's evidence discharge another's promise.
    const foreign = [
      ...Array.from({ length: 4 }, () => stream("obl_1_streams", { organizationId: "org_2" })),
      post("obl_1_posts", { organizationId: "org_2" }),
      post("obl_1_posts", { organizationId: "org_2" }),
      appearance("obl_1_final", { organizationId: "org_2" }),
    ];

    expect(isObligationDischarged(OBLIGATION, foreign, [])).toBe(false);
  });

  it("ignores retracted evidence and no other", () => {
    const records = [stream("obl_1_streams"), stream("obl_1_streams"), stream("obl_1_streams")];
    const retraction: EvidenceRetraction = retractEvidence({
      evidence: records[0]!,
      retractedAt: new Date("2026-05-20T09:00:00.000Z"),
      retractedBy: "person_compliance",
      reason: "wrong_match",
    });

    const report = computeDischarge(OBLIGATION, records, [retraction]);

    expect(report.parts[0]?.evidencedQuantity).toBe(2);
    expect(report.parts[0]?.excludedEvidenceIds).toContain(retraction ? records[0]!.evidenceId : "");
  });

  it("counts evidence again after it is retracted, because a retraction is scoped to the record it names", () => {
    const first = stream("obl_1_streams");
    const retraction = retractEvidence({
      evidence: first,
      retractedAt: new Date("2026-05-20T09:00:00.000Z"),
      retractedBy: "person_compliance",
      reason: "wrong_match",
    });
    const replacement = stream("obl_1_streams");

    const before = computeDischarge(OBLIGATION, [first, replacement], [retraction]);
    expect(before.parts[0]?.evidencedQuantity).toBe(1);
  });
});

describe("quantity exactness and over-fulfilment", () => {
  it("treats three of four as short by exactly one, and says so", () => {
    const three = [stream("obl_1_streams"), stream("obl_1_streams"), stream("obl_1_streams")];

    const report = computeDischarge(OBLIGATION, three, []);
    const streams = report.parts[0]!;

    expect(streams.state).toBe("partially_fulfilled");
    expect(streams.promisedQuantity).toBe(4);
    expect(streams.evidencedQuantity).toBe(3);
    expect(streams.shortfall).toBe(1);
    expect(streams.surplus).toBe(0);
  });

  it("marks over-fulfilment as its own state rather than collapsing it into fulfilled", () => {
    // Five streams against a promise of four is not "fulfilled" — it is a
    // different fact, and one with consequences: the fifth is usually a
    // double-record or an unbilled extra deliverable. Silently accepting it is
    // how an organisation ends up owing for four and delivering nobody can find
    // the fifth.
    const five = [...Array.from({ length: 5 }, () => stream("obl_1_streams")), ...COMPLETE.slice(4)];

    const report = computeDischarge(OBLIGATION, five, []);
    const streams = report.parts[0]!;

    expect(streams.state).toBe("over_fulfilled");
    expect(streams.evidencedQuantity).toBe(5);
    expect(streams.surplus).toBe(1);
    expect(streams.shortfall).toBe(0);
  });

  it("discharges an over-fulfilled obligation, because the promise was met and then some", () => {
    const five = [...Array.from({ length: 5 }, () => stream("obl_1_streams")), ...COMPLETE.slice(4)];

    expect(isObligationDischarged(OBLIGATION, five, [])).toBe(true);
  });

  it("surfaces the over-fulfilled parts on the report so the surplus is visible, not accepted", () => {
    const five = [...Array.from({ length: 5 }, () => stream("obl_1_streams")), ...COMPLETE.slice(4)];

    expect(computeDischarge(OBLIGATION, five, []).overFulfilledPartIds).toEqual(["obl_1_streams"]);
    expect(computeDischarge(OBLIGATION, COMPLETE, []).overFulfilledPartIds).toEqual([]);
  });

  it("never discharges on a partial delivery, however large the fraction", () => {
    const almost = [...Array.from({ length: 3 }, () => stream("obl_1_streams")), ...COMPLETE.slice(4)];

    expect(isObligationDischarged(OBLIGATION, almost, [])).toBe(false);
  });
});

describe("computeDischarge", () => {
  it("reports one entry per part, in the order the promise was written", () => {
    const report = computeDischarge(OBLIGATION, COMPLETE, []);

    expect(report.parts.map((part) => part.partId)).toEqual(["obl_1_streams", "obl_1_posts", "obl_1_final"]);
  });

  it("lists the evidence it counted, sorted, so the arithmetic can be checked by hand", () => {
    const report = computeDischarge(OBLIGATION, COMPLETE, []);
    const streams = report.parts[0]!;

    expect(streams.countedEvidenceIds).toEqual([...streams.countedEvidenceIds].sort());
    expect(streams.countedEvidenceIds).toHaveLength(4);
    expect(streams.evidencedQuantity).toBe(4);
  });

  it("marks an obligation with nothing met as outstanding on every part", () => {
    const report = computeDischarge(OBLIGATION, [], []);

    expect(report.discharged).toBe(false);
    expect(report.parts.every((part) => part.state === "outstanding")).toBe(true);
  });

  it("names the obligation it computed for", () => {
    expect(computeDischarge(OBLIGATION, [], []).obligationId).toBe("obl_1");
  });

  it("returns a frozen report", () => {
    const report = computeDischarge(OBLIGATION, COMPLETE, []);

    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.parts)).toBe(true);
    expect(Object.isFrozen(report.parts[0])).toBe(true);
  });
});

describe("a hand-set claim, and the drift between it and the parts", () => {
  const claim: ObligationDischargeClaim = Object.freeze({
    obligationId: "obl_1",
    organizationId: "org_1",
    claimedDischargedAt: new Date("2026-06-30T20:00:00.000Z"),
    claimedBy: "person_account_manager",
  });

  it("reports agreement when the claim matches what the evidence shows", () => {
    const outcome = compareDischargeClaim(OBLIGATION, COMPLETE, [], claim);

    expect(outcome.agrees).toBe(true);
    expect(outcome.claimedDischarged).toBe(true);
    expect(outcome.computedDischarged).toBe(true);
    expect(outcome.unsupportedPartIds).toEqual([]);
  });

  it("reports drift when an obligation with nothing behind it is claimed discharged", () => {
    // The defect, now made detectable rather than merely prevented. This is what a
    // stored flag looks like the moment it drifts: `claimed` is true, the
    // computed answer is false, and `agrees` is false.
    const outcome = compareDischargeClaim(OBLIGATION, [], [], claim);

    expect(outcome.claimedDischarged).toBe(true);
    expect(outcome.computedDischarged).toBe(false);
    expect(outcome.agrees).toBe(false);
  });

  it("names the parts the claim is not supported by", () => {
    const outcome = compareDischargeClaim(OBLIGATION, [stream("obl_1_streams")], [], claim);

    expect(outcome.unsupportedPartIds).toEqual(["obl_1_streams", "obl_1_posts", "obl_1_final"]);
  });

  it("names only the unsupported parts when some of them are genuinely met", () => {
    const outcome = compareDischargeClaim(
      OBLIGATION,
      [stream("obl_1_streams"), stream("obl_1_streams"), post("obl_1_posts"), post("obl_1_posts")],
      [],
      claim,
    );

    expect(outcome.unsupportedPartIds).toEqual(["obl_1_streams", "obl_1_final"]);
  });

  it("refuses a claim that names nobody, so the drift report is itself attributable", () => {
    expect(() => createDischargeClaim({ ...claim, claimedBy: "  " })).toThrow(/claimedBy/i);
  });

  it("refuses a claim with an invalid instant", () => {
    expect(() => createDischargeClaim({ ...claim, claimedDischargedAt: new Date("never") })).toThrow(
      /claimedDischargedAt/i,
    );
  });

  it("freezes the claim it creates", () => {
    const created = createDischargeClaim(claim);

    expect(Object.isFrozen(created)).toBe(true);
    expect(created.obligationId).toBe("obl_1");
  });

  it("carries a note when one is given, and omits the field when it is not", () => {
    expect(createDischargeClaim({ ...claim, note: "portal said it was done" }).note).toBe("portal said it was done");
    expect("note" in createDischargeClaim(claim)).toBe(false);
  });

  it("refuses a claim naming no obligation or no organisation", () => {
    expect(() => createDischargeClaim({ ...claim, obligationId: " " })).toThrow(/obligationId/i);
    expect(() => createDischargeClaim({ ...claim, organizationId: "" })).toThrow(/organizationId/i);
  });

  it("treats an absent claim as agreement, because nothing was asserted", () => {
    const outcome = compareDischargeClaim(OBLIGATION, COMPLETE, [], null);

    expect(outcome.claimedDischarged).toBe(false);
    expect(outcome.computedDischarged).toBe(true);
    // Nobody claimed this was delivered, so nobody has been contradicted. A
    // definition of "agrees" as plain boolean equality would put every unchecked
    // obligation into a review queue.
    expect(outcome.agrees).toBe(true);
  });

  it("ignores a claim raised against a different obligation or a different tenant", () => {
    const outcome = compareDischargeClaim(OBLIGATION, [], [], {
      ...claim,
      obligationId: "obl_other",
    });

    expect(outcome.claimedDischarged).toBe(false);
    expect(outcome.agrees).toBe(true);
  });
});

describe("latePartsAsOf", () => {
  it("reports nothing when every part was met before it was due", () => {
    const report = computeDischarge(OBLIGATION, COMPLETE, []);

    expect(latePartsAsOf(OBLIGATION, report, new Date("2026-05-02T00:00:00.000Z"))).toEqual([]);
  });

  it("reports a part met exactly at its due instant as on time, not late", () => {
    const onTime = [
      stream("obl_1_streams", {
        quantity: 4,
        observedAt: new Date("2026-06-30T23:59:59.000Z"),
        provenance: {
          capturedBy: "system:stream-ingest",
          capturedAt: new Date("2026-06-30T23:59:59.000Z"),
          origin: "machine_derived" as EvidenceOrigin,
          method: "twitch_exports_csv_v2",
        },
      }),
      post("obl_1_posts", { observedAt: new Date("2026-06-30T23:59:59.000Z"), provenance: { capturedBy: "person_account_manager", capturedAt: new Date("2026-06-30T23:59:59.000Z"), origin: "human_asserted" as EvidenceOrigin } }),
      appearance("obl_1_final", { observedAt: new Date("2026-07-12T18:00:00.000Z"), provenance: { capturedBy: "person_event_manager", capturedAt: new Date("2026-07-12T18:00:00.000Z"), origin: "human_asserted" as EvidenceOrigin } }),
    ];
    const report = computeDischarge(OBLIGATION, onTime, []);

    expect(latePartsAsOf(OBLIGATION, report, new Date("2026-12-31T00:00:00.000Z"))).toEqual([]);
  });

  it("reports a part met one millisecond after its due instant", () => {
    const justLate = [
      stream("obl_1_streams", {
        quantity: 4,
        observedAt: new Date("2026-07-01T00:00:00.000Z"),
        provenance: {
          capturedBy: "system:stream-ingest",
          capturedAt: new Date("2026-07-01T00:00:01.000Z"),
          origin: "machine_derived" as EvidenceOrigin,
          method: "twitch_exports_csv_v2",
        },
      }),
      post("obl_1_posts", { observedAt: new Date("2026-06-30T23:59:59.000Z"), provenance: { capturedBy: "person_account_manager", capturedAt: new Date("2026-06-30T23:59:59.000Z"), origin: "human_asserted" as EvidenceOrigin } }),
      appearance("obl_1_final", { observedAt: new Date("2026-07-12T18:00:00.000Z"), provenance: { capturedBy: "person_event_manager", capturedAt: new Date("2026-07-12T18:00:00.000Z"), origin: "human_asserted" as EvidenceOrigin } }),
    ];
    const report = computeDischarge(OBLIGATION, justLate, []);

    expect(latePartsAsOf(OBLIGATION, report, new Date("2026-12-31T00:00:00.000Z"))).toEqual(["obl_1_streams"]);
  });

  it("reports nothing for a part that was never met at all: lateness is not a lesser failure", () => {
    const report = computeDischarge(OBLIGATION, [], []);

    expect(latePartsAsOf(OBLIGATION, report, new Date("2026-12-31T00:00:00.000Z"))).toEqual([]);
  });

  it("uses the moment the evidence was captured, not the moment the deliverable happened", () => {
    // The org learns about a missed deliverable when somebody looks, not when the
    // clock passes. Using `observedAt` would report a stream as delivered because
    // somebody opened a spreadsheet in November.
    const capturedLongAfter = stream("obl_1_streams", {
      observedAt: new Date("2026-05-01T10:00:00.000Z"),
      provenance: {
        capturedBy: "system:stream-ingest",
        capturedAt: new Date("2026-11-01T00:00:00.000Z"),
        origin: "machine_derived" as EvidenceOrigin,
        method: "twitch_exports_csv_v2",
      },
    });
    const report = computeDischarge(OBLIGATION, [capturedLongAfter], []);

    expect(latePartsAsOf(OBLIGATION, report, new Date("2026-12-31T00:00:00.000Z"))).toEqual(["obl_1_streams"]);
  });

  it("refuses to report against an instant that is not a date", () => {
    const report = computeDischarge(OBLIGATION, COMPLETE, []);

    expect(() => latePartsAsOf(OBLIGATION, report, new Date("never"))).toThrow(/at/i);
  });

  it("refuses to read lateness off a report belonging to a different obligation", () => {
    // Two reports and two obligations would answer different questions, and
    // pairing them up by accident would report lateness against the wrong promise.
    const other = createObligation({ ...OBLIGATION_INPUT, obligationId: "obl_other" });
    const report = computeDischarge(OBLIGATION, COMPLETE, []);

    expect(() => latePartsAsOf(other, report, new Date("2026-12-31T00:00:00.000Z"))).toThrow(
      /obl_other|obl_1/,
    );
  });
});