/**
 * Competitive operations isolation — the Phase 2 release gate.
 *
 * These assertions are about the schema being *unable* to represent the states that
 * destroyed the legacy system: an oversold division, a duplicated attendance, a
 * cross-tenant reference, a result with no provenance, a share over 100%.
 *
 * Every structural claim is made by reflecting over the catalogue (pg_class,
 * information_schema, pg_constraint) rather than by trusting the SQL text that
 * created the tables. A migration that looks correct but is not reflected correctly
 * is still broken, and reading the DDL would not catch it.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migrateUp, migrationStatus } from "./migrations.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

/**
 * Every table introduced by 0002_competitive.sql.
 *
 * Held as an explicit list rather than derived from `schema_migration`, because the
 * point of these tests is that a table which *should* be here is actually present and
 * actually protected. Deriving the list from the migration file would let a table
 * silently drop out of the schema and out of its own test in the same commit.
 */
const COMPETITIVE_TABLES = [
  "game",
  "title",
  "season",
  "division",
  "team",
  "team_membership",
  "team_staff",
  "competition",
  "competition_division",
  "registration",
  "entry_cost",
  "opponent",
  "match",
  "match_map",
  "match_result",
  "prize_pool",
  "attendance_policy",
  "session",
  "session_template",
  "attendance_record",
] as const;

/**
 * Money columns, named rather than pattern-matched.
 *
 * `share_percent` and `confidence` are also numeric, at a different precision on
 * purpose: they are percentages, not money, and forcing them to numeric(18,4) would
 * be a lie about what they are.
 */
const MONEY_COLUMNS = ["gross", "deductions", "net", "tax_withheld", "amount", "discount"] as const;

let db: PGlite;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Runs `fn` as the non-superuser application role.
 *
 * The superuser connection used everywhere else is a control, not the system under
 * test: a superuser bypasses every RLS policy, so any isolation assertion made as a
 * superuser proves nothing (ADR-0006).
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

function uuids(prefix: string, tag: string): string {
  return `${prefix}-0000-0000-0000-${tag}`;
}

/** SQLSTATE for a CHECK constraint violation. */
const SQLSTATE_CHECK_VIOLATION = "23514";
/** SQLSTATE for a foreign key violation. */
const SQLSTATE_FOREIGN_KEY_VIOLATION = "23503";
/** SQLSTATE for a unique violation. */
const SQLSTATE_UNIQUE_VIOLATION = "23505";
/** SQLSTATE for insufficient privilege. */
const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";

/**
 * SQLSTATE the capacity guard reports when a division cannot host a registration.
 *
 * Numerically identical to {@link SQLSTATE_FOREIGN_KEY_VIOLATION}, and named
 * separately because the two are different guarantees that must be read apart:
 * a composite FK failing means the row names another tenant's entity, whereas
 * this code means "this division cannot hold one more entry". The guard reports
 * the same code for both of its refusals on purpose — a division that does not
 * exist and a division that is full are the same failure from the caller's side,
 * which is that the referenced division cannot satisfy this reference.
 *
 * It is deliberately NOT `check_violation`. 23514 is what
 * `competition_division_not_oversold_check` raises when the stored counter is
 * corrupt, and roughly a dozen other CHECK constraints in this schema use it too.
 * Reporting 23514 for a full division would make "you tried to sell past capacity"
 * indistinguishable from "somebody corrupted a counter", and only one of those is a
 * data-integrity fault worth waking someone for — the other is an ordinary business
 * condition a caller turns into a 409.
 */
const SQLSTATE_DIVISION_FULL = "23503";

