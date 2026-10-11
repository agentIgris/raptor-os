/**
 * Tasks: a state machine and a dependency graph that has to be a DAG.
 *
 * Two decisions carry the weight here, and both exist because the alternative
 * is a claim the data cannot support.
 *
 * 1. **The legal transitions are a table, and `done` is only reachable through
 *    `in_review`.** A `status` column with a `CHECK` can say what a row may be
 *    but never what it may become, because that is a relation between two rows in
 *    time. The table is exported as data so `packages/db` can seed the same edges
 *    into `task_state_transition` and a test can diff the two rather than trust
 *    that they stayed in step.
 * 2. **A cycle is refused, not tolerated.** A cyclic plan has no valid order, so
 *    a scheduler walking one produces no answer at all rather than a wrong one.
 *    See `./dependencies.ts` for why the naive "already seen means cycle"
 *    detector is wrong on a diamond.
 *
 * A task carries `originRunId` and `originStepId`, which is the whole of the
 * task↔workflow linkage: a task a workflow step created names both, so "which
 * step of which run produced this" is answerable from the task alone. Both or
 * neither — half a provenance claim is refused rather than completed with a
 * guess.
 *
 * Pure: no database, no network, no clock. Every instant is a parameter, so
 * "was this task overdue on the day it was reviewed?" is answerable.
 */

export {
  TASK_PRIORITIES,
  TASK_STATES,
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATES,
  canTransition,
  comparePriority,
  createTask,
  isOverdue,
  isTerminal,
  overdueBy,
  transition,
} from "./task.js";
export type {
  CreateTaskInput,
  Task,
  TaskPriority,
  TaskState,
  TerminalTaskState,
  TransitionTaskInput,
} from "./task.js";

export {
  assertNoDependencyCycle,
  dependencyGraphOf,
  dependentsOf,
  readyTasks,
  topologicalOrder,
} from "./dependencies.js";
export type { TaskEdges, TaskGraph } from "./dependencies.js";
