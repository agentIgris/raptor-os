#!/usr/bin/env node
// scripts/restore-local-db.mjs — replay the committed DB snapshot onto this machine.
//
// Run this on a FRESH CLONE after `node scripts/setup-local.mjs` (the bootstrap
// must own creating the roles — raptor_app, raptor_migrator, cms_app, raptor_*
// passwords — because pg_restore does not recreate cluster-wide roles). The
// script then makes raptor_os byte-identical to the machine that produced the
// snapshot: every domain row, seeded account, password link, TOTP enrolment and
// CMS document. Logging in with owner@raptor.local works with the SAME password
// and authenticator entries recorded in scripts/db-local-snapshot/seed-role-accounts.json.
//
// DESTRUCTIVE BY DESIGN: raptor_os is dropped with (FORCE) — killing any open
// connections — and recreated from the snapshot. That is the whole point; the
// snapshot itself is the local data, so nothing is lost that it does not carry.
// It never touches other databases and is not idempotent-safe in the usual
// sense: re-running produces the same snapshot state, which is fine locally.
//
// Order of operations on a new machine:
//   1. pnpm install
//   2. node scripts/setup-local.mjs     (roles + databases + migrations)
//   3. node scripts/restore-local-db.mjs (this: full data replay)
//   4. node scripts/dev-env.mjs          (.env.local / .data env hygiene)

import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, Client } from "./lib/local-dev-auth.mjs";
import { findPgTool } from "./lib/pg-bin.mjs";

const SNAPSHOT_DIR = path.join(REPO_ROOT, "scripts", "db-local-snapshot");
const DUMP_FILE = path.join(SNAPSHOT_DIR, "raptor_os.pgdump");
const CRED_FILE = path.join(SNAPSHOT_DIR, "seed-role-accounts.json");
const APP_DB = "raptor_os";

function fail(message) {
  console.error(`\nrestore-local-db: ${message}`);
  process.exit(1);
}

if (!existsSync(DUMP_FILE)) {
  fail(`no snapshot at ${DUMP_FILE} — did the repo include scripts/db-local-snapshot/?`);
}

const pgRestore = findPgTool("pg_restore");
if (!pgRestore) fail("pg_restore not found. Install PostgreSQL client binaries, or put them on PATH.");
console.log(`pg_restore: ${pgRestore}`);

const env = {
  ...process.env,
  PGHOST: process.env.PGHOST ?? "127.0.0.1",
  PGPORT: process.env.PGPORT ?? "5432",
  PGUSER: process.env.PGUSER ?? "postgres",
  PGPASSWORD: process.env.PGPASSWORD ?? "postgres",
  PGAPPNAME: "raptor-os-restore-local-db",
};

// The drop/recreate must run while connected to `postgres` (a DROP DATABASE
// cannot come from a session using the database being dropped), so this is a
// targeted connection, not adminClient() — that helper addresses raptor_os.
const client = new Client({
  host: env.PGHOST,
  port: Number(env.PGPORT),
  user: env.PGUSER,
  password: env.PGPASSWORD,
  database: "postgres",
  connectionTimeoutMillis: 5000,
});
try {
  await client.connect();
} catch (error) {
  fail(
    `could not reach Postgres as "${env.PGUSER}" on ${env.PGHOST}:${env.PGPORT} (database "postgres"): ${error.message}. ` +
      `Is the service running? Set PGPASSWORD if the superuser password is not "postgres".`,
  );
}

try {
  await client.query(`DROP DATABASE IF EXISTS ${APP_DB} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${APP_DB}`);
  console.log(`dropped and recreated ${APP_DB}`);

  const restore = spawnSync(
    pgRestore,
    ["--dbname", APP_DB, "--exit-on-error", DUMP_FILE],
    { stdio: "inherit", env },
  );
  if (restore.status !== 0) {
    fail(`pg_restore exited with status ${restore.status}. The database left behind is new and EMPTY — re-run setup-local.mjs first if roles are missing, then this script again.`);
  }

  // Credentials fixture: .data/ regenerates per machine (gitignored), so hand
  // the committed copy over so tooling (seed scripts, the role verifier) sees
  // the snapshot's accounts.
  if (existsSync(CRED_FILE)) {
    const dataDir = path.join(REPO_ROOT, ".data");
    mkdirSync(dataDir, { recursive: true });
    copyFileSync(CRED_FILE, path.join(dataDir, "seed-role-accounts.json"));
    console.log(`credential fixture restored to .data/seed-role-accounts.json`);
  }

  console.log(
    `\nrestore complete. Next steps:\n` +
      `  node scripts/dev-env.mjs   # refresh .env.local / .data env files\n` +
      `  pnpm --filter web dev      # start the local stack on :3000\n` +
      `Login: owner@raptor.local — credentials are in\n` +
      `${CRED_FILE}`,
  );
} finally {
  await client.end();
}
