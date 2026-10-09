/**
 * Tiers: the ladder `T4 < T3 < T2 < T1 < godtier` and the movement rule.
 *
 * There is no OCK/SSF/WWF ladder here. Those names exist nowhere in the legacy
 * source; ADR-0016 withdrew them.
 */

export { TIER_LADDER, demote, isTier, promote, tierRank } from "./tiers.js";
export type { Tier } from "./tiers.js";

export { PROMOTION_THRESHOLD_PERCENT, RETENTION_FLOOR_PERCENT, computeTierMovement, computeWinRatePercent } from "./movement.js";
export type {
  ComputeTierMovementInput,
  TierMovement,
  TierMovementKind,
  WinRateInput,
} from "./movement.js";