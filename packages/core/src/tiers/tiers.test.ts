import { describe, expect, it } from "vitest";

import type { Tier } from "./tiers.js";
import { TIER_LADDER, demote, isTier, promote, tierRank } from "./tiers.js";

describe("the tier ladder", () => {
  it("is exactly the legacy ladder, ascending, with no OCK/SSF/WWF", () => {
    // ADR-0016 withdrew those three names: they exist nowhere in the legacy
    // source. Reintroducing them would reintroduce a fiction.
    expect(TIER_LADDER).toEqual(["T4", "T3", "T2", "T1", "godtier"]);
  });

  it("orders `godtier` above `T1` and `T4` at the bottom", () => {
    expect(tierRank("T4")).toBeLessThan(tierRank("T3"));
    expect(tierRank("T3")).toBeLessThan(tierRank("T2"));
    expect(tierRank("T2")).toBeLessThan(tierRank("T1"));
    expect(tierRank("T1")).toBeLessThan(tierRank("godtier"));
  });

  it("narrows an untrusted string, because the legacy `teams.tier` was free text", () => {
    expect(isTier("godtier")).toBe(true);
    expect(isTier("OCK")).toBe(false);
    expect(isTier("GODTIER")).toBe(false);
  });
});

describe("promote", () => {
  it("moves exactly one rung up the ladder", () => {
    expect(promote("T4")).toBe("T3");
    expect(promote("T3")).toBe("T2");
    expect(promote("T2")).toBe("T1");
    expect(promote("T1")).toBe("godtier");
  });

  it("clamps at the top: the best tier stays the best tier", () => {
    expect(promote("godtier")).toBe("godtier");
  });

  it("is idempotent at the ceiling, so repeated promotion cannot invent a rank", () => {
    const once = promote("T1");
    expect(promote(once)).toBe("godtier");
    expect(promote(promote(once))).toBe("godtier");
  });
});

describe("demote", () => {
  it("moves exactly one rung down the ladder", () => {
    expect(demote("godtier")).toBe("T1");
    expect(demote("T1")).toBe("T2");
    expect(demote("T2")).toBe("T3");
    expect(demote("T3")).toBe("T4");
  });

  it("clamps at the bottom: the lowest tier cannot fall below itself", () => {
    expect(demote("T4")).toBe("T4");
  });

  it("is idempotent at the floor", () => {
    const once = demote("T3");
    expect(demote(once)).toBe("T4");
    expect(demote(demote(once))).toBe("T4");
  });

  it("cancels promote in the interior of the ladder", () => {
    // Only in the interior: promote clamps at the ceiling and demote clamps at
    // the floor, so a round trip through an end rung necessarily does NOT return.
    // That asymmetry is the clamp doing its job and is pinned separately below.
    for (const tier of ["T4", "T3", "T2", "T1"] as const) {
      expect(demote(promote(tier))).toBe(tier);
    }
    for (const tier of ["T3", "T2", "T1", "godtier"] as const) {
      expect(promote(demote(tier))).toBe(tier);
    }
  });

  it("breaks the round trip at the ceiling, because promote clamps before demote can undo it", () => {
    expect(promote("godtier")).toBe("godtier");
    expect(demote(promote("godtier"))).toBe("T1");
  });

  it("breaks the round trip at the floor, because demote clamps before promote can undo it", () => {
    expect(demote("T4")).toBe("T4");
    expect(promote(demote("T4"))).toBe("T3");
  });

  it("covers every rung of the declared ladder", () => {
    expect(TIER_LADDER).toHaveLength(5);
    expect(new Set(TIER_LADDER).size).toBe(TIER_LADDER.length);
  });

  it("gives every rung a distinct rank, so ordering is total and not merely conventional", () => {
    const ranks = TIER_LADDER.map((tier) => tierRank(tier));
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
  });

  it("refuses to rank a value off the ladder, because `teams.tier` was free text", () => {
    expect(() => tierRank("OCK" as Tier)).toThrow(/OCK/);
    expect(() => tierRank("" as Tier)).toThrow(/Unknown tier/);
  });

  it("refuses to move an off-ladder tier rather than promoting it to the floor", () => {
    expect(() => promote("SSF" as Tier)).toThrow(/SSF/);
    expect(() => demote("WWF" as Tier)).toThrow(/WWF/);
  });
});