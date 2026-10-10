/**
 * Guardian consent: given *to an engagement*, provable, and revocable.
 *
 * The legacy system had no guardian concept at all, so this is a new domain
 * rather than a recovered one. Three decisions carry the weight.
 *
 * ## 1. Consent is to an engagement, not a property of the minor
 *
 * There is no `guardian_consented` boolean on the person, and this module could
 * not set one even if there were: every {@link GuardianConsent} names one
 * `engagementId`. A global flag says "this person's guardian said yes at some
 * point", which is not the same claim as "this person's guardian said yes to
 * this contract", and only the second is worth anything. The first is how a
 * consent given for a school trip ends up authorising a sponsorship deal.
 *
 * ## 2. Consent is independently provable, so it carries evidence
 *
 * `evidenceReference` is required. A guardian's word is not a control: without
 * something to point at, "the guardian consented" is unfalsifiable, and an
 * unfalsifiable authorisation is the same as no authorisation at all. What form
 * the evidence takes — notarised letter, court order, registry entry — is for
 * `packages/db` and the audit package; this module requires that *something* be
 * named, and stores the reference immutably with the consent.
 *
 * ## 3. The guardian may not be the minor
 *
 * **Product decision.** The obvious conflict — guardian and minor are the same
 * person — is **forbidden outright** rather than resolved by demanding a second,
 * independent guardian.
 *
 * The reasoning for forbidding it rather than allowing a second signature: a
 * "second independent guardian" for a person who is their own guardian is
 * theatre. Two people both recruited by, or dependent on, the same minor do not
 * make two independent parties; they make one party with extra paperwork, and the
 * paperwork would be the entire control. The rule that does real work here is the
 * one already enforced elsewhere in this package: **below
 * {@link ENGAGEMENT_MINIMUM_AGE_YEARS} the answer is no regardless of who
 * signs.** So a thirteen-year-old is consented by an adult who is not the
 * thirteen-year-old, and a twelve-year-old is not consented by anybody. Making
 * the floor absolute is what lets the self-guardianship case be forbidden
 * without inventing a rule about counting heads.
 *
 * ## Withdrawal propagates
 *
 * {@link ConsentWithdrawal} is an append-only record, and the tests do not
 * assert that in a comment — they call {@link resolveEngagementConsent} before
 * and after and show the same person, engagement and date flipping from admitted
 * to refused. Withdrawal removes the consent **it names**, not every consent the
 * minor has, so a second guardian's live consent survives a first guardian's
 * withdrawal.
 *
 * Pure: no database, no network, no clock. `at` is always supplied.
 */

import type { Person } from "./majority.js";
import { isMinor, isUnderEngagementMinimumAge } from "./majority.js";

/** One guardian's consent to one engagement, with the evidence behind it. */
export interface GuardianConsent {
  readonly consentId: string;
  readonly minorId: string;
  readonly guardianId: string;
  /** The specific engagement being consented to. Never blank, never "any". */
  readonly engagementId: string;
  readonly organizationId: string;
  readonly grantedAt: Date;
  /** Mandatory. Guardian consent is not a standing authorisation. */
  readonly expiresAt: Date;
  /** Pointer to independently verifiable proof. Required; see the module note. */
  readonly evidenceReference: string;
}

/** Why a consent stopped counting. */
export type ConsentWithdrawalReason =
  | "guardian_withdrew"
  | "guardian_relationship_ended"
  | "evidence_withdrawn"
  | "fraud_suspected";

/** An append-only record that a named consent is revoked. */
export interface ConsentWithdrawal {
  readonly consentId: string;
  readonly withdrawnAt: Date;
  readonly withdrawnBy: string;
  readonly reason: ConsentWithdrawalReason;
  readonly organizationId: string;
}

export interface CreateGuardianConsentInput {
  readonly consentId: string;
  readonly minorId: string;
  readonly guardianId: string;
  readonly engagementId: string;
  readonly organizationId: string;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
  readonly evidenceReference: string;
}

/**
 * Validate and freeze a guardian consent.
 *
 * Refuses, in order: a blank consent id, the minor acting as their own
 * guardian, a blank engagement, missing evidence, and a non-advancing window.
 */
