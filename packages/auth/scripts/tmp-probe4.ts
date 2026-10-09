// TEMPORARY probe 4 — deleted before the change is finished.
import { writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const out: string[] = [];
const say = (s: string): void => {
  out.push(s);
};

const db = new PGlite();

const who = async (label: string): Promise<void> => {
  const r = await db.query(
    "select current_user as cu, session_user as su, (select rolsuper from pg_roles where rolname = current_user) as super, (select rolbypassrls from pg_roles where rolname = current_user) as bypass",
  );
  const row = r.rows[0] as Record<string, unknown>;
  say(`${label}: cu=${String(row["cu"])} su=${String(row["su"])} super=${String(row["super"])} bypass=${String(row["bypass"])}`);
};

const attempt = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
    say(`${label}: OK`);
  } catch (e) {
    say(`${label}: THREW ${String((e as Error).message).split("\n")[0]}`);
  }
};

await attempt("roles", async () => {
  await db.exec(`CREATE ROLE raptor_migrator LOGIN SUPERUSER`);
  await db.exec(`CREATE ROLE raptor_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  await db.exec(`GRANT raptor_migrator TO raptor_app`);
});

await attempt("apply mini schema as raptor_migrator", async () => {
  await db.exec("SET ROLE raptor_migrator");
  await db.exec(`
    CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql STABLE SET search_path = '' AS $f$
      SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $f$;
    CREATE TABLE "user" (id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), email text NOT NULL UNIQUE);
    ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY user_app_role_access ON "user" USING (session_user = 'raptor_app') WITH CHECK (session_user = 'raptor_app');
    CREATE TABLE "session" (id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), token text NOT NULL UNIQUE, "userId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, "orgId" text);
    ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "session" FORCE ROW LEVEL SECURITY;
    CREATE POLICY session_tenant_isolation ON "session"
      USING (current_org_id() IS NOT NULL AND "orgId" = current_org_id()::text)
      WITH CHECK (current_org_id() IS NOT NULL AND "orgId" = current_org_id()::text);
    CREATE OR REPLACE FUNCTION auth_session_by_token(p_token text) RETURNS SETOF public."session"
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $f$
        SELECT s.* FROM public."session" s WHERE s."token" = p_token
          AND (public.current_org_id() IS NULL OR s."orgId" = public.current_org_id()::text) $f$;
    REVOKE ALL ON FUNCTION auth_session_by_token(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION auth_session_by_token(text) TO raptor_app;
    GRANT USAGE ON SCHEMA public TO raptor_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "user", "session" TO raptor_app;
  `);
  await db.exec("RESET ROLE");
});

await who("before session authorization");

await attempt("SET SESSION AUTHORIZATION raptor_app", async () => {
  await db.exec("SET SESSION AUTHORIZATION raptor_app");
  await who("after");
});

const withOwner = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await db.exec("SET ROLE raptor_migrator");
    await fn();
  } catch (e) {
    say(`${label}: THREW ${String((e as Error).message).split("\n")[0]}`);
  } finally {
    await db.exec("RESET ROLE");
  }
};

const withApp = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await db.exec("SET ROLE raptor_app");
    await fn();
  } catch (e) {
    say(`${label}: THREW ${String((e as Error).message).split("\n")[0]}`);
  } finally {
    await db.exec("RESET ROLE");
  }
};

await attempt("SET ROLE raptor_app from ambient raptor_app", async () => {
  await withApp("app", async () => {
    await who("  inside app");
  });
});

await withOwner("owner seeds", async () => {
  await db.query(`INSERT INTO "user" (email) VALUES ($1)`, ["seed@example.invalid"]);
  await db.query(
    `INSERT INTO "session" ("token", "userId", "orgId") SELECT $1, id, $2 FROM "user" WHERE email = $3`,
    ["tok-a", "11111111-1111-4111-8111-111111111111", "seed@example.invalid"],
  );
  say(`  owner seeded session rows: ${JSON.stringify((await db.query(`SELECT count(*)::int AS n FROM "session"`)).rows)}`);
});
await who("after owner write");

await withApp("app reads user", async () => {
  say(`  user rows: ${JSON.stringify((await db.query(`SELECT count(*)::int AS n FROM "user"`)).rows)}`);
});
await withApp("app reads session, no org", async () => {
  say(`  session rows: ${JSON.stringify((await db.query(`SELECT count(*)::int AS n FROM "session"`)).rows)}`);
});
await withApp("app reads session, org A", async () => {
  await db.exec(`SELECT set_config('app.org_id', '11111111-1111-4111-8111-111111111111', false)`);
  say(`  session rows: ${JSON.stringify((await db.query(`SELECT count(*)::int AS n FROM "session"`)).rows)}`);
  await db.exec(`SELECT set_config('app.org_id', '', false)`);
});
await withApp("app inserts session, no org", async () => {
  const u = await db.query(`SELECT id FROM "user" LIMIT 1`);
  await db.query(`INSERT INTO "session" ("token", "userId") VALUES ($1, $2)`, ["tok-new", (u.rows[0] as Record<string, unknown>)["id"]]);
  say("  INSERT SUCCEEDED");
});
await withApp("app inserts session, WITH org ctx", async () => {
  await db.exec(`SELECT set_config('app.org_id', '11111111-1111-4111-8111-111111111111', false)`);
  const u = await db.query(`SELECT id FROM "user" LIMIT 1`);
  await db.query(
    `INSERT INTO "session" ("token", "userId", "orgId") VALUES ($1, $2, '11111111-1111-4111-8111-111111111111')`,
    ["tok-new2", (u.rows[0] as Record<string, unknown>)["id"]],
  );
  say("  INSERT SUCCEEDED with org ctx");
  await db.exec(`SELECT set_config('app.org_id', '', false)`);
});
await withApp("app calls auth_session_by_token", async () => {
  const r = await db.query(`SELECT "token" FROM auth_session_by_token($1)`, ["tok-a"]);
  say(`  by-token rows: ${JSON.stringify(r.rows)}`);
});

// Prove FORCE RLS binds the owner too (so a non-superuser owner would be filtered).
await withOwner("owner read of session (superuser bypasses)", async () => {
  say(`  session rows: ${JSON.stringify((await db.query(`SELECT count(*)::int AS n FROM "session"`)).rows)}`);
});

// Does the app role have TRUNCATE? (it should not)
await withApp("app TRUNCATE", async () => {
  await db.query(`TRUNCATE TABLE "user", "session" CASCADE`);
  say("  TRUNCATE SUCCEEDED (unexpected)");
});

await db.close();
writeFileSync("scripts/tmp-probe4-out.txt", out.join("\n") + "\n");
process.stdout.write(out.join("\n") + "\n");