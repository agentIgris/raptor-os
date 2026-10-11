import { describe, expect, it } from "vitest";

import {
  advanceRun,
  assertRunMatchesTasks,
  canResume,
  createWorkflowDefinition,
  createWorkflowRun,
  isStepComplete,
  nextStep,
  recordStepStarted,
  recordStepCompleted,
  replayStep,
  resumeWorkflowRun,
  stepOutcomeFor,
  workflowRunProgress,
} from "./index.js";
import type { Task } from "../tasks/index.js";
import type {
  CompleteStepInput,
  CreateWorkflowRunInput,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
} from "./index.js";

const ORG = "org_1";
const AT = new Date("2026-04-01T09:00:00.000Z");
const LATER = new Date("2026-04-01T10:00:00.000Z");
const DEFINED_AT = new Date("2026-03-20T08:00:00.000Z");

const STEPS: readonly WorkflowStep[] = [
  { stepId: "quote", title: "Quote the trip", idempotencyScope: "quote" },
  { stepId: "approve", title: "Manager approval", idempotencyScope: "approve" },
  { stepId: "book", title: "Book the flights", idempotencyScope: "book" },
];

const DEFINITION: WorkflowDefinition = createWorkflowDefinition({
  definitionId: "wf_travel",
  organizationId: ORG,
  name: "Player travel request",
  steps: STEPS,
  createdAt: DEFINED_AT,
});

function runInput(overrides: Partial<CreateWorkflowRunInput> = {}): CreateWorkflowRunInput {
  return {
    runId: "run_1",
    organizationId: ORG,
    definition: DEFINITION,
    startedAt: AT,
    subjectId: "trip_1",
    ...overrides,
  };
}

/** A run whose first step has been started. The common starting point. */
function startedRun(): WorkflowRun {
  const run = createWorkflowRun(runInput());
  return recordStepStarted({ run, stepId: "quote", at: AT });
}

/** A run whose first step has been started AND completed. */
function advancedRun(): WorkflowRun {
  return recordStepCompleted({ run: startedRun(), stepId: "quote", at: AT });
}

function aTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: "task_1",
    organizationId: ORG,
    title: "Book the flights",
    description: null,
    state: "open",
    priority: "normal",
    assigneeId: null,
    dueAt: null,
    createdAt: AT,
    transitionedAt: null,
    stateChangedBy: null,
    stateReason: null,
    dependsOnTaskIds: [],
    originRunId: "run_1",
    originStepId: "quote",
    ...overrides,
  };
}