/**
 * Runs `fn` expecting PostgreSQL to refuse it with a specific SQLSTATE.
 *
 * Asserting the SQLSTATE rather than the message matters here. Several guarantees in
 * this schema are enforced by different mechanisms that all produce a "rejected"
 * outcome, and a message match would let the wrong mechanism satisfy the test. The
 * capacity guard raises a deliberate 23503 before the FK is consulted, so a
 * cross-tenant registration is refused by the guard — correct, but a different
 * guarantee from the one an FK test claims to prove.
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
  expect(actual, `${label}: wrong SQLSTATE — ${String((caught as Error).message).slice(0, 160)}`).toBe(sqlstate);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

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
    VALUES
      ('${ORG_A}', 'org-a', 'Org A', 'INR', 'active'),
      ('${ORG_B}', 'org-b', 'Org B', 'USD', 'active');

    INSERT INTO person (id, external_ref) VALUES
      ('${uuids("aaaaaaaa", "000000000001")}', 'p-1'),
      ('${uuids("aaaaaaaa", "000000000002")}', 'p-2'),
      ('${uuids("bbbbbbbb", "000000000001")}', 'p-3');
  `);
});

interface Stack {
  readonly gameId: string;
  readonly titleId: string;
  readonly divisionId: string;
  readonly teamId: string;
  readonly team2Id: string;
  readonly team3Id: string;
  readonly person1: string;
  readonly person2: string;
  readonly opponentId: string;
  readonly competitionId: string;
  readonly competitionDivisionId: string;
}

/** Builds the full competitive chain for one org. Kept minimal; every table is exercised. */
async function seedStack(orgId: string, prefix: string, person1: string, person2: string): Promise<Stack> {
  const ids = {
    gameId: `${prefix}-0000-0000-0000-000000000001`,
    titleId: `${prefix}-0000-0000-0000-000000000002`,
    seasonId: `${prefix}-0000-0000-0000-000000000003`,
    divisionId: `${prefix}-0000-0000-0000-000000000004`,
    teamId: `${prefix}-0000-0000-0000-000000000005`,
    team2Id: `${prefix}-0000-0000-0000-000000000006`,
    team3Id: `${prefix}-0000-0000-0000-000000000007`,
    opponentId: `${prefix}-0000-0000-0000-000000000008`,
    competitionId: `${prefix}-0000-0000-0000-000000000009`,
    competitionDivisionId: `${prefix}-0000-0000-0000-00000000000a`,
  };

  await asOwner(`
    INSERT INTO game (id, org_id, name, slug) VALUES
      ('${ids.gameId}', '${orgId}', 'Test Game', 'test-game-${prefix}');

    INSERT INTO title (id, org_id, game_id, name, slug, tier, status)
      VALUES ('${ids.titleId}', '${orgId}', '${ids.gameId}', 'Test Cup', 'test-cup-${prefix}', 'commercial', 'active');

    INSERT INTO season (id, org_id, title_id, name, code, starts_on, ends_on, is_current)
      VALUES ('${ids.seasonId}', '${orgId}', '${ids.titleId}', 'Season 1', 'S1', now(), now() + interval '180 days', true);

    INSERT INTO division (id, org_id, season_id, name, slug, tier, rank_order)
      VALUES ('${ids.divisionId}', '${orgId}', '${ids.seasonId}', 'Elite', 'elite-${prefix}', 'elite', 1);

    INSERT INTO team (id, org_id, name, slug, game_id, division_id, status, valid_from)
      VALUES
        ('${ids.teamId}',   '${orgId}', 'Team One',   'team-one-${prefix}',   '${ids.gameId}', '${ids.divisionId}', 'active', now()),
        ('${ids.team2Id}',  '${orgId}', 'Team Two',   'team-two-${prefix}',  '${ids.gameId}', '${ids.divisionId}', 'active', now()),
        ('${ids.team3Id}',  '${orgId}', 'Team Three', 'team-three-${prefix}', '${ids.gameId}', '${ids.divisionId}', 'active', now());

    INSERT INTO team_membership (id, org_id, team_id, person_id, role_in_team, share_percent, valid_from)
      VALUES ('${prefix}-0000-0000-0000-00000000000b', '${orgId}', '${ids.teamId}', '${person1}', 'player', 60, now());

    INSERT INTO opponent (id, org_id, name, short_name, game_id)
      VALUES ('${ids.opponentId}', '${orgId}', 'Rival Esports', 'RIVAL', '${ids.gameId}');

    INSERT INTO competition (id, org_id, title_id, name, format, status, starts_at, ends_at, registration_deadline)
      VALUES ('${ids.competitionId}', '${orgId}', '${ids.titleId}', 'Test Cup 2026', 'single_elimination', 'registration_open',
              now() + interval '10 days', now() + interval '14 days', now() + interval '7 days');

    INSERT INTO competition_division (id, org_id, competition_id, division_id, name, capacity)
      VALUES ('${ids.competitionDivisionId}', '${orgId}', '${ids.competitionId}', '${ids.divisionId}', 'Elite Bracket', 2);
  `);

  return { ...ids, person1, person2 };
}

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe("competitive schema — row level security", () => {
  it("applies 0002_competitive.sql", async () => {
    const status = await migrationStatus(db);
    expect(status.applied).toContain("0002_competitive.sql");
    expect(status.pending).toHaveLength(0);
  });

  it("applies 0003_registration_place_invariant.sql, which corrects 0002", async () => {
    // Asserted separately so the correction cannot quietly drop out of the
    // migration set. 0002 is immutable once applied, so every fix to it lands in
    // a later file, and nothing else in this suite would notice one going missing.
    const status = await migrationStatus(db);
    expect(status.applied).toContain("0003_registration_place_invariant.sql");
  });

  it("runs the isolation assertions as a role that CANNOT bypass RLS", async () => {
    // Every other assertion in this file is made through `asApp`. If that role
    // were a superuser, or held BYPASSRLS, the whole suite would pass while
    // proving nothing — precisely the "isolation silently absent" outcome
    // ADR-0006 was written to prevent. The role's attributes are asserted from
    // the catalogue AND re-asserted live inside the role, because a property read
    // from the catalogue and a property observed in the session can drift apart,
    // and only the second one is the thing actually under test.
    const rows = await ownerRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'raptor_app'`,
    );

    expect(rows, "the application role must exist").toHaveLength(1);
    expect(rows[0]!.rolsuper, "a superuser bypasses every policy in this schema").toBe(false);
    expect(rows[0]!.rolbypassrls, "BYPASSRLS switches the whole guarantee off").toBe(false);

    await asApp(async () => {
      const who = await db.query<{ current_user: string; bypasses_rls: boolean }>(
        `SELECT current_user,
                (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls`,
      );

      expect(who.rows[0]!.current_user).toBe("raptor_app");
      expect(who.rows[0]!.bypasses_rls).toBe(false);
    }, ORG_A);
  });

  it("ENABLES and FORCES row level security on every new table", async () => {
    const rows = await ownerRows<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname = ANY($1) AND relkind = 'r'
        ORDER BY relname`,
      [[...COMPETITIVE_TABLES]],
    );

    expect(rows.map((r) => r.relname)).toEqual([...COMPETITIVE_TABLES].sort());
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });

  it("gives every new table exactly one tenant policy with no IS NULL bypass", async () => {
    const rows = await ownerRows<{ relname: string; polname: string; qual: string; with_check: string }>(
      `SELECT c.relname, p.polname,
              pg_get_expr(p.polqual, p.polrelid)    AS qual,
              pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = ANY($1)
        ORDER BY c.relname`,
      [[...COMPETITIVE_TABLES]],
    );

    expect(rows).toHaveLength(COMPETITIVE_TABLES.length);
    for (const row of rows) {
      expect(row.polname).toBe(`${row.relname}_tenant_isolation`);
      // The tenant predicate is the WHOLE predicate. An `OR org_id IS NULL` anywhere
      // here would hand every tenant every row whenever the context is missing.
      expect(row.qual).not.toMatch(/IS NULL/i);
      expect(row.with_check).not.toMatch(/IS NULL/i);
      expect(row.qual).toMatch(/org_id/);
      expect(row.with_check).toMatch(/org_id/);
    }
  });
});

describe("competitive schema — tenancy columns", () => {
  it("makes org_id NOT NULL on every new table", async () => {
    const rows = await ownerRows<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = ANY($1) AND column_name = 'org_id'
        ORDER BY table_name`,
      [[...COMPETITIVE_TABLES]],
    );

    expect(rows).toHaveLength(COMPETITIVE_TABLES.length);
    for (const row of rows) {
      expect(row.is_nullable, `${row.table_name}.org_id must be NOT NULL`).toBe("NO");
    }
  });

  it("gives every new table UNIQUE (org_id, id) so children can use composite FKs", async () => {
    // Grouped per constraint, not per table: a table with both UNIQUE (org_id, id) and
    // another two-column unique would otherwise collapse into a single unidentifiable row.
    const rows = await ownerRows<{ relname: string; conname: string; attnames: string[] }>(
      `SELECT c.relname, u.conname, array_agg(a.attname ORDER BY k.ord) AS attnames
         FROM pg_constraint u
         JOIN pg_class c ON c.oid = u.conrelid
         JOIN LATERAL unnest(u.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = u.conrelid AND a.attnum = k.attnum
        WHERE u.contype = 'u'
          AND c.relname = ANY($1)
        GROUP BY c.relname, u.conname, u.conkey
        ORDER BY c.relname, u.conname`,
      [[...COMPETITIVE_TABLES]],
    );

    const keyed = rows.filter((r) => r.attnames.length === 2 && r.attnames[0] === "org_id" && r.attnames[1] === "id");

    // Without this, a table silently losing its UNIQUE (org_id, id) would still pass
    // every other FK test in this file, because no child could then reference it.
    expect(
      keyed.map((r) => r.relname).sort(),
      "every competitive table must expose UNIQUE (org_id, id) for composite FKs",
    ).toEqual([...COMPETITIVE_TABLES].sort());
  });

  it("leads every multi-column index on a new table with org_id", async () => {
    const rows = await ownerRows<{ table_name: string; index_name: string; cols: string[]; ncols: number }>(
      `SELECT t.relname AS table_name, i.relname AS index_name,
              array_length(x.indkey, 1) AS ncols,
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
      [[...COMPETITIVE_TABLES]],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.cols[0], `${row.table_name}.${row.index_name} must lead with org_id`).toBe("org_id");
    }
  });
});

