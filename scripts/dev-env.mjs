/**
 * Local development boot with the monorepo-root environment.
 *
 * WHY THIS EXISTS
 * ---------------
 * Next.js reads `.env*` from `apps/web/`, but this repository keeps exactly
 * one `.env.local` at the repository root (a second copy under `apps/web`
 * would be a second secret store that drifts). Booting `pnpm dev` directly
 * therefore starts every package with an EMPTY environment — `/api/auth/*`
 * answers 503 by design and no session can exist. That failure looks like a
 * broken backend and has already cost one debugging session (see the plan).
 *
 * WHAT IT DOES
 * ------------
 * Parses `<root>/.env.local` (names AND values stay in this process and its
 * children; nothing is printed, committed, or copied anywhere) and spawns
 * `turbo run dev` with the values merged over the current environment.
 * Explicitly exported variables win over file values.
 *
 * Usage: `pnpm dev:local [--check]`
 *   --check loads and validates the file, prints variable NAMES only, and
 *   exits without booting anything.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = resolve(ROOT, ".env.local");

function loadEnvFile() {
  let text;
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    throw new Error(`.env.local not found at ${ENV_FILE}; copy .env.example and fill it in.`);
  }
  const values = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1);
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(trimmed.slice(0, eq), value);
  }
  return values;
}

const values = loadEnvFile();

if (process.argv.includes("--check")) {
  console.log(`.env.local: ${values.size} variables (${[...values.keys()].join(", ")})`);
  const required = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "DATABASE_URL", "PAYLOAD_SECRET", "PAYLOAD_DATABASE_URI"];
  const missing = required.filter((name) => (values.get(name) ?? "") === "");
  if (missing.length > 0) {
    console.error(`missing or empty: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("required CMS/auth/database entries present (values never printed).");
  process.exit(0);
}

for (const [name, value] of values) {
  if (process.env[name] === undefined) {
    process.env[name] = value;
  }
}

const result = spawnSync("pnpm", ["dev"], { cwd: ROOT, stdio: "inherit", shell: true });
process.exit(result.status ?? 1);
