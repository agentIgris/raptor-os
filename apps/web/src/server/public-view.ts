import type { PublicPlayer, PublicTeam } from "./public";

/**
 * Normalise a database timestamp for display.
 *
 * node-postgres parses `timestamptz` into a `Date`, while CMS JSON carries
 * ISO strings — and calling `.slice` on a `Date` throws inside render,
 * tripping the route error boundary. This function accepts both shapes so a
 * driver upgrade or a new caller cannot reintroduce that crash.
 */
export function toISODate(value: string | Date): string {
  const iso = value instanceof Date ? value.toISOString() : value;
  return iso.slice(0, 10);
}

/** Date plus `HH:MM` for schedules. Same dual-shape contract as `toISODate`. */
export function toDateTime(value: string | Date): string {
  const iso = value instanceof Date ? value.toISOString() : value;
  return iso.slice(0, 16).replace("T", " ");
}

interface TeamRow {
  readonly team_name: string;
  readonly team_slug: string;
  readonly team_status: string;
  readonly game_name: string;
  readonly division_name: string | null;
  readonly handle: string | null;
  readonly role_in_team: string | null;
}

/** Group flat roster rows into teams. Pure: unit-tested without a database. */
export function groupRoster(rows: readonly TeamRow[]): PublicTeam[] {
  const teams = new Map<string, PublicTeam & { players: PublicPlayer[] }>();
  for (const row of rows) {
    let team = teams.get(row.team_slug);
    if (team === undefined) {
      team = {
        name: row.team_name,
        slug: row.team_slug,
        status: row.team_status,
        gameName: row.game_name,
        divisionName: row.division_name,
        players: [],
      };
      teams.set(row.team_slug, team);
    }
    // `handle` is null when the membership has no PUBLIC profile — a private
    // profile is skipped, never rendered as an anonymous slot.
    if (row.handle !== null && row.handle !== "") {
      team.players.push({ handle: row.handle, role: row.role_in_team ?? "player" });
    }
  }
  return [...teams.values()];
}
