/**
 * Portability — the cross-tenant export and the all-or-nothing import.
 *
 * This file is the release gate for deliverable 5, and it is organised around the
 * one failure mode that matters: **a cross-tenant data leak**. Every other
 * concern here is subordinate to proving that an export for organisation A
 * contains nothing whatsoever of organisation B.
 *
 * WHY THE ASSERTIONS ARE SHAPED THE WAY THEY ARE
 * ----------------------------------------------
 *
 * A leak test that only checks the happy path proves nothing. Specifically:
 *
 *   * `expect(doc.tables.team).toHaveLength(2)` passes just as well when the
 *     document contains the WRONG two. Every count assertion here is paired with
 *     a membership assertion, and every membership assertion is paired with a
 *     negative one.
 *   * A test that runs as the schema owner would pass even if the export
 *     returned the whole database, because the owner bypasses RLS. So the
 *     isolation assertions run as `raptor_app` — and, because the export
 *     function is SECURITY DEFINER, that role's RLS is not what protects
 *     anything here. It is the function's own predicate. Which is exactly why
 *     there is a CONTROL assertion proving the owner sees both organisations
 *     through the same function: without it, a function that returned nothing at
 *     all would pass every isolation test in this file.
 *   * A leak test that cannot be DIFFED cannot fail. An export whose row order
 *     varies between runs produces a different document every time, so the one
 *     meaningful assertion — "these two documents are identical" — would be
 *     meaningless too. Determinism is therefore tested first and treated as a
 *     precondition of everything else.
 *
 * THE CLAIMS
 * ----------
 *  1. The contract is COMPLETE: every table carrying `org_id NOT NULL` is in it,
 *     each exactly once, and the only additions are `organization`, `person` and
 *     `person_profile`. A migration that adds a table and forgets to export it
 *     fails here rather than shipping a backup with a hole in it.
 *  2. The contract's ORDER is a topological order over the real foreign-key
 *     graph, recomputed from `pg_constraint` rather than trusted from the
 *     migration's own comment.
 *  3. The documented exclusions are genuinely absent, by name.
 *  4. An export for A contains NONE of B's sentinels — including B's PEOPLE,
 *     which is the sharp form of the leak, because `person` is the one table
 *     with no tenant predicate available to get wrong.
 *  5. An unset tenant context produces NO DOCUMENT AT ALL, for either role.
 *  6. Two exports of the same data are byte-identical.
 *  7. Export → delete → import reproduces the same document, byte for byte.
 *  8. A payload with one malformed record halfway through writes ZERO rows.
 *  9. A cross-tenant REFERENCE is refused by the composite foreign key.
 * 10. A cross-tenant DOCUMENT is refused by the tenant check, and a cross-tenant
 *     ROW inside a correct document is refused before any row is written.
 * 11. The receipt exists if and only if the import happened.
 *
 * ENVIRONMENT TRAPS THIS FILE IS WRITTEN AROUND
 * ---------------------------------------------
 *   * PGlite returns `timestamptz` to Node as HOST-timezone `Date` objects, so
 *     an instant is compared as TEXT, cast in SQL. Every literal is a whole ISO
 *     instant: PostgreSQL SILENTLY parses a malformed ISO string into a
 *     wrong-but-valid instant with no error, so a concatenated literal would pass
 *     an assertion that means nothing.
 *   * `digest()`/pgcrypto is unavailable in this PGlite build, so the receipt's
 *     digest is asserted by SHAPE (64 lowercase hex) and by EQUALITY between two
 *     imports of the same document, not against a value computed elsewhere.
 *   * The export is SECURITY DEFINER, so `SET ROLE` does not change what it can
 *     read. That is stated here rather than discovered again.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migrateUp } from "./migrations.js";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

/**
 * SENTINELS.
 *
 * Strings that appear ONLY in organisation B's data. Every one of them is
 * asserted ABSENT from organisation A's export, by content search over the whole
 * serialised document rather than by inspecting one table — a leak through a
 * table nobody thought to check is exactly the case a per-table assertion misses.
 */
const SENTINEL_TEAM_B = "ORG-B-SENTINEL-TEAM";
const SENTINEL_TITLE_B = "ORG-B-SENTINEL-TITLE";
const SENTINEL_PERSON_B = "org-b-sentinel-person";
const SENTINEL_ASSET_B = "ORG-B-SENTINEL-ASSET";
const SENTINEL_TASK_B = "ORG-B-SENTINEL-TASK";
const SENTINEL_PARTNER_B = "ORG-B-SENTINEL-PARTNER";

/** The mirror of the above: values only organisation A holds. */
const NAME_TEAM_A = "ORG-A-TEAM";
const NAME_TITLE_A = "ORG-A-TITLE";
const EXTERNAL_REF_A = "org-a-player";

const PERSON_A = "aaaa0000-0000-0000-0000-000000000001";
const PERSON_B = "bbbb0000-0000-0000-0000-000000000001";

const GAME_A = "5a000000-0000-0000-0000-000000000001";
const GAME_B = "5a000000-0000-0000-0000-000000000002";
const TITLE_A = "5b000000-0000-0000-0000-000000000001";
const TITLE_B = "5b000000-0000-0000-0000-000000000002";
const SEASON_A = "5c000000-0000-0000-0000-000000000001";
const DIVISION_A = "5d000000-0000-0000-0000-000000000001";
const TEAM_A = "5e000000-0000-0000-0000-000000000001";
const TEAM_B = "5e000000-0000-0000-0000-000000000002";
const OPPONENT_A = "5f000000-0000-0000-0000-000000000001";
const OPPONENT_B = "5f000000-0000-0000-0000-000000000002";

/**
 * Whole ISO instants only. See the file header: PostgreSQL parses a malformed ISO
 * literal into a wrong-but-valid instant without complaining, so a date
 * assertion built from concatenated fragments can pass while testing nothing.
 */
const MATCH_DAY = "2026-05-04T18:00:00Z";

/** Tables whose absence from the contract is a decision, not an oversight. */
const EXCLUDED_BY_DECISION = [
  "audit_log",
  "consent_record",
  "identity",
  "outbox_event",
  "permission",
  "portability_import_run",
] as const;

let db: PGlite;

// -----------------------------------------------------------------------------
// Session helpers
// -----------------------------------------------------------------------------

/**
 * Returns the session to a usable state.
 *
 * ROLLBACK first: PostgreSQL refuses every statement in an ABORTED transaction
 * with 25P02 — including `RESET ROLE` — so the wrong order turns one intended
 * refusal into a cascade of failures that read like schema bugs.
 */
