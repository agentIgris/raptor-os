/**
 * Tenancy isolation — the release gate.
 *
 * These are not ordinary unit tests. Each one asserts a property the entire product
 * depends on. If any of them fails, the system is not safe to ship.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migrateUp, migrationStatus } from "./migrations.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

let db: PGlite;

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

async function asOwner(sql: string): Promise<void> {
  await db.exec(sql);
}

beforeAll(async () => {
  db = new PGlite();
  await migrateUp(db);
});

beforeEach(async () => {
  await db.exec("RESET ROLE");
  await db.exec("SELECT set_config('app.org_id', '', false)");

  await asOwner(`
    TRUNCATE audit_log, outbox_event, role_assignment, role_scope_rule, role_permission,
             role, engagement, org_membership, consent_record, guardian_consent,
             person_profile, identity, person, organization CASCADE;
  `);

  await asOwner(`
    INSERT INTO organization (id, slug, display_name, default_currency, status)
    VALUES
      ('${ORG_A}', 'org-a', 'Org A', 'INR', 'active'),
      ('${ORG_B}', 'org-b', 'Org B', 'USD', 'active');
  `);
});

describe("migration ledger", () => {
  it("records every applied migration", async () => {
    const status = await migrationStatus(db);
    expect(status.applied).toContain("0001_tenancy.sql");
    expect(status.pending).toHaveLength(0);
  });

  it("is idempotent — re-running applies nothing", async () => {
    const executed = await migrateUp(db);
    expect(executed).toHaveLength(0);
  });
});

describe("structural tenant invariants", () => {
  const TENANT_TABLES = [
    "org_membership",
    "engagement",
    "role",
    "role_permission",
    "role_scope_rule",
    "role_assignment",
  ];

  it("forces row level security on every tenant-owned table", async () => {
    const { rows: result } = await asOwnerRows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname = ANY($1) AND relkind = 'r'`,
      [TENANT_TABLES],
    );

    expect(result).toHaveLength(TENANT_TABLES.length);
    for (const row of result) {
      expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });

  it("makes org_id NOT NULL on every tenant-owned table", async () => {
    const { rows: result } = await asOwnerRows<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = ANY($1) AND column_name = 'org_id'`,
      [TENANT_TABLES],
    );

    expect(result).toHaveLength(TENANT_TABLES.length);
    for (const row of result) {
      expect(row.is_nullable, `${row.table_name}.org_id must be NOT NULL`).toBe("NO");
    }
  });

  it("denies UPDATE and DELETE on the audit log", async () => {
    const { rows: result } = await asOwnerRows<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'audit_log' AND grantee = 'PUBLIC' AND privilege_type IN ('UPDATE','DELETE')`,
    );
    expect(result).toHaveLength(0);
  });

  it("does not let the application role alter authorisation tables", async () => {
    const { rows: result } = await asOwnerRows<{ privilege_type: string; table_name: string }>(
      `SELECT privilege_type, table_name FROM information_schema.role_table_grants
        WHERE grantee = 'raptor_app' AND table_name = 'role'
          AND privilege_type IN ('INSERT','UPDATE','DELETE')`,
    );
    expect(result).toHaveLength(0);
  });
});

describe("row level security in practice", () => {
  it("shows a member only their own organisation's rows", async () => {
    await seedMemberships();

    await asApp(async () => {
      const rows = await db.query<{ org_id: string }>("SELECT org_id FROM org_membership");
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.org_id).toBe(ORG_A);
    }, ORG_A);

    await asApp(async () => {
      const rows = await db.query<{ org_id: string }>("SELECT org_id FROM org_membership");
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.org_id).toBe(ORG_B);
    }, ORG_B);
  });

  it("refuses an insert that names a different organisation", async () => {
    await seedMemberships();

    await asApp(async () => {
      await expect(
        db.query(
          "INSERT INTO org_membership (org_id, person_id) VALUES ($1, $2)",
          [ORG_B, "33333333-3333-3333-3333-333333333333"],
        ),
      ).rejects.toThrow();
    }, ORG_A);
  });

  it("returns nothing when no tenant is set in the session", async () => {
    await seedMemberships();

    await asApp(async () => {
      const rows = await db.query("SELECT * FROM org_membership");
      expect(rows.rows).toHaveLength(0);
    });
  });
});

describe("composite foreign keys make cross-tenant references impossible", () => {
  it("rejects a row referencing another tenant's entity", async () => {
    await asOwner(`
      CREATE TABLE IF NOT EXISTS probe_child (
        id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id    uuid NOT NULL,
        member_id uuid NOT NULL,
        CONSTRAINT probe_child_member_fk
          FOREIGN KEY (org_id, member_id)
          REFERENCES org_membership (org_id, id)
      );
    `);

    await seedMemberships();

    const { rows } = await asOwnerRows<{ id: string; org_id: string }>(
      "SELECT id, org_id FROM org_membership ORDER BY org_id",
    );
    const aMember = rows.find((r) => r.org_id === ORG_A)!;
    const bMember = rows.find((r) => r.org_id === ORG_B)!;

    // Same tenant: accepted.
    await asOwner(
      `INSERT INTO probe_child (org_id, member_id) VALUES ('${ORG_A}', '${aMember.id}')`,
    );

    // Different tenant for the two FK columns: rejected by the database, not by code.
    await expect(
      asOwner(`INSERT INTO probe_child (org_id, member_id) VALUES ('${ORG_A}', '${bMember.id}')`),
    ).rejects.toThrow();
  });
});

async function seedMemberships(): Promise<void> {
  await asOwner(`
    INSERT INTO person (id, external_ref) VALUES
      ('aaaaaaaa-0000-0000-0000-000000000001', 'p-a'),
      ('bbbbbbbb-0000-0000-0000-000000000002', 'p-b');

    INSERT INTO org_membership (org_id, person_id, status, joined_at) VALUES
      ('${ORG_A}', 'aaaaaaaa-0000-0000-0000-000000000001', 'active', now()),
      ('${ORG_B}', 'bbbbbbbb-0000-0000-0000-000000000002', 'active', now());
  `);
}

async function asOwnerRows<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  await db.exec("RESET ROLE");
  const result = await db.query<T>(sql, params);
  return { rows: result.rows };
}