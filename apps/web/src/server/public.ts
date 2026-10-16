import { Pool, type PoolClient } from "pg";

import { tlsOptionsForDatabaseUrl } from "@raptor/auth";

import { groupRoster, toISODate } from "./public-view";

/**
 * Public-site reads over the domain database.
 *
 * THREE RULES, all load-bearing:
 *
 * 1. TENANT FIRST. Every query runs inside `BEGIN; SET LOCAL app.org_id; …
 *    COMMIT` with the org resolved from `PUBLIC_ORG_SLUG`. `raptor_app` with
 *    no tenant context sees NOTHING (RLS fails closed), so a pool query
 *    without the SET LOCAL is not "unscoped" — it is empty. Forgetting the
 *    context once produces a page of empty states that looks exactly like "no
 *    data yet", which is why the context lives in this one helper and not at
 *    each call site.
 *
 * 2. NEVER THROW TO THE PAGE. The fan site must survive a database outage
 *    with honest empty/error states (and the e2e suite runs with NO database
 *    at all). Every entry point catches and returns `null`. A `null` is
 *    "unknown", never "empty" — sections render accordingly.
 *
 * 3. PUBLIC FIELDS ONLY. Handles come from `roster_handles()` filtered to
 *    `visibility = 'public'` — `person_profile` itself carries RLS with no
 *    policy, so no application role can read it directly, by design. No
 *    contact data, no member metadata, no internal analytics cross this
 *    boundary — see the column lists, which name every selected field.
 */

export interface PublicDivision {
  readonly gameName: string;
  readonly gameSlug: string;
  readonly name: string;
  readonly slug: string;
  readonly tier: string;
  readonly teamCount: number;
}

export interface PublicPlayer {
  readonly handle: string;
  readonly role: string;
}

export interface PublicTeam {
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly gameName: string;
  readonly divisionName: string | null;
  readonly players: readonly PublicPlayer[];
}

export interface PublicResult {
  readonly event: string;
  readonly team: string;
  readonly division: string | null;
  readonly placement: number | null;
  readonly outcome: string;
  readonly date: string;
}

let pool: Pool | null = null;

function appPool(): Pool {
  if (pool === null) {
    const raw = process.env["DATABASE_URL"] ?? "postgresql://raptor_app@127.0.0.1:5432/raptor_os";
    const resolved = tlsOptionsForDatabaseUrl(raw);
    pool = new Pool({
      connectionString: resolved.connectionString,
      // More slots than the home page's concurrent domain reads (3), so a
      // slow query cannot starve its siblings into the acquire timeout.
      max: 5,
      // One warm connection: the first visitor of a fresh server must not pay
      // a cold TLS handshake before any byte renders.
      min: 1,
      connectionTimeoutMillis: 2_000,
      application_name: "raptor_public_site",
      ...(resolved.ssl === undefined ? {} : { ssl: resolved.ssl }),
    });
    pool.on("error", () => {
      // Idle-client death must not crash the process; the next request
      // re-establishes. Logged nowhere because the pool has no logger here —
      // the section simply reports unknown on its next render.
    });
  }
  return pool;
}

function publicOrgId(): string | null {
  // The id comes from configuration, not from a lookup: resolving the org by
  // slug would itself need a tenant context (`organization_tenant_isolation`
  // reads zero rows when unset), so a lookup-first design can never bootstrap.
  const id = process.env["PUBLIC_ORG_ID"] ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

/**
 * Run `work` with the public org in context.
 *
 * Returns `null` when no org is configured, or on any failure — the caller
 * renders "unknown", and no stack trace reaches the page.
 */
async function withPublicOrg<T>(work: (client: PoolClient, orgId: string) => Promise<T>): Promise<T | null> {
  const orgId = publicOrgId();
  if (orgId === null) return null;
  // One retry: a pooled connection that died idle takes exactly one failed
  // query with it (node-postgres drops it, but the query is already lost).
  // Reads here are idempotent SELECTs, so retrying is safe; anything
  // persistent fails twice and still degrades to unknown.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await withPublicOrgOnce(work, orgId);
    if (result !== null) return result;
  }
  return null;
}

