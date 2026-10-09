import { describe, expect, it } from "vitest";

import { TERMINAL_PHASES, canTransition, skipsScreening, transition } from "./state-machine.js";

const base = { candidateId: "cand_1", actorId: "person_manager" };

describe("the applied -> invited screening skip", () => {
  it("is legal, because the legacy route performed it", () => {
    expect(canTransition("applied", "invited")).toBe(true);
    expect(transition({ from: "applied", to: "invited", context: base })).toBe("invited");
  });

  it("is marked as skipping screening, so no screen is claimed", () => {
    // Legacy force-wrote status='screened' while screening nobody. Here the skip
    // is data, not a lie in a column.
    expect(skipsScreening("applied", "invited")).toBe(true);
  });

  it("does not mark the properly screened path as a skip", () => {
    expect(skipsScreening("applied", "screened")).toBe(false);
    expect(skipsScreening("screened", "invited")).toBe(false);
  });

  it("marks no other transition as a screening skip", () => {
    expect(skipsScreening("applied", "rejected")).toBe(false);
    expect(skipsScreening("evaluated", "selected")).toBe(false);
    expect(skipsScreening("invited", "evaluated")).toBe(false);
  });
});

describe("separation of duties on selection", () => {
  const selecting = { evaluatedBy: "person_scout", actorId: "person_manager", candidateId: "cand_1" };

  it("allows a different person to select a candidate they did not evaluate", () => {
    expect(transition({ from: "evaluated", to: "selected", context: selecting })).toBe("selected");
  });

  it("refuses to let an evaluator select the candidate they evaluated", () => {
    const self = { evaluatedBy: "person_scout", actorId: "person_scout", candidateId: "cand_1" };
    expect(() => transition({ from: "evaluated", to: "selected", context: self })).toThrow(/Separation of duties/);
  });

  it("names both the actor and the candidate in the violation, so the log is useful", () => {
    const self = { evaluatedBy: "person_scout", actorId: "person_scout", candidateId: "cand_9" };
    expect(() => transition({ from: "evaluated", to: "selected", context: self })).toThrow(/person_scout/);
    expect(() => transition({ from: "evaluated", to: "selected", context: self })).toThrow(/cand_9/);
  });

  it("refuses selection when no evaluator was recorded, rather than assuming one", () => {
    expect(() => transition({ from: "evaluated", to: "selected", context: base })).toThrow(/evaluatedBy/);
  });

  it("does NOT apply the separation check to rejection", () => {
    // An evaluator rejecting their own candidate is a judgement call, not a
    // conflict of interest: the bias risk is in the decision to hire.
    expect(
      transition({
        from: "evaluated",
        to: "rejected",
        context: { ...base, evaluatedBy: base.actorId, reason: "Not strong enough" },
      }),
    ).toBe("rejected");
  });
});

describe("terminal states", () => {
  it("refuses every outgoing transition from a terminal phase", () => {
    for (const terminal of TERMINAL_PHASES) {
      expect(() => transition({ from: terminal, to: "invited", context: base })).toThrow(/terminal/);
    }
  });

  it("says plainly that the phase is terminal, rather than listing an empty set", () => {
    expect(() => transition({ from: "selected", to: "evaluated", context: base })).toThrow(/terminal phase/);
  });

  it("refuses to reject an already-selected candidate, which would erase the outcome", () => {
    expect(() => transition({ from: "selected", to: "rejected", context: { ...base, reason: "x" } })).toThrow(
      /terminal/,
    );
  });

  it("refuses to select an already-rejected candidate", () => {
    expect(() =>
      transition({ from: "rejected", to: "selected", context: { ...base, evaluatedBy: "person_scout" } }),
    ).toThrow(/terminal/);
  });

  it("lists the allowed destinations for a non-terminal phase, to make the fix obvious", () => {
    expect(() => transition({ from: "invited", to: "applied", context: base })).toThrow(/Allowed from invited/);
  });
});

describe("context validation", () => {
  it("requires a candidate id", () => {
    expect(() => transition({ from: "applied", to: "screened", context: { ...base, candidateId: "" } })).toThrow(
      /candidateId/,
    );
  });

  it("requires an actor id, so a transition is never anonymous", () => {
    expect(() => transition({ from: "applied", to: "screened", context: { ...base, actorId: "  " } })).toThrow(
      /actorId/,
    );
  });

  it("checks the context before the transition, so a missing context is not misreported as an illegal edge", () => {
    expect(() =>
      transition({ from: "applied", to: "screened", context: { candidateId: "", actorId: "" } }),
    ).toThrow(/candidateId/);
  });

  it("rejects a missing context object outright", () => {
    expect(() =>
      transition({ from: "applied", to: "screened", context: undefined as unknown as { candidateId: string; actorId: string } }),
    ).toThrow(/Invalid context/);
  });
});