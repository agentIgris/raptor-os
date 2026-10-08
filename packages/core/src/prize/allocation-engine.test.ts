import { describe, expect, it } from "vitest";

import {
  allocatePrizePool,
  applyAdjustment,
  type AllocationBasis,
  type PrizeParticipant,
} from "./allocation-engine.js";
import { money } from "../money/index.js";

/**
 * The prize allocation engine is the product's differentiator.
 *
 * These tests encode the four non-negotiable properties from the design spec:
 * deterministic, reproducible, explainable, immutable — plus the reconciliation
 * invariant that makes the whole thing auditable.
 */

const INR = "INR";

function participants(...ids: string[]): PrizeParticipant[] {
  return ids.map((personId) => ({ personId, kind: "roster" as const }));
}

describe("money", () => {
  it("represents decimal amounts exactly without floating point drift", () => {
    expect(money("0.1", INR).minor + money("0.2", INR).minor).toBe(money("0.3", INR).minor);
  });

  it("keeps four decimal places of precision", () => {
    expect(money("1000.0001", INR).minor).toBe(10_000_001n);
  });

  it("rejects amounts with more than four decimal places", () => {
    expect(() => money("0.00001", INR)).toThrow(/precision/i);
  });

  it("rejects malformed amounts", () => {
    expect(() => money("not-a-number", INR)).toThrow();
    expect(() => money("10.5", "")).toThrow(/currency/i);
  });

  it("refuses to combine two different currencies", () => {
    expect(() => money("1.00", INR).add(money("1.00", "USD"))).toThrow(/currency/i);
  });

  it("sums a large pool without loss", () => {
    const many = Array.from({ length: 1000 }, () => money("0.0001", INR));
    const total = many.reduce((acc, m) => acc.add(m), money("0", INR));
    expect(total.toDecimal()).toBe("0.1000");
  });
});

