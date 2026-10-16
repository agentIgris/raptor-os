import type { PoolClient, QueryResultRow } from "pg";

import { groupRoster, toDateTime, toISODate } from "./public-view";
import type { PublicTeam } from "./public";
import { withOrg } from "./orgs";

/**
 * Workspace reads: the session organisation's operational data.
 *
 * Same contract as the public reads — tenant context per transaction
 * (`withOrg`), never throws (pages render states, not stack traces) — except
 * the scope is the SESSION org, which the layout guard already resolved.
 * Internal pages may show display names regardless of profile visibility;
 * legal names, contact data and credential material are never selected
 * (see the column lists).
 */

export interface WorkspaceTeam {
  readonly name: string;
  readonly slug: string;
  readonly game: string;
  readonly division: string | null;
  readonly status: string;
  readonly members: number;
}

export interface WorkspaceCompetition {
  readonly name: string;
  readonly format: string;
  readonly status: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly registrations: number;
}

export interface WorkspaceMatch {
  readonly team: string;
  readonly round: string | null;
  readonly scheduledAt: string;
  readonly status: string;
}

export interface WorkspaceMemberRow {
  readonly displayName: string | null;
  readonly membershipStatus: string;
  readonly roleKey: string | null;
  readonly roleName: string | null;
  readonly joinedAt: string | null;
}

export interface WorkspaceOrg {
  readonly slug: string;
  readonly displayName: string;
  readonly status: string;
  readonly timezone: string;
  readonly locale: string;
  readonly currency: string;
}

export interface MetricRow {
  readonly key: string;
  readonly status: string;
  readonly detail: string | null;
  readonly value: string | null;
}

export interface TopTeamRow {
  readonly name: string;
  readonly rank: number | null;
  readonly won: number;
  readonly lost: number;
  readonly winRate: string | null;
}

export interface PlayerRow {
  readonly handle: string;
  readonly played: number;
  readonly wins: number;
  readonly kd: string | null;
}

async function query<T extends QueryResultRow>(orgId: string, sql: string, params: readonly unknown[]): Promise<readonly T[] | null> {
  return withOrg(orgId, async (client: PoolClient) => {
    const result = await client.query<T>(sql, [...params]);
    return result.rows;
  });
}

export async function getWorkspaceTeams(orgId: string | null): Promise<readonly WorkspaceTeam[] | null> {
  if (orgId === null) return null;
  const rows = await query<{
    name: string;
    slug: string;
    game: string;
    division: string | null;
    status: string;
    members: string;
  }>(
    orgId,
    `SELECT t.name AS name, t.slug AS slug, g.name AS game,
            d.name AS division, t.status AS status,
            (SELECT count(*) FROM team_membership tm
              WHERE tm.team_id = t.id AND tm.valid_to IS NULL) AS members
       FROM team t
       JOIN game g ON g.id = t.game_id
       LEFT JOIN division d ON d.id = t.division_id
      WHERE t.archived_at IS NULL
      ORDER BY g.name, t.name`,
    [],
  );
  if (rows === null) return null;
  // count(*) arrives as text over the wire; the interface promises a number.
  return rows.map((row) => ({ ...row, members: Number.parseInt(row.members, 10) }));
}

/**
 * Full current rosters for the workspace. Unlike the public roster, internal
 * viewers see every member: missing display names render as "Unnamed member"
 * rather than vanishing (the public page instead skips non-public profiles).
 */
export async function getWorkspaceRosters(orgId: string | null): Promise<readonly PublicTeam[] | null> {
  if (orgId === null) return null;
  return withOrg(orgId, async (client: PoolClient) => {
    const result = await client.query<{
      team_name: string;
      team_slug: string;
      team_status: string;
      game_name: string;
      division_name: string | null;
      handle: string;
      role_in_team: string | null;
    }>(
      `SELECT t.name AS team_name, t.slug AS team_slug, t.status AS team_status,
              g.name AS game_name, d.name AS division_name,
              COALESCE(rh.handle, 'Unnamed member') AS handle,
              rh.role_in_team AS role_in_team
         FROM team t
         JOIN game g ON g.id = t.game_id
         LEFT JOIN division d ON d.id = t.division_id
         LEFT JOIN roster_handles() rh ON rh.team_slug = t.slug
        WHERE t.archived_at IS NULL
        ORDER BY g.name, t.name`,
      [],
    );
    return groupRoster(result.rows);
  });
}

