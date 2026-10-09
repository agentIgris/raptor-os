import { describe, expect, it } from "vitest";

import type { ScopeType } from "./scopes.js";
import { SCOPE_RANK, SCOPE_TYPES, compareScopeRank, scopeCovers, scopeRank, scopeTypesByBreadth } from "./scopes.js";

describe("scope breadth ranking", () => {
  it("declares the seven scope types of the product", () => {
    expect(SCOPE_TYPES).toEqual([
      "organization",
      "department",
      "division",
      "team",
      "campaign",
      "assigned",
      "self",
    ]);
  });

  it("assigns organization the broadest rank and self the narrowest", () => {
    expect(scopeRank("organization")).toBeGreaterThan(scopeRank("department"));
    expect(scopeRank("department")).toBeGreaterThan(scopeRank("division"));
    expect(scopeRank("division")).toBeGreaterThan(scopeRank("team"));
    expect(scopeRank("team")).toBeGreaterThan(scopeRank("campaign"));
    expect(scopeRank("campaign")).toBeGreaterThan(scopeRank("assigned"));
    expect(scopeRank("assigned")).toBeGreaterThan(scopeRank("self"));
  });

  it("uses a dense 0-based rank so consumers can index without gaps", () => {
    const ranks = SCOPE_TYPES.map((type) => scopeRank(type)).sort((a, b) => a - b);
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("exposes the rank table for consumers that need it as data (RLS, nav)", () => {
    expect(SCOPE_RANK.team).toBe(3);
    expect(Object.isFrozen(SCOPE_RANK)).toBe(true);
    expect(scopeTypesByBreadth()).toEqual([
      "organization",
      "department",
      "division",
      "team",
      "campaign",
      "assigned",
      "self",
    ]);
  });
});

describe("compareScopeRank", () => {
  it("orders broad before narrow", () => {
    expect(compareScopeRank("organization", "team")).toBe(1);
    expect(compareScopeRank("team", "organization")).toBe(-1);
  });

  it("reports equality for the same scope", () => {
    expect(compareScopeRank("team", "team")).toBe(0);
  });
});

describe("scopeCovers", () => {
  it("lets an identical scope cover itself", () => {
    expect(scopeCovers("team", "team")).toBe(true);
  });

  it("refuses to let a narrow grant cover a broad scope", () => {
    expect(scopeCovers("team", "organization")).toBe(false);
    expect(scopeCovers("self", "team")).toBe(false);
    expect(scopeCovers("campaign", "department")).toBe(false);
  });

  it("lets a broad grant cover a narrower scope", () => {
    expect(scopeCovers("organization", "self")).toBe(true);
    expect(scopeCovers("division", "team")).toBe(true);
  });
});

describe("scope breadth is a total order (fuzz over all 49 pairs)", () => {
  const pairs: Array<[ScopeType, ScopeType]> = [];
  for (const granted of SCOPE_TYPES) {
    for (const requested of SCOPE_TYPES) {
      pairs.push([granted, requested]);
    }
  }

  it("exercises every ordered pair", () => {
    expect(pairs).toHaveLength(49);
  });

  it("never covers a broader scope with a narrower grant", () => {
    for (const [granted, requested] of pairs) {
      const covers = scopeCovers(granted, requested);
      expect(covers).toBe(scopeRank(granted) >= scopeRank(requested));
      expect(covers).toBe(compareScopeRank(granted, requested) >= 0);
    }
  });

  it("is antisymmetric: exactly one of (a,b) and (b,a) covers when they differ", () => {
    for (const [a, b] of pairs) {
      if (a === b) continue;
      const forward = scopeCovers(a, b);
      const backward = scopeCovers(b, a);
      expect(forward).toBe(!backward);
    }
  });

  it("is transitive: if a covers b and b covers c then a covers c", () => {
    for (const [a, b] of pairs) {
      for (const [, c] of pairs) {
        if (scopeCovers(a, b) && scopeCovers(b, c)) {
          expect(scopeCovers(a, c)).toBe(true);
        }
      }
    }
  });
});