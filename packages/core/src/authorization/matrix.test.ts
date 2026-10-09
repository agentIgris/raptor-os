import { describe, expect, it } from "vitest";

import type { Role } from "./model.js";
import { createRole } from "./model.js";
import type { ScopeType } from "./scopes.js";
import { SCOPE_RANK, compareScopeRank } from "./scopes.js";
import { compileMatrix, matrixToNavigation, matrixToRlsPolicies } from "./matrix.js";

const ROLES: readonly Role[] = [
  createRole({
    key: "player",
    name: "Player",
    permissions: ["roster:read", "contract:read"],
    permittedScopes: ["self", "team"],
  }),
  createRole({
    key: "team_manager",
    name: "Team Manager",
    permissions: ["contract:read", "invoice:read", "invoice:approve", "expense:approve"],
    permittedScopes: ["team"],
  }),
  createRole({
    key: "owner",
    name: "Owner",
    permissions: ["invoice:read", "invoice:approve", "setting:update", "role:manage"],
    permittedScopes: ["organization"],
  }),
];

describe("compileMatrix", () => {
  it("flattens every (role, permission, scope) triple into one row", () => {
    const matrix = compileMatrix(ROLES);
    // player 2x2 + team_manager 4x1 + owner 4x1
    expect(matrix.rows).toHaveLength(4 + 4 + 4);
  });

  it("carries the scope rank on each row so RLS can compare without re-deriving it", () => {
    const matrix = compileMatrix(ROLES);
    const ownerRow = matrix.rows.find((row) => row.roleKey === "owner");
    expect(ownerRow?.scopeRank).toBe(SCOPE_RANK.organization);
    expect(ownerRow?.scopeType).toBe("organization");
  });

  it("sorts deterministically: role key, then permission, then scope broadest-first", () => {
    const matrix = compileMatrix(ROLES);
    const keys = matrix.rows.map((row) => `${row.roleKey}|${row.permission}|${row.scopeType}`);
    const sorted = [...keys].sort((a, b) => {
      const [roleA, permissionA, scopeA] = a.split("|") as [string, string, ScopeType];
      const [roleB, permissionB, scopeB] = b.split("|") as [string, string, ScopeType];
      if (roleA !== roleB) return roleA < roleB ? -1 : 1;
      if (permissionA !== permissionB) return permissionA < permissionB ? -1 : 1;
      // Broadest first, so negate: a comparator returning 1 puts its argument last.
      return compareScopeRank(scopeB, scopeA);
    });
    expect(keys).toEqual(sorted);
    // Broadest first within a role+permission, so the head row is the ceiling.
    expect(keys).toContain("player|contract:read|team");
    expect(keys.indexOf("player|contract:read|team")).toBeLessThan(
      keys.indexOf("player|contract:read|self"),
    );
  });

  it("exposes a lookup keyed by role then permission, for the nav consumer", () => {
    const matrix = compileMatrix(ROLES);
    expect(matrix.byRoleAndPermission.get("team_manager|contract:read")).toEqual(["team"]);
    expect(matrix.byRoleAndPermission.get("player|roster:read")).toEqual(["team", "self"]);
    expect(matrix.byRoleAndPermission.get("owner|role:manage")).toEqual(["organization"]);
    expect(matrix.byRoleAndPermission.get("owner|nope:nope")).toBeUndefined();
  });

  it("answers which roles hold a permission, for the API consumer", () => {
    const matrix = compileMatrix(ROLES);
    expect(matrix.rolesFor("invoice:approve")).toEqual(["owner", "team_manager"]);
    expect(matrix.rolesFor("invoice:update")).toEqual([]);
  });

  it("reports the broadest scope any role holds for a permission", () => {
    const matrix = compileMatrix(ROLES);
    expect(matrix.maxScopeFor("invoice:approve")).toBe("organization");
    expect(matrix.maxScopeFor("expense:approve")).toBe("team");
    expect(matrix.maxScopeFor("setting:update")).toBe("organization");
  });

  it("returns null for a permission no role holds, rather than a fake scope", () => {
    expect(compileMatrix(ROLES).maxScopeFor("payout:pay")).toBeNull();
  });

  it("finds the roles that grant any action on a resource, for a blanket-revocation sweep", () => {
    const matrix = compileMatrix(ROLES);
    expect(matrix.rolesForResource("invoice")).toEqual(["owner", "team_manager"]);
    expect(matrix.rolesForResource("travel_plan")).toEqual([]);
  });

  it("throws on an empty catalogue: an empty matrix means the policy failed to load", () => {
    expect(() => compileMatrix([])).toThrow(/role/i);
  });

  it("throws on a duplicate role key, because the matrix cannot represent two of them", () => {
    const duplicate = createRole({
      key: "player",
      name: "Player (duplicate)",
      permissions: ["person:read"],
      permittedScopes: ["self"],
    });
    expect(() => compileMatrix([...ROLES, duplicate])).toThrow(/player/);
  });

  it("is reproducible: compiling twice yields identical rows and lookups", () => {
    const first = compileMatrix(ROLES);
    const second = compileMatrix(ROLES);
    expect(first.rows).toEqual(second.rows);
    expect(first.permissions).toEqual(second.permissions);
    expect([...first.byRoleAndPermission.entries()]).toEqual([...second.byRoleAndPermission.entries()]);
  });

  it("does not depend on the order roles were defined in", () => {
    expect(compileMatrix([...ROLES].reverse()).rows).toEqual(compileMatrix(ROLES).rows);
  });
});

describe("matrixToNavigation", () => {
  it("gives nav a flat permission list per role, deduplicated across scopes", () => {
    const nav = matrixToNavigation(compileMatrix(ROLES));
    expect(nav.get("player")).toEqual(["contract:read", "roster:read"]);
    expect(nav.get("team_manager")).toEqual([
      "contract:read",
      "expense:approve",
      "invoice:approve",
      "invoice:read",
    ]);
  });
});

describe("matrixToRlsPolicies", () => {
  it("emits one SQL predicate shape per row, with the rank as a bound literal", () => {
    const statements = matrixToRlsPolicies(compileMatrix(ROLES));
    const ownerInvoice = statements.find(
      (line) => line.includes("role_key = 'owner'") && line.includes("'invoice:approve'"),
    );
    expect(ownerInvoice).toContain("max_scope_rank >= 6");
  });

  it("emits no rows for a permission nobody holds, so no policy is dead weight", () => {
    const statements = matrixToRlsPolicies(compileMatrix(ROLES));
    expect(statements.some((line) => line.includes("'payout:pay'"))).toBe(false);
  });

  it("emits exactly one line per matrix row", () => {
    const matrix = compileMatrix(ROLES);
    expect(matrixToRlsPolicies(matrix)).toHaveLength(matrix.rows.length);
  });
});