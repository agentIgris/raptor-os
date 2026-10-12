/**
 * person_credential_link (migration 0014, ADR-0018 item 1).
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * The auth package's `auth_set_active_org` joins session → "user" → person →
 * org_membership. That join is load-bearing for the whole session model, and until
 * 0014 the middle table did not exist — the function referenced a `userId` column on
 * org_membership that was never there, which a cloud apply proved with 42703.
 *
 * These tests pin the properties the join depends on: one credential resolves to at
 * most one person, deleting a person is RESTRICTed while its links survive, and the
 * application role holds no privilege on the table (link forgery would bypass the
 * membership check, so the absence of a grant is the control).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrateUp } from "./migrations.js";

const PERSON_A = "aaaaaaaa-0000-0000-0000-000000000001";
const PERSON_B = "bbbbbbbb-0000-0000-0000-000000000002";
const USER_A = "a0000000-0000-0000-0000-000000000001";

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await migrateUp(db);
  await db.exec(`
    INSERT INTO person (id, external_ref) VALUES
      ('${PERSON_A}', 'link-a'),
      ('${PERSON_B}', 'link-b');
  `);
});

describe("person_credential_link", () => {
  it("links a person to a credential", async () => {
    await db.exec(`
      INSERT INTO person_credential_link (person_id, user_id)
      VALUES ('${PERSON_A}', '${USER_A}');
    `);
    const r = await db.query<{ person_id: string }>(
      `SELECT person_id FROM person_credential_link WHERE user_id = '${USER_A}'`,
    );
    expect(r.rows[0]?.person_id).toBe(PERSON_A);
  });

  it("refuses a second person for one credential: UNIQUE(user_id)", async () => {
    await expect(
      db.exec(`
        INSERT INTO person_credential_link (person_id, user_id)
        VALUES ('${PERSON_B}', '${USER_A}');
      `),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("refuses to delete a person while its links survive: ON DELETE RESTRICT", async () => {
    await expect(
      db.exec(`DELETE FROM person WHERE id = '${PERSON_A}'`),
    ).rejects.toThrow(/restrict|violates/i);
  });

  it("grants the application role nothing on the link table", async () => {
    const r = await db.query<{ has_privilege: boolean }>(
      `SELECT has_table_privilege('raptor_app', 'person_credential_link', 'SELECT') AS has_privilege`,
    );
    expect(r.rows[0]?.has_privilege).toBe(false);
  });

  it("is intentionally global: no org_id, no RLS, like person and identity", async () => {
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'person_credential_link'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).not.toContain("org_id");
    const rls = await db.query<{ rls: boolean }>(
      `SELECT relrowsecurity AS rls FROM pg_class WHERE relname = 'person_credential_link'`,
    );
    expect(rls.rows[0]?.rls).toBe(false);
  });
});
