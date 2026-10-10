/**
 * Employment: effective-dated compensation agreements.
 *
 * Money is exact `bigint` minor units per ADR-0003; windows are half-open
 * `[validFrom, validTo)` per `src/authorization/model.ts`; overlapping agreements
 * are refused rather than ranked. See `./compensation.js` for the reasoning —
 * particularly why an overlap throws instead of resolving to a winner.
 */

export {
  agreementAppliesAt,
  agreementsCovering,
  assertNoOverlappingAgreements,
  createCompensationAgreement,
  hasOverlapAt,
  resolveCompensationAt,
  totalAnnualCompensationAt,
} from "./compensation.js";

export type { CompensationAgreement, CompensationAgreementDraft } from "./compensation.js";