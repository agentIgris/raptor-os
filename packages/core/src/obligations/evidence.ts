/**
 * Evidence, as an append-only value.
 *
 * The defect this module exists to prevent: an organisation records a sponsorship
 * as delivered and there is nothing behind it. The cure is not a better checkbox,
 * it is a record that says **who saw what, when, and how they came to know it** —
 * and a data model in which that record cannot be quietly replaced.
 *
 * ## Append-only is structural, not conventional
 *
 * There is no function in this module that edits an evidence record, and none
 * that deletes one. {@link recordEvidence} returns a new frozen value;
 * {@link retractEvidence} returns a *separate* {@link EvidenceRetraction} naming
 * the record it disputes. The original is still there afterwards, still says what
 * it said, and the dispute is visible next to it.
 *
 * A retraction cannot itself be retracted. That is the load-bearing part of the
 * design: if a retraction could be retracted, "somebody once disputed this" would
 * be erasures, and the ability to erase a dispute is exactly the ability the
 * first retraction was granted to remove.
 *
 * ## Provenance is mandatory, and the two origins are not interchangeable
 *
 * ADR-0019 records the finding: the legacy system had **no provenance column
 * anywhere**, which is how a hardcoded confidence of `85` came to be rendered as
 * an OCR result, and how `totalMatches * 0.7` came to be rendered as a win rate.
 * The cure is not "add a confidence column" — a confidence column can be
 * hardcoded too. The cure is that every claim is attributed to a *process*:
 *
 * - `machine_derived` **requires** a `method` naming the process that derived it.
 *   "The export pipeline said four streams happened" is auditable; "the system
 *   says 85" is not a claim about anything.
 * - `human_asserted` **forbids** a `method`. A human assertion carrying a method
 *   name is dressing a claim up as a measurement, and the two must be told apart
 *   at the type level rather than by convention.
 *
 * Neither is trusted over the other. A human saying "I watched it" and a machine
 * saying "the CSV said so" are both evidence; what matters is that a reader can
 * see which one they are looking at.
 *
 * **Product decision.** The legacy system had no evidence concept to recover
 * (ADR-0016); the two-origin vocabulary is designed here, not recovered.
 *
 * Pure: no database, no network, no clock. `capturedAt`, `observedAt` and
 * `retractedAt` are all supplied.
 */

import { isKnownKind } from "./obligation.js";
import type { ObligationPartKind } from "./part-kind.js";

/**
 * Where a claim about a deliverable came from.
 *
 * Two values, because the legacy system's failure was not having either. A third
 * ("imported", "inferred", "estimated") would be a distinction without a
 * difference: every one of them collapses into one of these two on inspection.
 */
export type EvidenceOrigin = "machine_derived" | "human_asserted";

/**
 * Who captured an observation, when, and by what route.
 *
 * `capturedBy` is an opaque identifier — a person id or a system identifier — and
 * is deliberately not typed as a person, because "the platform's ingest job" is a
 * legitimate capturer and pretending otherwise would push every automated
 * observation into a human's name.
 *
 * `method` is present for `machine_derived` and absent for `human_asserted`; see
 * {@link recordEvidence} for why that asymmetry is enforced rather than
 * documented.
 */
export interface EvidenceProvenance {
  readonly capturedBy: string;
  readonly capturedAt: Date;
  readonly origin: EvidenceOrigin;
  /** Required iff `origin === "machine_derived"`, forbidden otherwise. */
  readonly method?: string;
}

/** One observation about one promised deliverable. */
export interface EvidenceRecord {
  readonly evidenceId: string;
  readonly obligationId: string;
  readonly partId: string;
  readonly organizationId: string;
  /**
   * The kind of deliverable this evidences.
   *
   * Stored on the record rather than inferred from the part, so that "did this
   * evidence match the promise?" is answerable from the evidence alone — including
   * years later, after the obligation's parts have been read by a different code
   * path than the one that wrote them.
   */
  readonly kind: ObligationPartKind;
  /**
   * How many instances this single observation covers.
   *
   * Greater than one so that one machine extraction over a season's exports can
   * attest to four streams at once, without four copies of the same provenance.
   */
  readonly quantity: number;
  /** When the deliverable itself happened. Never after {@link capturedAt}. */
  readonly observedAt: Date;
  readonly description: string;
  readonly provenance: EvidenceProvenance;
}

/**
 * Why a claim stopped counting.
 *
 * A closed set, because "this evidence is wrong" is not an auditable statement:
 * somebody disputing four streams needs to say *how* they were wrong, and the
 * remedies differ. `wrong_match` and `duplicate` mean the record points at
 * something real that has already been recorded; `not_actually_delivered` means
 * the deliverable itself is in question, which is a conversation with the partner
 * rather than a correction to a row.
 */
export type EvidenceRetractionReason =
  | "recorded_in_error"
  | "wrong_match"
  | "wrong_part"
  | "wrong_partner"
  | "not_actually_delivered"
  | "duplicate";

/**
 * A dispute of one evidence record. Appended beside the record, never in place of
 * it.
 */
