/**
 * The four defects from the red-team security review, as named assertions.
 *
 * Each of the four was REPRODUCED against a real PGlite instance built from the
 * migration files before anything was changed (`scripts/security-review-repro.ts`
 * still reproduces all four, and still reports them resolved). This file is the
 * same set of checks in a form the suite runs on every change.
 *
 * WHY THE ASSERTIONS ARE SHAPED THE WAY THEY ARE
 * -----------------------------------------------
 *
 *   * **Every rejection is proved to be the mechanism that claims to be
 *     refusing, not merely some refusal.** A cross-tenant `role_assignment` must
 *     fail on the composite FOREIGN KEY; if it fails on an RLS policy instead,
 *     the schema would pass this test while the defect lived on in every context
 *     where RLS is not in the way — which is every migration script, every
 *     maintenance job, and every owner connection. So the FK cases run as the
 *     SCHEMA OWNER, and assert on the constraint name in the error.
 *
 *   * **A policy that refuses everything passes a naive test.** Each isolation
 *     test therefore runs both directions: org A must be unable to touch org B,
 *     AND org A must still be able to do the same operation to itself. The
 *     positive half is not a formality — a `WITH CHECK (false)` policy, or a
 *     REVOKE that was too broad, would satisfy the negative half alone.
 *
 *   * **"No rows" and "no error" are different answers.** RLS filters a
 *     cross-tenant UPDATE to zero rows and raises nothing at all. Every
 *     cross-tenant write below is therefore checked with `RETURNING` and then
 *     re-read AS THE OWNER, because what matters is whether the row changed, not
 *     whether the statement complained.
 *
 * ENVIRONMENT NOTES THIS FILE IS WRITTEN AROUND
 * ---------------------------------------------
 *   * `ALTER TABLE ... DROP POLICY` is a parse-level failure in this PGlite
 *     build, so the policy assertions read `pg_policies` rather than try to
 *     remove anything.
 *   * PGlite returns `timestamptz` to Node as HOST-timezone `Date` objects. Any
 *     instant compared here is cast to text IN SQL. Whole ISO literals only:
 *     PostgreSQL silently parses a malformed ISO string into a wrong-but-valid
 *     instant, so a concatenated literal would pass an assertion meaning nothing.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migrateUp } from "./migrations.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

const PERSON_A = "aaaaaaaa-0000-0000-0000-000000000001";
const PERSON_B = "bbbbbbbb-0000-0000-0000-000000000002";
const ROLE_A = "0c000000-0000-0000-0000-000000000001";
const ROLE_B = "0c000000-0000-0000-0000-000000000002";

/** A whole ISO instant. Never built by concatenation — see the file header. */
const INSTANT = "2026-05-04T18:00:00Z";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await migrateUp(db);
});

beforeEach(async () => {
  await asOwner("SELECT set_config('app.org_id', '', false)");
  await asOwner(`
    TRUNCATE audit_log, outbox_event, role_assignment, role_scope_rule, role_permission,
             role, engagement, org_membership, person CASCADE;
    DELETE FROM organization;
  `);
  await asOwner(`
    INSERT INTO organization (id, slug, display_name, default_currency, status)
    VALUES ('${ORG_A}', 'org-a', 'Org A', 'INR', 'active'),
           ('${ORG_B}', 'org-b', 'Org B', 'USD', 'active');

    INSERT INTO person (id, external_ref) VALUES
      ('${PERSON_A}', 'p-a'),
      ('${PERSON_B}', 'p-b');

    INSERT INTO org_membership (org_id, person_id, status, joined_at) VALUES
      ('${ORG_A}', '${PERSON_A}', 'active', '${INSTANT}'),
      ('${ORG_B}', '${PERSON_B}', 'active', '${INSTANT}');

    INSERT INTO role (id, org_id, key, name) VALUES
      ('${ROLE_A}', '${ORG_A}', 'coach_a', 'Coach A'),
      ('${ROLE_B}', '${ORG_B}', 'owner_b', 'Owner B');
  `);
});

/** Run as the schema owner, which bypasses RLS. Reflection and seeding only. */
async function asOwner(sql: string): Promise<void> {
  await db.exec("RESET ROLE");
  await db.exec("SELECT set_config('app.org_id', '', false)");
  await db.exec(sql);
}

