/**
 * Performance metrics — ADR-0019's six requirements, asserted.
 *
 * ADR-0019 (`docs/adr/0019-performance-metrics-designed-not-recovered.md`) records
 * the opposite outcome to every other ADR in this repository: the legacy system had
 * NO performance formula to recover, so this layer had to be DESIGNED. The ADR's
 * evidence is specific and none of it is carried forward:
 *
 *   * no match entity existed, so every aggregate counted PLAYER ROWS. A four-player
 *     squad win reported four wins (`/api/public/stats/route.ts:26-28`).
 *   * "Win rate" was `totalMatches * 0.7` and "Team Ranking" was
 *     `Math.ceil(totalMatches / 5)` — invented constants rendered as measurements.
 *   * OCR confidence was hardcoded to `85`, and results carried no provenance at
 *     all, so a machine read and a hand-typed number were indistinguishable.
 *   * `survival_time` was minutes on one surface and seconds on another, and a
 *     stored `10` is indistinguishable from a stored `600` forever after.
 *   * every time window filtered on `created_at`, so backfilled history landed in
 *     the present bucket.
 *   * `limit` silently capped at 1000 rows and the capped set was presented as a
 *     ranking.
 *
 * Each of those has a named test below, and each test names the requirement it
 * defends. Where ADR-0019 lists something as deliberately absent — a K/D ratio
 * (deaths were never tracked), ADR, ACS, impact, headshot percentage, a month
 * rollup, a tier sort — the absence is asserted too. A metric that cannot be
 * derived from stored inputs is absent, not fabricated, and a test that only ever
 * checks what exists cannot tell the difference.
 *
 * METHOD
 * ------
 * Every assertion runs real SQL against a real PGlite instance against seeded
 * data. Structural claims are made by reflecting over the catalogue rather than by
 * trusting the DDL, matching `competitive.isolation.test.ts`.
 *
 * Calendar windows are derived from the DATABASE's own clock inside SQL rather
 * than hard-coded, because the property under test is "a window follows the event,
 * not the insert" and that has to stay true whatever day the suite is run on.
 * Nothing here assembles a timestamp by string concatenation: PostgreSQL silently
 * parses a malformed ISO literal into a wrong-but-valid instant with no error
 * (recorded in `history.queries.test.ts`), and a fixture built that way looks
 * right and quietly shifts by an hour.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migrateUp, migrationStatus } from "./migrations.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

/**
 * Every table introduced by 0007_performance_metrics.sql.
 *
 * Held explicitly rather than derived from `schema_migration`: the point of these
 * tests is that a table which should exist is actually present and actually
 * protected, and a list derived from the migration file would let a table drop out
 * of the schema and out of its own test in the same commit.
 */
const PERFORMANCE_TABLES = ["match_player_performance", "performance_extraction"] as const;

/** A four-player squad, which is what makes a double-count visible. */
const SQUAD_A = [
  "aaaaaaaa-0000-0000-0000-000000000001",
  "aaaaaaaa-0000-0000-0000-000000000002",
  "aaaaaaaa-0000-0000-0000-000000000003",
  "aaaaaaaa-0000-0000-0000-000000000004",
] as const;

/** ORG_B's one player. A person may belong to several organisations. */
const P_B = "bbbbbbbb-0000-0000-0000-000000000001";

let db: PGlite;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** As the schema owner, which bypasses RLS. Used only for seeding and reflection. */
async function asOwner(sql: string): Promise<void> {
  await db.exec("RESET ROLE");
  await db.exec(sql);
}

async function ownerRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec("RESET ROLE");
  const result = await db.query<T>(sql, params);
  return result.rows;
}

/**
 * Runs `fn` as the non-superuser application role.
 *
 * A superuser bypasses every policy in this schema, so an isolation assertion made
 * as the owner proves nothing (ADR-0006). See the role-attribute assertion below.
 */
async function asApp(fn: (sql: string) => Promise<void>, orgId?: string): Promise<void> {
  await db.exec("SET ROLE raptor_app");
  if (orgId) await db.exec(`SET app.org_id = '${orgId}'`);
  else await db.exec("SELECT set_config('app.org_id', '', false)");
  try {
    await fn("");
  } finally {
    await db.exec("RESET ROLE");
  }
}

/**
 * A query through the application role with ORG_A in the session context.
 *
 * The leaderboard takes NO organisation parameter — the tenant comes from the
 * session, never from the caller (ADR-0011 rule 3) — so every leaderboard
 * assertion necessarily goes through this path rather than the owner.
 */
async function appRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec("SET ROLE raptor_app");
  await db.exec(`SET app.org_id = '${ORG_A}'`);
  try {
    const result = await db.query<T>(sql, params);
    return result.rows;
  } finally {
    await db.exec("RESET ROLE");
  }
}

/**
 * Runs `fn` expecting PostgreSQL to refuse it with a specific SQLSTATE.
 *
 * Asserting the code rather than the message: several distinct guarantees in this
 * schema all produce "rejected", and a message match would let the wrong mechanism
 * satisfy a test that claims a specific one.
 */
async function expectSqlstate(fn: () => Promise<unknown>, sqlstate: string, label: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }

  if (caught === undefined) {
    throw new Error(`${label}: expected SQLSTATE ${sqlstate} but the statement succeeded`);
  }

  const actual = (caught as { code?: string }).code;
  expect(actual, `${label}: wrong SQLSTATE — ${String((caught as Error).message).slice(0, 200)}`).toBe(sqlstate);
}

const SQLSTATE_CHECK_VIOLATION = "23514";
const SQLSTATE_FOREIGN_KEY_VIOLATION = "23503";
const SQLSTATE_UNIQUE_VIOLATION = "23505";
const SQLSTATE_NOT_NULL_VIOLATION = "23502";
const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";
const SQLSTATE_EXCLUSION_VIOLATION = "23P01";

// ---------------------------------------------------------------------------
// Calendar windows
// ---------------------------------------------------------------------------

/**
 * Month boundaries derived from the database's own clock.
 *
 * Computed in SQL, not in JavaScript, for two reasons. PGlite returns `timestamptz`
 * to Node as host-timezone `Date` objects, so a boundary built in JS would carry
 * the test runner's +05:30 into the comparison and the assertion would be testing
 * the locale. And the property under test — "a window follows the event, not the
 * insert" — has to remain true whenever the suite runs, so the windows are "the
 * month before this one" rather than a fixed calendar month that silently stops
 * being last month next year.
 */
interface Windows {
  /** Start of the previous calendar month, as a timestamptz literal for a query. */
  readonly prevMonthStart: string;
  /** Start of the current calendar month — the exclusive end of the previous one. */
  readonly monthStart: string;
  /** Start of today. */
  readonly dayStart: string;
  /**
   * The END of today, computed in SQL rather than concatenated onto `dayStart`.
   *
   * This exists because of the trap the brief names: PostgreSQL does not reject
   * `"2026-10-10T00:00:00Z" + "T23:59:59Z"`. It parses the doubled zone suffix into
   * a *wrong but valid* instant with no error at all, and the fixture looks right.
   */
  readonly dayEnd: string;
  /** The event instant used for the backfill fixture: the 14th of the previous month. */
  readonly eventAt: string;
}

