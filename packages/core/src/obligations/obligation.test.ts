import { describe, expect, it } from "vitest";

import { OBLIGATION_PART_KINDS, createObligation } from "./obligation.js";
import type { CreateObligationInput } from "./obligation.js";

/**
 * The worked example, taken from the design spec's framing: a sponsorship says
 * *"4 streams, 2 social posts, appear at the final"*. Every obligation test in
 * this package is recognisable as a variation on those three parts, because the
 * defect being prevented is an organisation marking a sponsorship fulfilled with
 * nothing behind it — and the only way to test that is against a promise whose
 * parts can individually be short.
 */
const SPONSORSHIP: CreateObligationInput = Object.freeze({
  obligationId: "obl_1",
  organizationId: "org_1",
  partnerId: "partner_1",
  contractVersionId: "contract_version_3",
  title: "Season 6 title sponsorship",
  parts: Object.freeze([
    Object.freeze({
      partId: "obl_1_streams",
      kind: "live_stream" as const,
      promisedQuantity: 4,
      dueAt: new Date("2026-06-30T23:59:59.000Z"),
      description: "Four co-streamed broadcasts.",
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
  ]),
});

describe("createObligation", () => {
  it("returns the parts as given, frozen and deep-frozen", () => {
    const obligation = createObligation(SPONSORSHIP);

    expect(obligation.obligationId).toBe("obl_1");
    expect(obligation.parts).toHaveLength(3);
    expect(Object.isFrozen(obligation)).toBe(true);
    expect(Object.isFrozen(obligation.parts)).toBe(true);
    for (const part of obligation.parts) {
      expect(Object.isFrozen(part)).toBe(true);
    }
  });

  it("copies the parts rather than aliasing the caller's array", () => {
    // A version that can be changed from outside its own object is not immutable,
    // whatever `readonly` says in the type. Mutating the caller's array afterwards
    // must not change what the obligation promises.
    const parts = [...SPONSORSHIP.parts];
    const obligation = createObligation({ ...SPONSORSHIP, parts });

    parts.push({
      partId: "obl_1_smuggled",
      kind: "content_delivery",
      promisedQuantity: 99,
      dueAt: new Date("2026-01-01T00:00:00.000Z"),
      description: "Never promised.",
    });

    expect(obligation.parts).toHaveLength(3);
  });

  it("preserves part order, because the order the promise was written in is part of it", () => {
    const obligation = createObligation(SPONSORSHIP);
    expect(obligation.parts.map((part) => part.partId)).toEqual(["obl_1_streams", "obl_1_posts", "obl_1_final"]);
  });

  it("refuses an obligation with no parts: a promise with nothing in it discharges trivially", () => {
    expect(() => createObligation({ ...SPONSORSHIP, parts: [] })).toThrow(/part/i);
  });

  it("refuses a blank obligation id", () => {
    expect(() => createObligation({ ...SPONSORSHIP, obligationId: "  " })).toThrow(/obligationId/i);
  });

  it("refuses a blank organisation id: tenancy is the discriminator for every query here", () => {
    expect(() => createObligation({ ...SPONSORSHIP, organizationId: "" })).toThrow(/organizationId/i);
  });

  it("refuses a blank partner id", () => {
    expect(() => createObligation({ ...SPONSORSHIP, partnerId: "" })).toThrow(/partnerId/i);
  });

  it("refuses a blank contract version id: an obligation that promises nothing in particular cannot be proved", () => {
    expect(() => createObligation({ ...SPONSORSHIP, contractVersionId: "" })).toThrow(/contractVersionId/i);
  });

  it("refuses a blank title", () => {
    expect(() => createObligation({ ...SPONSORSHIP, title: "   " })).toThrow(/title/i);
  });

  it("refuses duplicate part ids, which would make the per-part report ambiguous", () => {
    expect(() =>
      createObligation({
        ...SPONSORSHIP,
        parts: [SPONSORSHIP.parts[0]!, SPONSORSHIP.parts[0]!],
      }),
    ).toThrow(/duplicate|twice|partId/i);
  });

  it("refuses a part with a blank partId, which would make the per-part report ambiguous", () => {
    const [first] = SPONSORSHIP.parts;
    expect(() => createObligation({ ...SPONSORSHIP, parts: [{ ...first!, partId: "  " }] })).toThrow(/partId/i);
  });

  it("refuses a part whose kind is not one of the declared kinds", () => {
    const [first] = SPONSORSHIP.parts;
    expect(() =>
      createObligation({
        ...SPONSORSHIP,
        // Deliberately off-vocabulary: the union stops a TypeScript caller, but a
        // JSON body from a request handler would still arrive here.
        parts: [{ ...first!, kind: "vibes" as never }],
      }),
    ).toThrow(/kind/i);
  });

  it("declares every part kind exactly once, in a closed set", () => {
    // An open string kind would let a caller invent a kind at the call site, and
    // then a screenshot could discharge a promise of live streams.
    expect(new Set(OBLIGATION_PART_KINDS).size).toBe(OBLIGATION_PART_KINDS.length);
    expect(OBLIGATION_PART_KINDS.length).toBeGreaterThan(0);
  });

  it("refuses a promised quantity below one: zero of something is not a promise", () => {
    const [first] = SPONSORSHIP.parts;
    expect(() => createObligation({ ...SPONSORSHIP, parts: [{ ...first!, promisedQuantity: 0 }] })).toThrow(
      /promisedQuantity/i,
    );
    expect(() => createObligation({ ...SPONSORSHIP, parts: [{ ...first!, promisedQuantity: -2 }] })).toThrow(
      /promisedQuantity/i,
    );
  });

  it("refuses a fractional promised quantity, because a partial stream is not a stream", () => {
    const [first] = SPONSORSHIP.parts;
    expect(() => createObligation({ ...SPONSORSHIP, parts: [{ ...first!, promisedQuantity: 2.5 }] })).toThrow(
      /promisedQuantity|integer/i,
    );
  });

  it("refuses an invalid due date", () => {
    const [first] = SPONSORSHIP.parts;
    expect(() => createObligation({ ...SPONSORSHIP, parts: [{ ...first!, dueAt: new Date("nope") }] })).toThrow(
      /dueAt/i,
    );
  });

  it("refuses a blank part description: a deliverable nobody could identify", () => {
    const [first] = SPONSORSHIP.parts;
    expect(() => createObligation({ ...SPONSORSHIP, parts: [{ ...first!, description: " " }] })).toThrow(
      /description/i,
    );
  });
});

describe("an obligation carries no fulfilment flag at all", () => {
  it("has no property that records whether it has been fulfilled", () => {
    // The whole defect this package exists to prevent is a hand-set flag drifting
    // from the parts it is supposed to summarise. The structural answer is that
    // the field does not exist: `isObligationDischarged` cannot read a claim
    // because there is no claim on the type.
    const obligation = createObligation(SPONSORSHIP);

    expect(Object.keys(obligation).sort()).toEqual([
      "contractVersionId",
      "obligationId",
      "organizationId",
      "partnerId",
      "parts",
      "title",
    ]);
  });

  it("has no per-part state either, for the same reason", () => {
    const obligation = createObligation(SPONSORSHIP);
    for (const part of obligation.parts) {
      expect(Object.keys(part).sort()).toEqual(["description", "dueAt", "kind", "partId", "promisedQuantity"]);
    }
  });
});