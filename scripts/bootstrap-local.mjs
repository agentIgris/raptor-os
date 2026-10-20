#!/usr/bin/env node
/**
 * scripts/bootstrap-local.mjs — prepare a machine for Raptor OS, in one command.
 *
 * WHAT IT DOES, IN ORDER
 * ----------------------
 *   1. Checks the prerequisites — Node, pnpm, a reachable PostgreSQL — and
 *      stops with a specific message rather than a stack trace.
 *   2. Installs the workspace dependencies if they are not installed yet.
 *   3. Runs `scripts/setup-local.mjs`: the databases, the three roles, the
 *      domain migrations, the Better Auth identity schema, the CMS
 *      provisioning, the Payload migrations and the preview tenant.
 *   4. Writes `.env.local` with freshly generated secrets, IF THE FILE DOES
 *      NOT ALREADY EXIST. An existing `.env.local` is never overwritten: it
 *      may hold a database URL that points somewhere this script cannot see.
 *   5. Seeds the seven role accounts, IF THE APPLICATION IS ALREADY RUNNING
 *      (the seed signs in over HTTP, so it needs a live server).
 *   6. Prints the result: the URLs, the accounts, and the commands for the
 *      steps it could not do.
 *
 * WHY IT IS SAFE TO RE-RUN
 * -----------------------
 * Every step is idempotent or is skipped when its output already exists.
 * The script writes only inside the repository and the local database; it
 * never touches a remote environment, and it never prints a secret.
 *
 * WHY IT EXISTS
 * -------------
 * A person or an agent setting the project up used to have to know the
 * exact order of six scripts and two secret generations, and the wrong order
 * produced failures that read like a broken backend — a 503 from every auth
 * route, or "Database schema mismatch". This script is that knowledge, in
 * one place, executable by anyone.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(repoRoot, ".env.local");
const exampleFile = path.join(repoRoot, ".env.example");

const pgHost = process.env.PGHOST ?? "127.0.0.1";
const pgPort = process.env.PGPORT ?? "5432";
const pgUser = process.env.PGUSER ?? "postgres";
const pgPassword = process.env.PGPASSWORD ?? "postgres";
const appOrigin = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

// `pg` is a dependency of @raptor/db; pnpm's strict layout means it resolves
// from there, not from the repository root.
const requireFromDb = createRequire(path.join(repoRoot, "packages/db/package.json"));
const { Client } = requireFromDb("pg");

const step = (message) => console.log(`\n==> ${message}`);
const detail = (message) => console.log(`    ${message}`);

function fail(message, hint) {
  console.error(`\nbootstrap-local: ${message}`);
  if (hint !== undefined) console.error(`  ${hint}`);
  process.exit(1);
}

function run(command, args, { shell = false } = {}) {
  // `shell: true` is needed on Windows for `pnpm` (it resolves to pnpm.cmd),
  // and must NOT be used for an absolute path to node.exe: the path contains
  // a space ("C:\Program Files\nodejs\node.exe"), and a shell would split it
  // at the space and answer "C:\Program is not recognized".
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", shell });
  if (result.status !== 0) fail(`\`${command} ${args.join(" ")}\` exited with status ${result.status}`);
}

function generateSecret() {
  return randomBytes(32).toString("base64");
}

// -----------------------------------------------------------------------------
// 1. Preflight
// -----------------------------------------------------------------------------

step("1/6 preflight");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (Number.isNaN(nodeMajor) || nodeMajor < 22) {
  fail(
    `Node.js ${process.versions.node} is too old. This repository needs Node 22 or newer.`,
    "Install a current Node, or use a version manager (nvm, fnm, volta).",
  );
}
detail(`node ${process.versions.node}`);

const pnpmVersion = spawnSync("pnpm", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
if (pnpmVersion.status !== 0) {
  fail(
    "pnpm is not on the PATH.",
    "corepack enable && corepack prepare pnpm@12.10.1 --activate",
  );
}
detail(`pnpm ${pnpmVersion.stdout.trim()}`);

const admin = new Client({
  host: pgHost,
  port: Number(pgPort),
  user: pgUser,
  password: pgPassword,
  database: "postgres",
  connectionTimeoutMillis: 5_000,
});
try {
  await admin.connect();
  const version = await admin.query("SHOW server_version");
  detail(`postgres ${version.rows[0].server_version} on ${pgHost}:${pgPort}`);
} catch (error) {
  fail(
    `could not reach PostgreSQL as "${pgUser}" on ${pgHost}:${pgPort}: ${error.message}`,
    "Is the service running? On Windows: Start-Service postgresql-x64-16. Set PGPASSWORD if the superuser password is not \"postgres\".",
  );
} finally {
  await admin.end().catch(() => undefined);
}

// -----------------------------------------------------------------------------
// 2. Dependencies
// -----------------------------------------------------------------------------

step("2/6 dependencies");
if (existsSync(path.join(repoRoot, "node_modules", ".pnpm"))) {
  detail("workspace already installed — skipping `pnpm install`");
  detail("(run `pnpm install` yourself if you changed the lockfile)");
} else {
  detail("installing the workspace");
  run("pnpm", ["install"], { shell: process.platform === "win32" });
}

// -----------------------------------------------------------------------------
// 3. Database, roles, schema, migrations, preview data
// -----------------------------------------------------------------------------

step("3/6 database, roles, schema, migrations, preview data");
run(process.execPath, [path.join(repoRoot, "scripts", "setup-local.mjs")]);

// -----------------------------------------------------------------------------
// 4. .env.local
// -----------------------------------------------------------------------------

step("4/6 environment file");
if (existsSync(envFile)) {
  detail(".env.local already exists — left untouched");
  const current = readFileSync(envFile, "utf8");
  for (const name of ["BETTER_AUTH_SECRET", "PAYLOAD_SECRET"]) {
    const value = new RegExp(`^${name}=(.*)$`, "m").exec(current)?.[1] ?? "";
    if (value.trim() === "") {
      detail(`WARNING: ${name} is empty in .env.local — the app will refuse to start`);
      detail(`         set it with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`);
    }
  }
} else {
  if (!existsSync(exampleFile)) fail(".env.example is missing — the repository is incomplete");
  const contents = readFileSync(exampleFile, "utf8")
    .replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${generateSecret()}`)
    .replace(/^PAYLOAD_SECRET=.*$/m, `PAYLOAD_SECRET=${generateSecret()}`);
  writeFileSync(envFile, contents, "utf8");
  detail("wrote .env.local with freshly generated BETTER_AUTH_SECRET and PAYLOAD_SECRET");
  detail("(the values are not printed — they are in the file, and the file is gitignored)");
}

// -----------------------------------------------------------------------------
// 5. The role accounts
// -----------------------------------------------------------------------------

step("5/6 role accounts");

async function isApplicationRunning() {
  try {
    const response = await fetch(`${appOrigin}/api/health`, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

if (await isApplicationRunning()) {
  detail(`the application is answering on ${appOrigin} — seeding the accounts`);
  run(process.execPath, [path.join(repoRoot, "scripts", "create-role-accounts.mjs")]);
} else {
  detail("the application is not running — the accounts were NOT seeded");
  detail("start it with `pnpm dev:local`, then run:");
  detail("    node scripts/create-role-accounts.mjs");
}

// -----------------------------------------------------------------------------
// 6. Summary
// -----------------------------------------------------------------------------

step("6/6 summary");
console.log(`
  Ready.

  Start the stack:      pnpm dev:local
  Open:                 ${appOrigin}
                        ${appOrigin}/dashboard     the workspace
                        ${appOrigin}/assistant     the role-scoped assistant
                        ${appOrigin}/cms-admin     the Payload CMS
                        ${appOrigin}/sign-in       sign-in

  The seven accounts (local-only password: raptor_local_dev_only):
    owner@raptor.local   admin@raptor.local   manager@raptor.local
    analyst@raptor.local coach@raptor.local    player@raptor.local
    pending@raptor.local  (refused everywhere — the default a sign-up lands on)

  Verify:               pnpm verify
                        node scripts/verify-assistant-roles.mjs

  This build does not ask for a 6-digit code: the TOTP challenge is switched
  off, the MFA policy is not. See docs/SECURITY.md → Demo deviations.
`);