describe("a workflow definition", () => {
  it("keeps the steps in the order they were declared", () => {
    // Step order IS the workflow. Sorting them by id would turn "quote, approve,
    // book" into "approve, book, quote" and quietly approve before quoting.
    expect(DEFINITION.steps.map((s) => s.stepId)).toEqual(["quote", "approve", "book"]);
  });

  it("freezes the definition and its step list", () => {
    expect(Object.isFrozen(DEFINITION)).toBe(true);
    expect(Object.isFrozen(DEFINITION.steps)).toBe(true);
    expect(Object.isFrozen(DEFINITION.steps[0])).toBe(true);
  });

  it("refuses an empty step list", () => {
    // A workflow with no steps is not a workflow that finished instantly; it is
    // a definition that was never written, and admitting it produces a run that
    // reports "complete" having done nothing.
    expect(() =>
      createWorkflowDefinition({ definitionId: "wf_x", organizationId: ORG, name: "Empty", steps: [], createdAt: DEFINED_AT }),
    ).toThrow(/steps/i);
  });

  it("refuses duplicate step ids, because two steps of one name are one step", () => {
    expect(() =>
      createWorkflowDefinition({
        definitionId: "wf_x",
        organizationId: ORG,
        name: "Dupes",
        createdAt: DEFINED_AT,
        steps: [
          { stepId: "book", title: "Book once", idempotencyScope: "book" },
          { stepId: "book", title: "Book again", idempotencyScope: "book" },
        ],
      }),
    ).toThrow(/declares step book twice/i);
  });

  it("refuses a blank definition id, organisation or name", () => {
    for (const override of [{ definitionId: " " }, { organizationId: " " }, { name: "  " }]) {
      expect(() =>
        createWorkflowDefinition({
          definitionId: "wf_x",
          organizationId: ORG,
          name: "Valid",
          steps: STEPS,
          createdAt: DEFINED_AT,
          ...override,
        }),
      ).toThrow();
    }
  });

  it("refuses an unusable creation instant rather than reading a clock", () => {
    // A definition that cannot say when it was written is a definition whose
    // age is unknowable, and a defaulted `new Date()` here would make two
    // definitions built a second apart disagree about their own history.
    expect(() =>
      createWorkflowDefinition({ definitionId: "wf_x", organizationId: ORG, name: "Undated", steps: STEPS }),
    ).toThrow(/createdAt/i);

    expect(() =>
      createWorkflowDefinition({
        definitionId: "wf_x",
        organizationId: ORG,
        name: "Bad date",
        steps: STEPS,
        createdAt: new Date(Number.NaN),
      }),
    ).toThrow(/createdAt/i);
  });

  it("keeps the creation instant it was given", () => {
    expect(DEFINITION.createdAt).toEqual(DEFINED_AT);
  });

  it("refuses a step with a blank step id or a blank idempotency scope", () => {
    for (const step of [
      { stepId: " ", title: "No id", idempotencyScope: "s" },
      { stepId: "ok", title: "Ok", idempotencyScope: "  " },
    ] as const) {
      expect(() =>
        createWorkflowDefinition({
          definitionId: "wf_x",
          organizationId: ORG,
          name: "Bad step",
          steps: [step],
          createdAt: DEFINED_AT,
        }),
      ).toThrow();
    }
  });

  it("refuses a step with no title, because an unnamed step cannot be reported on", () => {
    expect(() =>
      createWorkflowDefinition({
        definitionId: "wf_x",
        organizationId: ORG,
        name: "Unnamed step",
        createdAt: DEFINED_AT,
        steps: [{ stepId: "book", title: "  ", idempotencyScope: "book" }],
      }),
    ).toThrow(/title/i);
  });

  it("refuses two steps sharing one idempotency scope", () => {
    // Two steps that share a scope share a retry token, so a retry of the first
    // would be swallowed by the second's record. The scope is what makes retry
    // safe, so it has to be unique within a definition.
    expect(() =>
      createWorkflowDefinition({
        definitionId: "wf_x",
        organizationId: ORG,
        name: "Shared scope",
        createdAt: DEFINED_AT,
        steps: [
          { stepId: "one", title: "One", idempotencyScope: "shared" },
          { stepId: "two", title: "Two", idempotencyScope: "shared" },
        ],
      }),
    ).toThrow(/idempotency scope/i);
  });
});

