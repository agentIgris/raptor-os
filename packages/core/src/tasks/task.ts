/**
 * A task: an explicit state machine with a transition table.
 *
 * ## Why a table rather than a status column with rules attached
 *
 * `status` plus a `CHECK` constraint can only say what a row may *be*. It cannot
 * say what a row may *become*, because that is a relation between two rows in
 * time and a constraint sees one row at a time. So the legal edges live here as
 * data — {@link TASK_TRANSITIONS} — and the database stores the same table
 * (`task_state_transition` in `packages/db`) so the two cannot disagree about
 * what a task is allowed to do.
 *
 * The table is `Record<TaskState, …>` rather than a plain object: adding a state
 * to {@link TASK_STATES} without deciding its edges is then a **compile error**.
 * That is the structural enforcement, and it is the reason the tryout machine in
 * `../tryout/state-machine.ts` is shaped the same way.
 *
 * ## The one policy decision worth arguing about: `done` requires `in_review`
 *
 * `open → done` is the transition every task board offers first and this one
 * refuses. Without a review state, "done" measures *the click*, and a list of
 * done tasks is a list of claims. Routing every completion through `in_review`
 * means a completed task has, by construction, passed a state somebody looked
 * at — and the transition record names who.
 *
 * ## Why terminal means terminal
 *
 * `done` and `cancelled` have no outgoing edge, and neither does `canTransition`
 * nor `transition` offer a way round it. The legacy system's complaint culture
 * was one of never-final records; an operation that can be reopened forever is
 * the same defect wearing a different hat. A reopened operation is a *new*
 * operation that references the old one, which leaves both visible.
 *
 * ## Why a transition returns a new task
 *
 * There is no in-place mutator anywhere in this module, and
 * `tasks/structure.test.ts` fails if one appears. Every function here is pure and
 * takes a task and returns a task, so "what did this task look like before the
 * transition" is always answerable from whatever the caller kept — which is the
 * only thing that makes a board's history trustworthy.
 *
 * Pure: no clock, no I/O, no randomness. `at` is always supplied.
 */

/** Every state a task may occupy, in lifecycle order. */
export const TASK_STATES = ["open", "in_progress", "blocked", "in_review", "done", "cancelled"] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** States with no outgoing edge. */
export const TERMINAL_TASK_STATES = ["done", "cancelled"] as const;

export type TerminalTaskState = (typeof TERMINAL_TASK_STATES)[number];

/**
 * The transition table.
 *
 * Exported as data so `packages/db` can seed the same edges into
 * `task_state_transition` and the two definitions can be diffed by a test rather
 * than trusted to have stayed in step. Frozen because a mutable transition table
 * is a state machine whose rules a caller may rewrite at runtime.
 *
 * No self-edge appears anywhere, deliberately: `x → x` is a no-op that reads as
 * a second occurrence of the thing, and in an append-only transition log it
 * would inflate the count of real moves.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  open: Object.freeze<TaskState[]>(["in_progress", "blocked", "cancelled"]),
  // `in_progress -> in_review` is the only way towards done. `blocked` is
  // reachable because work genuinely stops: the room is taken, the asset is out.
  in_progress: Object.freeze<TaskState[]>(["blocked", "in_review", "cancelled"]),
  // Unblocking goes back to `in_progress` and not to `open`, because the work
  // that had started is still started; resetting it would misreport it as
  // untouched.
  blocked: Object.freeze<TaskState[]>(["in_progress", "cancelled"]),
  // `in_review -> in_progress` is rework. It is the one backwards edge in the
  // table and it is bounded by `in_review` being re-enterable, not terminal.
  in_review: Object.freeze<TaskState[]>(["in_progress", "done", "cancelled"]),
  // Terminal. Empty lists are the enforcement, not an omission.
  done: Object.freeze<TaskState[]>([]),
  cancelled: Object.freeze<TaskState[]>([]),
});

const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_TASK_STATES);

/** Whether a state has no outgoing edge. */
export function isTerminal(state: TaskState): state is TerminalTaskState {
  return TERMINAL_SET.has(state);
}