async function ownerRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asOwner("");
  const found = await db.query<T>(sql, params);
  return found.rows;
}

/** Run `fn` as `raptor_app` with `app.org_id` set, or deliberately blank. */
async function asApp(fn: () => Promise<void>, orgId?: string): Promise<void> {
  await asOwner("");
  await db.exec("SET ROLE raptor_app");
  if (orgId === undefined) await db.exec("SELECT set_config('app.org_id', '', false)");
  else await db.exec(`SET app.org_id = '${orgId}'`);
  try {
    await fn();
  } finally {
    await db.exec("RESET ROLE");
    await db.exec("SELECT set_config('app.org_id', '', false)");
  }
}

// =============================================================================
// CRITICAL-1 — THE THREE ROLE REFERENCES ARE COMPOSITE
// =============================================================================

describe("CRITICAL-1 — a tenant cannot grant one of its people another tenant's role", () => {
  it("reflects every role reference as composite and leading with org_id", async () => {
    // Three tables, one shape of defect. Asserted from `pg_constraint` rather
    // than read out of the migration, because a list in a comment is a claim and
    // a constraint in the catalogue is a fact.
    const found = await ownerRows<{ table_name: string; def: string }>(`
      SELECT c.relname AS table_name, pg_get_constraintdef(k.oid) AS def
        FROM pg_constraint k
        JOIN pg_class c   ON c.oid = k.conrelid
        JOIN pg_class p   ON p.oid = k.confrelid
       WHERE k.contype = 'f'
         AND p.relname = 'role'
         AND c.relname IN ('role_permission', 'role_scope_rule', 'role_assignment')
       ORDER BY c.relname
    `);

    expect(found).toHaveLength(3);
    for (const row of found) {
      const keyColumns = /\(([^)]*)\)\s*REFERENCES/.exec(row.def)?.[1] ?? "";
      const columns = keyColumns.split(",").map((c) => c.trim());
      expect(columns, `${row.table_name} → role: ${row.def}`).toEqual(["org_id", "role_id"]);
    }
  });

  it("preserves the ON DELETE behaviour each of the three had before", async () => {
    // Not a detail. CASCADE on a grant and RESTRICT on an assignment are
    // different decisions: deleting a role must delete what it may do, and must
    // be REFUSED while somebody holds it, because a silently deleted grant is an
    // authority nobody decided to remove. Composite-ising a foreign key must not
    // quietly change either of those.
    const found = await ownerRows<{ table_name: string; def: string }>(`
      SELECT c.relname AS table_name, pg_get_constraintdef(k.oid) AS def
        FROM pg_constraint k
        JOIN pg_class c ON c.oid = k.conrelid
        JOIN pg_class p ON p.oid = k.confrelid
       WHERE k.contype = 'f'
         AND p.relname = 'role'
         AND c.relname IN ('role_permission', 'role_scope_rule', 'role_assignment')
       ORDER BY c.relname
    `);

    const byTable = Object.fromEntries(found.map((r) => [r.table_name, r.def]));
    expect(byTable["role_permission"]).toContain("ON DELETE CASCADE");
    expect(byTable["role_scope_rule"]).toContain("ON DELETE CASCADE");
    expect(byTable["role_assignment"]).toContain("ON DELETE RESTRICT");
  });

  it("REJECTS a cross-tenant role_assignment by the composite FK ITSELF, as the schema owner", async () => {
    // This is the assertion CRITICAL-1 turns on, and the role it runs as is the
    // point. Run as `raptor_app`, an RLS policy would hide org B's role and the
    // insert would be refused for the wrong reason — which is why the whole test
    // suite was green while the defect shipped. Run as the OWNER, RLS is out of
    // the way entirely, so only the schema can refuse.
    await expect(
      asOwner(`
        INSERT INTO role_assignment (org_id, person_id, role_id, valid_from)
        VALUES ('${ORG_A}', '${PERSON_A}', '${ROLE_B}', '${INSTANT}')
      `),
    ).rejects.toThrow(/role_assignment_role_org_id_fkey/);

    // Same tenant, same operation: ACCEPTED. Without this the assertion would be
    // satisfied by a constraint that refuses everything.
    await asOwner(`
      INSERT INTO role_assignment (org_id, person_id, role_id, valid_from)
      VALUES ('${ORG_A}', '${PERSON_A}', '${ROLE_A}', '${INSTANT}')
    `);
    const rows = await ownerRows<{ org_id: string }>(
      "SELECT org_id FROM role_assignment WHERE person_id = $1",
      [PERSON_A],
    );
    expect(rows).toHaveLength(1);
  });

  it("rejects the same reference in role_permission and role_scope_rule, as the owner", async () => {
    // The other two of the three. They were the same defect with the same blast
    // radius — a role_permission row in org A pointing at org B's role is org A
    // deciding what org B's role may do — so all three are exercised.
    //
    // A REAL permission row first, because `role_permission` also carries a
    // foreign key on `permission_id` and PostgreSQL checks constraints in
    // catalogue order: with a made-up permission id the test would have been
    // refused by the OTHER constraint and would have passed while proving
    // nothing about the one it names.
    const permission = await ownerRows<{ id: string }>(
      `INSERT INTO permission (key, resource, action)
       VALUES ('probe.k', 'probe', 'read') RETURNING id`,
    );
    const permissionId = permission[0]!.id;

    await expect(
      asOwner(`
        INSERT INTO role_permission (org_id, role_id, permission_id)
        VALUES ('${ORG_A}', '${ROLE_B}', '${permissionId}')
      `),
    ).rejects.toThrow(/role_permission_role_org_id_fkey/);

    await expect(
      asOwner(`
        INSERT INTO role_scope_rule (org_id, role_id, scope_type)
        VALUES ('${ORG_A}', '${ROLE_B}', 'organization')
      `),
    ).rejects.toThrow(/role_scope_rule_role_org_id_fkey/);

    // ... and the same-tenant form of each still works.
    await asOwner(`
      INSERT INTO role_permission (org_id, role_id, permission_id)
      VALUES ('${ORG_A}', '${ROLE_A}', '${permissionId}');
      INSERT INTO role_scope_rule (org_id, role_id, scope_type)
      VALUES ('${ORG_A}', '${ROLE_A}', 'organization');
    `);
    const counts = await ownerRows<{ permissions: number; rules: number }>(`
      SELECT (SELECT count(*) FROM role_permission  WHERE org_id = '${ORG_A}')::int AS permissions,
             (SELECT count(*) FROM role_scope_rule  WHERE org_id = '${ORG_A}')::int AS rules
    `);
    expect(counts).toEqual([{ permissions: 1, rules: 1 }]);
  });
});