describe("starting a run", () => {
  it("begins at step zero with nothing complete and nothing started", () => {
    const run = createWorkflowRun(runInput());

    expect(run.currentStepId).toBe("quote");
    expect(run.status).toBe("running");
    expect(run.completedStepIds).toEqual([]);
    expect(workflowRunProgress(run)).toEqual({ total: 3, completed: 0, remaining: 3 });
  });

  it("freezes the run and every step record", () => {
    const run = createWorkflowRun(runInput());

    expect(Object.isFrozen(run)).toBe(true);
    for (const record of run.steps) expect(Object.isFrozen(record)).toBe(true);
  });

  it("refuses a run for a definition belonging to another organisation", () => {
    // ADR-0011 in the domain layer: a run executes a definition, and a
    // definition is tenant-owned. Cross-tenant here would let one org's process
    // govern another's work.
    const foreign = Object.freeze({ ...DEFINITION, organizationId: "org_2" });

    expect(() => createWorkflowRun(runInput({ definition: foreign }))).toThrow(
      /which belongs to org_2/,
    );
  });

  it("refuses a blank run id or subject id", () => {
    expect(() => createWorkflowRun(runInput({ runId: " " }))).toThrow(/run id/i);
    // A run with no subject is a process with nothing to do it to, and there is
    // no way to say what it accomplished.
    expect(() => createWorkflowRun(runInput({ subjectId: " " }))).toThrow(/subject/i);
  });

  it("refuses a run that starts before one of its own steps could complete", () => {
    const withHistoricStep = createWorkflowDefinition({
      definitionId: "wf_hist",
      organizationId: ORG,
      name: "Historic",
      createdAt: DEFINED_AT,
      steps: [{ stepId: "one", title: "One", idempotencyScope: "one", completesAt: new Date("2026-01-01T00:00:00Z") }],
    });

    expect(() => createWorkflowRun(runInput({ definition: withHistoricStep }))).toThrow(/before/i);
  });

  it("refuses a run whose startedAt is not usable", () => {
    expect(() => createWorkflowRun(runInput({ startedAt: new Date(Number.NaN) }))).toThrow(/startedAt/i);
  });

  it("carries the subject it is processing onto the run", () => {
    // A run with no subject cannot say what it accomplished, so the subject is
    // stored rather than inferred from the caller that happened to start it.
    expect(createWorkflowRun(runInput()).subjectId).toBe("trip_1");
    expect(createWorkflowRun(runInput()).definitionId).toBe("wf_travel");
  });
});

