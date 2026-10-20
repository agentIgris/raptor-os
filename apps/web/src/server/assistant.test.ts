import { filterForRole, type AssistantSession, type AssistantTool, type AssistantToolName, type ToolResult } from "@raptor/assistant";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
  getWorkspaceTeams: vi.fn(),
  getWorkspaceCompetitions: vi.fn(),
  getWorkspaceInsights: vi.fn(),
  getWorkspaceRosters: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getWorkspaceOrg: vi.fn(),
}));

vi.mock("./workspace", () => workspace);

import { buildAssistantRegistry } from "./assistant";

const UNAVAILABLE_TEXT = "Workspace data is temporarily unavailable. Try again shortly.";

const session: AssistantSession = {
  userId: "u1",
  email: "coach@example.com",
  role: "coach",
  orgId: "org-1",
};

const QUESTION = "Which teams do we have?";

const registry = buildAssistantRegistry();

function toolFor(name: AssistantToolName): AssistantTool {
  const tool = registry.get(name);
  if (!tool) throw new Error(`registry is missing ${name}`);
  return tool;
}

async function run(name: AssistantToolName): Promise<ToolResult<unknown>> {
  return toolFor(name).run({ session, question: QUESTION });
}

async function okData(name: AssistantToolName): Promise<unknown> {
  const result = await run(name);
  if (!result.ok) throw new Error(`expected ok for ${name}, got ${result.error}`);
  return result.data;
}

async function failure(name: AssistantToolName): Promise<string> {
  const result = await run(name);
  if (result.ok) throw new Error(`expected failure for ${name}`);
  return result.error;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildAssistantRegistry", () => {
  it("registers every matrix tool name exactly once", () => {
    expect([...registry.keys()].sort()).toEqual([
      "getInsights",
      "getOrgOverview",
      "getRoster",
      "listCompetitions",
      "listMembers",
      "listTeams",
    ]);
  });

  it("resolves the tools filterForRole grants to each role", () => {
    const owner = filterForRole(registry, "owner").map((tool) => tool.name);
    expect(owner).toEqual([
      "listTeams",
      "listCompetitions",
      "getInsights",
      "getRoster",
      "listMembers",
      "getOrgOverview",
    ]);
    const coach = filterForRole(registry, "coach").map((tool) => tool.name);
    expect(coach).toEqual(["listTeams", "listCompetitions", "getInsights", "getRoster"]);
    const manager = filterForRole(registry, "manager").map((tool) => tool.name);
    expect(manager).toEqual(["listTeams", "listCompetitions", "getInsights", "getRoster", "listMembers"]);
    expect(filterForRole(registry, "pending")).toEqual([]);
    expect(filterForRole(registry, "ghost-role")).toEqual([]);
  });
});

describe("listTeams", () => {
  it("reports unavailable when the workspace read fails", async () => {
    workspace.getWorkspaceTeams.mockResolvedValue(null);
    await expect(failure("listTeams")).resolves.toBe(UNAVAILABLE_TEXT);
  });

  it("says there are no teams yet", async () => {
    workspace.getWorkspaceTeams.mockResolvedValue([]);
    await expect(okData("listTeams")).resolves.toBe("No active teams exist yet.");
  });

  it("formats one line per team, with or without a division", async () => {
    workspace.getWorkspaceTeams.mockResolvedValue([
      { name: "Raptors", slug: "raptors", game: "CS2", division: "Division A", status: "active", members: 5 },
      { name: "Owls", slug: "owls", game: "LoL", division: null, status: "active", members: 3 },
    ]);
    await expect(okData("listTeams")).resolves.toBe(
      [
        "Raptors (raptors) — CS2, Division A — active, 5 members",
        "Owls (owls) — LoL — active, 3 members",
      ].join("\n"),
    );
    expect(workspace.getWorkspaceTeams).toHaveBeenCalledWith("org-1");
  });
});

