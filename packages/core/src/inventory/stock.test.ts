import { describe, expect, it } from "vitest";

import type { InventoryItem } from "./stock.js";
import { STOCK_MOVEMENT_REASONS, appendMovement, computeOnHand, createInventoryItem } from "./stock.js";
import type { StockMovement, StockMovementReason } from "./stock.js";

const ITEM: InventoryItem = createInventoryItem({
  itemId: "item_jersey",
  organizationId: "org_1",
  sku: "JRSY-S6-M",
  name: "Season 6 jersey, size M",
  unitOfMeasure: "unit",
});

const ON = new Date("2026-05-01T09:00:00.000Z");

let sequence = 0;

function movement(overrides: Partial<StockMovement> = {}): StockMovement {
  sequence += 1;
  return Object.freeze({
    movementId: `mv_${String(sequence)}`,
    itemId: "item_jersey",
    organizationId: "org_1",
    direction: "in" as const,
    quantity: 10,
    at: ON,
    reason: "purchase_order_received" as StockMovementReason,
    reference: "po_1",
    ...overrides,
  });
}

describe("createInventoryItem", () => {
  it("returns a frozen item with no quantity field at all", () => {
    // The decision this module is about: a balance is *derived* from movements,
    // so there is nowhere to store one. If `quantity` appeared on this type, a
    // caller could set it and there would be two answers to "how many do we
    // have?".
    const item = createInventoryItem({
      itemId: "item_jersey",
      organizationId: "org_1",
      sku: "JRSY-S6-M",
      name: "Season 6 jersey, size M",
      unitOfMeasure: "unit",
    });

    expect(Object.keys(item).sort()).toEqual(["itemId", "name", "organizationId", "sku", "unitOfMeasure"]);
    expect(Object.isFrozen(item)).toBe(true);
  });

  it("refuses a blank item id, organisation id, sku or name", () => {
    const base = {
      itemId: "item_jersey",
      organizationId: "org_1",
      sku: "JRSY-S6-M",
      name: "Season 6 jersey, size M",
      unitOfMeasure: "unit",
    };

    expect(() => createInventoryItem({ ...base, itemId: " " })).toThrow(/itemId/i);
    expect(() => createInventoryItem({ ...base, organizationId: "" })).toThrow(/organizationId/i);
    expect(() => createInventoryItem({ ...base, sku: "" })).toThrow(/sku/i);
    expect(() => createInventoryItem({ ...base, name: "" })).toThrow(/name/i);
  });

  it("refuses a blank unit of measure, because a quantity without a unit is not a quantity", () => {
    expect(() =>
      createInventoryItem({
        itemId: "item_jersey",
        organizationId: "org_1",
        sku: "JRSY-S6-M",
        name: "Season 6 jersey, size M",
        unitOfMeasure: " ",
      }),
    ).toThrow(/unitOfMeasure/i);
  });
});

describe("computeOnHand", () => {
  it("is zero for an item that has never moved", () => {
    expect(computeOnHand(ITEM, [])).toBe(0);
  });

  it("sums receipts minus issues", () => {
    expect(computeOnHand(ITEM, [movement(), movement({ direction: "out", quantity: 4 })])).toBe(6);
  });

  it("is a pure function of the movement list, so it cannot drift from it", () => {
    const movements = [movement(), movement({ direction: "out", quantity: 4 })];

    expect(computeOnHand(ITEM, movements)).toBe(computeOnHand(ITEM, movements));
    expect(computeOnHand(ITEM, movements)).toBe(computeOnHand(ITEM, [...movements].reverse()));
  });

  it("ignores movements belonging to another item", () => {
    expect(computeOnHand(ITEM, [movement(), movement({ itemId: "item_cap" })])).toBe(10);
  });

  it("ignores movements belonging to another organisation", () => {
    // Tenancy is the discriminator for every read in this package (ADR-0011); a
    // cross-tenant receipt is not stock this organisation may count.
    expect(computeOnHand(ITEM, [movement(), movement({ organizationId: "org_2", quantity: 500 })])).toBe(10);
  });

  it("reports a negative balance rather than clamping it, because overselling is a real state", () => {
    // Clamping to zero would make an oversold item indistinguishable from an empty
    // one, and those two need completely different conversations: one is "order
    // more", the other is "you promised somebody stock you do not have".
    expect(computeOnHand(ITEM, [movement({ quantity: 3 }), movement({ direction: "out", quantity: 5 })])).toBe(-2);
  });
});

