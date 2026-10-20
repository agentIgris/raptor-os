import { describe, expect, it } from "vitest";

import {
  ASSISTANT_ROLES,
  ASSISTANT_TOOLS,
  TOOL_SCOPES,
  isToolAllowed,
  toolsForRole,
} from "./matrix.js";

describe("assistant scope matrix", () => {
  it("exposes the seven workspace roles", () => {
    expect([...ASSISTANT_ROLES]).toEqual([
      "pending",
      "player",
      "coach",
      "analyst",
      "manager",
      "admin",
      "owner",
    ]);
  });

  it("exposes the six Phase 1 read-only tools", () => {
    expect([...ASSISTANT_TOOLS]).toEqual([
      "listTeams",
      "listCompetitions",
      "getInsights",
      "getRoster",
      "listMembers",
      "getOrgOverview",
    ]);
  });

  it("denies pending accounts every tool", () => {
    expect(toolsForRole("pending")).toEqual([]);
    for (const tool of ASSISTANT_TOOLS) {
      expect(isToolAllowed(tool, "pending")).toBe(false);
    }
  });

  it("gives players navigation-visible data only", () => {
    expect(toolsForRole("player")).toEqual(["listTeams", "listCompetitions"]);
  });

  it("gives coaches and analysts insight and roster access", () => {
    const expected = [
      "listTeams",
      "listCompetitions",
      "getInsights",
      "getRoster",
    ];
    expect(toolsForRole("coach")).toEqual(expected);
    expect(toolsForRole("analyst")).toEqual(expected);
  });

  it("gives managers member data", () => {
    expect(toolsForRole("manager")).toEqual([
      "listTeams",
      "listCompetitions",
      "getInsights",
      "getRoster",
      "listMembers",
    ]);
  });

  it("gives admin and owner the full tool set including org overview", () => {
    const expected = [...ASSISTANT_TOOLS];
    expect(toolsForRole("admin")).toEqual(expected);
    expect(toolsForRole("owner")).toEqual(expected);
    expect(toolsForRole("admin")).toContain("getOrgOverview");
  });

  it("keeps the matrix aligned with the tool list keys", () => {
    expect(Object.keys(TOOL_SCOPES).sort()).toEqual([...ASSISTANT_TOOLS].sort());
  });

  it("answers allow/deny queries at scope boundaries", () => {
    expect(isToolAllowed("getInsights", "player")).toBe(false);
    expect(isToolAllowed("getInsights", "coach")).toBe(true);
    expect(isToolAllowed("listMembers", "manager")).toBe(true);
    expect(isToolAllowed("listMembers", "analyst")).toBe(false);
    expect(isToolAllowed("getOrgOverview", "manager")).toBe(false);
    expect(isToolAllowed("getOrgOverview", "owner")).toBe(true);
  });
});
