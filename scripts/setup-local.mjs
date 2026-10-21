#!/usr/bin/env node
// scripts/setup-local.mjs — one-command local setup on a native Postgres.
//
// What it does, in order, all idempotent (safe to re-run):
//   1. Creates the databases and roles from packages/db/scripts/local-bootstrap.sql
//   2. Runs the domain migrations (raptor_migrator)
//   3. Applies packages/auth/src/schema.sql (Better Auth tables) as raptor_migrator —
//      it is a deployment-time SQL asset, NOT a numbered db migration
//   4. Applies packages/cms/provision.sql, sets the cms_app local password
//   5. Runs the CMS migrations (cms_app)
//   6. Applies scripts/preview-seed.sql (tenant root + preview domain data)
//   7. Applies scripts/preview-seed-cms.sql (preview CONTENT: news, partners,
//      recruitment, site settings, socials, CMS operators)
//
// Connection: the local SUPERUSER is addressed through the standard PG*
// environment variables, defaulting to postgres/postgres on loopback. The
// script never prints a password. Keep local-bootstrap.sql, provision.sql and
// the local password constant below in sync by hand — this script EXECUTES
// those files rather than duplicating their logic.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LOCAL_PASSWORD = "raptor_local_dev_only";
const APP_DB = "raptor_os";

const host = process.env.PGHOST ?? "127.0.0.1";
const port = process.env.PGPORT ?? "5432";
const user = process.env.PGUSER ?? "postgres";
const password = process.env.PGPASSWORD ?? "postgres";

// `pg` is a dependency of @raptor/db; pnpm's strict layout means it resolves
// from there, not the repo root.
const requireFromDb = createRequire(path.join(repoRoot, "packages/db/package.json"));
const { Client } = requireFromDb("pg");

const step = (message) => console.log(`\n==> ${message}`);

function fail(message) {
  console.error(`\nsetup-local: ${message}`);
  process.exit(1);
}

function adminOptions(database) {
  return { host, port: Number(port), user, password, database, connectionTimeoutMillis: 5000 };
}

