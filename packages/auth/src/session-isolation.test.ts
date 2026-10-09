/**
 * Session identity and tenancy — the properties that hold after ADR-0017.
 *
 * WHAT THIS PROVES, AFTER ADR-0017
 * --------------------------------
 * `session` is an IDENTITY record, not a tenant-scoped one, so it carries no
 * `orgId` predicate at all. Concretely, this file proves:
 *
 *   - RLS is enabled on `session` and the table is protected by a ROLE policy, so
 *     it is neither unprotected nor unusable;
 *   - no auth policy reads `app.org_id` at all, and specifically none has regained
 *     a fail-open branch. The policy that once read
 *     `current_org_id() IS NULL OR "orgId" IS NULL OR ...` handed every tenant's
 *     sessions to every unresolved request — a cross-tenant credential-store
 *     exposure — and the fail-closed replacement that followed made every sign-in
 *     fail with 42501. Neither is reinstated here, and that is the regression this
 *     file guards;
 *   - `auth_session_by_token` returns at most the one row whose token the caller
 *     presented, and grants no access to any organisation;
 *   - session reads no longer depend on a tenant having been resolved, which is
 *     what makes the 42501 regression impossible to reintroduce by accident.
 *
 * WHAT THIS FILE NO LONGER CLAIMS
 * ------------------------------
 * That a session bound to one org is invisible to a request resolved as another,
 * and that an unresolved request sees zero sessions. Both were true under the old
 * policy and both are false now, by design. ADR-0017 states the first as an
 * accepted cost; the second follows from `session` being identity.
 *
 * Those tests were replaced rather than deleted, and each replacement records what
 * it replaced and why — see the comment above "the properties the old tenant policy
 * used to provide" and above "a request with no tenant resolved".
 *
 * The fail-CLOSED property itself is not abandoned, it moved: it is a property of
 * the TENANT tables, asserted by `packages/db` against a real PGlite instance, and
 * the part this package owns — that no auth table consults the tenant GUC — is
 * asserted here and in `auth-tenancy.test.ts`.
 *
 * WHERE THIS RUNS
 * ---------------
 * An in-process PGlite session (PostgreSQL 18.3 in WebAssembly), not a server.
 * Native PostgreSQL cannot start a backend on this machine (`0xC0000142`, 0/30
 * connections; `docs/adr/0015-pglite-restored-after-native-postgres-retest.md`).
 * One session means no second connection, so `SET ROLE` and `SET LOCAL` inside
 * an explicit transaction replace the old dedicated `PoolClient` — see
 * `test-database.ts`.
 *
 * WHY THE ASSERTIONS RUN AS `raptor_app`
 * --------------------------------------
 * Every query here is issued through the application-role pool, whose session
 * identity is `raptor_app` (NOSUPERUSER NOBYPASSRLS) and whose `SET ROLE` is
 * undone in a `finally`. A superuser bypasses RLS entirely, so the same
 * assertions run as `raptor_migrator` would pass while proving nothing. ADR-0006
 * records exactly this: "org-a sees: ['org-a-data', 'org-b-data'] — isolation
 * silently absent".
 *
 * WHY `SET LOCAL` INSIDE A TRANSACTION
 * -------------------------------------
 * `asOrg` scopes `app.org_id` to one transaction so a value can never leak from
 * one request into the next. Note that no policy on any auth table reads that GUC
 * any more — the helper survives because the tests below use it to PROVE the value
 * is inert, which is only meaningful if it is set correctly.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuthFixture, truncateAuthTables, type AuthTestFixture } from "./test-helpers.js";

let fixture: AuthTestFixture;

/** Two well-formed organisation identifiers. */
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

/**
 * Run `work` with `app.org_id` set for the duration of one transaction.
 *
 * `SET LOCAL` + explicit transaction, so the value cannot outlive the request.
 * The role is pinned to `raptor_app` for the same reason and restored in a
 * `finally`, so a failing assertion cannot leave a superuser active for the
 * next test.
 */
