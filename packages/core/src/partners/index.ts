/**
 * Partners: the commercial pipeline as a state machine, and a weighted forecast.
 *
 * Two files, two questions.
 *
 * **`./pipeline.ts` — "may this deal move?"** A six-stage table
 * (`lead → qualified → negotiation → signed → active → lapsed`) and a pure
 * `canTransition`. The load-bearing consequence is that `signed` is a one-way
 * door: a signed partner cannot quietly return to "negotiation", because every
 * report downstream reads that stage as "this deal exists". Irreversibility is
 * derived from the table by reachability and then pinned by name in the tests.
 *
 * **`./forecast.ts` — "what is this quarter worth?"** A probability-weighted
 * value for a set of deals. Every amount is the repository's `Money`: `bigint`
 * minor units at four decimal places, carrying an ISO 4217 code (ADR-0003). There
 * is no `number` amount anywhere, a mixed-currency pipeline is refused rather than
 * converted, and the rounding is *reported* rather than hidden — the precedent is
 * ADR-0019 §6, that a figure which silently moved is worse than one that refuses.
 *
 * **Product decision, not a recovered rule.** ADR-0016 records that the legacy
 * system had no recoverable commercial rules at all — status columns written by
 * unrelated handlers, and no state machine. Both the stage list and the default
 * probabilities are designed here, and both are held in one exported table each so
 * that recalibrating them is a visible one-line change.
 *
 * No persistence — `packages/db` owns the tables. No network, and no clock:
 * `at` is always supplied.
 */

export {
  IRREVERSIBLE_PARTNER_TRANSITIONS,
  PARTNER_STAGES,
  PARTNER_TRANSITIONS,
  assertCanTransition,
  canTransition,
  isIrreversibleTransition,
  isTerminalStage,
  nextStages,
  transitionPartner,
} from "./pipeline.js";
export type { PartnerStage, PartnerTransition, TransitionPartnerInput } from "./pipeline.js";

export { computeWeightedForecast, dealWeightedValue, stageDefaultProbability } from "./forecast.js";
export type { PartnerDeal, PipelineForecast, StageForecast } from "./forecast.js";