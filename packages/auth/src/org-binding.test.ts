/**
 * The organisation-binding functions, CALLED.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * `auth_active_orgs_for_token` and `auth_set_active_org` are the two functions
 * that decide which organisation a session may enter, and the sign-in flow
 * depends on both: the client calls the first to discover, the second to bind.
 * Until now they were only ASSERTED ABOUT — that they exist, that they are
 * `SECURITY DEFINER`, that `PUBLIC` cannot call them, that only
 * `auth_set_active_org` writes `orgId`. Nobody ever RAN them.
 *
 * That is how this shipped: the function was written as a `LANGUAGE sql`
 * function whose body returns `organization.display_name` (a `varchar(200)`)
 * where the signature declares `text`. A SQL-language function coerces its
 * result to the declared types; a `plpgsql` one does not, and `RETURN QUERY`
 * raises
 *
 *     structure of query does not match function result type
 *
 * at CALL time, naming a column and nothing else.
 *
 * The symptom was the whole workspace: the session never got an organisation
 * bound, so every page that needs one rendered "unavailable" — teams,
 * competitions, members, analytics, the organisation profile — with nothing in
 * the log, because the caller swallows the failure by design.
 *
 * So the functions are called here, with the cross-package tables they read
 * present as stubs. The stubs are deliberately `varchar`, not `text`: the
 * mismatch this file guards is a mismatch of TYPES, and a stub that used
 * `text` would pass while the real schema failed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuthFixture, truncateAuthTables, type AuthTestFixture } from "./test-helpers.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const PERSON = "33333333-3333-4333-8333-333333333333";

let fixture: AuthTestFixture;

beforeAll(async () => {
  fixture = await createAuthFixture({ truncate: false });

  // The three domain tables the functions read. `packages/db` owns them in
  // production; the auth test database applies only the identity schema, so
  // they are stubbed here — with the SAME column types the real tables have,
  // because the failure being guarded is a type mismatch.
  //
  // One statement per call: the driver refuses more than one command in a
  // prepared statement, and the harness has already dropped the session to the
  // application role, so the DDL has to go through the owner pool.
  await fixture.ownerPool.query(
    `CREATE TABLE IF NOT EXISTS public.organization (
       "id" uuid PRIMARY KEY,
       "slug" varchar(64) NOT NULL,
       "display_name" varchar(200) NOT NULL,
       "archived_at" timestamptz
     )`,
  );
  await fixture.ownerPool.query(
    `CREATE TABLE IF NOT EXISTS public.person_credential_link (
       "person_id" uuid NOT NULL,
       "user_id" uuid NOT NULL
     )`,
  );
  await fixture.ownerPool.query(
    `CREATE TABLE IF NOT EXISTS public.org_membership (
       "person_id" uuid NOT NULL,
       "org_id" uuid NOT NULL,
       "status" text NOT NULL
     )`,
  );
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  await truncateAuthTables(fixture);
  await fixture.ownerPool.query(`DELETE FROM public.org_membership`);
  await fixture.ownerPool.query(`DELETE FROM public.person_credential_link`);
  await fixture.ownerPool.query(`DELETE FROM public.organization`);
});

/** A user, a session for them, and the person link behind it. */
async function sessionFor(email: string, token: string): Promise<void> {
  // The role is `player` and that is deliberate: neither function reads it, and
  // a privileged role without the enrolment flag is refused by
  // `user_mfa_guard_trigger` — which is that trigger working, not a problem with
  // this fixture. The binding path under test is about MEMBERSHIP, not roles.
  const user = await fixture.ownerPool.query<{ id: string }>(
    `INSERT INTO "auth_user" ("name", "email", "emailVerified", "role")
     VALUES ('Org Tester', $1, true, 'player') RETURNING "id"`,
    [email],
  );
  const userId = user.rows[0]?.id ?? "";

  await fixture.ownerPool.query(
    `INSERT INTO "auth_session" ("expiresAt", "token", "userId")
     VALUES (now() + interval '1 hour', $1, $2)`,
    [token, userId],
  );
  await fixture.ownerPool.query(
    `INSERT INTO public.person_credential_link ("person_id", "user_id") VALUES ($1, $2)`,
    [PERSON, userId],
  );
}

