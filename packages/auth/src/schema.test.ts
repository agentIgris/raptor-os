/**
 * Schema tests.
 *
 * THE DEFECT BEING PREVENTED
 * --------------------------
 * AUDIT/08: "Three role identifiers exist only in TypeScript." `ROLE_CONFIG`
 * defined nine roles; `app/api/users/route.ts` allow-listed six; the database
 * CHECK constraint allowed seven. A role picker built from `getAllRoles()`
 * therefore offered `tryout` and `awaiting_approval`, and choosing either
 * produced a 23514 check-constraint violation at runtime.
 *
 * The fix is not vigilance — it is a test that fails if the two lists ever
 * diverge. `roles.ts` and `schema.sql` must agree exactly.
 *
 * These tests read the LIVE database rather than the `.sql` file, so a table
 * applied with the wrong constraint, or not applied at all, fails here. The
 * database is an in-process PGlite session (PostgreSQL 18.3 in WebAssembly);
 * native PostgreSQL cannot start a backend on this machine — see
 * `docs/adr/0015-pglite-restored-after-native-postgres-retest.md`.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ALL_ROLES, PRIVILEGED_ROLES } from "./roles.js";
import { createAuthFixture, type AuthTestFixture } from "./test-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, "schema.sql");

/** Tables Better Auth's option set expects, derived from the installed package. */
const EXPECTED_TABLES = ["user", "session", "account", "verification", "twoFactor", "rateLimit"] as const;

let fixture: AuthTestFixture;
let schemaSql: string;

beforeAll(async () => {
  fixture = await createAuthFixture({ truncate: false });
  schemaSql = await readFile(SCHEMA_PATH, "utf8");
});

afterAll(async () => {
  await fixture.close();
});

describe("the role vocabulary agrees across every place it is written", () => {
  it("declares exactly the roles in roles.ts in the database CHECK constraint", async () => {
    const result = await fixture.ownerPool.query<{ pg_get_constraintdef: string }>(
      `SELECT pg_get_constraintdef(oid) AS pg_get_constraintdef
       FROM pg_constraint
       WHERE conname = 'user_role_membership_check' AND conrelid = '"user"'::regclass`,
    );

    const definition = result.rows[0]?.pg_get_constraintdef;
    expect(definition, "user_role_membership_check must exist").toBeDefined();

    // PostgreSQL normalises `CHECK (role IN ('a','b'))` to
    // `CHECK ((role = ANY (ARRAY['a'::text, 'b'::text])))`, so the literals live
    // in the ARRAY, not in the outer parentheses. Parsing the wrong one would
    // read `role = ANY (ARRAY[...]` as a "role", and the assertion would pass or
    // fail for reasons unrelated to the constraint.
    const array = /ARRAY\[([^\]]*)\]/.exec(definition ?? "");
    expect(array, `expected an ARRAY literal in: ${definition ?? ""}`).not.toBeNull();

    const inDatabase = (array?.[1] ?? "")
      .split(",")
      .map((value) => value.trim().replaceAll("'", "").replace(/::text$/, "").trim())
      .filter((value) => value.length > 0);

    expect(inDatabase.sort()).toEqual([...ALL_ROLES].sort());
  });

  it("keeps the same list in schema.sql as in the database", () => {
    const match = /user_role_membership_check\s*\n?\s*CHECK\s*\("role"\s+IN\s*\(([^)]*)\)/.exec(schemaSql);
    expect(match).not.toBeNull();

    const inFile = (match?.[1] ?? "")
      .split(",")
      .map((value) => value.trim().replaceAll("'", ""))
      .filter((value) => value.length > 0);

    expect(inFile.sort()).toEqual([...ALL_ROLES].sort());
  });

  it("lists exactly the privileged roles in the MFA trigger", () => {
    // The trigger and the exported constant must not drift, or MFA silently
    // stops applying to a role that still needs it.
    const match = /NEW\."role"\s+IN\s*\(([^)]*)\)/.exec(schemaSql);
    expect(match).not.toBeNull();

    const inTrigger = (match?.[1] ?? "")
      .split(",")
      .map((value) => value.trim().replaceAll("'", ""))
      .filter((value) => value.length > 0);

    expect(inTrigger.sort()).toEqual([...PRIVILEGED_ROLES].sort());
  });
});

describe("every Better Auth table exists", () => {
  it.each(EXPECTED_TABLES)("creates %s", async (table) => {
    const result = await fixture.ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );

    expect(result.rows[0]?.n, `table "${table}" must exist`).toBe(1);
  });
});

