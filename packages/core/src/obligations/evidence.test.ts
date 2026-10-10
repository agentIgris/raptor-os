import { describe, expect, it } from "vitest";

import { activeEvidence, recordEvidence, retractEvidence } from "./evidence.js";
import type { EvidenceRecord, EvidenceRetraction } from "./evidence.js";

/**
 * The part ids below belong to the obligation built in `./obligation.test.ts` and
 * `./discharge.test.ts`. This suite deliberately does not construct one: it is
 * about what an evidence record is, and a record does not need an aggregate to
 * exist in order to be frozen, attributed and retractable. Whether it *counts* is
 * `discharge.test.ts`'s question, and it is a different one.
 */

const CAPTURED_AT = new Date("2026-05-01T12:00:00.000Z");

/** A machine-derived observation: the platform's own export pipeline saw the stream. */
const MACHINE = Object.freeze({
  capturedBy: "system:stream-ingest",
  capturedAt: CAPTURED_AT,
  origin: "machine_derived" as const,
  method: "twitch_exports_csv_v2",
});

describe("recordEvidence", () => {
  it("returns a new frozen record without touching anything it was given", () => {
    const record = recordEvidence({
      evidenceId: "ev_1",
      obligationId: "obl_1",
      partId: "obl_1_streams",
      organizationId: "org_1",
      kind: "live_stream",
      quantity: 1,
      observedAt: new Date("2026-05-01T10:00:00.000Z"),
      description: "Co-stream, match day 3, 94 minutes.",
      provenance: MACHINE,
    });

    expect(record.evidenceId).toBe("ev_1");
    expect(record.quantity).toBe(1);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.provenance)).toBe(true);
  });

  it("carries provenance on every record: who captured it, when, and how", () => {
    // ADR-0019: the legacy system had no provenance column anywhere, which is how
    // a hardcoded confidence of 85 came to be presented as an OCR result. There is
    // no optional provenance here — the field is required, so a record without it
    // cannot be constructed.
    const record = recordEvidence({
      evidenceId: "ev_1",
      obligationId: "obl_1",
      partId: "obl_1_streams",
      organizationId: "org_1",
      kind: "live_stream",
      quantity: 1,
      observedAt: new Date("2026-05-01T10:00:00.000Z"),
      description: "Co-stream.",
      provenance: MACHINE,
    });

    expect(record.provenance).toEqual(MACHINE);
  });

  it("refuses a blank capturedBy: evidence nobody captured is not evidence", () => {
    expect(() =>
      recordEvidence({
        evidenceId: "ev_1",
        obligationId: "obl_1",
        partId: "obl_1_streams",
        organizationId: "org_1",
        kind: "live_stream",
        quantity: 1,
        observedAt: new Date("2026-05-01T10:00:00.000Z"),
        description: "Co-stream.",
        provenance: { ...MACHINE, capturedBy: "   " },
      }),
    ).toThrow(/capturedBy/i);
  });

  it("refuses an invalid capturedAt", () => {
    expect(() =>
      recordEvidence({
        evidenceId: "ev_1",
        obligationId: "obl_1",
        partId: "obl_1_streams",
        organizationId: "org_1",
        kind: "live_stream",
        quantity: 1,
        observedAt: new Date("2026-05-01T10:00:00.000Z"),
        description: "Co-stream.",
        provenance: { ...MACHINE, capturedAt: new Date("nope") },
      }),
    ).toThrow(/capturedAt/i);
  });

  it("requires a named method for machine-derived evidence", () => {
    // This is the rule that makes "derived" mean something. A machine-derived
    // claim that does not name the process that derived it is precisely the
    // failure ADR-0019 describes: a constant presented as a measurement.
    expect(() =>
      recordEvidence({
        evidenceId: "ev_1",
        obligationId: "obl_1",
        partId: "obl_1_streams",
        organizationId: "org_1",
        kind: "live_stream",
        quantity: 1,
        observedAt: new Date("2026-05-01T10:00:00.000Z"),
        description: "Co-stream.",
        provenance: { capturedBy: "system:stream-ingest", capturedAt: CAPTURED_AT, origin: "machine_derived" },
      }),
    ).toThrow(/method/i);
  });

  it("refuses a method on human-asserted evidence, which would dress a claim up as a measurement", () => {
    expect(() =>
      recordEvidence({
        evidenceId: "ev_1",
        obligationId: "obl_1",
        partId: "obl_1_streams",
        organizationId: "org_1",
        kind: "live_stream",
        quantity: 1,
        observedAt: new Date("2026-05-01T10:00:00.000Z"),
        description: "Co-stream.",
        provenance: {
          capturedBy: "person_manager",
          capturedAt: CAPTURED_AT,
          origin: "human_asserted",
          method: "twitch_exports_csv_v2",
        },
      }),
    ).toThrow(/method/i);
  });

  it("refuses an unknown origin", () => {
    expect(() =>
      recordEvidence({
        evidenceId: "ev_1",
        obligationId: "obl_1",
        partId: "obl_1_streams",
        organizationId: "org_1",
        kind: "live_stream",
        quantity: 1,
        observedAt: new Date("2026-05-01T10:00:00.000Z"),
        description: "Co-stream.",
        provenance: { capturedBy: "person_manager", capturedAt: CAPTURED_AT, origin: "vibes" as never },
      }),
    ).toThrow(/origin/i);
  });

  it("accepts human-asserted evidence with no method", () => {
    const record = recordEvidence({
      evidenceId: "ev_1",
      obligationId: "obl_1",
      partId: "obl_1_streams",
      organizationId: "org_1",
      kind: "live_stream",
      quantity: 1,
      observedAt: new Date("2026-05-01T10:00:00.000Z"),
      description: "Partner's producer said they ran the co-stream.",
      provenance: { capturedBy: "person_manager", capturedAt: CAPTURED_AT, origin: "human_asserted" },
    });

    expect(record.provenance.origin).toBe("human_asserted");
    expect("method" in record.provenance).toBe(false);
  });

  it("refuses a blank evidence id, obligation id, part id or organisation id", () => {
    const base = {
      obligationId: "obl_1",
      partId: "obl_1_streams",
      organizationId: "org_1",
      kind: "live_stream" as const,
      quantity: 1,
      observedAt: new Date("2026-05-01T10:00:00.000Z"),
      description: "Co-stream.",
      provenance: MACHINE,
    };

    expect(() => recordEvidence({ ...base, evidenceId: " " })).toThrow(/evidenceId/i);
    expect(() => recordEvidence({ ...base, evidenceId: "ev_1", obligationId: "" })).toThrow(/obligationId/i);
    expect(() => recordEvidence({ ...base, evidenceId: "ev_1", partId: "" })).toThrow(/partId/i);
    expect(() => recordEvidence({ ...base, evidenceId: "ev_1", organizationId: "" })).toThrow(/organizationId/i);
  });

  it("refuses a blank description: evidence nobody could identify later", () => {
    expect(() =>
      recordEvidence({
        evidenceId: "ev_1",
        obligationId: "obl_1",
        partId: "obl_1_streams",
        organizationId: "org_1",
        kind: "live_stream",
        quantity: 1,
        observedAt: new Date("2026-05-01T10:00:00.000Z"),
        description: " ",
        provenance: MACHINE,
      }),
    ).toThrow(/description/i);
  });

  it("refuses a zero or negative quantity: evidence of nothing is not evidence", () => {
    const base = {
      evidenceId: "ev_1",
      obligationId: "obl_1",
      partId: "obl_1_streams",
      organizationId: "org_1",
      kind: "live_stream" as const,
      observedAt: new Date("2026-05-01T10:00:00.000Z"),
      description: "Co-stream.",
      provenance: MACHINE,
    };

    expect(() => recordEvidence({ ...base, quantity: 0 })).toThrow(/quantity/i);
    expect(() => recordEvidence({ ...base, quantity: -1 })).toThrow(/quantity/i);
    expect(() => recordEvidence({ ...base, quantity: 1.5 })).toThrow(/quantity|integer/i);
  });

  it("refuses an off-vocabulary kind, so evidence cannot be typed to fit a promise after the fact", () => {
    expect(() =>
      recordEvidence({
        evidenceId: "ev_1",
        obligationId: "obl_1",
        partId: "obl_1_streams",
        organizationId: "org_1",
        kind: "something_streamy" as never,
        quantity: 1,
        observedAt: new Date("2026-05-01T10:00:00.000Z"),
        description: "Co-stream.",
        provenance: MACHINE,
      }),
    ).toThrow(/kind/i);
  });

  it("refuses evidence of something that had not happened yet when it was captured", () => {
    // A record cannot witness an event that postdates its own writing. It is the
    // same rule `withdrawConsent` and `withdrawAcceptance` apply for the same
    // reason — an event that postdates its own cause is a corrupted record, and a
    // corrupted record in an append-only ledger stays corrupted forever.
    expect(() =>
      recordEvidence({
        evidenceId: "ev_1",
        obligationId: "obl_1",
        partId: "obl_1_streams",
        organizationId: "org_1",
        kind: "live_stream",
        quantity: 1,
        observedAt: new Date("2026-06-01T00:00:00.000Z"),
        description: "Co-stream.",
        provenance: MACHINE,
      }),
    ).toThrow(/captured at|capturedAt/i);
  });

  it("accepts an observation captured at the exact instant it happened", () => {
    // The boundary: same instant is not "after". `<` rather than `<=` for the
    // same reason `isMinor` uses `<`: equality is not a violation, and an
    // inclusive boundary here would reject every record written synchronously
    // with the event it reports.
    expect(() =>
      recordEvidence({
        evidenceId: "ev_boundary",
        obligationId: "obl_1",
        partId: "obl_1_streams",
        organizationId: "org_1",
        kind: "live_stream",
        quantity: 1,
        observedAt: CAPTURED_AT,
        description: "Co-stream.",
        provenance: MACHINE,
      }),
    ).not.toThrow();
  });

  it("produces a distinct record per call and never rewrites the one before it", () => {
    const base = {
      obligationId: "obl_1",
      partId: "obl_1_streams",
      organizationId: "org_1",
      kind: "live_stream" as const,
      quantity: 1,
      observedAt: new Date("2026-05-01T10:00:00.000Z"),
      description: "Co-stream.",
      provenance: MACHINE,
    };
    const first = recordEvidence({ ...base, evidenceId: "ev_1" });
    const second = recordEvidence({ ...base, evidenceId: "ev_2", quantity: 2 });

    expect(first).not.toBe(second);
    expect(first.quantity).toBe(1);
    expect(second.quantity).toBe(2);
  });
