// Reproduction of the red-team findings, run against a real PGlite instance
// built from the actual migration files.
//
// This exists so the claims in the security review can be re-checked rather
// than taken on trust, exactly as ADR-0015 requires of any environment claim.
// It reproduces; it does not fix. The fixes live in migration 0013.
//
// Every probe reports what it OBSERVED, not merely whether an exception was
// thrown. That distinction is the whole reason this script exists for two of the
// four findings: RLS filters a cross-tenant UPDATE to zero rows without raising
// anything, so "no error" and "did not happen" are different answers, and a
// probe built on `try { ... } catch { ... }` would have called the leak fixed
// on the day it started being fixed. Where the pre-existing version of a probe
// did exactly that, it is called out in a comment below.
//
// The named assertions in `src/security_review.isolation.test.ts` cover the same
// four findings and are what the suite runs.

import { PGlite } from "@electric-sql/pglite";
import { migrateUp } from "../src/migrations.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

const db = await PGlite.create();
await migrateUp(db);

const seed = `
  INSERT INTO organization (id, slug, display_name, default_currency, status) VALUES
    ('${ORG_A}', 'org-a', 'Org A', 'INR', 'active'),
    ('${ORG_B}', 'org-b', 'Org B', 'USD', 'active');

  INSERT INTO person (id, external_ref) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'p-a'),
    ('bbbbbbbb-0000-0000-0000-000000000002', 'p-b');

  INSERT INTO org_membership (org_id, person_id, status, joined_at) VALUES
    ('${ORG_A}', 'aaaaaaaa-0000-0000-0000-000000000001', 'active', now()),
    ('${ORG_B}', 'bbbbbbbb-0000-0000-0000-000000000002', 'active', now());

  INSERT INTO role (id, org_id, key, name) VALUES
    ('0c000000-0000-0000-0000-000000000001', '${ORG_A}', 'coach_a', 'Coach A'),
    ('0c000000-0000-0000-0000-000000000002', '${ORG_B}', 'owner_b', 'Owner B');

  INSERT INTO audit_log (org_id, actor_type, actor_id, action_class, action, resource_type, resource_id)
    VALUES ('${ORG_A}', 'user', 'aaaaaaaa-0000-0000-0000-000000000001', 'auth', 'test.login', 'person', 'x');

  -- A platform-level row: the system actor's legitimate use of the nullable
  -- org_id. Whether a TENANT can read or forge one of these is the question.
  INSERT INTO audit_log (org_id, actor_type, action_class, action)
    VALUES (NULL, 'system', 'platform', 'test.platform');
`;
await db.exec(seed);