/**
 * Whether a transition is structurally legal.
 *
 * A pure table lookup with no guards and no context: it answers only "is this
 * edge in the table". {@link transition} is what enforces the policy — an
 * unassigned task cannot start, and a block needs a reason — and mixing the two
 * would make one function that quietly ignored some of its inputs.
 */
export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/**
 * Task priority, highest last so a numeric sort is also the business order.
 *
 * Four values and no fifth. "Critical" and "urgent" reading differently on two
 * boards is how a queue stops being a queue.
 */
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = Object.freeze({
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
});

/**
 * Compare two priorities, highest first.
 *
 * Returns -1/0/1 rather than a subtraction so a caller sorting cannot overflow
 * on a future numeric encoding, and so the result is usable with `.sort()`
 * directly.
 */
export function comparePriority(a: TaskPriority, b: TaskPriority): -1 | 0 | 1 {
  const rankA = PRIORITY_RANK[a];
  const rankB = PRIORITY_RANK[b];
  if (rankA > rankB) return 1;
  if (rankA < rankB) return -1;
  return 0;
}

/**
 * A unit of work.
 *
 * `state` is the ONLY mutable field in this shape, and it changes only by
 * returning a new task from {@link transition}. Everything else — the title, the
 * dependencies, the creation instant — is frozen with the object, because a task
 * that quietly loses its dependency list is a task whose blockers become
 * invisible while still blocking.
 */
export interface Task {
  readonly taskId: string;
  readonly organizationId: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: TaskState;
  readonly priority: TaskPriority;
  /** `null` until somebody owns it. `in_progress` requires this to be set. */
  readonly assigneeId: string | null;
  readonly dueAt: Date | null;
  readonly createdAt: Date;
  /**
   * The instant of the most recent transition, or `null` for a task that has
   * never moved. A separate column from `createdAt` because "how long has this
   * been stuck" is the question a board actually asks.
   */
  readonly transitionedAt: Date | null;
  /** Who performed the most recent transition. */
  readonly stateChangedBy: string | null;
  /** Why the task was blocked or cancelled. `null` for every other state. */
  readonly stateReason: string | null;
  /** Tasks that must be `done` before this one may start. Sorted, deduplicated. */
  readonly dependsOnTaskIds: readonly string[];
  /**
   * The workflow run that created this task, when one did.
   *
   * `null` for a task a person raised by hand. This is the whole of the
   * task/workflow linkage: a task generated by a workflow names the run AND the
   * step, so "which step of which run is this" is answerable from the task alone
   * rather than from a join that could itself be wrong.
   */
  readonly originRunId: string | null;
  readonly originStepId: string | null;
}

export interface CreateTaskInput {
  readonly taskId: string;
  readonly organizationId: string;
  readonly title: string;
  readonly description?: string | null;
  readonly priority?: TaskPriority;
  readonly assigneeId?: string | null;
  readonly dueAt?: Date | null;
  readonly createdAt: Date;
  readonly dependsOnTaskIds?: readonly string[];
  readonly originRunId?: string | null;
  readonly originStepId?: string | null;
}

/**
 * Validate and freeze a new task.
 *
 * The four refusals here are all shapes that produce a task indistinguishable
 * from a load failure later: no id, no tenant, no title, and a due date that
 * has already passed. That last one is the interesting one — a task opened and
 * born overdue is a data-entry error, and if it is admitted it reports as
 * overdue from the instant it exists, which is noise on the one board anybody
 * watches.
 *
 * A task that depends on *itself* is refused here rather than only by the graph
 * pass. It is the degenerate cycle, and a task whose own existence blocks it is
 * unreadable on the board as well as unschedulable.
 */