describe("competitive schema — foreign keys are composite", () => {
  it("has no single-column foreign key to a tenant table", async () => {
    // A table is tenant-owned if it has a NOT NULL org_id AND UNIQUE (org_id, id).
    // `organization` and `person` are excluded by that definition on purpose: the first
    // is the tenant root, the second is deliberately org-independent (a person may
    // belong to several orgs). Anything that does qualify must only be referenced by a
    // composite key, or a cross-tenant reference becomes expressible (ADR-0011).
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

    const fks = await ownerRows<{
      child_table: string;
      parent_table: string;
      conname: string;
      cols: string[];
    }>(
      `SELECT child.relname AS child_table,
              parent.relname AS parent_table,
              con.conname,
              array_agg(a.attname ORDER BY k.ord) AS cols
         FROM pg_constraint con
         JOIN pg_class child  ON child.oid  = con.conrelid
         JOIN pg_class parent ON parent.oid = con.confrelid
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        WHERE con.contype = 'f'
          AND child.relname = ANY($1)
        GROUP BY child.relname, parent.relname, con.conname
        ORDER BY child.relname, con.conname`,
      [[...COMPETITIVE_TABLES]],
    );

    expect(fks.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const fk of fks) {
      if (!tenantTables.has(fk.parent_table)) continue;
      if (fk.cols.length < 2 || fk.cols[0] !== "org_id") {
        offenders.push(`${fk.child_table}.${fk.conname} -> ${fk.parent_table}(${fk.cols.join(", ")})`);
      }
    }

    expect(
      offenders,
      `every FK from a competitive table to a tenant table must be composite and lead with org_id:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("competitive schema — money and time types", () => {
  it("stores every money column as numeric(18,4)", async () => {
    const rows = await ownerRows<{
      table_name: string;
      column_name: string;
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_name = ANY($1) AND column_name = ANY($2)`,
      [[...COMPETITIVE_TABLES], [...MONEY_COLUMNS]],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // An integer minor unit would be an integer type; a float would be
      // double precision. ADR-0003 fixes this at numeric(18,4).
      expect(row.data_type, `${row.table_name}.${row.column_name} must be numeric`).toBe("numeric");
      expect(row.numeric_precision, `${row.table_name}.${row.column_name} precision`).toBe(18);
      expect(row.numeric_scale, `${row.table_name}.${row.column_name} scale`).toBe(4);
    }
  });

  it("pairs every money-bearing table with a varchar(3) currency column", async () => {
    const moneyTables = await ownerRows<{ table_name: string }>(
      `SELECT DISTINCT table_name
         FROM information_schema.columns
        WHERE table_name = ANY($1) AND column_name = ANY($2)`,
      [[...COMPETITIVE_TABLES], [...MONEY_COLUMNS]],
    );

    expect(moneyTables.length).toBeGreaterThan(0);
    for (const { table_name } of moneyTables) {
      const currency = await ownerRows<{ data_type: string; character_maximum_length: number | null }>(
        `SELECT data_type, character_maximum_length
           FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'currency'`,
        [table_name],
      );
      expect(currency, `${table_name} has money but no currency column`).toHaveLength(1);
      expect(currency[0]!.data_type).toBe("character varying");
      expect(currency[0]!.character_maximum_length).toBe(3);
    }
  });

  it("uses timestamptz for every instant and never text", async () => {
    // attendances.session_time was `text` in the legacy schema and the audit called it
    // the likely root cause of the whole attendance bug backlog. A cutoff window
    // cannot be evaluated against a string, so this scans for the regression shape.
    const rows = await ownerRows<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_name = ANY($1)
          AND (column_name ~ '(_at|_from|_to|_on|_deadline)$'
               OR column_name LIKE '%time%'
               OR column_name LIKE '%date%')
        ORDER BY table_name, column_name`,
      [[...COMPETITIVE_TABLES]],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data_type, `${row.table_name}.${row.column_name} must be timestamptz`).toBe(
        "timestamp with time zone",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Row level security in practice
// ---------------------------------------------------------------------------

describe("row level security in practice", () => {
  it("shows a member only their own organisation's rows", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));
    await seedStack(ORG_B, "dddddddd", uuids("bbbbbbbb", "000000000001"), uuids("aaaaaaaa", "000000000001"));

    await asApp(async () => {
      const rows = await db.query<{ org_id: string }>("SELECT org_id FROM team");
      expect(rows.rows).toHaveLength(3);
      expect(rows.rows.every((r) => r.org_id === ORG_A)).toBe(true);
    }, ORG_A);

    await asApp(async () => {
      const rows = await db.query<{ org_id: string }>("SELECT org_id FROM team");
      expect(rows.rows).toHaveLength(3);
      expect(rows.rows.every((r) => r.org_id === ORG_B)).toBe(true);
    }, ORG_B);

    expect(a.teamId).toBeDefined();
  });

  it("refuses a cross-tenant INSERT, representative tables", async () => {
    await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    // As ORG_A, naming ORG_B's game. WITH CHECK rejects it before any FK is consulted.
    await asApp(async () => {
      await expect(
        db.query("INSERT INTO team (org_id, name, slug, game_id, valid_from) VALUES ($1, 'X', 'x', $2, now())", [
          ORG_B,
          "cccccccc-0000-0000-0000-000000000001",
        ]),
      ).rejects.toThrow();
    }, ORG_A);

    // The competing failure the legacy system had: counting a purchase and an entry as
    // the same row. They are separate tables now, so an entry cannot be invented for
    // another org's division either.
    await asApp(async () => {
      await expect(
        db.query(
          "INSERT INTO registration (org_id, competition_division_id, team_id, status) VALUES ($1, $2, $3, 'confirmed')",
          [ORG_B, "dddddddd-0000-0000-0000-00000000000a", "cccccccc-0000-0000-0000-000000000005"],
        ),
      ).rejects.toThrow();
    }, ORG_A);
  });

  it("returns nothing when no tenant is set in the session", async () => {
    await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));
    await seedStack(ORG_B, "dddddddd", uuids("bbbbbbbb", "000000000001"), uuids("aaaaaaaa", "000000000001"));

    // Fail CLOSED. There is deliberately no IS NULL branch in any of these policies,
    // so an unset context cannot expose anything. This is the regression test for the
    // defect pattern ADR-0015 exists to prevent, and it is asserted per table rather
    // than for one representative table.
    const exposed = [
      "game",
      "title",
      "season",
      "division",
      "team",
      "team_membership",
      "team_staff",
      "competition",
      "competition_division",
      "registration",
      "opponent",
      "match",
      "match_result",
      "prize_pool",
      "attendance_policy",
      "session",
      "attendance_record",
    ];

    await asApp(async () => {
      for (const table of exposed) {
        const rows = await db.query(`SELECT * FROM ${table}`);
        expect(rows.rows, `${table} must expose nothing without a tenant context`).toHaveLength(0);
      }
    });

    // And an INSERT with no context must also be refused, not merely invisible.
    await asApp(async () => {
      await expect(
        db.query("INSERT INTO team (org_id, name, slug, game_id, valid_from) VALUES ($1, 'X', 'x', $2, now())", [
          ORG_A,
          "cccccccc-0000-0000-0000-000000000001",
        ]),
      ).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Composite foreign keys
// ---------------------------------------------------------------------------

describe("composite foreign keys make cross-tenant references impossible", () => {
  it("rejects a registration naming another org's division", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));
    const b = await seedStack(ORG_B, "dddddddd", uuids("bbbbbbbb", "000000000001"), uuids("aaaaaaaa", "000000000001"));

    // Same tenant, same division: accepted.
    await asOwner(
      `INSERT INTO registration (org_id, competition_division_id, team_id, status)
       VALUES ('${ORG_A}', '${a.competitionDivisionId}', '${a.teamId}', 'confirmed')`,
    );

    // Different tenants across the two FK columns: refused. Run as the owner so RLS is
    // not what does the refusing — this asserts the DATABASE refuses it independently
    // of any policy. The capacity guard runs first and raises a deliberate 23503 for
    // the same reason, which is why the next test targets the FK rather than the guard.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO registration (org_id, competition_division_id, team_id, status)
           VALUES ('${ORG_A}', '${b.competitionDivisionId}', '${a.teamId}', 'confirmed')`,
        ),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "registration across orgs",
    );
  });

  it("rejects a registration naming another org's team, by the composite FK itself", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));
    const b = await seedStack(ORG_B, "dddddddd", uuids("bbbbbbbb", "000000000001"), uuids("aaaaaaaa", "000000000001"));

    // The division genuinely belongs to ORG_A, so the capacity guard is satisfied and
    // the insert reaches the foreign key. It is refused there, which is the property
    // under test: no composite FK permits one org's row to name another's.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO registration (org_id, competition_division_id, team_id, status)
           VALUES ('${ORG_A}', '${a.competitionDivisionId}', '${b.teamId}', 'confirmed')`,
        ),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "registration naming another org's team",
    );

    expect(b.teamId).not.toBe(a.teamId);
  });

  it("rejects a match pointing at another org's team", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));
    const b = await seedStack(ORG_B, "dddddddd", uuids("bbbbbbbb", "000000000001"), uuids("aaaaaaaa", "000000000001"));

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO match (org_id, team_id, opponent_id, scheduled_at)
           VALUES ('${ORG_A}', '${b.teamId}', '${a.opponentId}', now())`,
        ),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "match naming another org's team",
    );
  });

  it("rejects a match map pointing at another org's match", async () => {
    const b = await seedStack(ORG_B, "dddddddd", uuids("bbbbbbbb", "000000000001"), uuids("aaaaaaaa", "000000000001"));

    await asOwner(
      `INSERT INTO match (id, org_id, team_id, opponent_id, scheduled_at)
       VALUES ('dddddddd-0000-0000-0000-0000000000c1', '${ORG_B}', '${b.teamId}', '${b.opponentId}', now())`,
    );

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO match_map (org_id, match_id, map_order, map_name)
           VALUES ('${ORG_A}', 'dddddddd-0000-0000-0000-0000000000c1', 1, 'Ascent')`,
        ),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "match map naming another org's match",
    );
  });

  it("rejects an attendance record pointing at another org's session", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));
    const b = await seedStack(ORG_B, "dddddddd", uuids("bbbbbbbb", "000000000001"), uuids("aaaaaaaa", "000000000001"));

    await asOwner(
      `INSERT INTO session (id, org_id, team_id, kind, title, starts_at, ends_at)
       VALUES ('cccccccc-0000-0000-0000-0000000000b1', '${ORG_B}', '${b.teamId}', 'practice', 'B Scrim', now(), now() + interval '2 hours')`,
    );

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO attendance_record (org_id, session_id, person_id, status, method)
           VALUES ('${ORG_A}', 'cccccccc-0000-0000-0000-0000000000b1', '${a.person1}', 'present', 'coach_marked')`,
        ),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "attendance naming another org's session",
    );
  });
});

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

