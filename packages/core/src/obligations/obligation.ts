/**
 * Obligations: a promise with parts, and nothing else.
 *
 * An obligation is what an organisation *promised* — "four streams, two social
 * posts, appear at the final". Each promise is split into discrete
 * {@link ObligationPart}s, each with its own kind, its own promised quantity and
 * its own due date, because a promise that can only be satisfied all at once can
 * only be satisfied in the one way that satisfies none of it.
 *
 * ## This type deliberately has no "fulfilled" flag
 *
 * There is no `fulfilled: boolean` here, no `status`, no `completedAt`, and
 * nothing on a part either. That absence is the point, and it is the defect this
 * package exists to prevent: an organisation marks a sponsorship fulfilled with
 * nothing behind it, because the record that says "fulfilled" is a single boolean
 * that somebody clicked and nothing has to agree with.
 *
 * A stored flag drifts from the evidence by construction — it is written by a
 * different code path from the one that records evidence, it is never re-derived,
 * and there is no moment at which the two are compared. Making it structurally
 * impossible to *read* such a flag from an {@link Obligation} is stronger than a
 * convention against it: `isObligationDischarged(obligation, evidence)` takes the
 * parts and the evidence and computes. Someone's claim that it was discharged
 * lives in a separate record (`ObligationDischargeClaim` in `./discharge.js`)
 * that this function is not given, and `compareDischargeClaim` is what reports
 * the drift between the two.
 *
 * ## Kinds are closed, and that is load-bearing
 *
 * {@link OBLIGATION_PART_KINDS} is a closed union rather than free text. Evidence
 * carries the kind it evidences, and only evidence of the same kind counts towards
 * a part — so a photograph of a Discord message cannot discharge four promised
 * live streams. A free-text kind would make that check vacuous, and a kind with a
 * `"catch_all"` member would make it worse than not having the check at all.
 *
 * **Product decision, not a recovered rule.** The legacy system had no obligation
 * concept at all (ADR-0016 records the absence of recoverable commercial rules),
 * so the part kinds, the granularity and the one-part-per-deliverable shape are
 * designed here. Nothing in this file claims to reproduce legacy behaviour.
 *
 * Pure: no database, no network, no clock. Every instant here is data supplied by
 * the caller.
 */

import { OBLIGATION_PART_KINDS } from "./part-kind.js";
import type { ObligationPartKind } from "./part-kind.js";

export { OBLIGATION_PART_KINDS };
export type { ObligationPartKind };

/**
 * One promised deliverable.
 *
 * `promisedQuantity` is an integer of *instances*, not a fraction and not a
 * monetary amount. "Appear at the final" is one; "four co-streams" is four. A
 * fractional quantity would make "3.5 of 4 delivered" a question, and the answer
 * would be a rounding rule — which is a checkbox with extra steps.
 */
export interface ObligationPart {
  readonly partId: string;
  readonly kind: ObligationPartKind;
  readonly promisedQuantity: number;
  /** When this part was due. Validated, never defaulted to "no deadline". */
  readonly dueAt: Date;
  readonly description: string;
}

/**
 * A promise made to a partner under a specific contract version.
 *
 * `contractVersionId` names the immutable document this promise was read out of,
 * for the same reason acceptance names a content hash in `./contracts`: "what did
 * they actually agree to" is only answerable against a version.
 */
export interface Obligation {
  readonly obligationId: string;
  readonly organizationId: string;
  readonly partnerId: string;
  readonly contractVersionId: string;
  readonly title: string;
  /** Ordered as written. Part order carries meaning, so it is never sorted away. */
  readonly parts: readonly ObligationPart[];
}

export interface CreateObligationInput {
  readonly obligationId: string;
  readonly organizationId: string;
  readonly partnerId: string;
  readonly contractVersionId: string;
  readonly title: string;
  readonly parts: readonly ObligationPart[];
}

