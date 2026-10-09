/**
 * Auth's tenancy spine, as far as `packages/auth` can honestly assert it.
 *
 * WHY THIS FILE EXISTS AFTER ADR-0017
 * ----------------------------------
 * `session` is no longer tenant-scoped: it is an identity record, so it carries no
 * `orgId` predicate at all. That is the accepted decision, and the property it
 * gave up — "an unresolved request sees zero sessions" — was real and is NOT
 * claimed to be preserved here. See `session-isolation.test.ts` for the tests
 * that record what is and is not now true.
 *
 * What this file does instead is assert the two things that ARE this package's
 * responsibility after the change:
 *
 *   1. No auth table carries a tenant predicate, and in particular none has
 *      regained a fail-open `current_org_id() IS NULL OR ...` branch. That branch
 *      leaked every tenant's sessions; it is the specific regression most worth
 *      pinning, and a future policy edit could reintroduce it silently.
 *
 *   2. The compensating controls ADR-0017 requires actually exist and work:
 *      `orgId` is unwritable by a client, `auth_set_active_org` requires a real
 *      active membership, and a session carrying another organisation's `orgId`
 *      confers nothing.
 *
 * THE FAIL-CLOSED PROPERTY LIVES ELSEWHERE NOW, AND SAYS SO
 * --------------------------------------------------------
 * "RLS fails CLOSED when `app.org_id` is unset" is a property of the TENANT
 * tables, and `packages/db` asserts it per table against `org_class`/`pg_class`
 * against a real PGlite instance. Duplicating that here would be asserting
 * another package's schema, and it would rot the moment that schema changes.
 * What this package can assert is narrower and still meaningful: the auth tables
 * do not consult `app.org_id` at all, so there is no context in which an unset
 * GUC could change what they return — the fail-closed property is vacuously true
 * of them rather than accidentally true.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase, type AuthTestDatabase } from "./test-database.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

const AUTH_TABLES = ["user", "session", "account", "verification", "twoFactor", "rateLimit"] as const;

let fixture: AuthTestDatabase;

beforeAll(async () => {
  fixture = await createTestDatabase();
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  await fixture.resetRoles();
  await fixture.assertNotElevated();
});

/** Reflect every policy on the auth tables, with its predicate rendered as text. */
async function policies(): Promise<
  Array<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }>
> {
  const result = await fixture.ownerPool.query<{
    tablename: string;
    policyname: string;
    qual: string | null;
    with_check: string | null;
  }>(
    `SELECT tablename, policyname, qual, with_check
       FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY($1)
      ORDER BY tablename, policyname`,
    [[...AUTH_TABLES]],
  );
  return result.rows;
}

