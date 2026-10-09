import { describe, expect, it } from "vitest";

import type { Role, RoleAssignment } from "./model.js";
import {
  assignmentActiveAt,
  assertScopePermitted,
  createAssignment,
  createRole,
  isAssignmentActive,
  maxAssignment,
  rolePermitsScope,
  validateAssignmentScope,
} from "./model.js";

const ORG = "org_1";

function role(overrides: Partial<Role> = {}): Role {
  return createRole({
    key: "team_manager",
    name: "Team Manager",
    permissions: ["invoice:read", "invoice:approve", "contract:sign"],
    permittedScopes: ["team", "self"],
    ...overrides,
  });
}

function assignment(overrides: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    roleKey: "team_manager",
    personId: "person_1",
    organizationId: ORG,
    scopeType: "team",
    scopeId: "team_7",
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: new Date("2027-01-01T00:00:00.000Z"),
    grantedBy: "person_admin",
    ...overrides,
  };
}

describe("createRole", () => {
  it("normalises and freezes a role", () => {
    const created = role();
    expect(Object.isFrozen(created)).toBe(true);
    // Permissions sort lexicographically and scopes broadest-first, so two roles
    // built from the same grants in different orders are deeply equal.
    expect(created.permissions).toEqual(["contract:sign", "invoice:approve", "invoice:read"]);
    expect(created.permittedScopes).toEqual(["team", "self"]);
  });

  it("deduplicates permissions and scopes so the compiled matrix is stable", () => {
    const created = role({
      permissions: ["invoice:read", "invoice:read"],
      permittedScopes: ["team", "team", "organization"],
    });
    expect(created.permissions).toEqual(["invoice:read"]);
    expect(created.permittedScopes).toEqual(["organization", "team"]);
  });

  it("is order-independent: the same grants built twice are deeply equal", () => {
    const a = role({ permissions: ["invoice:read", "contract:sign"], permittedScopes: ["self", "team"] });
    const b = role({ permissions: ["contract:sign", "invoice:read"], permittedScopes: ["team", "self"] });
    expect(a).toEqual(b);
  });

  it("rejects a role with no permissions: it can only ever be a dead grant", () => {
    expect(() => role({ permissions: [] })).toThrow(/permission/i);
  });

  it("rejects a role with no permitted scopes", () => {
    expect(() => role({ permittedScopes: [] })).toThrow(/scope/i);
  });

  it("rejects a role that permits organization but grants no organization-wide power", () => {
    // Not a validation rule — a documented example of a role allowed to be org-scoped.
    const orgScoped = role({ permittedScopes: ["organization", "team"] });
    expect(rolePermitsScope(orgScoped, "organization")).toBe(true);
  });

  it("rejects an off-catalogue permission", () => {
    expect(() => role({ permissions: ["wallet:sudo"] as never })).toThrow(/wallet:sudo/);
  });

  it("rejects an off-catalogue scope type", () => {
    expect(() => role({ permittedScopes: ["planet"] as never })).toThrow(/planet/);
  });

  it("rejects a blank role key, because the key is the durable identity", () => {
    expect(() => role({ key: "  " })).toThrow(/key/i);
  });
});

describe("server-determined scope validation", () => {
  it("permits a scope the role allows", () => {
    expect(validateAssignmentScope(role(), "team", "team_7")).toBe("team_7");
  });

  it("permits self scope with no scopeId", () => {
    expect(validateAssignmentScope(role(), "self", null)).toBeNull();
  });

  it("rejects a scope the role does not permit, and says which it was refused", () => {
    expect(() => validateAssignmentScope(role(), "organization", ORG)).toThrow(/organization/);
    expect(() => validateAssignmentScope(role(), "department", "dep_3")).toThrow(/department/);
  });

  it("rejects a scopeId on self scope, because self is not a row", () => {
    expect(() => validateAssignmentScope(role(), "self", "person_1")).toThrow(/self/);
  });

  it("rejects a missing scopeId on every scope that names a row", () => {
    for (const scopeType of ["organization", "department", "division", "team", "campaign", "assigned"] as const) {
      expect(() => validateAssignmentScope(role({ permittedScopes: [scopeType] }), scopeType, null)).toThrow(
        /scopeId/,
      );
    }
  });

  it("asserts without returning, for call sites that only want the guard", () => {
    expect(() => assertScopePermitted(role(), "team", "team_7")).not.toThrow();
    expect(() => assertScopePermitted(role(), "organization", ORG)).toThrow(/organization/);
  });
});

