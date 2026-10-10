/**
 * Amendment: a correction is a new version, never an edit.
 *
 * This is the structural half of the acceptance proof. It is easy to *claim*
 * that contracts are immutable and easy to write the mutator anyway six months
 * later, so here the claim is made structurally: {@link amendContract} takes a
 * version and returns a **different** version. There is no function anywhere in
 * this package that writes to a {@link ContractVersion}, and every value it
 * returns is `Object.freeze`d.
 *
 * ## What an amendment carries forward
 *
 * Everything the caller does not restate is inherited from the predecessor:
 * contract id, organisation, title, and any field the amendment leaves out. An
 * amendment restates only what it changes. That keeps the correction honest —
 * if an amendment silently dropped a clause list, version N+1 would be a different
 * document that still claimed to be a correction of version N.
 *
 * ## Why version and supersession are inside the hashed content
 *
 * An amendment that changes no prose at all — a reissue for the record, a
 * countersignature — still gets a different content hash, because the version
 * number and the supersession link are part of what is hashed. That is what makes
 * "this signature is for version 2" a checkable statement rather than a
 * convention. A hash that an amendment could reproduce would prove nothing about
 * *which* document was accepted.
 *
 * {@link amendmentChain} walks the supersession links back to the original. It
 * rejects a fork rather than picking a branch: two different amendments of the
 * same version means the history is ambiguous, and "which version is current"
 * must never be a coin toss.
 *
 * Pure: no database, no network, no clock. `at` is always supplied.
 */

import type { ContractClause, ContractVersion } from "./version.js";
import { createContractVersion } from "./version.js";

/**
 * The record that one version was produced by amending another.
 *
 * Separate from both versions, because the *relationship* is itself a fact worth
 * keeping: who amended what, when, and why. Reading `supersedesVersionId` off
 * the new version gives the same link, but not the actor or the reason.
 */
export interface Amendment {
  readonly previousVersionId: string;
  readonly amendmentVersionId: string;
  readonly at: Date;
  readonly actorId: string;
  readonly reason: string;
}

export interface AmendContractInput {
  /** The version being corrected. Never modified. */
  readonly previous: ContractVersion;
  /** Id for the *new* version. Must differ from `previous.versionId`. */
  readonly versionId: string;
  readonly body: string;
  /** Restated clauses; omitted means "carried forward unchanged". */
  readonly clauses?: readonly ContractClause[];
  /** Restated effective date; omitted means "carried forward unchanged". */
  readonly effectiveFrom?: Date;
  readonly at: Date;
  readonly actorId: string;
  /**
   * Why this correction is being made. Required, not optional: an unexplained
   * correction is precisely what an auditor is looking for, and a default reason
   * string is a way of never having to supply one.
   */
  readonly reason: string;
}

/**
 * Produce the next version of a contract.
 *
 * The predecessor is read, never written. The returned version is frozen, is a
 * distinct object, carries `previous.version + 1` and `supersedesVersionId =
 * previous.versionId`, and is hashed over its own content — including those two
 * fields, so it can never hash-equal what it amends.
 */
export function amendContract(input: AmendContractInput): ContractVersion {
  const { previous } = input;

  if (input.reason.trim() === "") {
    throw new Error(
      `Amendment of ${previous.versionId} carries no reason; a correction nobody can state the reason for is indistinguishable from tampering`,
    );
  }
  if (input.actorId.trim() === "") {
    throw new Error(`Amendment of ${previous.versionId} has no actorId; corrections are attributable or they are not corrections`);
  }
  if (Number.isNaN(input.at.getTime())) {
    throw new Error(`Amendment of ${previous.versionId} has an invalid at`);
  }
  if (input.versionId === previous.versionId) {
    throw new Error(
      `Amendment of ${previous.versionId} reuses the same versionId; an amendment is a new version, and reusing the id would overwrite the row it is correcting`,
    );
  }

  return createContractVersion({
    versionId: input.versionId,
    content: {
      contractId: previous.contractId,
      organizationId: previous.organizationId,
      version: previous.version + 1,
      title: previous.title,
      body: input.body,
      clauses: input.clauses === undefined ? previous.clauses : input.clauses,
      effectiveFrom: input.effectiveFrom ?? previous.effectiveFrom,
      expiresAt: previous.expiresAt,
      supersedesVersionId: previous.versionId,
    },
  });
}

/** Whether `candidate` was produced by amending `ancestor`. */
export function isAmendedFrom(candidate: ContractVersion, ancestor: ContractVersion): boolean {
  return candidate.supersedesVersionId === ancestor.versionId;
}

/**
 * The supersession chain ending at `versionId`, oldest first.
 *
 * Walks *backwards* from the given version through `supersedesVersionId`, keyed
 * on `amendmentVersionId`, so the caller may supply the amendment records in any
 * order. Records that are byte-identical duplicates are tolerated — a re-imported
 * history is not a corrupt one — but every genuine ambiguity is refused rather
 * than papered over:
 *
 * - A **fork** — one version amended into two different successors. Picking one
 *   would make "the current version of this contract" depend on row order, which
 *   is the exact class of ambiguity ADR-0016 lists as a legacy defect.
 * - A **merge** — one version recorded as amending two different predecessors,
 *   which leaves it unsaid which content it replaced.
 * - A **cycle** — including a version recorded as amended into itself, which
 *   would otherwise loop forever.
 *
 * Both ambiguity checks run over the *whole* supplied record set before the walk,
 * not just the part reachable from `versionId`: a fork anywhere in the history
 * makes the whole history untrustworthy, and silently ignoring a fork that
 * happens to sit off the path would be a reassuring lie.
 */
export function amendmentChain(versionId: string, amendments: readonly Amendment[]): readonly string[] {
  const byAmended = new Map<string, Amendment>();
  const byPrevious = new Map<string, Amendment>();

  for (const amendment of amendments) {
    if (amendment.previousVersionId === amendment.amendmentVersionId) {
      throw new Error(
        `Amendment record says ${amendment.previousVersionId} amends itself; a version cannot be its own predecessor`,
      );
    }

    const merged = byAmended.get(amendment.amendmentVersionId);
    if (merged !== undefined && merged.previousVersionId !== amendment.previousVersionId) {
      throw new Error(
        `Version ${amendment.amendmentVersionId} is recorded as amending both ${merged.previousVersionId} and ${amendment.previousVersionId}; two contracts were merged into one version, and the supersession chain does not say which content it replaced`,
      );
    }

    const forked = byPrevious.get(amendment.previousVersionId);
    if (forked !== undefined && forked.amendmentVersionId !== amendment.amendmentVersionId) {
      throw new Error(
        `Version ${amendment.previousVersionId} was amended twice, into ${forked.amendmentVersionId} and ${amendment.amendmentVersionId}; the contract history forks, and "the current version" would be ambiguous`,
      );
    }

    byAmended.set(amendment.amendmentVersionId, amendment);
    byPrevious.set(amendment.previousVersionId, amendment);
  }

  const newestFirst: string[] = [versionId];
  const seen = new Set<string>([versionId]);
  let cursor = versionId;

  for (;;) {
    const amendment = byAmended.get(cursor);
    if (amendment === undefined) return Object.freeze(newestFirst.reverse());

    if (seen.has(amendment.previousVersionId)) {
      throw new Error(
        `Amendment history contains a cycle at ${amendment.previousVersionId}; the supersession chain does not terminate`,
      );
    }
    seen.add(amendment.previousVersionId);
    newestFirst.push(amendment.previousVersionId);
    cursor = amendment.previousVersionId;
  }
}