// =============================================================================
// CRITICAL-2 — `organization` IS ROW-LEVEL SECURED
// =============================================================================

describe("CRITICAL-2 — a tenant sees and writes only its own organisation row", () => {
  it("is ENABLED and FORCED, so the owner cannot opt out either", async () => {
    const found = await ownerRows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
      SELECT relrowsecurity, relforcerowsecurity
        FROM pg_class
       WHERE relname = 'organization' AND relnamespace = 'public'::regnamespace
    `);
    expect(found).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it("states the tenant predicate and nothing else — no IS NULL branch, no OR true", async () => {
    // A predicate that cannot be false is not a policy. The rendered definition
    // is asserted as text because a future migration could keep the policy name
    // and quietly widen the expression underneath it.
    const found = await ownerRows<{ qual: string; with_check: string }>(`
      SELECT coalesce(pg_get_expr(polqual, polrelid), '')    AS qual,
             coalesce(pg_get_expr(polwithcheck, polrelid), '') AS with_check
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
       WHERE p.polname = 'organization_tenant_isolation'
         AND c.relname = 'organization'
    `);
    expect(found).toHaveLength(1);
    const expression = `${found[0]!.qual} ${found[0]!.with_check}`.replace(/\s+/g, " ").trim();
    expect(expression).toContain("current_org_id()");
    expect(expression).not.toMatch(/\bOR\b/i);
    expect(expression).not.toMatch(/\bIS NULL\b/i);
    expect(expression).not.toMatch(/\btrue\b/i);
  });

  it("hides another tenant's row from SELECT", async () => {
    await asApp(async () => {
      const other = await db.query<{ slug: string }>(
        "SELECT slug FROM organization WHERE slug = 'org-b'",
      );
      expect(other.rows, "org-a must not be able to read org-b").toEqual([]);

      const own = await db.query<{ slug: string }>("SELECT slug FROM organization");
      expect(own.rows.map((r) => r.slug)).toEqual(["org-a"]);
    }, ORG_A);
  });

  it("updates zero rows of another tenant, and the owner's own row proves it was never touched", async () => {
    // RETURNING rather than an exception, because RLS filters the UPDATE to zero
    // rows silently. Then the owner's view is the authority on whether anything
    // changed — a test that trusted "no error" would call this fixed on the day
    // it started being fixed.
    await asApp(async () => {
      const updated = await db.query<{ slug: string }>(
        `UPDATE organization SET status = 'closed' WHERE slug = 'org-b' RETURNING slug`,
      );
      expect(updated.rows).toEqual([]);
    }, ORG_A);

    const truth = await ownerRows<{ slug: string; status: string }>(
      "SELECT slug, status::text AS status FROM organization ORDER BY slug",
    );
    expect(truth).toEqual([
      { slug: "org-a", status: "active" },
      { slug: "org-b", status: "active" },
    ]);
  });

  it("denies the application role DELETE outright, before RLS is even consulted", async () => {
    // `raptor_app` does not hold DELETE on `organization` at all, so the statement
    // is refused by the privilege check. That is the first of two lines of defence
    // and it is asserted here so the second one below is not the only thing
    // standing between a tenant and somebody else's tenant root.
    const granted = await ownerRows<{ privilege_type: string }>(
      `SELECT privilege_type
         FROM information_schema.role_table_grants
        WHERE grantee = 'raptor_app' AND table_schema = 'public'
          AND table_name = 'organization' AND privilege_type = 'DELETE'`,
    );
    expect(granted).toEqual([]);

    await asApp(async () => {
      await expect(
        db.exec("DELETE FROM organization WHERE slug = 'org-b'"),
      ).rejects.toThrow(/permission denied for table organization/);
    }, ORG_A);
  });

  it("deletes zero rows of another tenant even when the privilege IS granted", async () => {
    // The second line, tested by handing `raptor_app` the privilege for the
    // duration of this one test and then taking it straight back. Without this,
    // a future migration that re-granted DELETE would pass on the strength of the
    // REVOKE alone, and the RLS policy — the thing that is supposed to make
    // cross-tenant writes impossible — would never have been exercised.
    await asOwner("GRANT DELETE ON organization TO raptor_app");
    try {
      await asApp(async () => {
        const deleted = await db.query<{ slug: string }>(
          `DELETE FROM organization WHERE slug = 'org-b' RETURNING slug`,
        );
        expect(deleted.rows, "the policy must block the delete, not the privilege").toEqual([]);
      }, ORG_A);

      // ... and the same-tenant delete still reaches the policy, which allows it.
      // Proving the positive half is what makes the negative half meaningful: a
      // policy that refused everything would pass the assertion above.
      await asApp(async () => {
        const deleted = await db.query<{ slug: string }>(
          `DELETE FROM organization WHERE slug = 'org-a' RETURNING slug`,
        );
        expect(deleted.rows.map((r) => r.slug)).toEqual(["org-a"]);
      }, ORG_A);
    } finally {
      await asOwner("REVOKE DELETE ON organization FROM raptor_app");
      await asOwner(`
        INSERT INTO organization (id, slug, display_name, default_currency, status)
        VALUES ('${ORG_A}', 'org-a', 'Org A', 'INR', 'active')
        ON CONFLICT (id) DO NOTHING
      `);
    }

    const remaining = await ownerRows<{ slug: string }>(
      "SELECT slug FROM organization ORDER BY slug",
    );
    expect(remaining).toEqual([{ slug: "org-a" }, { slug: "org-b" }]);
  });

  it("still lets a tenant read and update ITS OWN row", async () => {
    // The other direction. A policy that refused everything would satisfy every
    // isolation assertion above and leave the product unusable.
    await asApp(async () => {
      const own = await db.query<{ slug: string }>(
        "SELECT slug, status::text AS status FROM organization",
      );
      expect(own.rows).toEqual([{ slug: "org-a", status: "active" }]);

      const updated = await db.query<{ status: string }>(
        `UPDATE organization SET status = 'suspended' WHERE slug = 'org-a' RETURNING status::text AS status`,
      );
      expect(updated.rows).toEqual([{ status: "suspended" }]);
    }, ORG_A);

    const truth = await ownerRows<{ slug: string; status: string }>(
      "SELECT slug, status::text AS status FROM organization ORDER BY slug",
    );
    expect(truth).toEqual([
      { slug: "org-a", status: "suspended" },
      { slug: "org-b", status: "active" },
    ]);
  });

  it("reads nothing at all when no tenant is set", async () => {
    // The fail-closed direction. `current_org_id()` is NULL, and `id = NULL` is
    // not true, so an unset context reads zero organisations.
    await asApp(async () => {
      const rows = await db.query("SELECT id FROM organization");
      expect(rows.rows).toEqual([]);
    });
  });

  it("refuses a plain INSERT from the application role", async () => {
    // The policy would refuse it too, but the REVOKE is what makes the answer
    // stable: onboarding is a provisioning operation, and the assertion is on the
    // privilege rather than on the policy so that widening the policy later does
    // not quietly reopen it.
    const grants = await ownerRows<{ privilege_type: string }>(
      `SELECT privilege_type
         FROM information_schema.role_table_grants
        WHERE grantee = 'raptor_app'
          AND table_schema = 'public'
          AND table_name = 'organization'
          AND privilege_type IN ('INSERT', 'DELETE')
        ORDER BY privilege_type`,
    );
    expect(grants).toEqual([]);

    await expect(
      asApp(async () => {
        await db.exec(
          `INSERT INTO organization (slug, display_name, default_currency) VALUES ('forged', 'Forged', 'INR')`,
        );
      }, ORG_A),
    ).rejects.toThrow();
  });
});

// =============================================================================
// CRITICAL-2, THE ONBOARDING HALF — `provision_organization`
// =============================================================================

describe("CRITICAL-2 — onboarding still works, through a narrow function", () => {
  it("denies PUBLIC and grants only raptor_app", async () => {
    const found = await ownerRows<{ public_exec: boolean; app_exec: boolean }>(`
      SELECT has_function_privilege('public', p.oid, 'EXECUTE')      AS public_exec,
             has_function_privilege('raptor_app', p.oid, 'EXECUTE')  AS app_exec
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'provision_organization'
    `);
    expect(found).toEqual([{ public_exec: false, app_exec: true }]);
  });

  it("is SECURITY DEFINER with an empty search_path and no organisation argument", async () => {
    const found = await ownerRows<{ prosecdef: boolean; search_path: string; nargs: number }>(`
      SELECT p.prosecdef,
             coalesce(array_to_string(p.proconfig, ','), '') AS search_path,
             p.pronargs AS nargs
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'provision_organization'
    `);
    expect(found).toHaveLength(1);
    expect(found[0]!.prosecdef).toBe(true);
    // `search_path=`, quoted exactly as PostgreSQL renders it. A definer function
    // whose search_path is not pinned is a function that resolves its own names
    // through whoever is calling it.
    expect(found[0]!.search_path).toContain("search_path=");
    expect(found[0]!.search_path).toContain('""');
    // The id is generated inside the function, so a caller cannot name a tenant.
    expect(found[0]!.nargs).toBe(3);
  });

  it("creates the organisation, satisfies its own policy, and seeds the tenant's state machines", async () => {
    let created: string | undefined;
    await asApp(async () => {
      created = await db.query<{ id: string }>(
        "SELECT public.provision_organization('new-org', 'New Org', 'INR') AS id",
      ).then((r) => r.rows[0]!.id);
    });

    expect(created).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const row = await ownerRows<{ slug: string; status: string }>(
      "SELECT slug, status::text AS status FROM organization WHERE id = $1",
      [created],
    );
    expect(row).toEqual([{ slug: "new-org", status: "provisioning" }]);

    // The AFTER INSERT seeding triggers fired. They are SECURITY DEFINER and
    // insert into tenant tables whose policies require `org_id =
    // current_org_id()` — which is exactly why the provisioning function sets the
    // session tenant before inserting rather than relying on the owner to bypass
    // RLS. An organisation born with no state machine is one where every legal
    // move is refused.
    const seeded = await ownerRows<{ task_transitions: number; commercial: number; operations: number }>(`
      SELECT
        (SELECT count(*) FROM task_state_transition     WHERE org_id = $1)::int AS task_transitions,
        (SELECT count(*) FROM content_state_transition  WHERE org_id = $1)::int AS commercial,
        (SELECT count(*) FROM partner_state_transition  WHERE org_id = $1)::int AS operations
    `, [created]);
    for (const value of Object.values(seeded[0]!)) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it("restores the caller's tenant context, so provisioning cannot repoint the session", async () => {
    // The dangerous version of this bug is a provisioning failure that leaves the
    // session pointing at an organisation that does not exist, turning a duplicate
    // slug into a confusing failure for every request that follows.
    //
    // Read INSIDE the `asApp` wrapper, because the wrapper clears the context on
    // the way out — reading afterwards would have measured the harness rather than
    // the function, and passed either way.
    await asApp(async () => {
      await db.exec("SELECT public.provision_organization('ctx-org', 'Ctx Org', 'INR')");
      const context = await db.query<{ org_id: string }>(
        "SELECT public.current_org_id() AS org_id",
      );
      expect(context.rows).toEqual([{ org_id: ORG_A }]);
    }, ORG_A);

    // ... and the same after a failure.
    await asApp(async () => {
      await expect(
        db.exec("SELECT public.provision_organization('ctx-org', 'Duplicate', 'INR')"),
      ).rejects.toThrow(/duplicate key/);

      const context = await db.query<{ org_id: string }>(
        "SELECT public.current_org_id() AS org_id",
      );
      expect(context.rows, "a failed provisioning must not repoint the session")
        .toEqual([{ org_id: ORG_A }]);
    }, ORG_A);
  });

  it("refuses a duplicate slug without leaving a half-created organisation", async () => {
    await asApp(async () => {
      await db.exec("SELECT public.provision_organization('dup', 'One', 'INR')");
    });
    await asApp(async () => {
      await expect(
        db.exec("SELECT public.provision_organization('dup', 'Two', 'INR')"),
      ).rejects.toThrow();
    });

    const rows = await ownerRows<{ slug: string; display_name: string }>(
      "SELECT slug, display_name FROM organization WHERE slug = 'dup'",
    );
    expect(rows).toEqual([{ slug: "dup", display_name: "One" }]);
  });
});

// =============================================================================
// HIGH-2 — PLATFORM-LEVEL ROWS BELONG TO THE SYSTEM ROLE
// =============================================================================

describe("HIGH-2 — a NULL-org row is the system's, never a tenant's", () => {
  beforeEach(async () => {
    // One platform row, written the legitimate way, by the role that owns it.
    await asOwner(`
      INSERT INTO audit_log (org_id, actor_type, action_class, action)
      VALUES (NULL, 'system', 'platform', 'relay.started');
      INSERT INTO outbox_event (org_id, topic, payload, actor_type, dedupe_key)
      VALUES (NULL, 'platform', '{}'::jsonb, 'system', 'probe-platform-1');
    `);
  });

  it("gives the tenant policy no IS NULL branch and the system policy one, by name", async () => {
    const found = await ownerRows<{ tablename: string; policyname: string; qual: string; roles: string[] }>(`
      SELECT c.relname AS tablename,
             p.polname AS policyname,
             coalesce(pg_get_expr(p.polqual, p.polrelid), '') AS qual,
             -- polroles is {0} for PUBLIC. Rendered through regrole[] that comes
             -- back as the literal '-', which reads like a dash rather than a
             -- meaning, so the OID is compared instead.
             CASE WHEN p.polroles = ARRAY[0]::oid[] THEN ARRAY['public']::text[]
                  ELSE p.polroles::regrole[]::text[] END AS roles
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname IN ('audit_log', 'outbox_event')
         AND p.polname IN ('audit_log_tenant_isolation', 'outbox_event_tenant_isolation',
                            'audit_log_system_scope',     'outbox_event_system_scope')
       ORDER BY c.relname, p.polname
    `);

    expect(found.map((r) => `${r.tablename}.${r.policyname}`)).toEqual([
      "audit_log.audit_log_system_scope",
      "audit_log.audit_log_tenant_isolation",
      "outbox_event.outbox_event_system_scope",
      "outbox_event.outbox_event_tenant_isolation",
    ]);

    for (const row of found) {
      const isTenantPolicy = row.policyname.endsWith("tenant_isolation");
      if (isTenantPolicy) {
        // An unqualified policy applies to PUBLIC. Scoping it to a role would be a
        // narrower rule than 0001 gave every tenant table, and `raptor_app` would
        // fall through to no policy at all — which reads as "denied" rather than
        // "filtered", and would quietly change what an unset context returns.
        expect(row.roles, "the tenant policy must be unqualified so it applies to raptor_app")
          .toEqual(["public"]);
        expect(row.qual, `${row.policyname} must be the tenant predicate alone`).not.toMatch(
          /IS NULL/i,
        );
        expect(row.qual, `${row.policyname} must be the tenant predicate alone`).toContain(
          "current_org_id()",
        );
      } else {
        expect(row.roles, "the system scope must name the system role").toEqual(["raptor_system"]);
        expect(row.qual, `${row.policyname} carries the IS NULL branch`).toMatch(/IS NULL/i);
      }
    }
  });

  it("reads ZERO rows with no tenant set", async () => {
    await asApp(async () => {
      for (const table of ["audit_log", "outbox_event"]) {
        const found = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        expect(found.rows[0]!.n, `${table} with no tenant set`).toBe(0);
      }
    });
  });

  it("refuses a tenant's attempt to INSERT a NULL-org row", async () => {
    await asApp(async () => {
      await expect(
        db.exec(`
          INSERT INTO audit_log (org_id, actor_type, action_class, action)
          VALUES (NULL, 'user', 'auth', 'forged')
        `),
      ).rejects.toThrow(/row-level security/);
    }, ORG_A);

    await asApp(async () => {
      await expect(
        db.exec(`
          INSERT INTO outbox_event (org_id, topic, payload, actor_type, dedupe_key)
          VALUES (NULL, 'forged', '{}'::jsonb, 'user', 'probe-forged-1')
        `),
      ).rejects.toThrow(/row-level security/);
    }, ORG_B);

    const forged = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action IN ('forged')",
    );
    expect(forged[0]!.n).toBe(0);
  });

  it("never shows a tenant another tenant's rows, nor a platform row", async () => {
    // The forging half of the original defect: the tenant that forged a NULL-org
    // row did not get to keep it, but every OTHER tenant could read it. Asserted
    // for a tenant that did not write anything, which is the reader who was
    // harmed.
    await asApp(async () => {
      const found = await db.query<{ action: string }>(
        "SELECT action FROM audit_log WHERE action = 'relay.started'",
      );
      expect(found.rows, "org-b must not read a platform row").toEqual([]);
    }, ORG_B);

    // And the tenant's own rows still work, both directions.
    await asApp(async () => {
      await db.exec(`
        INSERT INTO audit_log (org_id, actor_type, action_class, action)
        VALUES ('${ORG_A}', 'user', 'auth', 'probe.own')
      `);
      const found = await db.query<{ action: string }>("SELECT action FROM audit_log");
      expect(found.rows.map((r) => r.action)).toEqual(["probe.own"]);
    }, ORG_A);
  });

  it("gives the system role the NULL-org branch and nothing more than that role has", async () => {
    // `raptor_system` exists precisely so the IS NULL branch has an owner. It is
    // NOLOGIN (granted to, never assumed by a request handler), not superuser,
    // and does not bypass RLS — a system write is a different SCOPE, not a higher
    // privilege.
    const roles = await ownerRows<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(`
      SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'raptor_system'
    `);
    expect(roles).toEqual([
      { rolname: "raptor_system", rolsuper: false, rolbypassrls: false, rolcanlogin: false },
    ]);

    await asOwner("SELECT set_config('app.org_id', '', false)");
    await db.exec("SET ROLE raptor_system");
    try {
      await db.exec(`
        INSERT INTO audit_log (org_id, actor_type, action_class, action)
        VALUES (NULL, 'system', 'platform', 'probe.by.system');
      `);
      const found = await db.query<{ action: string }>(
        "SELECT action FROM audit_log WHERE action = 'probe.by.system'",
      );
      expect(found.rows.map((r) => r.action)).toEqual(["probe.by.system"]);

      // And it may ALSO write a row for the tenant in its context, which is what
      // makes this a scope rather than a separate lane: one system actor, two
      // reachable scopes, neither of them anybody else's.
      await db.exec("SET app.org_id = '11111111-1111-1111-1111-111111111111'");
      await db.exec(`
        INSERT INTO audit_log (org_id, actor_type, action_class, action)
        VALUES ('11111111-1111-1111-1111-111111111111', 'system', 'platform', 'probe.by.system.tenanted');
      `);
      const tenanted = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_log WHERE action = 'probe.by.system.tenanted'",
      );
      expect(tenanted.rows[0]!.n).toBe(1);
    } finally {
      await db.exec("RESET ROLE");
    }

    const written = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'probe.by.system'",
    );
    expect(written[0]!.n).toBe(1);
  });
});