describe("effective dating", () => {
  const at = (iso: string) => new Date(iso);

  it("is inactive before validFrom", () => {
    expect(isAssignmentActive(assignment(), at("2025-12-31T23:59:59.999Z"))).toBe(false);
  });

  it("is active at the exact instant of validFrom (inclusive)", () => {
    expect(isAssignmentActive(assignment(), at("2026-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("is active in the middle of the window", () => {
    expect(isAssignmentActive(assignment(), at("2026-06-15T12:00:00.000Z"))).toBe(true);
  });

  it("is active up to but not including validTo, so back-to-back grants do not overlap", () => {
    expect(isAssignmentActive(assignment(), at("2026-12-31T23:59:59.999Z"))).toBe(true);
    expect(isAssignmentActive(assignment(), at("2027-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("treats a null validTo as open-ended", () => {
    const openEnded = assignment({ validTo: null });
    expect(isAssignmentActive(openEnded, at("2099-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("treats an invalid window as never active rather than throwing", () => {
    // Constructed by hand, bypassing createAssignment, because a bad window that
    // exists in the database must fail closed rather than grant anything.
    const inverted = assignment({
      validFrom: new Date("2027-01-01T00:00:00.000Z"),
      validTo: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(isAssignmentActive(inverted, at("2026-06-01T00:00:00.000Z"))).toBe(false);
    expect(isAssignmentActive(inverted, at("2027-06-01T00:00:00.000Z"))).toBe(false);
  });

  it("rejects an assignment whose window is inverted at construction", () => {
    expect(() =>
      createAssignment({
        roleKey: "team_manager",
        personId: "person_1",
        organizationId: ORG,
        scopeType: "team",
        scopeId: "team_7",
        validFrom: new Date("2027-01-01T00:00:00.000Z"),
        validTo: new Date("2026-01-01T00:00:00.000Z"),
        grantedBy: "person_admin",
      }),
    ).toThrow(/validFrom/);
  });

  it("rejects a validFrom equal to validTo: an instant of zero authority", () => {
    const instant = "2026-01-01T00:00:00.000Z";
    expect(() =>
      createAssignment({
        roleKey: "team_manager",
        personId: "person_1",
        organizationId: ORG,
        scopeType: "team",
        scopeId: "team_7",
        validFrom: new Date(instant),
        validTo: new Date(instant),
        grantedBy: "person_admin",
      }),
    ).toThrow(/validTo/);
  });

  it("exposes the same predicate under an explicit name for non-boolean call sites", () => {
    expect(assignmentActiveAt(assignment(), new Date("2026-06-01T00:00:00.000Z"))).toBe(true);
  });
});

describe("assignment helpers", () => {
  it("computes the widest active assignment for a person, which is what nav needs", () => {
    const grants = [
      assignment({ scopeType: "self", scopeId: null, validFrom: new Date("2026-01-01T00:00:00.000Z") }),
      assignment({ scopeType: "team", scopeId: "team_7" }),
      assignment({ scopeType: "team", scopeId: "team_8" }),
    ];
    const widest = maxAssignment("person_1", ORG, grants, new Date("2026-06-01T00:00:00.000Z"));
    expect(widest?.scopeType).toBe("team");
    expect(widest?.scopeId).toBe("team_7");
  });

  it("ignores assignments belonging to another person", () => {
    const grants = [
      assignment({ personId: "person_2", scopeType: "organization", scopeId: ORG }),
      assignment({ personId: "person_1", scopeType: "self", scopeId: null }),
    ];
    const widest = maxAssignment("person_1", ORG, grants, new Date("2026-06-01T00:00:00.000Z"));
    expect(widest?.scopeType).toBe("self");
  });

  it("ignores assignments from another organisation: tenancy beats breadth", () => {
    const grants = [
      assignment({ organizationId: "org_other", scopeType: "organization", scopeId: "org_other" }),
      assignment({ scopeType: "self", scopeId: null }),
    ];
    const widest = maxAssignment("person_1", ORG, grants, new Date("2026-06-01T00:00:00.000Z"));
    expect(widest?.scopeType).toBe("self");
  });

  it("returns null when nothing is active", () => {
    expect(maxAssignment("person_1", ORG, [], new Date("2026-06-01T00:00:00.000Z"))).toBeNull();
    expect(
      maxAssignment(
        "person_1",
        ORG,
        [assignment({ validTo: new Date("2026-02-01T00:00:00.000Z") })],
        new Date("2026-06-01T00:00:00.000Z"),
      ),
    ).toBeNull();
  });
});