export function createTask(input: CreateTaskInput): Task {
  if (input.taskId.trim() === "") {
    throw new Error("A task must carry a non-empty task id");
  }
  if (input.organizationId.trim() === "") {
    throw new Error(`Task ${input.taskId} names no organization; a task with no tenant is not a task`);
  }
  if (input.title.trim() === "") {
    throw new Error(`Task ${input.taskId} has a blank title`);
  }

  const priority = input.priority ?? "normal";
  if (!isKnownPriority(priority)) {
    throw new Error(
      `Task ${input.taskId} has priority ${JSON.stringify(priority)}; expected one of ${TASK_PRIORITIES.join(", ")}`,
    );
  }

  const createdAt = requireInstant(input.createdAt, input.taskId, "createdAt");

  if (input.dueAt !== null && input.dueAt !== undefined) {
    if (Number.isNaN(input.dueAt.getTime())) {
      throw new Error(`Task ${input.taskId} has an unusable dueAt`);
    }
    if (input.dueAt.getTime() <= createdAt.getTime()) {
      throw new Error(
        `Task ${input.taskId} is due at ${input.dueAt.toISOString()}, at or before it was created at ${createdAt.toISOString()}; a task born overdue is a data-entry error`,
      );
    }
  }

  const dependsOnTaskIds = canonicalDependencies(input.taskId, input.dependsOnTaskIds ?? []);

  if (dependsOnTaskIds.includes(input.taskId)) {
    throw new Error(`Task ${input.taskId} lists itself as a dependency; a task cannot wait for itself`);
  }

  const originRunId = input.originRunId ?? null;
  const originStepId = input.originStepId ?? null;
  // A run id without a step id, or the reverse, is half a provenance claim. It
  // is refused rather than completed with a guess, because guessing here would
  // attach a task to the wrong step of the right run.
  if ((originRunId === null) !== (originStepId === null)) {
    throw new Error(
      `Task ${input.taskId} names a workflow origin incompletely: run ${String(originRunId)} with step ${String(originStepId)}. Both are required or neither.`,
    );
  }

  return Object.freeze({
    taskId: input.taskId,
    organizationId: input.organizationId,
    title: input.title,
    description: input.description ?? null,
    state: "open",
    priority,
    assigneeId: input.assigneeId ?? null,
    dueAt: input.dueAt ?? null,
    createdAt,
    transitionedAt: null,
    stateChangedBy: null,
    stateReason: null,
    dependsOnTaskIds,
    originRunId,
    originStepId,
  });
}

export interface TransitionTaskInput {
  readonly task: Task;
  readonly to: TaskState;
  /** Who is moving it. Required on every transition, including a block. */
  readonly actorId: string;
  /** Injected clock. Required, never defaulted. */
  readonly at: Date;
  /** Required for `blocked` and `cancelled`. Forbidden elsewhere. */
  readonly reason?: string;
}

/**
 * Perform a transition and return the new task. The input task is untouched.
 *
 * Throws rather than returning a result object, because every caller of a state
 * transition is about to write it down: a caller that gets an error stops, and a
 * caller that got `null` might not.
 *
 * The guards, in the order they are checked, and each for a reason:
 *
 * 1. **An actor.** A transition nobody performed has no author, and the whole
 *    value of a transition record is who did it.
 * 2. **A usable instant, not before the previous one.** Moving a task backwards
 *    in time is a corrupted record rather than a historical fact — the same rule
 *    `../minors/consent.ts` applies to a withdrawal dated before its grant.
 * 3. **The edge is in the table**, with the legal alternatives named. An error
 *    that says only "illegal transition" costs a developer the whole table.
 * 4. **An assignee before work starts.** "In progress" with nobody's name on it
 *    is how a board fills with work that is nobody's.
 * 5. **A reason to block or cancel.** Both are decisions somebody will be asked
 *    to justify, and an all-whitespace string is not a reason.
 */
