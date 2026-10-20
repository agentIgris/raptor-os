/**
 * Postgres migration runner (native server mode).
 *
 * Mirrors the PGlite ledger semantics in `migrations.ts` — same table, same
 * checksums, same append-only discipline — but connects over node-postgres so
 * the same files replay against a real server (local dev, staging).
 *
 * Connects as the migration role via DATABASE_MIGRATION_URL (locally
 * `raptor_migrator`, a dedicated superuser scoped to this job). The app role
 * `raptor_app` is deliberately refused here: it is least-privilege by
 * ADR-0006, and an accidental migration run through the app connection would
 * either fail on DDL or, worse, leave the ledger inconsistent with reality.
 *
 * Migrations are forward-only. `down` does not exist by design — a correction
 * is a new file, never an edit or a revert.
 *
 * Usage: `pnpm --filter @raptor/db db:migrate` → `tsx src/migrate.ts up`
 */

import { Client } from "pg";

import { loadMigrations } from "./migrations.js";

const command = process.argv[2] ?? "up";

if (command !== "up" && command !== "status") {
  console.error(`Unknown command "${command}". Supported: up, status.`);
  console.error("Migrations are forward-only: there is no down, by design.");
  process.exit(1);
}

const connectionString = process.env.DATABASE_MIGRATION_URL ?? "";
if (connectionString === "") {
  console.error("DATABASE_MIGRATION_URL is not set.");
  console.error("Migrations must run through the dedicated migration role, never the app role (ADR-0006).");
  process.exit(1);
}

if (/\/\/[^@/]*raptor_app@/.test(connectionString)) {
  console.error("Refusing to migrate as raptor_app: the app role is least-privilege (ADR-0006).");
  console.error("Set DATABASE_MIGRATION_URL to the migration role instead.");
  process.exit(1);
}

const client = new Client({ connectionString });
let connected = false;

try {
  await client.connect();
  connected = true;

  // Session-level lock so two runners never race on the same database.
  await client.query("SELECT pg_advisory_lock(721834662)");

  const migrations = await loadMigrations();

  // The ledger is created here rather than in 0001 so the runner works on an
  // empty database the same way the PGlite runner does.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      id          integer PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer
    );
  `);

  const applied = new Map<string, string>(
    (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migration")).rows.map(
      (row) => [row.name, row.checksum],
    ),
  );

  if (command === "status") {
    for (const migration of migrations) {
      const known = applied.get(migration.name);
      const mark = known === undefined ? "pending " : "applied ";
      const drift = known !== undefined && known !== migration.checksum ? "  CHECKSUM MISMATCH" : "";
      console.warn(`${mark}${migration.name}${drift}`);
    }
    process.exit(0);
  }

  const executed: string[] = [];

  for (const [index, migration] of migrations.entries()) {
    const existing = applied.get(migration.name);

    if (existing !== undefined) {
      if (existing !== migration.checksum) {
        throw new Error(
          `Migration ${migration.name} has already been applied with a different checksum. ` +
            `Applied migrations are immutable — add a new migration instead of editing this one.`,
        );
      }
      continue;
    }

    const startedAt = Date.now();
    // Each migration runs in its own transaction: a failure leaves the ledger consistent.
    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migration (id, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)", [
        index + 1,
        migration.name,
        migration.checksum,
        Date.now() - startedAt,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    executed.push(migration.name);
    console.warn(`applied ${migration.name}`);
  }

  console.warn(executed.length === 0 ? "migrations up to date." : `${executed.length} migration(s) applied.`);
} finally {
  if (connected) {
    await client.query("SELECT pg_advisory_unlock(721834662)").catch(() => {});
    await client.end();
  }
}
