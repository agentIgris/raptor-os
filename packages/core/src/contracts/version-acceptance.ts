/**
 * Acceptance and withdrawal, as values.
 *
 * The legacy system's acceptance was a nullable boolean on a contract row. That
 * shape cannot answer a single question anyone actually asks: *which document did
 * this person agree to?* — because the boolean survives every edit to the
 * contract it was attached to. An acceptance that outlives the document it
 * accepted is not an acceptance of anything.
 *
 * So acceptance here is a **separate, immutable record naming both the version id
 * and the content hash the accepter was shown**. It is not a field on the
 * contract and it is never mutated. Two consequences fall out and both are
 * tested:
 *
 * - Acceptance of version N is not acceptance of version N+1. Version N+1 has a
 *   different hash, so an acceptance naming N's hash does not match it, whatever
 *   the ids say.
 * - Withdrawal cannot un-accept. {@link withdrawAcceptance} appends a
 *   {@link AcceptanceWithdrawal}; the acceptance still happened, and the history
 *   still shows it did. Revoking a signature by erasing it is the thing this
 *   shape exists to prevent.
 *
 * {@link findEffectiveAcceptance} matches on **id *and* hash together**, so an
 * acceptance whose hash was pointed at a different version is refused rather than
 * honoured. Matching on the id alone would leave the hash decorative.
 */

import type { ContractVersion } from "./version.js";

/** A person has agreed to one specific version, having seen one specific hash. */
export interface Acceptance {
  readonly versionId: string;
  /** The hash of the document that was presented. Proves *which* bytes. */
  readonly contentHash: string;
  readonly acceptedBy: string;
  readonly acceptedAt: Date;
  readonly organizationId: string;
}

/**
 * Why someone declined.
 *
 * Free-form strings would let a caller record `""` and produce a refusal nobody
 * can act on, so the reasons are a closed set. Product decision: the legacy
 * system recorded no reason at all.
 */
export type RefusalReason = "terms_not_agreed" | "read_more_time" | "signing_blocked";

/** A person declined one specific version. Append-only, like acceptance. */
export interface AcceptanceRefusal {
  readonly versionId: string;
  readonly contentHash: string;
  readonly refusedBy: string;
  readonly refusedAt: Date;
  readonly organizationId: string;
  readonly reason: RefusalReason;
}

/**
 * Why an acceptance stopped counting.
 *
 * `withdrawn_by_accepting_party` is the ordinary case. `revoked_by_organisation`
 * exists because an organisation sometimes discovers that the person who signed
 * had no authority to, and the record of the signature still has to survive.
 */
export type WithdrawalReason = "withdrawn_by_accepting_party" | "revoked_by_organisation";

/**
 * A withdrawal is its own record, appended alongside the acceptance it revokes.
 *
 * Carries the hash *as well as* the acceptance, so a withdrawal cannot be
 * re-pointed at a later version either — the same rule acceptance follows.
 */
export interface AcceptanceWithdrawal {
  readonly versionId: string;
  readonly acceptanceContentHash: string;
  readonly withdrawnAt: Date;
  readonly withdrawnBy: string;
  readonly reason: WithdrawalReason;
  readonly organizationId: string;
}

/** sha-256, lowercase hex. Shared with `./version.js` by construction, not by hope. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface CreateAcceptanceInput {
  readonly versionId: string;
  readonly contentHash: string;
  readonly acceptedBy: string;
  readonly acceptedAt: Date;
  readonly organizationId: string;
}

/**
 * Record an acceptance of a specific version at a specific hash.
 *
 * The hash is validated rather than trusted: an acceptance whose `contentHash`
 * is not a sha-256 is an acceptance that cannot be proven to anything, and
 * storing it would put an unverifiable record into the very table whose purpose
 * is verifiability.
 */
export function createAcceptance(input: CreateAcceptanceInput): Acceptance {
  if (input.versionId.trim() === "") {
    throw new Error("Acceptance must name a versionId: an acceptance of nothing is not an acceptance");
  }
  if (!HASH_PATTERN.test(input.contentHash)) {
    throw new Error(
      `Acceptance for ${input.versionId} carries contentHash ${JSON.stringify(input.contentHash)}, which is not a sha-256 hex digest; it could never be re-verified`,
    );
  }
  if (input.acceptedBy.trim() === "") {
    throw new Error(`Acceptance for ${input.versionId} has no acceptedBy: nobody accepted it`);
  }
  if (Number.isNaN(input.acceptedAt.getTime())) {
    throw new Error(`Acceptance for ${input.versionId} has an invalid acceptedAt`);
  }

  return Object.freeze({
    versionId: input.versionId,
    contentHash: input.contentHash,
    acceptedBy: input.acceptedBy,
    acceptedAt: input.acceptedAt,
    organizationId: input.organizationId,
  });
}

/**
 * The acceptance in force for this exact version, or `null`.
 *
 * Matches on version id **and** content hash. Either alone is insufficient: the
 * id alone would honour an acceptance re-pointed at an amended version, and the
 * hash alone would accept a hash belonging to some other contract entirely.
 *
 * Where a version was accepted more than once, the earliest acceptance wins, so
 * the answer does not depend on the order rows came back from the database.
 */
