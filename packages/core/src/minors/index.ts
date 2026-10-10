/**
 * Minors: majority computed from a birth date, and consent given by somebody else.
 *
 * The legacy system had no concept of minors at all — no birth date, no guardian,
 * nothing stopping a fourteen-year-old signing a player agreement. This package
 * is that concept, and its two structural decisions are:
 *
 * - **Minority is computed, never stored.** There is no `is_minor` boolean and no
 *   function that could set one; `isMinor(person, at)` derives it from the birth
 *   date against a supplied date.
 * - **Consent is to an engagement, provable, and revocable.** Not a flag on the
 *   person, and the guardian may never be the minor themselves.
 *
 * Both age thresholds live in `./majority.ts` as single exported constants.
 * See `./majority.ts` and `./consent.ts` for the boundary reasoning — especially
 * the instant-based eighteenth birthday and the 29 February clamp.
 */

export {
  createGuardianConsent,
  isConsentEffective,
  resolveEngagementConsent,
  withdrawConsent,
} from "./consent.js";
export type {
  ConsentStatus,
  ConsentWithdrawal,
  ConsentWithdrawalReason,
  CreateGuardianConsentInput,
  GuardianConsent,
  RefusalReason,
  ResolveEngagementConsentInput,
  WithdrawConsentInput,
} from "./consent.js";

export {
  ENGAGEMENT_MINIMUM_AGE_YEARS,
  MAJORITY_AGE_YEARS,
  addYears,
  ageInYearsAt,
  isMinor,
  isUnderEngagementMinimumAge,
  majorityDate,
} from "./majority.js";
export type { Person } from "./majority.js";