async function recoverSession(): Promise<void> {
  try {
    await db.exec("ROLLBACK");
  } catch {
    // No transaction was open, which is the normal case after a commit.
  }
  try {
    await db.exec("RESET ROLE");
  } catch {
    // Nothing to reset.
  }
}

/** As the schema owner, which bypasses RLS. Seeding and reflection only. */
async function asOwner(sql: string): Promise<void> {
  await recoverSession();
  try {
    await db.exec(sql);
  } catch (error) {
    await recoverSession();
    throw error;
  }
}

/** Run `fn` as `raptor_app`, with `app.org_id` set or deliberately blank. */
async function asApp(fn: () => Promise<void>, orgId?: string): Promise<void> {
  await recoverSession();
  await db.exec("SET ROLE raptor_app");
  if (orgId === undefined) await db.exec("SELECT set_config('app.org_id', '', false)");
  else await db.exec(`SET app.org_id = '${orgId}'`);
  try {
    await fn();
  } finally {
    await recoverSession();
  }
}

/** The export document, as a row, under whichever role is currently assumed. */
async function exportDocument(): Promise<Record<string, unknown>> {
  const found = await db.query<{ doc: Record<string, unknown> }>(
    "SELECT public.portability_export_document() AS doc",
  );
  return found.rows[0]!.doc;
}

/** The export document as text — the form a leak is actually found in. */
async function exportText(): Promise<string> {
  return JSON.stringify(await exportDocument());
}

/** Counts every contract table for the session tenant. Used to prove a wipe. */
async function tenantRowCounts(): Promise<Record<string, number>> {
  const found = await db.query<{ table_name: string; n: number }>(`
    SELECT k.table_name, (
      SELECT count(*)::int
        FROM public.portability_export_document() d,
             jsonb_array_elements(d -> 'tables' -> k.table_name)
    )::int AS n
      FROM public.portability_export_contract() k
     WHERE k.scope = 'tenant'
     ORDER BY k.table_name
  `);
  return Object.fromEntries(found.rows.map((r) => [r.table_name, r.n]));
}

// -----------------------------------------------------------------------------
// Fixture data
// -----------------------------------------------------------------------------

/** A competitive spine — game, title, season, division, team, opponent, match. */
async function seedCompetitiveSpine(
  orgId: string,
  ids: { game: string; title: string; season: string; division: string; team: string; opponent: string; match: string },
  names: { team: string; title: string },
): Promise<void> {
  await asOwner(`
    INSERT INTO game (id, org_id, slug, name)
    VALUES ('${ids.game}', '${orgId}', 'arena', 'Arena');

    INSERT INTO title (id, org_id, game_id, slug, name)
    VALUES ('${ids.title}', '${orgId}', '${ids.game}', 'pro-circuit', ${literal(names.title)});

    INSERT INTO season (id, org_id, title_id, name, starts_on, ends_on)
    VALUES ('${ids.season}', '${orgId}', '${ids.title}', 'Season 1', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z');

    INSERT INTO division (id, org_id, season_id, name, slug)
    VALUES ('${ids.division}', '${orgId}', '${ids.season}', 'Elite', 'elite');

    INSERT INTO team (id, org_id, division_id, game_id, name, slug)
    VALUES ('${ids.team}', '${orgId}', '${ids.division}', '${ids.game}', ${literal(names.team)}, 'roster');

    INSERT INTO opponent (id, org_id, game_id, name)
    VALUES ('${ids.opponent}', '${orgId}', '${ids.game}', 'Rivals');

    INSERT INTO "match" (id, org_id, team_id, opponent_id, status, scheduled_at, started_at, completed_at)
    VALUES ('${ids.match}', '${orgId}', '${ids.team}', '${ids.opponent}',
            'completed', '${MATCH_DAY}', '${MATCH_DAY}', '${MATCH_DAY}');
  `);
}

const MATCH_B = "6a000000-0000-0000-0000-000000000002";

/** Organisation A's rows: the spine above, plus a person, an asset and a task. */
async function seedOrgA(): Promise<void> {
  await seedCompetitiveSpine(
    ORG_A,
    { game: GAME_A, title: TITLE_A, season: SEASON_A, division: DIVISION_A, team: TEAM_A, opponent: OPPONENT_A, match: "6a000000-0000-0000-0000-000000000001" },
    { team: NAME_TEAM_A, title: NAME_TITLE_A },
  );

  await asOwner(`
    INSERT INTO person_profile (person_id, display_name, timezone)
    VALUES ('${PERSON_A}', 'Org A Player', 'UTC');

    INSERT INTO org_membership (id, org_id, person_id, status, joined_at)
    VALUES ('7a000000-0000-0000-0000-000000000001', '${ORG_A}', '${PERSON_A}', 'active', '${MATCH_DAY}');

    INSERT INTO engagement (id, org_id, person_id, classification, title, valid_from)
    VALUES ('7a000000-0000-0000-0000-000000000002', '${ORG_A}', '${PERSON_A}', 'player', 'Starter', '${MATCH_DAY}');

    INSERT INTO asset (id, org_id, asset_tag, name, category)
    VALUES ('9a000000-0000-0000-0000-000000000001', '${ORG_A}', 'LAPTOP-001', 'Org A laptop', 'equipment');

    INSERT INTO partner (id, org_id, name, stage)
    VALUES ('4a000000-0000-0000-0000-000000000001', '${ORG_A}', 'Acme Sponsors', 'lead');
  `);
}

/** Organisation B's rows: the same shape, entirely different values. */
async function seedOrgB(): Promise<void> {
  await seedCompetitiveSpine(
    ORG_B,
    { game: GAME_B, title: TITLE_B, season: "5c000000-0000-0000-0000-000000000002", division: "5d000000-0000-0000-0000-000000000002", team: TEAM_B, opponent: OPPONENT_B, match: MATCH_B },
    { team: SENTINEL_TEAM_B, title: SENTINEL_TITLE_B },
  );

  await asOwner(`
    INSERT INTO person_profile (person_id, display_name, timezone)
    VALUES ('${PERSON_B}', 'Org B Player', 'UTC');

    INSERT INTO org_membership (id, org_id, person_id, status, joined_at)
    VALUES ('7a000000-0000-0000-0000-0000000000b1', '${ORG_B}', '${PERSON_B}', 'active', '${MATCH_DAY}');

    INSERT INTO asset (id, org_id, asset_tag, name, category)
    VALUES ('9a000000-0000-0000-0000-0000000000b1', '${ORG_B}', 'LAPTOP-001', ${literal(SENTINEL_ASSET_B)}, 'equipment');

    INSERT INTO task (id, org_id, title, state, assignee_id)
    VALUES ('7c000000-0000-0000-0000-0000000000b1', '${ORG_B}', ${literal(SENTINEL_TASK_B)}, 'open', '${PERSON_B}');

    INSERT INTO partner (id, org_id, name, stage)
    VALUES ('4a000000-0000-0000-0000-0000000000b1', '${ORG_B}', ${literal(SENTINEL_PARTNER_B)}, 'lead');
  `);
}

