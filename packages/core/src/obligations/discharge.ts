/**
 * Discharge: fulfilment **computed** from the parts and their evidence.
 *
 * This is the file the phase's acceptance criterion — *"Obligation fulfilment
 * provable end to end"* — is actually decided by. Everything else in this package
 * is data; this is the proof.
 *
 * ## The stored flag is not an input
 *
 * {@link isObligationDischarged} takes an {@link Obligation} and the evidence and
 * returns a boolean. It does not read a stored `fulfilled` column, because there
 * is no such column on {@link Obligation} to read — see `./obligation.ts`. This is
 * structural rather than conventional: a function that *could* read a flag is a
 * function one refactor away from reading it, and a function that cannot is not.
 *
 * Somebody's assertion that the obligation was discharged still has to be recorded
 * somewhere, because an organisation that believes it has delivered is entitled to
 * say so and to be shown otherwise. That assertion is
 * {@link ObligationDischargeClaim}, and it is a **separate argument**.
 * {@link compareDischargeClaim} is what compares the two and reports the drift.
 *
 * **Product decision:** the claim is modelled as a first-class record rather than
 * a column, so that the drift is *detectable*. A flag nobody compares is worse
 * than no flag, because at least "no flag" cannot lie.
 *
 * ## What can discharge a part
 *
 * **Evidence must match the part's kind.** A photograph of an Instagram post does
 * not discharge four promised live streams, even though both records exist and
 * both are perfectly good evidence *of something*. This is the difference between
 * a fulfilment check and a checkbox: a checkbox asks "is there evidence?", and the
 * answer is yes to a photograph of the venue. This asks "is there evidence of
 * *this deliverable*, of *this kind*, from *this organisation*?" — and anything
 * that fails to match is returned in `excludedEvidenceIds` rather than quietly
 * dropped, so a mismatch is a visible report rather than a silent zero.
 *
 * Evidence is also matched on `organizationId`. Tenancy is the discriminator for
 * every read in this package (ADR-0011), and a cross-tenant record that happened
 * to fit the shape would otherwise let one organisation's evidence discharge
 * another's promise.
 *
 * ## Over-fulfilment is its own state
 *
 * Five evidenced streams against a promise of four is `over_fulfilled`, not
 * `fulfilled`. It **does** discharge — the promise was met and then some, and
 * treating a surplus as a breach would be a rule with no commercial sense — but
 * it is reported on {@link DischargeReport.overFulfilledPartIds} rather than
 * silently accepted. The surplus usually means one of two things: a double-record
 * that needs retracting, or an extra deliverable nobody invoiced for. Both are
 * worth a human's attention and neither is visible if the state is just "done".
 *
 * **Product decision.** ADR-0016 records that the legacy system had no recoverable
 * obligation rules, so "excess evidence is a distinct reportable state" is
 * designed here, not recovered.
 *
 * ## Lateness is a separate question from fulfilment
 *
 * A stream delivered three weeks late discharged its part. Whether that is a
 * breach of the contract is a question about the contract, not about whether it
 * happened, so {@link latePartsAsOf} answers it separately rather than folding it
 * into the discharge answer. It measures against the instant the evidence was
 * **captured**, not the instant the deliverable happened: the organisation learns
 * a part was delivered when somebody recorded it, and an obligation that quietly
 * became complete in November because somebody opened a spreadsheet is not a
 * fulfilled obligation, it is a late one.
 *
 * Pure: no database, no network, no clock. `at` is always supplied.
 */

import type { Obligation, ObligationPart } from "./obligation.js";
import type { EvidenceRecord, EvidenceRetraction } from "./evidence.js";
import { activeEvidence } from "./evidence.js";
import type { ObligationPartKind } from "./part-kind.js";

/**
 * How one part stands against its promise.
 *
 * Four states, not two, and the middle pair is the point. `partially_fulfilled`
 * is what three of four looks like; `over_fulfilled` is what five of four looks
 * like. A two-state machine would have to render one of them as the other, and
 * both renderings are lies an organisation can act on.
 */
export type PartDischargeState =
  | "outstanding"
  | "partially_fulfilled"
  | "fulfilled"
  | "over_fulfilled";

