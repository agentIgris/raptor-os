import { describe, expect, it } from "vitest";

import type { PartnerStage } from "./pipeline.js";
import {
  IRREVERSIBLE_PARTNER_TRANSITIONS,
  PARTNER_STAGES,
  PARTNER_TRANSITIONS,
  assertCanTransition,
  canTransition,
  isIrreversibleTransition,
  isTerminalStage,
  nextStages,
  transitionPartner,
} from "./pipeline.js";

describe("the transition table", () => {
  it("names every stage exactly once", () => {
    expect(Object.keys(PARTNER_TRANSITIONS).sort()).toEqual([...PARTNER_STAGES].sort());
  });

  it("only ever points at stages that exist", () => {
    for (const targets of Object.values(PARTNER_TRANSITIONS)) {
      for (const target of targets) {
        expect(PARTNER_STAGES).toContain(target);
      }
    }
  });

  it("never lists a stage as transitioning to itself", () => {
    for (const [from, targets] of Object.entries(PARTNER_TRANSITIONS)) {
      expect(targets).not.toContain(from as PartnerStage);
    }
  });

  it("declares the six stages the pipeline is made of, in order", () => {
    expect(PARTNER_STAGES).toEqual(["lead", "qualified", "negotiation", "signed", "active", "lapsed"]);
  });
});

describe("canTransition across the full matrix", () => {
  const pairs = PARTNER_STAGES.flatMap((from) => PARTNER_STAGES.map((to) => ({ from, to })));

  it("covers every ordered pair of stages", () => {
    expect(pairs).toHaveLength(PARTNER_STAGES.length * PARTNER_STAGES.length);
  });

  it.each(pairs)("$from -> $to is $expected", ({ from, to }) => {
    const declared = PARTNER_TRANSITIONS[from].includes(to);
    expect(canTransition(from, to)).toBe(declared);
  });

  it("refuses every transition out of a terminal stage", () => {
    for (const stage of PARTNER_STAGES.filter(isTerminalStage)) {
      for (const target of PARTNER_STAGES) {
        expect(canTransition(stage, target)).toBe(false);
      }
    }
  });

  it("rejects an unknown stage rather than defaulting it to allowed", () => {
    expect(() => canTransition("churned" as PartnerStage, "lead")).toThrow(/unknown/i);
    expect(() => canTransition("lead", "churned" as PartnerStage)).toThrow(/unknown/i);
  });
});

describe("the pipeline does not run backwards", () => {
  it("will not let a signed partner silently re-enter negotiation", () => {
    // The specific failure: a deal that was signed quietly returning to
    // "negotiation", which reads to every downstream report as though it were
    // still being negotiated. Nothing about that is honest — if terms really did
    // reopen, that is a new deal, not a rewound one.
    expect(canTransition("signed", "negotiation")).toBe(false);
    expect(() => assertCanTransition("signed", "negotiation")).toThrow(/signed.*negotiation|negotiation.*signed/s);
  });

  it("will not let an active partner go back to signed, or a signed one to lead", () => {
    expect(canTransition("active", "signed")).toBe(false);
    expect(canTransition("active", "lead")).toBe(false);
    expect(canTransition("signed", "lead")).toBe(false);
    expect(canTransition("signed", "qualified")).toBe(false);
  });

  it("will not let a partner skip from lead straight to signed", () => {
    // Signing is the stage the contract, the obligations and the invoice hang
    // off. A lead marked signed with no negotiation, no contract and no evidence
    // is the sponsorship defect arriving a phase early.
    expect(canTransition("lead", "signed")).toBe(false);
    expect(canTransition("lead", "active")).toBe(false);
    expect(canTransition("qualified", "signed")).toBe(false);
  });

  it("lets a deal step back from negotiation to qualified while terms are discussed", () => {
    // The one backward edge, and it is symmetric. Terms fall apart and are
    // renegotiated; that is a normal event, and modelling it in one direction only
    // would mean the second conversation could not happen.
    expect(canTransition("negotiation", "qualified")).toBe(true);
    expect(canTransition("qualified", "negotiation")).toBe(true);
    expect(isIrreversibleTransition("qualified", "negotiation")).toBe(false);
    expect(isIrreversibleTransition("negotiation", "qualified")).toBe(false);
  });

  it("lets any live stage lapse, because a partner can go quiet at any point", () => {
    for (const stage of ["lead", "qualified", "negotiation", "signed", "active"] as const) {
      expect(canTransition(stage, "lapsed")).toBe(true);
    }
  });

  it("has nowhere to go from lapsed", () => {
    expect(isTerminalStage("lapsed")).toBe(true);
    expect(nextStages("lapsed")).toEqual([]);
  });
});

