/**
 * Workflow runs: durable, ordered, resumable, and safe to retry.
 *
 * A definition says what a process *is*; a run says where one execution of it
 * has got to. Everything in this module exists because that execution **will**
 * be interrupted — a process dies between steps, a network times out, an
 * operator restarts a worker — and the design question is what the second
 * attempt is allowed to assume about the first.
 *
 * ## Resumability: the step record is the durable fact
 *
 * A run's state is not a "current step" integer. It is the set of
 * {@link WorkflowStepRun} records, and each one carries its own
 * `startedAt`/`completedAt`. Resuming reads those records and hands back the
 * **existing** record for an interrupted step, with its original start time and
 * its original retry token. That is what "resumable" has to mean: the step is
 * picked up where it stopped, not begun again. A design that reset the start
 * time on resume would be unable to tell a long-running step from a restarted
 * one, which is the question an operator asks after an incident.
 *
 * ## Idempotency: a retry is recognisable, and saying so is free
 *
 * Every step carries a `retryToken` derived from `(run id, idempotency scope)`.
 * Two properties follow, and both are load-bearing:
 *
 * - The same step of the same run always yields the same token, so a caller that
 *   retries after a timeout can hand the token to a downstream system and have
 *   it recognise the retry rather than perform the effect twice.
 * - The same step of a **different** run yields a different token. Without the
 *   run id in the derivation, Org A's token would equal Org B's for the same
 *   step, and a shared downstream system would silently swallow the second org's
 *   request as a duplicate of the first. That is a cross-tenant data loss, and it
 *   is asserted directly.
 *
 * The token is **derived, not assigned on first use**: computing it needs no
 * prior state, so a caller can obtain it before starting a step and use it to
 * make the start itself idempotent. Both halves appear on the run —
 * {@link WorkflowRun.retryTokenFor} for the lookup, and `retryToken` as an
 * optional field on {@link CompleteStepInput} so a completion carrying a token
 * from another run is refused rather than quietly marking the wrong one done.
 *
 * {@link replayStep} is the other half: given a run and a step, it reports
 * whether the work was already done, returning the existing record and the
 * **identical** run object when it was. It never performs work. A retry loop
 * therefore has a correct, cheap way to ask "did this already happen?" — and
 * because it hands back the same object reference, "nothing changed" is
 * assertable rather than merely claimed.
 *
 * ## Why `failed` ends the run
 *
 * A step that failed did not do the work. Continuing past it would produce a run
 * marked completed whose later steps ran against an earlier step that never
 * happened. Retrying a failed run is a **decision**, so this module refuses to
 * resume one and exposes {@link advanceRun} for the caller to make the next
 * attempt explicitly.
 *
 * ## Task linkage is checked, not assumed
 *
 * A task raised by a workflow step names both the run and the step
 * (`originRunId`/`originStepId` on `Task`). {@link assertRunMatchesTasks} is the
 * cross-check: it refuses a task for a step that has not started, a task for a
 * step that is complete while the task is not done, a task claiming another run,
 * and two tasks for one step. Without it, "the workflow says this is done" and
 * "the backlog says it isn't" can both be true.
 *
 * ## What is deliberately NOT here
 *
 * **No scheduler and no queue.** This module models the domain: what a step's
 * state is, which step may run next, what a retry looks like, how a run resumes.
 * It does not decide *when* any of that happens, it holds no timer, and it talks
 * to no broker. Those belong to the durable `workflow_run` / `workflow_step_run`
 * rows in `packages/db` and to a worker that claims them. Putting a clock and an
 * I/O boundary into this module would destroy the one property it has that a
 * scheduler does not: every instant here is a parameter, so a run can be
 * reconstructed and audited as of any date in its life.
 *
 * Pure: no database, no network, no clock.
 */

import { createHash } from "node:crypto";

import type { Task } from "../tasks/index.js";
import type { WorkflowDefinition, WorkflowStep } from "./definition.js";

/**
 * What happened to a step.
 *
 * `succeeded` and `declined` are both COMPLETE. Declining is finished business,
 * not unfinished work — a declined travel request that stays on somebody's list
 * forever is a list that stops being read. `failed` is not complete and ends the
 * run, because the step's work did not happen.
 */