/** One part's standing, with the arithmetic that produced it. */
export interface PartDischarge {
  readonly partId: string;
  readonly kind: ObligationPartKind;
  readonly promisedQuantity: number;
  /** Instances counted, after retraction, kind matching and tenancy. */
  readonly evidencedQuantity: number;
  readonly state: PartDischargeState;
  /** Promised minus evidenced, floored at zero. */
  readonly shortfall: number;
  /** Evidenced minus promised, floored at zero. */
  readonly surplus: number;
  /** The evidence that counted, sorted, so the sum can be checked by hand. */
  readonly countedEvidenceIds: readonly string[];
  /**
   * Evidence naming this part that was **not** counted: retracted, or of a
   * different kind.
   *
   * Reported rather than dropped. A part that reads zero when four records exist
   * is a support ticket; a part that reads zero and names the four records that
   * were refused is an answer. Retracted records appear here too, so that
   * "nothing was ever recorded" and "everything was withdrawn" stay tellable
   * apart.
   */
  readonly excludedEvidenceIds: readonly string[];
  /**
   * When the part became discharged: the latest capture instant among the counted
   * evidence, or `null` if it is not discharged at all.
   *
   * Derived here rather than stored, for the same reason the whole module is: a
   * stored `discharged_at` is written by a different code path from the one that
   * records evidence, and the two are never compared.
   */
  readonly dischargedAt: Date | null;
}

/** An obligation's standing, computed. */
export interface DischargeReport {
  readonly obligationId: string;
  readonly organizationId: string;
  /** True only when every part is `fulfilled` or `over_fulfilled`. */
  readonly discharged: boolean;
  readonly parts: readonly PartDischarge[];
  /** Parts carrying evidence beyond what was promised. Empty in the ordinary case. */
  readonly overFulfilledPartIds: readonly string[];
  /**
   * Evidence naming no part of this obligation: a `partId` it does not have, or
   * a record belonging to a different obligation or a different tenant.
   *
   * Kept apart from {@link PartDischarge.excludedEvidenceIds} because the two mean
   * different things. An excluded record is aimed at this promise and was refused;
   * an unattached record was never about it at all.
   */
  readonly unattachedEvidenceIds: readonly string[];
}

/**
 * Whether every promised part has been met by evidence of the right kind.
 *
 * Pure, and derived from the parts and the evidence alone. There is no stored flag
 * to consult and no way for a caller to pass one: the parameter list is the whole
 * set of facts that can affect the answer.
 */
export function isObligationDischarged(
  obligation: Obligation,
  evidence: readonly EvidenceRecord[],
  retractions: readonly EvidenceRetraction[],
): boolean {
  return computeDischarge(obligation, evidence, retractions).discharged;
}

/**
 * Compute every part's standing, and the obligation's from those parts.
 *
 * Nothing here short-circuits: a caller that wants to know *which* part is short
 * should not have to run the predicate once per part and diff the answers. The
 * report is the primitive; the predicate is the shortcut.
 */
export function computeDischarge(
  obligation: Obligation,
  evidence: readonly EvidenceRecord[],
  retractions: readonly EvidenceRetraction[],
): DischargeReport {
  const live = activeEvidence(evidence, retractions);
  const liveIds = new Set(live.map((record) => record.evidenceId));
  const partsById = new Map<string, ObligationPart>(obligation.parts.map((part) => [part.partId, part]));

  const countedByPart = new Map<string, EvidenceRecord[]>();
  const excludedByPart = new Map<string, string[]>();
  const unattached: string[] = [];

  // Every record is classified, not only the live ones. A retracted record is
  // reported in `excludedEvidenceIds` rather than dropped silently, because a part
  // reading zero is only an answer if the reader can see that three records exist
  // and were retracted — "nothing was ever recorded" and "everything was
  // withdrawn" call for completely different conversations.
  for (const record of evidence) {
    const part = partsById.get(record.partId);
    const attached =
      part !== undefined && record.obligationId === obligation.obligationId && record.organizationId === obligation.organizationId;

    if (!attached) {
      unattached.push(record.evidenceId);
      continue;
    }

    if (!liveIds.has(record.evidenceId)) {
      exclude(excludedByPart, record.partId, record.evidenceId);
      continue;
    }

    if (record.kind !== part.kind) {
      // Report, do not drop. A mismatch between promise and evidence is the
      // finding; a silently ignored record is how the finding is lost.
      exclude(excludedByPart, record.partId, record.evidenceId);
      continue;
    }

    const bucket = countedByPart.get(record.partId);
    if (bucket === undefined) {
      countedByPart.set(record.partId, [record]);
    } else {
      bucket.push(record);
    }
  }

  const parts = obligation.parts.map((part) =>
    evaluatePart(part, countedByPart.get(part.partId) ?? [], excludedByPart.get(part.partId) ?? []),
  );

  return Object.freeze({
    obligationId: obligation.obligationId,
    organizationId: obligation.organizationId,
    discharged: parts.every((part) => part.state === "fulfilled" || part.state === "over_fulfilled"),
    parts: Object.freeze(parts),
    overFulfilledPartIds: Object.freeze(parts.filter((part) => part.state === "over_fulfilled").map((part) => part.partId)),
    unattachedEvidenceIds: Object.freeze([...unattached].sort(compareStrings)),
  });
}

