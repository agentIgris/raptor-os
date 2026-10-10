/**
 * Invoice lifecycle: `draft → issued → paid → overdue → void`, as a table.
 *
 * ## `paid` is terminal, and that is the decision worth arguing about
 *
 * An invoice that has been paid cannot be voided. The reasoning is that voiding
 * asserts *"this was never owed"*, and a payment is in the ledger naming this
 * invoice — so a void that contradicts a payment is a record asserting two
 * incompatible facts about the same money. Voiding it would not make the
 * discrepancy go away; it would make it untraceable.
 *
 * The correction path is a **credit note**: a new document, referencing this one,
 * for a new amount. This package deliberately does not model credit notes, and
 * that absence is the honest answer — modelling one is a product decision about
 * how an organisation settles a billing mistake, and it has not been taken.
 * Leaving a hole here is better than inventing a rule.
 *
 * ## Going overdue is irreversible
 *
 * There is no `overdue → issued`. Paying an overdue invoice does not make it have
 * been paid on time, and the record of lateness is not the same fact as the
 * record of issuance. Both are true at once and both are kept.
 *
 * ## Irreversibility by reachability, as in `./content/lifecycle.ts`
 *
 * Computed transitively rather than by a direct reverse edge, and pinned by name
 * in the tests. On this table both definitions agree; the transitive form is the
 * one that stays correct when a machine contains a loop back through an
 * intermediate state.
 *
 * **Product decision, not a recovered rule.** ADR-0016 records that the legacy
 * repository had no invoice lifecycle — status columns, no terminality, and the
 * slot-expense double-billing defect where one purchase produced two rows. The
 * five states and the edges between them are designed here.
 *
 * Pure: no database, no network, no clock. `at` is always supplied.
 */

/** Every state an invoice can occupy. The closed set; nothing else is valid. */
export const INVOICE_STATES = ["draft", "issued", "paid", "overdue", "void"] as const;

export type InvoiceState = (typeof INVOICE_STATES)[number];

/**
 * The single source of truth for invoice movement.
 *
 * `Record<InvoiceState, ...>` rather than a plain object: adding a state to
 * {@link INVOICE_STATES} without deciding its transitions is then a **compile
 * error**.
 */
export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceState, readonly InvoiceState[]>> = Object.freeze({
  draft: Object.freeze<InvoiceState[]>(["issued", "void"]),
  issued: Object.freeze<InvoiceState[]>(["paid", "overdue", "void"]),
  // Terminal. See the module note: voiding a paid invoice would contradict a
  // payment that is in the ledger naming it.
  paid: Object.freeze<InvoiceState[]>([]),
  // No edge back to `issued`: paying late does not make the invoice timely.
  overdue: Object.freeze<InvoiceState[]>(["paid", "void"]),
  // Terminal, and every edge into it is irreversible.
  void: Object.freeze<InvoiceState[]>([]),
});

/**
 * The irreversible edges, named.
 *
 * Derived from {@link INVOICE_TRANSITIONS} by reachability, then pinned in the
 * test.
 */
export const IRREVERSIBLE_INVOICE_TRANSITIONS: readonly string[] = Object.freeze(
  INVOICE_STATES.flatMap((from) =>
    INVOICE_TRANSITIONS[from].filter((to) => !reachableFrom(to).has(from)).map((to) => `${from}->${to}`),
  ),
);

/**
 * Every state reachable from `start`, including `start` itself.
 *
 * A worklist rather than a queue with `shift()` or a recursion with a `seen` set:
 * both of those need either a non-null assertion or a guard that can never fire
 * on this table, and a branch that can never fire is a branch nobody has tested.
 * The inner `grew` loop terminates because a state is only re-added when it was
 * not already reached, so the reachable set strictly grows and then stops.
 */