export interface EvidenceRetraction {
  readonly evidenceId: string;
  readonly obligationId: string;
  readonly organizationId: string;
  readonly retractedAt: Date;
  readonly retractedBy: string;
  readonly reason: EvidenceRetractionReason;
}

export interface RecordEvidenceInput {
  readonly evidenceId: string;
  readonly obligationId: string;
  readonly partId: string;
  readonly organizationId: string;
  readonly kind: ObligationPartKind;
  readonly quantity: number;
  readonly observedAt: Date;
  readonly description: string;
  readonly provenance: EvidenceProvenance;
}

/** Recognising a retraction, structurally. See {@link retractEvidence}. */
const RETRACTION_MARKER = Symbol.for("raptor.obligations.evidence-retraction");

/**
 * A brand on the retraction records this module produces.
 *
 * It exists so a retraction can be told apart from an evidence record **by the
 * runtime and not only by convention**. The structural properties — no mutator,
 * no deleter, a retraction that cannot itself be retracted — are stated in this
 * file's comment; this symbol is what makes the last one enforceable when a
 * caller hands back something that merely *looks* like a record.
 */
interface BrandedRetraction extends EvidenceRetraction {
  readonly [RETRACTION_MARKER]?: true;
}

/**
 * Validate and freeze one evidence record.
 *
 * Refuses, in order: a blank id in any of its four identifying positions, a
 * blank description, an off-vocabulary kind, a quantity below one or not an
 * integer, an invalid `observedAt`, an unusable provenance, a machine-derived
 * claim with no method, a human-asserted claim carrying one, and an observation
 * dated before the moment it was captured.
 *
 * The last check is worth a line of its own: a record cannot witness something
 * that had not happened yet. It is the same rule `withdrawConsent` and
 * `withdrawAcceptance` apply for the same reason — an event that postdates its own
 * cause is a corrupted record, and a corrupted record in an append-only ledger
 * stays corrupted forever.
 */
export function recordEvidence(input: RecordEvidenceInput): EvidenceRecord {
  if (input.evidenceId.trim() === "") {
    throw new Error("Evidence must carry a non-empty evidenceId: an observation nobody can name cannot be withdrawn");
  }
  if (input.obligationId.trim() === "") {
    throw new Error(`Evidence ${input.evidenceId} names no obligationId: evidence of nothing evidences nothing`);
  }
  if (input.partId.trim() === "") {
    throw new Error(
      `Evidence ${input.evidenceId} names no partId. Evidence is evidence *about a promised deliverable*; unattached evidence cannot be counted against anything.`,
    );
  }
  if (input.organizationId.trim() === "") {
    throw new Error(`Evidence ${input.evidenceId} has a blank organizationId; tenancy scopes every read of this data (ADR-0011)`);
  }
  if (!isKnownKind(input.kind)) {
    throw new Error(
      `Evidence ${input.evidenceId} has unknown kind ${JSON.stringify(input.kind)}; expected one of the declared obligation part kinds. An off-vocabulary kind could be pointed at any part.`,
    );
  }
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    throw new Error(
      `Evidence ${input.evidenceId} claims a quantity of ${String(input.quantity)}; quantity must be a positive integer. Evidence of zero instances is not evidence.`,
    );
  }
  if (input.description.trim() === "") {
    throw new Error(`Evidence ${input.evidenceId} has a blank description; a claim nobody can identify later is not a claim`);
  }
  if (input.observedAt === null || input.observedAt === undefined || Number.isNaN(input.observedAt.getTime())) {
    throw new Error(`Evidence ${input.evidenceId} has no usable observedAt`);
  }

  const provenance = freezeProvenance(input.evidenceId, input.provenance, input.observedAt);

  return Object.freeze({
    evidenceId: input.evidenceId,
    obligationId: input.obligationId,
    partId: input.partId,
    organizationId: input.organizationId,
    kind: input.kind,
    quantity: input.quantity,
    observedAt: input.observedAt,
    description: input.description,
    provenance,
  });
}