describe("Better Auth's expected columns exist with the expected types", () => {
  /**
   * Derived from Better Auth's own compiled DDL (`getMigrations(...).compileMigrations()`),
   * not from memory. The odd camelCase names are what the adapter sends on the
   * wire; a tidied-up snake_case schema would fail at the first query.
   */
  const EXPECTED_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    user: {
      id: "uuid",
      name: "text",
      email: "text",
      emailVerified: "boolean",
      image: "text",
      createdAt: "timestamp with time zone",
      updatedAt: "timestamp with time zone",
      twoFactorEnabled: "boolean",
      role: "text",
    },
    session: {
      id: "uuid",
      expiresAt: "timestamp with time zone",
      token: "text",
      createdAt: "timestamp with time zone",
      updatedAt: "timestamp with time zone",
      ipAddress: "text",
      userAgent: "text",
      userId: "uuid",
      orgId: "text",
    },
    account: {
      id: "uuid",
      accountId: "text",
      providerId: "text",
      userId: "uuid",
      accessToken: "text",
      refreshToken: "text",
      idToken: "text",
      accessTokenExpiresAt: "timestamp with time zone",
      refreshTokenExpiresAt: "timestamp with time zone",
      scope: "text",
      password: "text",
      createdAt: "timestamp with time zone",
      updatedAt: "timestamp with time zone",
    },
    verification: {
      id: "uuid",
      identifier: "text",
      value: "text",
      expiresAt: "timestamp with time zone",
      createdAt: "timestamp with time zone",
      updatedAt: "timestamp with time zone",
    },
    twoFactor: {
      id: "uuid",
      secret: "text",
      backupCodes: "text",
      userId: "uuid",
      verified: "boolean",
      failedVerificationCount: "integer",
      lockedUntil: "timestamp with time zone",
    },
    rateLimit: {
      id: "uuid",
      key: "text",
      count: "integer",
      lastRequest: "bigint",
    },
  };

  it.each(Object.entries(EXPECTED_COLUMNS))("matches %s", async (table, columns) => {
    const result = await fixture.ownerPool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );

    const actual = new Map(result.rows.map((row) => [row.column_name, row.data_type]));

    for (const [column, dataType] of Object.entries(columns)) {
      expect(actual.get(column), `${table}.${column} must exist`).toBe(dataType);
    }
  });
});