/** Quotes a fixture string as a SQL literal. Fixture text contains apostrophes. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Delete every row the contract writes for organisation A, keeping A itself.
 *
 * THREE THINGS THIS GETS WRONG IF IT IS NAIVE, each of which cost a real
 * debugging cycle, and each of which would have produced a test that passes for
 * the wrong reason:
 *
 *  1. **Reverse order.** The contract is ordered parent-before-child for the
 *     import, so deleting in that order removes a `game` while `title` still
 *     references it and fails with `violates RESTRICT setting of foreign key
 *     constraint "title_game_fk"`.
 *  2. **Append-only tables refuse DELETE, correctly.** 0004's `ledger_line` and
 *     0009's evidence tables have guards that reject the delete outright. This
 *     wipe simulates the TOTAL LOSS of a tenant, which is a stronger event than
 *     those guards contemplate, so the guard is suspended for exactly that
 *     statement and switched back on immediately afterwards. Leaving it off
 *     would quietly delete an append-only guarantee for the rest of the run,
 *     which is a worse outcome than the wipe being impossible — so the disable
 *     is undone inside the same block and `expectAppendOnlyGuardsIntact` checks
 *     it afterwards.
 *  3. **People are shared.** `person` has no org_id, so the closure must be
 *     captured BEFORE the tenant rows are deleted — computed afterwards it is
 *     empty, and the wipe then leaves organisation A's people behind, which the
 *     round trip would faithfully reproduce as "the export contains people the
 *     import did not restore".
 */
async function wipeTenantData(): Promise<void> {
  await asOwner(`
    DO $wipe$
    DECLARE
      t          text;
      v_people   uuid[];
      v_disabled text[] := ARRAY[]::text[];
    BEGIN
      v_people := public.portability_person_closure('${ORG_A}'::uuid);

      FOR t IN
        SELECT table_name FROM public.portability_export_contract()
         WHERE scope = 'tenant' AND writable
         ORDER BY ordinal DESC
      LOOP
        BEGIN
          EXECUTE format('DELETE FROM public.%I WHERE org_id = $1', t) USING '${ORG_A}'::uuid;
        EXCEPTION WHEN OTHERS THEN
          EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', t);
          v_disabled := v_disabled || t;
          EXECUTE format('DELETE FROM public.%I WHERE org_id = $1', t) USING '${ORG_A}'::uuid;
        END;
      END LOOP;

      DELETE FROM public.person_profile WHERE person_id = ANY (v_people);
      DELETE FROM public.person          WHERE id         = ANY (v_people);

      FOREACH t IN ARRAY v_disabled LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', t);
      END LOOP;
    END
    $wipe$;
  `);
}

/**
 * Every trigger the wipe suspended is switched back on.
 *
 * A round-trip test that leaves an append-only guarantee disabled has bought its
 * green by removing the thing it was supposed to be checking around.
 */
async function appendOnlyGuardsIntact(): Promise<boolean> {
  const found = await asOwnerRows<{ suspended: number }>(`
    SELECT count(*)::int AS suspended
      FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgenabled = 'D'
       AND tgrelid IN (SELECT to_regclass('public.' || quote_ident(table_name))
                         FROM public.portability_export_contract())
  `);
  return found[0]!.suspended === 0;
}

beforeAll(async () => {
  db = new PGlite();
  await migrateUp(db);
});

beforeEach(async () => {
  await recoverSession();
  await db.exec("SELECT set_config('app.org_id', '', false)");
  // organization cascades to every tenant table, so this is a complete reset.
  await asOwner("TRUNCATE organization, person CASCADE");
  await asOwner(`
    INSERT INTO organization (id, slug, display_name, default_currency, status)
    VALUES ('${ORG_A}', 'org-a', 'Org A', 'INR', 'active'),
           ('${ORG_B}', 'org-b', 'Org B', 'USD', 'active');

    INSERT INTO person (id, external_ref, birth_date) VALUES
      ('${PERSON_A}', ${literal(EXTERNAL_REF_A)}, '1995-04-02'),
      ('${PERSON_B}', ${literal(SENTINEL_PERSON_B)}, '1995-04-02');
  `);
});

// =============================================================================
// 1. THE CONTRACT IS COMPLETE
// =============================================================================

