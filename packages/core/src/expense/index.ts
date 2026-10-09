/**
 * Expense: slot cost and the monthly surplus split.
 *
 * Slot cost is an exact integer multiply of rate by slot count (ADR-0016 §3).
 * The surplus split is the one real percentage rule in the legacy system, with
 * deduction order, the 20000 tournament override, and the residual team share all
 * reproduced exactly.
 */

export { computeSlotCost, computeTotalSlotCost } from "./slot-cost.js";
export type { SlotCostInput, SlotPurchase, TotalSlotCostInput } from "./slot-cost.js";

export { TOURNAMENT_OVERRIDE_THRESHOLD_MINOR, computeSurplusSplit } from "./surplus.js";
export type { SurplusSplit, SurplusSplitInput } from "./surplus.js";