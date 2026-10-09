// TEMPORARY probe — deleted before the change is finished.
import { writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const out: string[] = [];
const say = (s: string): void => {
  out.push(s);
};

try {
  await db.exec(`
    CREATE TABLE probe (
      id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
      n integer, b bigint, t timestamptz, ts timestamp, j jsonb,
      arr text[], num numeric(10,2), bool boolean, nul text
    );
  `);

  const ins = await db.query(
    `INSERT INTO probe (n, b, t, ts, j, arr, num, bool, nul)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7, $8, $9) RETURNING *`,
    [42, 9007199254740993n, new Date("2030-01-02T03:04:05.000Z"), "2030-01-02 03:04:05", { a: 1 }, ["x", "y"], "12.34", true, null],
  );
  const r = ins.rows[0] as Record<string, unknown>;
  say("types: " + Object.entries(r).map(([k, v]) => `${k}=${v === null ? "null" : `${typeof v}:${String(v)}`}`).join(", "));

  const raw = await db.query("SELECT count(*)::int AS c, now() AS nw, 'UPDATE' as command");
  const rr = raw.rows[0] as Record<string, unknown>;
  say(`raw keys: ${Object.keys(raw).join(",")} | c=${typeof rr["c"]} nwIsDate=${rr["nw"] instanceof Date}`);

  // transaction via raw SQL
  await db.exec("BEGIN");
  await db.query("INSERT INTO probe (n) VALUES ($1)", [1]);
  const inTx = await db.query("SELECT count(*)::int AS c FROM probe");
  say(`in-tx count: ${String((inTx.rows[0] as Record<string, unknown>)["c"])}`);
  await db.exec("COMMIT");
  say(`post-commit count: ${String(((await db.query("SELECT count(*)::int AS c FROM probe")).rows[0] as Record<string, unknown>)["c"])}`);

  // rollback after an error inside the transaction
  await db.exec("BEGIN");
  try { await db.query("SELECT 1/0"); } catch (e) { say(`div0: code=${(e as {code?:string}).code}`); }
  try { await db.query("SELECT 1"); say("post-abort query OK (unexpected)"); }
  catch (e) { say(`post-abort threw: ${(e as { message: string }).message.split("\n")[0]}`); }
  await db.exec("ROLLBACK");
  say(`post-rollback count: ${String(((await db.query("SELECT count(*)::int AS c FROM probe")).rows[0] as Record<string, unknown>)["c"])}`);

  // unique violation shape
  try {
    await db.query(`INSERT INTO probe (id, n) VALUES ($1, 1)`, [String(r["id"])]);
    say("dup NOT rejected");
  } catch (e) {
    const err = e as { code?: string; message?: string; constraint?: string };
    say(`dup: code=${err.code} constraint=${err.constraint} msg=${(err.message ?? "").split("\n")[0]}`);
  }

  // check violation shape (mfa trigger uses ERRCODE 23514)
  await db.exec(`CREATE TABLE chk (a int CHECK (a > 0))`);
  try {
    await db.exec(`INSERT INTO chk (a) VALUES (-1)`);
    say("chk NOT rejected");
  } catch (e) {
    const err = e as { code?: string };
    say(`chk: code=${err.code}`);
  }

  // multi-statement exec: DO block error surfaces
  try {
    await db.exec(`DO $$ BEGIN RAISE EXCEPTION 'boom' USING ERRCODE='23514'; END $$;`);
    say("DO not thrown");
  } catch (e) {
    const err = e as { code?: string; message?: string };
    say(`DO: code=${err.code} msg=${(err.message ?? "").split("\n")[0]}`);
  }

  // multi-statement exec success
  await db.exec(`CREATE TABLE m1 (a int); CREATE TABLE m2 (b int);`);
  say("multi-statement exec ok");

  // RETURNING single column
  say(`returning id: ${JSON.stringify((await db.query(`INSERT INTO probe (n) VALUES ($1) RETURNING "id"`, [7])).rows[0])}`);

  // rowCount / affectedRows for select & delete
  const sel = await db.query("SELECT 1 AS x");
  say(`select affectedRows=${sel.affectedRows} rowCount=${String(sel.rowCount)} fields=${String(sel.fields?.length)}`);
  const del = await db.query("DELETE FROM probe WHERE n = $1", [7]);
  say(`delete affectedRows=${del.affectedRows} rowCount=${String(del.rowCount)} command=${String((del as unknown as {command?:string}).command)}`);

  // RETURNING with a WHERE that matches nothing
  const none = await db.query(`DELETE FROM probe WHERE n = 999999 RETURNING id`);
  say(`delete-none rows=${none.rows.length} affected=${none.affectedRows}`);

  // does PGlite support `SET ROLE` for a NOSUPERUSER role + does RESET ROLE work?
  await db.exec(`CREATE ROLE probe_app LOGIN NOSUPERUSER NOBYPASSRLS`);
  await db.exec(`CREATE TABLE rls_t (id int primary key, org text)`);
  await db.exec(`ALTER TABLE rls_t ENABLE ROW LEVEL SECURITY`);
  await db.exec(`ALTER TABLE rls_t FORCE ROW LEVEL SECURITY`);
  await db.exec(`CREATE POLICY p ON rls_t USING (org = nullif(current_setting('app.org_id', true), ''))`);
  await db.exec(`INSERT INTO rls_t VALUES (1, 'A'), (2, 'B')`);
  await db.exec(`GRANT SELECT ON rls_t TO probe_app`);
  await db.exec("SET ROLE probe_app");
  const me = await db.query("select current_user as u, session_user as s");
  say(`set role: ${JSON.stringify(me.rows[0])}`);
  say(`no ctx: ${JSON.stringify((await db.query("select id from rls_t")).rows)}`);
  await db.exec("SELECT set_config('app.org_id', 'A', false)");
  say(`ctx A: ${JSON.stringify((await db.query("select id from rls_t")).rows)}`);
  await db.exec("RESET ROLE");
  const back = await db.query("select current_user as u");
  say(`after reset: ${JSON.stringify(back.rows[0])} ctx still=${JSON.stringify((await db.query("select current_setting('app.org_id', true) as v")).rows[0])}`);
  say(`owner sees: ${JSON.stringify((await db.query("select id from rls_t")).rows)}`);

  // SET LOCAL inside explicit transaction then ROLLBACK — does the GUC revert?
  await db.exec("BEGIN");
  await db.exec("SET LOCAL app.org_id = 'A'");
  say(`in tx as owner with FORCE: ${JSON.stringify((await db.query("select id from rls_t")).rows)}`);
  await db.exec("COMMIT");
  say(`after commit GUC: ${JSON.stringify((await db.query("select coalesce(current_setting('app.org_id', true),'<null>') as v")).rows[0])}`);

  // pg_policies view present?
  say(`pg_policies rows: ${JSON.stringify((await db.query("select policyname from pg_policies where schemaname='public' and tablename='rls_t'")).rows)}`);

  // schema.sql-ish: does BEGIN/COMMIT via exec work when the file already has BEGIN?
  await db.exec(`BEGIN; CREATE TABLE txfile (a int); COMMIT;`);
  say("explicit BEGIN/COMMIT in exec: ok");

  // advisory / lock concurrency not tested (single session)
} catch (e) {
  say("FATAL: " + String((e as Error).message).slice(0, 400));
}

await db.close();
writeFileSync("scripts/tmp-probe-out.txt", out.join("\n") + "\n");
process.stdout.write(out.join("\n") + "\n");