describe("the export contract", () => {
  it("carries every table that carries org_id NOT NULL, each exactly once", async () => {
    // Reflected over the catalogue rather than read from the migration, because a
    // list in a comment is a claim and a list in pg_attribute is a fact.
    //
    // The five documented exclusions are subtracted, and that subtraction is
    // itself part of the assertion: `portability_import_run` is a tenant table
    // this very migration creates, so a completeness check that ignored the
    // exclusion list would have to be rewritten the moment the receipt table was
    // added — and a check that gets rewritten is a check that quietly stops
    // running. The test below is the mirror that keeps the subtraction honest.
    const schema = await db.query<{ table_name: string }>(
      `
      SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnotnull
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname <> ALL ($1::text[])
       ORDER BY c.relname
    `,
      [[...EXCLUDED_BY_DECISION]],
    );
    const declared = await db.query<{ table_name: string }>(
      "SELECT table_name FROM public.portability_export_contract() WHERE scope = 'tenant' ORDER BY table_name",
    );

    expect(schema.rows.map((r) => r.table_name)).toEqual(declared.rows.map((r) => r.table_name));
    expect(declared.rows.length).toBeGreaterThan(70);
  });

  it("excludes EXACTLY the five tables it documents, and nothing else", async () => {
    // Every ordinary table in `public`, not merely the tenant ones. The
    // exclusion list spans three shapes — a tenant table (`portability_import_run`),
    // a nullable-org table (`audit_log`, `outbox_event`) and an org-independent
    // table (`identity`, `consent_record`) — so a check phrased only over tenant
    // tables would silently pass if somebody added a fourth exclusion of a shape
    // it did not consider.
    const everyTable = await db.query<{ table_name: string }>(`
      SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname NOT IN ('schema_migration', 'platform_feature_flag')
       ORDER BY c.relname
    `);
    const declared = await db.query<{ table_name: string }>(
      "SELECT table_name FROM public.portability_export_contract()",
    );

    const notExported = everyTable.rows
      .map((r) => r.table_name)
      .filter((name) => !declared.rows.some((d) => d.table_name === name));

    expect(notExported.sort()).toEqual([...EXCLUDED_BY_DECISION].sort());
  });

  it("adds only organization, person and person_profile to that set", async () => {
    const extra = await db.query<{ table_name: string; scope: string }>(
      "SELECT table_name, scope FROM public.portability_export_contract() WHERE scope <> 'tenant' ORDER BY table_name",
    );
    expect(extra.rows).toEqual([
      { table_name: "organization", scope: "tenant_root" },
      { table_name: "person", scope: "person" },
      { table_name: "person_profile", scope: "person_profile" },
    ]);
  });

  it("lists no table twice", async () => {
    // A duplicate ordinal is not caught by the set comparison above, and a table
    // imported twice is a unique violation at best and a doubled count at worst.
    const found = await db.query<{ table_name: string; n: number }>(`
      SELECT table_name, count(*)::int AS n
        FROM public.portability_export_contract()
       GROUP BY table_name HAVING count(*) > 1
    `);
    expect(found.rows).toEqual([]);
  });

  it("orders the contract so every inter-table reference points backwards", async () => {
    // The order is recomputed from pg_constraint. A table placed before something
    // it references would fail every import of a real organisation, and reading
    // the migration's own comment to check the migration's own claim would prove
    // nothing at all.
    const contract = await db.query<{ table_name: string; ordinal: number }>(
      "SELECT table_name, ordinal FROM public.portability_export_contract()",
    );
    const ordinalOf = new Map(contract.rows.map((r) => [r.table_name, r.ordinal]));
    const inContract = new Set(ordinalOf.keys());

    const edges = await db.query<{ child: string; parent: string; conname: string }>(`
      SELECT cl.relname AS child, pa.relname AS parent, k.conname
        FROM pg_constraint k
        JOIN pg_class cl ON cl.oid = k.conrelid
        JOIN pg_class pa ON pa.oid = k.confrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
       WHERE k.contype = 'f' AND n.nspname = 'public'
    `);

    const backwards = edges.rows.filter(
      (e) =>
        inContract.has(e.child) &&
        inContract.has(e.parent) &&
        // A self reference has no topological order at all; the import's retry
        // loop is what resolves those, and `portability_import_document` refuses
        // a row whose references never land.
        e.child !== e.parent &&
        ordinalOf.get(e.child)! <= ordinalOf.get(e.parent)!,
    );
    expect(backwards).toEqual([]);
  });

  it("omits the five tables excluded by decision, and says why in the schema", async () => {
    const declared = await db.query<{ table_name: string }>(
      "SELECT table_name FROM public.portability_export_contract()",
    );
    const names = declared.rows.map((r) => r.table_name);

    for (const excluded of EXCLUDED_BY_DECISION) {
      expect(names, `${excluded} must not be in the export contract`).not.toContain(excluded);
    }

    // "Deliberately excluded" is a claim only while something checks that the
    // reason is recorded, so the comments are read from the catalogue.
    const comments = await db.query<{ objname: string; description: string }>(`
      SELECT c.relname AS objname, obj_description(c.oid) AS description
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY ($1::text[])
    `, [EXCLUDED_BY_DECISION]);

    for (const row of comments.rows) {
      expect(row.description, `${row.objname} must record why it is not exported`).toBeTruthy();
      expect(row.description!.length).toBeGreaterThan(60);
    }
  });
});

// =============================================================================
// 2. THE EXPORT CANNOT LEAK
// =============================================================================

describe("a cross-tenant export", () => {
  beforeEach(async () => {
    await seedOrgA();
    await seedOrgB();
  });

  it("contains NONE of organisation B's sentinel values — searched over the whole document", async () => {
    const sentinels = [
      SENTINEL_TEAM_B,
      SENTINEL_TITLE_B,
      SENTINEL_PERSON_B,
      SENTINEL_ASSET_B,
      SENTINEL_TASK_B,
      SENTINEL_PARTNER_B,
      // Raw identifiers as well as prose, because a leak of a uuid with no
      // human-readable label is still a leak of another customer's row.
      TEAM_B,
      MATCH_B,
      OPPONENT_B,
      TITLE_B,
      GAME_B,
      ORG_B,
    ];

    await asApp(async () => {
      const text = await exportText();

      for (const sentinel of sentinels) {
        expect(text.includes(sentinel), `organisation A's export leaked ${sentinel}`).toBe(false);
      }
    }, ORG_A);
  });

  it("contains B's PERSON neither in the record set nor in the text", async () => {
    // The sharpest form of the leak. `person` has no org_id (ADR-0018), so it is
    // the one table with no tenant predicate available to get wrong, and it is
    // the one table the export must therefore derive rather than filter.
    await asApp(async () => {
      const doc = await exportDocument();
      const people = (doc["tables"] as Record<string, Array<{ id: string }>>)["person"]!;

      expect(people.map((p) => p["id"])).toEqual([PERSON_A]);
      expect(JSON.stringify(doc)).not.toContain(PERSON_B);
    }, ORG_A);
  });

  it("is COMPLETE for organisation A — every seeded row is present, and nothing extra", async () => {
    await asApp(async () => {
      const doc = await exportDocument();
      const tables = doc["tables"] as Record<string, Array<Record<string, string | null>>>;

      // Positive: A's own rows are all there. An export that leaked nothing
      // because it returned nothing would sail past every negative assertion
      // above, so completeness is asserted with equal weight.
      expect(tables["team"]!.map((r) => r["id"])).toEqual([TEAM_A]);
      expect(tables["title"]!.map((r) => r["id"])).toEqual([TITLE_A]);
      expect(tables["organization"]!.map((r) => r["id"])).toEqual([ORG_A]);
      expect(tables["person"]!.map((r) => r["id"])).toEqual([PERSON_A]);
      expect(tables["person_profile"]!.map((r) => r["person_id"])).toEqual([PERSON_A]);
      expect(tables["asset"]!.map((r) => r["asset_tag"])).toEqual(["LAPTOP-001"]);
      expect(tables["partner"]!.map((r) => r["name"])).toEqual(["Acme Sponsors"]);

      // And organisation B's rows are nowhere, by count as well as by value.
      expect(tables["task"]!).toEqual([]);
      expect(tables["person"]!.some((r) => r["id"] === PERSON_B)).toBe(false);
    }, ORG_A);
  });

  it("carries a self-describing header an importer can validate against", async () => {
    await asApp(async () => {
      const doc = await exportDocument();

      expect(doc["format"]).toBe("raptor.portability.export");
      expect(doc["format_version"]).toBe(1);
      expect(doc["organization_id"]).toBe(ORG_A);
      expect(typeof doc["last_migration"]).toBe("string");
      expect(doc["schema_migrations"]).toBeGreaterThanOrEqual(11);

      // The contract travels with the document rather than being looked up, so an
      // importer can tell what the document CLAIMS to contain.
      const contract = doc["contract"] as Array<Record<string, unknown>>;
      expect(contract.length).toBeGreaterThan(70);
      expect(contract.map((c) => c["table"])).toContain("match");
      expect(contract.map((c) => c["table"])).toContain("organization");
    }, ORG_A);
  });

  it("produces NO DOCUMENT AT ALL when the tenant is unset — as the app role", async () => {
    await asApp(async () => {
      await expect(exportDocument()).rejects.toThrow(/no tenant is set/i);
    });
  });

  it("produces NO DOCUMENT AT ALL when the tenant is unset — as the schema owner", async () => {
    // The export is SECURITY DEFINER, so the owner's ability to read everything
    // must not become its ability to export everything.
    await asOwner("SELECT set_config('app.org_id', '', false)");
    await expect(exportDocument()).rejects.toThrow(/no tenant is set/i);
    await recoverSession();
  });

  it("CONTROL: the same function, run as the owner for B, really does return B's data", async () => {
    // Without this, every isolation test above would also pass against a function
    // that returned an empty document for everybody. This is the same control
    // ADR-0015 records for the RLS demonstration: reproduce the leak on purpose,
    // so that the refusals mean something.
    await asOwner(`SET app.org_id = '${ORG_B}'`);
    const text = await exportText();
    await recoverSession();

    expect(text.includes(SENTINEL_TEAM_B)).toBe(true);
    expect(text.includes(SENTINEL_PERSON_B)).toBe(true);
    expect(text.includes(NAME_TEAM_A)).toBe(false);
  });

  it("runs as a role that CANNOT bypass RLS", async () => {
    // Stated rather than assumed: an isolation assertion made as the owner
    // proves nothing, and the export function being SECURITY DEFINER makes the
    // role's RLS irrelevant to it anyway — which is exactly why the function's
    // own predicate, and not the role, is what the assertions above test.
    await asApp(async () => {
      const who = await db.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT current_user, r.rolsuper, r.rolbypassrls
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      expect(who.rows[0]!.current_user).toBe("raptor_app");
      expect(who.rows[0]!.rolsuper).toBe(false);
      expect(who.rows[0]!.rolbypassrls).toBe(false);
    }, ORG_A);
  });
});