/**
 * One part's arithmetic.
 *
 * Exposed through {@link computeDischarge} only — there is no separate export that
 * would let a caller evaluate a part without the tenancy and retraction filtering
 * that makes the answer mean anything.
 */
function evaluatePart(
  part: ObligationPart,
  counted: readonly EvidenceRecord[],
  excludedEvidenceIds: readonly string[],
): PartDischarge {
  const quantity = counted.reduce((total, record) => total + record.quantity, 0);
  const countedEvidenceIds = [...counted.map((record) => record.evidenceId)].sort(compareStrings);

  // The latest capture is when the part became discharged. A part that is not
  // discharged has no such instant, and `null` says so rather than naming the
  // earliest record it has — which would make an unmet part look lateness-ready.
  const dischargedAt =
    counted.length === 0
      ? null
      : new Date(Math.max(...counted.map((record) => record.provenance.capturedAt.getTime())));

  return Object.freeze({
    partId: part.partId,
    kind: part.kind,
    promisedQuantity: part.promisedQuantity,
    evidencedQuantity: quantity,
    state: classifyPart(part.promisedQuantity, quantity),
    shortfall: Math.max(part.promisedQuantity - quantity, 0),
    surplus: Math.max(quantity - part.promisedQuantity, 0),
    countedEvidenceIds: Object.freeze(countedEvidenceIds),
    excludedEvidenceIds: Object.freeze([...excludedEvidenceIds].sort(compareStrings)),
    dischargedAt,
  });
}

/**
 * The four-way split, written out rather than composed from two predicates.
 *
 * Three compositions of the same rule produce three different off-by-ones within
 * a month, and "3 of 4" rendering as "fulfilled" is precisely the defect this
 * package exists to prevent — so the rule is stated once, in one place, and
 * pinned by tests at 0, `n-1`, `n`, `n+1` and `2n`.
 */
function classifyPart(promised: number, evidenced: number): PartDischargeState {
  if (evidenced === 0) return "outstanding";
  if (evidenced < promised) return "partially_fulfilled";
  if (evidenced === promised) return "fulfilled";
  return "over_fulfilled";
}

function exclude(map: Map<string, string[]>, partId: string, evidenceId: string): void {
  const existing = map.get(partId);
  if (existing === undefined) {
    map.set(partId, [evidenceId]);
    return;
  }
  existing.push(evidenceId);
}

/**
 * Someone's assertion that this obligation has been discharged.
 *
 * It exists, is validated, and is *never read by the computation*. That is not an
 * oversight to be fixed later; it is the design. The claim is an input to
 * {@link compareDischargeClaim} and nothing else, so it cannot be mistaken for
 * the answer.
 */
export interface ObligationDischargeClaim {
  readonly obligationId: string;
  readonly organizationId: string;
  readonly claimedDischargedAt: Date;
  readonly claimedBy: string;
  readonly note?: string;
}

/**
 * Validate and freeze a discharge claim.
 *
 * Rejects an unattributed claim and an undated one. A drift report whose
 * claimant is unknown is not a report anybody can act on, and a claim dated
 * nowhere cannot be ordered against the evidence that was captured before it.
 */
export function createDischargeClaim(input: ObligationDischargeClaim): ObligationDischargeClaim {
  if (input.obligationId.trim() === "") {
    throw new Error("A discharge claim must name an obligationId");
  }
  if (input.organizationId.trim() === "") {
    throw new Error(`Discharge claim for ${input.obligationId} has a blank organizationId`);
  }
  if (typeof input.claimedBy !== "string" || input.claimedBy.trim() === "") {
    throw new Error(
      `Discharge claim for ${input.obligationId} has a blank claimedBy. Somebody asserted this obligation was delivered; the assertion has to name who, or the drift report has nobody to go back to.`,
    );
  }
  if (input.claimedDischargedAt === null || input.claimedDischargedAt === undefined || Number.isNaN(input.claimedDischargedAt.getTime())) {
    throw new Error(`Discharge claim for ${input.obligationId} has no usable claimedDischargedAt`);
  }

  return Object.freeze({
    obligationId: input.obligationId,
    organizationId: input.organizationId,
    claimedDischargedAt: input.claimedDischargedAt,
    claimedBy: input.claimedBy,
    ...(input.note === undefined ? {} : { note: input.note }),
  });
}

