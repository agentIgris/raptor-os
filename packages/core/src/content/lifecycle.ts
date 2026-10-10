/**
 * Content lifecycle: draft → review → approved → scheduled → published → archived.
 *
 * The same shape as `./contracts/lifecycle.ts` and `./partners/pipeline.ts`: an
 * explicit table, a pure `canTransition`, and no other way to move.
 *
 * ## Irreversibility is computed by *reachability*, not by a direct edge
 *
 * This module uses the transitive-closure rule rather than the direct-edge rule
 * `contracts/lifecycle.ts` uses, and the difference matters here in a way it does
 * not there. A direct-edge test would ask "does `approved → draft` have a
 * reverse edge in the table?" and answer no — so it would call un-approving
 * *irreversible*, which is absurd: an approved item is routinely pulled back for
 * another round of edits.
 *
 * The right question is "can the pipeline get back to `approved` at all?", and
 * from `draft` it can: `draft → review → approved`. Reachability gives the
 * correct answer, and the pinned set that falls out is exactly the two things
 * that should be one-way doors:
 *
 * - **`scheduled → published`** — content cannot be un-published. The audience has
 *   seen it.
 * - **`published → archived`** and **`draft → archived`** — an archived item is
 *   archived for good. Un-archiving is a new content item, not a resurrection.
 *
 * The review loop and the unschedule step both stay reversible, which is why
 * neither appears.
 *
 * ## Publication is a scheduled act
 *
 * There is no `approved → published` edge. Publishing requires a named instant
 * set in advance (see `./scheduling.ts`), which is what makes "when did this go
 * live?" answerable from a record rather than from a column somebody updated
 * when they remembered.
 *
 * **Product decision, not a recovered rule.** The legacy repository had no
 * content pipeline; what it had was free-text status columns written by
 * unrelated handlers. The six states, their names and the edges between them are
 * designed here.
 *
 * Pure: no database, no network, no clock. `at` is always supplied.
 */

/** Every state a content item can occupy. The closed set; nothing else is valid. */
export const CONTENT_STATES = ["draft", "review", "approved", "scheduled", "published", "archived"] as const;

export type ContentState = (typeof CONTENT_STATES)[number];

/**
 * The single source of truth for editorial movement.
 *
 * `Record<ContentState, ...>` rather than a plain object: adding a state to
 * {@link CONTENT_STATES} without deciding its transitions is then a **compile
 * error**. The table cannot silently grow a hole, and a hole would read as "this
 * content can go nowhere", which is the safe direction to fail in but an
 * expensive one to discover once it is in production.
 */
export const CONTENT_TRANSITIONS: Readonly<Record<ContentState, readonly ContentState[]>> = Object.freeze({
  draft: Object.freeze<ContentState[]>(["review", "archived"]),
  // Return-for-edits. `review -> draft` is the reviewer sending it back, and it
  // is the same event as `draft -> review` seen from the other side.
  review: Object.freeze<ContentState[]>(["approved", "draft"]),
  // Back to draft as well as forward to scheduled: an item approved and then
  // found wanting is a normal occurrence, and forcing a whole new item to record
  // it would make the real history unreadable.
  approved: Object.freeze<ContentState[]>(["scheduled", "draft"]),
  // Unscheduling returns to `approved`, not to `review`. The work was reviewed
  // and stays reviewed; only the publication plan changed.
  scheduled: Object.freeze<ContentState[]>(["published", "approved"]),
  // Forward only. There is no edge back to `scheduled` or `approved`, and no edge
  // to `draft`: retracting a published claim is a new statement, not an edit to
  // the old one.
  published: Object.freeze<ContentState[]>(["archived"]),
  // Terminal.
  archived: Object.freeze<ContentState[]>([]),
});

/**
 * The irreversible edges, named.
 *
 * Derived from {@link CONTENT_TRANSITIONS} by reachability, then pinned in the
 * test. Derived so the set and the table cannot disagree; pinned so that neither
 * can change quietly.
 */
export const IRREVERSIBLE_CONTENT_TRANSITIONS: readonly string[] = Object.freeze(
  CONTENT_STATES.flatMap((from) =>
    CONTENT_TRANSITIONS[from].filter((to) => !reachableFrom(to).has(from)).map((to) => `${from}->${to}`),
  ),
);

/**
 * Every state reachable from `start`, including `start` itself.
 *
 * A worklist rather than a queue with `shift()` or a recursion with a `seen` set:
 * both of those need either a non-null assertion or a guard that can never fire,
 * and a branch that can never fire is a branch nobody has tested. The inner
 * `grew` loop terminates because a state is only re-added when it was not already
 * reached, so the reachable set strictly grows and then stops — which is what
 * makes this safe on a table containing the `draft ↔ review` cycle.
 */
function reachableFrom(start: ContentState): ReadonlySet<ContentState> {
  const reached = new Set<ContentState>([start]);
  let grew = true;

  while (grew) {
    grew = false;
    const frontier = new Set<ContentState>();

    for (const state of reached) {
      for (const next of CONTENT_TRANSITIONS[state]) {
        if (!reached.has(next)) frontier.add(next);
      }
    }
    for (const next of frontier) {
      reached.add(next);
      grew = true;
    }
  }

  return reached;
}

