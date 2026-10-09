// TEMPORARY probe 2 — deleted before the change is finished.
import { writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const out: string[] = [];
const say = (s: string): void => {
  out.push(s);
};

const attempt = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
    say(`${label}: OK`);
  } catch (e) {
    say(`${label}: THREW ${String((e as Error).message).split("\n")[0]}`);
  }
};

await db.exec(`CREATE ROLE raptor_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
await db.exec(`
  CREATE TABLE usr (id int primary key, email text);
  ALTER TABLE usr ENABLE ROW LEVEL SECURITY;
  CREATE POLICY usr_app_role_access ON usr USING (session_user = 'raptor_app') WITH CHECK (session_user = 'raptor_app');
  GRANT SELECT, INSERT, UPDATE, DELETE ON usr TO raptor_app;
  INSERT INTO usr VALUES (1, 'a@example.invalid');
`);

const probe = async (label: string): Promise<void> => {
  const who = await db.query("select current_user as cu, session_user as su");
  const rows = await db.query("select id from usr");
  say(`${label}: current_user=${String((who.rows[0] as Record<string, unknown>)["cu"])} session_user=${String((who.rows[0] as Record<string, unknown>)["su"])} visibleRows=${rows.rows.length}`);
};

await probe("owner");
await db.exec("SET ROLE raptor_app");
await probe("SET ROLE");
await db.exec("RESET ROLE");

await attempt("SET SESSION AUTHORIZATION", async () => {
  await db.exec("SET SESSION AUTHORIZATION raptor_app");
  await probe("SET SESSION AUTHORIZATION");
  await attempt("  RESET back", async () => {
    await db.exec("RESET SESSION AUTHORIZATION");
    await probe("  after reset");
  });
});

await attempt("SET SESSION AUTHORIZATION DEFAULT", async () => {
  await db.exec("SET SESSION AUTHORIZATION DEFAULT");
  await probe("DEFAULT");
});

await attempt("SET SESSION AUTHORIZATION inside tx", async () => {
  await db.exec("BEGIN");
  await db.exec("SET SESSION AUTHORIZATION raptor_app");
  await db.exec("COMMIT");
});

await attempt("set_config with param, session level", async () => {
  await db.query("SELECT set_config('app.org_id', $1, false)", ["11111111-1111-4111-8111-111111111111"]);
  const v = await db.query("select current_setting('app.org_id', true) as v");
  say(`  set_config -> ${String((v.rows[0] as Record<string, unknown>)["v"])}`);
  await db.exec("SELECT set_config('app.org_id', '', false)");
});

// Can a non-superuser session (after SESSION AUTHORIZATION) still be restored by a superuser?
say("---- final identity ----");
const who = await db.query("select current_user as cu, session_user as su, (select rolsuper from pg_roles where rolname = current_user) as is_super");
say(JSON.stringify(who.rows[0]));

// Does SET SESSION AUTHORIZATION revoke the ability to SET ROLE? (security-restricted op)
await db.exec("SET SESSION AUTHORIZATION raptor_app");
await attempt("SET ROLE while session auth = raptor_app", async () => {
  await db.exec("SET ROLE postgres");
  await probe("  after SET ROLE postgres");
});
await attempt("RESET SESSION AUTHORIZATION", async () => {
  await db.exec("RESET SESSION AUTHORIZATION");
  await probe("  restored");
});

await db.close();
writeFileSync("scripts/tmp-probe2-out.txt", out.join("\n") + "\n");
process.stdout.write(out.join("\n") + "\n");