describe("listCompetitions", () => {
  const competition = {
    name: "Autumn Split",
    format: "league",
    status: "active",
    startsAt: "2026-09-01",
    endsAt: "2026-11-30",
    registrations: 8,
  };
  const match = { team: "Raptors", round: "Round 3", scheduledAt: "2026-10-25", status: "scheduled" };

  it("reports unavailable when the competition read fails", async () => {
    workspace.getWorkspaceCompetitions.mockResolvedValue({ competitions: null, upcoming: [] });
    await expect(failure("listCompetitions")).resolves.toBe(UNAVAILABLE_TEXT);
  });

  it("reports unavailable when the upcoming-match read fails", async () => {
    workspace.getWorkspaceCompetitions.mockResolvedValue({ competitions: [], upcoming: null });
    await expect(failure("listCompetitions")).resolves.toBe(UNAVAILABLE_TEXT);
  });

  it("says there is nothing scheduled yet", async () => {
    workspace.getWorkspaceCompetitions.mockResolvedValue({ competitions: [], upcoming: [] });
    await expect(okData("listCompetitions")).resolves.toBe(
      ["No active competitions exist yet.", "No upcoming matches are scheduled."].join("\n"),
    );
  });

  it("lists competitions and matches, with a fallback for missing rounds", async () => {
    workspace.getWorkspaceCompetitions.mockResolvedValue({
      competitions: [competition],
      upcoming: [match, { team: "Owls", round: null, scheduledAt: "2026-10-26", status: "scheduled" }],
    });
    await expect(okData("listCompetitions")).resolves.toBe(
      [
        "Autumn Split — league, active; runs 2026-09-01 to 2026-11-30; 8 registrations",
        "Raptors — Round 3 at 2026-10-25, status scheduled",
        "Owls — round to be scheduled at 2026-10-26, status scheduled",
      ].join("\n"),
    );
  });
});

describe("getInsights", () => {
  it("reports unavailable when the insights read fails", async () => {
    workspace.getWorkspaceInsights.mockResolvedValue(null);
    await expect(failure("getInsights")).resolves.toBe(UNAVAILABLE_TEXT);
  });

  it("says analytics are empty", async () => {
    workspace.getWorkspaceInsights.mockResolvedValue({ metrics: [], teams: [], players: [] });
    await expect(okData("getInsights")).resolves.toBe("No analytics have been recorded for this period.");
  });

  it("formats metrics, teams and players with every optional field", async () => {
    workspace.getWorkspaceInsights.mockResolvedValue({
      metrics: [
        { key: "matches_played", status: "available", detail: null, value: "12" },
        { key: "attendance", status: "unavailable", detail: "no data source", value: null },
        { key: "review_hours", status: "unavailable", detail: null, value: null },
      ],
      teams: [
        { name: "Raptors", rank: 1, won: 9, lost: 3, winRate: "0.75" },
        { name: "Owls", rank: null, won: 2, lost: 8, winRate: null },
      ],
      players: [
        { handle: "ASH", played: 12, wins: 9, kd: "1.31" },
        { handle: "ROW", played: 10, wins: 5, kd: null },
      ],
    });
    await expect(okData("getInsights")).resolves.toBe(
      [
        "matches_played: 12",
        "attendance: unavailable (no data source)",
        "review_hours: unavailable",
        "Raptors — rank 1, 9 won, 3 lost, map win rate 0.75",
        "Owls — rank unranked, 2 won, 8 lost",
        "ASH — 12 matches, 9 wins, K/D 1.31",
        "ROW — 10 matches, 5 wins",
      ].join("\n"),
    );
  });
});

