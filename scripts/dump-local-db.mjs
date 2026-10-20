#!/usr/bin/env node
// scripts/dump-local-db.mjs — snapshot the ENTIRE local database into the repo.
//
// Purpose: make a local environment portable. A fresh clone on another machine,
// after `node scripts/setup-local.mjs`, can replay this snapshot with
// `node scripts/restore-local-db.mjs` and end up with byte-identical data — the
// seeded accounts, their password links, all domain rows and CMS content.
//
// What it writes (all committed to the repo):
//   scripts/db-local-snapshot/raptor_os.pgdump   full custom-format dump
//   scripts/db-local-snapshot/seed-role-accounts.json — the credential fixture
//     that the seed scripts and the role verifier read (@.data/ is deliberately
//     gitignored; this copy is what makes credentials travel with the repo).
//
// The snapshot contains LOCAL-DEV-ONLY data. Nothing here is a production
// secret: role passwords are fixed "raptor_local_dev_only" constants and the
// database names itself. Do not point this at a real environment.
//
// Connection: the local SUPERUSER, same convention as scripts/setup-local.mjs
// (postgres/postgres on loopback, PGHOST/PGPORT/PGUSER/PGPASSWORD override).

import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/local-dev-auth.mjs";
import { findPgTool } from "./lib/pg-bin.mjs";

const SNAPSHOT_DIR = path.join(REPO_ROOT, "scripts", "db-local-snapshot");
const DUMP_FILE = path.join(SNAPSHOT_DIR, "raptor_os.pgdump");
const CRED_FILE = path.join(SNAPSHOT_DIR, "seed-role-accounts.json");
const APP_DB = "raptor_os";

function fail(message) {
  console.error(`\ndump-local-db: ${message}`);
  process.exit(1);
}

const pgDump = findPgTool("pg_dump");
if (!pgDump) {
  fail(
    "pg_dump not found. Install PostgreSQL client binaries, or put them on PATH.",
  );
}
console.log(`pg_dump: ${pgDump}`);

mkdirSync(SNAPSHOT_DIR, { recursive: true });

// pg_dump speaks the standard PG* environment variables, so pass the setup-local
// defaults (postgres/postgres/@127.0.0.1:5432) as explicit flags only where the
// caller has not already set the ambient variable.
const env = {
  ...process.env,
  PGHOST: process.env.PGHOST ?? "127.0.0.1",
  PGPORT: process.env.PGPORT ?? "5432",
  PGUSER: process.env.PGUSER ?? "postgres",
  PGPASSWORD: process.env.PGPASSWORD ?? "postgres",
  PGAPPNAME: "raptor-os-dump-local-db",
};

const result = spawnSync(
  pgDump,
  ["--dbname", APP_DB, "--format=custom", "--file", DUMP_FILE],
  { stdio: "inherit", env },
);
if (result.status !== 0) fail(`pg_dump exited with status ${result.status}`);

// Integrity check: pg_restore --list re-parses the custom format end to end;
// a truncated file fails here rather than at restore time on another machine.
const pgRestore = findPgTool("pg_restore");
const toc = spawnSync(pgRestore, ["--list", DUMP_FILE], {
  env,
  encoding: "utf8",
});
if (toc.status !== 0) fail(`pg_restore --list rejected the dump (status ${toc.status})`);
const tableDataEntries = toc.stdout.split("\n").filter((line) => / TABLE DATA /.test(line)).length;
const megabytes = (statSync(DUMP_FILE).size / (1024 * 1024)).toFixed(2);

console.log(`snapshot written: ${DUMP_FILE} (${megabytes} MB, ${tableDataEntries} TOC entries)`);

// Credentials travel with the snapshot: .data/ is gitignored (it is regenerable),
// but the account/password/TOTP fixture is the thing that makes another clone a
// drop-in replacement, so a copy lives next to the dump.
const sourceCreds = path.join(REPO_ROOT, ".data", "seed-role-accounts.json");
if (existsSync(sourceCreds)) {
  copyFileSync(sourceCreds, CRED_FILE);
  console.log(`credential fixture copied: ${CRED_FILE}`);
} else {
  fail(`.data/seed-role-accounts.json is missing — run scripts/create-role-accounts.mjs first`);
}
