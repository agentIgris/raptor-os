/**
 * Workflow definitions: an ordered list of steps, frozen.
 *
 * A definition is the **shape** of a process — quote, approve, book — with no
 * state of its own. It is the run (`./run.js`) that has a position in time. The
 * split matters because two runs of the same definition execute concurrently and
 * must not be able to see each other: a definition carrying "currently on step
 * two" would make them interfere.
 *
 * ## Why the order is preserved rather than sorted
 *
 * Step order *is* the workflow. Sorting by id turns quote → approve → book into
 * approve → book → quote, and the result is a process that approves a quote
 * nobody has written. The order the caller wrote is therefore preserved exactly,
 * and every report that wants an alphabetical view asks for one explicitly.
 *
 * ## Why each step carries an idempotency scope
 *
 * A step that performs something outside this system — an email, a charge, an
 * API call — must not run twice when the run is retried after a crash. The
 * *scope* is what makes that possible: it names the real-world effect, and the
 * run's retry token is derived from `(run id, scope)` so a downstream system
 * that received the token can recognise the retry. Scope is unique within a
 * definition, because two steps sharing one scope share one token and a retry of
 * the first would be swallowed by the second's record.
 *
 * ## What is deliberately NOT here
 *
 * **There is no scheduler and no queue.** This module models the domain: what a
 * step's state is, which step may run next, what a retry looks like, and how a
 * run resumes. Deciding *when* to run it is a separate concern with a different
 * failure mode, and putting a timer in a pure module would mean `packages/core`
 * could no longer be tested without one. `packages/db` owns the durable
 * `workflow_run`/`workflow_step_run` rows that a worker would claim; this module
 * owns the rules about what those rows are allowed to say.
 *
 * Pure: no clock, no I/O, no randomness.
 */

/** One step of a workflow. */
export interface WorkflowStep {
  /** Unique within the definition. */
  readonly stepId: string;
  /** Human-readable. A step nobody can name is a step nobody can report on. */
  readonly title: string;
  /**
   * Names the real-world effect this step performs, and is unique within the
   * definition. The run's retry token is derived from it, so it is what a
   * downstream system dedupes on.
   */
  readonly idempotencyScope: string;
  /**
   * Whether this step must record an outcome.
   *
   * Set on any step that can end without doing the work — a decline, a
   * cancellation. Without it, "the request was declined" and "nobody got to it"
   * produce the same run, and the first looks like an omission.
   */
  readonly outcomeRequired?: boolean;
  /**
   * A step that may only be started after this instant.
   *
   * Used for a step that must not precede something outside the run: a booking
   * cannot be confirmed before the payment that funds it. `createWorkflowRun`
   * refuses a definition whose earliest such instant precedes the run, because a
   * run that starts "too early" is a run that will wait silently.
   */
  readonly completesAt?: Date;
}

/** An ordered, frozen process. */
export interface WorkflowDefinition {
  readonly definitionId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly steps: readonly WorkflowStep[];
  readonly createdAt: Date;
}

export interface CreateWorkflowDefinitionInput {
  readonly definitionId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly steps: readonly WorkflowStep[];
  readonly createdAt?: Date;
}

/**
 * Validate and freeze a workflow definition.
 *
 * The five refusals each remove a way for the definition to be silently wrong:
 * no steps, duplicate step ids, a blank title, a duplicate idempotency scope,
 * and a blank identity. A definition that fails any of them would produce runs
 * that report progress nobody can attribute to a named step.
 *
 * `createdAt` is a parameter rather than a clock read so a definition imported
 * from another system keeps its real age — the same rule as every other instant
 * in this package.
 */
export function createWorkflowDefinition(input: CreateWorkflowDefinitionInput): WorkflowDefinition {
  if (input.definitionId.trim() === "") {
    throw new Error("A workflow definition must carry a non-empty definition id");
  }
  if (input.organizationId.trim() === "") {
    throw new Error(
      `Workflow definition ${input.definitionId} names no organization; a definition with no tenant would be executable by every tenant`,
    );
  }
  if (input.name.trim() === "") {
    throw new Error(`Workflow definition ${input.definitionId} has a blank name`);
  }
  if (input.steps.length === 0) {
    throw new Error(
      `Workflow definition ${input.definitionId} has no steps. An empty definition is not a workflow that finishes instantly — it is a process that was never written.`,
    );
  }

  const stepIds = new Set<string>();
  const scopes = new Set<string>();

  const steps = input.steps.map((step) => {
    if (step.stepId.trim() === "") {
      throw new Error(`Workflow definition ${input.definitionId} has a step with a blank step id`);
    }
    if (stepIds.has(step.stepId)) {
      throw new Error(
        `Workflow definition ${input.definitionId} declares step ${step.stepId} twice. Two steps with one name are one step, and a run would report the second as though the first had not happened.`,
      );
    }
    stepIds.add(step.stepId);

    if (step.title.trim() === "") {
      throw new Error(
        `Workflow definition ${input.definitionId} step ${step.stepId} has a blank title; an unnamed step cannot be reported on`,
      );
    }

    const scope = step.idempotencyScope.trim();
    if (scope === "") {
      throw new Error(
        `Workflow definition ${input.definitionId} step ${step.stepId} has no idempotency scope. Without one a retry of this step cannot be recognised as a retry.`,
      );
    }
    if (scopes.has(scope)) {
      throw new Error(
        `Workflow definition ${input.definitionId} has two steps sharing the idempotency scope ${scope}. They would share a retry token, so a retry of the first would be swallowed by the second's record.`,
      );
    }
    scopes.add(scope);

    return Object.freeze({ ...step });
  });

  return Object.freeze({
    definitionId: input.definitionId,
    organizationId: input.organizationId,
    name: input.name,
    steps: Object.freeze(steps),
    createdAt: requireInstant(input.createdAt, input.definitionId),
  });
}

/**
 * Shared instant validation.
 *
 * `createdAt` is required rather than defaulted, and specifically **not**
 * defaulted to `new Date()`. A default that reads the clock would mean two
 * definitions built a second apart disagree about when they were written, and
 * the instant exists so a definition imported from another system keeps its real
 * age. An obviously-absent value is recoverable; a plausible-but-wrong one is
 * not.
 */
function requireInstant(date: Date | undefined, definitionId: string): Date {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Workflow definition ${definitionId} has an unusable createdAt`);
  }
  return date;
}