describe("a division cannot be oversold", () => {
  it("rejects a registration that exceeds capacity", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));
    // capacity is 2.

    await asApp(async () => {
      await db.query(
        "INSERT INTO registration (org_id, competition_division_id, team_id, status) VALUES ($1, $2, $3, 'confirmed')",
        [ORG_A, a.competitionDivisionId, a.teamId],
      );
      await db.query(
        "INSERT INTO registration (org_id, competition_division_id, team_id, status) VALUES ($1, $2, $3, 'confirmed')",
        [ORG_A, a.competitionDivisionId, a.team2Id],
      );
    }, ORG_A);

    const full = await ownerRows<{ registered_count: number; capacity: number }>(
      "SELECT registered_count, capacity FROM competition_division WHERE id = $1",
      [a.competitionDivisionId],
    );
    expect(full[0]!.registered_count).toBe(2);

    await asApp(async () => {
      await expectSqlstate(
        () =>
          db.query("INSERT INTO registration (org_id, competition_division_id, team_id, status) VALUES ($1, $2, $3, 'confirmed')", [
            ORG_A,
            a.competitionDivisionId,
            a.team3Id,
          ]),
        SQLSTATE_DIVISION_FULL,
        "registration past capacity",
      );
    }, ORG_A);

    const after = await ownerRows<{ registered_count: number }>(
      "SELECT registered_count FROM competition_division WHERE id = $1",
      [a.competitionDivisionId],
    );
    expect(after[0]!.registered_count).toBe(2);
  });

  it("refuses the oversell from plain SQL with no application code in the path", async () => {
    // The ceiling has to be a property of the DATABASE, not of a helper the
    // application happens to call. Everything here runs as the schema owner —
    // which bypasses RLS entirely and is not the application role — so the only
    // thing that can refuse the third registration is the schema itself.
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    await asOwner(`
      INSERT INTO registration (org_id, competition_division_id, team_id, status)
      VALUES
        ('${ORG_A}', '${a.competitionDivisionId}', '${a.teamId}', 'confirmed'),
        ('${ORG_A}', '${a.competitionDivisionId}', '${a.team2Id}', 'confirmed');
    `);

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO registration (org_id, competition_division_id, team_id, status)
           VALUES ('${ORG_A}', '${a.competitionDivisionId}', '${a.team3Id}', 'confirmed')`,
        ),
      SQLSTATE_DIVISION_FULL,
      "plain SQL past capacity",
    );

    // Nothing was written: the refused statement left the division exactly as it
    // found it rather than half-applying the increment.
    const rows = await ownerRows<{ team_id: string }>(
      "SELECT team_id FROM registration WHERE org_id = $1 AND competition_division_id = $2 ORDER BY team_id",
      [ORG_A, a.competitionDivisionId],
    );
    expect(rows.map((r) => r.team_id)).toEqual([a.teamId, a.team2Id].sort());
  });

  it("gives the last remaining place to exactly one of two contenders", async () => {
    // Two teams race for one place. The outcome a concurrent pair must converge
    // to is exactly this: one row, one increment, one refusal.
    //
    // SCOPE, STATED PLAINLY: PGlite is ONE in-process session, so two
    // statements cannot interleave inside the guard's read-then-increment window
    // and a genuine concurrent race is not expressible here. This is the
    // deterministic sequential form of the same guarantee, not a substitute for
    // a concurrency test. The window is closed by the `FOR UPDATE` row lock the
    // guard takes before reading the count (see 0003_registration_place_invariant.sql);
    // proving that claim needs a real multi-connection server, which ADR-0015
    // records as unavailable on this machine.
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    await asOwner(
      `UPDATE competition_division SET capacity = 1 WHERE org_id = '${ORG_A}' AND id = '${a.competitionDivisionId}'`,
    );

    // Contender one.
    await asOwner(
      `INSERT INTO registration (org_id, competition_division_id, team_id, status)
       VALUES ('${ORG_A}', '${a.competitionDivisionId}', '${a.teamId}', 'confirmed')`,
    );

    // Contender two, immediately after, against the same division row.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO registration (org_id, competition_division_id, team_id, status)
           VALUES ('${ORG_A}', '${a.competitionDivisionId}', '${a.team2Id}', 'confirmed')`,
        ),
      SQLSTATE_DIVISION_FULL,
      "second contender for the last place",
    );

    const rows = await ownerRows<{ team_id: string; registered_count: number; capacity: number }>(
      `SELECT r.team_id, cd.registered_count, cd.capacity
         FROM registration r
         JOIN competition_division cd
           ON cd.org_id = r.org_id AND cd.id = r.competition_division_id
        WHERE r.org_id = $1 AND r.competition_division_id = $2`,
      [ORG_A, a.competitionDivisionId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.team_id).toBe(a.teamId);
    expect(rows[0]!.registered_count).toBe(1);
    expect(rows[0]!.registered_count).toBeLessThanOrEqual(rows[0]!.capacity);
  });

  it("refuses to re-confirm a withdrawn entry once the division has filled again", async () => {
    // The legacy defect restated in new tables. Releasing a place on withdrawal
    // and NOT retaking it on re-confirmation means three confirmed entries can
    // sit in a division of capacity two while the counter still reads two. The
    // counter is right and the division is oversold, which is worse than a wrong
    // counter because nothing in the schema contradicts it.
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    await asOwner(`
      INSERT INTO registration (org_id, competition_division_id, team_id, status)
      VALUES
        ('${ORG_A}', '${a.competitionDivisionId}', '${a.teamId}', 'confirmed'),
        ('${ORG_A}', '${a.competitionDivisionId}', '${a.team2Id}', 'confirmed');
    `);

    // Withdraw one, giving its place back.
    await asOwner(
      `UPDATE registration SET status = 'withdrawn', withdrawn_at = now()
        WHERE org_id = '${ORG_A}' AND team_id = '${a.teamId}'`,
    );

    // The freed place is genuinely sold to somebody else.
    await asOwner(
      `INSERT INTO registration (org_id, competition_division_id, team_id, status)
       VALUES ('${ORG_A}', '${a.competitionDivisionId}', '${a.team3Id}', 'confirmed')`,
    );

    // Now the original team wants back in. There is no place, so the database
    // must refuse it.
    await expectSqlstate(
      () =>
        asOwner(
          `UPDATE registration SET status = 'confirmed', withdrawn_at = NULL
            WHERE org_id = '${ORG_A}' AND team_id = '${a.teamId}'`,
        ),
      SQLSTATE_DIVISION_FULL,
      "re-confirming an entry past capacity",
    );

    const state = await ownerRows<{ team_id: string; status: string }>(
      "SELECT team_id, status FROM registration WHERE org_id = $1 AND competition_division_id = $2 ORDER BY team_id",
      [ORG_A, a.competitionDivisionId],
    );

    expect(state).toHaveLength(3);
    expect(state.filter((r) => r.status === "confirmed")).toHaveLength(2);
  });

  it("does not sell a place to an entry that was never given one", async () => {
    // `registered_count` means "teams holding a place". A waitlisted or withdrawn
    // entry holds none, so counting it makes the division report itself full
    // while it has room — the same class of defect as overselling, and the reason
    // the placeholder now derives from the status rather than from the INSERT.
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    await asOwner(
      `UPDATE competition_division SET capacity = 1 WHERE org_id = '${ORG_A}' AND id = '${a.competitionDivisionId}'`,
    );

    await asOwner(
      `INSERT INTO registration (org_id, competition_division_id, team_id, status)
       VALUES ('${ORG_A}', '${a.competitionDivisionId}', '${a.teamId}', 'waitlisted')`,
    );

    const waiting = await ownerRows<{ registered_count: number }>(
      "SELECT registered_count FROM competition_division WHERE id = $1",
      [a.competitionDivisionId],
    );
    expect(waiting[0]!.registered_count).toBe(0);

    // The single real place is still available.
    await asOwner(
      `INSERT INTO registration (org_id, competition_division_id, team_id, status)
       VALUES ('${ORG_A}', '${a.competitionDivisionId}', '${a.team2Id}', 'confirmed')`,
    );

    // And promoting the waitlisted entry is what must now be refused.
    await expectSqlstate(
      () =>
        asOwner(
          `UPDATE registration SET status = 'confirmed'
            WHERE org_id = '${ORG_A}' AND team_id = '${a.teamId}'`,
        ),
      SQLSTATE_DIVISION_FULL,
      "promoting a waitlisted entry past capacity",
    );

    const final = await ownerRows<{ registered_count: number; capacity: number }>(
      "SELECT registered_count, capacity FROM competition_division WHERE id = $1",
      [a.competitionDivisionId],
    );
    expect(final[0]!.registered_count).toBe(1);
    expect(final[0]!.registered_count).toBeLessThanOrEqual(final[0]!.capacity);
  });

  it("does not let any role reach the counter's internals except by registering", async () => {
    // PostgreSQL grants EXECUTE on a new function to PUBLIC. Left alone, that hands
    // every role — including the application role and any future one — a direct way to
    // move registered_count without registering anybody, which is the same class of
    // defect as letting the app raise `capacity`. 0002 granted EXECUTE on its capacity
    // functions to raptor_app outright; the guard is reachable only by writing a
    // registration, and this asserts that.
    const rows = await ownerRows<{ proname: string; public_may_execute: boolean }>(
      `SELECT p.proname,
              -- aclitem is a base type, not a composite, so its grantee cannot be read with
              -- field notation; aclexplode is the supported way to decompose an ACL.
              -- Grantee 0 is the pseudo-role PUBLIC. A NULL proacl means the default
              -- ACL is still in force, which also grants PUBLIC, so the NULL case
              -- counts as "may execute".
              COALESCE(p.proacl IS NULL OR EXISTS (
                SELECT 1 FROM aclexplode(p.proacl) AS e(grantor, grantee, privilege_type, is_grantable)
                 WHERE e.grantee = 0 AND e.privilege_type = 'EXECUTE'
              ), false) AS public_may_execute
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('registration_holds_place', 'take_competition_division_place',
                            'give_back_competition_division_place', 'sync_competition_division_place')
        ORDER BY p.proname`,
    );

    expect(rows.map((r) => r.proname)).toEqual([
      "give_back_competition_division_place",
      "registration_holds_place",
      "sync_competition_division_place",
      "take_competition_division_place",
    ]);
    for (const row of rows) {
      expect(row.public_may_execute, `${row.proname} must not be executable by PUBLIC`).toBe(false);
    }

    // And the live refusal, from the role that actually runs in production. If this
    // ever succeeds, the application can move the counter without an entry behind it.
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    await asApp(async () => {
      await expect(
        db.query("SELECT public.take_competition_division_place($1, $2)", [ORG_A, a.competitionDivisionId]),
      ).rejects.toThrow();

      await expect(
        db.query("SELECT public.give_back_competition_division_place($1, $2)", [ORG_A, a.competitionDivisionId]),
      ).rejects.toThrow();
    }, ORG_A);

    // Neither attempt moved the counter, which is the property that actually matters:
    // a refused call must not leave a partial effect behind.
    const after = await ownerRows<{ registered_count: number }>(
      "SELECT registered_count FROM competition_division WHERE org_id = $1 AND id = $2",
      [ORG_A, a.competitionDivisionId],
    );
    expect(after[0]!.registered_count).toBe(0);
  });

  it("rejects the oversell even when the counter is written directly", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    // The CHECK, not the trigger. Even bypassing the trigger, a state with more
    // registered teams than places is not storable. The SQLSTATE is asserted, and
    // it is deliberately the SAME code the guard uses for nothing: 23514 here
    // means the stored counter was corrupted, which is a different fault from a
    // refused registration and must stay distinguishable from it.
    await expectSqlstate(
      () =>
        asOwner(
          "UPDATE competition_division SET registered_count = 3 WHERE id = 'cccccccc-0000-0000-0000-00000000000a'",
        ),
      SQLSTATE_CHECK_VIOLATION,
      "direct overshoot of registered_count",
    );
    expect(a.competitionDivisionId).toBeDefined();
  });

  it("returns the place when a registration is withdrawn", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    await asApp(async () => {
      await db.query("INSERT INTO registration (org_id, competition_division_id, team_id, status) VALUES ($1,$2,$3,'confirmed')", [
        ORG_A,
        a.competitionDivisionId,
        a.teamId,
      ]);
      await db.query("INSERT INTO registration (org_id, competition_division_id, team_id, status) VALUES ($1,$2,$3,'confirmed')", [
        ORG_A,
        a.competitionDivisionId,
        a.team2Id,
      ]);
    }, ORG_A);

    await asApp(async () => {
      await expect(
        db.query("INSERT INTO registration (org_id, competition_division_id, team_id, status) VALUES ($1,$2,$3,'confirmed')", [
          ORG_A,
          a.competitionDivisionId,
          a.team3Id,
        ]),
      ).rejects.toThrow(/full/i);
    }, ORG_A);

    await asApp(async () => {
      await db.query(
        "UPDATE registration SET status = 'withdrawn', withdrawn_at = now() WHERE org_id = $1 AND team_id = $2",
        [ORG_A, a.teamId],
      );
    }, ORG_A);

    const after = await ownerRows<{ registered_count: number }>(
      "SELECT registered_count FROM competition_division WHERE id = $1",
      [a.competitionDivisionId],
    );
    expect(after[0]!.registered_count).toBe(1);

    // The freed place is genuinely usable.
    await asApp(async () => {
      await db.query("INSERT INTO registration (org_id, competition_division_id, team_id, status) VALUES ($1,$2,$3,'confirmed')", [
        ORG_A,
        a.competitionDivisionId,
        a.team3Id,
      ]);
    }, ORG_A);

    const final = await ownerRows<{ registered_count: number }>(
      "SELECT registered_count FROM competition_division WHERE id = $1",
      [a.competitionDivisionId],
    );
    expect(final[0]!.registered_count).toBe(2);
  });

  it("denies the application role the ability to raise capacity directly", async () => {
    await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    // A role that can raise capacity can also oversell one with a single statement, so
    // the counter is owned by the trigger and the app role never gets UPDATE here.
    // The SQLSTATE is asserted rather than the message, so a refusal by some other
    // mechanism — a column-level grant gap, say — could not stand in for the
    // privilege decision this test claims to prove.
    await asApp(async () => {
      await expectSqlstate(
        () => db.query("UPDATE competition_division SET capacity = 999 WHERE id = $1", [
          "cccccccc-0000-0000-0000-00000000000a",
        ]),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "raising capacity as the application role",
      );
    }, ORG_A);

    // Refused, not clamped: the stored capacity is what it was seeded at.
    const rows = await ownerRows<{ capacity: number }>(
      "SELECT capacity FROM competition_division WHERE id = 'cccccccc-0000-0000-0000-00000000000a'",
    );
    expect(rows[0]!.capacity).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Roster integrity
// ---------------------------------------------------------------------------

describe("roster integrity", () => {
  it("refuses two CURRENT memberships for one person on one team", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));
    // The fixture already holds one current membership for person1 on teamId.

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO team_membership (id, org_id, team_id, person_id, role_in_team, share_percent, valid_from)
           VALUES ('cccccccc-0000-0000-0000-0000000000c1', '${ORG_A}', '${a.teamId}', '${a.person1}', 'player', 40, now())`,
        ),
      SQLSTATE_UNIQUE_VIOLATION,
      "second current membership",
    );

    // A second, different person is fine — the index is per person, not per team.
    await asOwner(
      `INSERT INTO team_membership (id, org_id, team_id, person_id, role_in_team, share_percent, valid_from)
       VALUES ('cccccccc-0000-0000-0000-0000000000c2', '${ORG_A}', '${a.teamId}', '${a.person2}', 'player', 40, now())`,
    );

    // A historical row for the same person does not collide: effective dating is the
    // point, so a past membership must remain recordable.
    await asOwner(
      `INSERT INTO team_membership (id, org_id, team_id, person_id, role_in_team, share_percent, valid_from, valid_to)
       VALUES ('cccccccc-0000-0000-0000-0000000000c3', '${ORG_A}', '${a.teamId}', '${a.person1}', 'player', 100, now() - interval '1 year', now() - interval '6 months')`,
    );
  });

  it("refuses a share_percent outside 0..100", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    // Values inside numeric(7,4)'s range but outside 0..100 must hit the CHECK.
    // 1000 is deliberately not in this list: it exceeds the column's precision and is
    // refused as a numeric overflow before the CHECK is ever evaluated, which would make
    // the assertion pass for the wrong reason.
    for (const bad of ["100.5", "-1", "-0.0001"]) {
      await expectSqlstate(
        () =>
          asOwner(
            `INSERT INTO team_membership (id, org_id, team_id, person_id, share_percent, valid_from)
             VALUES (gen_random_uuid(), '${ORG_A}', '${a.team2Id}', '${a.person2}', ${bad}, now())`,
          ),
        SQLSTATE_CHECK_VIOLATION,
        `share_percent ${bad}`,
      );
    }

    // The boundaries themselves are legal: 0 and 100 are real shares.
    await asOwner(
      `INSERT INTO team_membership (id, org_id, team_id, person_id, share_percent, valid_from)
       VALUES ('cccccccc-0000-0000-0000-0000000000d1', '${ORG_A}', '${a.team2Id}', '${a.person2}', 100, now())`,
    );

    const stored = await ownerRows<{ share_percent: string }>(
      "SELECT share_percent::text FROM team_membership WHERE id = 'cccccccc-0000-0000-0000-0000000000d1'",
    );
    expect(stored[0]!.share_percent).toBe("100.0000");
  });

  it("keeps a coach on staff without putting them on the roster", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    await asOwner(
      `INSERT INTO team_staff (org_id, team_id, person_id, role_in_team, valid_from)
       VALUES ('${ORG_A}', '${a.teamId}', '${a.person2}', 'head_coach', now())`,
    );

    // The coach manages the team and holds no membership, so the prize engine cannot
    // split a pool with them — the defect the separate table exists to prevent.
    const memberships = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM team_membership WHERE org_id = $1 AND team_id = $2 AND person_id = $3",
      [ORG_A, a.teamId, a.person2],
    );
    expect(memberships[0]!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Results, money, attendance
// ---------------------------------------------------------------------------

describe("results carry provenance", () => {
  it("requires a confidence value, and requires 1 for a hand-entered result", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    await asOwner(
      `INSERT INTO match (id, org_id, team_id, opponent_id, status, scheduled_at, completed_at)
       VALUES ('cccccccc-0000-0000-0000-0000000000e1', '${ORG_A}', '${a.teamId}', '${a.opponentId}', 'completed', now() - interval '2 hours', now() - interval '1 hour')`,
    );

    // OCR-derived: a real confidence below 1 is exactly what this column is for.
    await asOwner(
      `INSERT INTO match_result (id, org_id, match_id, team_id, outcome, rounds_won, rounds_lost, source, confidence)
       VALUES ('cccccccc-0000-0000-0000-0000000000e2', '${ORG_A}', 'cccccccc-0000-0000-0000-0000000000e1', '${a.teamId}',
               'win', 13, 9, 'ocr', 0.8200)`,
    );

    // Manual but claiming less than full confidence is a contradiction: either a
    // person asserted it, or a machine guessed. The schema refuses the middle.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO match_result (id, org_id, match_id, team_id, outcome, source, confidence)
           VALUES ('cccccccc-0000-0000-0000-0000000000e3', '${ORG_A}', 'cccccccc-0000-0000-0000-0000000000e1', '${a.teamId}',
                   'loss', 'manual', 0.5)`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "manual result with machine confidence",
    );

    // Confidence outside 0..1 is rejected outright.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO match_result (id, org_id, match_id, team_id, outcome, source, confidence)
           VALUES ('cccccccc-0000-0000-0000-0000000000e4', '${ORG_A}', 'cccccccc-0000-0000-0000-0000000000e1', '${a.teamId}',
                   'loss', 'ocr', 1.5)`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "confidence above 1",
    );

    const stored = await ownerRows<{ source: string; confidence: string }>(
      "SELECT source, confidence::text FROM match_result WHERE id = 'cccccccc-0000-0000-0000-0000000000e2'",
    );
    expect(stored[0]!.source).toBe("ocr");
    expect(stored[0]!.confidence).toBe("0.8200");
  });

  it("will not record two current results for one match and team", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    await asOwner(
      `INSERT INTO match (id, org_id, team_id, opponent_id, status, scheduled_at)
       VALUES ('cccccccc-0000-0000-0000-0000000000f1', '${ORG_A}', '${a.teamId}', '${a.opponentId}', 'completed', now())`,
    );
    await asOwner(
      `INSERT INTO match_result (id, org_id, match_id, team_id, outcome, source, confidence)
       VALUES ('cccccccc-0000-0000-0000-0000000000f2', '${ORG_A}', 'cccccccc-0000-0000-0000-0000000000f1', '${a.teamId}',
               'win', 'manual', 1)`,
    );

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO match_result (id, org_id, match_id, team_id, outcome, source, confidence)
           VALUES ('cccccccc-0000-0000-0000-0000000000f3', '${ORG_A}', 'cccccccc-0000-0000-0000-0000000000f1', '${a.teamId}',
                   'loss', 'manual', 1)`,
        ),
      SQLSTATE_UNIQUE_VIOLATION,
      "second result for one match",
    );
  });
});

