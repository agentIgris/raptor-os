import { describe, expect, it } from "vitest";

import {
  TASK_PRIORITIES,
  TASK_STATES,
  TERMINAL_TASK_STATES,
  canTransition,
  comparePriority,
  createTask,
  isOverdue,
  isTerminal,
  overdueBy,
  transition,
} from "./index.js";
import type { CreateTaskInput, Task, TaskState } from "./index.js";

const OPEN_AT = new Date("2026-03-01T09:00:00.000Z");
const DUE = new Date("2026-03-10T17:00:00.000Z");

function input(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    taskId: "task_1",
    organizationId: "org_1",
    title: "Book the practice room",
    createdAt: OPEN_AT,
    priority: "normal",
    ...overrides,
  };
}

function aTask(overrides: Partial<CreateTaskInput> = {}): Task {
  return createTask(input(overrides));
}

describe("the task vocabulary", () => {
  it("names every state, terminal or not", () => {
    // A predicate over an undeclared vocabulary is not a state machine; the list
    // is what makes "which states exist" answerable by reading something.
    expect(TASK_STATES).toEqual(["open", "in_progress", "blocked", "in_review", "done", "cancelled"]);
  });

  it("names the terminal states as a subset of the whole", () => {
    for (const state of TERMINAL_TASK_STATES) {
      expect(TASK_STATES).toContain(state);
    }
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("in_review")).toBe(false);
  });
});

describe("the transition table", () => {
  it("refuses every self-transition, including on a live state", () => {
    // `open -> open` reads as a no-op and `done -> done` reads as a second
    // completion. Neither is a transition; permitting them is how a state column
    // starts lying about whether work happened.
    for (const state of TASK_STATES) {
      expect(canTransition(state, state), `${state} -> ${state}`).toBe(false);
    }
  });

  it("reaches `done` only through `in_review`", () => {
    // The design decision that makes a completion claim mean something: work is
    // reviewed before it is finished, so `done` is unreachable from `open` and
    // from `in_progress` alike. A board where a task can be born finished is a
    // board where "done" measures the click rather than the review.
    const reachable: TaskState[] = ["open", "in_progress", "blocked"];
    for (const state of reachable) {
      expect(canTransition(state, "done"), `${state} -> done`).toBe(false);
    }
    expect(canTransition("in_review", "done")).toBe(true);
  });

  it("has no outgoing edge from a terminal state", () => {
    for (const terminal of TERMINAL_TASK_STATES) {
      for (const state of TASK_STATES) {
        expect(canTransition(terminal, state), `${terminal} -> ${state}`).toBe(false);
      }
    }
  });

  it("only ever moves between declared states", () => {
    // Enumerated by hand rather than computed, so adding a state to TASK_STATES
    // without deciding its edges fails here instead of silently defaulting.
    const declared: Readonly<Record<TaskState, readonly TaskState[]>> = {
      open: ["in_progress", "blocked", "cancelled"],
      in_progress: ["blocked", "in_review", "cancelled"],
      blocked: ["in_progress", "cancelled"],
      in_review: ["in_progress", "done", "cancelled"],
      done: [],
      cancelled: [],
    };

    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(declared[from].includes(to));
      }
    }
  });
});

