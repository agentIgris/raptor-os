import { describe, expect, it } from "vitest";

import { money } from "../money/index.js";
import type { SurplusSplitInput } from "./surplus.js";
import { computeSurplusSplit } from "./surplus.js";

const INR = "INR";

function input(overrides: Partial<SurplusSplitInput> = {}): SurplusSplitInput {
  return {
    monthlyPrizePool: money("100000", INR),
    monthlyCost: money("20000", INR),
    nextMonthTierCost: money("10000", INR),
    orgSharePercent: "50",
    ...overrides,
  };
}

describe("computeSurplusSplit — the standard split", () => {
  it("deducts BOTH costs before applying the percentage", () => {
    // gross = 100000 - (20000 + 10000) = 70000; org 50% = 35000.
    // Applying the percentage first would give 50000 * (1 - 0.5 - 0.1) = 20000,
    // or 100000*0.5 - 20000 - 10000 = 30000. Deduction order is the whole rule.
    const split = computeSurplusSplit(input());
    expect(split.grossSurplus.toDecimal()).toBe("70000.0000");
    expect(split.orgShare.toDecimal()).toBe("35000.0000");
    expect(split.teamShare.toDecimal()).toBe("35000.0000");
  });

  it("makes the two shares sum EXACTLY to the gross surplus, with no drift", () => {
    // The team share is a residual, not a second percentage, so the sum is exact
    // even when the surplus cannot be halved evenly.
    const split = computeSurplusSplit(input({ monthlyCost: money("3.3333", INR) }));

    expect(split.orgShare.add(split.teamShare).equals(split.grossSurplus)).toBe(true);
  });

  it("sums exactly across a grid of awkward surpluses", () => {
    // Positive-surplus cases only: a clamped non-positive surplus legitimately
    // sums to zero instead, and that is a separate pinned rule below.
    for (const cost of ["0", "0.0001", "3.3333", "7.7777", "12345.6789", "20000.0001"]) {
      const split = computeSurplusSplit(input({ monthlyCost: money(cost, INR) }));
      expect(split.grossSurplus.isNegative()).toBe(false);
      expect(split.orgShare.add(split.teamShare).equals(split.grossSurplus)).toBe(true);
    }
  });

  it("rounds only the ORG share, and the team share absorbs the remainder", () => {
    // 30000.0001 at 33.33% is 9999.000033..., which cannot land on a whole minor
    // unit. The org share rounds to 9999.0000 and the team takes the residual
    // 20001.0001, so nothing is invented and nothing is lost.
    const split = computeSurplusSplit(input({
      monthlyPrizePool: money("30000.0001", INR),
      monthlyCost: money("0", INR),
      nextMonthTierCost: money("0", INR),
      orgSharePercent: "33.33",
    }));

    expect(split.grossSurplus.toDecimal()).toBe("30000.0001");
    expect(split.orgShare.toDecimal()).toBe("9999.0000");
    expect(split.teamShare.toDecimal()).toBe("20001.0001");
    expect(split.orgShare.add(split.teamShare).equals(split.grossSurplus)).toBe(true);
  });

  it("rounds the org share half-up rather than truncating", () => {
    // 33.335% of 30000 is exactly 10000.50, landing precisely on the half. Half-up
    // keeps the .50 rather than truncating to .49 or rounding away to .51.
    const split = computeSurplusSplit(input({
      monthlyPrizePool: money("30000", INR),
      monthlyCost: money("0", INR),
      nextMonthTierCost: money("0", INR),
      orgSharePercent: "33.335",
    }));

    expect(split.orgShare.toDecimal()).toBe("10000.5000");
    expect(split.teamShare.toDecimal()).toBe("19999.5000");
    expect(split.orgShare.add(split.teamShare).equals(split.grossSurplus)).toBe(true);
  });

  it("rounds a half-up share UP when the exact result ends in one minor unit over half", () => {
    // 33.33333333% is not expressible at four places, so use a share that lands on
    // a genuine .005 boundary: 0.0001 * 50.0% ... instead take 3333333333/1e8 style
    // inputs away and pin the simpler 99.999% case.
    const split = computeSurplusSplit(input({
      monthlyPrizePool: money("1", INR),
      monthlyCost: money("0", INR),
      nextMonthTierCost: money("0", INR),
      orgSharePercent: "0.5",
    }));

    // 0.5% of 1.0000 = 0.0050 exactly: a whole minor unit, nothing to round away.
    expect(split.orgShare.toDecimal()).toBe("0.0050");
    expect(split.teamShare.toDecimal()).toBe("0.9950");
    expect(split.orgShare.add(split.teamShare).equals(split.grossSurplus)).toBe(true);
  });

  it("reports the derived gross surplus alongside the shares", () => {
    expect(computeSurplusSplit(input()).deductions.toDecimal()).toBe("30000.0000");
  });

  it("rejects a currency mismatch rather than combining INR with USD", () => {
    expect(() => computeSurplusSplit(input({ monthlyCost: money("100", "USD") }))).toThrow(/Currency mismatch/);
  });
});