describe("getRoster", () => {
  it("reports unavailable when the roster read fails", async () => {
    workspace.getWorkspaceRosters.mockResolvedValue(null);
    await expect(failure("getRoster")).resolves.toBe(UNAVAILABLE_TEXT);
  });

  it("says there are no rostered teams yet", async () => {
    workspace.getWorkspaceRosters.mockResolvedValue([]);
    await expect(okData("getRoster")).resolves.toBe("No active teams have rosters yet.");
  });

  it("lists each team with indented players, roles only when present", async () => {
    workspace.getWorkspaceRosters.mockResolvedValue([
      { name: "Owls", gameName: "LoL", divisionName: null, status: "active", players: [] },
      {
        name: "Raptors",
        gameName: "CS2",
        divisionName: "Division A",
        status: "active",
        players: [
          { handle: "ASH", role: "" },
          { handle: "ROW", role: "AWPer" },
        ],
      },
    ]);
    await expect(okData("getRoster")).resolves.toBe(
      [
        "Owls (LoL) — active",
        "  no rostered players",
        "Raptors (CS2, Division A) — active",
        "  ASH",
        "  ROW — AWPer",
      ].join("\n"),
    );
  });
});

describe("listMembers", () => {
  it("reports unavailable when the member read fails", async () => {
    workspace.getWorkspaceMembers.mockResolvedValue(null);
    await expect(failure("listMembers")).resolves.toBe(UNAVAILABLE_TEXT);
  });

  it("says there are no members yet", async () => {
    workspace.getWorkspaceMembers.mockResolvedValue([]);
    await expect(okData("listMembers")).resolves.toBe("The organisation has no members yet.");
  });

  it("formats members, falling back on every optional field", async () => {
    workspace.getWorkspaceMembers.mockResolvedValue([
      { displayName: "Asha", membershipStatus: "active", roleKey: "coach", roleName: "Coach", joinedAt: "2026-01-01" },
      { displayName: null, membershipStatus: "invited", roleKey: "player", roleName: null, joinedAt: null },
    ]);
    await expect(okData("listMembers")).resolves.toBe(
      [
        "Asha — membership active, role Coach, joined 2026-01-01",
        "Unnamed member — membership invited, role player",
      ].join("\n"),
    );
  });
});

describe("getOrgOverview", () => {
  it("reports unavailable when the org read fails", async () => {
    workspace.getWorkspaceOrg.mockResolvedValue(null);
    await expect(failure("getOrgOverview")).resolves.toBe(UNAVAILABLE_TEXT);
  });

  it("reports unavailable when the team read fails", async () => {
    workspace.getWorkspaceOrg.mockResolvedValue({
      slug: "raptor",
      displayName: "Raptor",
      status: "active",
      timezone: "Europe/Berlin",
      locale: "de-DE",
      currency: "EUR",
    });
    workspace.getWorkspaceTeams.mockResolvedValue(null);
    await expect(failure("getOrgOverview")).resolves.toBe(UNAVAILABLE_TEXT);
  });

  it("reports unavailable when the member read fails", async () => {
    workspace.getWorkspaceOrg.mockResolvedValue({
      slug: "raptor",
      displayName: "Raptor",
      status: "active",
      timezone: "Europe/Berlin",
      locale: "de-DE",
      currency: "EUR",
    });
    workspace.getWorkspaceTeams.mockResolvedValue([]);
    workspace.getWorkspaceMembers.mockResolvedValue(null);
    await expect(failure("getOrgOverview")).resolves.toBe(UNAVAILABLE_TEXT);
  });

  it("describes the org with team and member counts", async () => {
    workspace.getWorkspaceOrg.mockResolvedValue({
      slug: "raptor",
      displayName: "Raptor",
      status: "active",
      timezone: "Europe/Berlin",
      locale: "de-DE",
      currency: "EUR",
    });
    workspace.getWorkspaceTeams.mockResolvedValue([
      { name: "Raptors", slug: "raptors", game: "CS2", division: null, status: "active", members: 5 },
    ]);
    workspace.getWorkspaceMembers.mockResolvedValue([
      { displayName: "Asha", membershipStatus: "active", roleKey: "owner", roleName: "Owner", joinedAt: "2026-01-01" },
    ]);
    await expect(okData("getOrgOverview")).resolves.toBe(
      [
        "Raptor (raptor) — status active; timezone Europe/Berlin; locale de-DE; currency EUR.",
        "1 active team(s).",
        "1 member(s).",
      ].join("\n"),
    );
  });
});