describe("prize pool arithmetic", () => {
  it("refuses a net that is not gross minus deductions", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO prize_pool (org_id, competition_division_id, gross, deductions, net, tax_withheld, currency)
           VALUES ('${ORG_A}', '${a.competitionDivisionId}', 1000.0000, 100.0000, 950.0000, 0, 'INR')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "net inconsistent with gross - deductions",
    );

    await asOwner(
      `INSERT INTO prize_pool (org_id, competition_division_id, gross, deductions, net, tax_withheld, currency)
       VALUES ('${ORG_A}', '${a.competitionDivisionId}', 1000.0000, 100.0000, 900.0000, 50.0000, 'INR')`,
    );

    const stored = await ownerRows<{ gross: string; net: string; currency: string }>(
      "SELECT gross::text, net::text, currency FROM prize_pool WHERE org_id = $1",
      [ORG_A],
    );
    expect(stored[0]!.gross).toBe("1000.0000");
    expect(stored[0]!.net).toBe("900.0000");
    expect(stored[0]!.currency).toBe("INR");
  });

  it("refuses a currency that is not ISO 4217 alphabetic", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    await asOwner(
      `INSERT INTO registration (id, org_id, competition_division_id, team_id, status)
       VALUES ('cccccccc-0000-0000-0000-0000000000d9', '${ORG_A}', '${a.competitionDivisionId}', '${a.teamId}', 'confirmed')`,
    );

    // Three characters but not an ISO 4217 alphabetic code — the legacy README
    // hardcoded a ₹ symbol and had no currency column at all.
    for (const bad of ["inr", "123"]) {
      await expectSqlstate(
        () =>
          asOwner(
            `INSERT INTO entry_cost (org_id, registration_id, amount, currency)
             VALUES ('${ORG_A}', 'cccccccc-0000-0000-0000-0000000000d9', 500, '${bad}')`,
          ),
        SQLSTATE_CHECK_VIOLATION,
        `currency ${bad}`,
      );
    }
  });
});

