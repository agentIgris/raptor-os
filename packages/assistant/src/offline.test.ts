import { describe, expect, it } from "vitest";

import { OFFLINE_DISCLAIMER, composeOfflineAnswer } from "./offline.js";
import type { OfflineToolOutcome } from "./offline.js";

describe("composeOfflineAnswer", () => {
  it("marks non-run tools as skipped", () => {
    const outcomes: OfflineToolOutcome[] = [
      { tool: "listMembers", result: null },
    ];
    const answer = composeOfflineAnswer("who is on staff", "coach", outcomes);
    expect(answer.mode).toBe("offline");
    expect(answer.question).toBe("who is on staff");
    expect(answer.role).toBe("coach");
    expect(answer.disclaimer).toBe(OFFLINE_DISCLAIMER);
    expect(answer.sections).toEqual([
      { tool: "listMembers", status: "skipped" },
    ]);
  });

  it("carries successful tool data through unchanged", () => {
    const outcomes: OfflineToolOutcome[] = [
      { tool: "listTeams", result: { ok: true, data: [{ name: "A", id: 1 }] } },
    ];
    const answer = composeOfflineAnswer("teams", "player", outcomes);
    expect(answer.sections).toEqual([
      {
        tool: "listTeams",
        status: "ok",
        data: [{ name: "A", id: 1 }],
      },
    ]);
  });

  it("carries tool errors through as error sections", () => {
    const outcomes: OfflineToolOutcome[] = [
      { tool: "getRoster", result: { ok: false, error: "team not found" } },
    ];
    const answer = composeOfflineAnswer("roster", "coach", outcomes);
    expect(answer.sections).toEqual([
      { tool: "getRoster", status: "error", error: "team not found" },
    ]);
  });

  it("preserves outcome order and handles mixed statuses", () => {
    const outcomes: OfflineToolOutcome[] = [
      { tool: "listTeams", result: { ok: true, data: [] } },
      { tool: "getInsights", result: null },
      { tool: "getRoster", result: { ok: false, error: "boom" } },
      { tool: "listCompetitions", result: { ok: true, data: null } },
    ];
    const answer = composeOfflineAnswer("overview", "manager", outcomes);
    expect(answer.sections.map((section) => section.status)).toEqual([
      "ok",
      "skipped",
      "error",
      "ok",
    ]);
  });

  it("returns an empty sections list for no outcomes", () => {
    const answer = composeOfflineAnswer("anything", "owner", []);
    expect(answer.sections).toEqual([]);
    expect(answer.disclaimer).toBe(OFFLINE_DISCLAIMER);
  });
});
