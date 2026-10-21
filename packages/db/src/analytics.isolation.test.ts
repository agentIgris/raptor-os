/**
 * The analytics functions, CALLED.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * `analytics_top_teams` and `analytics_metric_summary` are what the workspace's
 * Analytics page is built on, and until now NOTHING called them. The
 * per-player leaderboard next door has six tests; these two had none, which is
 * how this shipped:
 *
 * `analytics_top_teams` is a `plpgsql` function whose signature declares
 * `team_name text` while its body returns `team.name` — a `varchar(160)`. A
 * `LANGUAGE sql` function coerces its result to the declared types; a `plpgsql`
 * one does not, and `RETURN QUERY` raises
 *
 *     structure of query does not match function result type
 *
 * AT CALL TIME. So the function installed cleanly, was granted cleanly, and
 * failed every time the page asked for a ranking. The page caught the failure
 * and rendered "Analytics unavailable"; the log said nothing.
 *
 * The same class of defect took out `auth_active_orgs_for_token` in the
 * identity schema, where the consequence was worse — the session never got an
 * organisation bound, so EVERY workspace page degraded. Two functions, two
 * schemas, one mistake.
 *
 * So these are called here, in a database with two tenants and real rows, and
 * the assertions are about what a caller sees: the call does not raise, and it
 * returns the caller's tenant's rows and nobody else's.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migrateUp } from "./migrations.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const GAME = "33333333-3333-3333-3333-333333333333";
const GAME_B = "abababab-abab-4bab-8bab-abababababab";
const TEAM_A = "44444444-4444-4444-4444-444444444444";
const TEAM_B = "55555555-5555-5555-5555-555555555555";
const OPPONENT = "66666666-6666-6666-6666-666666666666";
const OPPONENT_B = "abababab-abab-4bab-8bab-abababababac";
const MATCH_A = "77777777-7777-7777-7777-777777777777";
const MATCH_B = "88888888-8888-8888-8888-888888888888";
const RESULT_A = "99999999-9999-9999-9999-999999999999";
const RESULT_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

let db: PGlite;

const FROM = new Date("2026-01-01T00:00:00Z");
const TO = new Date("2026-12-31T00:00:00Z");

async function asOwner(sql: string): Promise<void> {
  await db.exec(sql);
}

async function appRows<T>(sql: string, params: readonly unknown[]): Promise<T[]> {
  await db.exec("SET ROLE raptor_app");
  await db.exec(`SELECT set_config('app.org_id', '${ORG_A}', false)`);
  try {
    const result = await db.query<T>(sql, params as unknown[]);
    return result.rows;
  } finally {
    await db.exec("RESET ROLE");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await migrateUp(db);
});

beforeEach(async () => {
  await db.exec("RESET ROLE");
  await db.exec("SELECT set_config('app.org_id', '', false)");

  await asOwner(`
    TRUNCATE match_result, match, opponent, team, game, organization CASCADE;
  `);

  await asOwner(`
    INSERT INTO organization (id, slug, display_name, default_currency, status)
    VALUES
      ('${ORG_A}', 'org-a', 'Org A', 'INR', 'active'),
      ('${ORG_B}', 'org-b', 'Org B', 'USD', 'active');

    INSERT INTO game (id, org_id, name, slug)
    VALUES
      ('${GAME}', '${ORG_A}', 'BGMI', 'bgmi'),
      ('${GAME_B}', '${ORG_B}', 'BGMI', 'bgmi');

    INSERT INTO team (id, org_id, name, slug, game_id, valid_from)
    VALUES
      ('${TEAM_A}', '${ORG_A}', 'Team A', 'team-a', '${GAME}', now()),
      ('${TEAM_B}', '${ORG_B}', 'Team B', 'team-b', '${GAME_B}', now());

    INSERT INTO opponent (id, org_id, name, game_id)
    VALUES
      ('${OPPONENT}', '${ORG_A}', 'Lobby', '${GAME}'),
      ('${OPPONENT_B}', '${ORG_B}', 'Lobby', '${GAME_B}');

    INSERT INTO match (id, org_id, team_id, opponent_id, status, scheduled_at)
    VALUES
      ('${MATCH_A}', '${ORG_A}', '${TEAM_A}', '${OPPONENT}', 'completed', '2026-06-01'),
      ('${MATCH_B}', '${ORG_B}', '${TEAM_B}', '${OPPONENT_B}', 'completed', '2026-06-01');

    INSERT INTO match_result (id, org_id, match_id, team_id, outcome, placement, source, confidence)
    VALUES
      ('${RESULT_A}', '${ORG_A}', '${MATCH_A}', '${TEAM_A}', 'win', 1, 'system', 1),
      ('${RESULT_B}', '${ORG_B}', '${MATCH_B}', '${TEAM_B}', 'win', 1, 'system', 1);
  `);
});

describe("analytics_top_teams", () => {
  it("answers, and answers with the caller's tenant", async () => {
    // The call is the assertion. Before the cast was added, this raised
    // "structure of query does not match function result type" — a failure the
    // Analytics page swallowed into "Analytics unavailable".
    const rows = await appRows<{ team_id: string; team_name: string; matches_won: number; rank_position: number }>(
      "SELECT * FROM public.analytics_top_teams($1::timestamptz, $2::timestamptz, $3::integer)",
      [FROM.toISOString(), TO.toISOString(), 10],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.team_id).toBe(TEAM_A);
    expect(rows[0]?.team_name).toBe("Team A");
    expect(rows[0]?.matches_won).toBe(1);
    expect(rows[0]?.rank_position).toBe(1);
  });

  it("never returns another tenant's team", async () => {
    const rows = await appRows<{ team_id: string }>(
      "SELECT * FROM public.analytics_top_teams($1::timestamptz, $2::timestamptz, $3::integer)",
      [FROM.toISOString(), TO.toISOString(), 10],
    );

    expect(rows.map((row) => row.team_id)).not.toContain(TEAM_B);
  });
});

describe("analytics_metric_summary", () => {
  it("answers, with a status for every metric", async () => {
    const rows = await appRows<{ metric_key: string; metric_status: string }>(
      "SELECT metric_key, metric_status::text AS metric_status FROM public.analytics_metric_summary($1::timestamptz, $2::timestamptz)",
      [FROM.toISOString(), TO.toISOString()],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.metric_key).not.toBe("");
      expect(["available", "unavailable"]).toContain(row.metric_status);
    }
  });
});
