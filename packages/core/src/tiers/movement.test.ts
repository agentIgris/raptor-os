import { describe, expect, it } from "vitest";

import type { ComputeTierMovementInput } from "./movement.js";
import { computeTierMovement, computeWinRatePercent } from "./movement.js";

function input(overrides: Partial<ComputeTierMovementInput> = {}): ComputeTierMovementInput {
  return {
    winRatePercent: 60,
    currentTier: "T3",
    isTrial: false,
    ...overrides,
  };
}

describe("computeTierMovement", () => {
  it("promotes strictly above 50%", () => {
    expect(computeTierMovement(input({ winRatePercent: 50.01, currentTier: "T3" })).movement).toBe("promote");
    expect(computeTierMovement(input({ winRatePercent: 51, currentTier: "T2" })).movement).toBe("promote");
  });

  it("RETAINS at exactly 50.0, because promotion is strictly greater", () => {
    // The pinned boundary. `> 50` is what legacy wrote; anything looser promotes
    // a team that merely held even, and every such team moves up in the same run
    // of the monthly job.
    const result = computeTierMovement(input({ winRatePercent: 50, currentTier: "T2" }));
    expect(result.movement).toBe("retain");
    expect(result.previousTier).toBe("T2");
    expect(result.newTier).toBe("T2");
  });

  it("retains across the whole 35-50 inclusive band", () => {
    expect(computeTierMovement(input({ winRatePercent: 50, currentTier: "T2" })).movement).toBe("retain");
    expect(computeTierMovement(input({ winRatePercent: 42.5, currentTier: "T2" })).movement).toBe("retain");
    expect(computeTierMovement(input({ winRatePercent: 35, currentTier: "T2" })).movement).toBe("retain");
  });

  it("demotes strictly below 35%", () => {
    expect(computeTierMovement(input({ winRatePercent: 34.99, currentTier: "T1" })).movement).toBe("demote");
    expect(computeTierMovement(input({ winRatePercent: 0, currentTier: "T1" })).movement).toBe("demote");
  });

  it("retains at exactly 35.0, because demotion is strictly less than", () => {
    expect(computeTierMovement(input({ winRatePercent: 35, currentTier: "T1" })).movement).toBe("retain");
  });

  it("moves exactly one rung, not to the top", () => {
    expect(computeTierMovement(input({ winRatePercent: 99, currentTier: "T4" })).newTier).toBe("T3");
    expect(computeTierMovement(input({ winRatePercent: 1, currentTier: "godtier" })).newTier).toBe("T1");
  });

  it("clamps a promotion at the top of the ladder", () => {
    const result = computeTierMovement(input({ winRatePercent: 90, currentTier: "godtier" }));
    expect(result.movement).toBe("promote");
    expect(result.newTier).toBe("godtier");
  });

  it("clamps a demotion at the bottom of the ladder", () => {
    const result = computeTierMovement(input({ winRatePercent: 5, currentTier: "T4" }));
    expect(result.movement).toBe("demote");
    expect(result.newTier).toBe("T4");
  });

  it("still reports the movement kind when the clamp leaves the tier unchanged", () => {
    // `promote` with `newTier === previousTier` is not a contradiction: it says
    // "this team earned a promotion and the ladder has nowhere higher to go",
    // which is a different fact from "this team held its tier".
    const result = computeTierMovement(input({ winRatePercent: 90, currentTier: "godtier" }));
    expect(result.movement).toBe("promote");
    expect(result.newTier).toBe(result.previousTier);
  });

  it("reports a reason for every outcome, because the monthly job overwrites tier permanently", () => {
    expect(computeTierMovement(input({ winRatePercent: 60 })).reason).toMatch(/above 50/);
    expect(computeTierMovement(input({ winRatePercent: 40 })).reason).toMatch(/retention band/);
    expect(computeTierMovement(input({ winRatePercent: 10 })).reason).toMatch(/below 35/);
    expect(computeTierMovement(input({ isTrial: true })).reason).toMatch(/[Tt]rial/);
  });
});

describe("trial exemption", () => {
  it("exempts a trial team from movement entirely", () => {
    const result = computeTierMovement(input({ winRatePercent: 99, currentTier: "T4", isTrial: true }));
    expect(result.movement).toBe("exempt");
    expect(result.newTier).toBe("T4");
  });

  it("exempts a trial team from demotion as well as promotion", () => {
    const result = computeTierMovement(input({ winRatePercent: 1, currentTier: "T1", isTrial: true }));
    expect(result.movement).toBe("exempt");
    expect(result.newTier).toBe("T1");
  });

  it("exempts a trial team at exactly 50, so exemption beats the retain band", () => {
    expect(computeTierMovement(input({ winRatePercent: 50, currentTier: "T2", isTrial: true })).movement).toBe("exempt");
  });

  it("exempts a trial team in every band, so the flag and the rate can never disagree", () => {
    for (const winRatePercent of [0, 34.99, 35, 50, 50.01, 100]) {
      expect(computeTierMovement(input({ winRatePercent, currentTier: "T2", isTrial: true })).movement).toBe("exempt");
    }
  });

  it("still records the trial team's rate, so an exemption is auditable rather than opaque", () => {
    const result = computeTierMovement(input({ winRatePercent: 99, currentTier: "T4", isTrial: true }));
    expect(result.winRatePercent).toBe(99);
  });
});

