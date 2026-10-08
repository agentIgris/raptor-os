import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "migrations");

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

/**
 * Read the migration ledger from disk, in filename order.
 *
 * Migrations are append-only. An applied migration is never edited; a correction is a
 * new file. This is the single most important structural difference from the legacy
 * repository, which had 43 ad-hoc SQL scripts with no ledger, duplicate numeric prefixes
 * and no ordering discipline.
 */
export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(dir, name), "utf8");
      return {
        name,
        sql,
        // Normalise line endings so a checkout on another platform does not
        // report a false checksum mismatch.
        checksum: createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex"),
      };
    }),
  );
}

async function ensureLedger(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      id          integer PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer
    );
  `);
}

async function appliedNames(db: PGlite): Promise<Map<string, string>> {
  const result = await db.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migration");
  return new Map(result.rows.map((row) => [row.name, row.checksum]));
}

/** Apply every migration not yet in the ledger. Idempotent and replayable. */
export async function migrateUp(db: PGlite): Promise<string[]> {
  await ensureLedger(db);
  const applied = await appliedNames(db);
  const migrations = await loadMigrations();
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
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query(
        "INSERT INTO schema_migration (id, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)",
        [index + 1, migration.name, migration.checksum, Date.now() - startedAt],
      );
    });

    executed.push(migration.name);
  }

  return executed;
}

export async function migrationStatus(db: PGlite): Promise<{ applied: string[]; pending: string[] }> {
  await ensureLedger(db);
  const applied = await appliedNames(db);
  const migrations = await loadMigrations();
  return {
    applied: [...applied.keys()],
    pending: migrations.filter((m) => !applied.has(m.name)).map((m) => m.name),
  };
}