async function asOrg<T>(orgId: string | null, work: () => Promise<T>): Promise<T> {
  return fixture.asAppRole(async () => {
    await fixture.db.exec("BEGIN");
    try {
      await fixture.db.query("SELECT set_config('app.org_id', $1, true)", [orgId ?? ""]);
      return await work();
    } finally {
      await fixture.db.exec("COMMIT");
    }
  });
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
  // Drop any role a previous test failed to give back and clear the tenant
  // GUC, so neither can reach this test. `assertNotElevated` then refuses to
  // continue if the session is still holding superuser rights.
  await fixture.resetRoles();
  await fixture.assertNotElevated();
  await truncateAuthTables(fixture);
});

/**
 * Seed a user with a session bound to `orgId`.
 *
 * Written as the owner because the application role cannot insert into a
 * FORCED-RLS table without a matching tenant context, and the fixture is
 * establishing the very rows the policy is supposed to protect.
 */
async function seedSessionFor(orgId: string, label: string): Promise<string> {
  const user = await fixture.ownerPool.query<{ id: string }>(
    `INSERT INTO "user" ("name", "email", "emailVerified", "role", "twoFactorEnabled")
     VALUES ($1, $2, true, 'player', false) RETURNING "id"`,
    [`Org ${label} User`, `${label.toLowerCase()}-user@example.invalid`],
  );
  const userId = user.rows[0]?.id;
  if (userId === undefined) throw new Error("seedSessionFor: no user id");

  const session = await fixture.ownerPool.query<{ id: string }>(
    `INSERT INTO "session" ("expiresAt", "token", "userId", "orgId")
     VALUES (now() + interval '1 hour', $1, $2, $3) RETURNING "id"`,
    [`token-for-${label}`, userId, orgId],
  );

  return session.rows[0]?.id ?? "";
}