describe("allocatePrizePool", () => {
  describe("rejects invalid input before computing", () => {
    it("throws when the participant set is empty", () => {
      expect(() =>
        allocatePrizePool({
          netPrize: money("1000.00", INR),
          participants: [],
          rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
        }),
      ).toThrow(/participant/i);
    });

    it("throws on duplicate participants", () => {
      expect(() =>
        allocatePrizePool({
          netPrize: money("1000.00", INR),
          participants: participants("p1", "p1"),
          rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
        }),
      ).toThrow(/duplicate/i);
    });

    it("throws when a negative net prize is supplied", () => {
      expect(() =>
        allocatePrizePool({
          netPrize: money("-1.00", INR),
          participants: participants("p1"),
          rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
        }),
      ).toThrow(/negative/i);
    });
  });

  describe("per_head basis", () => {
    it("splits equally and satisfies the reconciliation invariant exactly", () => {
      const result = allocatePrizePool({
        netPrize: money("1000.00", INR),
        participants: participants("p1", "p2", "p3"),
        rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
      });

      const total = result.allocations.reduce((acc, a) => acc.add(a.computedAmount), money("0", INR));
      expect(total.toDecimal()).toBe("1000.0000");
      expect(result.reconciliation.isBalanced).toBe(true);
      expect(result.reconciliation.variance.toDecimal()).toBe("0.0000");
    });

    it("assigns the indivisible remainder deterministically by stable sort", () => {
      // 1000.00 across 3 people cannot divide exactly: 333.3333 x3 = 999.9999
      const result = allocatePrizePool({
        netPrize: money("1000.00", INR),
        participants: participants("p3", "p1", "p2"),
        rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
      });

      const byPerson = Object.fromEntries(result.allocations.map((a) => [a.personId, a.computedAmount.toDecimal()]));

      // The residual cent goes to the lexicographically-first participant id, not input order.
      expect(byPerson["p1"]).toBe("333.3334");
      expect(byPerson["p2"]).toBe("333.3333");
      expect(byPerson["p3"]).toBe("333.3333");
    });

    it("produces identical output across repeated runs", () => {
      const input = {
        netPrize: money("777.77", INR),
        participants: participants("p9", "p4", "p7", "p1"),
        rule: { version: 3, basis: "per_head" as AllocationBasis, remainderPolicy: "largest_remainder_stable_sort" as const },
      };

      const first = allocatePrizePool(input);
      const second = allocatePrizePool({ ...input, participants: [...input.participants].reverse() });

      expect(second.allocations.map((a) => [a.personId, a.computedAmount.toDecimal()])).toEqual(
        [...first.allocations].sort((a, b) => a.personId.localeCompare(b.personId)).map((a) => [a.personId, a.computedAmount.toDecimal()]),
      );
    });
  });

  describe("percentage basis", () => {
    it("distributes strictly by the stated percentages", () => {
      const result = allocatePrizePool({
        netPrize: money("10000.00", INR),
        participants: participants("p1", "p2"),
        rule: {
          version: 1,
          basis: "percentage",
          percentages: { p1: "60", p2: "40" },
          remainderPolicy: "largest_remainder_stable_sort",
        },
      });

      const byPerson = Object.fromEntries(result.allocations.map((a) => [a.personId, a.computedAmount.toDecimal()]));
      expect(byPerson["p1"]).toBe("6000.0000");
      expect(byPerson["p2"]).toBe("4000.0000");
    });

    it("distributes the whole pool when percentages sum to exactly 100", () => {
      const result = allocatePrizePool({
        netPrize: money("1000.00", INR),
        participants: participants("p1", "p2", "p3"),
        rule: {
          version: 1,
          basis: "percentage",
          percentages: { p1: "40", p2: "30", p3: "30" },
          remainderPolicy: "largest_remainder_stable_sort",
        },
      });

      const byPerson = Object.fromEntries(result.allocations.map((a) => [a.personId, a.computedAmount.toDecimal()]));
      expect(byPerson["p1"]).toBe("400.0000");
      expect(byPerson["p2"]).toBe("300.0000");
      expect(byPerson["p3"]).toBe("300.0000");
      expect(result.unallocated.toDecimal()).toBe("0.0000");
      expect(result.reconciliation.isBalanced).toBe(true);
    });

    it("reports an unallocated remainder when percentages sum below 100", () => {
      const result = allocatePrizePool({
        netPrize: money("1000.00", INR),
        participants: participants("p1", "p2"),
        rule: {
          version: 1,
          basis: "percentage",
          percentages: { p1: "30", p2: "30" },
          remainderPolicy: "largest_remainder_stable_sort",
        },
      });

      expect(result.unallocated.toDecimal()).toBe("400.0000");
    });

    it("throws when a participant has no percentage defined", () => {
      expect(() =>
        allocatePrizePool({
          netPrize: money("1000.00", INR),
          participants: participants("p1", "p2"),
          rule: {
            version: 1,
            basis: "percentage",
            percentages: { p1: "100" },
            remainderPolicy: "largest_remainder_stable_sort",
          },
        }),
      ).toThrow(/percentage/i);
    });

    it("throws when percentages sum above 100", () => {
      expect(() =>
        allocatePrizePool({
          netPrize: money("1000.00", INR),
          participants: participants("p1", "p2"),
          rule: {
            version: 1,
            basis: "percentage",
            percentages: { p1: "70", p2: "70" },
            remainderPolicy: "largest_remainder_stable_sort",
          },
        }),
      ).toThrow(/exceed/i);
    });
  });

  describe("fixed_plus_percentage basis", () => {
    it("deducts fixed amounts from the pool, then splits the remainder by percentage", () => {
      const result = allocatePrizePool({
        netPrize: money("10000.00", INR),
        participants: participants("p1", "p2"),
        rule: {
          version: 1,
          basis: "fixed_plus_percentage",
          fixedAmounts: { p1: "500.00", p2: "0.00" },
          poolPercentage: { p1: "25", p2: "75" },
          remainderPolicy: "largest_remainder_stable_sort",
        },
      });

      // Fixed total 500 is taken off the top; the remaining 9500 splits 25/75.
      const byPerson = Object.fromEntries(result.allocations.map((a) => [a.personId, a.computedAmount.toDecimal()]));
      expect(byPerson["p1"]).toBe("2875.0000");
      expect(byPerson["p2"]).toBe("7125.0000");
      expect(result.reconciliation.isBalanced).toBe(true);
    });

    it("refuses to over-allocate the pool when fixed amounts exceed it", () => {
      expect(() =>
        allocatePrizePool({
          netPrize: money("1000.00", INR),
          participants: participants("p1", "p2"),
          rule: {
            version: 1,
            basis: "fixed_plus_percentage",
            fixedAmounts: { p1: "900.00", p2: "900.00" },
            poolPercentage: { p1: "50", p2: "50" },
            remainderPolicy: "largest_remainder_stable_sort",
          },
        }),
      ).toThrow(/exceed|over-allocat/i);
    });

    it("refuses percentages that sum above 100", () => {
      expect(() =>
        allocatePrizePool({
          netPrize: money("1000.00", INR),
          participants: participants("p1", "p2"),
          rule: {
            version: 1,
            basis: "fixed_plus_percentage",
            fixedAmounts: { p1: "0.00", p2: "0.00" },
            poolPercentage: { p1: "60", p2: "60" },
            remainderPolicy: "largest_remainder_stable_sort",
          },
        }),
      ).toThrow(/exceed/i);
    });

    it("throws when a participant has no pool percentage defined", () => {
      expect(() =>
        allocatePrizePool({
          netPrize: money("1000.00", INR),
          participants: participants("p1", "p2"),
          rule: {
            version: 1,
            basis: "fixed_plus_percentage",
            fixedAmounts: { p1: "0.00", p2: "0.00" },
            poolPercentage: { p1: "100" },
            remainderPolicy: "largest_remainder_stable_sort",
          },
        }),
      ).toThrow(/pool percentage/i);
    });

    it("treats an unallocated percentage remainder as unallocated money", () => {
      const result = allocatePrizePool({
        netPrize: money("1000.00", INR),
        participants: participants("p1", "p2"),
        rule: {
          version: 1,
          basis: "fixed_plus_percentage",
          fixedAmounts: { p1: "0.00", p2: "0.00" },
          poolPercentage: { p1: "30", p2: "30" },
          remainderPolicy: "largest_remainder_stable_sort",
        },
      });

      expect(result.unallocated.toDecimal()).toBe("400.0000");
    });
  });

  describe("weighted_by_participation basis", () => {
    it("distributes proportionally to frozen participation weights", () => {
      const result = allocatePrizePool({
        netPrize: money("900.00", INR),
        participants: [
          { personId: "p1", kind: "roster", weight: 3n },
          { personId: "p2", kind: "roster", weight: 1n },
        ],
        rule: { version: 1, basis: "weighted_by_participation", remainderPolicy: "largest_remainder_stable_sort" },
      });

      const byPerson = Object.fromEntries(result.allocations.map((a) => [a.personId, a.computedAmount.toDecimal()]));
      expect(byPerson["p1"]).toBe("675.0000");
      expect(byPerson["p2"]).toBe("225.0000");
    });

    it("throws when a participant has no weight", () => {
      expect(() =>
        allocatePrizePool({
          netPrize: money("100.00", INR),
          participants: [{ personId: "p1", kind: "roster", weight: 1n }, { personId: "p2", kind: "roster" }],
          rule: { version: 1, basis: "weighted_by_participation", remainderPolicy: "largest_remainder_stable_sort" },
        }),
      ).toThrow(/weight/i);
    });

    it("throws when every weight is zero", () => {
      expect(() =>
        allocatePrizePool({
          netPrize: money("100.00", INR),
          participants: [
            { personId: "p1", kind: "roster", weight: 0n },
            { personId: "p2", kind: "roster", weight: 0n },
          ],
          rule: { version: 1, basis: "weighted_by_participation", remainderPolicy: "largest_remainder_stable_sort" },
        }),
      ).toThrow(/weight/i);
    });
  });

  describe("reproducibility and explainability", () => {
    it("stamps every allocation with the rule version used", () => {
      const result = allocatePrizePool({
        netPrize: money("500.00", INR),
        participants: participants("p1", "p2"),
        rule: { version: 7, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
      });

      expect(result.allocations.every((a) => a.ruleVersion === 7)).toBe(true);
    });

    it("persists a human-readable derivation on every allocation", () => {
      const result = allocatePrizePool({
        netPrize: money("1000.00", INR),
        participants: participants("p1", "p2"),
        rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
      });

      for (const allocation of result.allocations) {
        expect(allocation.explanation).toContain(allocation.personId);
        expect(allocation.explanation).toContain("per_head");
        expect(allocation.explanation).toContain("1000.0000");
      }
    });

    it("computes a content hash of its inputs so a divergent re-run can be rejected", () => {
      const input = {
        netPrize: money("1000.00", INR),
        participants: participants("p1", "p2"),
        rule: { version: 1, basis: "per_head" as AllocationBasis, remainderPolicy: "largest_remainder_stable_sort" as const },
      };

      const first = allocatePrizePool(input);
      const second = allocatePrizePool(input);
      expect(second.inputHash).toBe(first.inputHash);

      const different = allocatePrizePool({ ...input, netPrize: money("1000.01", INR) });
      expect(different.inputHash).not.toBe(first.inputHash);
    });

    it("records the computedAt timestamp supplied by the caller, never its own clock", () => {
      const at = new Date("2026-01-15T10:30:00.000Z");
      const result = allocatePrizePool({
        netPrize: money("100.00", INR),
        participants: participants("p1"),
        rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
        computedAt: at,
      });

      expect(result.allocations[0]!.computedAt.toISOString()).toBe("2026-01-15T10:30:00.000Z");
    });

    it("records who performed the computation", () => {
      const result = allocatePrizePool({
        netPrize: money("100.00", INR),
        participants: participants("p1"),
        rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
        computedBy: "svc:allocation-engine",
      });

      expect(result.allocations[0]!.computedBy).toBe("svc:allocation-engine");
    });
  });

  describe("adjustments", () => {
    it("re-reconciles when an adjustment reallocates within the pool, never mutating an allocation", () => {
      const first = allocatePrizePool({
        netPrize: money("1000.00", INR),
        participants: participants("p1", "p2"),
        rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
      });

      // A correction that moves value between participants must leave the pool intact.
      const second = applyAdjustment({
        previous: first,
        adjustments: [
          { personId: "p1", amount: money("-50.00", INR), reason: "share correction" },
          { personId: "p2", amount: money("50.00", INR), reason: "share correction" },
        ],
        computedAt: new Date("2026-02-01T00:00:00.000Z"),
      });

      const total = second.allocations.reduce((acc, a) => acc.add(a.computedAmount), money("0", INR));
      expect(total.toDecimal()).toBe("1000.0000");
      expect(second.reconciliation.isBalanced).toBe(true);

      const byPerson = Object.fromEntries(second.allocations.map((a) => [a.personId, a.computedAmount.toDecimal()]));
      expect(byPerson["p1"]).toBe("450.0000");
      expect(byPerson["p2"]).toBe("550.0000");

      // The original allocation objects are untouched.
      expect(first.allocations.find((a) => a.personId === "p2")!.computedAmount.toDecimal()).toBe("500.0000");
    });

    it("reports a variance with an explanation when adjustments push the pool out of balance", () => {
      const first = allocatePrizePool({
        netPrize: money("1000.00", INR),
        participants: participants("p1", "p2"),
        rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
      });

      const second = applyAdjustment({
        previous: first,
        adjustments: [{ personId: "p2", amount: money("100.00", INR), reason: "goodwill" }],
        computedAt: new Date("2026-02-01T00:00:00.000Z"),
      });

      expect(second.reconciliation.isBalanced).toBe(false);
      expect(second.reconciliation.explanation).toContain("variance");
    });

    it("rejects an adjustment for an unknown participant", () => {
      const first = allocatePrizePool({
        netPrize: money("100.00", INR),
        participants: participants("p1"),
        rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
      });

      expect(() =>
        applyAdjustment({
          previous: first,
          adjustments: [{ personId: "ghost", amount: money("1.00", INR), reason: "typo" }],
          computedAt: new Date(),
        }),
      ).toThrow(/participant/i);
    });

    it("falls back to a service principal when no actor is supplied", () => {
      const first = allocatePrizePool({
        netPrize: money("100.00", INR),
        participants: participants("p1"),
        rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
      });

      const second = applyAdjustment({
        previous: first,
        adjustments: [{ personId: "p1", amount: money("-10.00", INR), reason: "clawback" }],
      });

      expect(second.allocations[0]!.computedBy).toBe("svc:allocation-engine");
      expect(second.allocations[0]!.computedAt).toBeInstanceOf(Date);
    });

    it("accumulates several adjustments to the same participant", () => {
      const first = allocatePrizePool({
        netPrize: money("1000.00", INR),
        participants: participants("p1", "p2"),
        rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
      });

      const second = applyAdjustment({
        previous: first,
        adjustments: [
          { personId: "p1", amount: money("-20.00", INR), reason: "correction" },
          { personId: "p1", amount: money("-30.00", INR), reason: "further correction" },
          { personId: "p2", amount: money("50.00", INR), reason: "rebalance" },
        ],
        computedAt: new Date("2026-03-01T00:00:00.000Z"),
      });

      const byPerson = Object.fromEntries(second.allocations.map((a) => [a.personId, a.computedAmount.toDecimal()]));
      expect(byPerson["p1"]).toBe("450.0000");
      expect(byPerson["p2"]).toBe("550.0000");
      expect(second.reconciliation.isBalanced).toBe(true);
    });

    it("produces a stable input hash regardless of percentage key order", () => {
      const base = {
        netPrize: money("1000.00", INR),
        participants: participants("p1", "p2"),
      };

      const a = allocatePrizePool({
        ...base,
        rule: {
          version: 4,
          basis: "percentage",
          percentages: { p1: "40", p2: "60" },
          remainderPolicy: "largest_remainder_stable_sort",
        },
      });

      const b = allocatePrizePool({
        ...base,
        rule: {
          version: 4,
          basis: "percentage",
          percentages: { p2: "60", p1: "40" },
          remainderPolicy: "largest_remainder_stable_sort",
        },
      });

      expect(b.inputHash).toBe(a.inputHash);
    });
  });

  describe("allocation-level invariants under fuzz", () => {
    it("never loses or invents money across randomised pools and rosters", () => {
      // Deterministic pseudo-random: a seeded LCG, so failures are reproducible.
      let seed = 987654321n;
      const next = () => {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
        return seed >> 33n;
      };

      for (let trial = 0; trial < 500; trial++) {
        const headCount = 1 + Number(next() % 9n);
        const ids = Array.from({ length: headCount }, (_, i) => `p${String(i).padStart(2, "0")}`);

        const whole = next() % 1_000_000n;
        const frac = next() % 10_000n;
        const netPrize = money(`${whole}.${String(frac).padStart(4, "0")}`, INR);

        const result = allocatePrizePool({
          netPrize,
          participants: ids.map((personId) => ({ personId, kind: "roster" as const })),
          rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
        });

        const total = result.allocations.reduce((acc, a) => acc.add(a.computedAmount), money("0", INR));
        const unallocated = result.unallocated;

        expect(total.add(unallocated).toDecimal(), `trial ${trial}`).toBe(netPrize.toDecimal());
        expect(result.reconciliation.isBalanced, `trial ${trial}`).toBe(true);
      }
    });
  });
});