describe("irreversibility", () => {
  it("derives the irreversible set from the table and it matches the pinned list", () => {
    // Pinned explicitly so the table cannot quietly widen what can never be
    // undone. Adding an edge back out of `signed` has to be an argument somebody
    // makes, not an edit that changes forty pipeline reports in silence.
    expect([...IRREVERSIBLE_PARTNER_TRANSITIONS].sort()).toEqual(
      [
        "active->lapsed",
        "lead->lapsed",
        "lead->qualified",
        "negotiation->lapsed",
        "negotiation->signed",
        "qualified->lapsed",
        "signed->active",
        "signed->lapsed",
      ].sort(),
    );
  });

  it("marks signing as a one-way door, which is what makes a signature worth anything", () => {
    expect(isIrreversibleTransition("negotiation", "signed")).toBe(true);
    expect(canTransition("signed", "negotiation")).toBe(false);
  });

  it("marks every move into lapsed as irreversible, because lapsed is terminal", () => {
    for (const stage of ["lead", "qualified", "negotiation", "signed", "active"] as const) {
      expect(isIrreversibleTransition(stage, "lapsed")).toBe(true);
    }
  });

  it("marks qualifying as irreversible: nobody is demoted back to a raw lead", () => {
    expect(isIrreversibleTransition("lead", "qualified")).toBe(true);
    expect(canTransition("qualified", "lead")).toBe(false);
  });

  it("never marks a terminal stage as a transition at all", () => {
    for (const from of PARTNER_STAGES.filter(isTerminalStage)) {
      for (const to of PARTNER_STAGES) {
        expect(isIrreversibleTransition(from, to)).toBe(false);
      }
    }
  });

  it("returns false for an edge the table does not declare at all", () => {
    // Irreversibility is a property of a declared edge. An undeclared pair is
    // simply illegal, and calling it "irreversible" would make the two
    // indistinguishable in a report.
    expect(isIrreversibleTransition("lead", "signed")).toBe(false);
  });

  it("rejects an unknown stage", () => {
    expect(() => isIrreversibleTransition("lead", "churned" as PartnerStage)).toThrow(/unknown/i);
  });
});

describe("nextStages", () => {
  it("returns the declared successors of a stage", () => {
    expect(nextStages("negotiation")).toEqual(["signed", "qualified", "lapsed"]);
  });

  it("returns a frozen list, so a caller cannot sort the table away for everybody", () => {
    expect(Object.isFrozen(nextStages("negotiation"))).toBe(true);
  });

  it("rejects an unknown stage", () => {
    expect(() => nextStages("churned" as PartnerStage)).toThrow(/unknown/i);
  });
});

describe("assertCanTransition", () => {
  it("passes for a declared transition", () => {
    expect(() => assertCanTransition("lead", "qualified")).not.toThrow();
  });

  it("names the permitted moves when it refuses one", () => {
    expect(() => assertCanTransition("signed", "negotiation")).toThrow(/active|lapsed/);
  });
});

describe("transitionPartner", () => {
  const AT = new Date("2026-04-01T09:00:00.000Z");

  it("returns a frozen record of the move rather than mutating a partner", () => {
    const record = transitionPartner({ partnerId: "partner_1",
      from: "negotiation",
      to: "signed",
      at: AT,
      actorId: "person_commercial",
      reason: "countersigned sponsorship agreement",
    });

    expect(record).toEqual({
      partnerId: "partner_1",
      from: "negotiation",
      to: "signed",
      at: AT,
      actorId: "person_commercial",
      reason: "countersigned sponsorship agreement",
    });
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("refuses to record a move the table forbids", () => {
    expect(() =>
      transitionPartner({ partnerId: "partner_1", from: "signed", to: "negotiation", at: AT, actorId: "person_commercial", reason: "reopened" }),
    ).toThrow(/signed.*negotiation|negotiation.*signed/s);
  });

  it("refuses to record a move out of a terminal stage", () => {
    expect(() =>
      transitionPartner({ partnerId: "partner_1", from: "lapsed", to: "active", at: AT, actorId: "person_commercial", reason: "won them back" }),
    ).toThrow();
  });

  it("requires an actor: every pipeline change is somebody's doing", () => {
    expect(() =>
      transitionPartner({ partnerId: "partner_1", from: "lead", to: "qualified", at: AT, actorId: " ", reason: "looks interested" }),
    ).toThrow(/actor/i);
  });

  it("refuses to record a move naming no partner", () => {
    expect(() =>
      transitionPartner({ partnerId: " ", from: "lead", to: "qualified", at: AT, actorId: "person_commercial" }),
    ).toThrow(/partnerId/i);
  });

  it("requires a valid instant", () => {
    expect(() =>
      transitionPartner({ partnerId: "partner_1", from: "lead", to: "qualified", at: new Date("never"), actorId: "person_commercial" }),
    ).toThrow(/at/i);
  });

  it("requires a reason on the move that closes a relationship", () => {
    // Signing and lapsing are the two decisions a partner is most likely to
    // dispute, and "we moved them to lapsed" with no reason is not an answer.
    expect(() =>
      transitionPartner({ partnerId: "partner_1", from: "negotiation", to: "signed", at: AT, actorId: "person_commercial", reason: "  " }),
    ).toThrow(/reason/i);
    expect(() =>
      transitionPartner({ partnerId: "partner_1", from: "active", to: "lapsed", at: AT, actorId: "person_commercial" }),
    ).toThrow(/reason/i);
  });

  it("allows an omitted reason on a routine internal move", () => {
    expect(() =>
      transitionPartner({ partnerId: "partner_1", from: "lead", to: "qualified", at: AT, actorId: "person_commercial" }),
    ).not.toThrow();
  });
});