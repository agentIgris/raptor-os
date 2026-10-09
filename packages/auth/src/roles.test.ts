/**
 * MFA policy tests.
 *
 * The rule under test — "privileged roles must hold TOTP before a session is
 * honoured" — is pure, so it is tested exhaustively here with no database, and
 * then exercised through the real database in `mfa-enforcement.test.ts`.
 *
 * Exhaustive rather than exemplary on purpose. The legacy system's most
 * expensive defect class was a policy that was true for the roles its author
 * tested and false for the rest (AUDIT/08: a role picker offering `tryout`,
 * which no database CHECK allowed). Every role is asserted, not a sample.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_ROLES,
  PRIVILEGED_ROLES,
  asRole,
  assertRoleAssignable,
  evaluateMfaRequirement,
  isPrivilegedRole,
  requiresMfa,
} from "./roles.js";

describe("privileged roles", () => {
  it("marks exactly manager, admin and owner as privileged", () => {
    expect([...PRIVILEGED_ROLES]).toEqual(["manager", "admin", "owner"]);
  });

  it("classifies every role in the vocabulary, with no gaps", () => {
    // A role absent from ALL_ROLES would be invisible to this loop, so the
    // vocabulary length is asserted too.
    expect(ALL_ROLES).toHaveLength(7);

    const privileged = ALL_ROLES.filter(isPrivilegedRole);
    expect(privileged).toEqual([...PRIVILEGED_ROLES]);
  });

  it("never classifies a non-existent role as privileged", () => {
    // These three existed only in the legacy TypeScript enum and could not be
    // written without tripping a CHECK constraint.
    for (const dead of ["pending_legacy", "awaiting_approval", "tryout"]) {
      expect(isPrivilegedRole(dead)).toBe(false);
    }
  });

  it("does not classify a case-variant as privileged", () => {
    // 'ADMIN' must not slip through a case-insensitive comparison and grant
    // rights, nor fail a strict one and lock an admin out. It is simply unknown,
    // and authorisation rejects it separately.
    expect(isPrivilegedRole("ADMIN")).toBe(false);
    expect(asRole("Admin")).toBeNull();
  });
});

describe("requiresMfa", () => {
  it("is true for a privileged role without TOTP, role by role", () => {
    for (const role of PRIVILEGED_ROLES) {
      expect(requiresMfa(role, false), `${role} without MFA`).toBe(true);
    }
  });

  it("is false for a privileged role that HAS enrolled TOTP", () => {
    for (const role of PRIVILEGED_ROLES) {
      expect(requiresMfa(role, true), `${role} with MFA`).toBe(false);
    }
  });

  it("is false for every non-privileged role, role by role", () => {
    // This is the "optional otherwise" half of the requirement: sign-up for a
    // player must not be a two-factor gauntlet.
    for (const role of ALL_ROLES.filter((r) => !isPrivilegedRole(r))) {
      expect(requiresMfa(role, false), `${role} without MFA`).toBe(false);
      expect(requiresMfa(role, true), `${role} with MFA`).toBe(false);
    }
  });

  it("holds for every combination of every role against both enrolment states", () => {
    // The full cross-product: 7 roles x 2 states. If the rule is ever edited to
    // something subtler than "privileged AND NOT enrolled", this is what catches
    // the gap.
    for (const role of ALL_ROLES) {
      for (const twoFactorEnabled of [false, true]) {
        expect(requiresMfa(role, twoFactorEnabled)).toBe(isPrivilegedRole(role) && !twoFactorEnabled);
      }
    }
  });
});

describe("evaluateMfaRequirement", () => {
  it("allows a non-privileged account with no TOTP", () => {
    expect(evaluateMfaRequirement("player", false)).toEqual({ allowed: true });
  });

  it("denies a privileged account with no TOTP, and says why", () => {
    expect(evaluateMfaRequirement("admin", false)).toEqual({
      allowed: false,
      reason: "privileged_role_requires_mfa",
    });
  });

  it("allows a privileged account that has enrolled TOTP", () => {
    expect(evaluateMfaRequirement("owner", true)).toEqual({ allowed: true });
  });
});

describe("assertRoleAssignable", () => {
  it("lets a non-privileged actor assign only pending and player", () => {
    expect(assertRoleAssignable("player", "player")).toBe(true);
    expect(assertRoleAssignable("player", "pending")).toBe(true);
    expect(assertRoleAssignable("player", "coach")).toBe(false);
    expect(assertRoleAssignable("player", "manager")).toBe(false);
    expect(assertRoleAssignable("player", "admin")).toBe(false);
    expect(assertRoleAssignable("player", "owner")).toBe(false);
  });

  it("stops a manager from minting an admin or an owner", () => {
    // The exact confusion the legacy role tables produced.
    expect(assertRoleAssignable("manager", "manager")).toBe(false);
    expect(assertRoleAssignable("manager", "admin")).toBe(false);
    expect(assertRoleAssignable("manager", "owner")).toBe(false);
    expect(assertRoleAssignable("manager", "player")).toBe(true);
  });

  it("lets an admin create a manager but not an owner", () => {
    expect(assertRoleAssignable("admin", "manager")).toBe(true);
    expect(assertRoleAssignable("admin", "admin")).toBe(false);
    expect(assertRoleAssignable("admin", "owner")).toBe(false);
  });

  it("lets an owner create any role strictly below itself", () => {
    expect(assertRoleAssignable("owner", "admin")).toBe(true);
    expect(assertRoleAssignable("owner", "manager")).toBe(true);
    expect(assertRoleAssignable("owner", "owner")).toBe(false);
  });

  it("lets anyone demote to pending, including a non-privileged actor", () => {
    // Self-demotion is not escalation and must not require admin.
    expect(assertRoleAssignable("player", "pending")).toBe(true);
    expect(assertRoleAssignable("manager", "pending")).toBe(true);
  });

  it("refuses both sides when either role is unrecognised", () => {
    // Fails closed: a corrupt or missing role must never widen escalation.
    expect(assertRoleAssignable("superuser", "admin")).toBe(false);
    expect(assertRoleAssignable("admin", "superuser")).toBe(false);
    expect(assertRoleAssignable("", "")).toBe(false);
  });
});