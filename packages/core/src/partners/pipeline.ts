/**
 * Partner pipeline: an explicit transition table, and nothing else.
 *
 * Six stages — `lead → qualified → negotiation → signed → active → lapsed` — and
 * a table of which moves are legal between them. `canTransition` is pure and
 * total: it consults the table and nothing else, so the same question can be
 * asked of a hypothetical pair in a test, in a UI that wants to grey out a
 * button, and in a server-side guard, and all three get the same answer.
 *
 * ## What legacy implemented, and what it did not
 *
 * The legacy repository had no CRM state machine. Commercial tracking lived in
 * free-text status columns that several unrelated handlers wrote to, so the set
 * of reachable statuses was whatever the last route that ran decided — including
 * moving a signed partner back to "negotiation" without a word of explanation.
 * Nothing here reproduces that; ADR-0016 records the absence of recoverable
 * commercial rules, and this table is **designed, not recovered**.
 *
 * ## Irreversibility is derived, then pinned
 *
 * {@link isIrreversibleTransition} computes reversibility from the table by
 * reachability: `from -> to` is irreversible exactly when `from` cannot be
 * reached again from `to`. That is the transitive-closure definition, rather
 * than the direct-edge one `contracts/lifecycle.ts` uses. On that table the two
 * agree; the transitive form is the one that stays correct when a machine
 * contains a path back through an intermediate state, which is what a pipeline
 * with a renegotiation loop is.
 *
 * The resulting set is then pinned by name in {@link IRREVERSIBLE_PARTNER_TRANSITIONS}
 * and asserted in the test, so *widening* it has to be an argument somebody makes.
 *
 * The load-bearing consequences:
 *
 * - **`negotiation -> signed` is irreversible.** A signed partner cannot go back
 *   to being negotiated with. `signed`, `active` and `lapsed` all hang real
 *   money and real obligations off that stage; rewinding one is not a correction,
 *   it is a rewrite.
 * - **The `qualified ↔ negotiation` loop is reversible, in both directions.** Terms
 *   fall apart and are renegotiated. Declaring only one direction would mean the
 *   second conversation could not be recorded at all.
 * - **`lead -> qualified` is irreversible.** Nobody is demoted back to a raw lead.
 * - **Every move into `lapsed` is irreversible**, from any live stage.
 *
 * Pure: no database, no network, no clock. `at` is always supplied.
 */

/** Every stage a partner can occupy. The closed set; nothing else is valid. */
export const PARTNER_STAGES = ["lead", "qualified", "negotiation", "signed", "active", "lapsed"] as const;

export type PartnerStage = (typeof PARTNER_STAGES)[number];

/**
 * The single source of truth for pipeline movement.
 *
 * `Record<PartnerStage, ...>` rather than a plain object: adding a stage to
 * {@link PARTNER_STAGES} without deciding its transitions is then a **compile
 * error**. That is the structural enforcement — the table cannot silently grow a
 * hole, and a hole would read as "this partner cannot go anywhere", which is the
 * safe direction to fail in but an expensive one to discover late.
 */
export const PARTNER_TRANSITIONS: Readonly<Record<PartnerStage, readonly PartnerStage[]>> = Object.freeze({
  lead: Object.freeze<PartnerStage[]>(["qualified", "lapsed"]),
  // Stepping back from `negotiation` is legal and symmetric. Modelling only the
  // forward edge would mean a deal whose terms collapsed could never re-enter
  // negotiation, which is the second conversation happening for real.
  qualified: Object.freeze<PartnerStage[]>(["negotiation", "lapsed"]),
  negotiation: Object.freeze<PartnerStage[]>(["signed", "qualified", "lapsed"]),
  // Forward only. Everything real — the contract, the obligations, the invoice —
  // hangs off `signed`, and this module refuses to pretend it did not happen.
  signed: Object.freeze<PartnerStage[]>(["active", "lapsed"]),
  active: Object.freeze<PartnerStage[]>(["lapsed"]),
  // Terminal: a lapsed partner has gone. Re-engaging is a new lead.
  lapsed: Object.freeze<PartnerStage[]>([]),
});

/**
 * The irreversible edges, named.
 *
 * Derived from {@link PARTNER_TRANSITIONS} by transitive reachability, then
 * pinned in the test. Derived so the set and the table cannot disagree; pinned so
 * that neither can change quietly.
 */
export const IRREVERSIBLE_PARTNER_TRANSITIONS: readonly string[] = Object.freeze(
  PARTNER_STAGES.flatMap((from) =>
    PARTNER_TRANSITIONS[from].filter((to) => !reachableFrom(to).has(from)).map((to) => `${from}->${to}`),
  ),
);

/**
 * Every stage reachable from `start`, including `start` itself.
 *
 * A worklist rather than a queue with `shift()` or a recursion with a `seen` set:
 * both of those need either a non-null assertion or a guard that can never fire,
 * and a branch that can never fire is a branch nobody has tested. The inner
 * `grew` loop terminates because a stage is only re-added when it was not
 * already reached, so the reachable set strictly grows and then stops — which is
 * what makes this safe on a table containing the `qualified ↔ negotiation` cycle.
 */
