import { describe, expect, it } from "vitest";

import type { Action, Permission, Resource } from "./permissions.js";
import { ACTIONS, RESOURCES, isAction, isPermission, isResource, parsePermission, permission } from "./permissions.js";

describe("the permission catalogue vocabulary", () => {
  it("names the nouns of an esports organisation, not generic ones", () => {
    expect(RESOURCES).toEqual([
      "person",
      "team",
      "roster",
      "contract",
      "agreement",
      "invoice",
      "expense",
      "deliverable",
      "travel_plan",
      "prize_pool",
      "payout",
      "tryout",
      "document",
      "setting",
      "role",
    ]);
    expect(RESOURCES.every(isResource)).toBe(true);
  });

  it("names the verbs, including the destructive and the outward-facing ones", () => {
    expect(ACTIONS).toEqual([
      "read",
      "create",
      "update",
      "delete",
      "approve",
      "export",
      "send",
      "manage",
      "publish",
      "sign",
      "pay",
      "impersonate",
    ]);
    expect(ACTIONS.every(isAction)).toBe(true);
  });

  it("rejects strings that are not in the catalogue", () => {
    expect(isResource("wallet")).toBe(false);
    expect(isAction("sudo")).toBe(false);
    expect(isPermission("wallet:sudo")).toBe(false);
    expect(isPermission("invoice")).toBe(false);
  });
});

describe("permission encoding", () => {
  it("encodes a permission as resource:action", () => {
    expect(permission("invoice", "approve")).toBe("invoice:approve");
    expect(permission("person", "read")).toBe("person:read");
  });

  it("round-trips through parsePermission", () => {
    for (const resource of RESOURCES) {
      for (const action of ACTIONS) {
        const encoded = permission(resource, action);
        expect(parsePermission(encoded)).toEqual({ resource, action });
      }
    }
  });

  it("throws rather than inventing a permission outside the catalogue", () => {
    expect(() => permission("wallet" as Resource, "sudo" as Action)).toThrow(/wallet:sudo/);
    expect(() => permission("wallet" as Resource, "read")).toThrow(/wallet/);
    expect(() => permission("invoice", "sudo" as Action)).toThrow(/invoice:sudo/);
  });

  it("throws on a malformed permission string instead of returning a partial parse", () => {
    expect(() => parsePermission("invoice:")).toThrow();
    expect(() => parsePermission("invoice:approve:extra")).toThrow();
    expect(() => parsePermission("")).toThrow();
    expect(() => parsePermission("Invoice:approve")).toThrow();
    expect(() => parsePermission("invoice:APPROVE")).toThrow();
  });

  it("sorts deterministically so the compiled matrix is reproducible", () => {
    const encoded: Permission[] = [
      permission("setting", "update"),
      permission("contract", "sign"),
      permission("contract", "approve"),
      permission("person", "read"),
    ];
    expect([...encoded].sort()).toEqual([
      "contract:approve",
      "contract:sign",
      "person:read",
      "setting:update",
    ]);
  });
});