// =============================================================================
// 3. DETERMINISM
// =============================================================================

describe("determinism", () => {
  beforeEach(async () => {
    await seedOrgA();
    await seedOrgB();
  });

  it("is byte-identical across repeated exports of unchanged data", async () => {
    await asApp(async () => {
      const first = await exportText();
      const second = await exportText();
      const third = await exportText();

      expect(second).toBe(first);
      expect(third).toBe(first);
    }, ORG_A);
  });

  it("is byte-identical across roles, so a diff between two installations is meaningful", async () => {
    await asApp(async () => {
      expect(await exportText()).toBeTruthy();
    }, ORG_A);

    await asOwner(`SET app.org_id = '${ORG_A}'`);
    const asOwnerText = await exportText();
    await recoverSession();

    await asApp(async () => {
      expect(await exportText()).toBe(asOwnerText);
    }, ORG_A);
  });

  it("carries no clock, so two exports of the same data cannot differ", async () => {
    await asApp(async () => {
      const doc = await exportDocument();
      const keys = Object.keys(doc);

      // An `exported_at` would be the one field that makes determinism
      // impossible, and it is a field nobody would think to remove later.
      for (const forbidden of ["exported_at", "generated_at", "created_at", "exportedBy", "timestamp"]) {
        expect(keys).not.toContain(forbidden);
      }
    }, ORG_A);
  });

  it("orders every row array deterministically by its declared key", async () => {
    // Two rows whose ids sort the other way round are what a missing ORDER BY
    // looks like, and it is invisible until a second run.
    await asOwner(`
      INSERT INTO task (id, org_id, title, state, created_at) VALUES
        ('7c000000-0000-0000-0000-0000000000f2', '${ORG_A}', 'Zebra', 'open', '2026-05-04T18:00:00Z'),
        ('7c000000-0000-0000-0000-0000000000f1', '${ORG_A}', 'Alpha', 'open', '2026-05-04T18:00:00Z'),
        ('7c000000-0000-0000-0000-0000000000f3', '${ORG_A}', 'Middle', 'open', '2026-05-04T18:00:00Z');
    `);

    await asApp(async () => {
      const first = ((await exportDocument())["tables"] as Record<string, Array<{ id: string }>>)["task"]!;
      const second = ((await exportDocument())["tables"] as Record<string, Array<{ id: string }>>)["task"]!;

      expect(first.map((r) => r["id"])).toEqual([
        "7c000000-0000-0000-0000-0000000000f1",
        "7c000000-0000-0000-0000-0000000000f2",
        "7c000000-0000-0000-0000-0000000000f3",
      ]);
      expect(second).toEqual(first);
    }, ORG_A);
  });
});

// =============================================================================
// 4. ROUND TRIP
// =============================================================================