function reachableFrom(start: PartnerStage): ReadonlySet<PartnerStage> {
  const reached = new Set<PartnerStage>([start]);
  let grew = true;

  while (grew) {
    grew = false;
    const frontier = new Set<PartnerStage>();

    for (const stage of reached) {
      for (const next of PARTNER_TRANSITIONS[stage]) {
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

function assertKnownStage(stage: string, position: "from" | "to"): PartnerStage {
  if (!(PARTNER_STAGES as readonly string[]).includes(stage)) {
    throw new Error(
      `Unknown partner stage ${JSON.stringify(stage)} as ${position}; expected one of ${PARTNER_STAGES.join(", ")}. An unrecognised stage is refused rather than treated as allowed, because defaulting it would turn a typo into a permission.`,
    );
  }
  return stage as PartnerStage;
}

/**
 * Whether the pipeline allows `from -> to`.
 *
 * Both arguments are checked against the closed set first. Without that, an
 * unknown `to` would be consulted against a real row and could come back `true`
 * — that is, `lead -> typo` would be allowed.
 */
export function canTransition(from: PartnerStage, to: PartnerStage): boolean {
  const knownFrom = assertKnownStage(from, "from");
  const knownTo = assertKnownStage(to, "to");
  return PARTNER_TRANSITIONS[knownFrom].includes(knownTo);
}

/** The stages reachable from `from`, frozen so a caller cannot sort the table away. */
export function nextStages(from: PartnerStage): readonly PartnerStage[] {
  return Object.freeze([...PARTNER_TRANSITIONS[assertKnownStage(from, "from")]]);
}

/** A stage with no declared successors. Nothing moves on from here. */
export function isTerminalStage(stage: PartnerStage): boolean {
  return PARTNER_TRANSITIONS[assertKnownStage(stage, "from")].length === 0;
}

/**
 * Whether `from -> to` can never be undone.
 *
 * True exactly when `from` cannot be reached again from `to`. Note this is a
 * statement about the machine, not about the world: a partner can certainly sign
 * a *new* agreement after lapsing. Irreversible means "there is no way back to
 * where this was", not "it cannot be succeeded by something else".
 *
 * Returns `false` for an edge the table does not declare. An undeclared pair is
 * illegal, and labelling it "irreversible" would make "you may not do this" and
 * "you may do this once" indistinguishable in a report.
 */
export function isIrreversibleTransition(from: PartnerStage, to: PartnerStage): boolean {
  const knownFrom = assertKnownStage(from, "from");
  const knownTo = assertKnownStage(to, "to");
  if (!canTransition(knownFrom, knownTo)) return false;
  return !reachableFrom(knownTo).has(knownFrom);
}

/** {@link canTransition} as a throw, for the call sites that must not proceed. */
export function assertCanTransition(from: PartnerStage, to: PartnerStage): void {
  if (!canTransition(from, to)) {
    const allowed = PARTNER_TRANSITIONS[assertKnownStage(from, "from")];
    throw new Error(
      `Partner pipeline does not allow ${from} -> ${to}. From ${from} the only permitted moves are ${
        allowed.length === 0 ? "(none: it is terminal)" : allowed.join(", ")
      }.`,
    );
  }
}

/**
 * One recorded pipeline move.
 *
 * Append-only, like every other fact in this package. A partner's stage is
 * derived by replaying these; it is never updated in place, so "when did this
 * deal stop being negotiated?" has an answer that does not depend on a mutable
 * status column.
 */
export interface PartnerTransition {
  readonly partnerId: string;
  readonly from: PartnerStage;
  readonly to: PartnerStage;
  readonly at: Date;
  readonly actorId: string;
  readonly reason?: string;
}

export interface TransitionPartnerInput {
  readonly partnerId: string;
  readonly from: PartnerStage;
  readonly to: PartnerStage;
  /** Injected clock. Required, never defaulted — see the module comment. */
  readonly at: Date;
  readonly actorId: string;
  readonly reason?: string;
}

/**
 * Moves that close a relationship, and so must say why.
 *
 * `signed` and `lapsed` are the two a partner is most likely to dispute months
 * later — one says money is owed, the other says it is not. A decision recorded
 * with no reason is not an answer to either question.
 */
const REASON_REQUIRED: ReadonlySet<PartnerStage> = new Set<PartnerStage>(["signed", "lapsed"]);

/**
 * Record a pipeline move, refusing one the table forbids.
 *
 * The returned record is frozen and the inputs are untouched: nothing here mutates
 * a partner, because this package has no partner object to mutate.
 */
export function transitionPartner(input: TransitionPartnerInput): PartnerTransition {
  assertCanTransition(input.from, input.to);

  if (input.partnerId.trim() === "") {
    throw new Error(`Partner pipeline move ${input.from} -> ${input.to} names no partnerId`);
  }
  if (typeof input.actorId !== "string" || input.actorId.trim() === "") {
    throw new Error(
      `Partner pipeline move ${input.from} -> ${input.to} for ${input.partnerId} has a blank actorId; every pipeline change is somebody's doing, and an unattributable change is not auditable`,
    );
  }
  if (input.at === null || input.at === undefined || Number.isNaN(input.at.getTime())) {
    throw new Error(`Partner pipeline move ${input.from} -> ${input.to} for ${input.partnerId} has an invalid at`);
  }
  if (REASON_REQUIRED.has(input.to) && (input.reason === undefined || input.reason.trim() === "")) {
    throw new Error(
      `Partner pipeline move ${input.from} -> ${input.to} for ${input.partnerId} states no reason. This move closes a relationship, and it is the one a partner is most likely to dispute.`,
    );
  }

  return Object.freeze({
    partnerId: input.partnerId,
    from: input.from,
    to: input.to,
    at: input.at,
    actorId: input.actorId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}