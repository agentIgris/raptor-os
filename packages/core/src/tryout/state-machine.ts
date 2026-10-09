/**
 * The tryout state machine.
 *
 * ## The vocabulary
 *
 * Exactly six phases: `applied | screened | invited | evaluated | selected |
 * rejected`. Closed and ordered, so an off-vocabulary phase is a compile error.
 *
 * ## What legacy actually implemented: three of nine declared transitions
 *
 * This is the finding (ADR-0016 §4), and it deserves to be stated precisely
 * because the gap between "declared" and "implemented" is the whole problem.
 *
 * Only `applied → invited → evaluated` was ever written
 * (`app/api/discord/tryout/{apply,invite,evaluate}/route.ts`). The other nine
 * states the schema permits — `screened`, `shortlisted`, `withdrawn`, `selected`,
 * `rejected`, plus every `tryout_invitations` and `tryout_sessions` transition —
 * were declared in CHECK constraints and written by **nothing**.
 * `tryout_selections` had no `INSERT` or `UPDATE` anywhere in the tree. A
 * pipeline whose selection phase could not be written to was a pipeline that
 * ended at `evaluated` forever, with every candidate permanently undecided.
 *
 * {@link LEGACY_IMPLEMENTED_TRANSITIONS} records what was real, so a reader can
 * see at a glance which rows of the table below are recovered behaviour and which
 * are new. New is not automatically right — it is simply new, and saying which
 * is which is the point.
 *
 * ## The `applied → invited` skip, surfaced rather than repeated
 *
 * Legacy's invite route, applied to a candidate still in `applied`, force-wrote
 * `status = 'screened'` **while performing no screening at all**. It invented a
 * screening record to satisfy a CHECK constraint rather than screening anybody.
 * The row then read `screened` and nobody could tell that nobody had looked.
 *
 * That transition is legal here, but it is now an explicit, declared skip:
 * {@link canTransition} reports it, the transition table marks it
 * `skipsScreening`, and {@link TRANSITIONS} records that no screen occurred. The
 * surprise is preserved as *data* instead of as a lie in a column.
 *
 * ## Separation of duties
 *
 * `evaluated → selected` requires the actor to differ from the evaluator. Legacy
 * had no such check, which meant the person who scored a candidate could also
 * hire them.
 *
 * ## Terminal states
 *
 * `selected` and `rejected` are terminal, and legacy had no terminal handling at
 * all — no cascade, no cleanup. This module does not invent side effects; it
 * refuses the transitions and names the terminality, so the caller's cleanup is
 * an explicit decision rather than an accident of which route ran.
 *
 * Pure: no clock, no I/O, no randomness.
 */

/** The six declared phases, in pipeline order. */
export const PHASES = ["applied", "screened", "invited", "evaluated", "selected", "rejected"] as const;

export type TryoutPhase = (typeof PHASES)[number];

/**
 * Phases with no outgoing transition.
 *
 * New in this rewrite. Legacy permitted writes out of both of these in its
 * CHECK constraints and simply had no code that performed them.
 */
export const TERMINAL_PHASES = ["selected", "rejected"] as const;

export type TerminalPhase = (typeof TERMINAL_PHASES)[number];

/**
 * The transitions legacy actually implemented (ADR-0016 §4).
 *
 * Recorded so the difference between "recovered" and "new" is legible in the
 * source rather than only in a commit message. Note that even this set is
 * incomplete as a pipeline: it ends at `evaluated`, and neither `selected` nor
 * `rejected` was reachable.
 */
export const LEGACY_IMPLEMENTED_TRANSITIONS = ["applied>invited", "invited>evaluated"] as const;

const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_PHASES);

/** Whether a phase has no outgoing transition. */
export function isTerminal(phase: TryoutPhase): phase is TerminalPhase {
  return TERMINAL_SET.has(phase);
}

interface TransitionRule {
  readonly to: readonly TryoutPhase[];
  /**
   * Destinations reachable from here that bypass `screened` without that work
   * being done. Only `applied → invited` qualifies.
   *
   * Keyed on the destination rather than being a boolean on the row, because
   * `applied → screened` and `applied → rejected` are not skips and a flag on
   * the source row would mark all three at once.
   */
  readonly screeningSkips?: readonly TryoutPhase[];
}

/**
 * The transition table, keyed by every phase.
 *
 * `Record<TryoutPhase, ...>` rather than a plain object: adding a phase to
 * {@link PHASES} without deciding its transitions is then a **compile error**.
 * That is the structural enforcement — the table cannot silently grow a hole.
 */