// =============================================================================
// MEDIUM-1 — NO SECURITY DEFINER FUNCTION IS REACHABLE BY PUBLIC
// =============================================================================

describe("MEDIUM-1 — a SECURITY DEFINER function is not callable by PUBLIC", () => {
  it("revokes EXECUTE from PUBLIC on the three 0011 functions", async () => {
    const found = await ownerRows<{ proname: string; args: string; public_exec: boolean }>(`
      SELECT p.proname,
             pg_get_function_identity_arguments(p.oid) AS args,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('portability_export_document', 'portability_import_document',
                           'portability_person_closure')
       ORDER BY p.proname
    `);

    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const row of found) {
      expect(row.public_exec, `${row.proname}(${row.args}) is PUBLIC-executable`).toBe(false);
    }
  });

  it("removes the caller-chosen organisation argument from the person closure", async () => {
    // The grant was never the whole of MEDIUM-1. `portability_person_closure(uuid)`
    // took the organisation FROM THE CALLER, so revoking PUBLIC while leaving the
    // parameter would have left any tenant that could call it able to name any
    // other tenant. The shape is fixed: no argument at all, tenant from the
    // session, exactly as `portability_export_document` already worked.
    const found = await ownerRows<{ proname: string; nargs: number; argnames: string }>(`
      SELECT p.proname, p.pronargs AS nargs, coalesce(p.proargnames::text, '') AS argnames
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'portability_person_closure'
    `);

    expect(found, "the one-argument overload must be GONE, not merely revoked").toEqual([
      { proname: "portability_person_closure", nargs: 0, argnames: "" },
    ]);
  });

  it("gives the anonymous raptor_public role nothing, and a cross-tenant caller nothing", async () => {
    // `raptor_public` is the role the red team actually used. It holds SELECT on
    // two views and EXECUTE on one function (0009), and nothing else — so these
    // two calls are the whole of its reach into this area.
    await asOwner("SELECT set_config('app.org_id', '', false)");

    await db.exec("SET ROLE raptor_public");
    try {
      await expect(
        db.query("SELECT public.portability_person_closure()"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query("SELECT public.portability_export_document()"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("RESET ROLE");
    }

    // A tenant WITH the grant, calling with no tenant set: refused by the
    // function, because an empty array is indistinguishable from "this
    // organisation has no people".
    await asApp(async () => {
      await expect(db.query("SELECT public.portability_person_closure()")).rejects.toThrow(
        /no tenant is set/,
      );
    });
  });

  it("gives a tenant only its OWN closure, and a cross-tenant ask is no longer expressible", async () => {
    // The membership rows from the fixture already name one person per tenant,
    // and `org_membership` is one of the tables the closure walks.
    const own = await closureFor(ORG_A);
    expect(own).toContain(PERSON_A);
    expect(own, "org-a must not receive org-b's person").not.toContain(PERSON_B);

    // The signature has no parameter, so there is nothing left to try. The only
    // way to reach org B's roster is to be org B.
    const other = await closureFor(ORG_B);
    expect(other).toContain(PERSON_B);
    expect(other, "org-b must not receive org-a's person").not.toContain(PERSON_A);
  });
});

/** The person closure as `raptor_app`, resolved as `orgId`. */
async function closureFor(orgId: string): Promise<string[]> {
  let closure: string[] = [];
  await asApp(async () => {
    const found = await db.query<{ closure: string[] }>(
      "SELECT public.portability_person_closure() AS closure",
    );
    closure = found.rows[0]!.closure;
  }, orgId);
  return closure;
}