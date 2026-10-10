import { describe, expect, it } from "vitest";

import type { ContentState } from "./lifecycle.js";
import {
  IRREVERSIBLE_CONTENT_TRANSITIONS,
  CONTENT_STATES,
  CONTENT_TRANSITIONS,
  assertCanTransition,
  canTransition,
  isIrreversibleTransition,
  isTerminalState,
  nextStates,
  transitionContent,
} from "./lifecycle.js";

describe("the transition table", () => {
  it("names every state exactly once", () => {
    expect(Object.keys(CONTENT_TRANSITIONS).sort()).toEqual([...CONTENT_STATES].sort());
  });

  it("only ever points at states that exist", () => {
    for (const targets of Object.values(CONTENT_TRANSITIONS)) {
      for (const target of targets) {
        expect(CONTENT_STATES).toContain(target);
      }
    }
  });

  it("never lists a state as transitioning to itself", () => {
    for (const [from, targets] of Object.entries(CONTENT_TRANSITIONS)) {
      expect(targets).not.toContain(from as ContentState);
    }
  });

  it("declares the six states the pipeline is made of, in editorial order", () => {
    expect(CONTENT_STATES).toEqual(["draft", "review", "approved", "scheduled", "published", "archived"]);
  });
});

describe("canTransition across the full matrix", () => {
  const pairs = CONTENT_STATES.flatMap((from) => CONTENT_STATES.map((to) => ({ from, to })));

  it("covers every ordered pair of states", () => {
    expect(pairs).toHaveLength(CONTENT_STATES.length * CONTENT_STATES.length);
  });

  it.each(pairs)("$from -> $to is $expected", ({ from, to }) => {
    const declared = CONTENT_TRANSITIONS[from].includes(to);
    expect(canTransition(from, to)).toBe(declared);
  });

  it("refuses every transition out of a terminal state", () => {
    for (const state of CONTENT_STATES.filter(isTerminalState)) {
      for (const target of CONTENT_STATES) {
        expect(canTransition(state, target)).toBe(false);
      }
    }
  });

  it("rejects an unknown state rather than defaulting it to allowed", () => {
    expect(() => canTransition("cancelled" as ContentState, "draft")).toThrow(/unknown/i);
    expect(() => canTransition("draft", "cancelled" as ContentState)).toThrow(/unknown/i);
  });
});

describe("the editorial pipeline", () => {
  it("will not let a draft skip review and go straight to approved", () => {
    // Review is the control. A draft that could jump to `approved` would make the
    // reviewer optional, and an optional reviewer is the same as no reviewer.
    expect(canTransition("draft", "approved")).toBe(false);
    expect(canTransition("draft", "scheduled")).toBe(false);
    expect(canTransition("draft", "published")).toBe(false);
  });

  it("will not let review skip approval and go straight to scheduled", () => {
    expect(canTransition("review", "scheduled")).toBe(false);
    expect(canTransition("review", "published")).toBe(false);
  });

  it("will not let approved skip the schedule and publish immediately", () => {
    // Publishing on demand is how a draft that nobody approved ends up in front
    // of an audience. Publication is a *scheduled* act, with a named instant.
    expect(canTransition("approved", "published")).toBe(false);
  });

  it("will not let a scheduled item move backwards to review", () => {
    // Unscheduling returns to `approved`, which is a different and honest thing:
    // the work was reviewed and stays reviewed.
    expect(canTransition("scheduled", "approved")).toBe(true);
    expect(canTransition("scheduled", "review")).toBe(false);
    expect(canTransition("scheduled", "draft")).toBe(false);
  });

  it("lets a reviewer return work to draft, and the author start again", () => {
    expect(canTransition("review", "draft")).toBe(true);
    expect(canTransition("draft", "review")).toBe(true);
  });

  it("has nowhere to go from archived", () => {
    expect(isTerminalState("archived")).toBe(true);
    expect(nextStates("archived")).toEqual([]);
  });
});