async function withPublicOrgOnce<T>(
  work: (client: PoolClient, orgId: string) => Promise<T>,
  orgId: string,
): Promise<T | null> {
  let client: PoolClient | null = null;
  try {
    client = await appPool().connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    try {
      const result = await work(client, orgId);
      await client.query("COMMIT");
      return result;
    } catch {
      await client.query("ROLLBACK");
      return null;
    }
  } catch {
    return null;
  } finally {
    client?.release();
  }
}

/** Divisions with live team counts, ordered for display. */
export async function getPublicDivisions(): Promise<readonly PublicDivision[] | null> {
  return withPublicOrg(async (client, orgId) => {
    const result = await client.query<{
      game_name: string;
      game_slug: string;
      name: string;
      slug: string;
      tier: string;
      team_count: string;
    }>(
      `SELECT g.name AS game_name, g.slug AS game_slug,
              d.name AS name, d.slug AS slug, d.tier AS tier,
              (SELECT count(*) FROM team t
                WHERE t.division_id = d.id AND t.archived_at IS NULL) AS team_count
         FROM division d
         JOIN season s ON s.org_id = $1 AND s.id = d.season_id
         JOIN title ti ON ti.org_id = $1 AND ti.id = s.title_id
         JOIN game g ON g.org_id = $1 AND g.id = ti.game_id
        WHERE d.org_id = $1 AND d.valid_to IS NULL AND d.archived_at IS NULL
          AND g.is_active AND g.archived_at IS NULL
        ORDER BY g.name, d.rank_order`,
      [orgId],
    );
    return result.rows.map((row) => ({
      gameName: row.game_name,
      gameSlug: row.game_slug,
      name: row.name,
      slug: row.slug,
      tier: row.tier,
      teamCount: Number.parseInt(row.team_count, 10),
    }));
  });
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

/** Teams with public rosters. */
export async function getPublicTeams(): Promise<readonly PublicTeam[] | null> {
  return withPublicOrg(async (client, orgId) => {
    const result = await client.query<TeamRow>(
      `SELECT t.name AS team_name, t.slug AS team_slug, t.status AS team_status,
              g.name AS game_name, d.name AS division_name,
              rh.handle AS handle, rh.role_in_team AS role_in_team
         FROM team t
         JOIN game g ON g.org_id = $1 AND g.id = t.game_id
         LEFT JOIN division d ON d.org_id = $1 AND d.id = t.division_id
         LEFT JOIN roster_handles() rh
           ON rh.team_slug = t.slug AND rh.visibility = 'public'
        WHERE t.org_id = $1 AND t.is_active AND t.archived_at IS NULL
        ORDER BY g.name, t.name`,
      [orgId],
    );
    return groupRoster(result.rows);
  });
}

/** Verified placements only: an unverified result is a rumour, not a result. */
export async function getPublicResults(): Promise<readonly PublicResult[] | null> {
  return withPublicOrg(async (client, orgId) => {
    const result = await client.query<{
      event: string;
      team: string;
      division: string | null;
      placement: number | null;
      outcome: string;
      date: string | Date;
    }>(
      `SELECT c.name AS event, t.name AS team, d.name AS division,
              mr.placement AS placement, mr.outcome AS outcome,
              m.completed_at AS date
         FROM match_result mr
         JOIN "match" m ON m.org_id = $1 AND m.id = mr.match_id
         JOIN team t ON t.org_id = $1 AND t.id = mr.team_id
         LEFT JOIN competition_division cd ON cd.org_id = $1 AND cd.id = m.competition_division_id
         LEFT JOIN competition c ON c.org_id = $1 AND c.id = cd.competition_id
         LEFT JOIN division d ON d.org_id = $1 AND d.id = cd.division_id
        WHERE mr.org_id = $1 AND mr.archived_at IS NULL
          AND mr.verified_at IS NOT NULL AND m.completed_at IS NOT NULL
        ORDER BY m.completed_at DESC
        LIMIT 12`,
      [orgId],
    );
    return result.rows.map((row) => ({
      event: row.event ?? "Match",
      team: row.team,
      division: row.division,
      placement: row.placement,
      outcome: row.outcome,
      date: toISODate(row.date),
    }));
  });
}
