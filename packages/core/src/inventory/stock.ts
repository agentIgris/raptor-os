/**
 * Inventory: a **ledger of movements**, and a balance derived from it.
 *
 * ## The decision, and the justification
 *
 * **A balance is stored or movements are ledgered. This module ledgers the
 * movements.** Not because a stored balance cannot be kept correct — it can, on a
 * good day — but because a stored balance has no owner and no invariant, and
 * ADR-0016 is the finding that settles it.
 *
 * In the legacy system an `AFTER INSERT` trigger created the expense row for a
 * slot purchase, *and* the API route inserted a second one, swallowing the failure
 * with `console.warn`. Every API-created slot was billed twice. The stored figure
 * and the movement that caused it were written by **two different code paths**,
 * nothing compared them, and the resulting number was wrong by 100% for every
 * write that went through the API. The same shape appears in ADR-0016's other
 * findings: a `late` flag nothing derives, a `start_time` a cutoff rule ignores.
 *
 * The design spec makes the same call about money — §6, *"Money is a ledger,
 * never a column"* — and inventory is money that has not been sold yet. A
 * sponsor's jersey count is an amount owed to a partner the moment it is
 * promised, so the same reasoning applies with the same force.
 *
 * So: {@link InventoryItem} has **no quantity field**, there is no function that
 * sets one, and {@link computeOnHand} sums movements. The answer is a pure
 * function of the record, which means:
 *
 * - It cannot drift. There is nothing to drift from.
 * - It is reproducible: replaying the movements six months later gives the same
 *   number, which is what makes "we had 40 jerseys on 3 April" answerable in a
 *   sponsorship dispute.
 * - It is tenant-scoped for free, because tenancy is a property of the movements
 *   rather than a filter somebody forgot to apply.
 *
 * **Product decision, not a recovered rule.** The legacy system had no recoverable
 * inventory rules. The movement vocabulary below is designed here.
 *
 * ## Where the control lives
 *
 * The oversell guard is in {@link appendMovement}, at the **write**, and not in
 * {@link computeOnHand}. A computed balance can legitimately be negative —
 * {@link computeOnHand} reports that rather than clamping it, because clamping
 * makes "oversold" indistinguishable from "empty" and those need opposite
 * responses. But the moment to *refuse* is when the movement is recorded, while
 * somebody is still in a position to do something about it.
 *
 * ## No mutations, and the clock is not read
 *
 * `appendMovement` returns a new frozen list; it does not edit the one it was
 * given. There is no deleter. The reversal of a mistaken movement is another
 * movement, exactly as `ledger/journal.ts` reverses a posting.
 *
 * Pure: no database, no network, no clock. `at` is always supplied.
 */

/** A stock-keeping unit. Deliberately carries no quantity. */
export interface InventoryItem {
  readonly itemId: string;
  readonly organizationId: string;
  /** Stock-keeping unit code, unique within the organisation. */
  readonly sku: string;
  readonly name: string;
  /**
   * Named rather than implied: a duration column with no unit in its name is a
   * defect waiting to be misread, and the same is true of a quantity column.
   */
  readonly unitOfMeasure: string;
}

/**
 * Why a movement happened. A closed set.
 *
 * Free-text reasons are how "delivery" becomes "delivary", "deliveryy" and
 * "DELIVERY", and a stock report that cannot group its movements is a stock
 * report nobody can reconcile against a delivery note.
 */
export const STOCK_MOVEMENT_REASONS = [
  "purchase_order_received",
  "returned_by_partner",
  "issued_to_partner",
  "written_off",
  "stock_take_correction",
  "damaged",
] as const;

export type StockMovementReason = (typeof STOCK_MOVEMENT_REASONS)[number];

/** Which way stock moved. The sign comes from here, never from a negative quantity. */
export type MovementDirection = "in" | "out";