describe("constraints exist", () => {
  it("has a unique index on user email", async () => {
    // Without it, two accounts could share an address and the "sign in" lookup
    // would return an arbitrary one of them.
    const result = await fixture.ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM pg_constraint
       WHERE conrelid = '"user"'::regclass AND contype = 'u'
         AND pg_get_constraintdef(oid) LIKE '%email%'`,
    );

    expect(result.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("has a unique index on session token", async () => {
    const result = await fixture.ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM pg_constraint
       WHERE conrelid = '"session"'::regclass AND contype = 'u'
         AND pg_get_constraintdef(oid) LIKE '%token%'`,
    );

    expect(result.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("cascades deletes from user to session and account", async () => {
    // Deleting an account must not orphan live sessions; an orphaned session is a
    // credential with no owner to revoke it.
    const result = await fixture.ownerPool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE contype = 'f' AND confrelid = '"user"'::regclass`,
    );

    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of result.rows) {
      expect(row.confdeltype, `${row.conname} must cascade`).toBe("c");
    }
  });

  it.each([
    ["user_role_membership_check", '"user"'],
    ["user_email_normalised_check", '"user"'],
    ["session_expiry_after_creation_check", '"session"'],
    ["account_provider_id_present_check", '"account"'],
    ["two_factor_failed_count_nonnegative_check", '"twoFactor"'],
    ["two_factor_lock_requires_failures_check", '"twoFactor"'],
    ["rate_limit_count_nonnegative_check", '"rateLimit"'],
  ])("installs %s", async (constraint, table) => {
    const result = await fixture.ownerPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass",
      [constraint, table],
    );

    expect(result.rows[0]?.n, `${constraint} on ${table}`).toBe(1);
  });
});

describe("the twoFactor lock constraint matches what Better Auth actually writes", () => {
  // The previous constraint here was
  //
  //     CHECK ("lockedUntil" IS NULL OR "verified" IS NOT TRUE)
  //
  // and it rejected the lockout's own write. Better Auth sets `lockedUntil` and
  // leaves `verified` alone, so for every ENROLLED user -- the only users a TOTP
  // guessing attack targets -- the lock could never be persisted and
  // `accountLockout` was inert. These two tests are the regression.
  it("permits a verified enrolment to be locked, which is the state the plugin writes", async () => {
    const user = await fixture.ownerPool.query<{ id: string }>(
      `INSERT INTO "user" ("name", "email", "emailVerified", "role", "twoFactorEnabled")
       VALUES ('Lock Tester', 'lockable@example.invalid', true, 'player', true)
       RETURNING "id"`,
    );
    const userId = user.rows[0]?.id;
    if (userId === undefined) throw new Error("fixture user row missing");

    const inserted = await fixture.ownerPool.query<{ lockedUntil: Date | null }>(
      `INSERT INTO "twoFactor" ("secret", "backupCodes", "userId", "verified",
                                "failedVerificationCount", "lockedUntil")
       VALUES ($1, $2, $3, true, 5, now() + interval '15 minutes')
       RETURNING "lockedUntil"`,
      ["encrypted-secret", "encrypted-backup-codes", userId],
    );

    expect(inserted.rows[0]?.lockedUntil, "the lock must persist, not raise 23514").not.toBeNull();
  });

  it("refuses a lock with no failures behind it", async () => {
    // The invariant that replaced the broken one: a lock must be explained.
    const user = await fixture.ownerPool.query<{ id: string }>(
      `INSERT INTO "user" ("name", "email", "emailVerified", "role", "twoFactorEnabled")
       VALUES ('Lock Tester', 'unexplained-lock@example.invalid', true, 'player', true)
       RETURNING "id"`,
    );
    const userId = user.rows[0]?.id;
    if (userId === undefined) throw new Error("fixture user row missing");

    let code: string | null = null;
    try {
      await fixture.ownerPool.query(
        `INSERT INTO "twoFactor" ("secret", "backupCodes", "userId", "verified",
                                  "failedVerificationCount", "lockedUntil")
         VALUES ($1, $2, $3, true, 0, now() + interval '15 minutes')`,
        ["encrypted-secret", "encrypted-backup-codes", userId],
      );
    } catch (error) {
      code = (error as { code?: string }).code ?? null;
    }

    expect(code).toBe("23514");
  });

  it("no longer contains the constraint that defeated the lockout", async () => {
    // Asserted on the FILE as well as the database, because the defect shipped as
    // a line of SQL that a re-run of this file would otherwise restore.
    const result = await fixture.ownerPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_constraint WHERE conname = $1",
      ["two_factor_verified_only_when_not_locked_check"],
    );

    expect(result.rows[0]?.n).toBe(0);
  });
});

describe("the MFA guard trigger is installed", () => {
  it("exists on the user table", async () => {
    const result = await fixture.ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger
       WHERE tgname = 'user_mfa_guard_trigger' AND NOT tgisinternal`,
    );

    expect(result.rows[0]?.n).toBe(1);
  });

  it("fires on both INSERT and UPDATE", async () => {
    // A trigger on INSERT alone would still permit promoting an existing account,
    // which is the escalation that matters.
    const result = await fixture.ownerPool.query<{ tgtype: number }>(
      `SELECT tgtype FROM pg_trigger
       WHERE tgname = 'user_mfa_guard_trigger' AND NOT tgisinternal`,
    );

    // PostgreSQL bitmask: 1 = ROW, 2 = BEFORE, 4 = INSERT, 8 = DELETE,
    // 16 = UPDATE, 64 = TRUNCATE.
    const tgtype = result.rows[0]?.tgtype ?? 0;
    expect(tgtype & 4, "must fire on INSERT").not.toBe(0);
    expect(tgtype & 16, "must fire on UPDATE").not.toBe(0);
  });
});

describe("schema.sql is idempotent", () => {
  it("uses IF NOT EXISTS for every object it creates", () => {
    const createStatements = schemaSql
      .split("\n")
      .filter((line) => /^\s*CREATE\s+(TABLE|INDEX)\b/i.test(line));

    expect(createStatements.length).toBeGreaterThan(0);
    for (const statement of createStatements) {
      expect(statement, `must be conditional: ${statement.trim()}`).toMatch(/IF NOT EXISTS/i);
    }
  });

  it("drops a trigger before recreating it, because CREATE TRIGGER has no IF NOT EXISTS", () => {
    // Without the DROP, a second application fails with 42710 and the migration
    // is not idempotent despite everything else being guarded.
    expect(schemaSql).toMatch(/DROP TRIGGER IF EXISTS user_mfa_guard_trigger/);
  });

  it("drops a policy before recreating it", () => {
    // The property is idempotency, not the existence of any one policy: CREATE
    // POLICY has no IF NOT EXISTS, so an unguarded second application fails with
    // 42710. `session_tenant_isolation` was the example before ADR-0017 removed
    // the tenant policy; the guards now live in the loop that creates every
    // `*_app_role_access` policy, which includes `session`. Asserting the loop
    // keeps the guarantee without pinning the test to a policy ADR-0017 deleted.
    expect(schemaSql).toMatch(/DROP POLICY IF EXISTS %I ON %I/);
    expect(schemaSql).toMatch(/'user','account','verification','twoFactor','rateLimit','session'/);
  });

  it("replaces functions rather than failing on an existing one", () => {
    const createFunctions = schemaSql.match(/CREATE OR REPLACE FUNCTION/g) ?? [];
    expect(createFunctions.length).toBeGreaterThanOrEqual(2);
  });
});