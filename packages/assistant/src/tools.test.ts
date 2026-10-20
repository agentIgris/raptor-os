import { describe, expect, it } from "vitest";

import {
  ASSISTANT_ROLES,
  ASSISTANT_TOOLS,
  TOOL_SCOPES,
} from "./matrix.js";
import {
  filterForRole,
  makeRegistry,
  makeTool,
  type AssistantTool,
  type AssistantToolRequest,
  type ToolResult,
} from "./tools.js";

const session = {
  userId: "u_1",
  email: "coach@example.test",
  role: "coach" as const,
  orgId: "org_1",
};

const request: AssistantToolRequest = { session, question: "how are we doing" };

function okTool(name: AssistantTool["name"], value: unknown): AssistantTool {
  return makeTool({
    name,
    description: `${name} description`,
    run: () => Promise.resolve({ ok: true, data: value }),
  });
}

describe("makeTool", () => {
  it("derives allowedRoles from the matrix instead of trusting the caller", () => {
    const tool = okTool("getInsights", 1);
    expect(tool.allowedRoles).toEqual(TOOL_SCOPES.getInsights);
    expect(tool.allowedRoles).not.toContain("player");
  });

  it("keeps the provided description and run", async () => {
    const tool = okTool("listMembers", ["a"]);
    expect(tool.description).toBe("listMembers description");
    const result = await tool.run(request);
    expect(result).toEqual({ ok: true, data: ["a"] });
  });
});

describe("makeRegistry", () => {
  it("returns an empty registry for no tools", () => {
    expect(makeRegistry([]).size).toBe(0);
  });

  it("indexes tools by name", () => {
    const registry = makeRegistry([okTool("listTeams", []), okTool("getRoster", [])]);
    expect(registry.size).toBe(2);
    expect(registry.get("listTeams")?.name).toBe("listTeams");
    expect(registry.get("getRoster")?.name).toBe("getRoster");
  });

  it("lets the last registration win on duplicate names", () => {
    const registry = makeRegistry([
      okTool("listTeams", "first"),
      okTool("listTeams", "second"),
    ]);
    expect(registry.size).toBe(1);
  });
});

describe("filterForRole", () => {
  it("fails closed on unknown roles", () => {
    const registry = makeRegistry(ASSISTANT_TOOLS.map((name) => okTool(name, 1)));
    expect(filterForRole(registry, "superadmin")).toEqual([]);
    expect(filterForRole(registry, "")).toEqual([]);
    expect(filterForRole(registry, "PLAYER")).toEqual([]);
  });

  it("gives pending accounts nothing even with a full registry", () => {
    const registry = makeRegistry(ASSISTANT_TOOLS.map((name) => okTool(name, 1)));
    expect(filterForRole(registry, "pending")).toEqual([]);
  });

  it("returns tools in canonical matrix order regardless of registry order", () => {
    const registry = makeRegistry([
      okTool("getOrgOverview", 1),
      okTool("listCompetitions", 1),
      okTool("listTeams", 1),
    ]);
    const selected = filterForRole(registry, "player").map((tool) => tool.name);
    expect(selected).toEqual(["listTeams", "listCompetitions"]);
  });

  it("skips tools that are allowed for the role but missing from the registry", () => {
    const registry = makeRegistry([okTool("listTeams", 1)]);
    const selected = filterForRole(registry, "manager").map((tool) => tool.name);
    expect(selected).toEqual(["listTeams"]);
  });

  it("runs every allowed tool for each role", async () => {
    const registry = makeRegistry(ASSISTANT_TOOLS.map((name) => okTool(name, name)));
    for (const role of ASSISTANT_ROLES) {
      const results = await Promise.all(
        filterForRole(registry, role).map((tool) => tool.run(request)),
      );
      for (const result of results satisfies ToolResult<unknown>[]) {
        expect(result.ok).toBe(true);
      }
    }
  });
});