export const TRANSITIONS: Readonly<Record<TryoutPhase, TransitionRule>> = Object.freeze({
  // Invite without screening. Legal, but `skipsScreening` records that no
  // screen happened, which is the fact legacy wrote into a status column.
  applied: { to: ["screened", "invited", "rejected"], screeningSkips: ["invited"] },
  screened: { to: ["invited", "rejected"] },
  invited: { to: ["evaluated", "rejected"] },
  // Selection is the only way into `selected`, so it can never be skipped.
  evaluated: { to: ["selected", "rejected"] },
  // Terminal. Empty outbound lists are the enforcement, not an omission.
  selected: { to: [] },
  rejected: { to: [] },
});

/**
 * Whether a transition is structurally legal.
 *
 * A pure lookup — it answers only "is this edge in the table", and consults
 * nothing else. It does **not** consider guards, separation of duties, or
 * required reasons: those need context this function does not take, and a
 * predicate that silently ignored its inputs would be worse than useless. Use
 * {@link transition} to enforce those.
 */
export function canTransition(from: TryoutPhase, to: TryoutPhase): boolean {
  return TRANSITIONS[from].to.includes(to);
}

/** Whether this specific edge bypasses screening without performing it. */
export function skipsScreening(from: TryoutPhase, to: TryoutPhase): boolean {
  const skips = TRANSITIONS[from].screeningSkips;
  return skips !== undefined && skips.includes(to);
}

export interface TransitionContext {
  readonly candidateId: string;
  /** The staff member performing the transition. */
  readonly actorId: string;
  /**
   * The evaluator who scored the candidate.
   *
   * Required for `evaluated → selected`. Separation of duties is enforced
   * against this, because legacy let the person who evaluated a candidate also
   * select them.
   */
  readonly evaluatedBy?: string;
  /** Required for every transition into `rejected`. */
  readonly reason?: string;
}

export interface TransitionRequest {
  readonly from: TryoutPhase;
  readonly to: TryoutPhase;
  readonly context: TransitionContext;
}

/**
 * Perform a transition, returning the destination phase.
 *
 * Throws rather than returning a result object on failure, because every caller
 * of a state transition is about to write it down: a caller that gets an error
 * stops, and a caller that got `null` might not.
 */
export function transition(request: TransitionRequest): TryoutPhase {
  const { from, to, context } = request;

  assertContext(context);

  if (!canTransition(from, to)) {
    const allowed = TRANSITIONS[from].to;
    throw new Error(
      `Illegal tryout transition ${from} -> ${to}. ` +
        (allowed.length === 0
          ? `${from} is a terminal phase and has no outgoing transitions.`
          : `Allowed from ${from}: ${allowed.join(", ")}.`),
    );
  }

  if (to === "rejected") {
    assertReason(context.reason);
  }

  if (from === "evaluated" && to === "selected") {
    assertSeparationOfDuties(context);
  }

  return to;
}

function assertContext(context: TransitionContext): void {
  if (context === null || typeof context !== "object") {
    throw new Error("Invalid context: a transition requires a context object");
  }
  if (typeof context.candidateId !== "string" || context.candidateId.trim() === "") {
    throw new Error("Invalid candidateId: a transition must name the candidate");
  }
  if (typeof context.actorId !== "string" || context.actorId.trim() === "") {
    throw new Error("Invalid actorId: a transition must name the actor");
  }
}

/**
 * Separation of duties on selection.
 *
 * The evaluator may not be the selector. This is the guard legacy did not have,
 * and it is checked against the recorded evaluator rather than a role, because a
 * role check asks "may this job do this" while the actual conflict is "may this
 * *person* decide on someone they scored".
 */
function assertSeparationOfDuties(context: TransitionContext): void {
  const evaluatedBy = context.evaluatedBy;

  if (evaluatedBy === undefined) {
    throw new Error(
      "Missing evaluatedBy: selecting a candidate requires the recorded evaluator, so separation of duties can be enforced",
    );
  }

  if (evaluatedBy === context.actorId) {
    throw new Error(
      `Separation of duties violated: ${context.actorId} evaluated candidate ${context.candidateId} and may not also select them`,
    );
  }
}

/**
 * A decision with no stated reason is not auditable.
 *
 * Rejection is the terminal decision a candidate is most likely to dispute, so
 * it is the one that must carry a reason. The reason is required, not merely
 * permitted, and an all-whitespace string does not count.
 */
function assertReason(reason: string | undefined): void {
  if (reason === undefined || reason.trim() === "") {
    throw new Error("Missing reason: a transition to rejected requires a stated reason");
  }
}