export function transition(input: TransitionTaskInput): Task {
  const { task, to, actorId, at } = input;

  if (actorId.trim() === "") {
    throw new Error(`Task ${task.taskId} cannot be moved by nobody: a transition requires an actor`);
  }

  const instant = requireInstant(at, task.taskId, "at");
  const previous = task.transitionedAt;
  if (previous !== null && instant.getTime() < previous.getTime()) {
    throw new Error(
      `Task ${task.taskId} cannot be moved to ${to} at ${instant.toISOString()}, earlier than its last transition at ${previous.toISOString()}; a task cannot move backwards in time`,
    );
  }

  if (isTerminal(task.state)) {
    throw new Error(
      `Task ${task.taskId} is ${task.state}, which is terminal: it has no outgoing transitions. Reopening is a new task that references this one.`,
    );
  }

  if (!canTransition(task.state, to)) {
    // No "is terminal" branch here: the terminal check above already threw, and
    // every non-terminal state has at least one outgoing edge, so `allowed` is
    // never empty at this point. The nesting below is only the `done`
    // explanation, which is worth the extra clause because `open -> done` is the
    // transition a caller is most likely to try and the one whose absence is most
    // likely to read as an oversight rather than a decision.
    const allowed = TASK_TRANSITIONS[task.state].join(", ");
    throw new Error(
      `Illegal task transition ${task.state} -> ${to} for ${task.taskId}. Allowed from ${task.state}: ${allowed}.` +
        (to === "done"
          ? " Completion is only reachable through in_review, so a task is looked at before it is finished."
          : ""),
    );
  }

  if (to === "in_progress" && task.assigneeId === null) {
    throw new Error(
      `Task ${task.taskId} cannot start with no assignee; "in progress" with nobody's name on it is work nobody owns`,
    );
  }

  const reason = input.reason;
  const needsReason = to === "blocked" || to === "cancelled";
  if (needsReason && (reason === undefined || reason.trim() === "")) {
    throw new Error(`Task ${task.taskId} cannot be ${to} without a stated reason`);
  }
  if (!needsReason && reason !== undefined && reason.trim() !== "") {
    // A reason on an ordinary transition is not merely redundant: it is a claim
    // about *why* that would be stored next to a state that does not record
    // causation, and a reader would take it as authoritative.
    throw new Error(
      `Task ${task.taskId} was given a reason for moving to ${to}, but only blocked and cancelled record one`,
    );
  }

  return Object.freeze({
    ...task,
    state: to,
    transitionedAt: instant,
    stateChangedBy: actorId,
    stateReason: needsReason && reason !== undefined ? reason : null,
  });
}

/**
 * Whether a task is past its deadline at `at`.
 *
 * `at >= dueAt`, not `at > dueAt`. A deadline is the first instant the work is
 * late, and strict comparison buys every task one free second.
 *
 * Terminal tasks are never overdue. A cancelled task that missed its date did not
 * miss anything — the work was called off, and reporting it as late puts a false
 * alarm on the one board anybody watches.
 */
export function isOverdue(task: Task, at: Date): boolean {
  return overdueBy(task, at) !== null;
}

/**
 * How late a task is, in **milliseconds**, or `null` if it is not late.
 *
 * Milliseconds because it is the only duration unit both the caller and the
 * caller of the caller can agree on without agreeing on a rounding rule, and
 * `bigint` because a duration spanning a year does not fit comfortably in a
 * float millisecond count once several of them are summed. `null` rather than
 * `0n` for "not late" because zero is a lateness and "not late" is not.
 */
export function overdueBy(task: Task, at: Date): bigint | null {
  const dueAt = task.dueAt;
  if (dueAt === null) return null;
  if (isTerminal(task.state)) return null;

  const late = at.getTime() - dueAt.getTime();
  if (late < 0) return null;
  return BigInt(late);
}

function isKnownPriority(value: TaskPriority): boolean {
  return (TASK_PRIORITIES as readonly string[]).includes(value);
}

/**
 * Shared instant validation, so the error names the offending task rather than
 * saying "invalid date" three times in three files.
 */
function requireInstant(date: Date, taskId: string, field: string): Date {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Task ${taskId} has an unusable ${field}: a task with no usable instant cannot be ordered in time`);
  }
  return date;
}

/**
 * Dependencies, sorted and deduplicated.
 *
 * Both operations are load-bearing rather than tidy. Sorting is what makes a
 * board's rendered order reproducible; deduplication is what stops one blocked
 * predecessor appearing twice and reading as two separate blockers. The input is
 * never aliased, so a caller mutating the array it passed in cannot change the
 * task after the fact.
 */
function canonicalDependencies(taskId: string, dependsOnTaskIds: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const dependency of dependsOnTaskIds) {
    if (dependency.trim() === "") {
      throw new Error(`Task ${taskId} lists a blank task id as a dependency`);
    }
    seen.add(dependency);
  }
  return Object.freeze([...seen].sort(compareStrings));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