describe("attendance integrity", () => {
  it("refuses a duplicate attendance for the same person and session", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    await asOwner(
      `INSERT INTO session (id, org_id, team_id, kind, title, starts_at, ends_at)
       VALUES ('cccccccc-0000-0000-0000-0000000000a1', '${ORG_A}', '${a.teamId}', 'practice', 'Scrim Review', now(), now() + interval '2 hours')`,
    );

    await asOwner(
      `INSERT INTO attendance_record (org_id, session_id, person_id, status, method)
       VALUES ('${ORG_A}', 'cccccccc-0000-0000-0000-0000000000a1', '${a.person1}', 'present', 'kiosk_scan')`,
    );

    // The legacy schema had no attendance entity at all, so a re-scan created a second
    // row and every count was inflated. Here the second row cannot be written.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO attendance_record (org_id, session_id, person_id, status, method)
           VALUES ('${ORG_A}', 'cccccccc-0000-0000-0000-0000000000a1', '${a.person1}', 'present', 'coach_marked')`,
        ),
      SQLSTATE_UNIQUE_VIOLATION,
      "duplicate attendance",
    );

    // A different person at the same session is unaffected.
    await asOwner(
      `INSERT INTO attendance_record (org_id, session_id, person_id, status, method, minutes_late)
       VALUES ('${ORG_A}', 'cccccccc-0000-0000-0000-0000000000a1', '${a.person2}', 'late', 'self_reported', 7)`,
    );

    const count = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM attendance_record WHERE org_id = $1 AND session_id = $2",
      [ORG_A, "cccccccc-0000-0000-0000-0000000000a1"],
    );
    expect(count[0]!.n).toBe(2);
  });

  it("refuses minutes_late on a row that is not late", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    await asOwner(
      `INSERT INTO session (id, org_id, team_id, kind, title, starts_at, ends_at)
       VALUES ('cccccccc-0000-0000-0000-0000000000b2', '${ORG_A}', '${a.teamId}', 'practice', 'Block', now(), now() + interval '3 hours')`,
    );

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO attendance_record (org_id, session_id, person_id, status, method, minutes_late)
           VALUES ('${ORG_A}', 'cccccccc-0000-0000-0000-0000000000b2', '${a.person1}', 'absent', 'coach_marked', 12)`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "absent with minutes_late",
    );

    // The converse: 'late' with no figure says someone was late but not by how much,
    // which is the row an attendance report cannot reconcile.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO attendance_record (org_id, session_id, person_id, status, method)
           VALUES ('${ORG_A}', 'cccccccc-0000-0000-0000-0000000000b2', '${a.person2}', 'late', 'self_reported')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "late without minutes_late",
    );

    await asOwner(
      `INSERT INTO attendance_record (org_id, session_id, person_id, status, method, minutes_late)
       VALUES ('${ORG_A}', 'cccccccc-0000-0000-0000-0000000000b2', '${a.person2}', 'late', 'self_reported', 12)`,
    );
  });

  it("refuses an attendance policy whose cutoff runs forwards", async () => {
    const a = await seedStack(ORG_A, "cccccccc", uuids("aaaaaaaa", "000000000001"), uuids("aaaaaaaa", "000000000002"));

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO attendance_policy (org_id, team_id, name, cutoff_offset_minutes, grace_minutes)
           VALUES ('${ORG_A}', '${a.teamId}', 'Strict', 15, 5)`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "cutoff running forwards",
    );

    await asOwner(
      `INSERT INTO attendance_policy (org_id, team_id, name, cutoff_offset_minutes, grace_minutes, holiday_scope)
       VALUES ('${ORG_A}', '${a.teamId}', 'Strict', -15, 5, 'org')`,
    );
  });
});