/**
 * scripts/lib/pg-bin.mjs — locate the Postgres client binaries (pg_dump /
 * pg_restore / psql) across the box, so the snapshot scripts do not depend on
 * these being on PATH.
 *
 * Windows installs Postgres under "C:\Program Files\PostgreSQL\<major>\bin"
 * and does not add it to PATH; Linux/macOS installs usually do. The lookup
 * covers both: the platform's own PATH search first, then the known
 * installation directory (highest version wins on Windows, Homebrew cellar on
 * macOS). An ENOENT from spawnSync is the signal that a lookup failed, so the
 * caller can fall through.
 *
 * The scripts that use this snapshot the LOCAL database, never a remote one —
 * the connection parameters are the setup-local superuser defaults with PG* env
 * overrides, the same convention scripts/setup-local.mjs documents.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";

const WINDOWS_BIN_DIR = "C:\\Program Files\\PostgreSQL";
const HOMEBREW_PREFIXES = ["/opt/homebrew/opt/postgresql", "/usr/local/opt/postgresql"];

function tryOnPath(tool) {
  const probe = spawnSync(tool, ["--version"], { stdio: "ignore" });
  return probe.error === undefined ? tool : null;
}

function tryWindowsInstall(tool) {
  if (process.platform !== "win32" || !existsSync(WINDOWS_BIN_DIR)) return null;
  const versions = readdirSync(WINDOWS_BIN_DIR)
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(b) - Number(a));
  for (const version of versions) {
    const candidate = path.join(WINDOWS_BIN_DIR, version, "bin", `${tool}.exe`);
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.error === undefined) return candidate;
  }
  return null;
}

function tryHomebrewInstall(tool) {
  for (const prefix of HOMEBREW_PREFIXES) {
    for (const bindir of [path.join(prefix, "bin"), path.join(prefix, "..", "bin")]) {
      const candidate = path.join(bindir, tool);
      if (!existsSync(candidate)) continue;
      const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
      if (probe.error === undefined) return candidate;
    }
  }
  return null;
}

/**
 * Resolve the absolute path of a Postgres client tool, or return null when it
 * is installed nowhere we know of. Callers report that to the user instead of
 * failing with a bare ENOENT.
 */
export function findPgTool(tool) {
  return tryOnPath(tool) ?? tryWindowsInstall(tool) ?? tryHomebrewInstall(tool);
}
