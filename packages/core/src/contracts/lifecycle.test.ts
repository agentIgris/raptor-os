import { describe, expect, it } from "vitest";

import type { ContractState } from "./lifecycle.js";
import {
  CONTRACT_STATES,
  CONTRACT_TRANSITIONS,
  IRREVERSIBLE_TRANSITIONS,
  assertCanTransition,
  canTransition,
  isIrreversibleTransition,
  isTerminalState,
  nextStates,
  transitionContract,
} from "./lifecycle.js";

const AT = new Date("2026-02-01T00:00:00.000Z");

describe("the transition table", () => {
  it("names every state exactly once", () => {
    expect(Object.keys(CONTRACT_TRANSITIONS).sort()).toEqual([...CONTRACT_STATES].sort());
  });

  it("only ever points at states that exist", () => {
    for (const targets of Object.values(CONTRACT_TRANSITIONS)) {
      for (const target of targets) {
        expect(CONTRACT_STATES).toContain(target);
      }
    }
  });

  it("never lists a state as transitioning to itself", () => {
    // A self-transition would mean "do nothing, but record that you did
    // nothing" — which is how duplicate lifecycle rows get written.
    for (const [from, targets] of Object.entries(CONTRACT_TRANSITIONS)) {
      expect(targets).not.toContain(from as ContractState);
    }
  });
});

describe("canTransition across the full matrix", () => {
  // Every (from, to) pair, so a state added later without a row fails here
  // rather than quietly defaulting to "allowed".
  const pairs = CONTRACT_STATES.flatMap((from) => CONTRACT_STATES.map((to) => ({ from, to })));

  it("covers every ordered pair of states", () => {
    expect(pairs).toHaveLength(CONTRACT_STATES.length * CONTRACT_STATES.length);
  });

  it.each(pairs)("$from -> $to is $expected", ({ from, to }) => {
    // The table is the single source of truth. The test re-derives the
    // expectation from it rather than hard-coding 49 booleans, so the matrix
    // cannot drift from the thing it claims to check — and the explicit `it.each`
    // over every ordered pair is what makes "every pair is exercised" true.
    const declared = CONTRACT_TRANSITIONS[from].includes(to);
    expect(canTransition(from, to)).toBe(declared);
  });

  it("refuses every transition out of a terminal state", () => {
    for (const state of CONTRACT_STATES.filter(isTerminalState)) {
      for (const target of CONTRACT_STATES) {
        expect(canTransition(state, target)).toBe(false);
      }
    }
  });

  it("rejects an unknown state rather than defaulting it to allowed", () => {
    expect(() => canTransition("archived" as ContractState, "draft")).toThrow(/unknown/i);
    expect(() => canTransition("draft", "archived" as ContractState)).toThrow(/unknown/i);
  });
});

describe("irreversibility", () => {
  it("derives the irreversible set from the table and it matches the pinned list", () => {
    // Pinned explicitly so a change to the table cannot quietly widen the set of
    // things that can never be undone. If someone adds an edge back out of
    // `terminated`, this assertion is what makes them argue for it.
    expect([...IRREVERSIBLE_TRANSITIONS].sort()).toEqual(
      [
        "active->expired",
        "active->superseded",
        "active->terminated",
        "draft->withdrawn",
        "pending_acceptance->active",
        "pending_acceptance->withdrawn",
      ].sort(),
    );
  });

  it("marks an acceptance as irreversible: it cannot be un-accepted, only terminated", () => {
    expect(isIrreversibleTransition("pending_acceptance", "active")).toBe(true);
    expect(canTransition("active", "pending_acceptance")).toBe(false);
  });

  it("marks termination, expiry and supersession as irreversible", () => {
    expect(isIrreversibleTransition("active", "terminated")).toBe(true);
    expect(isIrreversibleTransition("active", "expired")).toBe(true);
    expect(isIrreversibleTransition("active", "superseded")).toBe(true);
  });

  it("keeps the drafting loop reversible, because rework is not a legal event", () => {
    // `pending_acceptance -> draft` is returned-for-rework: the other direction
    // exists, so this one is reversible. Modelling it as irreversible would mean
    // every typo in a draft cost a brand-new contract.
    expect(isIrreversibleTransition("pending_acceptance", "draft")).toBe(false);
    expect(canTransition("draft", "pending_acceptance")).toBe(true);
  });

  it("never marks a terminal state as a transition at all", () => {
    for (const from of CONTRACT_STATES.filter(isTerminalState)) {
      for (const to of CONTRACT_STATES) {
        expect(isIrreversibleTransition(from, to)).toBe(false);
      }
    }
  });
});

describe("nextStates", () => {
  it("returns the declared successors of a state", () => {
    expect(nextStates("draft")).toEqual(["pending_acceptance", "withdrawn"]);
  });

  it("returns an empty list for a terminal state", () => {
    expect(nextStates("expired")).toEqual([]);
  });

  it("returns a frozen list", () => {
    expect(Object.isFrozen(nextStates("draft"))).toBe(true);
  });

  it("rejects an unknown state", () => {
    expect(() => nextStates("archived" as ContractState)).toThrow(/unknown/i);
  });
});

describe("assertCanTransition", () => {
  it("passes for a declared transition", () => {
    expect(() => assertCanTransition("draft", "pending_acceptance")).not.toThrow();
  });

  it("throws naming both states for an undeclared one", () => {
    expect(() => assertCanTransition("draft", "active")).toThrow(/draft.*active|active.*draft/s);
  });
});

describe("transitionContract", () => {
  it("returns an immutable record of the move rather than mutating anything", () => {
    const record = transitionContract({
      from: "draft",
      to: "pending_acceptance",
      at: AT,
      actorId: "person_1",
      reason: "sent_for_signature",
    });

    expect(record).toEqual({
      from: "draft",
      to: "pending_acceptance",
      at: AT,
      actorId: "person_1",
      reason: "sent_for_signature",
    });
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("refuses to record a transition the table forbids", () => {
    expect(() =>
      transitionContract({ from: "draft", to: "active", at: AT, actorId: "person_1", reason: "skipped_signature" }),
    ).toThrow(/draft.*active|active.*draft/s);
  });

  it("refuses to record a transition out of a terminal state", () => {
    expect(() =>
      transitionContract({ from: "terminated", to: "active", at: AT, actorId: "person_1", reason: "restarted" }),
    ).toThrow();
  });

  it("allows an omitted reason, for transitions that need none", () => {
    expect(() =>
      transitionContract({ from: "active", to: "expired", at: AT, actorId: "system" }),
    ).not.toThrow();
  });

  it("requires an actor: every lifecycle change is somebody's doing", () => {
    expect(() =>
      transitionContract({ from: "draft", to: "pending_acceptance", at: AT, actorId: " ", reason: "sent_for_signature" }),
    ).toThrow(/actor/i);
  });

  it("requires a valid instant", () => {
    expect(() =>
      transitionContract({
        from: "draft",
        to: "pending_acceptance",
        at: new Date("not-a-date"),
        actorId: "person_1",
        reason: "sent_for_signature",
      }),
    ).toThrow(/at/i);
  });
});

describe("isTerminalState", () => {
  it.each(["expired", "terminated", "withdrawn", "superseded"] as const)("%s is terminal", (state) => {
    expect(isTerminalState(state)).toBe(true);
  });

  it.each(["draft", "pending_acceptance", "active"] as const)("%s is not terminal", (state) => {
    expect(isTerminalState(state)).toBe(false);
  });

  it("rejects an unknown state", () => {
    expect(() => isTerminalState("archived" as ContractState)).toThrow(/unknown/i);
  });
});