describe("running the steps in order", () => {
  it("advances one step at a time and refuses to skip one", () => {
    // Skipping is how an approval that never happened becomes a completed
    // workflow, so an out-of-order step is refused rather than reordered.
    const run = startedRun();

    expect(() => recordStepStarted({ run, stepId: "book", at: AT })).toThrow(/book/);
  });

  it("refuses to finish a step that was never started", () => {
    // Completion without a start is the claim that something happened with no
    // record that anybody began it — exactly the shape of a fabricated step.
    const run = createWorkflowRun(runInput());

    expect(() => recordStepCompleted({ run, stepId: "quote", at: AT })).toThrow(/not started|never started/i);
  });

  it("walks the whole definition and lands on `completed`", () => {
    let run = startedRun();
    run = recordStepCompleted({ run, stepId: "quote", at: AT });
    expect(run.status).toBe("running");
    expect(run.currentStepId).toBe("approve");

    run = recordStepStarted({ run, stepId: "approve", at: LATER });
    run = recordStepCompleted({ run, stepId: "approve", at: LATER });

    run = recordStepStarted({ run, stepId: "book", at: LATER });
    run = recordStepCompleted({ run, stepId: "book", at: LATER });

    expect(run.status).toBe("completed");
    expect(run.completedStepIds).toEqual(["quote", "approve", "book"]);
    expect(workflowRunProgress(run)).toEqual({ total: 3, completed: 3, remaining: 0 });
    // A completed run has no next step, rather than a next step that would run.
    expect(nextStep(run)).toBeNull();
  });

  it("records an outcome against a step that needs one, and refuses the rest without", () => {
    // A step that declines the work without saying why produces a run that looks
    // identical to one that never got that far.
    const withDecline = createWorkflowDefinition({
      definitionId: "wf_decline",
      organizationId: ORG,
      name: "Decline",
      createdAt: DEFINED_AT,
      steps: [{ stepId: "quote", title: "Quote", idempotencyScope: "quote", outcomeRequired: true }],
    });

    const run = createWorkflowRun(runInput({ definition: withDecline }));
    const begun = recordStepStarted({ run, stepId: "quote", at: AT });

    expect(() => recordStepCompleted({ run: begun, stepId: "quote", at: AT })).toThrow(/outcome/i);

    const finished = recordStepCompleted({
      run: begun,
      stepId: "quote",
      at: AT,
      outcome: { kind: "declined", reason: "budget withdrawn" },
    });

    expect(isStepComplete(finished, "quote")).toBe(true);
    expect(stepOutcomeFor(finished, "quote")).toEqual({ kind: "declined", reason: "budget withdrawn" });
  });

  it("refuses a completion timestamped before the step began", () => {
    const run = startedRun();

    expect(() =>
      recordStepCompleted({ run, stepId: "quote", at: new Date(AT.getTime() - 60_000) }),
    ).toThrow(/before/i);
  });

  it("refuses to start a step twice", () => {
    // A second start is either a double execution or a lost write; both are
    // indistinguishable afterwards, so the second one is refused.
    const run = startedRun();

    expect(() => recordStepStarted({ run, stepId: "quote", at: LATER })).toThrow(/already/i);
  });

  it("refuses to complete a step twice", () => {
    const finished = recordStepCompleted({ run: startedRun(), stepId: "quote", at: AT });

    expect(() => recordStepCompleted({ run: finished, stepId: "quote", at: LATER })).toThrow(/already/i);
  });

  it("refuses any advance on a completed run", () => {
    let run = startedRun();
    run = recordStepCompleted({ run, stepId: "quote", at: AT });
    run = recordStepStarted({ run, stepId: "approve", at: LATER });
    run = recordStepCompleted({ run, stepId: "approve", at: LATER });
    run = recordStepStarted({ run, stepId: "book", at: LATER });
    const done = recordStepCompleted({ run, stepId: "book", at: LATER });

    expect(() => recordStepStarted({ run: done, stepId: "book", at: LATER })).toThrow(/completed/i);
  });

  it("refuses to move backwards to a step already behind", () => {
    const advanced = recordStepCompleted({ run: startedRun(), stepId: "quote", at: AT });

    expect(() => recordStepStarted({ run: advanced, stepId: "quote", at: LATER })).toThrow(/already/i);
  });

  it("refuses to complete a step that was started but is not the current one", () => {
    // Reachable only from a run whose records were corrupted or hand-edited:
    // `recordStepStarted` refuses to start a non-current step, so no sequence of
    // legal calls produces this state. The guard exists anyway, because a rule
    // that only holds for states the API can construct is not a rule — a row
    // written by a migration or a console is exactly the case it is for, and the
    // same reasoning the ledger's reversal guard uses.
    const honest = advancedRun();
    const corrupted: WorkflowRun = Object.freeze({
      ...honest,
      currentStepId: "approve",
      steps: Object.freeze(
        honest.steps.map((record) =>
          record.stepId === "book" ? Object.freeze({ ...record, status: "in_progress" as const, startedAt: AT }) : record,
        ),
      ),
      retryTokenFor: honest.retryTokenFor,
    });

    expect(corrupted.steps.find((s) => s.stepId === "book")!.status).toBe("in_progress");
    expect(() => recordStepCompleted({ run: corrupted, stepId: "book", at: LATER })).toThrow(
      /not the current step/,
    );
  });
});