async function withAdmin(database, fn) {
  const client = new Client(adminOptions(database));
  try {
    await client.connect();
  } catch (error) {
    fail(
      `could not reach Postgres as "${user}" on ${host}:${port} (database "${database}"): ${error.message}. ` +
        `Is the service running? Set PGPASSWORD if the superuser password is not "postgres".`,
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Statement splitter for OUR migration files: handles `--` and block
 * comments, single-quoted strings ('' escapes), and dollar-quoted bodies
 * ($$ or $tag$ — the DO blocks), none of which a naive split(";") survives.
 * psql's `\gexec` terminator is surfaced as { gexec: true } because the
 * driver cannot execute it; the caller expands the two CREATE DATABASE
 * guards itself.
 */
function splitStatements(sql) {
  const statements = [];
  let current = "";
  let inLineComment = false;
  let inBlockComment = false;
  let inSingleQuote = false;
  let dollarTag = null;

  for (let i = 0; i < sql.length; i += 1) {
    const rest = sql.slice(i);
    if (inLineComment) {
      current += sql[i];
      if (sql[i] === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += rest.startsWith("*/") ? ((i += 1), "*/") : sql[i];
      if (rest.startsWith("*/")) inBlockComment = false;
      continue;
    }
    if (dollarTag !== null) {
      if (rest.startsWith(dollarTag)) {
        current += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += sql[i];
      }
      continue;
    }
    if (rest.startsWith("--")) {
      inLineComment = true;
      current += "--";
      i += 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      inBlockComment = true;
      current += "/*";
      i += 1;
      continue;
    }
    const dollar = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(rest);
    if (dollar !== null) {
      dollarTag = dollar[0];
      current += dollarTag;
      i += dollarTag.length - 1;
      continue;
    }
    if (sql[i] === "'" && !inSingleQuote) inSingleQuote = true;
    else if (sql[i] === "'" && inSingleQuote && sql[i + 1] === "'") {
      current += "''";
      i += 1;
      continue;
    } else if (sql[i] === "'" && inSingleQuote) inSingleQuote = false;

    if (sql[i] === ";" && !inSingleQuote) {
      if (current.trim() !== "") statements.push({ text: current.trim(), gexec: false });
      current = "";
      continue;
    }
    current += sql[i];

    // \gexec sits on its own line after a SELECT; treat it as a terminator.
    if (current.trimEnd().endsWith("\\gexec")) {
      statements.push({ text: current.replace(/\\gexec\s*$/, "").trim(), gexec: true });
      current = "";
    }
  }
  if (current.trim() !== "") statements.push({ text: current.trim(), gexec: false });
  return statements;
}

const TOLERATED = new Set([
  "42710", // duplicate_object (role exists)
  "42P04", // duplicate_database
  "42P07", // duplicate_table
  "42723", // duplicate column / constraint
]);

async function applyFile(client, file, { tolerate = TOLERATED } = {}) {
  const sql = readFileSync(path.join(repoRoot, file), "utf8");
  for (const statement of splitStatements(sql)) {
    if (statement.gexec) {
      // Anchor to the quoted literal: statement text can carry a leading
      // comment that mentions "CREATE DATABASE" in prose (local-bootstrap.sql
      // does: "CREATE DATABASE cannot run inside a DO block").
      const create = /CREATE DATABASE ([A-Za-z_][A-Za-z0-9_]*)'/.exec(statement.text);
      if (create !== null) {
        await ensureDatabase(client, create[1]);
      }
      continue;
    }
    try {
      await client.query(statement.text);
    } catch (error) {
      if (tolerate.has(error.code)) continue;
      throw error;
    }
  }
}

async function ensureDatabase(client, name) {
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (exists.rowCount === 0) {
    console.log(`   creating database ${name}`);
    await client.query(`CREATE DATABASE ${name}`);
  }
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) fail(`"${command} ${args.join(" ")}" failed with exit code ${result.status}`);
}

// ---------------------------------------------------------------------------

console.log("Raptor OS — local setup");
console.log(`Postgres ${host}:${port} as ${user}`);

step("1/7 bootstrap (databases, roles) — packages/db/scripts/local-bootstrap.sql");
await withAdmin("postgres", (client) =>
  applyFile(client, "packages/db/scripts/local-bootstrap.sql"),
);

const migrationUrl = `postgresql://raptor_migrator:${LOCAL_PASSWORD}@${host}:${port}/${APP_DB}`;
step("2/7 domain migrations (raptor_migrator)");
run("pnpm", ["--filter", "@raptor/db", "db:migrate"], { DATABASE_MIGRATION_URL: migrationUrl });

// Better Auth's persistence is a hand-written, deployment-time SQL asset
// (`packages/auth/src/schema.sql`), deliberately NOT part of the numbered
// migrations (see its header). Without it the web app logs
// "Database schema mismatch" and every sign-in fails. schema.sql wraps itself
// in BEGIN/COMMIT and is fully IF NOT EXISTS / OR REPLACE idempotent, so
// executing it verbatim on one connection converges. Per its header it must
// run AS raptor_migrator — never as raptor_app.
step("3/7 Better Auth schema — packages/auth/src/schema.sql (as raptor_migrator)");
{
  const client = new Client(migrationUrl + "?connectionTimeoutMillis=5000");
  try {
    await client.connect();
  } catch (error) {
    fail(`could not connect as raptor_migrator: ${error.message}`);
  }
  try {
    for (const statement of splitStatements(readFileSync(path.join(repoRoot, "packages/auth/src/schema.sql"), "utf8"))) {
      if (statement.gexec) continue; // schema.sql contains no backslash commands
      await client.query(statement.text);
    }
    const count = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'auth\\_%'",
    );
    console.log(`   auth tables present: ${count.rows[0].n}/6`);
  } finally {
    await client.end();
  }
}

step("4/7 CMS role provisioning — packages/cms/provision.sql");
await withAdmin(APP_DB, async (client) => {
  await applyFile(client, "packages/cms/provision.sql");
  await client.query(`ALTER ROLE cms_app WITH LOGIN PASSWORD '${LOCAL_PASSWORD}'`);
});

step("5/7 CMS migrations (cms_app)");
const cmsEnv = {
  PAYLOAD_DATABASE_URI: `postgresql://cms_app:${LOCAL_PASSWORD}@${host}:${port}/${APP_DB}`,
};
if (!process.env.PAYLOAD_SECRET) {
  // Migrate-time only; the admin runtime uses PAYLOAD_SECRET from .env.local.
  cmsEnv.PAYLOAD_SECRET = requireFromDb("node:crypto").randomBytes(32).toString("base64");
}
run("pnpm", ["--filter", "./packages/cms", "cms:migrate"], cmsEnv);

step("6/7 preview seed — scripts/preview-seed.sql");
const counts = await withAdmin(APP_DB, async (client) => {
  await applyFile(client, "scripts/preview-seed.sql", { tolerate: new Set() });
  const result = await client.query(
    `SELECT (SELECT count(*) FROM public.game) AS games,
            (SELECT count(*) FROM public.team) AS teams,
            (SELECT count(*) FROM public.person WHERE external_ref LIKE 'preview:%') AS preview_people,
            (SELECT count(*) FROM public.competition) AS competitions,
            (SELECT count(*) FROM public.match_result) AS results`,
  );
  return result.rows[0];
});
console.log(
  `   games=${counts.games} teams=${counts.teams} preview_people=${counts.preview_people} ` +
    `competitions=${counts.competitions} results=${counts.results}`,
);

// The preview CONTENT of the fan site - the news, the partner strip, the
// recruitment panel, the site settings, the social links and the CMS
// operators - lives in its own seed.
//
// It used to live ONLY inside the committed database snapshot, which meant a
// fresh clone that ran this script got the domain preview data and no news
// at all: the content was in a binary blob, unreviewable and unreproducible.
// The snapshot is still the portable copy; this is the thing that makes it.
step("7/7 CMS preview content — scripts/preview-seed-cms.sql");
const content = await withAdmin(APP_DB, async (client) => {
  await applyFile(client, "scripts/preview-seed-cms.sql", { tolerate: new Set() });
  const result = await client.query(
    `SELECT (SELECT count(*) FROM public.cms_news) AS news,
            (SELECT count(*) FROM public.cms_partners) AS partners,
            (SELECT count(*) FROM public.cms_recruitment) AS recruitment,
            (SELECT count(*) FROM public.cms_site_settings) AS site_settings,
            (SELECT count(*) FROM public.cms_operators) AS operators`,
  );
  return result.rows[0];
});
console.log(
  `   news=${content.news} partners=${content.partners} recruitment=${content.recruitment} ` +
    `site_settings=${content.site_settings} operators=${content.operators}`,
);

console.log(`
Setup complete. Next:
  1. cp .env.example .env.local  (if you have not already)
  2. Fill BETTER_AUTH_SECRET and PAYLOAD_SECRET:
       node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  3. For Google sign-in, set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET with
     redirect URI http://localhost:3000/api/auth/callback/google
  4. pnpm dev:local  →  http://localhost:3000
`);
