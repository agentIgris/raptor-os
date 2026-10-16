import { describe, expect, it } from "vitest";

import { groupRoster, toDateTime, toISODate } from "./public-view";

/**
 * Roster grouping without a database: teams collect their public members,
 * private profiles (null/empty handle) vanish instead of rendering as
 * anonymous slots, and a missing role defaults to player.
 */
describe("groupRoster", () => {
  it("groups memberships by team", () => {
    const teams = groupRoster([
      {
        team_name: "Alpha",
        team_slug: "alpha",
        team_status: "active",
        game_name: "BGMI",
        division_name: "Elite",
        handle: "kirra",
        role_in_team: "captain",
      },
      {
        team_name: "Alpha",
        team_slug: "alpha",
        team_status: "active",
        game_name: "BGMI",
        division_name: "Elite",
        handle: "ozz",
        role_in_team: "player",
      },
    ]);
    expect(teams).toHaveLength(1);
    expect(teams[0]?.players).toEqual([
      { handle: "kirra", role: "captain" },
      { handle: "ozz", role: "player" },
    ]);
  });

  it("skips memberships with no public handle", () => {    const teams = groupRoster([
      {
        team_name: "Alpha",
        team_slug: "alpha",
        team_status: "active",
        game_name: "BGMI",
        division_name: null,
        handle: null,
        role_in_team: "player",
      },
      {
        team_name: "Alpha",
        team_slug: "alpha",
        team_status: "active",
        game_name: "BGMI",
        division_name: null,
        handle: "",
        role_in_team: "player",
      },
      {
        team_name: "Alpha",
        team_slug: "alpha",
        team_status: "active",
        game_name: "BGMI",
        division_name: null,
        handle: "bramble",
        role_in_team: null,
      },
    ]);
    expect(teams).toHaveLength(1);
    expect(teams[0]?.players).toEqual([{ handle: "bramble", role: "player" }]);
  });
});

describe("driver date normalization", () => {
  // node-postgres parses timestamptz into Date; CMS JSON carries ISO strings.
  // Both shapes must render identically — `.slice` on a Date throws in render
  // and trips the route error boundary (caught live, 2026-10-14).
  it("formats ISO strings and Dates identically", () => {
    expect(toISODate("2026-06-21T20:00:00.000Z")).toBe("2026-06-21");
    expect(toISODate(new Date("2026-06-21T20:00:00.000Z"))).toBe("2026-06-21");
    expect(toDateTime("2026-06-21T20:00:00.000Z")).toBe("2026-06-21 20:00");
    expect(toDateTime(new Date("2026-06-21T20:00:00.000Z"))).toBe("2026-06-21 20:00");
  });
});
