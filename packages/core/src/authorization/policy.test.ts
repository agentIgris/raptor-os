import { describe, expect, it } from "vitest";

import type { PolicyRule } from "./policy.js";
import { evaluateCondition, ruleMatches } from "./policy.js";

describe("evaluateCondition: actor_equals_owner", () => {
  const condition = { kind: "actor_equals_owner" } as const;

  it("is true when the actor is the owner", () => {
    expect(evaluateCondition(condition, { actorId: "p1", resourceOwnerId: "p1" })).toBe(true);
  });

  it("is false when they differ", () => {
    expect(evaluateCondition(condition, { actorId: "p1", resourceOwnerId: "p2" })).toBe(false);
  });

  it("fails closed when either side is unknown, because an unverifiable rule must not pass", () => {
    expect(evaluateCondition(condition, { actorId: "p1" })).toBe(false);
    expect(evaluateCondition(condition, { resourceOwnerId: "p1" })).toBe(false);
    expect(evaluateCondition(condition, {})).toBe(false);
  });
});

describe("evaluateCondition: amount_within_limit", () => {
  const condition = {
    kind: "amount_within_limit",
    limit: { minor: 100_000n, currency: "INR" },
  } as const;

  it("takes the amount from the condition when the request carries none", () => {
    expect(evaluateCondition({ ...condition, amount: { minor: 100_000n, currency: "INR" } }, {})).toBe(true);
  });

  it("prefers the request's amount over the condition's own", () => {
    expect(
      evaluateCondition({ ...condition, amount: { minor: 100_000n, currency: "INR" } }, {
        amount: { minor: 100_001n, currency: "INR" },
      }),
    ).toBe(false);
  });

  it("is inclusive at the limit, so a limit of 10,000 approves exactly 10,000", () => {
    expect(evaluateCondition(condition, { amount: { minor: 100_000n, currency: "INR" } })).toBe(true);
    expect(evaluateCondition(condition, { amount: { minor: 100_001n, currency: "INR" } })).toBe(false);
    expect(evaluateCondition(condition, { amount: { minor: 0n, currency: "INR" } })).toBe(true);
  });

  it("refuses to compare across currencies instead of guessing a rate", () => {
    expect(evaluateCondition(condition, { amount: { minor: 1n, currency: "USD" } })).toBe(false);
  });

  it("fails closed when no amount is available at all", () => {
    expect(evaluateCondition(condition, {})).toBe(false);
  });
});

describe("ruleMatches", () => {
  const rule: PolicyRule = {
    id: "r1",
    resource: "invoice",
    action: "approve",
    effect: "DENY",
    condition: { kind: "actor_equals_owner" },
  };

  it("matches on resource and action", () => {
    expect(ruleMatches(rule, "invoice", "approve", "team")).toBe(true);
  });

  it("does not match another resource or another action", () => {
    expect(ruleMatches(rule, "expense", "approve", "team")).toBe(false);
    expect(ruleMatches(rule, "invoice", "read", "team")).toBe(false);
  });

  it("is scope-unbounded when the rule names no scope types", () => {
    expect(ruleMatches(rule, "invoice", "approve", "organization")).toBe(true);
  });

  it("honours an explicit scope-type restriction", () => {
    const scoped = { ...rule, scopeTypes: ["organization"] as const };
    expect(ruleMatches(scoped, "invoice", "approve", "organization")).toBe(true);
    expect(ruleMatches(scoped, "invoice", "approve", "team")).toBe(false);
  });

  it("matches several listed scope types", () => {
    const scoped = { ...rule, scopeTypes: ["team", "department"] as const };
    expect(ruleMatches(scoped, "invoice", "approve", "department")).toBe(true);
    expect(ruleMatches(scoped, "invoice", "approve", "self")).toBe(false);
  });
});