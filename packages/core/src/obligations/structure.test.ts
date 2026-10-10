/**
 * Structural guarantees, tested rather than asserted in prose.
 *
 * These do not test behaviour — `obligation.test.ts`, `evidence.test.ts` and
 * `discharge.test.ts` do that. They test **shape**: that the guarantees the
 * module comments make are still true of the exported surface. A guarantee that
 * exists only in a comment is a comment, and comments do not fail a build.
 *
 * The mutator-name check follows the pattern `contracts/structure.test.ts` and
 * the ledger already use. It is deliberately not the whole story — a mutator named
 * innocuously would slip past it — but it forces anyone who really wants an edit
 * path to name it `amend*` or `retract*`, and every such name is listed below
 * with the reason it is safe, so the escape hatch is visible.
 */

import { describe, expect, it } from "vitest";

import * as obligations from "./index.js";

/**
 * Exports whose names contain an edit-like word, and why each is safe.
 *
 * - `retractEvidence` — appends an `EvidenceRetraction`. It writes nothing and
 *   deletes nothing.
 * - `activeEvidence` — reads. It reports what is left after retractions.
 *
 * The `EvidenceRetraction` and `EvidenceRetractionReason` *types* are deliberately
 * absent: `Object.keys` sees runtime values only, so listing them here would make
 * the honesty check below fail for names that can never appear in the scan.
 */
const ALLOWED_EDIT_LIKE = new Set(["retractEvidence", "activeEvidence"]);

/** Names that would mean "change an existing record in place". */
const MUTATOR_PATTERN =
  /(amend|update|mutate|delete|remove|replace|patch|purge|void|edit|rewrite|backdate|overwrite|undo|correct)/i;

describe("the obligations package exports no in-place mutator", () => {
  it("exports nothing named as an edit, a delete or a correction", () => {
    const offenders = Object.keys(obligations).filter(
      (name) => !ALLOWED_EDIT_LIKE.has(name) && MUTATOR_PATTERN.test(name),
    );

    // Retraction is the only correction path, and it appends. If an in-place
    // mutator ever appears under a name not listed above, this fails and makes
    // that an argument rather than a review comment nobody reads.
    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist honest: every listed name still exists", () => {
    // A stale allowlist entry would silently permit a future export to reuse the
    // name it describes, which is the whole point of this file.
    for (const name of ALLOWED_EDIT_LIKE) {
      expect(name in obligations).toBe(true);
    }
  });

  it("demonstrates that the one retraction path appends and leaves the original alone", () => {
    const record = obligations.recordEvidence({
      evidenceId: "ev_1",
      obligationId: "obl_1",
      partId: "obl_1_streams",
      organizationId: "org_1",
      kind: "live_stream",
      quantity: 1,
      observedAt: new Date("2026-05-01T10:00:00.000Z"),
      description: "Co-stream.",
      provenance: {
        capturedBy: "system:stream-ingest",
        capturedAt: new Date("2026-05-01T12:00:00.000Z"),
        origin: "machine_derived",
        method: "twitch_exports_csv_v2",
      },
    });

    const retraction = obligations.retractEvidence({
      evidence: record,
      retractedAt: new Date("2026-05-20T09:00:00.000Z"),
      retractedBy: "person_compliance",
      reason: "wrong_match",
    });

    expect(retraction).not.toBe(record);
    // The original is unchanged and still frozen: the evidence was captured, and
    // that fact does not stop being true because it was later disputed.
    expect(record.quantity).toBe(1);
    expect(Object.isFrozen(record)).toBe(true);
    expect(obligations.activeEvidence([record], [retraction])).toEqual([]);
  });
});

describe("the discharge proof is reachable from the package entry point", () => {
  it("exposes obligation, evidence, claim and computation together", () => {
    // "Obligation fulfilment provable end to end" is unusable if the barrel stops
    // re-exporting one of these: a caller would have to reach into private paths
    // and the guarantee would quietly stop being available.
    for (const name of [
      "createObligation",
      "recordEvidence",
      "retractEvidence",
      "activeEvidence",
      "createDischargeClaim",
      "isObligationDischarged",
      "computeDischarge",
      "compareDischargeClaim",
      "latePartsAsOf",
    ] as const) {
      expect(typeof obligations[name]).toBe("function");
    }
  });

  it("exposes the part-kind vocabulary, not only a predicate over it", () => {
    // A predicate with no table cannot be audited. "What kinds of deliverable
    // exist?" has to be answerable by reading something.
    expect(obligations.OBLIGATION_PART_KINDS).toContain("live_stream");
    expect(obligations.OBLIGATION_PART_KINDS).toContain("social_post");
    expect(obligations.OBLIGATION_PART_KINDS).toContain("appearance");
  });

  it("keeps the promise and the proof in one package, so the criteria cannot be satisfied separately", () => {
    // If `isObligationDischarged` could be reached without `createObligation`,
    // somebody could compute fulfilment over a shape nothing in this package
    // vouched for.
    expect(typeof obligations.createObligation).toBe("function");
    expect(typeof obligations.isObligationDischarged).toBe("function");
  });
});