export function createGuardianConsent(input: CreateGuardianConsentInput): GuardianConsent {
  if (input.consentId.trim() === "") {
    throw new Error("Guardian consent must carry a non-empty consentId");
  }
  if (input.minorId.trim() === "") {
    throw new Error(`Guardian consent ${input.consentId} names no minorId`);
  }
  if (input.guardianId.trim() === "") {
    throw new Error(`Guardian consent ${input.consentId} has a blank guardianId; nobody consented to anything`);
  }
  if (input.guardianId === input.minorId) {
    throw new Error(
      `Guardian consent ${input.consentId} names the same person as guardianId and minorId: ${input.guardianId} would be consenting to their own engagement on their own behalf. A person cannot consent to themselves. Require an independent guardian, or, below the engagement minimum age, refuse outright regardless of who signs.`,
    );
  }
  if (input.engagementId.trim() === "") {
    throw new Error(
      `Guardian consent ${input.consentId} names no engagementId; consent that is not attached to an engagement is a global flag, which is exactly the thing this replaces`,
    );
  }
  if (input.evidenceReference.trim() === "") {
    throw new Error(
      `Guardian consent ${input.consentId} names no evidenceReference; a consent nobody can independently verify is not a consent`,
    );
  }
  if (input.expiresAt === null || input.expiresAt === undefined || Number.isNaN(input.expiresAt.getTime())) {
    throw new Error(
      `Guardian consent ${input.consentId} has no usable expiresAt; guardian consent is not a standing authorisation and must be given an end date`,
    );
  }
  if (input.expiresAt.getTime() <= input.grantedAt.getTime()) {
    throw new Error(
      `Guardian consent ${input.consentId} has expiresAt ${input.expiresAt.toISOString()}, at or before grantedAt ${input.grantedAt.toISOString()}`,
    );
  }

  return Object.freeze({
    consentId: input.consentId,
    minorId: input.minorId,
    guardianId: input.guardianId,
    engagementId: input.engagementId,
    organizationId: input.organizationId,
    grantedAt: input.grantedAt,
    expiresAt: input.expiresAt,
    evidenceReference: input.evidenceReference,
  });
}

/**
 * Whether a consent is in force at `at`. Half-open `[grantedAt, expiresAt)`, the
 * same convention compensation windows and role grants use.
 */
export function isConsentEffective(consent: GuardianConsent, at: Date): boolean {
  if (at.getTime() < consent.grantedAt.getTime()) return false;
  return at.getTime() < consent.expiresAt.getTime();
}

export interface WithdrawConsentInput {
  readonly consent: GuardianConsent;
  readonly at: Date;
  readonly withdrawnBy: string;
  readonly reason: ConsentWithdrawalReason;
}

/**
 * Append a withdrawal. The consent is untouched and stays frozen.
 *
 * Rejects a withdrawal dated before the grant for the same reason it rejects a
 * withdrawal of a contract acceptance: a revocation that predates the thing it
 * revokes is a corrupted record, not a historical fact.
 */
export function withdrawConsent(input: WithdrawConsentInput): ConsentWithdrawal {
  if (input.withdrawnBy.trim() === "") {
    throw new Error(`Withdrawal of consent ${input.consent.consentId} has a blank withdrawnBy`);
  }
  if (Number.isNaN(input.at.getTime())) {
    throw new Error(`Withdrawal of consent ${input.consent.consentId} has an invalid at`);
  }
  if (input.at.getTime() < input.consent.grantedAt.getTime()) {
    throw new Error(
      `Consent ${input.consent.consentId} cannot be withdrawn at ${input.at.toISOString()}: it was granted at ${input.consent.grantedAt.toISOString()}, and a withdrawal cannot predate the consent it withdraws`,
    );
  }

  return Object.freeze({
    consentId: input.consent.consentId,
    withdrawnAt: input.at,
    withdrawnBy: input.withdrawnBy,
    reason: input.reason,
    organizationId: input.consent.organizationId,
  });
}

/**
 * Why an engagement is not consented to.
 *
 * Distinct reasons because each demands a different remedy: `consent_expired`
 * needs re-consent, `consent_withdrawn` needs a conversation with the guardian,
 * `below_engagement_minimum_age` needs the engagement not to happen, and
 * `no_consent_on_record` needs a guardian to be found at all.
 */
export type RefusalReason =
  | "no_consent_on_record"
  | "not_yet_in_force"
  | "consent_expired"
  | "consent_withdrawn"
  | "below_engagement_minimum_age";

