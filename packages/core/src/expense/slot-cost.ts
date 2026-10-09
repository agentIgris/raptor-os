/**
 * Slot expense.
 *
 * The whole rule, recovered from
 * `automation-scripts/04-business-logic-automation.sql:12-32` (ADR-0016 §3):
 *
 * ```
 * slot_cost = rate * number_of_slots
 * ```
 *
 * An integer multiplication. There is **no** percentage, no deduction, no
 * discount, no rounding and no tax. That is not minimalism — it is the finding.
 * Every one of those was a plausible thing to have found, and none of them is
 * there, so the absence is part of the specification and is reproduced exactly.
 *
 * All arithmetic runs on {@link Money}, i.e. `bigint` minor units at four decimal
 * places (ADR-0003). Because minor units are integers, the multiply is exact and
 * nothing here ever needs to round. A float implementation of the same formula
 * would return 1499.9999999999998 for inputs where this returns exactly
 * `1500.0000`, and a billing figure that is off by a millionth of a rupee is a
 * billing figure nobody can reconcile against an invoice.
 *
 * ## The double-billing defect is NOT reproduced
 *
 * Legacy had an `AFTER INSERT` trigger that created the expense row, and an API
 * route that then inserted a second one and swallowed the failure with
 * `console.warn`. Every API-created slot was billed twice (ADR-0016,
 * "Deliberately NOT carried"). This module computes the cost of a slot exactly
 * once and has no notion of persisting it. The caller owns the decision of *when*
 * to write an expense row; the reason this module does not help it write two is
 * that "bill once" is a property of the write path, not of the arithmetic.
 */

import type { Money } from "../money/index.js";
import { zero } from "../money/index.js";

export interface SlotCostInput {
  /** The rate card's per-slot price, in minor units. */
  readonly ratePerSlot: Money;
  /** How many slots the purchase covers. */
  readonly numberOfSlots: number;
}

/**
 * Cost of a slot purchase: exactly `ratePerSlot * numberOfSlots`.
 *
 * Validates the slot count as a non-negative integer. A negative count is
 * rejected rather than multiplied through, because it would produce a credit
 * and a credit issued by arithmetic is indistinguishable from a refund.
 */
export function computeSlotCost(input: SlotCostInput): Money {
  const { ratePerSlot, numberOfSlots } = input;
  assertSlotCount(numberOfSlots);

  return ratePerSlot.multiply(BigInt(numberOfSlots));
}

export interface SlotPurchase {
  readonly numberOfSlots: number;
}

export interface TotalSlotCostInput {
  readonly ratePerSlot: Money;
  readonly purchases: readonly SlotPurchase[];
}

/**
 * Total cost across several slot purchases against one rate card.
 *
 * Sums {@link computeSlotCost} over the purchases. An empty list costs zero
 * rather than throwing: a team that bought nothing this month is a real state,
 * not an error.
 */
export function computeTotalSlotCost(input: TotalSlotCostInput): Money {
  const { ratePerSlot, purchases } = input;

  return purchases.reduce<Money>((total, purchase) => total.add(computeSlotCost({ ratePerSlot, numberOfSlots: purchase.numberOfSlots })), zero(ratePerSlot.currency));
}

function assertSlotCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Invalid numberOfSlots: expected a non-negative integer, got ${String(value)}. Slot cost is an exact integer multiplication of rate by slot count.`,
    );
  }
}