async function calendarWindows(): Promise<Windows> {
  const found = await ownerRows<{
    prev_month_start: string;
    month_start: string;
    day_start: string;
    day_end: string;
    event_at: string;
  }>(
    `SELECT to_char(m - interval '1 month', 'YYYY-MM-DD"T"HH24:MI:SS')                    AS prev_month_start,
            to_char(m,                 'YYYY-MM-DD"T"HH24:MI:SS')                             AS month_start,
            to_char(d,                 'YYYY-MM-DD"T"HH24:MI:SS')                             AS day_start,
            to_char(d + interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS')                         AS day_end,
            -- The 14th of the previous month, computed rather than concatenated so the
            -- literal handed to the INSERT is one PostgreSQL itself produced.
            to_char(m - interval '1 month' + interval '14 days', 'YYYY-MM-DD"T"HH24:MI:SS')  AS event_at
       FROM (SELECT date_trunc('month', now()) AS m, date_trunc('day', now()) AS d) c`,
  );

  // Mapped explicitly rather than aliased in SQL: the driver hands back the column
  // names the query chose, so a camelCase interface read straight off the row would
  // be silently undefined and every later assertion would be testing "undefined".
  const row = found[0]!;
  return {
    prevMonthStart: row.prev_month_start,
    monthStart: row.month_start,
    dayStart: row.day_start,
    dayEnd: row.day_end,
    eventAt: row.event_at,
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface SquadWin {
  readonly gameId: string;
  readonly teamId: string;
  readonly opponentId: string;
  readonly matchId: string;
  readonly resultId: string;
  readonly extractionId: string;
  readonly squad: readonly string[];
}

/**
 * Raw inputs for one player's line in the squad win.
 *
 * Deliberately chosen so every derived value is a real four-decimal figure rather
 * than a recurring 1 or 0, which would make a wrong rounding mode invisible.
 */
const RAW_INPUTS = {
  rounds_played: 24,
  kills: 20,
  deaths: 5,
  assists: 7,
  damage_dealt: 4800,
  damage_taken: 3600,
  headshot_attempts: 40,
  headshots: 11,
  survival_time_seconds: 3725,
} as const;

/** The values the derivations must produce from {@link RAW_INPUTS}, at scale 4. */
const DERIVED = {
  kills_per_round: "0.8333",
  deaths_per_round: "0.2083",
  assists_per_round: "0.2917",
  damage_per_round: "200.0000",
  kd_ratio: "4.0000",
  headshot_rate_pct: "27.5000",
} as const;

/**
 * Builds a completed match won by a four-player squad: one `match`, one
 * `match_result` with placement 1, one `performance_extraction`, and four
 * `match_player_performance` rows.
 *
 * Four stat rows for one match is exactly the shape the legacy system counted as
 * four matches. Every test that reports a count below is only meaningful because
 * this fixture produces four lines and still yields one.
 */
async function seedSquadWin(orgId: string, prefix: string, squad: readonly string[], eventAt: string): Promise<SquadWin> {
  const ids = {
    gameId: `${prefix}-0000-0000-0000-000000000001`,
    teamId: `${prefix}-0000-0000-0000-000000000002`,
    opponentId: `${prefix}-0000-0000-0000-000000000003`,
    matchId: `${prefix}-0000-0000-0000-000000000004`,
    resultId: `${prefix}-0000-0000-0000-000000000005`,
    extractionId: `${prefix}-0000-0000-0000-000000000006`,
  };

  await asOwner(`
    INSERT INTO game (id, org_id, name, slug)
    VALUES ('${ids.gameId}', '${orgId}', 'Perf Game', 'perf-game-${prefix}');

    INSERT INTO team (id, org_id, name, slug, game_id, valid_from)
    VALUES ('${ids.teamId}', '${orgId}', 'Perf Squad', 'perf-squad-${prefix}', '${ids.gameId}', '${eventAt}');

    INSERT INTO opponent (id, org_id, name, game_id)
    VALUES ('${ids.opponentId}', '${orgId}', 'Rival Crew', '${ids.gameId}');

    -- scheduled_at is the EVENT date and is the one instant on \`match\` that is NOT
    -- NULL for every match, so a window over \`match\` is well defined whether or not
    -- a backfill filled in started_at / completed_at. Filtering a window on
    -- completed_at would drop a match whose completion was never recorded, which is
    -- the "backfilled history disappears" failure in a different costume.
    INSERT INTO match (id, org_id, team_id, opponent_id, status, scheduled_at)
    VALUES ('${ids.matchId}', '${orgId}', '${ids.teamId}', '${ids.opponentId}', 'completed', '${eventAt}');

    INSERT INTO match_result (id, org_id, match_id, team_id, outcome, placement, source, confidence)
    VALUES ('${ids.resultId}', '${orgId}', '${ids.matchId}', '${ids.teamId}', 'win', 1, 'manual', 1);
  `);

  await asOwner(
    `INSERT INTO performance_extraction
       (id, org_id, match_id, source, extractor, payload_text, confidence, extracted_at)
     VALUES ('${ids.extractionId}', '${orgId}', '${ids.matchId}', 'ocr', 'stat-ocr 4.2',
             'kills=20 deaths=5 assists=7', 0.6210, '${eventAt}')`,
  );

  const lines = squad
    .map(
      (personId, index) => `('${prefix}-0000-0000-0000-00000000001${index}',
        '${orgId}', '${ids.matchId}', '${personId}', '${ids.extractionId}',
        'ocr', 0.6210,
        ${RAW_INPUTS.rounds_played}, ${RAW_INPUTS.kills}, ${RAW_INPUTS.deaths}, ${RAW_INPUTS.assists},
        ${RAW_INPUTS.damage_dealt}, ${RAW_INPUTS.damage_taken},
        ${RAW_INPUTS.headshot_attempts}, ${RAW_INPUTS.headshots},
        ${RAW_INPUTS.survival_time_seconds},
        ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
        ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})`,
    )
    .join(",\n       ");

  await asOwner(`
    INSERT INTO match_player_performance
      (id, org_id, match_id, person_id, extraction_id, source, confidence,
       rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
       headshot_attempts, headshots, survival_time_seconds,
       kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
       kd_ratio, headshot_rate_pct)
    VALUES ${lines}
  `);

  return { ...ids, squad };
}

/**
 * A single MATCHED line used where a squad is noise rather than the subject.
 *
 * The line is filed against the match `seedSquadMatch` already created, so it
 * inherits that match's event date. Callers therefore pass no date: a separate
 * date here would have to mutate a shared fixture to take effect, which is
 * exactly the kind of hidden coupling that makes a date-sensitive test
 * untrustworthy.
 */
async function seedSingleLine(orgId: string, personId: string): Promise<string> {
  const lineId = "99999999-0000-0000-0000-000000000001";
  await asOwner(`
    INSERT INTO match_player_performance
      (id, org_id, match_id, person_id, source, confidence,
       rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
       headshot_attempts, headshots, survival_time_seconds,
       kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
       kd_ratio, headshot_rate_pct)
    VALUES ('${lineId}', '${orgId}', '99999999-0000-0000-0000-000000000004', '${personId}',
            'manual', 1,
            ${RAW_INPUTS.rounds_played}, ${RAW_INPUTS.kills}, ${RAW_INPUTS.deaths}, ${RAW_INPUTS.assists},
            ${RAW_INPUTS.damage_dealt}, ${RAW_INPUTS.damage_taken},
            ${RAW_INPUTS.headshot_attempts}, ${RAW_INPUTS.headshots},
            ${RAW_INPUTS.survival_time_seconds},
            ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
            ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})
  `);
  return lineId;
}

/**
 * One completed match, lost, with room for exactly one player's line.
 *
 * The outcome is a LOSS on purpose. The leaderboard joins `match_result` rather
 * than inferring an outcome from a performance line, so a fixture whose match has
 * no recorded result would tell us nothing about how a loss is counted — and
 * "infers a win because someone posted numbers" is exactly the fabricated claim
 * ADR-0019 exists to end.
 */
async function seedLoneMatch(orgId: string, eventAt: string): Promise<void> {
  await asOwner(`
    INSERT INTO game (id, org_id, name, slug)
    VALUES ('88888888-0000-0000-0000-000000000001', '${orgId}', 'Lone Game', 'lone-game');

    INSERT INTO team (id, org_id, name, slug, game_id, valid_from)
    VALUES ('88888888-0000-0000-0000-000000000002', '${orgId}', 'Lone Squad', 'lone-squad',
            '88888888-0000-0000-0000-000000000001', '${eventAt}');

    INSERT INTO opponent (id, org_id, name, game_id)
    VALUES ('88888888-0000-0000-0000-000000000003', '${orgId}', 'Lone Rival', '88888888-0000-0000-0000-000000000001');

    INSERT INTO match (id, org_id, team_id, opponent_id, status, scheduled_at)
    VALUES ('99999999-0000-0000-0000-000000000004', '${orgId}',
            '88888888-0000-0000-0000-000000000002', '88888888-0000-0000-0000-000000000003',
            'completed', '${eventAt}');

    INSERT INTO match_result (org_id, match_id, team_id, outcome, source, confidence)
    VALUES ('${orgId}', '99999999-0000-0000-0000-000000000004',
            '88888888-0000-0000-0000-000000000002', 'loss', 'manual', 1);
  `);
}

beforeAll(async () => {
  db = new PGlite();
  await migrateUp(db);
});

beforeEach(async () => {
  await db.exec("RESET ROLE");
  await db.exec("SELECT set_config('app.org_id', '', false)");
  // organization cascades to every tenant table, so this is a complete reset.
  await asOwner("TRUNCATE organization, person CASCADE");
  await asOwner(`
    INSERT INTO organization (id, slug, display_name, default_currency, status)
    VALUES ('${ORG_A}', 'org-a', 'Org A', 'INR', 'active'),
           ('${ORG_B}', 'org-b', 'Org B', 'USD', 'active');

    INSERT INTO person (id, external_ref) VALUES
      ('${SQUAD_A[0]}', 'p1'), ('${SQUAD_A[1]}', 'p2'),
      ('${SQUAD_A[2]}', 'p3'), ('${SQUAD_A[3]}', 'p4'),
      ('${P_B}', 'pb');
  `);
});

// ---------------------------------------------------------------------------
// Isolation invariants
// ---------------------------------------------------------------------------

describe("performance schema — isolation", () => {
  it("applies 0007_performance_metrics.sql with no pending work", async () => {
    const status = await migrationStatus(db);
    expect(status.applied).toContain("0007_performance_metrics.sql");
    expect(status.pending).toHaveLength(0);
  });

  it("runs the isolation assertions as a role that CANNOT bypass RLS", async () => {
    // Without this, every isolation assertion below could pass while proving
    // nothing: a superuser bypasses every policy in this schema (ADR-0006).
    const found = await ownerRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'raptor_app'",
    );

    expect(found, "the application role must exist").toHaveLength(1);
    expect(found[0]!.rolsuper).toBe(false);
    expect(found[0]!.rolbypassrls).toBe(false);
  });

  it("ENABLES and FORCES row level security on every performance table", async () => {
    const found = await ownerRows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname = ANY($1) AND relkind = 'r'
        ORDER BY relname`,
      [[...PERFORMANCE_TABLES]],
    );

    expect(found.map((r) => r.relname)).toEqual([...PERFORMANCE_TABLES].sort());
    for (const row of found) {
      expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });

  it("gives every performance table one tenant policy with no IS NULL bypass", async () => {
    const found = await ownerRows<{ relname: string; polname: string; qual: string; with_check: string }>(
      `SELECT c.relname, p.polname,
              pg_get_expr(p.polqual, p.polrelid)    AS qual,
              pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = ANY($1)
        ORDER BY c.relname`,
      [[...PERFORMANCE_TABLES]],
    );

    expect(found).toHaveLength(PERFORMANCE_TABLES.length);
    for (const row of found) {
      expect(row.polname).toBe(`${row.relname}_tenant_isolation`);
      // The tenant predicate is the WHOLE predicate. An `OR org_id IS NULL` anywhere
      // here would hand every tenant every row whenever the context is missing.
      expect(row.qual).not.toMatch(/IS NULL/i);
      expect(row.with_check).not.toMatch(/IS NULL/i);
      expect(row.qual).toMatch(/org_id/);
      expect(row.with_check).toMatch(/org_id/);
    }
  });

  it("makes org_id NOT NULL on every performance table", async () => {
    const found = await ownerRows<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = ANY($1) AND column_name = 'org_id'
        ORDER BY table_name`,
      [[...PERFORMANCE_TABLES]],
    );

    expect(found).toHaveLength(PERFORMANCE_TABLES.length);
    for (const row of found) {
      expect(row.is_nullable, `${row.table_name}.org_id must be NOT NULL`).toBe("NO");
    }
  });

  it("gives every performance table UNIQUE (org_id, id) for composite foreign keys", async () => {
    const found = await ownerRows<{ relname: string; conname: string; attnames: string[] }>(
      `SELECT c.relname, u.conname, array_agg(a.attname ORDER BY k.ord) AS attnames
         FROM pg_constraint u
         JOIN pg_class c ON c.oid = u.conrelid
         JOIN LATERAL unnest(u.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = u.conrelid AND a.attnum = k.attnum
        WHERE u.contype = 'u' AND c.relname = ANY($1)
        GROUP BY c.relname, u.conname, u.conkey
        ORDER BY c.relname, u.conname`,
      [[...PERFORMANCE_TABLES]],
    );

    const keyed = found.filter((r) => r.attnames.length === 2 && r.attnames[0] === "org_id" && r.attnames[1] === "id");

    expect(
      keyed.map((r) => r.relname),
      "every performance table must expose UNIQUE (org_id, id) for composite FKs",
    ).toEqual([...PERFORMANCE_TABLES].sort());
  });

  it("leads every multi-column index on a performance table with org_id", async () => {
    const found = await ownerRows<{ table_name: string; index_name: string; cols: string[] }>(
      `SELECT t.relname AS table_name, i.relname AS index_name,
              array_agg(a.attname ORDER BY k.ord) AS cols
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
        WHERE t.relname = ANY($1)
          AND k.attnum > 0
          AND array_length(x.indkey, 1) > 1
        GROUP BY t.relname, i.relname, x.indkey
        ORDER BY t.relname, i.relname`,
      [[...PERFORMANCE_TABLES]],
    );

    expect(found.length).toBeGreaterThan(0);
    for (const row of found) {
      expect(row.cols[0], `${row.table_name}.${row.index_name} must lead with org_id`).toBe("org_id");
    }
  });

  it("has no single-column foreign key from a performance table to a tenant table", async () => {
    // A table is tenant-owned if it has a NOT NULL org_id AND UNIQUE (org_id, id).
    // `organization` and `person` are excluded by that definition on purpose: the
    // first is the tenant root, the second is deliberately org-independent.
    const tenantTables = new Set(
      (
        await ownerRows<{ relname: string }>(
          `SELECT c.relname
             FROM pg_class c
            WHERE c.relkind = 'r'
              AND EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND a.attnotnull)
              AND EXISTS (SELECT 1 FROM pg_constraint u
                           WHERE u.conrelid = c.oid AND u.contype = 'u' AND array_length(u.conkey, 1) = 2
                             AND u.conkey = ARRAY[
                                   (SELECT attnum FROM pg_attribute WHERE attrelid = c.oid AND attname = 'org_id'),
                                   (SELECT attnum FROM pg_attribute WHERE attrelid = c.oid AND attname = 'id')
                                 ]::smallint[])`,
        )
      ).map((r) => r.relname),
    );

    const found = await ownerRows<{ child_table: string; parent_table: string; conname: string; cols: string[] }>(
      `SELECT child.relname AS child_table, parent.relname AS parent_table, con.conname,
              array_agg(a.attname ORDER BY k.ord) AS cols
         FROM pg_constraint con
         JOIN pg_class child  ON child.oid  = con.conrelid
         JOIN pg_class parent ON parent.oid = con.confrelid
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        WHERE con.contype = 'f' AND child.relname = ANY($1)
        GROUP BY child.relname, parent.relname, con.conname
        ORDER BY child.relname, con.conname`,
      [[...PERFORMANCE_TABLES]],
    );

    expect(found.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const fk of found) {
      if (!tenantTables.has(fk.parent_table)) continue;
      if (fk.cols.length < 2 || fk.cols[0] !== "org_id") {
        offenders.push(`${fk.child_table}.${fk.conname} -> ${fk.parent_table}(${fk.cols.join(", ")})`);
      }
    }

    expect(
      offenders,
      `every FK from a performance table to a tenant table must be composite and lead with org_id:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("uses timestamptz for every instant on the performance tables", async () => {
    // ADR-0003's lesson, restated for the new tables: `attendances.session_time` was
    // `text` in the legacy schema and strings do not order, so a cutoff window could
    // not be evaluated against them at all.
    const found = await ownerRows<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_name = ANY($1)
          AND (column_name ~ '(_at|_on|_from|_to)$' OR column_name LIKE '%date%')
        ORDER BY table_name, column_name`,
      [[...PERFORMANCE_TABLES]],
    );

    expect(found.length).toBeGreaterThan(0);
    for (const row of found) {
      expect(row.data_type, `${row.table_name}.${row.column_name} must be timestamptz`).toBe("timestamp with time zone");
    }
  });

  it("rejects a performance line naming another org's match, by the composite FK itself", async () => {
    const windows = await calendarWindows();
    await seedSquadWin(ORG_B, "cccccccc", [P_B], windows.eventAt);

    // The referenced match genuinely exists — asserted so this cannot pass because
    // the row was never written.
    const present = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM match WHERE org_id = $1",
      [ORG_B],
    );
    expect(present[0]!.n).toBe(1);

    // Run as the owner, so RLS is not what does the refusing: the guarantee being
    // asserted is that the DATABASE cannot express a cross-tenant reference
    // (ADR-0011), independent of any policy.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (org_id, match_id, person_id, source, confidence,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('${ORG_A}', 'cccccccc-0000-0000-0000-000000000004', '${SQUAD_A[0]}',
                  'manual', 1, 24, 20, 5, 7, 4800, 3600, 40, 11, 3725,
                  ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
                  ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})
        `),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "performance line naming another org's match",
    );

    // Nothing was written: a refused reference leaves no partial history behind.
    const stored = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM match_player_performance WHERE org_id = $1",
      [ORG_A],
    );
    expect(stored[0]!.n).toBe(0);
  });

  it("rejects an extraction naming another org's match", async () => {
    const windows = await calendarWindows();
    await seedSquadWin(ORG_B, "cccccccc", [P_B], windows.eventAt);

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO performance_extraction
            (org_id, match_id, source, extractor, payload_text, confidence, extracted_at)
          VALUES ('${ORG_A}', 'cccccccc-0000-0000-0000-000000000004',
                  'ocr', 'stat-ocr 4.2', 'kills=20', 0.6210, '${windows.eventAt}')
        `),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "extraction naming another org's match",
    );
  });

  it("shows a member only their own organisation's performance lines", async () => {
    const windows = await calendarWindows();
    await seedSquadWin(ORG_A, "cccccccc", SQUAD_A, windows.eventAt);
    await seedSquadWin(ORG_B, "dddddddd", [P_B], windows.eventAt);

    const asA = await appRows<{ org_id: string }>("SELECT org_id FROM match_player_performance");
    expect(asA).toHaveLength(4);
    expect(asA.every((r) => r.org_id === ORG_A)).toBe(true);

    await asApp(async () => {
      const found = await db.query<{ org_id: string }>("SELECT org_id FROM match_player_performance");
      expect(found.rows).toHaveLength(1);
      expect(found.rows[0]!.org_id).toBe(ORG_B);
    }, ORG_B);
  });

  it("fails CLOSED with app.org_id unset, on every performance table", async () => {
    const windows = await calendarWindows();
    await seedSquadWin(ORG_A, "cccccccc", SQUAD_A, windows.eventAt);

    // Fail CLOSED. There is deliberately no IS NULL branch in either policy, so an
    // unset context cannot expose anything. This is the regression test for the
    // pattern ADR-0015 exists to prevent, and it is asserted per table.
    await asApp(async () => {
      for (const table of PERFORMANCE_TABLES) {
        const found = await db.query(`SELECT * FROM ${table}`);
        expect(found.rows, `${table} must expose nothing without a tenant context`).toHaveLength(0);
      }
    });

    // And an INSERT with no context must be refused too, not merely invisible.
    await asApp(async () => {
      await expectSqlstate(
        () =>
          db.query(
            `INSERT INTO match_player_performance
               (org_id, match_id, person_id, source, confidence, rounds_played,
                kills, deaths, assists, damage_dealt, damage_taken,
                headshot_attempts, headshots, survival_time_seconds,
                kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
                kd_ratio, headshot_rate_pct)
             VALUES ($1, 'cccccccc-0000-0000-0000-000000000004', $2,
                     'manual', 1, 24, 20, 5, 7, 4800, 3600, 40, 11, 3725,
                     ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
                     ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})`,
            [ORG_A, SQUAD_A[0]],
          ),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "insert with no tenant context",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Requirement 1 — a metric derives from a MATCH
// ---------------------------------------------------------------------------

describe("a metric derives from a match, never from a free-floating row", () => {
  it("counts a four-player squad win as ONE match and ONE win", async () => {
    // The legacy defect in one assertion. `/api/public/stats/route.ts:26-28` counted
    // rows for matches and rows with placement = 1 for wins, so four players on one
    // winning roster reported four wins. Every count below comes from the same
    // four-player fixture, and the four counts are the whole argument.
    const windows = await calendarWindows();
    const seeded = await seedSquadWin(ORG_A, "cccccccc", SQUAD_A, windows.eventAt);

    // The shape of the data first: FOUR performance lines exist for this match.
    const lines = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM match_player_performance WHERE org_id = $1 AND match_id = $2",
      [ORG_A, seeded.matchId],
    );
    expect(lines[0]!.n, "the fixture must produce four lines or the counts below prove nothing").toBe(4);

    // One match. One result row — match_result is UNIQUE (org_id, match_id, team_id).
    const matches = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM match WHERE org_id = $1 AND id = $2",
      [ORG_A, seeded.matchId],
    );
    expect(matches[0]!.n).toBe(1);

    const results = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM match_result WHERE org_id = $1 AND match_id = $2",
      [ORG_A, seeded.matchId],
    );
    expect(results[0]!.n).toBe(1);

    // Team-level win count over the window: ONE. This is the number the legacy
    // system reported as four.
    const teamRecord = await ownerRows<{ matches: number; wins: number }>(
      `SELECT count(DISTINCT m.id)::int AS matches,
              count(DISTINCT m.id) FILTER (WHERE r.outcome = 'win')::int AS wins
         FROM match_result r
         JOIN match m ON m.org_id = r.org_id AND m.id = r.match_id
        WHERE r.org_id = $1
          AND m.scheduled_at >= $2::timestamptz
          AND m.scheduled_at <  $3::timestamptz`,
      [ORG_A, windows.prevMonthStart, windows.monthStart],
    );
    expect(teamRecord[0]!.matches).toBe(1);
    expect(teamRecord[0]!.wins).toBe(1);

    // And the same is true per player: each of the four reports one match played
    // and one win, not four.
    const board = await appRows<{ person_id: string; matches_played: number; wins: number }>(
      `SELECT person_id, matches_played, wins
         FROM public.player_performance_leaderboard($1::timestamptz, $2::timestamptz, $3::integer)`,
      [windows.prevMonthStart, windows.monthStart, null],
    );

    expect(board).toHaveLength(4);
    for (const row of board) {
      expect(row.matches_played, `${row.person_id} played one match, not four`).toBe(1);
      expect(row.wins, `${row.person_id} won one match, not four`).toBe(1);
    }
    // The squad total is four player-lines and one match. Stating both together is
    // what stops the fixture being read as "four matches happened".
    const totals = await ownerRows<{ lines: number; matches: number }>(
      `SELECT (SELECT count(*)::int FROM match_player_performance WHERE org_id = $1) AS lines,
              (SELECT count(*)::int FROM match            WHERE org_id = $1) AS matches`,
      [ORG_A],
    );
    expect(totals[0]!.lines).toBe(4);
    expect(totals[0]!.matches).toBe(1);
  });

  it("refuses a second CURRENT performance line for the same player and match", async () => {
    // Without this, a re-import could leave two lines for one player in one match
    // and every per-player count would silently double — the same class of defect as
    // the duplicate attendance row that inflated the legacy attendance numbers.
    const windows = await calendarWindows();
    await seedSquadWin(ORG_A, "cccccccc", SQUAD_A, windows.eventAt);

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (id, org_id, match_id, person_id, source, confidence,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('77777777-0000-0000-0000-000000000001', '${ORG_A}',
                  'cccccccc-0000-0000-0000-000000000004', '${SQUAD_A[0]}',
                  'manual', 1, 24, 20, 5, 7, 4800, 3600, 40, 11, 3725,
                  ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
                  ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})
        `),
      SQLSTATE_UNIQUE_VIOLATION,
      "second current line for one player and match",
    );

    // A different player in the same match is unaffected — the guard is keyed on the
    // player, and a squad of one would otherwise be all the schema could express.
    await asOwner(`
      INSERT INTO team (id, org_id, name, slug, game_id, valid_from)
      VALUES ('77777777-0000-0000-0000-000000000010', '${ORG_A}', 'Second Squad', 'second-squad',
              'cccccccc-0000-0000-0000-000000000001', '${windows.eventAt}');
      INSERT INTO match (id, org_id, team_id, opponent_id, status, scheduled_at)
      VALUES ('77777777-0000-0000-0000-000000000011', '${ORG_A}',
              '77777777-0000-0000-0000-000000000010', 'cccccccc-0000-0000-0000-000000000003',
              'completed', '${windows.eventAt}');
      INSERT INTO match_player_performance
        (id, org_id, match_id, person_id, source, confidence,
         rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
         headshot_attempts, headshots, survival_time_seconds,
         kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
         kd_ratio, headshot_rate_pct)
      VALUES ('77777777-0000-0000-0000-000000000012', '${ORG_A}',
              '77777777-0000-0000-0000-000000000011', '${SQUAD_A[0]}',
              'manual', 1, 24, 20, 5, 7, 4800, 3600, 40, 11, 3725,
              ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
              ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct});
    `);
  });

  it("refuses a correction that claims to supersede another player's line", async () => {
    // Archiving and superseding is how a mistake is corrected without destroying the
    // evidence that it happened. But a supersession chain that jumps to another
    // person is a claim with no reading: "this corrects that" would be false, and
    // the audit trail that exists to answer disputes would itself lie.
    const windows = await calendarWindows();
    await seedSquadWin(ORG_A, "cccccccc", SQUAD_A, windows.eventAt);

    // Two lines archived first, so the partial unique index cannot be what refuses
    // the bad insert. Every refusal in this test has to be attributable to the
    // supersede guard or it proves nothing about the guard.
    await asOwner(`
      UPDATE match_player_performance SET archived_at = now()
       WHERE org_id = '${ORG_A}'
         AND id IN ('cccccccc-0000-0000-0000-000000000010', 'cccccccc-0000-0000-0000-000000000012')
    `);

    // A successor for the SAME match and the SAME person is what a correction looks
    // like, and it must be accepted — a guard that refuses everything would leave
    // corrected data unwritable, which is how people start disabling constraints.
    await asOwner(`
      INSERT INTO match_player_performance
        (id, org_id, match_id, person_id, source, confidence, supersedes_id,
         rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
         headshot_attempts, headshots, survival_time_seconds,
         kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
         kd_ratio, headshot_rate_pct)
      VALUES ('66666666-0000-0000-0000-000000000001', '${ORG_A}',
              'cccccccc-0000-0000-0000-000000000004', '${SQUAD_A[0]}',
              'manual', 1, 'cccccccc-0000-0000-0000-000000000010',
              24, 22, 5, 8, 5000, 3600, 40, 12, 3725,
              '0.9167', '0.2083', '0.3333', '208.3333', '4.4000', '30.0000')
    `);

    const chain = await ownerRows<{ id: string; supersedes_id: string; archived: boolean }>(
      `SELECT id, supersedes_id, archived_at IS NOT NULL AS archived
         FROM match_player_performance
        WHERE org_id = $1 AND match_id = 'cccccccc-0000-0000-0000-000000000004'
          AND person_id = $2
        ORDER BY id`,
      [ORG_A, SQUAD_A[0]],
    );
    expect(chain.map((r) => r.id)).toEqual([
      "66666666-0000-0000-0000-000000000001",
      "cccccccc-0000-0000-0000-000000000010",
    ]);
    // The chain is a chain: the successor names the predecessor, and the predecessor
    // is the archived one. Asserting it on the predecessor rather than on whichever
    // row happens to name it is the difference between testing the chain and testing
    // a column's value.
    const predecessor = chain.find((r) => r.id === "cccccccc-0000-0000-0000-000000000010");
    const successor = chain.find((r) => r.id === "66666666-0000-0000-0000-000000000001");
    expect(successor!.supersedes_id).toBe("cccccccc-0000-0000-0000-000000000010");
    expect(predecessor!.archived, "the corrected line must be archived, never overwritten").toBe(true);
    expect(successor!.archived).toBe(false);

    // A successor naming a DIFFERENT player has no reading.
    await asOwner(`
      UPDATE match_player_performance SET archived_at = now()
       WHERE org_id = '${ORG_A}' AND id = '66666666-0000-0000-0000-000000000001'
    `);

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (id, org_id, match_id, person_id, source, confidence, supersedes_id,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('66666666-0000-0000-0000-000000000002', '${ORG_A}',
                  'cccccccc-0000-0000-0000-000000000004', '${SQUAD_A[2]}',
                  'manual', 1, 'cccccccc-0000-0000-0000-000000000010',
                  24, 22, 5, 8, 5000, 3600, 40, 12, 3725,
                  '0.9167', '0.2083', '0.3333', '208.3333', '4.4000', '30.0000')
        `),
      SQLSTATE_EXCLUSION_VIOLATION,
      "a correction superseding another player's line",
    );

    // And nothing was written: a refused correction leaves the history as it found
    // it rather than half-applying one. The cast is needed because `id` is a uuid
    // and there is no `~~` operator for one.
    const survivors = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM match_player_performance WHERE org_id = $1 AND id::text LIKE '66666666%'",
      [ORG_A],
    );
    expect(survivors[0]!.n).toBe(1);
  });

  it("takes the team from the match, so a line cannot be filed against another team", async () => {
    // There is no team_id on the performance line at all. The team is a property of
    // the match, so "which squad is this line for" has exactly one answer and a
    // disagreeing one is not storable rather than merely discouraged.
    const columns = await ownerRows<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'match_player_performance' AND column_name IN ('team_id', 'match_id')`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(["match_id"]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 2 — every computed value is reproducible from stored raw inputs
// ---------------------------------------------------------------------------

describe("every computed value is reproducible from stored raw inputs", () => {
  it("stores the raw inputs and the derived value side by side", async () => {
    const windows = await calendarWindows();
    await seedLoneMatch(ORG_A, windows.eventAt);
    const lineId = await seedSingleLine(ORG_A, SQUAD_A[0]);

    // The whole point of requirement 2: an organisation disputing a figure can read
    // the inputs it was derived from out of the same row, without asking anybody.
    const line = await ownerRows<{
      rounds_played: number;
      kills: number;
      deaths: number;
      assists: number;
      damage_dealt: number;
      damage_taken: number;
      headshot_attempts: number;
      headshots: number;
      survival_time_seconds: number;
      kills_per_round: string;
      deaths_per_round: string;
      assists_per_round: string;
      damage_per_round: string;
      kd_ratio: string;
      headshot_rate_pct: string;
    }>(
      `SELECT rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
              headshot_attempts, headshots, survival_time_seconds,
              kills_per_round::text, deaths_per_round::text, assists_per_round::text,
              damage_per_round::text, kd_ratio::text, headshot_rate_pct::text
         FROM match_player_performance
        WHERE org_id = $1 AND id = $2`,
      [ORG_A, lineId],
    );

    expect(line[0]).toEqual({
      rounds_played: RAW_INPUTS.rounds_played,
      kills: RAW_INPUTS.kills,
      deaths: RAW_INPUTS.deaths,
      assists: RAW_INPUTS.assists,
      damage_dealt: RAW_INPUTS.damage_dealt,
      damage_taken: RAW_INPUTS.damage_taken,
      headshot_attempts: RAW_INPUTS.headshot_attempts,
      headshots: RAW_INPUTS.headshots,
      survival_time_seconds: RAW_INPUTS.survival_time_seconds,
      kills_per_round: DERIVED.kills_per_round,
      deaths_per_round: DERIVED.deaths_per_round,
      assists_per_round: DERIVED.assists_per_round,
      damage_per_round: DERIVED.damage_per_round,
      kd_ratio: DERIVED.kd_ratio,
      headshot_rate_pct: DERIVED.headshot_rate_pct,
    });
  });

  it("refuses a stored derived value the raw inputs do not reproduce", async () => {
    // The stored figure is the CLAIM; the raw inputs are the evidence. When they
    // disagree the row is refused, which is what makes the stored figure auditable
    // rather than decorative. This is the check the legacy system never had — it
    // rendered `totalMatches * 0.7` as "Win rate" and nothing could contradict it.
    const windows = await calendarWindows();
    await seedLoneMatch(ORG_A, windows.eventAt);

    // kills_per_round is 0.8333 for 20 kills in 24 rounds. A different figure is a
    // different claim and is refused. Each case names the one column it corrupts so
    // a failure names the derivation that is wrong rather than "a check failed".
    const corruptions: ReadonlyArray<{ column: string; value: string; why: string }> = [
      { column: "kills_per_round", value: "1.0000", why: "kills_per_round against 20/24" },
      { column: "deaths_per_round", value: "0.5000", why: "deaths_per_round against 5/24" },
      { column: "assists_per_round", value: "0.1000", why: "assists_per_round against 7/24" },
      { column: "damage_per_round", value: "250.0000", why: "damage_per_round against 4800/24" },
      { column: "kd_ratio", value: "9.0000", why: "kd_ratio against 20/5" },
      { column: "headshot_rate_pct", value: "90.0000", why: "headshot_rate_pct against 11/40" },
    ];

    for (const [index, bad] of corruptions.entries()) {
      const valueFor = (column: string): string =>
        column === bad.column ? bad.value : (DERIVED[column as keyof typeof DERIVED] ?? "");
      const lineId = `55555555-0000-0000-0000-0000000000${String(index + 10).padStart(2, "0")}`;

      await expectSqlstate(
        () =>
          asOwner(`
            INSERT INTO match_player_performance
              (id, org_id, match_id, person_id, source, confidence,
               rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
               headshot_attempts, headshots, survival_time_seconds,
               kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
               kd_ratio, headshot_rate_pct)
            VALUES ('${lineId}', '${ORG_A}',
                    '99999999-0000-0000-0000-000000000004', '${SQUAD_A[0]}',
                    'manual', 1, 24, 20, 5, 7, 4800, 3600, 40, 11, 3725,
                    ${valueFor("kills_per_round")}, ${valueFor("deaths_per_round")},
                    ${valueFor("assists_per_round")}, ${valueFor("damage_per_round")},
                    ${valueFor("kd_ratio")}, ${valueFor("headshot_rate_pct")})
          `),
        SQLSTATE_CHECK_VIOLATION,
        bad.why,
      );
    }

    // The same raw inputs with the CORRECT figures are accepted, so the loop above
    // is refusing the disagreement and not the shape of the row.
    const lineId = await seedSingleLine(ORG_A, SQUAD_A[0]);
    const accepted = await ownerRows<{ kd_ratio: string }>(
      "SELECT kd_ratio::text AS kd_ratio FROM match_player_performance WHERE org_id = $1 AND id = $2",
      [ORG_A, lineId],
    );
    expect(accepted[0]!.kd_ratio).toBe(DERIVED.kd_ratio);
  });

  it("lets a party recompute the stored figure from the raw inputs in SQL", async () => {
    // The audit a disputed payout actually needs. This is the check above seen from
    // the other side: the stored value is not merely CONSTRAINED to agree, it is
    // reproducible by anyone with SELECT.
    const windows = await calendarWindows();
    await seedLoneMatch(ORG_A, windows.eventAt);
    const lineId = await seedSingleLine(ORG_A, SQUAD_A[0]);

    const recomputed = await ownerRows<{
      kills_per_round: string;
      damage_per_round: string;
      kd_ratio: string;
      headshot_rate_pct: string;
      agrees: boolean;
    }>(
      `SELECT round(kills::numeric / NULLIF(rounds_played, 0), 4)::text AS kills_per_round,
              round(damage_dealt::numeric / NULLIF(rounds_played, 0), 4)::text AS damage_per_round,
              round(kills::numeric / NULLIF(deaths, 0), 4)::text AS kd_ratio,
              round(headshots::numeric * 100 / NULLIF(headshot_attempts, 0), 4)::text AS headshot_rate_pct,
              (kills_per_round   IS NOT DISTINCT FROM round(kills::numeric / NULLIF(rounds_played, 0), 4)
           AND deaths_per_round IS NOT DISTINCT FROM round(deaths::numeric / NULLIF(rounds_played, 0), 4)
           AND assists_per_round IS NOT DISTINCT FROM round(assists::numeric / NULLIF(rounds_played, 0), 4)
           AND damage_per_round IS NOT DISTINCT FROM round(damage_dealt::numeric / NULLIF(rounds_played, 0), 4)
           AND kd_ratio         IS NOT DISTINCT FROM round(kills::numeric / NULLIF(deaths, 0), 4)
           AND headshot_rate_pct IS NOT DISTINCT FROM round(headshots::numeric * 100 / NULLIF(headshot_attempts, 0), 4)
              ) AS agrees
         FROM match_player_performance
        WHERE org_id = $1 AND id = $2`,
      [ORG_A, lineId],
    );

    expect(recomputed[0]!.agrees).toBe(true);
    expect(recomputed[0]!.kills_per_round).toBe(DERIVED.kills_per_round);
    expect(recomputed[0]!.damage_per_round).toBe(DERIVED.damage_per_round);
    expect(recomputed[0]!.kd_ratio).toBe(DERIVED.kd_ratio);
    expect(recomputed[0]!.headshot_rate_pct).toBe(DERIVED.headshot_rate_pct);
  });

  it("records which derivation produced the stored value", async () => {
    const windows = await calendarWindows();
    await seedLoneMatch(ORG_A, windows.eventAt);
    const lineId = await seedSingleLine(ORG_A, SQUAD_A[0]);

    // "Stored with its derivation" is only true if the derivation is identified.
    // A stored figure whose formula version is unknown is a number nobody can
    // reproduce a year from now, which is the auditability this schema is for.
    const found = await ownerRows<{ derivation_version: number }>(
      "SELECT derivation_version FROM match_player_performance WHERE org_id = $1 AND id = $2",
      [ORG_A, lineId],
    );
    expect(found[0]!.derivation_version).toBe(1);

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (id, org_id, match_id, person_id, source, confidence, derivation_version,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('44444444-0000-0000-0000-000000000001', '${ORG_A}',
                  '99999999-0000-0000-0000-000000000004', '${SQUAD_A[1]}',
                  'manual', 1, 0, 24, 20, 5, 7, 4800, 3600, 40, 11, 3725,
                  ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
                  ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})
        `),
      SQLSTATE_CHECK_VIOLATION,
      "derivation version zero",
    );
  });

  it("reports a metric it cannot compute as absent rather than fabricated", async () => {
    // Three cases, all of which the legacy system answered with an invented number:
    // a K/D with no deaths, a per-round figure with no rounds played, and a headshot
    // rate with no attempts. NULL is the honest answer. A zero would be a lie and a
    // guess would be worse.
    const windows = await calendarWindows();
    await seedLoneMatch(ORG_A, windows.eventAt);

    // A flawless round: 20 kills, no deaths. K/D is undefined, not infinite.
    await asOwner(`
      INSERT INTO match_player_performance
        (id, org_id, match_id, person_id, source, confidence,
         rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
         headshot_attempts, headshots, survival_time_seconds,
         kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
         kd_ratio, headshot_rate_pct)
      VALUES ('33333333-0000-0000-0000-000000000001', '${ORG_A}',
              '99999999-0000-0000-0000-000000000004', '${SQUAD_A[0]}',
              'manual', 1, 24, 20, 0, 7, 4800, 3600, 40, 11, 3725,
              ${DERIVED.kills_per_round}, ${"0.0000"}, ${DERIVED.assists_per_round},
              ${DERIVED.damage_per_round}, NULL, ${DERIVED.headshot_rate_pct})
    `);

    // Asserted as SQL NULL rather than 0 or a sentinel, because "absent" and "zero"
    // are different claims and only one of them is true here.
    const undefinable = await ownerRows<{ kd_ratio: string | null; is_null: boolean }>(
      `SELECT kd_ratio::text AS kd_ratio, kd_ratio IS NULL AS is_null
         FROM match_player_performance WHERE org_id = $1 AND id = '33333333-0000-0000-0000-000000000001'`,
      [ORG_A],
    );
    expect(undefinable[0]!.is_null).toBe(true);
    expect(undefinable[0]!.kd_ratio).toBeNull();

    // No rounds played: every per-round figure is undefined.
    await asOwner(`
      INSERT INTO match_player_performance
        (id, org_id, match_id, person_id, source, confidence,
         rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
         headshot_attempts, headshots, survival_time_seconds,
         kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
         kd_ratio, headshot_rate_pct)
      VALUES ('33333333-0000-0000-0000-000000000002', '${ORG_A}',
              '99999999-0000-0000-0000-000000000004', '${SQUAD_A[1]}',
              'manual', 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              NULL, NULL, NULL, NULL, NULL, NULL)
    `);

    const noRounds = await ownerRows<{
      kills_per_round: string | null;
      deaths_per_round: string | null;
      assists_per_round: string | null;
      damage_per_round: string | null;
      headshot_rate_pct: string | null;
    }>(
      `SELECT kills_per_round::text, deaths_per_round::text, assists_per_round::text,
              damage_per_round::text, headshot_rate_pct::text
         FROM match_player_performance WHERE org_id = $1 AND id = '33333333-0000-0000-0000-000000000002'`,
      [ORG_A],
    );
    expect(noRounds[0]).toEqual({
      kills_per_round: null,
      deaths_per_round: null,
      assists_per_round: null,
      damage_per_round: null,
      headshot_rate_pct: null,
    });

    // A fabricated figure in place of an undefined one is refused. This is the
    // single most important assertion in the file: it is the mechanical form of
    // "there is no 'win rate = matches x 0.7'".
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (id, org_id, match_id, person_id, source, confidence,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('33333333-0000-0000-0000-000000000003', '${ORG_A}',
                  '99999999-0000-0000-0000-000000000004', '${SQUAD_A[2]}',
                  'manual', 1, 0, 3, 1, 0, 0, 0, 0, 0, 60,
                  NULL, NULL, NULL, NULL, ${DERIVED.kd_ratio}, NULL)
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a K/D asserted for a player with no deaths",
    );

    // And the schema does not pretend to metrics it cannot produce. ADR-0019 records
    // no KAST, no ACS, no impact rating, no round-level survival bit and no monthly
    // rollup anywhere in the legacy source, so there is nothing here to derive them
    // from and no column claims to hold them.
    const columns = await ownerRows<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'match_player_performance'
          AND column_name ~ '(kast|acs|impact|rating|rollup)'`,
    );
    expect(columns).toEqual([]);
  });

  it("refuses raw inputs that contradict each other", async () => {
    const windows = await calendarWindows();
    await seedLoneMatch(ORG_A, windows.eventAt);

    // More headshots than headshot attempts is a row about a match that cannot have
    // happened. A CHECK that only bounded the sign would store it.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (id, org_id, match_id, person_id, source, confidence,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('22222222-0000-0000-0000-000000000001', '${ORG_A}',
                  '99999999-0000-0000-0000-000000000004', '${SQUAD_A[0]}',
                  'manual', 1, 24, 20, 5, 7, 4800, 3600, 10, 40, 3725,
                  ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
                  ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio},
                  round(40::numeric * 100 / 10, 4))
        `),
      SQLSTATE_CHECK_VIOLATION,
      "more headshots than headshot attempts",
    );

    // A negative count is not a measurement at all.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (id, org_id, match_id, person_id, source, confidence,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('22222222-0000-0000-0000-000000000002', '${ORG_A}',
                  '99999999-0000-0000-0000-000000000004', '${SQUAD_A[1]}',
                  'manual', 1, 24, -1, 5, 7, 4800, 3600, 40, 11, 3725,
                  ${"0.8333"}, ${"0.2083"}, ${DERIVED.assists_per_round},
                  ${DERIVED.damage_per_round}, ${"0.2000"}, ${DERIVED.headshot_rate_pct})
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a negative kill count",
    );
  });
});