describe("irreversibility", () => {
  it("derives the irreversible set from the table and it matches the pinned list", () => {
    // Pinned explicitly so a change to the table cannot quietly widen the set of
    // things that can never be undone. Publishing is a one-way door and archiving
    // is the end; widening either has to be an argument somebody makes.
    expect([...IRREVERSIBLE_CONTENT_TRANSITIONS].sort()).toEqual(
      [
        "draft->archived",
        "published->archived",
        "scheduled->published",
      ].sort(),
    );
  });

  it("marks publication as irreversible: content cannot be un-published", () => {
    // The audience has seen it. There is no transition back and there should not
    // be one — a retraction is a new statement, not an un-publication.
    expect(isIrreversibleTransition("scheduled", "published")).toBe(true);
    expect(canTransition("published", "scheduled")).toBe(false);
  });

  it("marks archiving as irreversible from either end", () => {
    expect(isIrreversibleTransition("published", "archived")).toBe(true);
    expect(isIrreversibleTransition("draft", "archived")).toBe(true);
    expect(canTransition("archived", "draft")).toBe(false);
  });

  it("keeps the review loop reversible, because returning work for edits is not an event", () => {
    expect(isIrreversibleTransition("review", "draft")).toBe(false);
    expect(isIrreversibleTransition("draft", "review")).toBe(false);
  });

  it("keeps unscheduling reversible, because an approved item stays approved", () => {
    expect(isIrreversibleTransition("scheduled", "approved")).toBe(false);
    expect(canTransition("approved", "scheduled")).toBe(true);
  });

  it("never marks a terminal state as a transition at all", () => {
    for (const from of CONTENT_STATES.filter(isTerminalState)) {
      for (const to of CONTENT_STATES) {
        expect(isIrreversibleTransition(from, to)).toBe(false);
      }
    }
  });

  it("returns false for an edge the table does not declare", () => {
    expect(isIrreversibleTransition("draft", "approved")).toBe(false);
  });
});

describe("nextStates", () => {
  it("returns the declared successors of a state", () => {
    expect(nextStates("review")).toEqual(["approved", "draft"]);
  });

  it("returns a frozen list", () => {
    expect(Object.isFrozen(nextStates("review"))).toBe(true);
  });

  it("rejects an unknown state", () => {
    expect(() => nextStates("cancelled" as ContentState)).toThrow(/unknown/i);
  });
});

describe("assertCanTransition", () => {
  it("passes for a declared transition", () => {
    expect(() => assertCanTransition("draft", "review")).not.toThrow();
  });

  it("names the permitted moves when it refuses one", () => {
    expect(() => assertCanTransition("review", "scheduled")).toThrow(/approved|draft/);
  });
});

describe("transitionContent", () => {
  const AT = new Date("2026-04-01T09:00:00.000Z");

  it("returns a frozen record of the move rather than mutating anything", () => {
    const record = transitionContent({
      contentId: "content_1",
      from: "draft",
      to: "review",
      at: AT,
      actorId: "person_editor",
      reason: "ready for review",
    });

    expect(record).toEqual({
      contentId: "content_1",
      from: "draft",
      to: "review",
      at: AT,
      actorId: "person_editor",
      reason: "ready for review",
    });
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("refuses to record a transition the table forbids", () => {
    expect(() =>
      transitionContent({
        contentId: "content_1",
        from: "draft",
        to: "approved",
        at: AT,
        actorId: "person_editor",
        reason: "skipping review",
      }),
    ).toThrow(/draft.*approved|approved.*draft/s);
  });

  it("requires an actor", () => {
    expect(() =>
      transitionContent({ contentId: "content_1", from: "draft", to: "review", at: AT, actorId: " " }),
    ).toThrow(/actor/i);
  });

  it("requires a valid instant", () => {
    expect(() =>
      transitionContent({ contentId: "content_1", from: "draft", to: "review", at: new Date("never"), actorId: "person_editor" }),
    ).toThrow(/at/i);
  });

  it("requires a stated reason on the two moves a creator is most likely to dispute", () => {
    // Returning somebody's work, and archiving what they wrote, are the two
    // decisions a creator disputes.
    expect(() =>
      transitionContent({ contentId: "content_1", from: "review", to: "draft", at: AT, actorId: "person_editor" }),
    ).toThrow(/reason/i);
    expect(() =>
      transitionContent({ contentId: "content_1", from: "published", to: "archived", at: AT, actorId: "person_editor" }),
    ).toThrow(/reason/i);
  });

  it("allows an omitted reason on a routine move", () => {
    expect(() =>
      transitionContent({ contentId: "content_1", from: "draft", to: "review", at: AT, actorId: "person_editor" }),
    ).not.toThrow();
  });

  it("refuses to record a move naming no content", () => {
    expect(() =>
      transitionContent({ contentId: " ", from: "draft", to: "review", at: AT, actorId: "person_editor" }),
    ).toThrow(/contentId/i);
  });
});