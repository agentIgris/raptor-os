/**
 * The dashboard view model.
 *
 * These assertions are about the contract between the app and `packages/core`,
 * not about the fixture numbers. What is being checked is that the screen is
 * showing what the domain layer actually decided — the allocation sums to the
 * net, the attendance status comes from an arrival instant, and the tier
 * movement comes from the recovered rule including its exactly-50 boundary.
 */

import { describe, expect, it } from "vitest";

import { buildPrizePreview, buildRosterPreview } from "../server/dashboard";

describe("buildPrizePreview", () => {
  const preview = buildPrizePreview();

  it("reconciles exactly: allocations sum to the net, with zero variance", () => {
    // This is the invariant the whole prize engine exists to make satisfiable
    // (spec §7). A non-zero number here means the largest-remainder
    // distribution has regressed.
    const total = preview.allocations.reduce((sum, row) => sum + row.computed.minor, 0n);
    expect(total).toBe(preview.net.minor);
    expect(preview.variance.isZero()).toBe(true);
  });

  it("derives net as gross less deductions less tax", () => {
    expect(preview.net.minor).toBe(preview.gross.minor - preview.deductions.minor - preview.tax.minor);
  });

  it("keeps major and minor units straight", () => {
    // €50,000.00 at a scale of 4 is 500,000,000 minor units. `money()` takes
    // MAJOR units and returns MINOR units, while `allocateByShareNumerators`
    // works purely in minor units. Mixing them up inflates an amount by
    // 10,000x, and this is the assertion that catches it.
    expect(preview.gross.minor).toBe(500_000_000n);
    expect(preview.deductions.minor).toBe(20_000_000n);
    expect(preview.tax.minor).toBe(50_000_000n);
    expect(preview.net.minor).toBe(430_000_000n);
    expect(preview.gross.toDecimal()).toBe("50000.0000");
  });

  it("allocates the whole net, with no unit drift in the share amounts", () => {
    // 50% of €43,000.00 is €21,500.00 = 215,000,000 minor units.
    const startingRoster = preview.allocations.find((row) => row.id === "team-alpha");
    expect(startingRoster?.computed.minor).toBe(215_000_000n);
  });

  it("carries a rule version on every allocation — an allocation with no rule version is not reproducible", () => {
    for (const row of preview.allocations) {
      expect(row.ruleVersion).not.toBe("");
    }
  });

  it("is deterministic: the same inputs give the same output", () => {
    // `JSON.stringify` throws on a bigint, so the replacer stringifies it.
    const replacer = (_key: string, value: unknown): unknown =>
      typeof value === "bigint" ? value.toString() : value;

    expect(JSON.stringify(buildPrizePreview(), replacer)).toBe(JSON.stringify(preview, replacer));
  });

  it("is a single currency throughout — the domain refuses to combine two", () => {
    const currencies = new Set([
      preview.gross.currency,
      preview.net.currency,
      ...preview.allocations.map((row) => row.computed.currency),
    ]);
    expect(currencies.size).toBe(1);
  });
});

describe("buildRosterPreview", () => {
  const roster = buildRosterPreview();

  it("derives every attendance status from a recorded arrival instant", () => {
    const byHandle = new Map(roster.map((player) => [player.handle, player]));
    // On time.
    expect(byHandle.get("kirra")?.attendance).toBe("present");
    // Inside the 15-minute cutoff, so late rather than absent.
    expect(byHandle.get("nineveh")?.attendance).toBe("late");
    // No arrival recorded at all — absent, which is the only status the system
    // is entitled to decide on its own.
    expect(byHandle.get("ozz")?.attendance).toBe("absent");
  });

  it("treats exactly 50% as retained, not promoted", () => {
    // The recovered rule is strict on both ends: `> 50` promotes, `< 35`
    // demotes, and 50 exactly is retained. This is the boundary that a
    // rounded or "approximately" implementation gets wrong.
    const nineveh = roster.find((player) => player.handle === "nineveh");
    expect(nineveh?.winRatePercent).toBe(50);
    expect(nineveh?.movement).toBe("retain");
    expect(nineveh?.previousTier).toBe(nineveh?.newTier);
  });

  it("promotes above the threshold and demotes below it", () => {
    expect(roster.find((player) => player.handle === "kirra")?.movement).toBe("promote");
    expect(roster.find((player) => player.handle === "ozz")?.movement).toBe("demote");
  });

  it("exempts trial teams from the ladder entirely", () => {
    const bramble = roster.find((player) => player.handle === "bramble");
    expect(bramble?.movement).toBe("exempt");
    expect(bramble?.previousTier).toBe(bramble?.newTier);
  });

  it("carries a human-readable reason for every movement, because these get disputed", () => {
    for (const player of roster) {
      expect(player.reason.length).toBeGreaterThan(0);
    }
  });
});