/**
 * The answer to "did somebody claim this was discharged, and is that true?".
 *
 * Both halves are reported, and neither is preferred. `agrees` is what a caller
 * should branch on: `claimedDischarged && !computedDischarged` is the defect this
 * package exists to catch, and `unsupportedPartIds` says exactly which promises
 * the claim rests on nothing.
 *
 * The computed answer is what counts wherever the two differ, and this module
 * enforces that by never reading the claim inside {@link isObligationDischarged}
 * at all. The claim is an assertion about the world; the computation is the
 * world.
 */
export interface DischargeComparison {
  readonly obligationId: string;
  /** Whether a claim for this obligation exists in this tenant. */
  readonly claimedDischarged: boolean;
  /** What the parts and the evidence actually say. */
  readonly computedDischarged: boolean;
  /**
   * Whether the claim and the computation conflict.
   *
   * `true` when there is no claim at all: nobody asserted anything, so nothing has
   * been contradicted. `false` only in the direction that matters — somebody
   * claimed discharge and the evidence does not support it.
   */
  readonly agrees: boolean;
  /** Parts the claim asserts and the evidence does not support, in promise order. */
  readonly unsupportedPartIds: readonly string[];
  /** The full computation, so a caller can render the whole picture. */
  readonly report: DischargeReport;
}

/**
 * Compare somebody's claim against what the evidence supports.
 *
 * A claim for a different obligation, or from a different tenant, is treated as
 * no claim at all. Both ids are caller-supplied and therefore collidable, and a
 * claim is an assertion about one specific promise.
 *
 * Note the one-sidedness: a claim can only be *unsupported*, never *prematurely
 * withdrawn*. There is no "I withdraw my claim" value here, and that is
 * deliberate — withdrawing an assertion of delivery is not a thing the person who
 * made it gets to do silently, and the product decision for it has not been
 * taken. Adding one would need a rule, not a convenience.
 */
export function compareDischargeClaim(
  obligation: Obligation,
  evidence: readonly EvidenceRecord[],
  retractions: readonly EvidenceRetraction[],
  claim: ObligationDischargeClaim | null,
): DischargeComparison {
  const report = computeDischarge(obligation, evidence, retractions);
  const applies =
    claim !== null && claim.obligationId === obligation.obligationId && claim.organizationId === obligation.organizationId;
  const claimedDischarged = applies;
  const computedDischarged = report.discharged;

  return Object.freeze({
    obligationId: obligation.obligationId,
    claimedDischarged,
    computedDischarged,
    // "Agrees" means *no claim contradicts the computation*, not "two booleans
    // are equal". An obligation with no claim on record has not been disputed by
    // anybody, and reporting that as a disagreement would fill a review queue with
    // every obligation nobody has checked yet. The direction that matters —
    // claimed but unsupported — is the one that survives this definition.
    agrees: !claimedDischarged || claimedDischarged === computedDischarged,
    unsupportedPartIds: Object.freeze(
      report.parts.filter((part) => part.state !== "fulfilled" && part.state !== "over_fulfilled").map((part) => part.partId),
    ),
    report,
  });
}

/**
 * Parts that were met after they were due.
 *
 * Deliberately excludes parts that were never met: an unmet part is a breach, not
 * a late one, and listing the two together would let "was late" and "was never
 * delivered" share a report.
 *
 * The comparison is against `dischargedAt` — when the evidence was **captured**,
 * not when the deliverable happened. The organisation finds out that a part was
 * delivered when somebody records it, and a promise that quietly became complete
 * in November because somebody opened a spreadsheet was late, not fulfilled on
 * time.
 *
 * The boundary is strict: a part discharged at exactly its `dueAt` is on time.
 * `<=` would make every deliverable a millisecond late and would train readers to
 * ignore this report.
 */
export function latePartsAsOf(obligation: Obligation, report: DischargeReport, at: Date): readonly string[] {
  if (at === null || at === undefined || Number.isNaN(at.getTime())) {
    throw new Error("latePartsAsOf requires a valid at instant; there is no default clock in this package");
  }
  if (report.obligationId !== obligation.obligationId) {
    throw new Error(
      `latePartsAsOf was given a report for ${report.obligationId} but an obligation for ${obligation.obligationId}; the two would answer different questions`,
    );
  }

  const dueById = new Map<string, Date>(obligation.parts.map((part) => [part.partId, part.dueAt]));

  return Object.freeze(
    report.parts
      .filter((part) => {
        if (part.dischargedAt === null) return false;
        // `!` rather than a `?? 0` fallback: a fabricated zero would make a part
        // with no known due date look infinitely late, which is a lie in the
        // opposite direction. `latePartsAsOf` has already refused a report for a
        // different obligation, and a report is a frozen derived value, so the
        // part is one of this obligation's by construction.
        return part.dischargedAt.getTime() > dueById.get(part.partId)!.getTime();
      })
      .map((part) => part.partId),
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}