function assertKnownState(state: string, position: "from" | "to"): ContentState {
  if (!(CONTENT_STATES as readonly string[]).includes(state)) {
    throw new Error(
      `Unknown content state ${JSON.stringify(state)} as ${position}; expected one of ${CONTENT_STATES.join(", ")}. An unrecognised state is refused rather than treated as allowed, because defaulting it would turn a typo into a permission.`,
    );
  }
  return state as ContentState;
}

/**
 * Whether the lifecycle allows `from -> to`.
 *
 * Both arguments are checked against the closed set first. Without that, an
 * unknown `to` would be consulted against a real row and could come back `true` —
 * that is, `draft -> typo` would be allowed.
 */
export function canTransition(from: ContentState, to: ContentState): boolean {
  const knownFrom = assertKnownState(from, "from");
  const knownTo = assertKnownState(to, "to");
  return CONTENT_TRANSITIONS[knownFrom].includes(knownTo);
}

/** The states reachable from `from`, frozen so a caller cannot sort the table away. */
export function nextStates(from: ContentState): readonly ContentState[] {
  return Object.freeze([...CONTENT_TRANSITIONS[assertKnownState(from, "from")]]);
}

/** A state with no declared successors. Nothing moves on from here. */
export function isTerminalState(state: ContentState): boolean {
  return CONTENT_TRANSITIONS[assertKnownState(state, "from")].length === 0;
}

/**
 * Whether `from -> to` can never be undone.
 *
 * True exactly when `from` cannot be reached again from `to`. See the module note
 * for why reachability is the right test here and a direct reverse edge is not.
 *
 * Returns `false` for an edge the table does not declare. An undeclared pair is
 * illegal, and labelling it "irreversible" would make "you may not do this" and
 * "you may do this once" indistinguishable in a report.
 */
export function isIrreversibleTransition(from: ContentState, to: ContentState): boolean {
  const knownFrom = assertKnownState(from, "from");
  const knownTo = assertKnownState(to, "to");
  if (!canTransition(knownFrom, knownTo)) return false;
  return !reachableFrom(knownTo).has(knownFrom);
}

/** {@link canTransition} as a throw, for the call sites that must not proceed. */
export function assertCanTransition(from: ContentState, to: ContentState): void {
  if (!canTransition(from, to)) {
    const allowed = CONTENT_TRANSITIONS[assertKnownState(from, "from")];
    throw new Error(
      `Content lifecycle does not allow ${from} -> ${to}. From ${from} the only permitted moves are ${
        allowed.length === 0 ? "(none: it is terminal)" : allowed.join(", ")
      }.`,
    );
  }
}

/**
 * One recorded editorial move. Append-only, like every other fact in this package.
 */
export interface ContentTransition {
  readonly contentId: string;
  readonly from: ContentState;
  readonly to: ContentState;
  readonly at: Date;
  readonly actorId: string;
  readonly reason?: string;
}

export interface TransitionContentInput {
  readonly contentId: string;
  readonly from: ContentState;
  readonly to: ContentState;
  /** Injected clock. Required, never defaulted — see the module comment. */
  readonly at: Date;
  readonly actorId: string;
  readonly reason?: string;
}

/**
 * Destinations that undo somebody's work, and so must say why.
 *
 * Keyed on the **destination** rather than the edge: every move into `draft` is
 * a return-for-edits and every move into `archived` is a removal, whether it came
 * from `review`, `approved` or `published`. Sending a creator's piece back and
 * archiving what they wrote are the two decisions a creator disputes, and "we
 * archived it" with no reason is not an answer to "why was my post pulled?".
 */
const REASON_REQUIRED: ReadonlySet<ContentState> = new Set<ContentState>(["draft", "archived"]);

/**
 * Record an editorial move, refusing one the table forbids.
 *
 * Note that this records *state* only. It does not enforce separation of duties
 * or validate a schedule — those need facts this signature does not take, and a
 * guard that silently ignored its inputs would be worse than no guard. Use
 * `./approval.js` and `./scheduling.ts` for those.
 */
export function transitionContent(input: TransitionContentInput): ContentTransition {
  assertCanTransition(input.from, input.to);

  if (input.contentId.trim() === "") {
    throw new Error(`Content lifecycle move ${input.from} -> ${input.to} names no contentId`);
  }
  if (typeof input.actorId !== "string" || input.actorId.trim() === "") {
    throw new Error(
      `Content lifecycle move ${input.from} -> ${input.to} for ${input.contentId} has a blank actorId; every editorial change is somebody's doing, and an unattributable change is not auditable`,
    );
  }
  if (input.at === null || input.at === undefined || Number.isNaN(input.at.getTime())) {
    throw new Error(`Content lifecycle move ${input.from} -> ${input.to} for ${input.contentId} has an invalid at`);
  }
  if (REASON_REQUIRED.has(input.to) && (input.reason === undefined || input.reason.trim() === "")) {
    throw new Error(
      `Content lifecycle move ${input.from} -> ${input.to} for ${input.contentId} states no reason. Moving into ${input.to} undoes somebody's work, and it is the decision a creator most often disputes.`,
    );
  }

  return Object.freeze({
    contentId: input.contentId,
    from: input.from,
    to: input.to,
    at: input.at,
    actorId: input.actorId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}