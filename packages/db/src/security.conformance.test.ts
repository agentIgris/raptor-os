/**
 * Schema conformance — rules that must hold for EVERY migration, now and later.
 *
 * These are the rules the security review showed the suite was missing. Each one
 * exists because a specific defect got past a green build, and each one is
 * therefore stated as a rule over the CATALOGUE rather than as a check of a
 * hand-maintained list of things somebody remembered to add.
 *
 * WHY A LIST IS NOT A RULE
 * ------------------------
 * `operations.isolation.test.ts` had a test called "makes every FK BETWEEN TENANT
 * TABLES composite and include org_id". It was scoped to `OPERATIONS_TABLES` —
 * the tables migration 0010 happened to create. All four authorisation tables from
 * 0001 sat outside that list, so `role_assignment`'s single-column
 * `REFERENCES role(id)` passed that test on every run for as long as it existed.
 * CRITICAL-1 shipped with 444 green tests.
 *
 * A conformance test that only checks the tables it already knows about reads as
 * coverage, is believed to be coverage, and is worse than no test at all: it
 * converts a known gap into an assumed guarantee. So everything below is derived
 * from `pg_attribute`, `pg_class`, `pg_policy` and `pg_proc`, and a new migration
 * is in scope the moment it creates the object, with nobody editing a list.
 *
 * THE THREE RULES
 * ---------------
 *  1. No SECURITY DEFINER function in `public` is executable by PUBLIC.
 *     0011 granted EXECUTE to `raptor_app` for seven functions and revoked from
 *     PUBLIC for none of them, leaving three SECURITY DEFINER elevations on the
 *     grant PostgreSQL makes by default. Nine migrations before it, every one
 *     carried the REVOKE. Nothing checked.
 *  2. Every tenant-owned table has RLS ENABLED and FORCED.
 *     `organization` had neither while `raptor_app` held full DML on it.
 *  3. No RLS policy reaches a NULL-organisation row unless it is scoped to a
 *     NAMED role. `USING (org_id IS NULL OR ...)` is how a tenant reads — and
 *     forges — rows belonging to the installation. The branch is legitimate for
 *     a system actor; what was missing was anything deciding who that is.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migrateUp } from "./migrations.js";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await migrateUp(db);
});

// =============================================================================
// RULE 1 — NO SECURITY DEFINER FUNCTION IS EXECUTABLE BY PUBLIC
// =============================================================================

describe("no SECURITY DEFINER function is executable by PUBLIC", () => {
  it("holds for every function in the schema, whatever migration added it", async () => {
    // The whole point of this assertion is that it does not care which migration
    // wrote the function or which domain it belongs to. A migration that adds a
    // SECURITY DEFINER function and forgets the REVOKE fails here, with the
    // function named, instead of shipping.
    const found = await db.query<{ proname: string; args: string }>(`
      SELECT p.proname,
             pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prosecdef
         AND has_function_privilege('public', p.oid, 'EXECUTE')
       ORDER BY p.proname, args
    `);

    expect(
      found.rows.map((r) => `${r.proname}(${r.args})`),
      "every SECURITY DEFINER function must carry REVOKE ... FROM PUBLIC; PostgreSQL " +
        "grants EXECUTE to PUBLIC by default, so an omitted REVOKE is an open door",
    ).toEqual([]);
  });

  it("is not vacuous: the schema really does have SECURITY DEFINER functions", async () => {
    // A rule that passes because it matched nothing is not a rule. The schema has
    // dozens of them — guard triggers, seeding functions, the portability trio —
    // and this asserts the set is large enough for the rule above to mean
    // something.
    const found = await db.query<{ n: number }>(`
      SELECT count(*)::int AS n
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
    `);
    expect(found.rows[0]!.n).toBeGreaterThan(30);
  });

  it("leaves the tenant role able to execute the functions that are meant for it", async () => {
    // The other direction, because revoking from PUBLIC without granting to the
    // intended role would satisfy the rule above perfectly while breaking the
    // product. Named rather than counted, so a lost grant is named in the failure.
    const expected: Record<string, boolean> = {
      portability_export_document: true,
      portability_import_document: true,
      portability_person_closure: true,
      provision_organization: true,
      publish_content_to_public_site: true,
      public_site_content: false, // raptor_public's, not the tenant's
    };

    const found = await db.query<{ proname: string; app_exec: boolean }>(`
      SELECT p.proname,
             has_function_privilege('raptor_app', p.oid, 'EXECUTE') AS app_exec
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = ANY($1)
       ORDER BY p.proname
    `, [Object.keys(expected)]);

    const actual = Object.fromEntries(found.rows.map((r) => [r.proname, r.app_exec]));
    expect(actual).toEqual(expected);
  });

  it("keeps every SECURITY DEFINER function's search_path pinned", async () => {
    // Same class of omission, same place. A SECURITY DEFINER function that does
    // not pin `search_path` resolves its own names through whoever is calling it,
    // which is how an unqualified table reference becomes another schema's table.
    // Every function in this schema sets it; the assertion exists so the next one
    // cannot skip it.
    const found = await db.query<{ proname: string; config: string[] }>(`
      SELECT p.proname, coalesce(p.proconfig, ARRAY[]::text[]) AS config
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
       ORDER BY p.proname
    `);

    const unpinned = found.rows
      .filter((r) => !r.config.some((c) => c.replace(/\s/g, "").startsWith("search_path=")))
      .map((r) => r.proname);

    expect(unpinned, "SECURITY DEFINER functions must pin search_path").toEqual([]);
  });
});

// =============================================================================
// RULE 2 — EVERY TENANT-OWNED TABLE HAS RLS ENABLED AND FORCED
// =============================================================================

describe("every tenant-scoped table has row level security enabled and forced", () => {
  /**
   * The one documented exception, named rather than allowed by omission.
   *
   * `public_site_publication` is the public projection of published content. 0009
   * gives it NO RLS policy deliberately and records why in a COMMENT ON TABLE: it
   * is "the ONLY table read without a tenant filter", and its safety is STRUCTURAL
   * rather than enforced — seven vetted columns, no person, no money, no
   * obligation, no partner, and a single session-scoped writer. An RLS policy here
   * would break the public site, which addresses an organisation by SLUG with no
   * tenant in the session at all.
   *
   * The risk of an exception is that it outlives its reasoning, so the tests below
   * assert the exception's PRECONDITIONS rather than just exempting the name. If a
   * future migration adds a ninth column carrying something sensitive, or grants
   * UPDATE to a second writer, the exemption stops passing and the rule applies.
   */
  const NO_POLICY_BY_DECISION = ["public_site_publication"] as const;

  it("holds for every table carrying org_id NOT NULL — and for the tenant root", async () => {
    // `organization` had `relrowsecurity = false` while 0001 granted `raptor_app`
    // SELECT, INSERT, UPDATE and DELETE on it, which is why CRITICAL-2 was
    // possible at all.
    //
    // AND THE OBVIOUS DERIVATION MISSES IT, which is worth recording because the
    // first version of this test did exactly that and PASSED on the broken schema.
    // "A tenant-owned table is one with `org_id NOT NULL`" is true of every table
    // EXCEPT the tenant root, which has no `org_id` column at all — its `id` IS the
    // tenant id. So the rule derived from pg_attribute excluded precisely the
    // table the rule exists to catch, and reported green while every tenant could
    // still read and close every other tenant's organisation.
    //
    // The tenant root is therefore identified STRUCTURALLY rather than by name:
    // it is the table that tenant tables reference on their `org_id` column. No
    // table is referred to as `person_id` or `permission_id` in that position, so
    // this derives exactly one table — and it is the one that was unhardened.
    const found = await db.query<{ relname: string; enabled: boolean; forced: boolean }>(`
      WITH tenant_root AS (
        SELECT DISTINCT parent.relname
          FROM pg_constraint k
          JOIN pg_class parent ON parent.oid = k.confrelid
          JOIN pg_class child  ON child.oid  = k.conrelid
          JOIN pg_attribute a ON a.attrelid = child.oid AND a.attnum = k.conkey[1]
         WHERE k.contype = 'f' AND a.attname = 'org_id'
      )
      SELECT c.relname,
             c.relrowsecurity       AS enabled,
             c.relforcerowsecurity  AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND (
              EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'org_id'
                         AND a.attnum > 0 AND a.attnotnull)
           OR c.relname IN (SELECT relname FROM tenant_root)
         )
       ORDER BY c.relname
    `);

    expect(found.rows.length, "the tenant-scoped set must not be empty").toBeGreaterThan(75);

    const exempt = new Set<string>(NO_POLICY_BY_DECISION);
    expect(
      found.rows
        .filter((r) => exempt.has(r.relname))
        .map((r) => `${r.relname} (enabled=${r.enabled}, forced=${r.forced})`),
      "public_site_publication is exempt from RLS entirely, not merely from having a policy",
    ).toEqual(["public_site_publication (enabled=false, forced=false)"]);

    expect(
      found.rows
        .filter((r) => !exempt.has(r.relname) && (!r.enabled || !r.forced))
        .map((r) => `${r.relname} (enabled=${r.enabled}, forced=${r.forced})`),
      "every tenant-scoped table must have RLS ENABLED and FORCED — without FORCE " +
        "the table owner is not subject to the policy",
    ).toEqual([]);
  });

  it("gives every tenant-scoped table a policy, except the one exception whose reasoning still holds", async () => {
    // RLS with no policy denies everything, which is safe but is almost never what
    // a tenant table is for. `person`, `identity`, `person_profile`,
    // `consent_record` and `guardian_consent` are not in this set: they carry a
    // NULLABLE org_id or no org_id at all, and 0001 enables RLS on them precisely
    // so they are closed to anonymous access and gates them through membership in
    // the service layer instead.
    const found = await db.query<{ relname: string }>(`
      WITH tenant_root AS (
        SELECT DISTINCT parent.relname
          FROM pg_constraint k
          JOIN pg_class parent ON parent.oid = k.confrelid
          JOIN pg_class child  ON child.oid  = k.conrelid
          JOIN pg_attribute a ON a.attrelid = child.oid AND a.attnum = k.conkey[1]
         WHERE k.contype = 'f' AND a.attname = 'org_id'
      ),
      tenant_scoped AS (
        SELECT c.oid, c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND (
                EXISTS (SELECT 1 FROM pg_attribute a
                         WHERE a.attrelid = c.oid AND a.attname = 'org_id'
                           AND a.attnum > 0 AND a.attnotnull)
             OR c.relname IN (SELECT relname FROM tenant_root)
           )
      )
      SELECT t.relname
        FROM tenant_scoped t
        LEFT JOIN pg_policy p ON p.polrelid = t.oid
       GROUP BY t.relname
        HAVING count(p.oid) = 0
       ORDER BY t.relname
    `);

    expect(
      found.rows.map((r) => r.relname),
      "a tenant-scoped table with RLS enabled and no policy denies every row, " +
        "including its own tenant's",
    ).toEqual([...NO_POLICY_BY_DECISION]);
  });

  it("keeps the public_site_publication exception safe, by asserting WHY it is an exception", async () => {
    // If the reasoning in 0009 stops holding, the exemption must stop applying.
    // Three preconditions, all structural rather than conventional:
    //
    //  1. The column list is still the seven vetted ones. A `legal_name` or an
    //     `org_id`-free `body` typed by an operator would turn an intentionally
    //     narrow public projection into a tenant table with no tenant filter.
    //  2. Only `raptor_public` and `raptor_app` may READ it, and NO role may write
    //     it by grant — the projection is append-only, written by one SECURITY
    //     DEFINER publisher rather than by a request handler. `raptor_app`
    //     reading it is correct: a tenant that is not ACTIVE goes public-dark but
    //     still reads its own published content. The schema owner is excluded BY
    //     NAME because it necessarily holds the privileges that own the table;
    //     what is checked is that nobody ELSE was handed a way to write it.
    //  3. It is still the ONLY unfiltered table. A second one would mean the
    //     exception has stopped being an exception.
    const columns = await db.query<{ attname: string }>(`
      SELECT a.attname
        FROM pg_attribute a
       WHERE a.attrelid = 'public.public_site_publication'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum
    `);
    expect(columns.rows.map((r) => r.attname)).toEqual([
      "id",
      "org_id",
      "content_item_id",
      "creator_handle",
      "title",
      "body",
      "published_at",
    ]);

    const writers = await db.query<{ grantee: string; privilege_type: string }>(`
      SELECT grantee, privilege_type
        FROM information_schema.role_table_grants
       WHERE table_schema = 'public'
         AND table_name = 'public_site_publication'
         AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
         AND grantee <> (SELECT pg_get_userbyid(c.relowner)
                           FROM pg_class c
                          WHERE c.oid = 'public.public_site_publication'::regclass)
       ORDER BY grantee, privilege_type
    `);
    expect(
      writers.rows,
      "the public projection is written by publish_content_to_public_site, not by a grant",
    ).toEqual([]);

    const readers = await db.query<{ grantee: string }>(`
      SELECT grantee
        FROM information_schema.role_table_grants
       WHERE table_schema = 'public'
         AND table_name = 'public_site_publication'
         AND privilege_type = 'SELECT'
         AND grantee <> (SELECT pg_get_userbyid(c.relowner)
                           FROM pg_class c
                          WHERE c.oid = 'public.public_site_publication'::regclass)
       ORDER BY grantee
    `);
    expect(readers.rows.map((r) => r.grantee)).toEqual(["raptor_app", "raptor_public"]);
  });
});