export type StepOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "declined"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Per-step status.
 *
 * `failed` is a **distinct** terminal status rather than a `completed` step
 * carrying a failed outcome, because "this step ended" and "this step's work
 * happened" are different claims. Collapsing them means `workflowRunProgress`
 * would report a run as one-third done after its first step failed, which is the
 * over-reporting ADR-0019 exists to prevent — a number presented as a
 * measurement while describing something else.
 *
 * `failed` is terminal: the run has ended and nothing re-runs the step. Retrying
 * is a decision the caller makes explicitly, on a fresh run.
 */
export type StepStatus = "pending" | "in_progress" | "completed" | "failed";

/** The run's overall status. */
export type RunStatus = "running" | "completed" | "declined" | "failed";

/**
 * One step's durable record within one run.
 *
 * `startedAt` is written once and never moved, so a resumed step keeps the start
 * of the *original* attempt. That single fact is what makes a resume
 * distinguishable from a restart.
 */
export interface WorkflowStepRun {
  readonly stepId: string;
  /** Zero-based position in the definition. */
  readonly position: number;
  readonly status: StepStatus;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  /** Derived from `(runId, idempotencyScope)`. Stable across retries. */
  readonly retryToken: string;
  /**
   * Whether the definition declared this step as needing an outcome.
   *
   * Carried onto the record rather than looked up in the definition, so
   * {@link recordStepCompleted} can enforce it without holding a reference to a
   * definition that may since have been edited — and because a run has to remain
   * auditable against the rules it was started under.
   */
  readonly outcomeRequired: boolean;
  /** `null` until the step completes. See {@link StepOutcome}. */
  readonly outcome: StepOutcome | null;
}

/** One execution of a definition against one subject. */
export interface WorkflowRun {
  readonly runId: string;
  readonly organizationId: string;
  readonly definitionId: string;
  /** The thing being processed: a trip, an invoice, a contract. */
  readonly subjectId: string;
  readonly status: RunStatus;
  /** The step a fresh execution is on, or `null` when the run has ended. */
  readonly currentStepId: string | null;
  /** Completed step ids, in completion order. */
  readonly completedStepIds: readonly string[];
  /** One record per definition step, in definition order. */
  readonly steps: readonly WorkflowStepRun[];
  readonly startedAt: Date;
  /**
   * The retry token for one step of this run.
   *
   * A method rather than a lookup function so a caller holding a run does not
   * have to remember to import anything, and because a token is a property OF a
   * run rather than of a step definition: two runs of the same definition must
   * produce different tokens, and a function that took only a step could not.
   */
  retryTokenFor(stepId: string): string;
}

export interface CreateWorkflowRunInput {
  readonly runId: string;
  readonly organizationId: string;
  readonly definition: WorkflowDefinition;
  /** The thing being processed. A run with no subject did nothing to nothing. */
  readonly subjectId: string;
  readonly startedAt: Date;
}

/**
 * Begin a run. Every step starts `pending`; nothing has happened yet.
 *
 * Refuses a definition belonging to another organisation (ADR-0011 in the domain
 * layer: a run executes a tenant-owned definition) and any step whose
 * `completesAt` precedes the run's start — a run that begins before its own
 * earliest permitted step would wait silently, which presents as a hang.
 */
export function createWorkflowRun(input: CreateWorkflowRunInput): WorkflowRun {
  if (input.runId.trim() === "") {
    throw new Error("A workflow run must carry a non-empty run id");
  }
  if (input.subjectId.trim() === "") {
    throw new Error(
      `Workflow run ${input.runId} names no subject; a run with nothing to process cannot say what it accomplished`,
    );
  }
  if (input.definition.organizationId !== input.organizationId) {
    throw new Error(
      `Workflow run ${input.runId} in ${input.organizationId} cannot execute definition ${input.definition.definitionId}, which belongs to ${input.definition.organizationId}`,
    );
  }

  const startedAt = requireInstant(input.startedAt, input.runId, "startedAt");

  for (const step of input.definition.steps) {
    const completesAt = step.completesAt;
    if (completesAt !== undefined && completesAt.getTime() < startedAt.getTime()) {
      throw new Error(
        `Workflow run ${input.runId} starts at ${startedAt.toISOString()}, before step ${step.stepId} may complete at ${completesAt.toISOString()}; a run that begins too early waits silently`,
      );
    }
  }

  const steps = input.definition.steps.map((step, position) => makeStepRun(step, position, input.runId));

  return freezeRun({
    runId: input.runId,
    organizationId: input.organizationId,
    definitionId: input.definition.definitionId,
    subjectId: input.subjectId,
    status: "running",
    // No `?? null`: `createWorkflowDefinition` refuses an empty step list, so a
    // definition this run can execute always has at least one step and the first
    // one is therefore the current step. A guard would be a branch no input could
    // take, and it would quietly make "a run with no steps" representable.
    currentStepId: (steps[0] as WorkflowStepRun).stepId,
    completedStepIds: Object.freeze([] as readonly string[]),
    steps: Object.freeze(steps),
    startedAt,
  });
}