/** One movement of stock. Append-only. */
export interface StockMovement {
  readonly movementId: string;
  readonly itemId: string;
  readonly organizationId: string;
  readonly direction: MovementDirection;
  /**
   * Always positive. The direction carries the sign, so "in of -10" and "out of
   * 10" are the same movement spelled two ways — and two spellings will
   * eventually disagree.
   */
  readonly quantity: number;
  readonly at: Date;
  readonly reason: StockMovementReason;
  /** The purchase order, delivery note, partner obligation or stock-take sheet. */
  readonly reference: string;
}

/**
 * Validate and freeze an inventory item.
 *
 * Note what is *not* checked: any quantity. There is none, and there must not be.
 */
export function createInventoryItem(input: InventoryItem): InventoryItem {
  if (input.itemId.trim() === "") {
    throw new Error("An inventory item must carry a non-empty itemId");
  }
  if (input.organizationId.trim() === "") {
    throw new Error(
      `Inventory item ${input.itemId} has a blank organizationId; tenancy scopes every read of this data (ADR-0011)`,
    );
  }
  if (input.sku.trim() === "") {
    throw new Error(`Inventory item ${input.itemId} has a blank sku`);
  }
  if (input.name.trim() === "") {
    throw new Error(`Inventory item ${input.itemId} has a blank name`);
  }
  if (typeof input.unitOfMeasure !== "string" || input.unitOfMeasure.trim() === "") {
    throw new Error(
      `Inventory item ${input.itemId} has a blank unitOfMeasure. A quantity without a unit is not a quantity, and "40" of an unnamed thing cannot be compared with anything.`,
    );
  }

  return Object.freeze({
    itemId: input.itemId,
    organizationId: input.organizationId,
    sku: input.sku,
    name: input.name,
    unitOfMeasure: input.unitOfMeasure,
  });
}

/**
 * Stock on hand for an item: receipts minus issues.
 *
 * Pure, and the whole answer. Movements naming another item or another
 * organisation are ignored — tenancy is a property of the movement here rather
 * than a filter a caller has to remember (ADR-0011).
 *
 * **May return a negative number**, deliberately. A clamp to zero would make
 * "we have oversold" and "we have none" the same number, and those two need
 * opposite responses: one means order more, the other means stop promising.
 * Refusing to produce an oversold figure would hide it.
 */
export function computeOnHand(item: InventoryItem, movements: readonly StockMovement[]): number {
  return movements.reduce((total, movement) => {
    if (movement.itemId !== item.itemId) return total;
    if (movement.organizationId !== item.organizationId) return total;
    return movement.direction === "in" ? total + movement.quantity : total - movement.quantity;
  }, 0);
}

/** The result of appending a movement: the new list, and what it implies. */
export interface AppendMovementResult {
  readonly movements: readonly StockMovement[];
  /** `computeOnHand` over {@link movements}. Present so a caller need not recompute. */
  readonly onHand: number;
  /** When the most recent movement happened, or `null` for an empty list. */
  readonly lastMovementAt: Date | null;
}

/**
 * Append one movement, refusing one that would take stock negative.
 *
 * This is where the oversell control lives. It cannot live in
 * {@link computeOnHand}: a derived balance can legitimately be negative, and a
 * read cannot stop anything. This is the last point at which the mistake is still
 * somebody's to correct.
 *
 * The caller's list is not modified — a new frozen list is returned. The
 * correction path for a mistaken movement is a further movement, as with
 * `reverseJournal` in `../ledger`: there is no edit and no delete.
 */
