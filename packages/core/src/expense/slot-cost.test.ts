import { describe, expect, it } from "vitest";

import { money } from "../money/index.js";
import { computeSlotCost, computeTotalSlotCost } from "./slot-cost.js";

const INR = "INR";

describe("computeSlotCost", () => {
  it("is exactly rate x number_of_slots, with no percentage, deduction or rounding", () => {
    // ADR-0016 §3: integer multiplication, full stop. Recovered from
    // automation-scripts/04-business-logic-automation.sql:12-32.
    expect(computeSlotCost({ ratePerSlot: money("500", INR), numberOfSlots: 3 }).toDecimal()).toBe("1500.0000");
  });

  it("preserves all four decimal places through the multiply", () => {
    expect(computeSlotCost({ ratePerSlot: money("499.9999", INR), numberOfSlots: 7 }).toDecimal()).toBe("3499.9993");
  });

  it("keeps the currency of the rate card", () => {
    const cost = computeSlotCost({ ratePerSlot: money("1200", "USD"), numberOfSlots: 2 });
    expect(cost.currency).toBe("USD");
    expect(cost.toDecimal()).toBe("2400.0000");
  });

  it("charges nothing for zero slots", () => {
    expect(computeSlotCost({ ratePerSlot: money("500", INR), numberOfSlots: 0 }).toDecimal()).toBe("0.0000");
  });

  it("scales linearly, so doubling slots doubles cost with no drift", () => {
    const rate = money("333.3333", INR);
    const one = computeSlotCost({ ratePerSlot: rate, numberOfSlots: 1 });
    const three = computeSlotCost({ ratePerSlot: rate, numberOfSlots: 3 });

    expect(three.equals(one.multiply(3n))).toBe(true);
    expect(three.toDecimal()).toBe("999.9999");
  });

  it("does not round, because integer minor units need no rounding", () => {
    // A third of 1000 is not representable in minor units. The rule is a
    // multiply, so the result must be exactly 1000 * 3 / 3 = 1000 with no
    // invented fraction of a paisa.
    expect(computeSlotCost({ ratePerSlot: money("1000", INR), numberOfSlots: 3 }).toDecimal()).toBe("3000.0000");
    expect(computeSlotCost({ ratePerSlot: money("0.0001", INR), numberOfSlots: 1 }).toDecimal()).toBe("0.0001");
  });

  it("allows a fractional money rate, because the rate card is numeric(18,4)", () => {
    expect(computeSlotCost({ ratePerSlot: money("12.5", INR), numberOfSlots: 4 }).toDecimal()).toBe("50.0000");
  });

  it("rejects a negative slot count rather than crediting the organisation", () => {
    expect(() => computeSlotCost({ ratePerSlot: money("500", INR), numberOfSlots: -1 })).toThrow(/numberOfSlots/);
  });

  it("rejects a fractional slot count, because a half slot is not a slot", () => {
    expect(() => computeSlotCost({ ratePerSlot: money("500", INR), numberOfSlots: 1.5 })).toThrow(/numberOfSlots/);
  });

  it("rejects a non-finite slot count", () => {
    expect(() => computeSlotCost({ ratePerSlot: money("500", INR), numberOfSlots: Number.NaN })).toThrow(/numberOfSlots/);
  });
});

describe("computeTotalSlotCost", () => {
  it("sums several slot purchases against one rate card", () => {
    const total = computeTotalSlotCost({ ratePerSlot: money("500", INR), purchases: [{ numberOfSlots: 2 }, { numberOfSlots: 3 }] });
    expect(total.toDecimal()).toBe("2500.0000");
  });

  it("returns zero for no purchases rather than throwing", () => {
    expect(computeTotalSlotCost({ ratePerSlot: money("500", INR), purchases: [] }).toDecimal()).toBe("0.0000");
  });

  it("keeps the rate card currency on the total", () => {
    expect(computeTotalSlotCost({ ratePerSlot: money("10", "EUR"), purchases: [{ numberOfSlots: 1 }] }).currency).toBe("EUR");
  });
});