/** The answer to "may this person enter this engagement, on this date?" */
export type ConsentStatus =
  | { readonly kind: "self_consented"; readonly personId: string }
  | { readonly kind: "guardian_consented"; readonly consentId: string; readonly guardianId: string }
  | {
      readonly kind: "refused";
      readonly reason: RefusalReason;
      /** Every consent that stood in the way, sorted. Empty when none did. */
      readonly blockingConsentIds: readonly string[];
    };

export interface ResolveEngagementConsentInput {
  readonly person: Person;
  readonly engagementId: string;
  readonly consents: readonly GuardianConsent[];
  readonly withdrawals: readonly ConsentWithdrawal[];
  readonly at: Date;
  /**
   * Tenant to scope the query to. Required in practice by every caller: without
   * it the answer spans every organisation the minor has ever had a guardian,
   * which would let a consent from one tenant authorise an engagement in
   * another (ADR-0011).
   */
  readonly organizationId?: string;
}

/**
 * Whether this person may enter this engagement on this date, and if not, why.
 *
 * The order of the checks is the policy:
 *
 * 1. **Below the engagement minimum age: refused outright.** Before consent is
 *    even looked at, because no signature can lift it.
 * 2. **Adult: consented for themselves.** A stale withdrawn minor-consent must
 *    never manufacture a bar on somebody who no longer needs one.
 * 3. **Minor: a live, un-withdrawn consent naming this engagement.** Any consent
 *    that exists for this minor but is expired, not yet in force, or withdrawn
 *    is a refusal in its own right — not silently ignored, because "we ignored
 *    the withdrawal because another one existed" is exactly how a withdrawn
 *    authorisation keeps working.
 *
 * Returns data rather than a boolean so a caller can show the reason and so the
 * tests can assert on which consent was honoured.
 */
export function resolveEngagementConsent(input: ResolveEngagementConsentInput): ConsentStatus {
  const { person, at } = input;

  if (isUnderEngagementMinimumAge(person, at)) {
    return { kind: "refused", reason: "below_engagement_minimum_age", blockingConsentIds: [] };
  }

  if (!isMinor(person, at)) {
    return { kind: "self_consented", personId: person.personId };
  }

  const relevant = input.consents.filter((consent) => {
    if (consent.minorId !== person.personId) return false;
    if (consent.engagementId !== input.engagementId) return false;
    if (input.organizationId !== undefined && consent.organizationId !== input.organizationId) return false;
    return true;
  });

  const live = relevant.filter((consent) => !isWithdrawn(consent, input.withdrawals) && isConsentEffective(consent, at));

  if (live.length > 0) {
    // Earliest surviving consent wins, so the answer does not depend on the order
    // rows came back from the database.
    const chosen = [...live].sort(
      (a, b) => a.grantedAt.getTime() - b.grantedAt.getTime() || compare(a.consentId, b.consentId),
    )[0];
    if (chosen !== undefined) {
      return { kind: "guardian_consented", consentId: chosen.consentId, guardianId: chosen.guardianId };
    }
  }

  const expired = relevant
    .filter((consent) => at.getTime() >= consent.expiresAt.getTime())
    .map((consent) => consent.consentId);
  const pending = relevant
    .filter((consent) => at.getTime() < consent.grantedAt.getTime())
    .map((consent) => consent.consentId);
  const withdrawn = relevant
    .filter((consent) => isWithdrawn(consent, input.withdrawals))
    .map((consent) => consent.consentId);

  if (withdrawn.length > 0) {
    return { kind: "refused", reason: "consent_withdrawn", blockingConsentIds: sorted(withdrawn) };
  }
  if (expired.length > 0) {
    return { kind: "refused", reason: "consent_expired", blockingConsentIds: sorted(expired) };
  }
  if (pending.length > 0) {
    return { kind: "refused", reason: "not_yet_in_force", blockingConsentIds: sorted(pending) };
  }

  return { kind: "refused", reason: "no_consent_on_record", blockingConsentIds: [] };
}

/** A withdrawal counts only within the same organisation, and only for the consent it names. */
function isWithdrawn(consent: GuardianConsent, withdrawals: readonly ConsentWithdrawal[]): boolean {
  return withdrawals.some(
    (withdrawal) => withdrawal.consentId === consent.consentId && withdrawal.organizationId === consent.organizationId,
  );
}

function sorted(ids: readonly string[]): readonly string[] {
  return Object.freeze([...ids].sort(compare));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}