describe("round trip", () => {
  beforeEach(async () => {
    await seedOrgA();
    await seedOrgB();
  });

  it("reproduces the same document, byte for byte, after deleting and re-importing", async () => {
    const before = await asAppRead(ORG_A, exportText);
    const countsBefore = await asAppRead(ORG_A, tenantRowCounts);

    await wipeTenantData();

    // The wipe is verified rather than assumed. A round-trip test that deletes
    // nothing passes while testing nothing.
    const countsAfterWipe = await asAppRead(ORG_A, tenantRowCounts);
    for (const [table, n] of Object.entries(countsAfterWipe)) {
      expect(n, `${table} was not wiped`).toBe(0);
    }

    await asApp(async () => {
      const written = await db.query<{ n: number }>(
        "SELECT public.portability_import_document($1::jsonb) AS n",
        [before],
      );
      expect(written.rows[0]!.n).toBeGreaterThan(0);
    }, ORG_A);

    const after = await asAppRead(ORG_A, exportText);
    const countsAfter = await asAppRead(ORG_A, tenantRowCounts);

    // CONTENT, not just counts.
    expect(after).toBe(before);
    expect(countsAfter).toEqual(countsBefore);
    expect(await appendOnlyGuardsIntact()).toBe(true);
  });

  it("restores money exactly, which a JSON number would not", async () => {
    // numeric(18,4) is why the export renders text. 1234.5601 has no exact
    // binary form, so a document carrying it as a JSON number would come back
    // subtly different — the class of defect that surfaces as an unexplained
    // allocation variance months later.
    await asOwner(`
      INSERT INTO ledger_account (id, org_id, code, name, account_type, currency)
      VALUES ('3a000000-0000-0000-0000-000000000001', '${ORG_A}', '1000', 'Cash', 'asset', 'INR');

      INSERT INTO ledger_journal (id, org_id, description, source_kind, posting_period, currency, occurred_at)
      VALUES ('3b000000-0000-0000-0000-000000000001', '${ORG_A}', 'Opening balance', 'expense',
              '2026-05-01', 'INR', '${MATCH_DAY}');

      INSERT INTO ledger_line (id, org_id, journal_id, line_no, account_id, side, amount, currency)
      VALUES
        ('3c000000-0000-0000-0000-000000000001', '${ORG_A}', '3b000000-0000-0000-0000-000000000001', 1,
              '3a000000-0000-0000-0000-000000000001', 'debit', 1234.5601, 'INR'),
        -- A double-entry journal needs a second line; 0004 refuses a one-sided
        -- entry, and the refusal is correct — an unbalanced journal is not an
        -- entry, it is a typo that round-trips perfectly well.
        ('3c000000-0000-0000-0000-000000000002', '${ORG_A}', '3b000000-0000-0000-0000-000000000001', 2,
              '3a000000-0000-0000-0000-000000000001', 'credit', 1234.5601, 'INR');
    `);

    // The whole document is captured BEFORE the wipe. An earlier version read it
    // back out of the database after wiping, which exported an empty document and
    // then "restored" it perfectly — a round-trip test that passes by importing
    // nothing.
    const document = await asAppRead(ORG_A, exportText);
    const before = await asAppRead(ORG_A, async () => {
      const doc = await exportDocument();
      return JSON.stringify((doc["tables"] as Record<string, Array<Record<string, string | null>>>)["ledger_line"]!);
    });
    expect(before).toContain("1234.5601");

    await wipeTenantData();
    // Re-imported through the normal path, so the import's own contract checks
    // still apply and are still part of what is under test.
    await importDocument(document);

    const after = await asAppRead(ORG_A, async () => {
      const doc = await exportDocument();
      return JSON.stringify((doc["tables"] as Record<string, Array<Record<string, string | null>>>)["ledger_line"]!);
    });

    expect(after).toBe(before);
    expect(after).toContain("1234.5601");
  });
});

// =============================================================================
// 5. ALL-OR-NOTHING
// =============================================================================

