/**
 * Inventory: a **ledger of movements**, with the balance derived from it.
 *
 * The choice is stated and justified rather than left implicit, because the whole
 * module turns on it.
 *
 * **Stored balance or ledger of movements? Movements.** The justification is
 * ADR-0016's slot-expense finding: an `AFTER INSERT` trigger created the expense
 * row for a purchase and an API route inserted a second one, swallowing the
 * failure with `console.warn`. Every API-created slot was billed twice, because
 * the stored figure and the movement that caused it were written by **two code
 * paths** and nothing ever compared them. A stored balance has no owner and no
 * invariant; a derived one cannot drift from anything, because there is nothing
 * to drift from. The design spec makes the same call for money — §6, *"Money is a
 * ledger, never a column"* — and an unsold jersey is money owed to a partner the
 * moment it is promised.
 *
 * Concretely:
 *
 * - `InventoryItem` has **no quantity field**, and no function here could set one.
 * - `computeOnHand` is a pure function of the movement list, tenant-scoped by
 *   construction, and reports a negative balance rather than clamping it, because
 *   "oversold" and "empty" need opposite responses.
 * - `appendMovement` refuses a movement that would take stock negative. The guard
 *   is at the **write**, because a read cannot stop anything.
 * - There is no edit and no delete. A mistaken movement is corrected by appending
 *   another, exactly as `reverseJournal` corrects a posting.
 *
 * **Product decision, not a recovered rule.** The legacy system had no recoverable
 * inventory rules; the movement vocabulary is designed here.
 *
 * No persistence — `packages/db` owns the tables. No network, and no clock.
 */

export {
  STOCK_MOVEMENT_REASONS,
  appendMovement,
  computeOnHand,
  createInventoryItem,
} from "./stock.js";
export type {
  AppendMovementResult,
  InventoryItem,
  MovementDirection,
  StockMovement,
  StockMovementReason,
} from "./stock.js";