describe("creating a task", () => {
  it("freezes the result and starts it open with no dependencies", () => {
    const task = aTask();

    expect(Object.isFrozen(task)).toBe(true);
    expect(task.state).toBe("open");
    expect(task.dependsOnTaskIds).toEqual([]);
    expect(task.assigneeId).toBeNull();
    expect(task.dueAt).toBeNull();
  });

  it("refuses a blank task id, an unknown priority and a blank title", () => {
    // Each of these produces a row that is indistinguishable from a load failure
    // six months later, which is the whole reason they are refused at the door.
    expect(() => aTask({ taskId: "  " })).toThrow(/task id/i);
    expect(() => aTask({ organizationId: "" })).toThrow(/organization/i);
    expect(() => aTask({ title: "   " })).toThrow(/title/i);
    expect(() => aTask({ priority: "asap" as never })).toThrow(/priority/i);
  });

  it("refuses a due date at or before the moment the task was opened", () => {
    // A task due before it existed is a data-entry error, and it silently
    // reports as overdue from the second it is created.
    expect(() => aTask({ dueAt: OPEN_AT })).toThrow(/due/i);
    expect(() => aTask({ dueAt: new Date(OPEN_AT.getTime() - 1000) })).toThrow(/due/i);
  });

  it("refuses a due date it cannot read", () => {
    // An unreadable date is not "no deadline"; admitting it would store a task
    // that can never be due and never be overdue, which is a task nobody chases.
    expect(() => aTask({ dueAt: new Date(Number.NaN) })).toThrow(/dueAt/i);
  });

  it("refuses a creation instant it cannot read", () => {
    expect(() => aTask({ createdAt: new Date(Number.NaN) })).toThrow(/createdAt/i);
  });

  it("refuses a blank task id in the dependency list", () => {
    // A blank predecessor is not "no blocker"; it is a blocker whose id is
    // unreadable, and it would resolve to nothing at scheduling time.
    expect(() => aTask({ dependsOnTaskIds: ["  "] })).toThrow(/blank task id/i);
  });

  it("refuses a task that names a workflow origin incompletely", () => {
    // Both or neither. A run id with no step is half a provenance claim, and
    // completing it with a guess would attach a task to the wrong step of the
    // right run — which is worse than refusing.
    expect(() => aTask({ originRunId: "run_1" })).toThrow(/incompletely/i);
    expect(() => aTask({ originStepId: "quote" })).toThrow(/incompletely/i);
    // Both supplied is the legal shape.
    expect(aTask({ originRunId: "run_1", originStepId: "quote" }).originRunId).toBe("run_1");
  });

  it("refuses a task that depends on itself", () => {
    // Self-dependence is the degenerate cycle. It is refused here as well as in
    // the graph pass, because a task whose own existence blocks it is unreadable.
    expect(() => aTask({ dependsOnTaskIds: ["task_1"] })).toThrow(/depend/i);
  });

  it("deduplicates dependencies so one blocked predecessor is not two", () => {
    const task = aTask({ dependsOnTaskIds: ["task_0", "task_0", "task_2"] });
    expect(task.dependsOnTaskIds).toEqual(["task_0", "task_2"]);
  });

  it("orders dependencies deterministically, whatever order they arrived in", () => {
    // Two callers writing the same dependency set must produce the same task, or
    // a board's rendered order becomes an artefact of a query plan.
    const forwards = aTask({ dependsOnTaskIds: ["t_a", "t_b", "t_c"] });
    const backwards = aTask({ dependsOnTaskIds: ["t_c", "t_b", "t_a"] });

    expect(forwards.dependsOnTaskIds).toEqual(["t_a", "t_b", "t_c"]);
    expect(backwards.dependsOnTaskIds).toEqual(forwards.dependsOnTaskIds);
  });

  it("copies the dependency list rather than holding the caller's array", () => {
    // The same reasoning as `canonicalizeContractVersion`: a version that can be
    // changed through an array the caller still holds is not immutable.
    const dependencies = ["task_0"];
    const task = aTask({ dependsOnTaskIds: dependencies });
    dependencies.push("task_9");

    expect(task.dependsOnTaskIds).toEqual(["task_0"]);
  });
});

