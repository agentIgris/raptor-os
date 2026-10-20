import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "./prompt.js";

describe("buildSystemPrompt", () => {
  it("states the caller's role", () => {
    const prompt = buildSystemPrompt("analyst", []);
    expect(prompt).toContain('"analyst"');
  });

  it("lists every tool the route ran", () => {
    const prompt = buildSystemPrompt("owner", [
      "listTeams",
      "getOrgOverview",
    ]);
    expect(prompt).toContain("- listTeams");
    expect(prompt).toContain("- getOrgOverview");
  });

  it("does not leak tool names outside the provided set", () => {
    const prompt = buildSystemPrompt("player", ["listTeams"]);
    expect(prompt).toContain("- listTeams");
    expect(prompt).not.toContain("getOrgOverview");
  });

  it("renders a no-tools placeholder when nothing ran", () => {
    const prompt = buildSystemPrompt("pending", []);
    expect(prompt).toContain("(none)");
  });

  it("includes the grounding guardrails", () => {
    const prompt = buildSystemPrompt("coach", ["getInsights"]);
    expect(prompt).toContain("using only the data");
    expect(prompt).toContain("Do not invent");
    expect(prompt).toContain("role, organization, or person");
  });
});