describe("computeTierMovement input validation", () => {
  it("rejects a win rate outside [0, 100], which would be a corrupt counter", () => {
    expect(() => computeTierMovement(input({ winRatePercent: 101 }))).toThrow(/winRatePercent/);
    expect(() => computeTierMovement(input({ winRatePercent: -1 }))).toThrow(/winRatePercent/);
    expect(() => computeTierMovement(input({ winRatePercent: Number.NaN }))).toThrow(/winRatePercent/);
  });
});

describe("computeWinRatePercent", () => {
  it("computes the rate from slots", () => {
    expect(computeWinRatePercent({ slotsWon: 6, slotsPlayed: 10 })).toBe(60);
    expect(computeWinRatePercent({ slotsWon: 3, slotsPlayed: 10 })).toBe(30);
    expect(computeWinRatePercent({ slotsWon: 1, slotsPlayed: 3 })).toBe(33.33);
  });

  it("clamps slotsWon to slotsPlayed, reproducing the legacy guard", () => {
    // Legacy clamped before dividing. Without it, 12/10 = 120% "promotes" a
    // team beyond the top of a ladder it cannot leave.
    expect(computeWinRatePercent({ slotsWon: 12, slotsPlayed: 10 })).toBe(100);
  });

  it("clamps a negative slotsWon to zero rather than producing a negative rate", () => {
    expect(computeWinRatePercent({ slotsWon: -5, slotsPlayed: 10 })).toBe(0);
  });

  it("returns zero when nothing was played, rather than dividing by zero", () => {
    expect(computeWinRatePercent({ slotsWon: 0, slotsPlayed: 0 })).toBe(0);
  });

  it("returns zero for an unplayed cycle however many wins are claimed", () => {
    expect(computeWinRatePercent({ slotsWon: 4, slotsPlayed: 0 })).toBe(0);
  });

  it("keeps a perfect record at exactly 100", () => {
    expect(computeWinRatePercent({ slotsWon: 10, slotsPlayed: 10 })).toBe(100);
  });

  it("never exceeds 100 or drops below 0 across a grid of slot counts", () => {
    for (let played = 0; played <= 12; played += 1) {
      for (let won = -2; won <= 14; won += 1) {
        const rate = computeWinRatePercent({ slotsWon: won, slotsPlayed: played });
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThanOrEqual(100);
      }
    }
  });

  it("rejects a fractional slot count, because a half slot is not a count", () => {
    expect(() => computeWinRatePercent({ slotsWon: 1.5, slotsPlayed: 10 })).toThrow(/slotsWon/);
    expect(() => computeWinRatePercent({ slotsWon: 1, slotsPlayed: 2.5 })).toThrow(/slotsPlayed/);
  });

  it("feeds tier movement, so a clamped 100% promotes rather than exceeding the ladder", () => {
    const rate = computeWinRatePercent({ slotsWon: 12, slotsPlayed: 10 });
    const result = computeTierMovement(input({ winRatePercent: rate, currentTier: "T1" }));
    expect(result.movement).toBe("promote");
    expect(result.newTier).toBe("godtier");
  });

  it("feeds tier movement, so an unplayed cycle demotes under the recovered thresholds", () => {
    // 0 slots played yields a 0% rate, and 0 < 35, so an unplayed team is
    // demoted. This is the recovered rule applied faithfully, not a designed
    // outcome; a fourth "unplayed means retain" band would be an invention, and
    // ADR-0016 exists precisely to stop those. See the module comment.
    const rate = computeWinRatePercent({ slotsWon: 0, slotsPlayed: 0 });
    const result = computeTierMovement(input({ winRatePercent: rate, currentTier: "T2" }));
    expect(result.movement).toBe("demote");
    // One rung down, not to the floor: T2 -> T3.
    expect(result.newTier).toBe("T3");
  });

  it("still exempts an unplayed TRIAL team, because the exemption is checked first", () => {
    const rate = computeWinRatePercent({ slotsWon: 0, slotsPlayed: 0 });
    const result = computeTierMovement(input({ winRatePercent: rate, currentTier: "T2", isTrial: true }));
    expect(result.movement).toBe("exempt");
    expect(result.newTier).toBe("T2");
  });
});