/**
 * Freeze a run and close over its own step list for `retryTokenFor`.
 *
 * The closure is why the token lookup is a method rather than a field: a field
 * would have to be a string per step, and a method derived from `runId` alone
 * could not validate that the step belongs to *this* definition — which is the
 * check that stops a caller marking a step of the wrong run complete.
 */
function freezeRun(fields: Omit<WorkflowRun, "retryTokenFor">): WorkflowRun {
  const run: WorkflowRun = {
    ...fields,
    retryTokenFor(stepId: string): string {
      const record = run.steps.find((s) => s.stepId === stepId);
      if (record === undefined) {
        throw new Error(`Step ${stepId} is not part of run ${fields.runId}`);
      }
      return record.retryToken;
    },
  };
  return Object.freeze(run);
}

export interface StartStepInput {
  readonly run: WorkflowRun;
  readonly stepId: string;
  readonly at: Date;
}

/**
 * Mark the run's current step as started, returning a new run.
 *
 * Refuses to start anything other than the current step — skipping is how an
 * approval that never happened becomes a completed workflow — and refuses a
 * second start of the same step, which is either a double execution or a lost
 * write and is indistinguishable afterwards.
 */
export function recordStepStarted(input: StartStepInput): WorkflowRun {
  const { run, stepId } = input;
  assertRunning(run);
  const at = requireInstant(input.at, run.runId, "at");

  const existing = findStep(run, stepId);
  if (existing.status !== "pending") {
    throw new Error(`Step ${stepId} of run ${run.runId} was already ${existing.status}; it cannot be started again`);
  }
  if (run.currentStepId !== stepId) {
    throw new Error(
      `Step ${stepId} is not the current step of run ${run.runId} (which is ${String(run.currentStepId)}). Steps run in order; skipping one is how a workflow reports work that never happened.`,
    );
  }

  return replaceStep(run, stepId, { ...existing, status: "in_progress", startedAt: at });
}

export interface CompleteStepInput {
  readonly run: WorkflowRun;
  readonly stepId: string;
  readonly at: Date;
  /**
   * The retry token, when the caller obtained one via
   * {@link WorkflowRun.retryTokenFor}.
   *
   * Optional, but supplying it makes the completion *checked*: a token that does
   * not match this run's is refused, which is what stops a caller wiring two runs
   * together. Omitting it asserts "I am the one executing this run", which is a
   * real assertion and is why it is not silently the only option.
   */
  readonly retryToken?: string;
  /** Required when the step declares `outcomeRequired`. */
  readonly outcome?: StepOutcome;
}

/**
 * Complete the run's current step, advancing to the next.
 *
 * A step with no supplied outcome completes `succeeded` — which is exactly why a
 * definition marks `outcomeRequired` on any step that can end without doing its
 * work. Without that flag "the request was declined" and "nobody got to it"
 * produce the same run, and the first reads as an omission.
 */