// =============================================================================
// RULE 3 — ONLY A NAMED ROLE REACHES A NULL-ORGANISATION ROW
// =============================================================================

describe("no unqualified policy reaches rows with no organisation", () => {
  it("holds for every policy in the schema", async () => {
    // The HIGH-2 shape, stated as a rule. A policy that mentions `org_id IS NULL`
    // and applies to PUBLIC hands that branch to every tenant in the
    // installation. The branch is legitimate for a system actor, so the rule is
    // not "never write IS NULL" — it is "if you write IS NULL, name the role that
    // is allowed to reach it". A role-qualified policy is what turns a wider scope
    // from a hole into a decision.
    const offenders = await db.query<{ tablename: string; policyname: string; scope: string }>(`
      SELECT c.relname AS tablename,
             p.polname AS policyname,
             CASE WHEN p.polroles = ARRAY[0]::oid[] THEN 'public' ELSE 'scoped' END AS scope
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND p.polqual IS NOT NULL
         AND pg_get_expr(p.polqual, p.polrelid) ~* 'IS[[:space:]]+NULL'
         AND p.polroles = ARRAY[0]::oid[]
       ORDER BY c.relname, p.polname
    `);

    expect(
      offenders.rows,
      "a policy applying to PUBLIC must never contain an IS NULL branch: scope it " +
        "to the role that is supposed to have it, so widening that role's scope " +
        "cannot widen anybody else's",
    ).toEqual([]);
  });

  it("leaves the system scope it did find, so the rule above is not passing by finding nothing", async () => {
    const found = await db.query<{ tablename: string; policyname: string; roles: string[] }>(`
      SELECT c.relname AS tablename,
             p.polname AS policyname,
             p.polroles::regrole[]::text[] AS roles
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND p.polqual IS NOT NULL
         AND pg_get_expr(p.polqual, p.polrelid) ~* 'IS[[:space:]]+NULL'
       ORDER BY c.relname, p.polname
    `);

    // Exactly the two 0013 created, each named to the system role. If this ever
    // returns empty, the rule above has stopped having anything to check and is
    // no longer evidence of anything.
    expect(
      found.rows.map((r) => `${r.tablename}.${r.policyname}`),
    ).toEqual([
      "audit_log.audit_log_system_scope",
      "outbox_event.outbox_event_system_scope",
    ]);
  });

  it("finds no policy whose predicate is `OR true` or an unconditional match", async () => {
    // The other escape hatch, and the one the brief for this migration names
    // explicitly. A predicate that cannot be false is not a policy; it is a
    // comment that RLS is enabled.
    const found = await db.query<{ tablename: string; policyname: string; qual: string }>(`
      SELECT c.relname AS tablename,
             p.polname AS policyname,
             coalesce(pg_get_expr(p.polqual, p.polrelid), '') AS qual
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND p.polqual IS NOT NULL
         AND pg_get_expr(p.polqual, p.polrelid) ~* '(^|[^a-z_])true([^a-z_]|$)'
       ORDER BY c.relname, p.polname
    `);

    expect(
      found.rows.map((r) => `${r.tablename}.${r.policyname}: ${r.qual}`),
      "a policy predicate of `OR true` cannot be false and is not a policy",
    ).toEqual([]);
  });
});

// =============================================================================
// THE LEDGER ITSELF
// =============================================================================

describe("the migration ledger", () => {
  it("records the security migration, and the earlier ones are untouched", async () => {
    // An applied migration is immutable and `migrateUp` enforces that by
    // checksum. Asserting the ledger here means a fix that tried to edit 0011
    // rather than add 0013 would have failed at apply time with a message naming
    // the file — and this assertion makes the shape of the ledger visible rather
    // than incidental.
    const found = await db.query<{ name: string }>(
      "SELECT name FROM schema_migration ORDER BY id",
    );
    const names = found.rows.map((r) => r.name);

    expect(names).toContain("0011_portability.sql");
    expect(names).toContain("0013_security_review.sql");
    expect(names.indexOf("0011_portability.sql")).toBeLessThan(
      names.indexOf("0013_security_review.sql"),
    );
    // 0001-0012 are all present, so the ledger is complete rather than merely
    // containing the newest entry.
    expect(names.filter((n) => /^00(0[1-9]|1[0-2])_/.test(n))).toHaveLength(12);
  });
});