describe("idempotency: a retried step must not run twice", () => {
  it("hands out one retry token per step, and the same one on every call", () => {
    const first = recordStepStarted({ run: createWorkflowRun(runInput()), stepId: "quote", at: AT });
    const second = recordStepStarted({ run: createWorkflowRun(runInput()), stepId: "quote", at: LATER });

    // The token is derived from the run, the step and the definition's scope —
    // not from the clock. Two attempts of the same step therefore agree, and an
    // operator can recognise the retry in a log without a database round trip.
    expect(second.retryTokenFor("quote")).toBe(first.retryTokenFor("quote"));
    expect(second.retryTokenFor("quote")).not.toBe(second.retryTokenFor("approve"));
    expect(second.retryTokenFor("quote")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives different runs different tokens for the same step", () => {
    const a = createWorkflowRun(runInput({ runId: "run_a" }));
    const b = createWorkflowRun(runInput({ runId: "run_b" }));

    // Without the run id in the derivation, Org A's retry token would be
    // identical to Org B's for the same step, and a shared downstream system
    // would swallow the second org's request as a duplicate of the first.
    expect(recordStepStarted({ run: a, stepId: "quote", at: AT }).retryTokenFor("quote")).not.toBe(
      recordStepStarted({ run: b, stepId: "quote", at: AT }).retryTokenFor("quote"),
    );
  });

  it("accepts a replayed completion and reports it as a replay rather than a new completion", () => {
    const begun = startedRun();
    const completed = recordStepCompleted({ run: begun, stepId: "quote", at: AT });
    const completion = completed.steps.find((s) => s.stepId === "quote")!;

    // This is the heart of the requirement: a caller that retries after a
    // network timeout must be able to learn "I already did this" WITHOUT the
    // domain re-executing the step. `replayStep` looks the record up and returns
    // `replayed: true`; it never calls anything that performs work.
    const replay = replayStep({ run: completed, stepId: "quote" });

    expect(replay.replayed).toBe(true);
    expect(replay.record).toEqual(completion);
    // The run is byte-for-byte unchanged: a replay has no effect at all.
    expect(replay.run).toBe(completed);
  });

  it("reports `replayed: false` for a step that is still outstanding", () => {
    // The caller has to be able to tell the two apart. A single boolean that is
    // false for both "not done" and "never existed" is how a retry loop either
    // re-executes work or skips it forever.
    const run = createWorkflowRun(runInput());

    expect(replayStep({ run, stepId: "quote" }).replayed).toBe(false);
  });

  it("refuses to replay a step that is not part of the run", () => {
    // A replay lookup must be scoped to the run's own steps. Handed a foreign
    // step id, answering "not done" would invite the caller to do work for a
    // step this run does not have.
    const run = createWorkflowRun(runInput());

    expect(() => replayStep({ run, stepId: "invoice" })).toThrow(/not part of/i);
  });

  it("replays a step that has NOT completed as `replayed: false`", () => {
    // The two-way answer a retry loop depends on: true means "already done", false
    // means "not done". The `record` field is what distinguishes "not yet" from
    // "never started", and it is null for both.
    const run = startedRun();
    const result = replayStep({ run, stepId: "quote" });

    expect(result.replayed).toBe(false);
    expect(result.record).toBeNull();
    expect(result.run).toBe(run);
  });

  it("refuses to replay a step belonging to a different run's own step list", () => {
    // A run with a different step set must not answer for a step it does not
    // have. The lookup is scoped by `run.steps`, not by the definition id, so a
    // caller cannot replay against a run that merely shares a workflow.
    const narrow = createWorkflowRun(
      runInput({
        runId: "run_narrow",
        definition: createWorkflowDefinition({
          definitionId: "wf_narrow",
          organizationId: ORG,
          name: "Narrow",
          createdAt: DEFINED_AT,
          steps: [{ stepId: "approve", title: "Approve", idempotencyScope: "approve" }],
        }),
      }),
    );

    expect(() => replayStep({ run: narrow, stepId: "quote" })).toThrow(/not part of/i);
  });
  it("refuses a completion whose replay token does not match the run", () => {
    // If the caller is going to be trusted to retry, it has to be checked. A
    // completion carrying another run's token is a caller wiring two runs
    // together, and it would otherwise mark a step of the wrong run complete.
    const begun = startedRun();
    const foreign = createWorkflowRun(runInput({ runId: "run_2" }));
    const foreignToken = recordStepStarted({ run: foreign, stepId: "quote", at: AT }).retryTokenFor("quote");

    expect(() =>
      recordStepCompleted({ run: begun, stepId: "quote", at: AT, retryToken: foreignToken }),
    ).toThrow(/retry token/i);
  });
});

describe("interrupting and resuming", () => {
  it("reports a run interrupted mid-step as resumable, and a finished step as not", () => {
    const begun = startedRun();
    expect(canResume(begun, "quote")).toBe(true);

    const completed = advancedRun();
    expect(canResume(completed, "quote")).toBe(false);
    expect(canResume(completed, "approve")).toBe(true);
  });

  it("resumes at the interrupted step and does not restart the completed one", () => {
    const midApprove = recordStepStarted({ run: advancedRun(), stepId: "approve", at: LATER });

    const resumed = resumeWorkflowRun({ run: midApprove, at: new Date(LATER.getTime() + 3_600_000) })!;

    // Resuming returns the SAME step record, with the original start time and the
    // same retry token. That is what "resumable" means here: the step is picked
    // up where it stopped, not begun again.
    expect(resumed.stepId).toBe("approve");
    expect(resumed.record?.startedAt).toEqual(LATER);
    expect(resumed.record?.retryToken).toBe(midApprove.retryTokenFor("approve"));
    expect(resumed.replayed).toBe(false);
  });

  it("resumes a run that stopped BETWEEN steps at the next one", () => {
    const resumed = resumeWorkflowRun({ run: advancedRun(), at: LATER })!;

    // No record: nothing was in flight. The step is simply the next one to start.
    expect(resumed.stepId).toBe("approve");
    expect(resumed.record).toBeNull();
  });

  it("reports nothing to resume once every step is complete", () => {
    let run = createWorkflowRun(runInput());
    for (const stepId of ["quote", "approve", "book"]) {
      run = recordStepCompleted({ run: recordStepStarted({ run, stepId, at: AT }), stepId, at: AT });
    }

    expect(resumeWorkflowRun({ run, at: LATER })).toBeNull();
  });

  it("refuses to resume with a non-resumable step id", () => {
    // `book` is not the run's current step, so resuming there would skip
    // `approve` — the exact skip the ordering rule exists to prevent.
    expect(() => resumeWorkflowRun({ run: advancedRun(), stepId: "book", at: LATER })).toThrow(/resumable step/i);
  });

  it("refuses to resume a step that already ended, completed or failed", () => {
    expect(() => resumeWorkflowRun({ run: advancedRun(), stepId: "quote", at: LATER })).toThrow(/not resumable/i);

    const failed = advanceRun({
      run: createWorkflowRun(runInput()),
      stepId: "quote",
      at: AT,
      outcome: { kind: "failed", reason: "down" },
    });
    // A failed step *ended*, and re-running it is a decision on a fresh run —
    // not a continuation. `canResume` says so before a caller even tries.
    expect(canResume(failed, "quote")).toBe(false);
    // The RUN-level refusal comes first, and it is the better message: it names
    // the run and explains why continuing is wrong, rather than blaming a step
    // that behaved correctly.
    expect(() => resumeWorkflowRun({ run: failed, stepId: "quote", at: LATER })).toThrow(
      /run_1 failed\. A failed run is not resumed/,
    );
  });

  it("refuses to resume at an instant before the run started", () => {
    const run = startedRun();

    expect(() => resumeWorkflowRun({ run, at: new Date(AT.getTime() - 1000) })).toThrow(/before/i);
  });

  it("does not resume a run that failed, because a failed run needs a decision", () => {
    const failed = advanceRun({
      run: createWorkflowRun(runInput()),
      stepId: "quote",
      at: AT,
      outcome: { kind: "failed", reason: "vendor down" },
    });

    // A failed run has THREE steps not complete and still no next step. That is
    // the whole argument: the next step is not waiting, it is blocked on a
    // decision the caller has not made.
    expect(failed.status).toBe("failed");
    expect(nextStep(failed)).toBeNull();
    expect(workflowRunProgress(failed).remaining).toBe(3);
    expect(() => resumeWorkflowRun({ run: failed, at: LATER })).toThrow(/failed/i);
  });
});

describe("task and workflow state agreeing", () => {
  it("accepts a task whose origin names a step this run has started", () => {
    expect(() => assertRunMatchesTasks(startedRun(), [aTask()])).not.toThrow();
  });

  it("rejects a task that claims a different run", () => {
    // The linkage is the point of the exercise: a task in the backlog with no
    // traceable step is work nobody asked for, and one attributed to the wrong
    // run is worse.
    expect(() => assertRunMatchesTasks(startedRun(), [aTask({ originRunId: "run_other" })])).toThrow(
      /claims to come from run run_other/,
    );
  });

  it("rejects a task that claims a step this run does not have", () => {
    expect(() => assertRunMatchesTasks(startedRun(), [aTask({ originStepId: "invoice" })])).toThrow(/invoice/);
  });

  it("rejects a task with no workflow origin while the run created tasks", () => {
    expect(() => assertRunMatchesTasks(startedRun(), [aTask({ originRunId: null, originStepId: null })])).toThrow(
      /no workflow origin/,
    );
  });

  it("rejects a task belonging to another organisation", () => {
    expect(() => assertRunMatchesTasks(startedRun(), [aTask({ organizationId: "org_2" })])).toThrow(/org_2/);
  });

  it("rejects a task created by a step that has not started yet", () => {
    // This is the one that would otherwise slip through: a task for step three
    // existing while step one is still running means somebody created work the
    // workflow has not reached, and it will be picked up as if it were part of
    // the plan.
    const run = startedRun();

    expect(() => assertRunMatchesTasks(run, [aTask({ originStepId: "book" })])).toThrow(/has not started/);
  });

  it("rejects a task whose step is complete while the task is not done", () => {
    // State disagreement in the other direction. A completed step with an
    // untouched task is exactly the "workflow says done, backlog says otherwise"
    // case that makes a board untrustworthy.
    expect(() => assertRunMatchesTasks(advancedRun(), [aTask({ state: "open" })])).toThrow(
      /complete but its task task_1 is open/,
    );
  });

  it("rejects a task for a step twice over, which would double-count the step's work", () => {
    const done = aTask({ state: "done", taskId: "task_a" });

    expect(() => assertRunMatchesTasks(advancedRun(), [done, { ...done, taskId: "task_b" }])).toThrow(
      /more than one task/,
    );
  });

  it("accepts a completed step with a done task and an outstanding step with none", () => {
    expect(() => assertRunMatchesTasks(advancedRun(), [aTask({ state: "done" })])).not.toThrow();
    expect(() => assertRunMatchesTasks(startedRun(), [])).not.toThrow();
  });

  it("accepts a cancelled task for a completed step, because cancelling is a finish", () => {
    // A step whose work was called off still completed. Refusing this would
    // force a caller to keep a cancelled task looking like outstanding work.
    expect(() => assertRunMatchesTasks(advancedRun(), [aTask({ state: "cancelled" })])).not.toThrow();
  });
});

describe("the step record", () => {
  it("exposes the step's position in the definition, not just its id", () => {
    const run = startedRun();
    const record = run.steps.find((s) => s.stepId === "book")!;

    // "Which step is this" is meaningless without its order, and a report that
    // sorted steps alphabetically would show "approve" before "quote".
    expect(record.position).toBe(2);
    expect(record.status).toBe("pending");
  });

  it("carries an outcome only on a step that has one", () => {
    const run = advanceRun({
      run: createWorkflowRun(runInput()),
      stepId: "quote",
      at: AT,
      outcome: { kind: "succeeded" },
    });
    const record = run.steps.find((s) => s.stepId === "quote")!;

    expect(record.outcome).toEqual({ kind: "succeeded" });
    expect(run.steps.find((s) => s.stepId === "approve")!.outcome).toBeNull();
  });

  it("refuses a completion with no outcome when the step declares one required", () => {
    const strict = createWorkflowDefinition({
      definitionId: "wf_strict",
      organizationId: ORG,
      name: "Strict",
      createdAt: DEFINED_AT,
      steps: [{ stepId: "one", title: "One", idempotencyScope: "one", outcomeRequired: true }],
    });
    const run = createWorkflowRun(runInput({ definition: strict }));
    const begun = recordStepStarted({ run, stepId: "one", at: AT });

    const input: CompleteStepInput = { run: begun, stepId: "one", at: AT };
    expect(() => recordStepCompleted(input)).toThrow(/outcome/i);
    // The step's own record carries the requirement, so a run stays auditable
    // against the rules it started under rather than against a definition that
    // may since have been edited.
    expect(begun.steps[0]!.outcomeRequired).toBe(true);
    expect(startedRun().steps[0]!.outcomeRequired).toBe(false);
  });

  it("accepts a supplied outcome on a step that does not require one", () => {
    const run = startedRun();

    expect(() =>
      recordStepCompleted({ run, stepId: "quote", at: AT, outcome: { kind: "succeeded" } }),
    ).not.toThrow();
  });

  it("refuses a completion or a start at an instant that is not usable", () => {
    const run = startedRun();

    expect(() => recordStepCompleted({ run, stepId: "quote", at: new Date(Number.NaN) })).toThrow(/at/i);
    expect(() =>
      recordStepStarted({ run: createWorkflowRun(runInput()), stepId: "quote", at: new Date(Number.NaN) }),
    ).toThrow(/at/i);
  });

  it("refuses a blank reason on a failed or declined step", () => {
    const run = startedRun();

    for (const outcome of [
      { kind: "failed", reason: "  " },
      { kind: "declined", reason: "" },
    ] as const) {
      expect(() => recordStepCompleted({ run, stepId: "quote", at: AT, outcome })).toThrow(/blank reason/i);
    }
  });

  it("refuses a start, completion or token lookup naming a step the run does not have", () => {
    const run = startedRun();

    expect(() => recordStepStarted({ run, stepId: "invoice", at: AT })).toThrow(/not part of/i);
    expect(() => recordStepCompleted({ run, stepId: "invoice", at: AT })).toThrow(/not part of/i);
    expect(() => run.retryTokenFor("invoice")).toThrow(/not part of/i);
  });
});

describe("nothing is invented", () => {
  it("refuses to report a step outcome that was never recorded", () => {
    const run = startedRun();

    // `null`, not a synthesised "succeeded". A caller that cannot distinguish
    // "not done" from "done and fine" will report both as done.
    expect(stepOutcomeFor(run, "quote")).toBeNull();
    expect(isStepComplete(run, "quote")).toBe(false);
  });

  it("counts a failed step as not complete, so progress never over-reports", () => {
    const failed = advanceRun({
      run: createWorkflowRun(runInput()),
      stepId: "quote",
      at: AT,
      outcome: { kind: "failed", reason: "no" },
    });

    // The step ended and the run ended, but NOTHING completed. A progress bar
    // reading "1 of 3 done" after a failure is precisely the invented metric
    // ADR-0019 was written against.
    expect(isStepComplete(failed, "quote")).toBe(false);
    expect(failed.steps.find((s) => s.stepId === "quote")!.status).toBe("failed");
    expect(workflowRunProgress(failed)).toEqual({ total: 3, completed: 0, remaining: 3 });
    expect(failed.completedStepIds).toEqual([]);
  });

  it("counts a declined step as complete, because declining IS an outcome", () => {
    // A declined request is finished business, not unfinished work. Reporting it
    // as outstanding would keep it on somebody's list forever.
    const single = createWorkflowRun(
      runInput({
        definition: createWorkflowDefinition({
          definitionId: "wf_one",
          organizationId: ORG,
          name: "One step",
          createdAt: DEFINED_AT,
          steps: [{ stepId: "quote", title: "Quote", idempotencyScope: "quote", outcomeRequired: true }],
        }),
      }),
    );
    const declined = advanceRun({
      run: single,
      stepId: "quote",
      at: AT,
      outcome: { kind: "declined", reason: "over budget" },
    });

    expect(isStepComplete(declined, "quote")).toBe(true);
    // Declining the ONLY step ends the run as `declined` rather than
    // `completed`: the request was answered, and it was answered no.
    expect(declined.status).toBe("declined");
    expect(workflowRunProgress(declined)).toEqual({ total: 1, completed: 1, remaining: 0 });
  });

  it("keeps a run running when a non-final step is declined, because later steps still apply", () => {
    const declined = advanceRun({
      run: createWorkflowRun(runInput()),
      stepId: "quote",
      at: AT,
      outcome: { kind: "declined", reason: "quoted too high" },
    });

    expect(declined.status).toBe("running");
    expect(declined.currentStepId).toBe("approve");
  });
});