function freezeProvenance(evidenceId: string, provenance: EvidenceProvenance, observedAt: Date): EvidenceProvenance {
  if (provenance === null || typeof provenance !== "object") {
    throw new Error(`Evidence ${evidenceId} has no provenance; a claim nobody can attribute is not a claim`);
  }
  if (typeof provenance.capturedBy !== "string" || provenance.capturedBy.trim() === "") {
    throw new Error(
      `Evidence ${evidenceId} has a blank provenance.capturedBy. Every observation is somebody's or something's doing; an unattributable one is exactly what ADR-0019 describes.`,
    );
  }
  if (provenance.capturedAt === null || provenance.capturedAt === undefined || Number.isNaN(provenance.capturedAt.getTime())) {
    throw new Error(`Evidence ${evidenceId} has no usable provenance.capturedAt`);
  }
  if (provenance.origin !== "machine_derived" && provenance.origin !== "human_asserted") {
    throw new Error(
      `Evidence ${evidenceId} has provenance origin ${JSON.stringify(provenance.origin)}; expected "machine_derived" or "human_asserted". A third origin is the place where provenance quietly stops meaning anything.`,
    );
  }

  if (provenance.origin === "machine_derived") {
    if (typeof provenance.method !== "string" || provenance.method.trim() === "") {
      throw new Error(
        `Evidence ${evidenceId} is machine_derived but names no provenance.method. A machine-derived claim that does not name the process that derived it is indistinguishable from a hardcoded constant, which is how ADR-0019's confidence of 85 was presented as an OCR result.`,
      );
    }
  } else if (provenance.method !== undefined) {
    throw new Error(
      `Evidence ${evidenceId} is human_asserted but carries provenance.method ${JSON.stringify(provenance.method)}. A person asserting something is not the same claim as a process deriving it, and attaching a method name to an assertion dresses it up as a measurement.`,
    );
  }

  if (provenance.capturedAt.getTime() < observedAt.getTime()) {
    throw new Error(
      `Evidence ${evidenceId} observes something at ${observedAt.toISOString()} but was captured at ${provenance.capturedAt.toISOString()}: a record cannot witness an event that had not yet happened when it was written, and a corrupted record in an append-only ledger stays corrupted forever`,
    );
  }

  return Object.freeze({
    capturedBy: provenance.capturedBy,
    capturedAt: provenance.capturedAt,
    origin: provenance.origin,
    // The key is *absent* rather than `undefined` for human assertions, so the
    // frozen record has exactly the fields its origin warrants.
    ...(provenance.method === undefined ? {} : { method: provenance.method }),
  });
}

export interface RetractEvidenceInput {
  readonly evidence: EvidenceRecord;
  readonly retractedAt: Date;
  readonly retractedBy: string;
  readonly reason: EvidenceRetractionReason;
}

/**
 * Append a dispute of one evidence record. The record is untouched.
 *
 * Refuses a retraction dated before the capture it retracts, an unattributed or
 * undated retraction, and — structurally rather than by convention — the retraction
 * of a retraction.
 *
 * That last one is why {@link activeEvidence} takes the retraction list
 * separately: a dispute of a dispute has no meaning, because the fact that the
 * evidence was ever questioned is itself the fact worth keeping.
 */
export function retractEvidence(input: RetractEvidenceInput): EvidenceRetraction {
  const { evidence, retractedAt, retractedBy, reason } = input;

  if (isRetraction(evidence)) {
    throw new Error(
      `Cannot retract ${evidence.evidenceId}: it is already a retraction, not an evidence record. A dispute of a dispute would let the fact that anybody ever questioned the evidence be erased, which is the defect retraction exists to prevent.`,
    );
  }
  if (typeof retractedBy !== "string" || retractedBy.trim() === "") {
    throw new Error(
      `Retraction of evidence ${evidence.evidenceId} has a blank retractedBy; a dispute nobody owns is indistinguishable from an accident`,
    );
  }
  if (retractedAt === null || retractedAt === undefined || Number.isNaN(retractedAt.getTime())) {
    throw new Error(`Retraction of evidence ${evidence.evidenceId} has no usable retractedAt`);
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error(`Retraction of evidence ${evidence.evidenceId} states no reason`);
  }
  if (retractedAt.getTime() < evidence.provenance.capturedAt.getTime()) {
    throw new Error(
      `Evidence ${evidence.evidenceId} cannot be retracted at ${retractedAt.toISOString()}: it was captured at ${evidence.provenance.capturedAt.toISOString()}, and a retraction cannot predate the record it retracts`,
    );
  }

  return Object.freeze({
    evidenceId: evidence.evidenceId,
    obligationId: evidence.obligationId,
    organizationId: evidence.organizationId,
    retractedAt,
    retractedBy,
    reason,
    [RETRACTION_MARKER]: true,
  });
}

/**
 * Whether a value is one of this module's retraction records.
 *
 * Brand check rather than a field check: a hand-built object literal with the
 * right fields is not something this module produced, and the guarantee that a
 * retraction cannot itself be retracted is only worth anything if it can tell
 * the difference.
 */
function isRetraction(value: EvidenceRecord | EvidenceRetraction): value is BrandedRetraction {
  return typeof value === "object" && value !== null && (value as BrandedRetraction)[RETRACTION_MARKER] === true;
}

/**
 * The evidence that still counts: everything not named by a live retraction.
 *
 * Retraction matching is on **all three** of `evidenceId`, `obligationId` and
 * `organizationId`. Id alone would let a retraction raised against one obligation
 * silently discharge another — ids are supplied by the caller, so two obligations
 * in different tenants can hold the same evidence id, and "erase it" is far too
 * strong a word for a collision.
 */
export function activeEvidence(
  evidence: readonly EvidenceRecord[],
  retractions: readonly EvidenceRetraction[],
): readonly EvidenceRecord[] {
  return evidence.filter(
    (record) =>
      !retractions.some(
        (retraction) =>
          retraction.evidenceId === record.evidenceId &&
          retraction.obligationId === record.obligationId &&
          retraction.organizationId === record.organizationId,
      ),
  );
}