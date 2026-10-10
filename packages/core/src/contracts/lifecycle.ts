/**
 * Contract lifecycle: an explicit transition table and nothing else.
 *
 * A contract's lifecycle is a small state machine, and the legacy system had no
 * state machine — it had a status column that several unrelated handlers wrote
 * to, so the set of reachable statuses was whatever the last handler did. This
 * module makes the reachable set a table, and every other question about
 * lifecycle reduces to reading that table.
 *
 * ## Why a table rather than a switch inside a mutator
 *
 * `canTransition(from, to)` is pure and total: it consults the table, it never
 * writes anything, and it does not need a contract in hand. That means the same
 * question can be asked of a hypothetical pair in a test, in a UI that wants to
 * grey out a button, and in a server-side guard — and all three get the same
 * answer. A `setStatus()` that validates inside itself can only answer for the
 * contract it was handed.
 *
 * ## Irreversibility is derived, then pinned
 *
 * {@link isIrreversibleTransition} computes reversibility from the table — a
 * transition is irreversible exactly when its reverse edge does not exist. It is
 * computed rather than hand-listed so the two cannot drift, and the resulting set
 * is then *pinned by name* in {@link IRREVERSIBLE_TRANSITIONS} and asserted in
 * the test, so that adding a way back out of `terminated` has to be an argument
 * somebody makes rather than an accident.
 *
 * The load-bearing consequences:
 *
 * - **`pending_acceptance -> active` is irreversible.** A signed contract cannot
 *   be un-signed. It can be terminated or superseded, which are different legal
 *   events with their own records.
 * - **Every move into `withdrawn` is irreversible,** from `draft` or from
 *   `pending_acceptance` alike: `withdrawn` is terminal, so there is nowhere to
 *   return to.
 * - **`active -> terminated | expired | superseded` are irreversible.**
 * - **The drafting loop `draft -> pending_acceptance -> draft` is reversible.**
 *   Returned-for-rework is not a legal event; treating it as irreversible would
 *   mean every typo in a draft cost an entirely new contract.
 *
 * Which states exist and what they mean is a **product decision**, not a rule
 * recovered from the legacy source — ADR-0016 records that the legacy system had
 * no recoverable contract lifecycle at all.
 *
 * Pure: no database, no network, no clock. `at` is always supplied.
 */

/** Every state a contract can occupy. The closed set; nothing else is valid. */
export const CONTRACT_STATES = [
  "draft",
  "pending_acceptance",
  "active",
  "expired",
  "terminated",
  "withdrawn",
  "superseded",
] as const;

export type ContractState = (typeof CONTRACT_STATES)[number];

/**
 * The single source of truth for lifecycle movement.
 *
 * Written out rather than generated so that reading it is not a puzzle. The four
 * terminal states have empty lists on purpose: they are the irreversible end of
 * the machine, and a missing key would be indistinguishable from a typo.
 */
export const CONTRACT_TRANSITIONS: Readonly<Record<ContractState, readonly ContractState[]>> = Object.freeze({
  // `Object.freeze<T[]>` rather than a cast: the inner arrays must stay frozen so
  // no caller can add an edge to the machine after it has been read.
  draft: Object.freeze<ContractState[]>(["pending_acceptance", "withdrawn"]),
  // Back to `draft` is return-for-rework: the party asked for changes before signing.
  pending_acceptance: Object.freeze<ContractState[]>(["active", "draft", "withdrawn"]),
  active: Object.freeze<ContractState[]>(["expired", "terminated", "superseded"]),
  expired: Object.freeze<ContractState[]>([]),
  terminated: Object.freeze<ContractState[]>([]),
  withdrawn: Object.freeze<ContractState[]>([]),
  superseded: Object.freeze<ContractState[]>([]),
});

/**
 * The irreversible edges, named.
 *
 * Derived from {@link CONTRACT_TRANSITIONS} rather than maintained by hand, so
 * that the set and the table cannot disagree; pinned in the test so that
 * *widening* it cannot happen silently.
 */
export const IRREVERSIBLE_TRANSITIONS: readonly string[] = Object.freeze(
  CONTRACT_STATES.flatMap((from) =>
    CONTRACT_TRANSITIONS[from]
      .filter((to) => !CONTRACT_TRANSITIONS[to].includes(from))
      .map((to) => `${from}->${to}`),
  ),
);