function reachableFrom(start: InvoiceState): ReadonlySet<InvoiceState> {
  const reached = new Set<InvoiceState>([start]);
  let grew = true;

  while (grew) {
    grew = false;
    const frontier = new Set<InvoiceState>();

    for (const state of reached) {
      for (const next of INVOICE_TRANSITIONS[state]) {
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

function assertKnownState(state: string, position: "from" | "to"): InvoiceState {
  if (!(INVOICE_STATES as readonly string[]).includes(state)) {
    throw new Error(
      `Unknown invoice state ${JSON.stringify(state)} as ${position}; expected one of ${INVOICE_STATES.join(", ")}. An unrecognised state is refused rather than treated as allowed, because defaulting it would turn a typo into a permission.`,
    );
  }
  return state as InvoiceState;
}

/** Whether the lifecycle allows `from -> to`. */
export function canTransition(from: InvoiceState, to: InvoiceState): boolean {
  const knownFrom = assertKnownState(from, "from");
  const knownTo = assertKnownState(to, "to");
  return INVOICE_TRANSITIONS[knownFrom].includes(knownTo);
}

/** The states reachable from `from`, frozen so a caller cannot sort the table away. */
export function nextStates(from: InvoiceState): readonly InvoiceState[] {
  return Object.freeze([...INVOICE_TRANSITIONS[assertKnownState(from, "from")]]);
}

/** A state with no declared successors. Nothing moves on from here. */
export function isTerminalState(state: InvoiceState): boolean {
  return INVOICE_TRANSITIONS[assertKnownState(state, "from")].length === 0;
}

/**
 * Whether a state means "this invoice was never owed".
 *
 * Separate from {@link isTerminalState} because the two answer different
 * questions: `void` and `paid` are both terminal, and only one of them says the
 * obligation did not exist. A caller filtering out "invoices we are not chasing"
 * needs this one.
 */
export function isVoid(state: InvoiceState): boolean {
  return assertKnownState(state, "from") === "void";
}

/**
 * Whether `from -> to` can never be undone.
 *
 * True exactly when `from` cannot be reached again from `to`. Returns `false`
 * for an undeclared edge: an undeclared pair is illegal, and labelling it
 * "irreversible" would make "you may not do this" and "you may do this once"
 * indistinguishable in a report.
 */
export function isIrreversibleTransition(from: InvoiceState, to: InvoiceState): boolean {
  const knownFrom = assertKnownState(from, "from");
  const knownTo = assertKnownState(to, "to");
  if (!canTransition(knownFrom, knownTo)) return false;
  return !reachableFrom(knownTo).has(knownFrom);
}

/** {@link canTransition} as a throw, for the call sites that must not proceed. */
export function assertCanTransition(from: InvoiceState, to: InvoiceState): void {
  if (!canTransition(from, to)) {
    const allowed = INVOICE_TRANSITIONS[assertKnownState(from, "from")];
    throw new Error(
      `Invoice lifecycle does not allow ${from} -> ${to}. From ${from} the only permitted moves are ${
        allowed.length === 0 ? "(none: it is terminal)" : allowed.join(", ")
      }.`,
    );
  }
}

/** One recorded invoice state change. Append-only, like every other fact here. */
export interface InvoiceTransition {
  readonly invoiceId: string;
  readonly from: InvoiceState;
  readonly to: InvoiceState;
  readonly at: Date;
  readonly actorId: string;
  readonly reason?: string;
}

export interface TransitionInvoiceInput {
  readonly invoiceId: string;
  readonly from: InvoiceState;
  readonly to: InvoiceState;
  /** Injected clock. Required, never defaulted — see the module comment. */
  readonly at: Date;
  readonly actorId: string;
  readonly reason?: string;
}

/**
 * Destinations that need a stated reason.
 *
 * `void` asserts the obligation did not exist and `overdue` asserts a promise
 * was broken — both are things a partner disputes, and both need an answer.
 * Marking an invoice `paid` does not: payment is evidenced by the payment
 * record in the ledger, and a required reason here would be a field nobody fills
 * in.
 */
const REASON_REQUIRED: ReadonlySet<InvoiceState> = new Set<InvoiceState>(["void", "overdue"]);

/**
 * Record a state change, refusing one the table forbids.
 *
 * Returns a frozen record and mutates nothing: this package has no invoice object
 * to mutate, and the invoice's state is derived by replaying these records — the
 * same decision as `Obligation` carrying no `fulfilled` flag.
 */
export function transitionInvoice(input: TransitionInvoiceInput): InvoiceTransition {
  assertCanTransition(input.from, input.to);

  if (input.invoiceId.trim() === "") {
    throw new Error(`Invoice lifecycle move ${input.from} -> ${input.to} names no invoiceId`);
  }
  if (typeof input.actorId !== "string" || input.actorId.trim() === "") {
    throw new Error(
      `Invoice lifecycle move ${input.from} -> ${input.to} for ${input.invoiceId} has a blank actorId; every billing change is somebody's doing, and an unattributable change is not auditable`,
    );
  }
  if (input.at === null || input.at === undefined || Number.isNaN(input.at.getTime())) {
    throw new Error(`Invoice lifecycle move ${input.from} -> ${input.to} for ${input.invoiceId} has an invalid at`);
  }
  if (REASON_REQUIRED.has(input.to) && (input.reason === undefined || input.reason.trim() === "")) {
    throw new Error(
      `Invoice lifecycle move ${input.from} -> ${input.to} for ${input.invoiceId} states no reason. Moving an invoice to ${input.to} is a statement about money that is owed or not owed, and it is the statement a partner most often disputes.`,
    );
  }

  return Object.freeze({
    invoiceId: input.invoiceId,
    from: input.from,
    to: input.to,
    at: input.at,
    actorId: input.actorId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}