// ---------------------------------------------------------------------------
// Requirement 3 — provenance is mandatory
// ---------------------------------------------------------------------------

describe("provenance is mandatory on every performance line", () => {
  it("requires a machine-derived line to name the extraction it came from", async () => {
    const windows = await calendarWindows();
    await seedLoneMatch(ORG_A, windows.eventAt);

    // The legacy OCR path hardcoded confidence to 85 and stored nothing else, so a
    // screenshot read and a human's memory of the same match were the same row.
    // Here a machine-sourced line must name the extraction that holds the machine's
    // own output and its own stated confidence.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (id, org_id, match_id, person_id, source, confidence,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('11111111-0000-0000-0000-000000000001', '${ORG_A}',
                  '99999999-0000-0000-0000-000000000004', '${SQUAD_A[0]}',
                  'ocr', 0.6210, 24, 20, 5, 7, 4800, 3600, 40, 11, 3725,
                  ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
                  ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})
        `),
      SQLSTATE_CHECK_VIOLATION,
      "machine-sourced line naming no extraction",
    );

    // And the converse: a hand-entered line naming a machine read is claiming a human
    // wrote down what an algorithm produced, which is precisely how a corrected OCR
    // row becomes indistinguishable from a typed one.
    await asOwner(`
      INSERT INTO performance_extraction
        (id, org_id, match_id, source, extractor, payload_text, confidence, extracted_at)
      VALUES ('11111111-0000-0000-0000-000000000010', '${ORG_A}',
              '99999999-0000-0000-0000-000000000004', 'ocr', 'stat-ocr 4.2',
              'kills=20 deaths=5 assists=7', 0.6210, '${windows.eventAt}');
    `);

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (id, org_id, match_id, person_id, extraction_id, source, confidence,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('11111111-0000-0000-0000-000000000002', '${ORG_A}',
                  '99999999-0000-0000-0000-000000000004', '${SQUAD_A[1]}',
                  '11111111-0000-0000-0000-000000000010', 'manual', 1,
                  24, 20, 5, 7, 4800, 3600, 40, 11, 3725,
                  ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
                  ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})
        `),
      SQLSTATE_CHECK_VIOLATION,
      "hand-entered line naming a machine extraction",
    );
  });

  it("records the machine's own confidence, never a constant", async () => {
    const windows = await calendarWindows();
    await seedSquadWin(ORG_A, "cccccccc", SQUAD_A, windows.eventAt);

    // 0.6210 was supplied at write time and is read back verbatim. There is no
    // DEFAULT on confidence: a row cannot be written without somebody stating how
    // sure the source was, which is the opposite of the hardcoded 85.
    const found = await ownerRows<{ confidence: string; extractor: string; payload_text: string }>(
      `SELECT s.confidence::text AS confidence, e.extractor, e.payload_text
         FROM match_player_performance s
         JOIN performance_extraction e
           ON e.org_id = s.org_id AND e.id = s.extraction_id
        WHERE s.org_id = $1
        ORDER BY s.person_id`,
      [ORG_A],
    );

    expect(found).toHaveLength(4);
    for (const row of found) {
      expect(row.confidence).toBe("0.6210");
      expect(row.extractor).toBe("stat-ocr 4.2");
      expect(row.payload_text).toBe("kills=20 deaths=5 assists=7");
    }

    // No default means the column cannot be omitted. A line with no stated
    // confidence is the row the legacy system wrote with `85` written into it.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (id, org_id, match_id, person_id, source,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('11111111-0000-0000-0000-000000000003', '${ORG_A}',
                  'cccccccc-0000-0000-0000-000000000004', '${SQUAD_A[0]}',
                  'manual', 24, 20, 5, 7, 4800, 3600, 40, 11, 3725,
                  ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
                  ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})
        `),
      SQLSTATE_NOT_NULL_VIOLATION,
      "performance line with no confidence",
    );

    // Nor a source: an unnamed provenance is the defect, not the missing value.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (id, org_id, match_id, person_id, confidence,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('11111111-0000-0000-0000-000000000004', '${ORG_A}',
                  'cccccccc-0000-0000-0000-000000000004', '${SQUAD_A[1]}', 1,
                  24, 20, 5, 7, 4800, 3600, 40, 11, 3725,
                  ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
                  ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})
        `),
      SQLSTATE_NOT_NULL_VIOLATION,
      "performance line with no source",
    );
  });

  it("requires full confidence for a hand-entered line and refuses it for a machine one", async () => {
    const windows = await calendarWindows();
    await seedLoneMatch(ORG_A, windows.eventAt);
    await asOwner(`
      INSERT INTO performance_extraction
        (id, org_id, match_id, source, extractor, payload_text, confidence, extracted_at)
      VALUES ('11111111-0000-0000-0000-000000000010', '${ORG_A}',
              '99999999-0000-0000-0000-000000000004', 'ocr', 'stat-ocr 4.2',
              'kills=20 deaths=5 assists=7', 0.6210, '${windows.eventAt}');
    `);

    // Either a person asserted it, or a machine guessed. The middle — a hand-typed
    // figure with machine confidence — is the schema's refusal.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (id, org_id, match_id, person_id, source, confidence,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('11111111-0000-0000-0000-000000000005', '${ORG_A}',
                  '99999999-0000-0000-0000-000000000004', '${SQUAD_A[0]}',
                  'manual', 0.5, 24, 20, 5, 7, 4800, 3600, 40, 11, 3725,
                  ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
                  ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})
        `),
      SQLSTATE_CHECK_VIOLATION,
      "hand-entered line claiming machine confidence",
    );

    // A confidence outside 0..1 is not a confidence.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (id, org_id, match_id, person_id, extraction_id, source, confidence,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('11111111-0000-0000-0000-000000000006', '${ORG_A}',
                  '99999999-0000-0000-0000-000000000004', '${SQUAD_A[1]}',
                  '11111111-0000-0000-0000-000000000010', 'ocr', 1.5,
                  24, 20, 5, 7, 4800, 3600, 40, 11, 3725,
                  ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
                  ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})
        `),
      SQLSTATE_CHECK_VIOLATION,
      "confidence above one",
    );
  });

  it("refuses a verification with no verifier, and one dated before the recording", async () => {
    const windows = await calendarWindows();
    await seedLoneMatch(ORG_A, windows.eventAt);

    // "Verified" without a verifier is a claim, not a verification. Same rule as
    // match_result, restated here because this table is where a per-player figure
    // is actually disputed.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (id, org_id, match_id, person_id, source, confidence,
             recorded_at, verified_at,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('11111111-0000-0000-0000-000000000007', '${ORG_A}',
                  '99999999-0000-0000-0000-000000000004', '${SQUAD_A[0]}',
                  'manual', 1, '${windows.eventAt}', '${windows.eventAt}',
                  24, 20, 5, 7, 4800, 3600, 40, 11, 3725,
                  ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
                  ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})
        `),
      SQLSTATE_CHECK_VIOLATION,
      "verified with no verifier",
    );

    await asOwner(`
      INSERT INTO match_player_performance
        (id, org_id, match_id, person_id, source, confidence,
         recorded_at, verified_at, verified_by_person_id,
         rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
         headshot_attempts, headshots, survival_time_seconds,
         kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
         kd_ratio, headshot_rate_pct)
      VALUES ('11111111-0000-0000-0000-000000000008', '${ORG_A}',
              '99999999-0000-0000-0000-000000000004', '${SQUAD_A[1]}',
              'manual', 1, '${windows.eventAt}', '${windows.monthStart}', '${SQUAD_A[0]}',
              24, 20, 5, 7, 4800, 3600, 40, 11, 3725,
              ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
              ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})
    `);
  });

  it("refuses an extraction that claims to be hand-written", async () => {
    const windows = await calendarWindows();
    await seedLoneMatch(ORG_A, windows.eventAt);

    // An "extraction" with source 'manual' is a person writing into a table whose
    // whole purpose is to be the machine's evidence. It would let a hand-typed row
    // acquire a machine-looking provenance, which is the defect in reverse.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO performance_extraction
            (id, org_id, match_id, source, extractor, payload_text, confidence, extracted_at)
          VALUES ('11111111-0000-0000-0000-000000000011', '${ORG_A}',
                  '99999999-0000-0000-0000-000000000004', 'manual',
                  'a coach', 'kills=20', 1, '${windows.eventAt}')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "extraction claiming manual provenance",
    );
  });
});

// ---------------------------------------------------------------------------
// Requirement 4 — units are named in the schema
// ---------------------------------------------------------------------------

describe("units are named in the schema", () => {
  it("has no duration column anywhere whose name omits its unit", async () => {
    // ADR-0019's item 3: the legacy `survival_time` was minutes on one surface and
    // seconds on another, and a stored 10 is indistinguishable from a stored 600
    // forever afterwards. The fix is the column NAME, because by the time anyone
    // reads the number the name is all they have.
    //
    // Scanned over EVERY table in the schema, not just the new ones, so a future
    // migration that adds `cooldown` or `ping_ms_maybe` fails here. The list of
    // accepted suffixes is explicit: a pattern-match on "looks like a time" would
    // pass for any suffix at all and prove nothing.
    //
    // The scan is what found `attendance_record.minutes_late` — a genuine instance
    // of ADR-0019's item 3, since every caller computes against a cutoff declared
    // in minutes — and 0007 renames it to `late_minutes`. `schema_migration.duration_ms`
    // passes on its own merits: the name states the unit.
    const offenders = await ownerRows<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('integer','bigint','smallint','numeric','real','double precision')
          AND column_name ~ '(duration|_time|minute|second|hour|day)'
          AND column_name !~ '(_seconds|_minutes|_hours|_days|_milliseconds|_ms|_of_day)$'
        ORDER BY table_name, column_name`,
    );

    expect(
      offenders.map((r) => `${r.table_name}.${r.column_name}`),
      "a duration column whose name does not say what unit it is in (ADR-0019)",
    ).toEqual([]);
  });

  it("stores survival time in SECONDS and says so in the name and the comment", async () => {
    const windows = await calendarWindows();
    await seedLoneMatch(ORG_A, windows.eventAt);
    const lineId = await seedSingleLine(ORG_A, SQUAD_A[0]);

    const found = await ownerRows<{ column_name: string; data_type: string; comment_text: string | null }>(
      `SELECT c.column_name,
              c.data_type,
              col_description(('public.' || c.table_name)::regclass, c.ordinal_position::int) AS comment_text
         FROM information_schema.columns c
        WHERE c.table_name = 'match_player_performance'
          AND c.column_name IN ('survival_time_seconds', 'survival_time')`,
    );

    // The ambiguous name is not merely avoided, it does not exist.
    expect(found.map((c) => c.column_name)).toEqual(["survival_time_seconds"]);
    expect(found[0]!.data_type).toBe("integer");
    // The name states the unit and the COMMENT restates it, so the answer survives
    // being read by somebody who has never seen this ADR.
    expect(found[0]!.comment_text).toMatch(/second/i);

    // 3725 seconds is 1 hour 2 minutes 5 seconds. Recomputed in SQL so the assertion
    // is about the database's reading of the column, not about a JavaScript Date —
    // PGlite returns timestamptz to Node in the HOST's timezone, which would make
    // this test assert the test runner's locale.
    //
    // The ::numeric cast is load-bearing: survival_time_seconds and 60 are both
    // integers, so without it PostgreSQL performs INTEGER division and answers 62
    // for a value that is 62 minutes and 5 seconds. That truncation is exactly the
    // class of silent wrongness a unit column exists to prevent, and it is worth
    // one cast to make the test catch it.
    const read = await ownerRows<{ seconds: number; as_minutes: string; legible: string }>(
      `SELECT survival_time_seconds AS seconds,
              (survival_time_seconds::numeric / 60)::numeric(14,4)::text AS as_minutes,
              to_char(make_interval(secs => survival_time_seconds), 'HH24:MI:SS') AS legible
         FROM match_player_performance WHERE org_id = $1 AND id = $2`,
      [ORG_A, lineId],
    );

    expect(read[0]!.seconds).toBe(3725);
    expect(read[0]!.as_minutes).toBe("62.0833");
    expect(read[0]!.legible).toBe("01:02:05");

    // A negative duration is not a measurement.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO match_player_performance
            (id, org_id, match_id, person_id, source, confidence,
             rounds_played, kills, deaths, assists, damage_dealt, damage_taken,
             headshot_attempts, headshots, survival_time_seconds,
             kills_per_round, deaths_per_round, assists_per_round, damage_per_round,
             kd_ratio, headshot_rate_pct)
          VALUES ('12121212-0000-0000-0000-000000000001', '${ORG_A}',
                  '99999999-0000-0000-0000-000000000004', '${SQUAD_A[2]}',
                  'manual', 1, 24, 20, 5, 7, 4800, 3600, 40, 11, -1,
                  ${DERIVED.kills_per_round}, ${DERIVED.deaths_per_round}, ${DERIVED.assists_per_round},
                  ${DERIVED.damage_per_round}, ${DERIVED.kd_ratio}, ${DERIVED.headshot_rate_pct})
        `),
      SQLSTATE_CHECK_VIOLATION,
      "negative survival time",
    );
  });
});

// ---------------------------------------------------------------------------
// Requirement 5 — windows filter on the EVENT date
// ---------------------------------------------------------------------------

describe("windows filter on the event date, not on created_at", () => {
  it("puts a backfilled match in the month it was played, not the month it was written", async () => {
    // ADR-0019's item 5, and the legacy defect verbatim: every window filtered on
    // insert timestamp, so a season's history imported today appeared as though it
    // all happened today. The fixture is the same either way — created_at defaults
    // to now(), scheduled_at is a fortnight into the previous month — and the two
    // queries below disagree, which is the only way to prove which one is right.
    const windows = await calendarWindows();
    await seedSquadWin(ORG_A, "cccccccc", SQUAD_A, windows.eventAt);

    // The premise, asserted before anything is concluded from it: this match was
    // PLAYED last month and WRITTEN today. Without both halves, the queries below
    // could pass for the wrong reason.
    const premise = await ownerRows<{
      played_last_month: boolean;
      written_today: boolean;
      scheduled_at: string;
      created_at: string;
    }>(
      `SELECT scheduled_at < $2::timestamptz AS played_last_month,
              created_at >= $3::timestamptz AS written_today,
              to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS scheduled_at,
              to_char(created_at  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
         FROM match WHERE org_id = $1`,
      [ORG_A, windows.monthStart, windows.dayStart],
    );

    expect(premise).toHaveLength(1);
    expect(premise[0]!.played_last_month).toBe(true);
    expect(premise[0]!.written_today).toBe(true);

    // A query for LAST MONTH includes the backfilled match.
    const lastMonth = await appRows<{ person_id: string }>(
      `SELECT person_id
         FROM public.player_performance_leaderboard($1::timestamptz, $2::timestamptz, $3::integer)`,
      [windows.prevMonthStart, windows.monthStart, null],
    );
    expect(lastMonth).toHaveLength(4);

    // A query for TODAY does not — and is not merely empty for want of rows.
    // `dayEnd` comes from the database, never from string concatenation onto
    // `dayStart`: PostgreSQL silently parses a doubled zone suffix into a wrong
    // but valid instant with no error, so a concatenated fixture here would look
    // correct and quietly test nothing.
    const today = await appRows<{ person_id: string }>(
      `SELECT person_id
         FROM public.player_performance_leaderboard($1::timestamptz, $2::timestamptz, $3::integer)`,
      [windows.dayStart, windows.dayEnd, null],
    );
    expect(today).toEqual([]);

    // The legacy rule, run against the same data, says the opposite on both counts.
    // Asserting it is what proves the difference is in the filter and not in the
    // fixture: a created_at window sees the match in today's bucket and nowhere
    // else, which is the bug.
    const byCreatedAt = await ownerRows<{ in_previous_month: number; in_today: number }>(
      `SELECT count(*) FILTER (WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz)::int AS in_previous_month,
              count(*) FILTER (WHERE created_at >= $4::timestamptz)::int                        AS in_today
         FROM match WHERE org_id = $1`,
      [ORG_A, windows.prevMonthStart, windows.monthStart, windows.dayStart],
    );
    expect(byCreatedAt[0]!.in_previous_month).toBe(0);
    expect(byCreatedAt[0]!.in_today).toBe(1);
  });

  it("keeps a match inside the window it was played and outside the neighbouring ones", async () => {
    // Half-open, like every other window in this schema: the start is inclusive and
    // the end exclusive, so the first instant of the next month belongs to the next
    // month and a match exactly on the boundary is counted once.
    const windows = await calendarWindows();
    await seedSquadWin(ORG_A, "cccccccc", SQUAD_A, windows.eventAt);

    const at = async (from: string, to: string): Promise<number> => {
      const found = await appRows<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.player_performance_leaderboard($1::timestamptz, $2::timestamptz, $3::integer)`,
        [from, to, null],
      );
      return found[0]!.n;
    };

    // A window that ends exactly when the match was played excludes it.
    expect(await at(windows.prevMonthStart, windows.eventAt)).toBe(0);
    // A window that starts exactly when the match was played includes it.
    expect(await at(windows.eventAt, windows.monthStart)).toBe(4);
    // The whole previous month includes it.
    expect(await at(windows.prevMonthStart, windows.monthStart)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Requirement 6 — truncation is always reported
// ---------------------------------------------------------------------------

interface LeaderboardRow {
  person_id: string;
  rank_position: number;
  matches_played: number;
  wins: number;
  losses: number;
  draws: number;
  rounds_played: number;
  kills: number;
  deaths: number;
  assists: number;
  damage_dealt: number;
  kd_ratio: string | null;
  damage_per_round: string | null;
  headshot_rate_pct: string | null;
  rows_matched: number;
  is_truncated: boolean;
}

const LEADERBOARD_SQL = `SELECT * FROM public.player_performance_leaderboard($1::timestamptz, $2::timestamptz, $3::integer)`;

describe("truncation is always reported", () => {
  it("says it was capped instead of presenting a capped set as a ranking", async () => {
    // `performances/route.ts:63-64` capped at 1000 when a limit was supplied and
    // told nobody. A leaderboard that looks authoritative while being incomplete is
    // worse than one that refuses to answer, so this one answers AND says so.
    const windows = await calendarWindows();
    await seedSquadWin(ORG_A, "cccccccc", SQUAD_A, windows.eventAt);

    const capped = await appRows<LeaderboardRow>(LEADERBOARD_SQL, [windows.prevMonthStart, windows.monthStart, 1]);

    expect(capped).toHaveLength(1);
    expect(capped[0]!.rows_matched, "the full size of the set must be visible").toBe(4);
    expect(capped[0]!.is_truncated).toBe(true);
    expect(capped[0]!.rank_position).toBe(1);
    expect(capped[0]!.person_id).toBe(SQUAD_A[0]);

    // The cap is reported on EVERY returned row, not only on the last one. A flag
    // attached to the final row is invisible to anyone reading page one.
    const cappedToThree = await appRows<LeaderboardRow>(LEADERBOARD_SQL, [
      windows.prevMonthStart,
      windows.monthStart,
      3,
    ]);
    expect(cappedToThree).toHaveLength(3);
    for (const row of cappedToThree) {
      expect(row.is_truncated).toBe(true);
      expect(row.rows_matched).toBe(4);
    }
    expect(cappedToThree[0]!.person_id).toBe(SQUAD_A[0]);
    expect(cappedToThree[1]!.person_id).toBe(SQUAD_A[1]);
    expect(cappedToThree[2]!.person_id).toBe(SQUAD_A[2]);
  });

  it("says nothing was capped when the limit exceeds the set", async () => {
    const windows = await calendarWindows();
    await seedSquadWin(ORG_A, "cccccccc", SQUAD_A, windows.eventAt);

    for (const limit of [4, 5, 1000]) {
      const found = await appRows<LeaderboardRow>(LEADERBOARD_SQL, [
        windows.prevMonthStart,
        windows.monthStart,
        limit,
      ]);
      expect(found, `limit ${limit} returns the whole set`).toHaveLength(4);
      for (const row of found) {
        expect(row.is_truncated, `limit ${limit} must not report truncation`).toBe(false);
        expect(row.rows_matched).toBe(4);
      }
    }

    // And no limit at all is uncapped, and says so rather than defaulting to a
    // silent 1000 the way the legacy route did.
    const uncapped = await appRows<LeaderboardRow>(LEADERBOARD_SQL, [
      windows.prevMonthStart,
      windows.monthStart,
      null,
    ]);
    expect(uncapped).toHaveLength(4);
    for (const row of uncapped) {
      expect(row.is_truncated).toBe(false);
      expect(row.rows_matched).toBe(4);
    }
  });

  it("refuses a cap that would silently return nothing", async () => {
    const windows = await calendarWindows();
    await seedSquadWin(ORG_A, "cccccccc", SQUAD_A, windows.eventAt);

    // `limit = 0` in the legacy route returned an empty ranking that rendered as
    // "no performers". A cap of zero is a caller mistake and is refused as one.
    await asApp(async () => {
      await expectSqlstate(
        () => db.query(LEADERBOARD_SQL, [windows.prevMonthStart, windows.monthStart, 0]),
        SQLSTATE_CHECK_VIOLATION,
        "a leaderboard cap of zero",
      );
    }, ORG_A);

    // So is a negative one.
    await asApp(async () => {
      await expectSqlstate(
        () => db.query(LEADERBOARD_SQL, [windows.prevMonthStart, windows.monthStart, -5]),
        SQLSTATE_CHECK_VIOLATION,
        "a leaderboard cap of minus five",
      );
    }, ORG_A);
  });

  it("ranks deterministically, with a tie-breaker the legacy sort did not have", async () => {
    // ADR-0019 lists "no tie-breaker in any leaderboard sort" as explicitly absent
    // from the source. Two players with identical records must therefore come back
    // in the same order every time, and the order must be a function of stored data
    // rather than of the order rows happened to arrive in.
    const windows = await calendarWindows();
    await seedSquadWin(ORG_A, "cccccccc", SQUAD_A, windows.eventAt);

    const first = await appRows<LeaderboardRow>(LEADERBOARD_SQL, [
      windows.prevMonthStart,
      windows.monthStart,
      null,
    ]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = await appRows<LeaderboardRow>(LEADERBOARD_SQL, [
        windows.prevMonthStart,
        windows.monthStart,
        null,
      ]);
      expect(again.map((r) => r.person_id)).toEqual(first.map((r) => r.person_id));
    }

    // Every player has identical statistics, so the ONLY thing that can order them
    // is the final key — and it is the person id, which is stable and stored.
    expect(first.map((r) => r.person_id)).toEqual([...SQUAD_A].sort());
    expect(first.map((r) => r.rank_position)).toEqual([1, 2, 3, 4]);
  });

  it("aggregates from summed raw inputs rather than averaging stored ratios", async () => {
    // Averaging per-round ratios weights a one-round cameo the same as a full match,
    // which is how a leaderboard ends up ranking a player above the team they lost
    // to. Every aggregate below is therefore sum(inputs) / sum(inputs).
    const windows = await calendarWindows();
    await seedLoneMatch(ORG_A, windows.eventAt);
    await seedSingleLine(ORG_A, SQUAD_A[0]);

    const board = await appRows<LeaderboardRow>(LEADERBOARD_SQL, [
      windows.prevMonthStart,
      windows.monthStart,
      null,
    ]);

    expect(board).toHaveLength(1);
    const row = board[0]!;
    expect(row.rounds_played).toBe(RAW_INPUTS.rounds_played);
    expect(row.kills).toBe(RAW_INPUTS.kills);
    expect(row.deaths).toBe(RAW_INPUTS.deaths);
    expect(row.assists).toBe(RAW_INPUTS.assists);
    expect(row.damage_dealt).toBe(RAW_INPUTS.damage_dealt);

    // 20 / 5 and 4800 / 24 — identical to the single-line figures here, so the
    // assertion that matters is the arithmetic identity rather than the number.
    expect(row.kd_ratio).toBe(DERIVED.kd_ratio);
    expect(row.damage_per_round).toBe(DERIVED.damage_per_round);
    expect(row.headshot_rate_pct).toBe(DERIVED.headshot_rate_pct);
    // The lone match was LOST, and the loss is read from match_result rather than
    // inferred from the absence of a win. A player with numbers posted and no
    // result recorded is not a win, and is not silently counted as a match either.
    expect(row.wins).toBe(0);
    expect(row.losses).toBe(1);
    expect(row.draws).toBe(0);
    expect(row.matches_played).toBe(1);

    // The legacy device this replaces: "win rate = totalMatches * 0.7". It is not
    // present, and the column that would hold it is not in the schema at all.
    const columns = await ownerRows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'match_player_performance'
          AND column_name ~ '(win_rate|team_ranking|score)'`,
    );
    expect(columns).toEqual([]);
  });

  it("reads the tenant from the session, not from a parameter", async () => {
    const windows = await calendarWindows();
    await seedSquadWin(ORG_A, "cccccccc", SQUAD_A, windows.eventAt);
    await seedSquadWin(ORG_B, "dddddddd", [P_B], windows.eventAt);

    // No organisation argument exists to pass. ADR-0011 rule 3: the caller never
    // chooses which tenant they read.
    //
    // Read through `pg_get_function_arguments` rather than `proargnames`: the
    // latter also carries the OUT columns, because `RETURNS TABLE` columns ARE OUT
    // parameters, so an assertion on that list would be testing the return shape
    // (already covered by every row-level assertion above) rather than the input
    // surface. This renders the INPUT arguments only.
    const signature = await ownerRows<{ in_args: string; identity: string }>(
      `SELECT pg_get_function_arguments(p.oid)           AS in_args,
              pg_get_function_identity_arguments(p.oid) AS identity
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'player_performance_leaderboard'`,
    );

    expect(signature).toHaveLength(1);
    expect(signature[0]!.in_args).toContain("p_from");
    expect(signature[0]!.in_args).toContain("p_to");
    // p_limit is optional, which is how "no cap" is expressed. Asserted so that a
    // future change making it mandatory cannot pass unnoticed — an always-on cap is
    // exactly the silent truncation this column exists to report.
    expect(signature[0]!.in_args).toContain("p_limit integer DEFAULT NULL");
    expect(
      signature[0]!.in_args,
      "the leaderboard must not take a tenant parameter (ADR-0011 rule 3)",
    ).not.toMatch(/org/i);
    // Exactly three inputs: from, to, and an optional cap. The exact rendering is
    // a formatting detail, so the arity and the types are asserted instead — a
    // fourth argument of any kind is the thing that would matter.
    const identity = signature[0]!.identity;
    expect(identity.split(",")).toHaveLength(3);
    expect(identity).toMatch(/p_from timestamp with time zone/);
    expect(identity).toMatch(/p_to timestamp with time zone/);
    expect(identity).toMatch(/p_limit integer$/);

    // ORG_A sees its four and not ORG_B's one.
    const asA = await appRows<LeaderboardRow>(LEADERBOARD_SQL, [
      windows.prevMonthStart,
      windows.monthStart,
      null,
    ]);
    expect(asA.map((r) => r.person_id).sort()).toEqual([...SQUAD_A].sort());

    await asApp(async () => {
      const found = await db.query<LeaderboardRow>(LEADERBOARD_SQL, [
        windows.prevMonthStart,
        windows.monthStart,
        null,
      ]);
      expect(found.rows.map((r) => r.person_id)).toEqual([P_B]);
    }, ORG_B);

    // And with no tenant set at all, nothing is returned rather than everything.
    await asApp(async () => {
      const found = await db.query<LeaderboardRow>(LEADERBOARD_SQL, [
        windows.prevMonthStart,
        windows.monthStart,
        null,
      ]);
      expect(found.rows).toEqual([]);
    });
  });
});