function assertKnownState(state: string, position: "from" | "to"): ContractState {
  if (!(CONTRACT_STATES as readonly string[]).includes(state)) {
    throw new Error(
      `Unknown contract state ${JSON.stringify(state)} as ${position}; expected one of ${CONTRACT_STATES.join(", ")}. An unrecognised state is refused rather than treated as allowed, because defaulting it would make a typo into a permission.`,
    );
  }
  return state as ContractState;
}

/**
 * Whether the lifecycle allows `from -> to`.
 *
 * Both arguments are checked against the closed set first. Without that, a state
 * that is not in the table would fall through to "no outgoing transitions, so
 * false" for `from` — correct — but `to` being unknown would still be consulted
 * against a real row and could return `true`, i.e. `draft -> typo` would be
 * allowed. An unknown state is a bug, not a permitted value.
 */
export function canTransition(from: ContractState, to: ContractState): boolean {
  const knownFrom = assertKnownState(from, "from");
  const knownTo = assertKnownState(to, "to");
  return CONTRACT_TRANSITIONS[knownFrom].includes(knownTo);
}

/** The states reachable from `from`, frozen so a caller cannot sort the table away. */
export function nextStates(from: ContractState): readonly ContractState[] {
  const known = assertKnownState(from, "from");
  return Object.freeze([...CONTRACT_TRANSITIONS[known]]);
}

/** A state with no declared successors. Nothing moves on from here. */
export function isTerminalState(state: ContractState): boolean {
  return CONTRACT_TRANSITIONS[assertKnownState(state, "from")].length === 0;
}

/**
 * Whether `from -> to` can never be undone.
 *
 * True exactly when the reverse edge is absent from the table. Note this is a
 * statement about the machine, not about the world: `pending_acceptance ->
 * withdrawn` is irreversible here, while a contract can of course be *replaced*
 * by a brand new one. Irreversible means "there is no way back to where it was",
 * not "it cannot be succeeded by something else".
 */
export function isIrreversibleTransition(from: ContractState, to: ContractState): boolean {
  const knownFrom = assertKnownState(from, "from");
  const knownTo = assertKnownState(to, "to");
  if (!canTransition(knownFrom, knownTo)) return false;
  return !CONTRACT_TRANSITIONS[knownTo].includes(knownFrom);
}

/** {@link canTransition} as a throw, for the call sites that must not proceed. */
export function assertCanTransition(from: ContractState, to: ContractState): void {
  if (!canTransition(from, to)) {
    const allowed = CONTRACT_TRANSITIONS[assertKnownState(from, "from")];
    throw new Error(
      `Contract lifecycle does not allow ${from} -> ${to}. From ${from} the only permitted moves are ${
        allowed.length === 0 ? "(none: it is terminal)" : allowed.join(", ")
      }.`,
    );
  }
}

/**
 * One recorded lifecycle move.
 *
 * Append-only, like every other fact in this package. A lifecycle is derived by
 * replaying these; it is never updated in place, so "when did this contract stop
 * being active?" has an answer that does not depend on a mutable status column.
 */
export interface LifecycleTransition {
  readonly from: ContractState;
  readonly to: ContractState;
  readonly at: Date;
  readonly actorId: string;
  /** Why the move happened. Optional only for machine-driven moves such as expiry. */
  readonly reason?: string;
}

export interface TransitionContractInput {
  readonly from: ContractState;
  readonly to: ContractState;
  readonly at: Date;
  readonly actorId: string;
  readonly reason?: string;
}

/**
 * Record a lifecycle move, refusing one the table forbids.
 *
 * The returned record is frozen and the inputs are untouched: nothing here
 * mutates a contract, because this package has no contract object to mutate.
 */
export function transitionContract(input: TransitionContractInput): LifecycleTransition {
  assertCanTransition(input.from, input.to);

  if (input.actorId.trim() === "") {
    throw new Error(
      `Contract lifecycle move ${input.from} -> ${input.to} has no actorId; every lifecycle change is somebody's doing, and an unattributable change is not auditable`,
    );
  }
  if (Number.isNaN(input.at.getTime())) {
    throw new Error(`Contract lifecycle move ${input.from} -> ${input.to} has an invalid at`);
  }

  return Object.freeze({
    from: input.from,
    to: input.to,
    at: input.at,
    actorId: input.actorId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}