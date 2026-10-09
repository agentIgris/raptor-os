/**
 * Session tenant-isolation tests, against the real local PostgreSQL 18.6.
 *
 * WHAT THIS PROVES
 * ----------------
 * `"session"` is the one Better Auth table that carries an org scope, and
 * `schema.sql` enables AND FORCES RLS on it. This suite demonstrates that a
 * session bound to one organisation is invisible to a request resolved as
 * another — the behaviour ADR-0011 requires of every tenant-owned table.
 *
 * WHY THE ASSERTIONS RUN AS `raptor_app`
 * --------------------------------------
 * Every query here goes through a pool connected as `raptor_app`
 * (NOSUPERUSER NOBYPASSRLS). A superuser bypasses RLS entirely, so the same
 * assertions run as `raptor_migrator` would pass while proving nothing. ADR-0006
 * records exactly this: "org-a sees: ['org-a-data', 'org-b-data'] — isolation
 * silently absent".
 *
 * WHY A `SET LOCAL` INSIDE A TRANSACTION
 * --------------------------------------
 * `current_org_id()` reads `app.org_id`, which must be scoped to one request.
 * `SET LOCAL` inside an explicit transaction makes it revert at COMMIT, so one
 * request can never leak its tenant into the next — which is exactly what a
 * pooled connection would do with a bare `SET`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import { createAuthFixture, truncateAuthTables, type AuthTestFixture } from "./test-helpers.js";

let fixture: AuthTestFixture;

/** Two well-formed organisation identifiers. */
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

/**
 * Run `work` with `app.org_id` set for the duration of one transaction.
 *
 * `SET LOCAL` + explicit transaction, so the value cannot outlive the request on
 * a pooled connection.
 */
async function asOrg<T>(orgId: string | null, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await fixture.appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId ?? ""]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Count sessions visible on the current connection. */
async function visibleSessionCount(): Promise<number> {
  const result = await fixture.appPool.query<{ n: number }>('SELECT count(*)::int AS n FROM "session"');
  return result.rows[0]?.n ?? -1;
}

beforeAll(async () => {
  fixture = await createAuthFixture({ truncate: false });
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  await truncateAuthTables(fixture.migratorPool);
});

/**
 * Seed a user with a session bound to `orgId`.
 *
 * Written as `raptor_migrator` because the app role cannot insert into a
 * FORCED-RLS table without a matching tenant context, and the fixture is
 * establishing the very rows the policy is supposed to protect.
 */
async function seedSessionFor(orgId: string, label: string): Promise<string> {
  const user = await fixture.migratorPool.query<{ id: string }>(
    `INSERT INTO "user" ("name", "email", "emailVerified", "role", "twoFactorEnabled")
     VALUES ($1, $2, true, 'player', false) RETURNING "id"`,
    [`Org ${label} User`, `${label.toLowerCase()}-user@example.invalid`],
  );
  const userId = user.rows[0]?.id;
  if (userId === undefined) throw new Error("seedSessionFor: no user id");

  const session = await fixture.migratorPool.query<{ id: string }>(
    `INSERT INTO "session" ("expiresAt", "token", "userId", "orgId")
     VALUES (now() + interval '1 hour', $1, $2, $3) RETURNING "id"`,
    [`token-for-${label}`, userId, orgId],
  );

  return session.rows[0]?.id ?? "";
}