it("refuses an invalid observedAt", () => {
    expect(() =>
      recordEvidence({
        evidenceId: "ev_1",
        obligationId: "obl_1",
        partId: "obl_1_streams",
        organizationId: "org_1",
        kind: "live_stream",
        quantity: 1,
        observedAt: new Date("never"),
        description: "Co-stream.",
        provenance: MACHINE,
      }),
    ).toThrow(/observedAt/i);
  });

  it("refuses a record with no provenance object at all", () => {
    // The provenance check has to survive a caller that passes nothing at all,
    // which a JSON body can do; otherwise the next property read throws a
    // TypeError instead of saying what is wrong.
    expect(() =>
      recordEvidence({
        evidenceId: "ev_1",
        obligationId: "obl_1",
        partId: "obl_1_streams",
        organizationId: "org_1",
        kind: "live_stream",
        quantity: 1,
        observedAt: new Date("2026-05-01T10:00:00.000Z"),
        description: "Co-stream.",
        provenance: null as never,
      }),
    ).toThrow(/provenance/i);
  });
});

describe("retractEvidence", () => {
  const evidence: EvidenceRecord = recordEvidence({
    evidenceId: "ev_1",
    obligationId: "obl_1",
    partId: "obl_1_streams",
    organizationId: "org_1",
    kind: "live_stream",
    quantity: 1,
    observedAt: new Date("2026-05-01T10:00:00.000Z"),
    description: "Co-stream.",
    provenance: MACHINE,
  });

  it("appends a new record naming the original, leaving the original untouched", () => {
    const retraction = retractEvidence({
      evidence,
      retractedAt: new Date("2026-05-20T09:00:00.000Z"),
      retractedBy: "person_compliance",
      reason: "wrong_match",
    });

    expect(retraction.evidenceId).toBe("ev_1");
    expect(retraction.organizationId).toBe("org_1");
    expect(Object.isFrozen(retraction)).toBe(true);

    // The original is still exactly what it was. Retraction is append-only: the
    // evidence was captured, and the fact that it was captured does not stop
    // being true when it turns out to be wrong.
    expect(evidence.quantity).toBe(1);
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it("refuses a retraction dated before the capture it retracts", () => {
    expect(() =>
      retractEvidence({
        evidence,
        retractedAt: new Date("2026-04-01T00:00:00.000Z"),
        retractedBy: "person_compliance",
        reason: "wrong_match",
      }),
    ).toThrow(/predate|before/i);
  });

  it("refuses a blank retractedBy and an invalid instant", () => {
    expect(() =>
      retractEvidence({ evidence, retractedAt: new Date("2026-05-20T09:00:00.000Z"), retractedBy: "", reason: "wrong_match" }),
    ).toThrow(/retractedBy/i);
    expect(() =>
      retractEvidence({
        evidence,
        retractedAt: new Date("never"),
        retractedBy: "person_compliance",
        reason: "wrong_match",
      }),
    ).toThrow(/retractedAt/i);
  });

  it("requires a stated reason, which is the whole point of a retraction", () => {
    expect(() =>
      retractEvidence({
        evidence,
        retractedAt: new Date("2026-05-20T09:00:00.000Z"),
        retractedBy: "person_compliance",
        reason: "  " as never,
      }),
    ).toThrow(/reason/i);
  });

  it("refuses to retract a retraction, so the chain cannot be collapsed from either end", () => {
    // A retraction is itself an assertion about the record. Allowing it to be
    // retracted would mean the fact that anyone ever disputed the evidence
    // disappears, which is the same defect as deleting the evidence.
    const retraction = retractEvidence({
      evidence,
      retractedAt: new Date("2026-05-20T09:00:00.000Z"),
      retractedBy: "person_compliance",
      reason: "wrong_match",
    });

    expect(() =>
      retractEvidence({
        evidence: retraction as unknown as EvidenceRecord,
        retractedAt: new Date("2026-05-21T09:00:00.000Z"),
        retractedBy: "person_compliance",
        reason: "wrong_match",
      }),
    ).toThrow(/retraction/i);
  });

  it("scopes a retraction to its own tenant, so a same-id collision cannot erase another org's evidence", () => {
    // Ids are caller-supplied, so two organisations can hold the same
    // `evidenceId`. A retraction that matched on the id alone would let one
    // tenant's dispute silence another tenant's evidence.
    const foreignRetraction: EvidenceRetraction = retractEvidence({
      evidence: { ...evidence, organizationId: "org_2" },
      retractedAt: new Date("2026-05-20T09:00:00.000Z"),
      retractedBy: "person_compliance",
      reason: "wrong_match",
    });

    expect(foreignRetraction.organizationId).toBe("org_2");
    expect(activeEvidence([evidence], [foreignRetraction])).toEqual([evidence]);
  });
});

describe("activeEvidence", () => {
  const evidence: EvidenceRecord = recordEvidence({
    evidenceId: "ev_1",
    obligationId: "obl_1",
    partId: "obl_1_streams",
    organizationId: "org_1",
    kind: "live_stream",
    quantity: 1,
    observedAt: new Date("2026-05-01T10:00:00.000Z"),
    description: "Co-stream.",
    provenance: MACHINE,
  });

  it("returns the evidence when nothing has been retracted", () => {
    expect(activeEvidence([evidence], [])).toEqual([evidence]);
  });

  it("drops only the evidence the retraction names", () => {
    const other: EvidenceRecord = recordEvidence({
      evidenceId: "ev_2",
      obligationId: "obl_1",
      partId: "obl_1_streams",
      organizationId: "org_1",
      kind: "live_stream",
      quantity: 1,
      observedAt: new Date("2026-05-08T10:00:00.000Z"),
      description: "Co-stream, match day 4.",
      provenance: { ...MACHINE, capturedAt: new Date("2026-05-08T12:00:00.000Z") },
    });
    const retraction: EvidenceRetraction = retractEvidence({
      evidence,
      retractedAt: new Date("2026-05-20T09:00:00.000Z"),
      retractedBy: "person_compliance",
      reason: "wrong_match",
    });

    expect(activeEvidence([evidence, other], [retraction])).toEqual([other]);
  });

  it("drops evidence whose retraction belongs to another obligation, an id coincidence is not a retraction", () => {
    const foreign: EvidenceRetraction = {
      ...retractEvidence({
        evidence,
        retractedAt: new Date("2026-05-20T09:00:00.000Z"),
        retractedBy: "person_compliance",
        reason: "wrong_match",
      }),
      obligationId: "obl_other",
    };

    expect(activeEvidence([evidence], [foreign])).toEqual([evidence]);
  });

  it("preserves input order, so the caller's ordering survives for its own report", () => {
    const second: EvidenceRecord = recordEvidence({
      evidenceId: "ev_0",
      obligationId: "obl_1",
      partId: "obl_1_streams",
      organizationId: "org_1",
      kind: "live_stream",
      quantity: 1,
      observedAt: new Date("2026-04-01T10:00:00.000Z"),
      description: "Co-stream, match day 1.",
      provenance: { ...MACHINE, capturedAt: new Date("2026-04-01T12:00:00.000Z") },
    });

    expect(activeEvidence([second, evidence], []).map((e) => e.evidenceId)).toEqual(["ev_0", "ev_1"]);
  });
});