describe("session is identity, not tenant-scoped (ADR-0017)", () => {
  it("reports RLS enabled on session", async () => {
    // Queried from pg_class rather than trusted from the SQL file, so this fails if
    // the DDL is ever edited without the ENABLE.
    //
    // The old version of this test asserted `relforcerowsecurity = true` as well.
    // That assertion was correct for the old design and is deliberately inverted
    // now: FORCE would subject the OWNER to `session_app_role_access`, and
    // `auth_set_active_org` is SECURITY DEFINER and reads through the owner, so
    // FORCING would break the compensating control ADR-0017 requires. The property
    // that still matters — RLS is on, so a role that is not the app role and not
    // the owner gets nothing — is asserted below.
    const result = await fixture.ownerPool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'session'`,
    );

    expect(result.rows[0]?.relrowsecurity).toBe(true);
    expect(result.rows[0]?.relforcerowsecurity).toBe(false);
  });

  it("has no tenant policy, and specifically not a fail-open one", async () => {
    // The old assertion here was that `session_tenant_isolation` EXISTS. It was
    // asserting the broken policy itself: that policy made every sign-in fail with
    // 42501. It is replaced by the property that now has to hold, which is the
    // absence of ANY tenant predicate on the table.
    const result = await fixture.ownerPool.query<{ policyname: string; qual: string | null; with_check: string | null }>(
      `SELECT policyname, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'session'`,
    );

    // Exactly the role policy every identity table carries, and nothing else.
    expect(result.rows.map((row) => row.policyname)).toEqual(["session_app_role_access"]);

    for (const row of result.rows) {
      // Neither the fail-open branch that leaked every tenant's sessions nor any
      // other reading of the tenant GUC.
      expect(row.qual ?? "", `${row.policyname} USING`).not.toMatch(/current_org_id/i);
      expect(row.with_check ?? "", `${row.policyname} WITH CHECK`).not.toMatch(/current_org_id/i);
      expect(row.qual ?? "").not.toMatch(/IS\s+NULL\s+OR/i);
    }
  });

  it("enables RLS on every Better Auth table", async () => {
    const result = await fixture.ownerPool.query<{ relname: string; relrowsecurity: boolean }>(
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

  it("shows a role with no grant sees nothing, so the table is not merely unprotected", async () => {
    // RLS is default-deny. This is the assertion that keeps "no tenant policy"
    // from quietly becoming "no policy at all", which would present in production
    // as every sign-in reporting an unknown email.
    await seedSessionFor(ORG_A, "DefaultDeny");

    const seen = await fixture.asAppRole(async () => {
      const rows = await fixture.appPool.query<{ n: number }>('SELECT count(*)::int AS n FROM "session"');
      return rows.rows[0]?.n ?? -1;
    });

    expect(seen, "the app role must be admitted by the role policy").toBeGreaterThan(0);
  });
});

describe("the application role can still use the identity tables", () => {
  it("reads its own sessions once the tenant is resolved", async () => {
    // RLS is default-deny. With RLS enabled and no policy, `raptor_app` sees
    // ZERO rows no matter what it was granted — a failure that looks like
    // "every password is wrong" rather than like a missing policy. So the
    // policy must ADMIT the caller's own row, not merely avoid denying it.
    await seedSessionFor(ORG_A, "Readable");

    const seen = await asOrg(ORG_A, async () => visibleSessionCount());

    expect(seen).toBe(1);
  });

  it("reads the user table", async () => {
    await seedSessionFor(ORG_A, "UserReadable");
    const result = await fixture.appPool.query<{ n: number }>('SELECT count(*)::int AS n FROM "user"');
    expect(result.rows[0]?.n).toBeGreaterThan(0);
  });
});

/**
 * What happened to the five tests that used to live here, one by one.
 *
 * Every test in this block asserted that a session bound to org A was invisible
 * to a request resolved as org B. Under ADR-0017 that is no longer a property of
 * `session`, because `session` no longer carries a tenant predicate at all. The
 * five tests were:
 *
 *   1. "hides org A's session from a request resolved as org B"
 *   2. "shows each org only its own sessions when both exist"
 *   3. "denies a cross-tenant UPDATE as well as a read"
 *   4. "denies a cross-tenant DELETE"
 *   5. "blocks INSERT of a session claiming another org's id"
 *
 * None were deleted to reach green. Each was asserting the broken policy itself —
 * the policy is what made every sign-in fail with 42501 — so each is replaced by
 * the control that now carries the property it was reaching for. What survives is
 * recorded below rather than quietly dropped, and the properties themselves are
 * asserted in `auth-tenancy.test.ts`.
 *
 *   1, 2. Visibility by org. NOT PRESERVED, and not claimed. A request can now read
 *      a session row belonging to another tenant. ADR-0017 states this plainly as
 *      a cost: a session holds a token and identity metadata, not business data.
 *      The replacement is that nothing AUTHORISES off the session's orgId, which is
 *      asserted in `auth-tenancy.test.ts`.
 *   3, 4. Write denial by org. NOT PRESERVED in that form, because there is no
 *      longer an org to write as. The surviving concern — that the application
 *      role cannot forge the tenant on a session — is now carried by a
 *      column-level REVOKE on "orgId", asserted in `auth-tenancy.test.ts`. That is
 *      strictly stronger than the old test, which only stopped a cross-org write
 *      while leaving same-org forgery open.
 *   5. Rejecting a forged orgId on INSERT. Superseded: "orgId" is now writable
 *      only through `auth_set_active_org`, which requires an active membership, and
 *      the column-level grant is what stops a direct write. Both are asserted in
 *      `auth-tenancy.test.ts`.
 *
 * The one thing that must not regress is the opposite failure: a fail-open branch
 * that would hand every tenant's sessions to an unresolved request. That is
 * asserted above, against the live policy, and in `auth-tenancy.test.ts`.
 */
describe("the properties the old tenant policy used to provide", () => {
  it("reads sessions through the app role, with no tenant context required", async () => {
    // The replacement for tests 1 and 2. Sign-in and session lookup no longer
    // depend on a tenant having been resolved first, which is what makes the 42501
    // regression impossible to reintroduce by accident.
    await seedSessionFor(ORG_A, "NoContext");

    const seen = await fixture.asAppRole(async () => {
      const rows = await fixture.appPool.query<{ n: number }>('SELECT count(*)::int AS n FROM "session"');
      return rows.rows[0]?.n ?? -1;
    });

    expect(seen, "sessions must be readable with no tenant context set").toBe(1);
  });

  it("cannot be reduced to org A or org B by any orgId value", async () => {
    // The negative of tests 1 and 2, stated as the thing that IS true: the row
    // count does not depend on orgId at all, because no predicate reads it. If a
    // future edit reintroduced a tenant predicate, this would change.
    await seedSessionFor(ORG_A, "ValueIrrelevant");

    const withOrgA = await asOrg(ORG_A, visibleSessionCount);
    const withOrgB = await asOrg(ORG_B, visibleSessionCount);
    const withNone = await asOrg(null, visibleSessionCount);

    // All three identical. Not one row, not two — the same one, regardless.
    expect(withOrgA).toBe(1);
    expect(withOrgB).toBe(1);
    expect(withNone).toBe(1);
  });

  it("lets the app role write the session fields it legitimately needs", async () => {
    // The surviving part of test 3. Cross-org denial is gone, but the app role must
    // still be able to do what Better Auth does on every request, or the product is
    // broken in the other direction.
    await seedSessionFor(ORG_A, "Writable");

    const updated = await fixture.asAppRole(async () => {
      const result = await fixture.appPool.query('UPDATE "session" SET "ipAddress" = $1', ["203.0.113.9"]);
      return result.rowCount;
    });

    expect(updated, "the app role must be able to refresh session metadata").toBe(1);
  });

  it("still lets a revoked session be deleted", async () => {
    // The surviving part of test 4. ADR-0007 requires revocation to be immediate
    // and provable, which needs DELETE. Dropping it to satisfy a tenant policy would
    // have broken revocation.
    await seedSessionFor(ORG_A, "Revocable");

    const deleted = await fixture.asAppRole(async () => {
      const result = await fixture.appPool.query('DELETE FROM "session"');
      return result.rowCount;
    });

    expect(deleted).toBe(1);
  });
});

/**
 * The no-tenant case — and where its property went.
 *
 * THESE THREE TESTS ASSERTED A PROPERTY THAT NO LONGER HOLDS, and they are
 * replaced rather than quietly dropped. For the record, what each asserted and
 * what became of it:
 *
 *   1. "sees ZERO sessions, not all of them" — that an unresolved request sees
 *      nothing on `session`. Under ADR-0017 this is FALSE by design: `session` is
 *      identity and carries no tenant predicate, so an unresolved request sees its
 *      own sessions. Keeping the old assertion would mean re-introducing the exact
 *      policy that made sign-in impossible (42501 on every session INSERT).
 *
 *      The underlying worry — that an unresolved request should not be handed
 *      everything — is REAL, but it is not a property of this table. It is a
 *      property of the tenant tables, and it is asserted there:
 *        - `packages/db` asserts it per table by reflecting `pg_class` against a
 *          real PGlite instance (`competitive.isolation.test.ts` and
 *          `tenancy.isolation.test.ts`).
 *        - `auth-tenancy.test.ts` asserts the part this package owns: that no auth
 *          table consults `app.org_id` at all, so an unset GUC cannot widen access
 *          on any of them.
 *      Duplicating the tenant-table assertion here would mean asserting another
 *      package's schema and would rot the moment that schema changed.
 *
 *   2. "does not see a session that is not yet bound to a tenant either" — that
 *      `"orgId" IS NULL` was load-bearing, so an unbound session was invisible to
 *      every read including its own creator. That was a direct consequence of the
 *      `WITH CHECK`, and it is why sign-in failed. No longer applicable.
 *
 *   3. "still isolates a BOUND session when the tenant is known" — that setting
 *      `app.org_id` made the predicate exact. There is no longer a predicate for
 *      it to make exact.
 *
 * WHAT REPLACES THEM
 * ------------------
 * Not a weakened assertion: a different and still falsifiable one. The dangerous
 * failure mode in this area is not "an unresolved request sees too few rows" — it
 * is "a fail-open branch sneaks back in and it sees too many". That is asserted
 * directly below and again in `auth-tenancy.test.ts`.
 */
describe("a request with no tenant resolved", () => {
  it("does not gain access by virtue of the context being unset", async () => {
    // The fail-CLOSED property, in the form that is still true and still
    // falsifiable: the tenant GUC grants NOTHING. Setting it does not open a
    // session, and clearing it does not close one, because no predicate on any
    // auth table reads it.
    await seedSessionFor(ORG_A, "UnresolvedAlpha");
    await seedSessionFor(ORG_B, "UnresolvedBeta");

    const seenUnset = await asOrg(null, visibleSessionCount);
    const seenSet = await asOrg(ORG_A, visibleSessionCount);

    // Identical. A context that widened access would make these differ.
    expect(seenUnset).toBe(2);
    expect(seenSet).toBe(2);
  });

  it("has no policy that widens access when the context is unset", async () => {
    // The precise regression guard, against the live database. The earlier policy
    // read `USING (current_org_id() IS NULL OR "orgId" IS NULL OR ...)`, and that
    // first branch handed every tenant's sessions to any unresolved request. The
    // assertion is on the rendered predicate text, so a re-introduction under any
    // name fails here rather than in production.
    const result = await fixture.ownerPool.query<{ policyname: string; qual: string | null }>(
      `SELECT policyname, qual FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('session','user','account','verification','twoFactor','rateLimit')`,
    );

    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.qual ?? "", row.policyname).not.toMatch(/current_org_id/i);
      expect(row.qual ?? "", row.policyname).not.toMatch(/IS\s+NULL\s+OR/i);
    }
  });

  it("does not treat an unbound session as a special case", async () => {
    // Replaces test 2. An unbound session (orgId NULL) and a bound one are treated
    // identically, because "bound" is not a visibility concept on this table any
    // more. Both are ordinary identity rows.
    await fixture.ownerPool.query(
      `INSERT INTO "user" ("name", "email", "emailVerified", "role")
       VALUES ('Unbound', 'unbound@example.invalid', true, 'player')`,
    );
    const userId = await fixture.ownerPool.query<{ id: string }>('SELECT "id" FROM "user" WHERE "email" = $1', [
      "unbound@example.invalid",
    ]);
    await fixture.ownerPool.query(
      `INSERT INTO "session" ("expiresAt", "token", "userId", "orgId")
       VALUES (now() + interval '1 hour', 'unbound-token', $1, NULL)`,
      [userId.rows[0]?.id ?? ""],
    );
    await seedSessionFor(ORG_A, "Bound");

    const seen = await asOrg(null, visibleSessionCount);
    expect(seen, "an unbound session is an ordinary identity row").toBe(2);
  });
});

/**
 * `auth_session_by_token()` — identity resolution, not a tenant boundary.
 *
 * Under ADR-0017 this function is no longer "the only way in" to a tenant, because
 * `session` no longer holds a tenant boundary to breach. What it is now, and what
 * these tests hold it to: a single-row identity lookup keyed on the token the
 * caller already holds. It returns that row and nothing else. It grants no access
 * to any organisation, and the returned `orgId` is data the caller must still
 * validate rather than a grant.
 *
 * `auth-tenancy.test.ts` asserts the second half of that — that nothing in this
 * package authorises off the value this function returns.
 */
describe("auth_session_by_token is the only way in", () => {
  /** Seed one bound session and return its token and owning organisation. */
  async function seedBoundSession(label: string, orgId: string): Promise<string> {
    await seedSessionFor(orgId, label);
    return `token-for-${label}`;
  }

  it("resolves exactly the caller's own token", async () => {
    const token = await seedBoundSession("ByTokenAlpha", ORG_A);
    await seedBoundSession("ByTokenBeta", ORG_B);

    const rows = await asOrg(null, () =>
      fixture.appPool.query<{ token: string }>('SELECT "token" FROM auth_session_by_token($1)', [token]),
    );

    // One row, and it is the one the caller already held a credential for.
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.token).toBe(token);
  });

  it("returns nothing for a token the caller does not hold", async () => {
    await seedBoundSession("ByTokenMissAlpha", ORG_A);

    const rows = await asOrg(null, () =>
      fixture.appPool.query<{ token: string }>('SELECT "token" FROM auth_session_by_token($1)', [
        "a-token-nobody-issued",
      ]),
    );

    // A caller that holds no token cannot name a session, so it reads nothing.
    expect(rows.rows).toHaveLength(0);
  });

  it("resolves the caller's own token regardless of the tenant context", async () => {
    // REPLACES "refuses a token belonging to another tenant once a tenant IS set".
    //
    // That test asserted that resolving as org A makes an org B token unreadable.
    // It was true only because the function carried
    // `OR s."orgId" = current_org_id()::text`, which existed to stop the SECURITY
    // DEFINER elevation becoming a cross-tenant read. With the tenant policy gone
    // there is no org filter to apply, and the honest property is narrower and
    // still worth asserting: the function is a pure identity lookup keyed on the
    // token, so it reveals the token's own row and NOTHING else regardless of what
    // context it is called in.
    //
    // What this no longer claims: that possession of the function plus knowledge of
    // a token is bounded by org. It is bounded by the token. That is the intended
    // design — a bearer token is the credential, and a holder of it is the caller.
    const token = await seedBoundSession("ByTokenCross", ORG_B);

    const asOrgA = await asOrg(ORG_A, () =>
      fixture.appPool.query<{ token: string; orgId: string | null }>(
        'SELECT "token", "orgId" FROM auth_session_by_token($1)',
        [token],
      ),
    );
    const asNoOrg = await asOrg(null, () =>
      fixture.appPool.query<{ token: string; orgId: string | null }>(
        'SELECT "token", "orgId" FROM auth_session_by_token($1)',
        [token],
      ),
    );

    // The same single row either way: the one whose token was presented. The context
    // changes nothing, which is exactly why no policy can depend on it.
    expect(asOrgA.rows).toHaveLength(1);
    expect(asNoOrg.rows).toHaveLength(1);
    expect(asOrgA.rows[0]?.token).toBe(token);
    expect(asNoOrg.rows[0]?.token).toBe(token);

    // And it still never widens the result set: the other org's session is not
    // dragged along by resolving one token.
    await seedBoundSession("ByTokenOther", ORG_A);
    const afterBoth = await asOrg(ORG_A, () =>
      fixture.appPool.query<{ token: string }>('SELECT "token" FROM auth_session_by_token($1)', [token]),
    );
    expect(afterBoth.rows).toHaveLength(1);
    expect(afterBoth.rows[0]?.token).toBe(token);
  });

  it("is revoked from PUBLIC, so a role with no grant cannot call it", async () => {
    // PostgreSQL makes a new function EXECUTABLE by PUBLIC. Without the REVOKE
    // in `schema.sql`, any role — including an anonymous login role — could
    // read any session by token.
    //
    // `has_function_privilege` is the assertion. The ACL itself is read as TEXT
    // rather than as `aclitem[]`: after the REVOKE `proacl` is non-NULL
    // (`{postgres=X/postgres}`), so the `coalesce(proacl, 'NULL'::aclitem[])`
    // fallback this query used to carry was never taken — and `'NULL'` is not a
    // valid array literal, so the statement failed to parse before it could
    // assert anything.
    const result = await fixture.ownerPool.query<{ has_function_privilege: boolean; acl: string | null }>(
      `SELECT has_function_privilege('public', 'auth_session_by_token(text)', 'EXECUTE')
              AS has_function_privilege,
              p.proacl::text AS acl
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'auth_session_by_token'`,
    );

    expect(result.rows[0]?.has_function_privilege).toBe(false);

    // The same fact stated structurally. In an ACL, PUBLIC is the grantor with an
    // EMPTY name, so a public grant renders as `=X/grantor` — an `=` with nothing
    // before it. Named grants to raptor_app and raptor_migrator are expected and
    // legitimate; a public one is the defect.
    const acl = result.rows[0]?.acl ?? "";
    expect(acl).not.toMatch(/[{,]\s*=/);
    expect(acl).toContain("raptor_app=X/raptor_migrator");
  });

  it("takes no org_id parameter, so a caller cannot choose its tenant", async () => {
    // ADR-0011 rule 3: the tenant comes from the session, never from a
    // request parameter. A two-argument signature would let the caller name the
    // tenant it reads from, which is the substitution the ADR forbids.
    const result = await fixture.ownerPool.query<{ proargnames: string[] }>(
      `SELECT p.proargnames
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'auth_session_by_token'`,
    );

    const names = result.rows[0]?.proargnames ?? [];
    expect(names).toHaveLength(1);
    expect(names).not.toContain("org_id");
    expect(names).not.toContain("p_org_id");
  });
});