export function appendMovement(existing: readonly StockMovement[], movement: StockMovement): AppendMovementResult {
  if (movement === null || typeof movement !== "object") {
    throw new Error("appendMovement requires a movement");
  }
  if (typeof movement.movementId !== "string" || movement.movementId.trim() === "") {
    throw new Error("A stock movement must carry a non-empty movementId");
  }
  if (typeof movement.itemId !== "string" || movement.itemId.trim() === "") {
    throw new Error(`Stock movement ${movement.movementId} names no itemId`);
  }
  if (typeof movement.organizationId !== "string" || movement.organizationId.trim() === "") {
    throw new Error(`Stock movement ${movement.movementId} has a blank organizationId; tenancy scopes every read of this data (ADR-0011)`);
  }
  if (movement.direction !== "in" && movement.direction !== "out") {
    throw new Error(
      `Stock movement ${movement.movementId} has direction ${JSON.stringify(movement.direction)}; expected "in" or "out". The direction carries the sign, so a third spelling would be a movement whose meaning depends on who read it.`,
    );
  }
  if (!Number.isSafeInteger(movement.quantity) || movement.quantity < 1) {
    throw new Error(
      `Stock movement ${movement.movementId} has quantity ${String(movement.quantity)}; expected a positive integer. Direction carries the sign, and a movement of zero units is not a movement.`,
    );
  }
  if (movement.at === null || movement.at === undefined || Number.isNaN(movement.at.getTime())) {
    throw new Error(`Stock movement ${movement.movementId} has an invalid at`);
  }
  if (!(STOCK_MOVEMENT_REASONS as readonly string[]).includes(movement.reason)) {
    throw new Error(
      `Stock movement ${movement.movementId} has unknown reason ${JSON.stringify(movement.reason)}; expected one of ${STOCK_MOVEMENT_REASONS.join(", ")}. An unclassifiable movement cannot be reconciled against a delivery note or a write-off approval.`,
    );
  }
  if (typeof movement.reference !== "string" || movement.reference.trim() === "") {
    throw new Error(
      `Stock movement ${movement.movementId} names no reference. Every movement points at a purchase order, a delivery note, an obligation or a stock take; one that points at nothing cannot be audited.`,
    );
  }

  for (const prior of existing) {
    if (prior.movementId === movement.movementId) {
      throw new Error(
        `Stock movement ${movement.movementId} is already recorded. Re-submitting the same id would count one delivery twice, which is the same defect as the legacy double-billed slot (ADR-0016).`,
      );
    }
    if (prior.itemId !== movement.itemId || prior.organizationId !== movement.organizationId) {
      throw new Error(
        `Cannot append a movement for ${movement.itemId}/${movement.organizationId} to a list of movements for ${prior.itemId}/${prior.organizationId}. Two items' movements in one list would produce a balance for neither.`,
      );
    }
    if (movement.at.getTime() < prior.at.getTime()) {
      throw new Error(
        `Stock movement ${movement.movementId} is dated ${movement.at.toISOString()}, before ${prior.movementId} at ${prior.at.getTime()} which is already recorded. A movement that predates the movement before it is a corrupted record, and a corrupted record in an append-only ledger stays corrupted for ever.`,
      );
    }
  }

  const onHand = computeOnHand(
    { itemId: movement.itemId, organizationId: movement.organizationId, sku: "", name: "", unitOfMeasure: "" },
    [...existing, movement],
  );

  if (onHand < 0) {
    throw new Error(
      `Stock movement ${movement.movementId} would take ${movement.itemId} to ${String(onHand)}: ${String(onHand * -1)} more than is on hand. Stock cannot go negative here. If the shortfall is real, record a receipt first; if the earlier movements are wrong, append a stock-take correction rather than editing them.`,
    );
  }

  const movements = Object.freeze([
    ...existing,
    // Copied rather than frozen in place. Freezing the caller's object would be a
    // side effect on something this module was only asked to read, and the same
    // mistake `contracts/version.ts` avoids by copying the clauses it is handed.
    Object.freeze({
      movementId: movement.movementId,
      itemId: movement.itemId,
      organizationId: movement.organizationId,
      direction: movement.direction,
      quantity: movement.quantity,
      at: movement.at,
      reason: movement.reason,
      reference: movement.reference,
    }),
  ]);

  return Object.freeze({
    movements,
    onHand,
    lastMovementAt: movement.at,
  });
}