export async function getWorkspaceCompetitions(orgId: string | null): Promise<{
  readonly competitions: readonly WorkspaceCompetition[] | null;
  readonly upcoming: readonly WorkspaceMatch[] | null;
}> {
  if (orgId === null) return { competitions: null, upcoming: null };
  const competitionRows = await query<{
    name: string;
    format: string;
    status: string;
    startsAt: string | Date;
    endsAt: string | Date;
    registrations: string;
  }>(
    orgId,
    `SELECT c.name AS name, c.format AS format, c.status AS status,
            c.starts_at AS "startsAt", c.ends_at AS "endsAt",
            (SELECT count(*) FROM registration r
               JOIN competition_division cd ON cd.id = r.competition_division_id
              WHERE cd.competition_id = c.id AND r.withdrawn_at IS NULL) AS registrations
       FROM competition c
      WHERE c.archived_at IS NULL
      ORDER BY c.starts_at DESC`,
    [],
  );
  const upcomingRows = await query<{
    team: string;
    round: string | null;
    scheduledAt: string | Date;
    status: string;
  }>(
    orgId,
    `SELECT t.name AS team, m.round_label AS round,
            m.scheduled_at AS "scheduledAt", m.status AS status
       FROM "match" m
       JOIN team t ON t.id = m.team_id
      WHERE m.status = 'scheduled' AND m.archived_at IS NULL
      ORDER BY m.scheduled_at ASC
      LIMIT 10`,
    [],
  );
  if (competitionRows === null || upcomingRows === null) return { competitions: null, upcoming: null };
  return {
    competitions: competitionRows.map((row) => ({
      name: row.name,
      format: row.format,
      status: row.status,
      startsAt: toISODate(row.startsAt),
      endsAt: toISODate(row.endsAt),
      registrations: Number.parseInt(row.registrations, 10),
    })),
    upcoming: upcomingRows.map((row) => ({
      team: row.team,
      round: row.round,
      scheduledAt: toDateTime(row.scheduledAt),
      status: row.status,
    })),
  };
}
export async function getWorkspaceMembers(orgId: string | null): Promise<readonly WorkspaceMemberRow[] | null> {
  if (orgId === null) return null;
  const rows = await query<{
    displayName: string | null;
    membershipStatus: string;
    roleKey: string | null;
    roleName: string | null;
    joinedAt: string | Date | null;
  }>(
    orgId,
    `SELECT pd.handle AS "displayName", m.status AS "membershipStatus",
            r.key AS "roleKey", r.name AS "roleName", m.joined_at AS "joinedAt"
       FROM org_membership m
       LEFT JOIN person_directory() pd ON pd.person_id = m.person_id
       LEFT JOIN role_assignment ra ON ra.person_id = m.person_id AND ra.valid_to IS NULL
       LEFT JOIN role r ON r.id = ra.role_id
      WHERE m.status <> 'left'
      ORDER BY pd.handle NULLS LAST, m.joined_at`,
    [],
  );
  if (rows === null) return null;
  return rows.map((row) => ({
    ...row,
    joinedAt: row.joinedAt === null ? null : toISODate(row.joinedAt),
  }));
}

export async function getWorkspaceOrg(orgId: string | null): Promise<WorkspaceOrg | null> {
  if (orgId === null) return null;
  const rows = await query<WorkspaceOrg>(
    orgId,
    `SELECT slug, display_name AS "displayName", status,
            default_timezone AS timezone, default_locale AS locale,
            default_currency AS currency
       FROM organization LIMIT 1`,
    [],
  );
  return rows?.[0] ?? null;
}

export async function getWorkspaceInsights(orgId: string | null): Promise<{
  readonly metrics: readonly MetricRow[];
  readonly teams: readonly TopTeamRow[];
  readonly players: readonly PlayerRow[];
} | null> {
  if (orgId === null) return null;
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  const metrics = await query<{
    metric_key: string;
    metric_status: string;
    unavailable_text: string | null;
    value: string | null;
  }>(
    orgId,
    `SELECT metric_key, metric_status::text AS metric_status, unavailable_text, value::text AS value
       FROM analytics_metric_summary($1, $2)`,
    [from.toISOString(), to.toISOString()],
  );
  const teams = await query<{
    team_name: string;
    rank_position: number | null;
    matches_won: number;
    matches_lost: number;
    map_win_rate: string | null;
  }>(
    orgId,
    `SELECT team_name, rank_position, matches_won, matches_lost, map_win_rate::text AS map_win_rate
       FROM analytics_top_teams($1, $2, 10)`,
    [from.toISOString(), to.toISOString()],
  );
  const players = await query<{
    handle: string | null;
    matches_played: number;
    wins: number;
    kd_ratio: string | null;
  }>(
    orgId,
    `SELECT pp.display_name AS handle, l.matches_played, l.wins, l.kd_ratio::text AS kd_ratio
       FROM player_performance_leaderboard($1, $2, 10) l
       LEFT JOIN person_profile pp ON pp.person_id = l.person_id
      ORDER BY l.rank_position`,
    [from.toISOString(), to.toISOString()],
  );
  if (metrics === null || teams === null || players === null) return null;
  return {
    metrics: metrics.map((row) => ({
      key: row.metric_key,
      status: row.metric_status,
      detail: row.unavailable_text,
      value: row.value,
    })),
    teams: teams.map((row) => ({
      name: row.team_name,
      rank: row.rank_position,
      won: row.matches_won,
      lost: row.matches_lost,
      winRate: row.map_win_rate,
    })),
    players: players.map((row) => ({
      handle: row.handle ?? "Unnamed",
      played: row.matches_played,
      wins: row.wins,
      kd: row.kd_ratio,
    })),
  };
}