describe("auth_active_orgs_for_token", () => {
  it("returns the organisation an ACTIVE membership proves", async () => {
    // The call itself is the assertion. The function's RETURN type says
    // `display_name text, slug text`; the columns it reads are
    // `varchar(200)` and `varchar(64)`. A plpgsql function refuses that
    // mismatch at call time, and the refusal is the whole bug.
    await fixture.ownerPool.query(
      `INSERT INTO public.organization ("id", "slug", "display_name") VALUES ($1, 'raptor', 'Raptor Esports')`,
      [ORG_A],
    );
    await sessionFor("org-a@example.invalid", "token-a");
    await fixture.ownerPool.query(
      `INSERT INTO public.org_membership ("person_id", "org_id", "status") VALUES ($1, $2, 'active')`,
      [PERSON, ORG_A],
    );

    const result = await fixture.appPool.query<{ org_id: string; display_name: string; slug: string }>(
      "SELECT org_id, display_name, slug FROM auth_active_orgs_for_token($1)",
      ["token-a"],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.org_id).toBe(ORG_A);
    expect(result.rows[0]?.display_name).toBe("Raptor Esports");
    expect(result.rows[0]?.slug).toBe("raptor");
  });

  it("returns nothing for a membership that is not active", async () => {
    await fixture.ownerPool.query(
      `INSERT INTO public.organization ("id", "slug", "display_name") VALUES ($1, 'raptor', 'Raptor Esports')`,
      [ORG_A],
    );
    await sessionFor("org-b@example.invalid", "token-b");
    await fixture.ownerPool.query(
      `INSERT INTO public.org_membership ("person_id", "org_id", "status") VALUES ($1, $2, 'revoked')`,
      [PERSON, ORG_A],
    );

    const result = await fixture.appPool.query(
      "SELECT org_id FROM auth_active_orgs_for_token($1)",
      ["token-b"],
    );

    expect(result.rows).toHaveLength(0);
  });

  it("returns nothing for a session with no person behind it", async () => {
    const result = await fixture.appPool.query(
      "SELECT org_id FROM auth_active_orgs_for_token($1)",
      ["no-such-token"],
    );

    expect(result.rows).toHaveLength(0);
  });
});

describe("auth_set_active_org", () => {
  it("binds the organisation the membership proves, and writes it to the session", async () => {
    await fixture.ownerPool.query(
      `INSERT INTO public.organization ("id", "slug", "display_name") VALUES ($1, 'raptor', 'Raptor Esports')`,
      [ORG_A],
    );
    await sessionFor("set-a@example.invalid", "token-set-a");
    await fixture.ownerPool.query(
      `INSERT INTO public.org_membership ("person_id", "org_id", "status") VALUES ($1, $2, 'active')`,
      [PERSON, ORG_A],
    );

    const bound = await fixture.appPool.query<{ set: boolean }>("SELECT auth_set_active_org($1, $2) AS set", [
      "token-set-a",
      ORG_A,
    ]);
    expect(bound.rows[0]?.set).toBe(true);

    const stored = await fixture.ownerPool.query<{ orgId: string | null }>(
      `SELECT "orgId" FROM "auth_session" WHERE "token" = 'token-set-a'`,
    );
    expect(stored.rows[0]?.orgId ?? null).toBe(ORG_A);
  });

  it("refuses an organisation the session has no membership in", async () => {
    await fixture.ownerPool.query(
      `INSERT INTO public.organization ("id", "slug", "display_name") VALUES ($1, 'other', 'Other')`,
      [ORG_B],
    );
    await sessionFor("set-b@example.invalid", "token-set-b");
    await fixture.ownerPool.query(
      `INSERT INTO public.org_membership ("person_id", "org_id", "status") VALUES ($1, $2, 'active')`,
      [PERSON, ORG_A],
    );

    const bound = await fixture.appPool.query<{ set: boolean }>("SELECT auth_set_active_org($1, $2) AS set", [
      "token-set-b",
      ORG_B,
    ]);
    expect(bound.rows[0]?.set).toBe(false);

    const stored = await fixture.ownerPool.query<{ orgId: string | null }>(
      `SELECT "orgId" FROM "auth_session" WHERE "token" = 'token-set-b'`,
    );
    expect(stored.rows[0]?.orgId ?? null).toBeNull();
  });
});