describe("RLS is enabled and forced on session", () => {
  it("reports relrowsecurity and relforcerowsecurity as true", async () => {
    // Queried from pg_class rather than trusted from the migration file, so this
    // fails if the DDL is ever edited without the FORCE.
    const result = await fixture.migratorPool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'session'`,
    );

    expect(result.rows[0]?.relrowsecurity).toBe(true);
    // Without FORCE the table owner is exempt, so the policy is one
    // `ALTER TABLE ... OWNER TO` away from being decorative.
    expect(result.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("has the tenant policy installed", async () => {
    const result = await fixture.migratorPool.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'session'`,
    );

    expect(result.rows.map((row) => row.policyname)).toContain("session_tenant_isolation");
  });

  it("enables RLS on every Better Auth table", async () => {
    const result = await fixture.migratorPool.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname IN ('user','session','account','verification','twoFactor','rateLimit')
       ORDER BY c.relname`,
    );

    expect(result.rows).toHaveLength(6);
    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
    }
  });
});

describe("the application role can still use the identity tables", () => {
  it("reads its own rows, which a policy-less table would deny entirely", async () => {
    // RLS is default-deny. With RLS enabled and no policy, `raptor_app` sees
    // ZERO rows no matter what it was granted — a failure that looks like
    // "every password is wrong" rather than like a missing policy.
    await seedSessionFor(ORG_A, "Readable");
    expect(await visibleSessionCount()).toBeGreaterThan(0);
  });

  it("reads the user table", async () => {
    await seedSessionFor(ORG_A, "UserReadable");
    const result = await fixture.appPool.query<{ n: number }>('SELECT count(*)::int AS n FROM "user"');
    expect(result.rows[0]?.n).toBeGreaterThan(0);
  });
});

describe("a session bound to one org is invisible to another", () => {
  it("hides org A's session from a request resolved as org B", async () => {
    await seedSessionFor(ORG_A, "Alpha");

    const seenByA = await asOrg(ORG_A, async (client) => {
      const result = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM "session"');
      return result.rows[0]?.n ?? 0;
    });
    const seenByB = await asOrg(ORG_B, async (client) => {
      const result = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM "session"');
      return result.rows[0]?.n ?? 0;
    });

    expect(seenByA).toBe(1);
    expect(seenByB).toBe(0);
  });

  it("shows each org only its own sessions when both exist", async () => {
    await seedSessionFor(ORG_A, "BothAlpha");
    await seedSessionFor(ORG_B, "BothBeta");

    const seenByA = await asOrg(ORG_A, async (client) => {
      const result = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM "session"');
      return result.rows[0]?.n ?? 0;
    });
    const seenByB = await asOrg(ORG_B, async (client) => {
      const result = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM "session"');
      return result.rows[0]?.n ?? 0;
    });

    expect(seenByA).toBe(1);
    expect(seenByB).toBe(1);
  });

  it("denies a cross-tenant UPDATE as well as a read", async () => {
    await seedSessionFor(ORG_A, "UpdateAlpha");

    const updated = await asOrg(ORG_B, async (client) => {
      const result = await client.query('UPDATE "session" SET "ipAddress" = $1', ["203.0.113.9"]);
      return result.rowCount ?? 0;
    });

    // Zero rows affected: the row is not visible, so it cannot be modified.
    expect(updated).toBe(0);
  });

  it("denies a cross-tenant DELETE", async () => {
    await seedSessionFor(ORG_A, "DeleteAlpha");

    const deleted = await asOrg(ORG_B, async (client) => {
      const result = await client.query('DELETE FROM "session"');
      return result.rowCount ?? 0;
    });

    expect(deleted).toBe(0);

    // And the session is still there for its own tenant, so revocation from the
    // wrong tenant silently did nothing rather than half-working.
    const seenByA = await asOrg(ORG_A, async (client) => {
      const result = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM "session"');
      return result.rows[0]?.n ?? 0;
    });
    expect(seenByA).toBe(1);
  });

  it("blocks INSERT of a session claiming another org's id", async () => {
    const user = await fixture.migratorPool.query<{ id: string }>(
      `INSERT INTO "user" ("name", "email", "emailVerified", "role")
       VALUES ('Bound', 'bound@example.invalid', true, 'player') RETURNING "id"`,
    );
    const userId = user.rows[0]?.id ?? "";

    // The WITH CHECK clause is what stops a compromised application process
    // from writing a session into a tenant it does not belong to.
    const rejected = await asOrg(ORG_B, async (client) => {
      try {
        await client.query(
          `INSERT INTO "session" ("expiresAt", "token", "userId", "orgId")
           VALUES (now() + interval '1 hour', $1, $2, $3)`,
          ["forged-token", userId, ORG_A],
        );
        return false;
      } catch {
        return true;
      }
    });

    expect(rejected).toBe(true);
  });
});

describe("the identity bootstrap branch", () => {
  it("lets an unbound session be resolved before the tenant is known", async () => {
    // A session with `orgId` NULL is the platform-level sign-in state. The
    // application cannot know which organisation the caller belongs to until it
    // has read the session, so without this branch every signed-in user would
    // appear logged out.
    await fixture.migratorPool.query(
      `INSERT INTO "user" ("name", "email", "emailVerified", "role")
       VALUES ('Unbound', 'unbound@example.invalid', true, 'player')`,
    );
    const userId = await fixture.migratorPool.query<{ id: string }>(
      'SELECT "id" FROM "user" WHERE "email" = $1',
      ["unbound@example.invalid"],
    );
    await fixture.migratorPool.query(
      `INSERT INTO "session" ("expiresAt", "token", "userId", "orgId")
       VALUES (now() + interval '1 hour', 'unbound-token', $1, NULL)`,
      [userId.rows[0]?.id ?? ""],
    );

    const seen = await asOrg(null, async (client) => {
      const result = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM "session"');
      return result.rows[0]?.n ?? 0;
    });

    expect(seen).toBe(1);
  });

  it("still isolates a BOUND session when the tenant is known", async () => {
    // The bootstrap branch does not weaken the boundary for bound sessions: once
    // `app.org_id` is set, the predicate is exact.
    await seedSessionFor(ORG_A, "BootstrapAlpha");

    const seenByA = await asOrg(ORG_A, async (client) => {
      const result = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM "session"');
      return result.rows[0]?.n ?? 0;
    });
    const seenByB = await asOrg(ORG_B, async (client) => {
      const result = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM "session"');
      return result.rows[0]?.n ?? 0;
    });

    expect(seenByA).toBe(1);
    expect(seenByB).toBe(0);
  });
});