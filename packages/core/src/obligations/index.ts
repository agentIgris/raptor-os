/**
 * Obligations: promises with parts, evidence with provenance, and a fulfilment
 * answer that is **computed**.
 *
 * The phase's acceptance criterion is *"Obligation fulfilment provable end to
 * end"*. Five decisions together make that true rather than aspirational:
 *
 * 1. **An obligation has parts, not a status.** "Four streams, two posts, appear
 *    at the final" is three promises with three due dates, so each can be short
 *    on its own. A single status could only ever be right or wrong about all
 *    three at once, which is how two delivered posts out of four reads as
 *    "fulfilled".
 * 2. **There is no fulfilment flag anywhere.** `Obligation` and
 *    `ObligationPart` have no `fulfilled`, no `status` and no `completedAt`. The
 *    absence is structural, so `isObligationDischarged` *cannot* read a claim
 *    somebody set by hand — and `compareDischargeClaim` reports the drift when one
 *    exists, rather than letting it stand.
 * 3. **Evidence is append-only and carries provenance.** Who captured it, when,
 *    and whether it was `machine_derived` or `human_asserted` — with a named
 *    `method` required for machine claims and forbidden for human ones, because
 *    ADR-0019 records that the legacy system had no provenance at all and that is
 *    how a hardcoded `85` was rendered as an OCR result.
 * 4. **Evidence must match the part's kind.** A screenshot of a post does not
 *    discharge four promised streams. Mismatches are returned in
 *    `excludedEvidenceIds`, so the mismatch is a report rather than a silent
 *    zero.
 * 5. **Over-fulfilment is its own state.** Five evidenced streams against a
 *    promise of four discharges the obligation and is reported on
 *    `overFulfilledPartIds` — neither silently accepted nor treated as a breach.
 *
 * No persistence — `packages/db` owns the tables. No network, and no clock: every
 * instant is a parameter, so "was this discharged by June?" can be answered for a
 * date in the past.
 *
 * Which part kinds exist, and how surplus is treated, are **product decisions**,
 * not recovered rules: ADR-0016 records that the legacy system had no recoverable
 * commercial rules at all.
 */

export { createObligation } from "./obligation.js";
export type { CreateObligationInput, Obligation, ObligationPart } from "./obligation.js";

export { OBLIGATION_PART_KINDS } from "./part-kind.js";
export type { ObligationPartKind } from "./part-kind.js";

export { activeEvidence, recordEvidence, retractEvidence } from "./evidence.js";
export type {
  EvidenceOrigin,
  EvidenceProvenance,
  EvidenceRecord,
  EvidenceRetraction,
  EvidenceRetractionReason,
  RecordEvidenceInput,
  RetractEvidenceInput,
} from "./evidence.js";

export {
  compareDischargeClaim,
  computeDischarge,
  createDischargeClaim,
  isObligationDischarged,
  latePartsAsOf,
} from "./discharge.js";
export type {
  DischargeComparison,
  DischargeReport,
  ObligationDischargeClaim,
  PartDischarge,
  PartDischargeState,
} from "./discharge.js";