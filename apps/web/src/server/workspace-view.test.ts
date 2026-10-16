import { describe, expect, it } from "vitest";

import { mergeMembers } from "./workspace-view";

/** One row per person, roles merged, unnamed handled, no inventing. */
describe("mergeMembers", () => {
  it("merges role rows into one member row", () => {
    const members = mergeMembers([
      { displayName: "Asha", membershipStatus: "active", roleKey: "coach", roleName: "Coach", joinedAt: "2026-01-01" },
      { displayName: "Asha", membershipStatus: "active", roleKey: "manager", roleName: "Manager", joinedAt: "2026-01-01" },
    ]);
    expect(members).toEqual([
      { displayName: "Asha", membershipStatus: "active", roles: ["Coach", "Manager"], joinedAt: "2026-01-01" },
    ]);
  });

  it("keeps role-less members with empty roles", () => {
    const members = mergeMembers([
      { displayName: null, membershipStatus: "pending", roleKey: null, roleName: null, joinedAt: null },
    ]);
    expect(members).toEqual([
      { displayName: "Unnamed member", membershipStatus: "pending", roles: [], joinedAt: null },
    ]);
  });
});
