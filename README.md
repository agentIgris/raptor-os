# Raptor OS

Multi-tenant Esports Organisation OS — a Next.js monorepo with a workspace
app, a public organisation site, and a Payload CMS, all served by a single
Next.js process on port 3000, plus an authentication package and a
domain database package.

This README covers running the whole stack locally on one machine with
nothing but PostgreSQL 16 and Node.js. Supabase and Vercel are optional
deploy targets, not requirements.

## Prerequisites

- **Node.js 22 or newer** (`node --version`)
- **pnpm 12.x** (`corepack enable` or `npm i -g pnpm`)
- **PostgreSQL 16** running locally on `127.0.0.1:5432`, with a superuser
  password. On Windows the default zip installer creates a service named
  `postgresql-x64-16` with the `postgres` superuser.

No Docker is required.

## One-command local setup

1. Clone, then install dependencies:

   ```sh
   pnpm install
   ```

2. Run the setup script:

   ```sh
   node scripts/setup-local.mjs
   ```

   What it does, idempotently (safe to run again any time):

   - Creates the local database `raptor_os` (and its test twin) plus three
     restricted roles: `raptor_app` (runtime data, tenant-scoped), `raptor_migrator`
     (schema changes), and `cms_app` (Payload). Local passwords default to
     `raptor_local_dev_only`; override any of them with
     `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` environment variables.
   - Applies every domain migration from `packages/db/src/migrations/`
     forward-only, under an advisory lock.
   - Applies `packages/cms/provision.sql` (row-level security, grants) and
     runs the CMS migrations for Payload.
   - Seeds a preview tenant (games, teams, competitions, people, results)
     so the public site and workspace render with real data, then prints
     row counts as a health check.

   At the end it prints the exact environment variables you need, including
   fresh random values for `BETTER_AUTH_SECRET` and `PAYLOAD_SECRET` that it
   generated for the session — copy them into your `.env.local` once, then
   keep the file.

3. Copy the connection strings into `.env.local`:

   ```sh
   cp .env.example .env.local
   ```

   Fill the three database URLs as printed by the setup script (they default
   to the values above), paste the two generated secrets, and — if you want
   Google sign-in — add `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Without
   them sign-in falls back to email + password. Without `RESEND_API_KEY`
   (dev only) sign-in emails each confirmation code to the server console
   instead of a real inbox.

4. Start everything:

   ```sh
   pnpm dev:local
   ```

   Then open <http://localhost:3000> — the public site; `/dashboard`
   for the workspace; `/cms-admin` for Payload.

## Google sign-in

Create OAuth credentials in Google Cloud Console with the redirect URI:

```
http://localhost:3000/api/auth/callback/google
```

Add the client id/secret to `.env.local`. A half-configured provider is
refused and the Google button simply does not render.

## Data model orientation

- Everything tenant-scoped carries `org_id`; row-level security in
  `packages/cms/provision.sql` restricts content writes to the tenant root.
- `PUBLIC_ORG_ID` / `PUBLIC_ORG_SLUG` in `.env.local` choose which single
  tenant is rendered publicly.
- `STORAGE_ROOT` (default `.data/storage`) is where media land when no S3
  bucket is configured; with `S3_BUCKET` + access keys set, uploads go to
  S3 instead.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm verify` | Lint + typecheck + full test suite |
| `pnpm test:unit` | Unit tests (DB-free) |
| `pnpm test:integration` / `pnpm test:e2e` | Integration and end-to-end suites |
| `pnpm test:a11y` | Accessibility assertions |
| `pnpm db:migrate` | Apply pending domain migrations |
| `pnpm db:studio` | Open Drizzle Studio against a local DB |

The integration, e2e and a11y suites and `pnpm db:*` require the local
Postgres service to be running; `pnpm test:unit` does not.

## Deployment targets (optional)

Supabase stays a valid target: point `DATABASE_URL` etc. at the Supabase
pooled connection string, keep `packages/cms/provision.sql` as the source of
truth for RLS, and run `pnpm db:migrate` against it. Vercel deployment works
the same way for the web app — the only difference is storage and database
endpoints in env.
