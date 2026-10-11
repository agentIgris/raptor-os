/**
 * Workflows: a definition, and a run of it that survives being interrupted.
 *
 * Two modules, split because a definition and an execution have different
 * lifetimes. `createWorkflowDefinition` is the **shape** of a process — quote,
 * approve, book — with no state. `createWorkflowRun` is one execution of it
 * against one subject, and it is the part that gets interrupted.
 *
 * The properties that matter, all of them because a run **will** be interrupted:
 *
 * 1. **Ordered.** Steps run in declaration order and a step cannot start until
 *    the current one has finished. Skipping is how an approval that never
 *    happened becomes a completed workflow.
 * 2. **Resumable.** A run's state is a set of per-step records, not a "current
 *    step" integer. Resuming an interrupted step hands back the *existing*
 *    record with its original start time — so a resume is distinguishable from a
 *    restart, which is the question an operator asks after an incident.
 * 3. **Retry-safe.** Every step carries a token derived from
 *    `(run id, idempotency scope)`, so a retry after a timeout is recognisable to
 *    a downstream system. `replayStep` answers "did this already run?" without
 *    running anything, and returns the *identical* run object when it had.
 * 4. **Linked to tasks.** A task a step created names the run AND the step, and
 *    `assertRunMatchesTasks` refuses the disagreements — a task for a step that
 *    never started, a completed step whose task is not done, two tasks for one
 *    step.
 *
 * What is deliberately **not** here: a scheduler and a queue. This package
 * models the domain — what a step's state is, which may run next, what a retry
 * looks like, how a run resumes. Deciding *when* to run is a separate concern
 * with a separate failure mode, and `packages/core` has no clock and no I/O by
 * construction. `packages/db` owns the durable rows; a worker claims them.
 *
 * Pure: no database, no network, no clock. Every instant is a parameter, so a
 * run can be reconstructed as of any date in its life.
 */

export { createWorkflowDefinition } from "./definition.js";
export type {
  CreateWorkflowDefinitionInput,
  WorkflowDefinition,
  WorkflowStep,
} from "./definition.js";

export {
  advanceRun,
  assertRunMatchesTasks,
  canResume,
  createWorkflowRun,
  isStepComplete,
  nextStep,
  recordStepCompleted,
  recordStepStarted,
  replayStep,
  resumeWorkflowRun,
  stepOutcomeFor,
  workflowRunProgress,
} from "./run.js";
export type {
  AdvanceRunInput,
  CompleteStepInput,
  CreateWorkflowRunInput,
  ReplayStepInput,
  ReplayStepResult,
  ResumeResult,
  ResumeWorkflowRunInput,
  RunProgress,
  RunStatus,
  StartStepInput,
  StepOutcome,
  StepStatus,
  WorkflowRun,
  WorkflowStepRun,
} from "./run.js";