describe("transitioning a task", () => {
  const base = aTask({ assigneeId: "person_1" });

  it("returns the destination state and names who moved it and when", () => {
    const next = transition({
      task: base,
      to: "in_progress",
      actorId: "person_1",
      at: OPEN_AT,
    });

    expect(next.state).toBe("in_progress");
    expect(next.transitionedAt).toEqual(OPEN_AT);
    expect(next.stateChangedBy).toBe("person_1");
    // The prior task is untouched: a transition produces a new value.
    expect(base.state).toBe("open");
    expect(base.transitionedAt).toBeNull();
  });

  it("refuses an edge the table does not contain, and names the edges it does", () => {
    expect(() =>
      transition({ task: base, to: "done", actorId: "person_1", at: OPEN_AT }),
    ).toThrow(/open -> done.*review/is);
  });

  it("refuses a transition from a terminal state and says the state is terminal", () => {
    const done = transition({ task: base, to: "in_progress", actorId: "p", at: OPEN_AT });
    const finished = transition({ task: done, to: "in_review", actorId: "p", at: OPEN_AT });
    const complete = transition({ task: finished, to: "done", actorId: "p", at: OPEN_AT });

    expect(() => transition({ task: complete, to: "in_progress", actorId: "p", at: OPEN_AT })).toThrow(
      /terminal/i,
    );
  });

  it("refuses a reason attached to a transition that does not record one", () => {
    // A reason beside an ordinary transition is not redundant — it is a claim
    // about WHY stored next to a state that does not record causation, and a
    // reader would take it as authoritative. Silently dropping it would be worse
    // than refusing.
    expect(() =>
      transition({ task: base, to: "in_progress", actorId: "person_1", at: OPEN_AT, reason: "because" }),
    ).toThrow(/only blocked and cancelled/i);
  });

  it("ignores an EMPTY reason on a transition that does not record one", () => {
    // Whitespace is not a reason, so there is nothing to reject and nothing to
    // store. This is the one case where supplying the key is harmless.
    const started = transition({ task: base, to: "in_progress", actorId: "person_1", at: OPEN_AT, reason: "   " });
    expect(started.stateReason).toBeNull();
  });

  it("refuses to start unassigned work", () => {
    // "In progress" with nobody's name on it is how a task list fills with work
    // that is nobody's. The assignee is therefore a precondition, not a note.
    const unassigned = aTask();
    expect(() => transition({ task: unassigned, to: "in_progress", actorId: "person_1", at: OPEN_AT })).toThrow(
      /assignee/i,
    );
  });

  it("refuses to block or cancel without a stated reason", () => {
    // Both are decisions a person will later be asked to justify, so both carry a
    // reason. An all-whitespace reason is not a reason.
    for (const to of ["blocked", "cancelled"] as const) {
      expect(() => transition({ task: base, to, actorId: "person_1", at: OPEN_AT })).toThrow(/reason/i);
      expect(() => transition({ task: base, to, actorId: "person_1", at: OPEN_AT, reason: "   " })).toThrow(
        /reason/i,
      );
    }
  });

  it("accepts a stated reason and carries it onto the result", () => {
    const blocked = transition({
      task: base,
      to: "blocked",
      actorId: "person_1",
      at: OPEN_AT,
      reason: "the room is double-booked",
    });

    expect(blocked.state).toBe("blocked");
    expect(blocked.stateReason).toBe("the room is double-booked");
  });

  it("refuses a blank actor, a missing instant and a backwards transition clock", () => {
    const started = transition({ task: base, to: "in_progress", actorId: "person_1", at: OPEN_AT });

    expect(() => transition({ task: started, to: "in_review", actorId: " ", at: OPEN_AT })).toThrow(/actor/i);
    expect(() =>
      transition({ task: started, to: "in_review", actorId: "person_1", at: new Date(Number.NaN) }),
    ).toThrow(/at/i);
    // Moving a task backwards in time is a corrupted record, not a historical fact.
    expect(() =>
      transition({
        task: started,
        to: "in_review",
        actorId: "person_1",
        at: new Date(OPEN_AT.getTime() - 60_000),
      }),
    ).toThrow(/earlier than/i);
  });
});

describe("due dates", () => {
  it("is not overdue before the deadline and is overdue at it", () => {
    // `at >= dueAt`, not `at > dueAt`: a deadline is the first instant the work
    // is late, and using strict comparison buys everybody one extra second.
    const task = aTask({ dueAt: DUE });

    expect(isOverdue(task, new Date(DUE.getTime() - 1000))).toBe(false);
    expect(isOverdue(task, DUE)).toBe(true);
    expect(overdueBy(task, DUE)).toBe(0n);
  });

  it("reports lateness in milliseconds, which is the only exact unit available", () => {
    // Durations are bigint milliseconds because there is no integer unit of
    // "overdue" that every reader would agree on, and a float would drift.
    const task = aTask({ dueAt: DUE });
    expect(overdueBy(task, new Date(DUE.getTime() + 90_000))).toBe(90_000n);
  });

  it("is never overdue with no deadline, and never overdue once terminal", () => {
    // A cancelled task that missed its date did not "miss" anything — the work
    // was called off, and reporting it as late is a false alarm on a board.
    const withDue = aTask({ dueAt: DUE, assigneeId: "person_1" });
    expect(isOverdue(aTask(), new Date(DUE.getTime() + 1_000_000))).toBe(false);
    expect(isOverdue(withDue, DUE)).toBe(true);

    const started = transition({ task: withDue, to: "in_progress", actorId: "p", at: OPEN_AT });
    const cancelled = transition({
      task: started,
      to: "cancelled",
      actorId: "p",
      at: OPEN_AT,
      reason: "event moved",
    });

    expect(isOverdue(cancelled, new Date(DUE.getTime() + 1_000_000))).toBe(false);
    expect(overdueBy(cancelled, new Date(DUE.getTime() + 1_000_000))).toBeNull();
  });
});

describe("priority", () => {
  it("orders urgent above high above normal above low", () => {
    expect(comparePriority("urgent", "high")).toBe(1);
    expect(comparePriority("high", "normal")).toBe(1);
    expect(comparePriority("normal", "low")).toBe(1);
    expect(comparePriority("low", "urgent")).toBe(-1);
    expect(comparePriority("high", "high")).toBe(0);
  });

  it("names the whole vocabulary so a board filter cannot invent a bucket", () => {
    expect(TASK_PRIORITIES).toEqual(["low", "normal", "high", "urgent"]);
  });
});