export function recordStepCompleted(input: CompleteStepInput): WorkflowRun {
  const { run, stepId } = input;
  assertRunning(run);
  const at = requireInstant(input.at, run.runId, "at");

  const existing = findStep(run, stepId);
  if (existing.status === "completed") {
    throw new Error(`Step ${stepId} of run ${run.runId} was already completed; it cannot be completed again`);
  }
  if (existing.status === "pending") {
    throw new Error(
      `Step ${stepId} of run ${run.runId} was never started. A completion with no start is the claim that work happened with no record that anybody began it.`,
    );
  }
  if (run.currentStepId !== stepId) {
    throw new Error(
      `Step ${stepId} is not the current step of run ${run.runId} (which is ${String(run.currentStepId)}); a later step cannot complete while an earlier one is outstanding`,
    );
  }
  if (input.retryToken !== undefined && input.retryToken !== existing.retryToken) {
    throw new Error(
      `Completion for step ${stepId} of run ${run.runId} carries a retry token from another run; refusing to mark a step of the wrong run complete`,
    );
  }

  const startedAt = existing.startedAt;
  if (startedAt !== null && at.getTime() < startedAt.getTime()) {
    throw new Error(
      `Step ${stepId} of run ${run.runId} cannot complete at ${at.toISOString()}, before it started at ${startedAt.toISOString()}`,
    );
  }

  const outcome = input.outcome ?? { kind: "succeeded" };
  if (outcome.kind !== "succeeded" && outcome.reason.trim() === "") {
    throw new Error(`Step ${stepId} of run ${run.runId} has a ${outcome.kind} outcome with a blank reason`);
  }
  if (existing.outcomeRequired && input.outcome === undefined) {
    throw new Error(
      `Step ${stepId} of run ${run.runId} must record an outcome. This step can end without doing its work, so "declined" and "never reached" have to be distinguishable.`,
    );
  }

  const failed = outcome.kind === "failed";

  const updated = replaceStep(run, stepId, {
    ...existing,
    // A failed step ends, but its work did not happen. `failed` is not
    // `completed`, so nothing downstream can count it as progress.
    status: failed ? "failed" : "completed",
    completedAt: at,
    outcome,
  });

  const remaining = run.steps.filter((s) => s.status !== "completed" && s.stepId !== stepId);
  const isLast = remaining.length === 0;

  // A failed run has no current step even when steps remain: the next step is
  // not pending, it is blocked on a decision the caller has not made. Reporting
  // one would invite exactly the continuation this module refuses.
  const status: RunStatus = failed
    ? "failed"
    : isLast
      ? outcome.kind === "declined"
        ? "declined"
        : "completed"
      : "running";

  return freezeRun({
    ...updated,
    status,
    // When neither `failed` nor `isLast`, `remaining` is non-empty by definition
    // (`isLast` is precisely the test for it being empty), so there is no `??`
    // to write. The two conditions above are the whole story of what this
    // pointer means.
    currentStepId: failed || isLast ? null : (remaining[0] as WorkflowStepRun).stepId,
    completedStepIds: Object.freeze(failed ? run.completedStepIds : [...run.completedStepIds, stepId]),
  });
}

export interface AdvanceRunInput {
  readonly run: WorkflowRun;
  readonly stepId: string;
  readonly at: Date;
  readonly outcome: StepOutcome;
}

/**
 * Start **and** complete a step in one call.
 *
 * Convenience only: it is exactly {@link recordStepStarted} followed by
 * {@link recordStepCompleted} on the intermediate run, so it cannot accept a
 * shape the two-step path would refuse.
 */
export function advanceRun(input: AdvanceRunInput): WorkflowRun {
  const started = recordStepStarted({ run: input.run, stepId: input.stepId, at: input.at });
  return recordStepCompleted({ run: started, stepId: input.stepId, at: input.at, outcome: input.outcome });
}

export interface ReplayStepInput {
  readonly run: WorkflowRun;
  readonly stepId: string;
}

export interface ReplayStepResult {
  /**
   * Whether the work was already done.
   *
   * `false` for both "not done" and "never started"; the caller pairs it with
   * {@link ReplayStepResult.record}, which distinguishes them.
   */
  readonly replayed: boolean;
  /** The step's record when complete, `null` otherwise. */
  readonly record: WorkflowStepRun | null;
  /** The run, unchanged — a replay has no effect at all. */
  readonly run: WorkflowRun;
}

/**
 * Ask "did this step already run?" without running anything.
 *
 * When the step is complete this returns the existing record, `replayed: true`,
 * and the **identical** run object — a replay has no effect whatsoever. That
 * object identity is asserted by a test, because a replay that rebuilt the run
 * would make a retry loop's "nothing changed" claim untestable.
 */
export function replayStep(input: ReplayStepInput): ReplayStepResult {
  const record = findStep(input.run, input.stepId);
  const isComplete = record.status === "completed";
  return Object.freeze({ replayed: isComplete, record: isComplete ? record : null, run: input.run });
}

/**
 * Whether `stepId` is still outstanding, and so could be started or resumed.
 *
 * `failed` counts as not resumable even though it is not `completed`: the step
 * ended, and re-running it is a decision on a fresh run rather than a
 * continuation of this one. A caller checking this before resuming therefore
 * cannot mistake a failed step for one that merely needs picking up.
 */
export function canResume(run: WorkflowRun, stepId: string): boolean {
  const status = findStep(run, stepId).status;
  return status !== "completed" && status !== "failed";
}