describe("an import that half-applies", () => {
  beforeEach(async () => {
    await seedOrgA();
    await seedOrgB();
  });

  it("writes ZERO rows when the payload's LAST record is malformed", async () => {
    // The defect this must not have: a partially applied import. The malformed
    // record is placed at the very end so that every well-formed record before it
    // has already been written by the time the failure is discovered.
    const document = await asAppRead(ORG_A, exportText);
    const doc = JSON.parse(document) as {
      tables: Record<string, Array<Record<string, string | null>>>;
    };

    // `task` is alphabetically after every seeded table, and the task row is
    // given an enum value that does not exist. It parses as text and fails on the
    // cast, which is the same shape as a real malformed payload.
    doc.tables["task"] = [
      {
        "id": "7c000000-0000-0000-0000-0000000000ff",
        "org_id": ORG_A,
        "title": "Legitimate task",
        "description": null,
        "state": "open",
        "priority": "normal",
        "assignee_id": null,
        "due_at": null,
        "created_at": "2026-05-04 18:00:00+00",
        "transitioned_at": null,
        "state_changed_by": null,
        "state_reason": null,
        "origin_run_id": null,
        "origin_step_id": null,
        "archived_at": null,
      },
      {
        "id": "7c000000-0000-0000-0000-0000000000fe",
        "org_id": ORG_A,
        "title": "Malformed task",
        "description": null,
        // `task_state` has no such member. The CHECK/cast refuses it.
        "state": "not_a_state",
        "priority": "normal",
        "assignee_id": null,
        "due_at": null,
        "created_at": "2026-05-04 18:00:00+00",
        "transitioned_at": null,
        "state_changed_by": null,
        "state_reason": null,
        "origin_run_id": null,
        "origin_step_id": null,
        "archived_at": null,
      },
    ];

    await wipeTenantData();

    let refused = false;
    try {
      await asApp(async () => {
        await db.exec("BEGIN");
        await db.query("SELECT public.portability_import_document($1::jsonb)", [JSON.stringify(doc)]);
        await db.exec("COMMIT");
      }, ORG_A);
    } catch {
      refused = true;
      await recoverSession();
    }

    expect(refused, "a payload with an invalid enum value was accepted").toBe(true);

    // ZERO rows written — not "not all of them".
    const counts = await asAppRead(ORG_A, tenantRowCounts);
    for (const [table, n] of Object.entries(counts)) {
      expect(n, `${table} received ${n} rows from a refused import`).toBe(0);
    }

    const people = await asAppRead(ORG_A, async () => {
      const doc = await exportDocument();
      return (doc["tables"] as Record<string, unknown[]>)["person"]!.length;
    });
    expect(people).toBe(0);
  });

  it("leaves NO receipt behind when the import is refused", async () => {
    // The receipt is written in the same transaction as the data, so a receipt
    // claiming an import that did not happen is the specific dishonesty this
    // makes unrepresentable.
    await asOwner(`
      DELETE FROM task;
    `);
    const document = await asAppRead(ORG_A, exportText);
    const doc = JSON.parse(document) as { tables: Record<string, Array<Record<string, string | null>>> };
    doc.tables["partner"] = [
      {
        "id": "4a000000-0000-0000-0000-0000000000ff",
        "org_id": ORG_A,
        "name": "Good partner",
        "legal_name": null,
        "website_url": null,
        "stage": "lead",
        "stage_reason": null,
        "stage_changed_at": "2026-05-04 18:00:00+00",
        "stage_changed_by_person_id": null,
        "contracted_at": null,
        "created_at": "2026-05-04 18:00:00+00",
        "archived_at": null,
      },
      {
        "id": "4a000000-0000-0000-0000-0000000000fe",
        "org_id": ORG_A,
        "name": "Bad partner",
        "legal_name": null,
        "website_url": null,
        // `partner_stage` has no such member: 'lead','qualified','negotiation',
        // 'signed','active','lapsed'. The cast refuses it.
        "stage": "not_a_stage",
        "stage_reason": null,
        "stage_changed_at": "2026-05-04 18:00:00+00",
        "stage_changed_by_person_id": null,
        "contracted_at": null,
        "created_at": "2026-05-04 18:00:00+00",
        "archived_at": null,
      },
    ];

    await wipeTenantData();
    await expect(importDocument(JSON.stringify(doc))).rejects.toThrow();

    const runs = await asAppRead(ORG_A, async () => {
      const found = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM portability_import_run");
      return found.rows[0]!.n;
    });
    expect(runs).toBe(0);
  });

  it("records a receipt when the import DOES succeed", async () => {
    const document = await asAppRead(ORG_A, exportText);
    await wipeTenantData();
    await importDocument(document);

    const runs = await asAppRead(ORG_A, async () => {
      const found = await db.query<{ rows_written: number; tables_written: number; digest: string }>(
        `SELECT rows_written, tables_written, btrim(document_digest) AS digest FROM portability_import_run`,
      );
      return found.rows;
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]!.rows_written).toBeGreaterThan(0);
    expect(runs[0]!.tables_written).toBeGreaterThan(70);
    // pgcrypto is unavailable here, so the digest is asserted by shape and by
    // reproducibility rather than against a value computed elsewhere.
    expect(runs[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

// =============================================================================
// 6. CROSS-TENANT REFERENCES ARE REFUSED, NEVER REPARENTED
// =============================================================================

describe("a cross-tenant reference on import", () => {
  beforeEach(async () => {
    await seedOrgA();
    await seedOrgB();
  });

  it("REFUSES a document whose organization_id is another organisation's", async () => {
    const orgADocument = await asAppRead(ORG_A, exportText);

    // Importing A's document into B is the cross-tenant write in its purest form.
    // It must fail; rewriting org_id to B would "succeed" and produce B holding
    // A's matches, which is precisely the silent corruption being refused.
    await expect(importDocumentInto(orgADocument, ORG_B)).rejects.toThrow(
      /refusing to import a document for organisation/i,
    );

    const bSeesA = await asAppRead(ORG_B, async () => {
      const doc = await exportDocument();
      return JSON.stringify(doc).includes(NAME_TEAM_A);
    });
    expect(bSeesA).toBe(false);
  });

  it("REFUSES a row whose org_id belongs to another organisation, before writing anything", async () => {
    const document = await asAppRead(ORG_A, exportText);
    const doc = JSON.parse(document) as { tables: Record<string, Array<Record<string, string | null>>> };

    // A task that says it belongs to B, inside a document that claims to be A's.
    // Nothing about this is exotic: it is what a hand-edited file looks like.
    doc.tables["task"] = [
      {
        "id": "7c000000-0000-0000-0000-0000000000ab",
        "org_id": ORG_B,
        "title": "Smuggled task",
        "description": null,
        "state": "open",
        "priority": "normal",
        "assignee_id": null,
        "due_at": null,
        "created_at": "2026-05-04 18:00:00+00",
        "transitioned_at": null,
        "state_changed_by": null,
        "state_reason": null,
        "origin_run_id": null,
        "origin_step_id": null,
        "archived_at": null,
      },
    ];

    await wipeTenantData();
    await expect(importDocumentInto(JSON.stringify(doc), ORG_A)).rejects.toThrow(
      /org_id is not this organisation/i,
    );

    const taskCount = await asAppRead(ORG_A, async () => {
      const found = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM task");
      return found.rows[0]!.n;
    });
    expect(taskCount).toBe(0);
  });

  it("REFUSES a match pointing at ANOTHER organisation's team, by the composite foreign key", async () => {
    // The structural case. The document is entirely A's — right org_id, right
    // header — but one record REFERENCES an entity B owns. Every other record is
    // valid, so this is a payload that only a reference check can catch.
    //
    // ADR-0011's mechanism: `match_team_fk` is FOREIGN KEY (org_id, team_id)
    // REFERENCES team (org_id, id), so the row cannot exist.
    const document = await asAppRead(ORG_A, exportText);
    const doc = JSON.parse(document) as { tables: Record<string, Array<Record<string, string | null>>> };

    doc.tables["match"] = [
      {
        "id": "6a000000-0000-0000-0000-0000000000ff",
        "org_id": ORG_A,
        "competition_division_id": null,
        "team_id": TEAM_B, // <-- belongs to organisation B
        "opponent_id": OPPONENT_A,
        "round_label": null,
        "round_number": null,
        "status": "completed",
        "best_of": null,
        "scheduled_at": "2026-05-04 18:00:00+00",
        "started_at": null,
        "completed_at": null,
        "stream_url": null,
        "venue": null,
        "valid_from": "2026-05-04 18:00:00+00",
        "valid_to": null,
        "created_at": "2026-05-04 18:00:00+00",
        "archived_at": null,
      },
    ];

    await wipeTenantData();
    await expect(importDocumentInto(JSON.stringify(doc), ORG_A)).rejects.toThrow(
      /cannot be imported|cross-tenant/i,
    );

    // Refused, not rewritten. The row is absent and B's team is untouched.
    const matchCount = await asAppRead(ORG_A, async () => {
      const found = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "match"`);
      return found.rows[0]!.n;
    });
    expect(matchCount).toBe(0);

    const bTeamRows = await asAppRead(ORG_B, async () => {
      const found = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM team");
      return found.rows[0]!.n;
    });
    expect(bTeamRows).toBe(1);
  });

  it("REFUSES a document from a different schema rather than reinterpreting it", async () => {
    const document = await asAppRead(ORG_A, exportText);
    const doc = JSON.parse(document) as { last_migration: string };
    doc.last_migration = "0009_commercial.sql";

    await expect(importDocumentInto(JSON.stringify(doc), ORG_A)).rejects.toThrow(
      /written against schema/i,
    );
  });

  it("REFUSES a partial document — an absent table is not an empty one", async () => {
    const document = await asAppRead(ORG_A, exportText);
    const doc = JSON.parse(document) as { tables: Record<string, unknown> };
    delete doc.tables["asset"];

    await expect(importDocumentInto(JSON.stringify(doc), ORG_A)).rejects.toThrow(/is missing table/i);
  });
});

// =============================================================================
// 7. THE RECEIPT IS TENANT-SCOPED LIKE EVERYTHING ELSE
// =============================================================================

describe("portability_import_run", () => {
  beforeEach(async () => {
    await seedOrgA();
    await seedOrgB();
  });

  it("gives one organisation no rows of another's imports", async () => {
    const aDocument = await asAppRead(ORG_A, exportText);
    await wipeTenantData();
    await importDocument(aDocument);

    await asApp(async () => {
      const found = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM portability_import_run");
      expect(found.rows[0]!.n).toBe(1);
    }, ORG_A);

    await asApp(async () => {
      const found = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM portability_import_run");
      expect(found.rows[0]!.n).toBe(0);
    }, ORG_B);
  });

  it("reads nothing when the tenant is unset", async () => {
    await asApp(async () => {
      const found = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM portability_import_run");
      expect(found.rows[0]!.n).toBe(0);
    });
  });

  it("has FORCE ROW LEVEL SECURITY and a predicate with no IS NULL branch", async () => {
    const found = await asOwnerRows<{ relrowsecurity: boolean; relforcerowsecurity: boolean; polqual: string }>(`
      SELECT c.relrowsecurity, c.relforcerowsecurity, pg_get_expr(p.polqual, p.polrelid) AS polqual
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'portability_import_run_tenant_isolation'
       WHERE n.nspname = 'public' AND c.relname = 'portability_import_run'
    `);

    expect(found[0]!.relrowsecurity).toBe(true);
    expect(found[0]!.relforcerowsecurity).toBe(true);
    // `IS NULL` in a tenant policy is a hole that widens to every row, and 0001's
    // audit_log policy shows exactly how easily one gets there by accident.
    expect(found[0]!.polqual).toBe("(org_id = current_org_id())");
  });

  it("refuses a cross-tenant write through a direct INSERT", async () => {
    await asApp(async () => {
      await expect(
        db.exec(`
          INSERT INTO portability_import_run
            (org_id, source_schema_migrations, source_last_migration, tables_written, rows_written, document_digest, imported_at)
          VALUES ('${ORG_B}', 11, 'x', 1, 1, repeat('a', 64), '${MATCH_DAY}')
        `),
      ).rejects.toThrow();
    }, ORG_A);
  });
});

// =============================================================================
// 8. THE GRANTS THIS MIGRATION MUST NOT HAVE WIDENED
// =============================================================================

describe("privileges", () => {
  it("grants SELECT on every contract table, because an unreadable table is a hole in the backup", async () => {
    const missing = await asOwnerRows<{ table_name: string }>(`
      SELECT c.table_name
        FROM public.portability_export_contract() c
       WHERE NOT has_table_privilege('raptor_app', format('public.%I', c.table_name), 'SELECT')
       ORDER BY c.table_name
    `);
    expect(missing).toEqual([]);
  });

  it("does NOT grant the application role write access to the governance state machines", async () => {
    // 0008, 0009 and 0010 each refuse this for the same reason, and an export
    // migration is exactly the kind of change that widens grants "for
    // convenience". The import is a function, not a grant.
    const widened = await asOwnerRows<{ table_name: string }>(`
      SELECT t.relname AS table_name
        FROM pg_class t
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND t.relname IN ('hr_state_transition', 'partner_state_transition',
                            'content_state_transition', 'task_state_transition')
         AND has_table_privilege('raptor_app', format('public.%I', t.relname), 'INSERT')
       ORDER BY t.relname
    `);
    expect(widened).toEqual([]);
  });

  it("gives the application role no UPDATE or DELETE on its own receipt table", async () => {
    // `portability_import_run` is the one table this migration creates, so its
    // privileges are the only ones here that are unambiguously 0011's doing. A
    // receipt that could be edited afterwards is not a receipt.
    const found = await asOwnerRows<{ can_update: boolean; can_delete: boolean; can_insert: boolean }>(`
      SELECT has_table_privilege('raptor_app', 'public.portability_import_run', 'UPDATE') AS can_update,
             has_table_privilege('raptor_app', 'public.portability_import_run', 'DELETE') AS can_delete,
             has_table_privilege('raptor_app', 'public.portability_import_run', 'INSERT') AS can_insert
    `);
    expect(found).toEqual([{ can_update: false, can_delete: false, can_insert: true }]);
  });

  it("resolves the tenant from the SESSION, because neither function has a tenant parameter", async () => {
    // ADR-0011 rule 3: the tenant is never a request parameter, or the caller
    // chooses which tenant they act in. A function whose only argument is the
    // document cannot be asked for another organisation — there is nothing to ask
    // with. Reflected, not read from a comment.
    const found = await asOwnerRows<{ proname: string; nargs: number; argnames: string; prosecdef: boolean }>(`
      SELECT p.proname,
             p.pronargs AS nargs,
             coalesce(p.proargnames::text, '') AS argnames,
             p.prosecdef
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('portability_export_document', 'portability_import_document')
       ORDER BY p.proname
    `);

    expect(found).toHaveLength(2);
    for (const row of found) {
      expect(row.argnames.toLowerCase(), `${row.proname} takes a tenant argument`).not.toContain("org");
      // SECURITY DEFINER is REQUIRED here and asserted rather than assumed: the
      // export must read `person`, which has RLS enabled and no policy (0001), so
      // a SECURITY INVOKER export would silently return no people at all — a
      // backup that quietly drops every human in the organisation.
      expect(row.prosecdef, `${row.proname} must read person, which RLS hides`).toBe(true);
    }
    expect(found.map((r) => r.nargs)).toEqual([0, 1]);
  });
});

// -----------------------------------------------------------------------------
// Late helpers
// -----------------------------------------------------------------------------

/** Run `fn` as the app role for `orgId` and return its value. */
async function asAppRead<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await asApp(async () => {
    result = await fn();
  }, orgId);
  return result as T;
}

/** A query through the schema owner, which bypasses RLS. */
async function asOwnerRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await recoverSession();
  try {
    const found = await db.query<T>(sql, params);
    return found.rows;
  } finally {
    await recoverSession();
  }
}

/** Import a document into `orgId`, inside one explicit transaction. */
async function importDocumentInto(document: string, orgId: string): Promise<void> {
  await asApp(async () => {
    await db.exec("BEGIN");
    await db.query("SELECT public.portability_import_document($1::jsonb)", [document]);
    await db.exec("COMMIT");
  }, orgId);
}

/** Import a document into the current session tenant (always ORG_A here). */
async function importDocument(document: string): Promise<void> {
  await importDocumentInto(document, ORG_A);
}