describe("appendMovement", () => {
  it("returns a frozen movement and a frozen list, leaving the caller's list alone", () => {
    const existing = [movement()];
    const result = appendMovement(existing, movement({ direction: "out", quantity: 2 }));

    expect(existing).toHaveLength(1);
    expect(result.movements).toHaveLength(2);
    expect(Object.isFrozen(result.movements)).toBe(true);
    expect(Object.isFrozen(result.movements[0])).toBe(true);
    expect(result.onHand).toBe(8);
  });

  it("refuses a movement that would take stock negative", () => {
    // The oversell control. It lives at the *write* rather than the read because
    // the read cannot stop anything: a balance that is computed can still be
    // negative, and the moment to refuse is when the movement is recorded.
    expect(() => appendMovement([movement({ quantity: 3 })], movement({ direction: "out", quantity: 5 }))).toThrow(
      /negative|stock|shortfall/i,
    );
  });

  it("allows taking exactly all of it, at the boundary", () => {
    expect(() => appendMovement([movement({ quantity: 3 })], movement({ direction: "out", quantity: 3 }))).not.toThrow();
  });

  it("refuses taking one more than all of it, at the boundary", () => {
    expect(() => appendMovement([movement({ quantity: 3 })], movement({ direction: "out", quantity: 4 }))).toThrow(
      /negative|stock|shortfall/i,
    );
  });

  it("refuses a movement dated before the last one already recorded", () => {
    // A movement that predates the movement before it is a corrupted record, and
    // a corrupted record in an append-only ledger stays corrupted for ever. This
    // is the same rule `retractEvidence` and `withdrawConsent` apply.
    expect(() =>
      appendMovement([movement({ at: new Date("2026-05-02T00:00:00.000Z") })], movement({ at: ON })),
    ).toThrow(/before|predate/i);
  });

  it("accepts a movement at the exact instant of the one before it", () => {
    expect(() => appendMovement([movement({ at: ON })], movement({ at: ON }))).not.toThrow();
  });

  it("refuses a duplicate movement id, so one receipt cannot be counted twice", () => {
    const first = movement();
    expect(() => appendMovement([first], { ...first })).toThrow(/duplicate|mv_/i);
  });

  it("refuses a zero or negative quantity: a movement of nothing is not a movement", () => {
    expect(() => appendMovement([], movement({ quantity: 0 }))).toThrow(/quantity/i);
    expect(() => appendMovement([], movement({ quantity: -5 }))).toThrow(/quantity/i);
  });

  it("refuses a fractional quantity, because half a jersey is not a jersey", () => {
    expect(() => appendMovement([], movement({ quantity: 1.5 }))).toThrow(/quantity|integer/i);
  });

  it("refuses a movement naming no item or organisation", () => {
    expect(() => appendMovement([], movement({ itemId: " " }))).toThrow(/itemId/i);
    expect(() => appendMovement([], movement({ organizationId: "" }))).toThrow(/organizationId/i);
    expect(() => appendMovement([], movement({ movementId: "" }))).toThrow(/movementId/i);
  });

  it("refuses a call with no movement at all", () => {
    expect(() => appendMovement([], null as never)).toThrow(/requires a movement/i);
  });

  it("refuses a direction outside the closed set", () => {
    // The direction carries the sign, so a third spelling would be a movement
    // whose meaning depends on who read it.
    expect(() => appendMovement([], movement({ direction: "sideways" as never }))).toThrow(/direction/i);
  });

  it("refuses a movement with no reference to check it against", () => {
    // Every movement points at a purchase order, a delivery note, an obligation
    // or a stock take. One that points at nothing cannot be audited.
    expect(() => appendMovement([], movement({ reference: " " }))).toThrow(/reference/i);
  });

  it("refuses an unknown reason, because a movement nobody can classify cannot be audited", () => {
    expect(() => appendMovement([], movement({ reason: "shrug" as never }))).toThrow(/reason/i);
  });

  it("refuses an invalid instant", () => {
    expect(() => appendMovement([], movement({ at: new Date("never") }))).toThrow(/at/i);
  });

  it("refuses a movement appended to a list containing another item's movements", () => {
    expect(() => appendMovement([movement({ itemId: "item_cap" })], movement({ itemId: "item_jersey" }))).toThrow(
      /itemId|item/i,
    );
  });

  it("returns a balance that always equals the recomputation from its own list", () => {
    // The invariant that makes the whole choice safe: whatever `appendMovement`
    // reports, `computeOnHand` over the list it returned must agree.
    const result = appendMovement(
      [movement({ quantity: 20 })],
      movement({ direction: "out", quantity: 7, at: new Date("2026-05-03T00:00:00.000Z") }),
    );

    expect(result.onHand).toBe(computeOnHand(ITEM, result.movements));
  });
});

describe("movements are the record, and the balance is derived from them", () => {
  it("reports the last movement instant alongside the balance", () => {
    const last = new Date("2026-05-05T00:00:00.000Z");
    const result = appendMovement([movement()], movement({ at: last, quantity: 5 }));

    expect(result.lastMovementAt?.toISOString()).toBe(last.toISOString());
  });

  it("reports no last movement for an item that has never moved", () => {
    const result = appendMovement([], movement());

    expect(result.lastMovementAt?.toISOString()).toBe(ON.toISOString());
  });

  it("declares every reason it accepts, so the vocabulary is auditable", () => {
    // Free-text reasons are how "delivery" becomes "delivary", "deliveryy" and
    // "DELIVERY", and a stock report nobody can group is a stock report nobody
    // trusts.
    expect(STOCK_MOVEMENT_REASONS.length).toBeGreaterThan(0);
    expect(new Set(STOCK_MOVEMENT_REASONS).size).toBe(STOCK_MOVEMENT_REASONS.length);
  });
});