// The application role, exactly as 0001 grants it.
await db.exec(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raptor_app') THEN
      CREATE ROLE raptor_app LOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$;
  GRANT USAGE ON SCHEMA public TO raptor_app;
`);
await db.exec(`
  DO $$
  DECLARE t text;
  BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO raptor_app', t);
    END LOOP;
  END $$;
`);

const findings: Array<[string, string]> = [];

// ---- CRITICAL-1: cross-tenant role assignment through a single-column FK ----
await db.exec(`SET app.org_id = '${ORG_A}'; SET ROLE raptor_app;`);
let critical1: string;
try {
  await db.exec(`
    INSERT INTO role_assignment (org_id, person_id, role_id, valid_from)
    VALUES ('${ORG_A}', 'aaaaaaaa-0000-0000-0000-000000000001',
            '0c000000-0000-0000-0000-000000000002', now());
  `);
  // The insert was accepted. Now prove what it produced: does an assignment in
  // org A now name a role that belongs to org B? Check as the OWNER, so RLS
  // cannot mask the answer either way.
  await db.exec('RESET ROLE');
  const r = await db.query(
    `SELECT ra.org_id AS assignment_org, r.org_id AS role_owner_org, r.key AS role_key
     FROM role_assignment ra JOIN role r ON r.id = ra.role_id
     WHERE ra.org_id = '${ORG_A}'`,
  );
  if (r.rows.length === 0) {
    critical1 = 'ACCEPTED but no row readable - inconclusive, investigate';
  } else if (r.rows[0].assignment_org !== r.rows[0].role_owner_org) {
    critical1 = `ACCEPTED - org ${r.rows[0].assignment_org} holds a grant on role "${r.rows[0].role_key}" owned by org ${r.rows[0].role_owner_org}`;
  } else {
    critical1 = 'accepted but same-org reference only - not a leak';
  }
} catch (error) {
  critical1 = `RESOLVED - database refused the cross-tenant grant: ${String(error.message).slice(0, 60)}`;
}
findings.push(['CRITICAL-1 cross-tenant role_assignment', critical1]);
await db.exec(`SET app.org_id = '${ORG_A}'; SET ROLE raptor_app;`);

// ---- CRITICAL-2: organization readable/writable cross-tenant ----
//
// The previous version of this probe reported BLOCKED as soon as the SELECT
// returned no rows, and then appended "UPDATE another tenant SUCCEEDED" purely
// because the UPDATE statement did not raise. Under RLS that UPDATE matches
// zero rows and raises nothing, so the probe would have declared the leak gone
// while org-b was one policy change away from being closed again. Both halves
// are therefore measured, and the owner's view of org-b's status is the
// authority on whether anything actually changed.
await db.exec(`SET app.org_id = '${ORG_A}'; SET ROLE raptor_app;`);
const readOther = await db.query(`SELECT slug FROM organization WHERE slug = 'org-b'`);
const updated = await db.query(
  `UPDATE organization SET status = 'closed' WHERE slug = 'org-b' RETURNING slug`,
);
const updatedOwn = await db.query(
  `UPDATE organization SET status = 'active' WHERE slug = 'org-a' RETURNING slug`,
);
await db.exec('RESET ROLE');
const truth = await db.query<{ slug: string; status: string }>(
  `SELECT slug, status::text AS status FROM organization ORDER BY slug`,
);

const leakedRead = readOther.rows.length;
const leakedWrite = updated.rows.length;
const ownWriteWorks = updatedOwn.rows.length === 1;
const orgBClosed = truth.rows.find((r) => r.slug === "org-b")?.status === "closed";

const critical2 =
  leakedRead === 0 && leakedWrite === 0 && !orgBClosed
    ? `RESOLVED - org-b invisible to org-a (${leakedRead} rows), ${leakedWrite} rows updated, org-b still ${truth.rows.find((r) => r.slug === "org-b")?.status}` +
      (ownWriteWorks ? "; org-a can still update itself" : "; OWN UPDATE ALSO BROKEN")
    : `READ ANOTHER TENANT: ${leakedRead} rows | UPDATE another tenant ${leakedWrite === 0 ? "matched" : "SUCCEEDED"} rows | org-b is now ${truth.rows.find((r) => r.slug === "org-b")?.status}`;
findings.push(['CRITICAL-2 organization readable/writable cross-tenant', critical2]);

// ---- HIGH-2: rows visible with no tenant context set ----
await db.exec('RESET ROLE');
const rlsState = await db.query(
  `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('organization','audit_log','outbox_event')
    ORDER BY c.relname`,
);
for (const row of rlsState.rows) {
  findings.push([
    `RLS state: ${row.relname}`,
    `enabled=${row.relrowsecurity} forced=${row.relforcerowsecurity}`,
  ]);
}

// The previous version of this probe was labelled "with app.org_id unset" but
// never unset it: CRITICAL-1's recovery path had left `SET app.org_id` at ORG_A
// in place, so it counted rows belonging to ORG_A and called that a NULL-org
// leak. Clearing the context is the whole point of this finding, so it is now
// cleared explicitly rather than inherited from whatever ran before.
await db.exec(`SELECT set_config('app.org_id', '', false)`);
await db.exec(`SET ROLE raptor_app`);
const unsetRows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log');
let forged: string;
try {
  await db.exec(`
    INSERT INTO audit_log (org_id, actor_type, action_class, action)
    VALUES (NULL, 'user', 'auth', 'test.forged')
  `);
  forged = 'ACCEPTED - tenant wrote a NULL-org row';
} catch (error) {
  forged = `refused: ${String(error.message).slice(0, 45)}`;
}
await db.exec('RESET ROLE');

// ... and does the forged row show up in ANOTHER tenant's read?
await db.exec(`SET app.org_id = '${ORG_B}'; SET ROLE raptor_app;`);
const crossRead = await db.query(
  `SELECT action FROM audit_log WHERE action IN ('test.platform', 'test.forged')`,
);
await db.exec('RESET ROLE');

const leaked = unsetRows.rows[0]?.n ?? 0;
const forgedVisible = crossRead.rows.some((r) => r.action === "test.forged");
const platformVisible = crossRead.rows.some((r) => r.action === "test.platform");
const high2 =
  leaked === 0 && !forgedVisible && forged.startsWith("refused")
    ? `RESOLVED - 0 rows with no tenant set; ${forged}; org-b sees no platform or forged rows`
    : `LEAKED ${leaked} audit_log rows with no tenant set | ${forged} | org-b sees ${crossRead.rows.length} NULL-org rows (platform=${platformVisible}, forged=${forgedVisible})`;
findings.push(['HIGH-2 audit_log with app.org_id unset', high2]);

// ---- MEDIUM-1: SECURITY DEFINER functions executable by PUBLIC ----
await db.exec('RESET ROLE');
const fns = await db.query(
  `SELECT p.proname, pg_catalog.array_to_string(p.proargnames, ',') AS args,
          p.prosecdef AS security_definer,
          pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
    ORDER BY p.proname`,
);
const publicDefiner = fns.rows.filter((r) => r.public_exec);
findings.push([
  'MEDIUM-1 SECURITY DEFINER fns executable by PUBLIC',
  publicDefiner.length === 0
    ? 'RESOLVED - none; all revoked'
    : publicDefiner.map((r) => `${r.proname}(${r.args})`).join(', '),
]);

await db.close();

for (const [name, detail] of findings) {
  // `console` is banned outside warn/error by the repo's ESLint config, and a
  // report has no error condition to report.
  process.stdout.write(`${name}\n    ${detail}\n`);
}