/**
 * Validate and deep-freeze an obligation.
 *
 * Refuses, in order: a blank identity, a blank title, no parts, a part with an
 * off-vocabulary kind, a non-positive or fractional promised quantity, an invalid
 * due date, a blank description, and a repeated part id.
 *
 * The duplicate check is not cosmetic: a report that says "post 1 of 2 met, post
 * 2 of 2 not met" is only possible if the two posts are distinguishable, and a
 * repeated `partId` makes a single obligation answer two questions.
 */
export function createObligation(input: CreateObligationInput): Obligation {
  if (input.obligationId.trim() === "") {
    throw new Error("Obligation must carry a non-empty obligationId: a promise nobody can name cannot be proved");
  }
  if (input.organizationId.trim() === "") {
    throw new Error(
      `Obligation ${input.obligationId} has a blank organizationId; every query in this package is tenant-scoped, and an unscoped obligation would answer across organisations (ADR-0011)`,
    );
  }
  if (input.partnerId.trim() === "") {
    throw new Error(`Obligation ${input.obligationId} names no partnerId: a promise to nobody discharges nothing`);
  }
  if (input.contractVersionId.trim() === "") {
    throw new Error(
      `Obligation ${input.obligationId} names no contractVersionId; "what was promised" is only answerable against an immutable version of the agreement`,
    );
  }
  if (input.title.trim() === "") {
    throw new Error(`Obligation ${input.obligationId} has a blank title`);
  }
  if (input.parts.length === 0) {
    throw new Error(
      `Obligation ${input.obligationId} has no parts. A promise with nothing in it is discharged the moment it is created, which is the defect this package exists to prevent.`,
    );
  }

  const seen = new Set<string>();
  const parts = input.parts.map((part) => {
    if (part.partId.trim() === "") {
      throw new Error(`Obligation ${input.obligationId} has a part with a blank partId`);
    }
    if (seen.has(part.partId)) {
      throw new Error(
        `Obligation ${input.obligationId} lists part ${part.partId} twice. A repeated part id makes the per-part discharge report ambiguous: the two parts would be counted together and reported as one.`,
      );
    }
    seen.add(part.partId);

    if (!isKnownKind(part.kind)) {
      throw new Error(
        `Obligation ${input.obligationId} part ${part.partId} has unknown kind ${JSON.stringify(part.kind)}; expected one of ${OBLIGATION_PART_KINDS.join(", ")}. An off-vocabulary kind would let any evidence discharge any part, which is a checkbox rather than a fulfilment check.`,
      );
    }
    if (!Number.isSafeInteger(part.promisedQuantity) || part.promisedQuantity < 1) {
      throw new Error(
        `Obligation ${input.obligationId} part ${part.partId} promises ${String(part.promisedQuantity)}: promisedQuantity must be a positive integer. A promise of zero of something is not a promise, and a fractional one would need a rounding rule to judge.`,
      );
    }
    if (part.dueAt === null || part.dueAt === undefined || Number.isNaN(part.dueAt.getTime())) {
      throw new Error(`Obligation ${input.obligationId} part ${part.partId} has no usable dueAt`);
    }
    if (part.description.trim() === "") {
      throw new Error(
        `Obligation ${input.obligationId} part ${part.partId} has a blank description; a deliverable nobody could identify is a deliverable nobody can check`,
      );
    }

    return Object.freeze({
      partId: part.partId,
      kind: part.kind,
      promisedQuantity: part.promisedQuantity,
      dueAt: part.dueAt,
      description: part.description,
    });
  });

  return Object.freeze({
    obligationId: input.obligationId,
    organizationId: input.organizationId,
    partnerId: input.partnerId,
    contractVersionId: input.contractVersionId,
    title: input.title,
    parts: Object.freeze(parts),
  });
}

/**
 * Closed-set membership test.
 *
 * `as readonly string[]` rather than a cast: the compiler cannot narrow an
 * arbitrary string through `includes`, and this is the one place where a value
 * that arrived from outside the type system is admitted.
 */
export function isKnownKind(kind: string): kind is ObligationPartKind {
  return (OBLIGATION_PART_KINDS as readonly string[]).includes(kind);
}