export function findEffectiveAcceptance(
  version: ContractVersion,
  acceptances: readonly Acceptance[],
): Acceptance | null {
  let earliest: Acceptance | null = null;

  for (const candidate of acceptances) {
    if (candidate.organizationId !== version.organizationId) continue;
    if (candidate.versionId !== version.versionId) continue;
    if (candidate.contentHash !== version.contentHash) continue;
    if (earliest === null || candidate.acceptedAt.getTime() < earliest.acceptedAt.getTime()) {
      earliest = candidate;
    }
  }

  return earliest;
}

/** Whether a withdrawal applies to this acceptance, on both id and hash. */
export function withdrawalMatchesAcceptance(
  acceptance: Acceptance,
  withdrawal: AcceptanceWithdrawal,
): boolean {
  return (
    withdrawal.organizationId === acceptance.organizationId &&
    withdrawal.versionId === acceptance.versionId &&
    withdrawal.acceptanceContentHash === acceptance.contentHash
  );
}

/**
 * The acceptance in force after withdrawals are applied, or `null`.
 *
 * A withdrawal is scoped to *the acceptance it names by time*: it kills the
 * acceptances it post-dates and leaves later ones standing, because a person may
 * sign again after withdrawing. That is why the comparison is between timestamps
 * rather than a boolean "revoked" flag.
 *
 * The search is over every matching acceptance rather than only the earliest,
 * because otherwise a version signed once, withdrawn, and signed again would
 * read as permanently withdrawn — the withdrawal of 2026-04 would retroactively
 * cancel the signature of 2026-06.
 */
export function findUnexpiredAcceptance(
  version: ContractVersion,
  acceptances: readonly Acceptance[],
  withdrawals: readonly AcceptanceWithdrawal[],
): Acceptance | null {
  const matching = acceptances
    .filter(
      (candidate) =>
        candidate.organizationId === version.organizationId &&
        candidate.versionId === version.versionId &&
        candidate.contentHash === version.contentHash,
    )
    .sort((a, b) => a.acceptedAt.getTime() - b.acceptedAt.getTime());

  for (const candidate of matching) {
    const withdrawn = withdrawals.some(
      (withdrawal) =>
        withdrawalMatchesAcceptance(candidate, withdrawal) &&
        withdrawal.withdrawnAt.getTime() >= candidate.acceptedAt.getTime(),
    );
    if (!withdrawn) return candidate;
  }

  return null;
}

export interface WithdrawAcceptanceInput {
  readonly acceptance: Acceptance;
  readonly withdrawnAt: Date;
  readonly withdrawnBy: string;
  readonly reason: WithdrawalReason;
}

/**
 * Append a withdrawal. The acceptance is untouched.
 *
 * Returns a new record rather than setting a flag, and the test asserts the
 * original acceptance object is still frozen and unchanged afterwards. A
 * "revoked" column on the acceptance row is how a signature quietly disappears
 * from the audit trail.
 */
export function withdrawAcceptance(input: WithdrawAcceptanceInput): AcceptanceWithdrawal {
  if (input.withdrawnBy.trim() === "") {
    throw new Error("A withdrawal must name the person or process that withdrew it");
  }
  if (Number.isNaN(input.withdrawnAt.getTime())) {
    throw new Error("A withdrawal must carry a valid withdrawnAt");
  }
  if (input.withdrawnAt.getTime() < input.acceptance.acceptedAt.getTime()) {
    throw new Error(
      `Cannot withdraw ${input.acceptance.versionId} at ${input.withdrawnAt.toISOString()}: it was accepted at ${input.acceptance.acceptedAt.toISOString()}, and a withdrawal cannot predate the event it withdraws`,
    );
  }

  return Object.freeze({
    versionId: input.acceptance.versionId,
    acceptanceContentHash: input.acceptance.contentHash,
    withdrawnAt: input.withdrawnAt,
    withdrawnBy: input.withdrawnBy,
    reason: input.reason,
    organizationId: input.acceptance.organizationId,
  });
}

export interface RecordRefusalInput {
  readonly versionId: string;
  readonly contentHash: string;
  readonly refusedBy: string;
  readonly refusedAt: Date;
  readonly organizationId: string;
  readonly reason: RefusalReason;
}

/**
 * Record a refusal as its own fact.
 *
 * A refusal is not the absence of an acceptance; it is a decision somebody made,
 * and conflating the two loses the only record that they were ever asked.
 */
export function recordRefusal(input: RecordRefusalInput): AcceptanceRefusal {
  if (input.versionId.trim() === "") {
    throw new Error("Refusal must name a versionId");
  }
  if (!HASH_PATTERN.test(input.contentHash)) {
    throw new Error(
      `Refusal for ${input.versionId} carries contentHash ${JSON.stringify(input.contentHash)}, which is not a sha-256 hex digest`,
    );
  }
  if (input.refusedBy.trim() === "") {
    throw new Error(`Refusal for ${input.versionId} has no refusedBy`);
  }
  // The union stops a TypeScript caller passing "". It does not stop a JSON body
  // arriving from a request handler, and a refusal with no stated reason is a
  // record nobody can act on.
  if (input.reason.trim() === "") {
    throw new Error(`Refusal for ${input.versionId} has an empty reason`);
  }
  if (Number.isNaN(input.refusedAt.getTime())) {
    throw new Error(`Refusal for ${input.versionId} has an invalid refusedAt`);
  }

  return Object.freeze({
    versionId: input.versionId,
    contentHash: input.contentHash,
    refusedBy: input.refusedBy,
    refusedAt: input.refusedAt,
    organizationId: input.organizationId,
    reason: input.reason,
  });
}