export interface ResumeWorkflowRunInput {
  readonly run: WorkflowRun;
  readonly at: Date;
  /** Narrow to a specific step; otherwise the run's own current step is used. */
  readonly stepId?: string;
}

export interface ResumeResult {
  readonly stepId: string;
  /**
   * The **existing** record for an interrupted step, `null` for a run that
   * stopped between steps. An interrupted step keeps its original `startedAt`
   * and retry token; that is what makes a resume a resume.
   */
  readonly record: WorkflowStepRun | null;
  /** Always false: this is a fresh resumption, not a replay of finished work. */
  readonly replayed: boolean;
}

/**
 * Hand back the step a second attempt should pick up.
 *
 * Returns `null` on a finished run, refuses a `failed` run (retrying one is a
 * decision, not an automatic continuation) and refuses a step that is already
 * complete — resuming a completed step would re-run it, which is precisely the
 * double execution this module exists to make impossible.
 */
export function resumeWorkflowRun(input: ResumeWorkflowRunInput): ResumeResult | null {
  const { run } = input;
  const at = requireInstant(input.at, run.runId, "at");
  if (at.getTime() < run.startedAt.getTime()) {
    throw new Error(
      `Workflow run ${run.runId} cannot be resumed at ${at.toISOString()}, before it started at ${run.startedAt.toISOString()}`,
    );
  }
  if (run.status === "failed") {
    throw new Error(
      `Workflow run ${run.runId} failed. A failed run is not resumed automatically: the step that failed did not do its work, so continuing would run later steps against a step that never happened.`,
    );
  }

  const stepId = input.stepId ?? run.currentStepId;
  if (stepId === null) return null;

  const record = findStep(run, stepId);
  if (record.status === "completed" || record.status === "failed") {
    throw new Error(`Step ${stepId} of run ${run.runId} already ended and is not resumable`);
  }
  if (run.currentStepId !== stepId) {
    throw new Error(
      `Step ${stepId} of run ${run.runId} is not the resumable step (which is ${String(run.currentStepId)})`,
    );
  }

  return Object.freeze({
    stepId,
    record: record.status === "in_progress" ? record : null,
    replayed: false,
  });
}

/**
 * Whether a step completed — by succeeding or by being declined.
 *
 * A `failed` step returns `false`. It ended, but its work did not happen, and
 * reporting it as complete is how a plan gets marked done on the strength of a
 * step that errored.
 */
export function isStepComplete(run: WorkflowRun, stepId: string): boolean {
  return findStep(run, stepId).status === "completed";
}

/**
 * The outcome recorded against a step, or `null` if it has none.
 *
 * `null` rather than a synthesised `{kind: "succeeded"}`, because a caller that
 * cannot distinguish "not done" from "done and fine" will report both as done.
 */
export function stepOutcomeFor(run: WorkflowRun, stepId: string): StepOutcome | null {
  return findStep(run, stepId).outcome;
}

/**
 * The step a fresh execution would work on next, or `null` when the run has
 * ended.
 *
 * Distinct from "the first step that is not complete": a failed run has an
 * incomplete step and no next one, because continuing past a failure is the
 * decision this module refuses to make on the caller's behalf.
 */
export function nextStep(run: WorkflowRun): string | null {
  return run.currentStepId;
}

export interface RunProgress {
  readonly total: number;
  readonly completed: number;
  /** Steps not yet complete. Includes the one in progress. */
  readonly remaining: number;
}

/**
 * How far a run has got, counted from the step records rather than from the run
 * status.
 *
 * A failed step counts as **not** complete, so `completed` here can never
 * over-report. That is the whole reason this is a fold over records instead of a
 * read of `run.status === "completed"`.
 */
export function workflowRunProgress(run: WorkflowRun): RunProgress {
  const completed = run.steps.filter((s) => s.status === "completed").length;
  return Object.freeze({
    total: run.steps.length,
    completed,
    remaining: run.steps.length - completed,
  });
}

/**
 * Cross-check a run against the tasks that claim to come from it.
 *
 * Throws on the first disagreement, naming it. The refusals, and why each
 * matters:
 *
 * - a task from another organisation, or claiming another run: unattributable
 *   work;
 * - a task for a step this run does not have: unattributable work, other cause;
 * - a task with no origin at all: the case that slips through otherwise, and
 *   exactly what a hand-raised task in the backlog looks like;
 * - a task for a step that has not started: work created ahead of the plan;
 * - a completed step whose task is neither done nor cancelled: the "workflow
 *   says done, backlog says otherwise" disagreement that makes a board
 *   untrustworthy;
 * - two tasks for one step: that step's work counted twice.
 *
 * A running run with no tasks is fine — not every workflow creates one.
 */