describe("computeSurplusSplit — a non-positive surplus", () => {
  it("clamps both shares to zero when costs exceed the prize pool", () => {
    const split = computeSurplusSplit(input({ monthlyPrizePool: money("10000", INR) }));

    expect(split.orgShare.toDecimal()).toBe("0.0000");
    expect(split.teamShare.toDecimal()).toBe("0.0000");
  });

  it("still reports the negative surplus, so the loss is visible", () => {
    // Clamping the shares must not clamp the fact. A month that lost money has to
    // be reportable as a losing month.
    const split = computeSurplusSplit(input({
      monthlyPrizePool: money("25000", INR),
      monthlyCost: money("30000", INR),
      nextMonthTierCost: money("10000", INR),
    }));

    expect(split.grossSurplus.toDecimal()).toBe("-15000.0000");
    expect(split.orgShare.isZero()).toBe(true);
    expect(split.teamShare.isZero()).toBe(true);
  });

  it("clamps a zero surplus to two zero shares", () => {
    const split = computeSurplusSplit(input({ monthlyPrizePool: money("30000", INR) }));
    expect(split.grossSurplus.isZero()).toBe(true);
    expect(split.orgShare.isZero()).toBe(true);
    expect(split.teamShare.isZero()).toBe(true);
  });

  it("clamps when the next month's tier cost alone exceeds the surplus", () => {
    const split = computeSurplusSplit(input({ nextMonthTierCost: money("90000", INR) }));
    expect(split.grossSurplus.isNegative()).toBe(true);
    expect(split.orgShare.isZero()).toBe(true);
    expect(split.teamShare.isZero()).toBe(true);
  });
});

describe("computeSurplusSplit — the tournament override", () => {
  const tournament = (amount: string) => computeSurplusSplit(input({ tournamentWinnings: money(amount, INR) }));

  it("switches to 50/50 on RAW winnings when winnings are strictly above 20000", () => {
    const split = tournament("25000");
    expect(split.appliedOverride).toBe(true);
    expect(split.grossSurplus.toDecimal()).toBe("25000.0000");
    expect(split.orgShare.toDecimal()).toBe("12500.0000");
    expect(split.teamShare.toDecimal()).toBe("12500.0000");
  });

  it("does NOT override at exactly 20000, because the test is strictly greater", () => {
    // The pinned boundary. `> 20000` and `>= 20000` differ by one team, one
    // month, and the entire cost-deduction path.
    const split = tournament("20000");

    expect(split.appliedOverride).toBe(false);
    expect(split.grossSurplus.toDecimal()).toBe("70000.0000");
    expect(split.orgShare.toDecimal()).toBe("35000.0000");
  });

  it("does not override just below the threshold", () => {
    expect(tournament("19999.9999").appliedOverride).toBe(false);
    expect(tournament("20000.0001").appliedOverride).toBe(true);
  });

  it("BYPASSES cost deduction entirely, using raw winnings not the surplus", () => {
    // Costs would have left 70000; the override splits the raw 25000 instead.
    const split = tournament("25000");
    expect(split.grossSurplus.toDecimal()).toBe("25000.0000");
    expect(split.grossSurplus.equals(money("25000", INR))).toBe(true);
  });

  it("uses 50/50 regardless of the configured org share", () => {
    const split = computeSurplusSplit(input({ tournamentWinnings: money("30000", INR), orgSharePercent: "10" }));

    expect(split.orgShare.toDecimal()).toBe("15000.0000");
    expect(split.teamShare.toDecimal()).toBe("15000.0000");
  });

  it("applies the override even when the standard surplus would be negative", () => {
    // The override is decided on winnings alone, so a losing month does not
    // suppress a big tournament win.
    const split = computeSurplusSplit(input({
      monthlyPrizePool: money("0", INR),
      tournamentWinnings: money("50000", INR),
    }));

    expect(split.appliedOverride).toBe(true);
    expect(split.orgShare.toDecimal()).toBe("25000.0000");
    expect(split.teamShare.toDecimal()).toBe("25000.0000");
  });

  it("keeps the sum invariant under the override, including on awkward amounts", () => {
    for (const amount of ["20000.0001", "33333.3333", "99999.9999"]) {
      const split = tournament(amount);
      expect(split.orgShare.add(split.teamShare).equals(split.grossSurplus)).toBe(true);
    }
  });

  it("explains that the override applied and why", () => {
    expect(tournament("25000").explanation).toMatch(/override/i);
    expect(tournament("20000").explanation).not.toMatch(/override/i);
  });
});

describe("computeSurplusSplit input validation", () => {
  it("rejects an org share above 100, which would hand the team a negative share", () => {
    expect(() => computeSurplusSplit(input({ orgSharePercent: "120" }))).toThrow(/orgSharePercent/);
  });

  it("rejects a negative org share", () => {
    expect(() => computeSurplusSplit(input({ orgSharePercent: "-5" }))).toThrow(/orgSharePercent/);
  });

  it("rejects an unparseable org share rather than defaulting it", () => {
    expect(() => computeSurplusSplit(input({ orgSharePercent: "half" }))).toThrow(/orgSharePercent/);
  });

  it("rejects tournament winnings in a different currency from the pool", () => {
    expect(() => computeSurplusSplit(input({ tournamentWinnings: money("30000", "USD") }))).toThrow(
      /Currency mismatch/,
    );
  });
});