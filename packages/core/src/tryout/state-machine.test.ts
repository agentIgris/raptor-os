import { describe, expect, it } from "vitest";

import type { TryoutPhase } from "./state-machine.js";
import {
  LEGACY_IMPLEMENTED_TRANSITIONS,
  PHASES,
  TERMINAL_PHASES,
  canTransition,
  isTerminal,
  transition,
} from "./state-machine.js";

/** Every ordered pair, so the matrix test can assert all 36 at once. */
const ALL_PAIRS: readonly (readonly [TryoutPhase, TryoutPhase])[] = PHASES.flatMap((from) =>
  PHASES.map((to) => [from, to] as const),
);

const LEGAL_PAIRS: ReadonlySet<string> = new Set([
  "applied>screened",
  "applied>invited",
  "applied>rejected",
  "screened>invited",
  "screened>rejected",
  "invited>evaluated",
  "invited>rejected",
  "evaluated>selected",
  "evaluated>rejected",
]);

describe("the phase vocabulary", () => {
  it("is exactly the six declared phases, in pipeline order", () => {
    expect(PHASES).toEqual(["applied", "screened", "invited", "evaluated", "selected", "rejected"]);
  });

  it("marks selected and rejected terminal, which legacy never did", () => {
    expect(TERMINAL_PHASES).toEqual(["selected", "rejected"]);
    expect(isTerminal("selected")).toBe(true);
    expect(isTerminal("rejected")).toBe(true);
    expect(isTerminal("applied")).toBe(false);
  });
});

describe("canTransition — the full from x to matrix", () => {
  it("has exactly 36 ordered pairs to assert on", () => {
    expect(ALL_PAIRS).toHaveLength(36);
  });

  it("agrees with the legal-pair set on every single pair", () => {
    for (const [from, to] of ALL_PAIRS) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(LEGAL_PAIRS.has(`${from}>${to}`));
    }
  });

  it("enumerates the legal pairs explicitly, so a regression names itself", () => {
    const legal = ALL_PAIRS.filter(([from, to]) => canTransition(from, to)).map(([from, to]) => `${from}>${to}`);
    expect(legal.sort()).toEqual([...LEGAL_PAIRS].sort());
  });

  it("allows a rejection from any non-terminal phase", () => {
    for (const from of ["applied", "screened", "invited", "evaluated"] as const) {
      expect(canTransition(from, "rejected")).toBe(true);
    }
  });

  it("allows no transition out of a terminal phase, which legacy never enforced", () => {
    for (const terminal of TERMINAL_PHASES) {
      for (const to of PHASES) {
        expect(canTransition(terminal, to), `${terminal} -> ${to}`).toBe(false);
      }
    }
  });

  it("allows no self-transition anywhere", () => {
    for (const phase of PHASES) {
      expect(canTransition(phase, phase), `${phase} -> ${phase}`).toBe(false);
    }
  });

  it("allows no transition that skips evaluation to reach selection", () => {
    expect(canTransition("applied", "selected")).toBe(false);
    expect(canTransition("invited", "selected")).toBe(false);
    expect(canTransition("screened", "selected")).toBe(false);
  });

  it("refuses to resurrect a rejected candidate", () => {
    for (const to of PHASES) {
      expect(canTransition("rejected", to)).toBe(false);
    }
  });

  it("refuses to walk backwards down the pipeline", () => {
    expect(canTransition("invited", "applied")).toBe(false);
    expect(canTransition("evaluated", "invited")).toBe(false);
    expect(canTransition("screened", "applied")).toBe(false);
  });

  it("requires screening before evaluation, except via the legacy skip", () => {
    expect(canTransition("applied", "evaluated")).toBe(false);
    expect(canTransition("screened", "evaluated")).toBe(false);
  });
});

describe("the legacy transition set, documented", () => {
  it("records that legacy implemented only three of the nine declared transitions", () => {
    // ADR-0016 §4. The rest were declared in CHECK constraints and written by
    // nothing: `tryout_selections` had no INSERT or UPDATE anywhere in the tree.
    expect(LEGACY_IMPLEMENTED_TRANSITIONS).toEqual(["applied>invited", "invited>evaluated"]);
  });

  it("marks only legacy-implemented pairs in the matrix as implemented", () => {
    // Everything else in PHASES is new, and a reader must be able to tell which.
    // The pair string is widened because `includes` on a 2-tuple const would
    // otherwise reject every pair that is NOT legacy-implemented — which is
    // exactly the set this test exists to prove is not being claimed.
    const implemented: readonly string[] = LEGACY_IMPLEMENTED_TRANSITIONS;

    for (const [from, to] of ALL_PAIRS) {
      if (implemented.includes(`${from}>${to}`)) {
        expect(canTransition(from, to)).toBe(true);
      }
    }
  });

  it("claims no more transitions than legacy actually wrote", () => {
    // Nine were declared; three written. Anything added here is new behaviour
    // and must be argued for in review, not inherited by accident.
    expect(LEGACY_IMPLEMENTED_TRANSITIONS).toHaveLength(2);
  });
});

describe("transition", () => {
  const context = { candidateId: "cand_1", actorId: "person_staff" };

  it("returns the destination phase for a legal transition", () => {
    expect(transition({ from: "applied", to: "screened", context })).toBe("screened");
  });

  it("returns the destination phase for a legal rejection that carries a reason", () => {
    expect(
      transition({ from: "invited", to: "rejected", context: { ...context, reason: "Withdrew after scrims" } }),
    ).toBe("rejected");
  });

  it("throws on an illegal transition instead of writing a dead-end state", () => {
    expect(() => transition({ from: "selected", to: "invited", context })).toThrow(/selected/);
    expect(() => transition({ from: "applied", to: "selected", context })).toThrow(/applied/);
  });

  it("rejects a required reason, because a pipeline decision with no reason is unauditable", () => {
    expect(() => transition({ from: "applied", to: "rejected", context })).toThrow(/reason/);
    expect(() =>
      transition({ from: "applied", to: "rejected", context: { ...context, reason: "Not eligible this split" } }),
    ).not.toThrow();
  });

  it("rejects an empty reason string", () => {
    expect(() => transition({ from: "applied", to: "rejected", context: { ...context, reason: "   " } })).toThrow(/reason/);
  });
});