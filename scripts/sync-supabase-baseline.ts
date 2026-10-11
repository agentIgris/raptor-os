/**
 * Regenerate the Supabase migration baseline from the canonical schema.
 *
 * WHY A SCRIPT INSTEAD OF A COPY
 * ------------------------------
 * `packages/db/migrations/*.sql` is the single source of truth for this schema. Copying it
 * into `supabase/migrations/` by hand would create a second copy that can drift silently,
 * and a drifted schema is precisely the class of defect this project has spent seven phases
 * removing - two identity models, two permission systems, two attendance definitions.
 *
 * So the baseline is GENERATED, never edited. If you change the schema, change it in
 * `packages/db/migrations/`, run this, and commit both.
 *
 * WHY A BASELINE RATHER THAN 13 SEPARATE FILES
 * --------------------------------------------
 * Supabase applies migrations in filename order and tracks them in `schema_migrations`.
 * Re-naming the existing files to its timestamp convention would couple this repo's history
 * to the Supabase CLI's naming, for no benefit. One ordered baseline preserves the same
 * order, is idempotent on re-run, and leaves the door open for genuinely new migrations to
 * be added alongside it afterwards.
 *
 * Run: pnpm exec tsx scripts/sync-supabase-baseline.ts
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file's own location, NOT from `process.cwd()`. The script is invoked
// from the repository root in some places and from `packages/db` in others, because `tsx`
// is only a dependency of that package. A cwd-relative root works until someone runs it the
// other way, and then it fails on a path that looks perfectly plausible.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const SOURCE_DIR = join(REPO_ROOT, 'packages', 'db', 'migrations')
const TARGET_DIR = join(REPO_ROOT, 'supabase', 'migrations')

if (!existsSync(SOURCE_DIR)) {
  throw new Error(`canonical migration directory not found: ${SOURCE_DIR}`)
}

const files = readdirSync(SOURCE_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))

if (files.length === 0) throw new Error(`no .sql files in ${SOURCE_DIR}`)

const header = `-- GENERATED FILE - DO NOT EDIT.
--
-- Produced by scripts/sync-supabase-baseline.ts from packages/db/migrations/.
-- The canonical schema is packages/db/migrations/*.sql; this is a mirror for the Supabase
-- CLI, which applies migrations in filename order and records them in schema_migrations.
--
-- To change the schema: edit packages/db/migrations/, then re-run the script.
--
-- Files, in application order:
${files.map((name, index) => `--   ${index + 1}. ${name}`).join('\n')}
--
-- Every statement below is reproduced verbatim from the source. Anything this file appears
-- to assert about the schema, assert against the source instead.

`

const body = files
  .map((name) => {
    const sql = readFileSync(join(SOURCE_DIR, name), 'utf8').trimEnd()
    return `-- ${'='.repeat(74)}\n-- SOURCE: packages/db/migrations/${name}\n-- ${'='.repeat(74)}\n\n${sql}\n`
  })
  .join('\n')

if (!existsSync(TARGET_DIR)) throw new Error(`supabase migrations dir not found: ${TARGET_DIR}`)

const existing = readdirSync(TARGET_DIR).filter((n) => n.endsWith('.sql'))
// Narrowed by DESTRUCTURING rather than by a non-null assertion. `noUncheckedIndexedAccess`
// makes `existing[0]` possibly-undefined, and the length check above does not narrow it.
// Destructuring an array of length 1 gives TypeScript a real one-element tuple type, so the
// narrowing is derived from the shape rather than asserted away.
const [baselineFile, ...unexpected] = existing

if (baselineFile === undefined || unexpected.length > 0) {
  throw new Error(
    `expected exactly one baseline file in ${TARGET_DIR}, found ${existing.length}: ${existing.join(', ')}`,
  )
}

const target = join(TARGET_DIR, baselineFile)
const next = header + body
writeFileSync(target, next, 'utf8')

process.stdout.write(
  `baseline regenerated: ${target}\n` +
    `  ${files.length} source migrations, ${next.length} bytes\n`,
)