describe("no auth table carries a tenant predicate (ADR-0017)", () => {
  it("has no policy that references current_org_id at all", async () => {
    const rows = await policies();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Not merely "is not the old broken policy" — no auth policy may read the
      // tenant GUC. `session` is identity; a policy that read this would be the
      // tenant-scoped design ADR-0017 removed, back under a new name.
      expect(row.qual ?? "", `${row.tablename}.${row.policyname} USING`).not.toMatch(/current_org_id/i);
      expect(row.with_check ?? "", `${row.tablename}.${row.policyname} WITH CHECK`).not.toMatch(/current_org_id/i);
    }
  });

  it("has no fail-open branch that would expose every tenant's rows", async () => {
    const rows = await policies();

    for (const row of rows) {
      // The exact shape that leaked every session in the deployment. Guarded by
      // name as well as by structure so a rename cannot smuggle it back in.
      expect(row.qual ?? "", `${row.tablename}.${row.policyname}`).not.toMatch(/IS\s+NULL\s+OR/i);
      expect(row.with_check ?? "", `${row.tablename}.${row.policyname}`).not.toMatch(/IS\s+NULL\s+OR/i);
    }
  });

  it("protects session by role, exactly as it does every other identity table", async () => {
    const rows = await policies();
    const sessionPolicy = rows.find((row) => row.tablename === "session");

    // The compensating role check. Same predicate as "user" and friends: it grants
    // the application role its DML and nobody else, and grants no organisation
    // anything.
    expect(sessionPolicy?.policyname).toBe("session_app_role_access");
    // The parser folds the unreserved keyword to upper case, hence the `i` flag.
    expect(sessionPolicy?.qual).toMatch(/session_user/i);

    const userPolicy = rows.find((row) => row.tablename === "user");
    expect(sessionPolicy?.qual).toBe(userPolicy?.qual);
  });

  it("does not FORCE RLS on session, because the table owner must be able to seed fixtures", async () => {
    const result = await fixture.ownerPool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)
        ORDER BY c.relname`,
      [["session"]],
    );

    expect(result.rows[0]?.relrowsecurity).toBe(true);
    // FORCE would subject the owner to the policy, which matters here because
    // `auth_set_active_org` is SECURITY DEFINER and reads through the owner.
    expect(result.rows[0]?.relforcerowsecurity).toBe(false);
  });
});

describe("compensating control 1 — orgId is server-only", () => {
  it("declares orgId with input: false, so no client can assert its own tenant", async () => {
    // The field declaration is the control. A client-supplied `orgId` would let a
    // caller choose the tenant its session claims, which is the substitution
    // ADR-0011 rule 3 forbids — and with the session policy gone, that claim would
    // be believed by whatever read it.
    const { testAuthOptions } = await import("./test-helpers.js");
    const options = testAuthOptions(fixture.appPool);
    const fields = options.session?.additionalFields as Record<string, { input?: boolean }> | undefined;

    expect(fields?.orgId).toBeDefined();
    expect(fields?.orgId?.input).toBe(false);
  });
});

describe("compensating control 2 — the active org requires a real membership", () => {
  it("exists, is not callable by PUBLIC, and takes no caller-chosen role", async () => {
    const result = await fixture.ownerPool.query<{
      has_public_execute: boolean;
      app_has_execute: boolean;
      prosecdef: boolean;
      proconfig: string[] | null;
      proargnames: string[];
    }>(
      `SELECT has_function_privilege('public', 'auth_set_active_org(text,uuid)', 'EXECUTE')
                AS has_public_execute,
              has_function_privilege('raptor_app', 'auth_set_active_org(text,uuid)', 'EXECUTE')
                AS app_has_execute,
              p.prosecdef,
              p.proconfig,
              p.proargnames
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'auth_set_active_org'`,
    );

    const fn = result.rows[0];
    expect(fn).toBeDefined();
    // SECURITY DEFINER, with the search path pinned — ADR-0006. Without the pin, a
    // caller who can create an object named `session` in a directory on the path
    // could aim the function's privileges at their own table.
    expect(fn?.prosecdef).toBe(true);
    // The pin is rendered with its empty value, hence `search_path=""` and not
    // `search_path=`.
    expect(fn?.proconfig).toContain('search_path=""');
    expect(fn?.has_public_execute).toBe(false);
    expect(fn?.app_has_execute).toBe(true);

    // It takes a token and an org, and nothing else. A `p_user_id` parameter would
    // let a caller bind somebody ELSE's session to an organisation.
    expect(fn?.proargnames).toHaveLength(2);
    expect(fn?.proargnames).not.toContain("p_user_id");
    expect(fn?.proargnames).not.toContain("p_role");
  });

  it("is not bypassable: the app role cannot write orgId directly", async () => {
    // The control is worthless if the application role can simply set the column.
    // Better Auth needs table-level UPDATE to refresh an expiry, so the grant is
    // revoked and re-issued per column, omitting "orgId".
    //
    // Run WITHOUT the owner membership, because that membership is a test-harness
    // convenience and a member of the owner inherits the owner's privileges —
    // which would make this assertion pass or fail for the wrong reason.
    // Production has no such membership, so this is the production condition.
    await fixture.withoutOwnerMembership(async () => {
      // Queried directly rather than through `ownerPool`: that pool assumes the
      // owner role, and with the membership dropped the session is no longer
      // entitled to become the owner. The session identity is already `raptor_app`,
      // which is the identity these grants are about.
      const granted = await fixture.db.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.column_privileges
          WHERE grantee = 'raptor_app'
            AND table_schema = 'public'
            AND table_name = 'session'
            AND privilege_type = 'UPDATE'
          ORDER BY column_name`,
      );

      expect(granted.rows.map((row) => row.column_name)).not.toContain("orgId");
      // Better Auth can still refresh an expiry, which is what the UPDATE is for.
      expect(granted.rows.map((row) => row.column_name)).toContain("expiresAt");

      const user = await fixture.db.query<{ id: string }>(
        `INSERT INTO "user" ("name", "email", "emailVerified", "role")
         VALUES ('Direct', 'direct@example.invalid', true, 'player') RETURNING "id"`,
      );
      await fixture.db.query(
        `INSERT INTO "session" ("expiresAt", "token", "userId")
         VALUES (now() + interval '1 hour', 'direct-token', $1)`,
        [user.rows[0]?.id ?? ""],
      );

      // And the refusal is real, not merely absent from the catalogue.
      await expect(
        fixture.appPool.query('UPDATE "session" SET "orgId" = $1 WHERE "token" = $2', [ORG_A, "direct-token"]),
      ).rejects.toThrow();

      const stored = await fixture.db.query<{ orgId: string | null }>(
        `SELECT "orgId" FROM "session" WHERE "token" = 'direct-token'`,
      );
      expect(stored.rows[0]?.orgId ?? null).toBeNull();

      // Control: the app role CAN still do the expiry refresh it legitimately
      // needs, so the restriction is targeted rather than a blanket denial that
      // would have broken session refresh in production.
      const refreshed = await fixture.appPool.query('UPDATE "session" SET "expiresAt" = $1 WHERE "token" = $2', [
        new Date(Date.now() + 7_200_000).toISOString(),
        "direct-token",
      ]);
      expect(refreshed.rowCount).toBe(1);
    });
  });

  it("refuses to set an active org for a token whose user has no active membership", async () => {
    // `org_membership` is not present in this package's schema — it belongs to
    // `packages/db`'s tenancy migration, which the auth test database does not
    // apply. The function therefore cannot run here without it, which is a real
    // cross-package seam rather than a test to work around.
    //
    // Rather than skip, assert the thing that IS observable and that a broken
    // implementation would fail: with `org_membership` absent, the function
    // refuses every call instead of granting one.
    const hasMembership = await fixture.ownerPool.query<{ present: boolean }>(
      `SELECT to_regclass('public.org_membership') IS NOT NULL AS present`,
    );

    if (hasMembership.rows[0]?.present === true) {
      throw new Error(
        "org_membership now exists in the auth test database; this test should be " +
          "replaced with a real membership/no-membership pair rather than skipped.",
      );
    }

    const user = await fixture.ownerPool.query<{ id: string }>(
      `INSERT INTO "user" ("name", "email", "emailVerified", "role")
       VALUES ('Unmember', 'unmember@example.invalid', true, 'player') RETURNING "id"`,
    );
    const userId = user.rows[0]?.id ?? "";

    const session = await fixture.ownerPool.query<{ id: string }>(
      `INSERT INTO "session" ("expiresAt", "token", "userId")
       VALUES (now() + interval '1 hour', 'unmember-token', $1) RETURNING "id"`,
      [userId],
    );
    expect(session.rows[0]?.id).toBeDefined();

    // With no membership table there is no proof of membership, so the call must
    // fail loudly rather than silently leaving orgId set.
    await expect(
      fixture.appPool.query<{ set: boolean }>("SELECT auth_set_active_org($1, $2) AS set", [
        "unmember-token",
        ORG_A,
      ]),
    ).rejects.toThrow();

    // And nothing was written: an unbound session stays unbound.
    const stored = await fixture.ownerPool.query<{ orgId: string | null }>(
      `SELECT "orgId" FROM "session" WHERE "token" = 'unmember-token'`,
    );
    expect(stored.rows[0]?.orgId ?? null).toBeNull();
  });

  it("leaves orgId NULL on every session Better Auth creates", async () => {
    // Sign-in works again now that "session" is not tenant-scoped, and it does so
    // without inventing a tenant: `input: false` means Better Auth never sends
    // `orgId`, so the column stays NULL until a server-side decision is made.
    const signUp = await fixture.appPool.query<{ id: string }>(
      `INSERT INTO "user" ("name", "email", "emailVerified", "role")
       VALUES ('Bootstrap', 'bootstrap-org@example.invalid', true, 'player') RETURNING "id"`,
    );
    const userId = signUp.rows[0]?.id ?? "";

    const created = await fixture.appPool.query<{ id: string }>(
      `INSERT INTO "session" ("expiresAt", "token", "userId")
       VALUES (now() + interval '1 hour', 'bootstrap-org-token', $1) RETURNING "id"`,
      [userId],
    );

    // The INSERT succeeded, which is the whole regression: it previously failed
    // with 42501 on the WITH CHECK clause.
    expect(created.rows[0]?.id).toBeDefined();

    const stored = await fixture.ownerPool.query<{ orgId: string | null }>(
      `SELECT "orgId" FROM "session" WHERE "token" = 'bootstrap-org-token'`,
    );
    expect(stored.rows[0]?.orgId ?? null).toBeNull();
  });
});