export function assertRunMatchesTasks(run: WorkflowRun, tasks: readonly Task[]): void {
  const perStep = new Map<string, Task>();

  for (const task of tasks) {
    if (task.organizationId !== run.organizationId) {
      throw new Error(
        `Task ${task.taskId} belongs to ${task.organizationId} but run ${run.runId} is in ${run.organizationId}; a task from another tenant is not this run's work`,
      );
    }
    if (task.originRunId === null || task.originStepId === null) {
      throw new Error(
        `Task ${task.taskId} has no workflow origin; a task in the backlog with no traceable step is work nobody asked for`,
      );
    }
    if (task.originRunId !== run.runId) {
      throw new Error(`Task ${task.taskId} claims to come from run ${task.originRunId}, not ${run.runId}`);
    }

    const record = run.steps.find((s) => s.stepId === task.originStepId);
    if (record === undefined) {
      throw new Error(`Task ${task.taskId} claims step ${task.originStepId}, which run ${run.runId} does not have`);
    }
    if (record.status === "pending") {
      throw new Error(
        `Task ${task.taskId} was created by step ${task.originStepId}, which run ${run.runId} has not started; work created ahead of the plan will be picked up as though it were part of it`,
      );
    }
    if (record.status === "completed" && task.state !== "done" && task.state !== "cancelled") {
      throw new Error(
        `Step ${task.originStepId} of run ${run.runId} is complete but its task ${task.taskId} is ${task.state}; the run and the backlog disagree`,
      );
    }
    if (perStep.has(task.originStepId)) {
      throw new Error(
        `Step ${task.originStepId} of run ${run.runId} has more than one task (${perStep.get(task.originStepId)?.taskId} and ${task.taskId}); a step's work counted twice is worse than counted once`,
      );
    }
    perStep.set(task.originStepId, task);
  }
}

// --- internals --------------------------------------------------------------

function makeStepRun(step: WorkflowStep, position: number, runId: string): WorkflowStepRun {
  return Object.freeze({
    stepId: step.stepId,
    position,
    status: "pending",
    startedAt: null,
    completedAt: null,
    retryToken: deriveRetryToken(runId, step.idempotencyScope),
    outcomeRequired: step.outcomeRequired ?? false,
    outcome: null,
  });
}

/**
 * The retry token: sha-256 over `(runId, idempotencyScope)`, length-framed.
 *
 * Both parts are framed so `("run_1", "ab")` and `("run_1a", "b")` cannot
 * produce the same token — the same boundary-attack reasoning as
 * `../contracts/version.ts`, applied to a value a downstream system dedupes on.
 * Including the run id is what stops one org's token colliding with another's
 * for the same step.
 */
function deriveRetryToken(runId: string, scope: string): string {
  const framed = `${Buffer.byteLength(runId, "utf8")}:${runId}${Buffer.byteLength(scope, "utf8")}:${scope}`;
  return createHash("sha256").update(framed, "utf8").digest("hex");
}

function findStep(run: WorkflowRun, stepId: string): WorkflowStepRun {
  const record = run.steps.find((s) => s.stepId === stepId);
  if (record === undefined) {
    throw new Error(`Step ${stepId} is not part of run ${run.runId}`);
  }
  return record;
}

function replaceStep(run: WorkflowRun, stepId: string, replacement: WorkflowStepRun): WorkflowRun {
  return freezeRun({
    ...run,
    steps: Object.freeze(run.steps.map((s) => (s.stepId === stepId ? Object.freeze(replacement) : s))),
  });
}

/**
 * A run that has ended accepts no steps.
 *
 * `failed` is included, and that is the load-bearing part: a run whose first
 * step failed has three steps left, and letting the caller start the second
 * would produce a completed run built on a step that never happened.
 */
function assertRunning(run: WorkflowRun): void {
  if (run.status !== "running") {
    throw new Error(`Workflow run ${run.runId} is ${run.status} and accepts no further steps`);
  }
}

function requireInstant(date: Date, runId: string, field: string): Date {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Workflow run ${runId} has an unusable ${field}`);
  }
  return date;
}