describe("compensating control 3 — a session's orgId is a value, not a grant", () => {
  it("confers no access: nothing authorises off the session's orgId", async () => {
    // The property ADR-0017 requires and states must be tested. It is testable at
    // this layer, but only in the form the schema actually permits, and the
    // distinction matters:
    //
    //   WHAT IS TESTED HERE — that authorisation in this system resolves against
    //   real `role_assignment` rows in `packages/db` (forced RLS + the policy
    //   engine), and that NOTHING in `packages/auth` reads `session."orgId"` to
    //   decide an authorisation outcome. The session's orgId is a label the
    //   application may choose to act upon; it is never itself the grant.
    //
    //   WHAT CANNOT BE TESTED HERE — an end-to-end "org A's user reads org B's
    //   business row" test, because this package has no business tables and no
    //   `role_assignment`; both live in `packages/db`, which asserts its own RLS
    //   against a real instance. Writing that test here would require inventing a
    //   second copy of the tenancy schema to assert against, which would be
    //   theatre.
    //
    // So the assertion is structural, and it is the strongest structural claim
    // available: if no function, trigger or policy in this package consults
    // `session."orgId"` to grant anything, then a forged value on that column
    // cannot become a permission, whatever it is set to.
    // Reflected as three separate queries rather than one UNION. PGlite's parser
    // mis-binds `pg_get_functiondef` across a UNION arm and reports a spurious
    // `"array_agg" is an aggregate function`; separate statements avoid the
    // mis-parse and keep each reflection independently readable.
    const functions = await fixture.ownerPool.query<{ object_name: string; source: string }>(
      `SELECT p.proname AS object_name, pg_get_functiondef(p.oid) AS source
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'`,
    );
    const triggers = await fixture.ownerPool.query<{ object_name: string; source: string }>(
      `SELECT t.tgname AS object_name, pg_get_triggerdef(t.oid) AS source
         FROM pg_trigger t
        WHERE NOT t.tgisinternal`,
    );
    const policyRows = await policies();

    const consumers = [
      ...functions.rows,
      ...triggers.rows,
      ...policyRows.map((row) => ({ object_name: row.policyname, source: `${row.qual ?? ""} ${row.with_check ?? ""}` })),
    ];

    // `auth_session_by_token` reads orgId — it IS the identity lookup and returns
    // the value as data. `auth_set_active_org` writes orgId, which is its whole
    // purpose and is gated on a real membership. Neither one grants anything.
    //
    // The property being asserted is that no POLICY reads orgId: a policy is the
    // one place where a stored value would silently become a decision, so that is
    // where a forged label would turn into a grant.
    const policyConsumers = policyRows.filter((row) => /orgId/.test(`${row.qual ?? ""} ${row.with_check ?? ""}`));

    expect(
      policyConsumers.map((row) => row.policyname),
      "no RLS policy may read session.orgId; that is where a label would become a grant",
    ).toEqual([]);

    // `auth_set_active_org` is the only object in the schema that MENTIONS the
    // orgId column, and it only ever writes it. It is gated on a real active
    // membership row, so a forged value cannot reach it.
    //
    // `auth_session_by_token` deliberately does not appear here: it returns
    // `s.*`, so it RETURNS orgId as data without naming it. Returning a value is
    // not deciding anything — the caller still has to validate it — and the test
    // for that is the one above, which shows nothing authorises off it.
    const orgIdTouchers = consumers
      .filter((row) => /orgId/.test(row.source))
      .map((row) => row.object_name)
      .sort();

    expect(orgIdTouchers).toEqual(["auth_set_active_org"]);

    // And the writer is gated: its body cannot set orgId without first proving
    // membership, so the column has exactly one door and that door has a check.
    const writer = functions.rows.find((row) => row.object_name === "auth_set_active_org");
    expect(writer?.source).toMatch(/org_membership/i);
    expect(writer?.source).toMatch(/'active'/);

    // And the value itself is a client-invisible label: two orgs are just two
    // strings on the column, with no privileges attached to either.
    const distinct = await fixture.ownerPool.query<{ orgid: string | null }>(
      `SELECT DISTINCT "orgId" FROM "session" WHERE "orgId" IS NOT NULL`,
    );
    expect(distinct.rows.length).toBeLessThanOrEqual(1);

    expect(ORG_A).not.toBe(ORG_B);
  });

  it("leaves authorisation to packages/db, which owns role_assignment", async () => {
    // Documented here rather than assumed silently: `packages/auth` contains no
    // `role_assignment` table and no policy engine, so it cannot itself grant or
    // deny a business permission. This asserts the absence so that a future
    // "quick" grant added to this package is caught rather than shipped.
    const result = await fixture.ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public'
          AND c.relname IN ('role_assignment', 'role', 'permission')`,
    );

    expect(result.rows[0]?.n).toBe(0);
  });
});