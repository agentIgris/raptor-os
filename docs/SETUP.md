# Setup

Two ways to get the stack running: one command, or step by step. Both land in
the same place — a local stack on <http://localhost:3000> with a seeded
organisation and seven sign-in accounts.

---

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | 22 or newer | `node --version` |
| pnpm | 12.10.1 | `corepack enable && corepack prepare pnpm@12.10.1 --activate` |
| PostgreSQL | 16, local | `127.0.0.1:5432`, superuser `postgres` |

**No Docker is required.** The stack talks to a native Postgres over TCP.

On Windows the default zip installer registers a service named
`postgresql-x64-16`. Start it if it is not running:

```powershell
Get-Service postgresql-x64-16
Start-Service postgresql-x64-16
```

On macOS, `brew services start postgresql@16`. On Debian/Ubuntu,
`systemctl start postgresql`.

Confirm the database is reachable before anything else:

```sh
psql -h 127.0.0.1 -U postgres -c "select version();"
```

---

## Option A — one command (recommended, and what an agent should run)

```sh
pnpm install
pnpm bootstrap
pnpm dev:local
```

`pnpm bootstrap` (`scripts/bootstrap-local.mjs`) is idempotent and does the
whole of this in order:

1. **Checks the prerequisites** — Node, pnpm and a reachable Postgres — and
   stops with a specific message rather than a stack trace.
2. **Installs dependencies** if the workspace is not installed yet.
3. **Creates the databases and roles** (`raptor_os` and its test twin, plus
   `raptor_app`, `raptor_migrator` and `cms_app`).
4. **Applies the migrations** — the domain ledger, the Better Auth identity
   schema, the CMS provisioning and the Payload migrations.
5. **Seeds the preview data** — `scripts/preview-seed.sql` for the domain
   (teams, games, players, competitions, results) and
   `scripts/preview-seed-cms.sql` for the CONTENT (the news, the partner
   strip, the recruitment panel, the site settings, the social links and the
   CMS operators). Both are committed SQL, so the demo content is reviewable
   in a diff and reproducible on any machine, not only inside the database
   snapshot.
6. **Writes `.env.local`** with freshly generated `BETTER_AUTH_SECRET` and
   `PAYLOAD_SECRET`, if the file does not exist. An existing `.env.local` is
   never overwritten.
7. **Seeds the seven role accounts**, if the application is already running
   (the seed signs in over HTTP, so it needs a live server).
8. **Prints the result** — the URLs, the accounts, and the exact command to
   start the stack.


It is safe to run again at any time. It is also safe to run as an AI agent:
it takes no interactive input, it writes only inside the repository and the
local database, and it never touches a remote environment.

---

## Option B — step by step

<details open>
<summary><strong>1. Install</strong></summary>

```sh
pnpm install
```

</details>

<details>
<summary><strong>2. Create the database, roles, schema and preview data</strong></summary>

```sh
node scripts/setup-local.mjs
```

Idempotent — safe to run again any time. It:

- creates the local database `raptor_os` (and its test twin `raptor_os_test`)
  plus three restricted roles: `raptor_app` (runtime data, tenant-scoped),
  `raptor_migrator` (schema changes) and `cms_app` (Payload);
- applies every domain migration from `packages/db/migrations/` forward-only,
  under an advisory lock;
- applies `packages/auth/src/schema.sql` as `raptor_migrator`;
- applies `packages/cms/provision.sql` (row-level security, grants) and runs
  the Payload migrations;
- seeds a preview tenant (games, teams, competitions, people, results) and
  prints row counts as a health check;
- seeds the preview CONTENT — three news stories, five partners, the
  recruitment panel, the site settings, the social links and the two CMS
  operator accounts — from `scripts/preview-seed-cms.sql`, so a clone has the
  same fan site the snapshot has.

It also prints fresh random values for `BETTER_AUTH_SECRET` and
`PAYLOAD_SECRET`. Write them down — the next step needs them.

</details>

<details>
<summary><strong>3. Write <code>.env.local</code></strong></summary>

```sh
cp .env.example .env.local
```

Then fill in:

- `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `PAYLOAD_DATABASE_URI` — the
  values the setup script printed (they default to the local ones);
- `BETTER_AUTH_SECRET` and `PAYLOAD_SECRET` — the generated values.

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Optional: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` for Google sign-in,
`RESEND_API_KEY` for real email. Without Resend, verification and reset
links are printed to the server console in development — links are bearer
credentials and are never printed anywhere else.

</details>

<details>
<summary><strong>4. Seed the role accounts</strong></summary>

```sh
node scripts/create-role-accounts.mjs
```

Creates one sign-in account per role, wires each to a person and an active
organisation membership, and writes the credentials to
`.data/seed-role-accounts.json` (gitignored).

</details>

<details>
<summary><strong>5. Start</strong></summary>

```sh
pnpm dev:local
```

`scripts/dev-env.mjs` reads the root `.env.local` and starts the workspace
with it. Booting `pnpm dev` directly instead starts every package with an
EMPTY environment, and `/api/auth/*` answers 503 by design — that failure
looks like a broken backend and has cost real debugging time, so use
`dev:local`.

</details>

---

## What you get

| URL | Surface |
| --- | --- |
| <http://localhost:3000> | Public fan site |
| <http://localhost:3000/dashboard> | Workspace (role-aware) |
| <http://localhost:3000/assistant> | Workspace assistant |
| <http://localhost:3000/cms-admin> | Payload CMS admin |
| <http://localhost:3000/sign-in> | Sign-in |
| <http://localhost:3000/api/health> | Liveness |
| <http://localhost:3000/api/ready> | Readiness (checks the database) |

### The accounts

All seven use the local-only password `raptor_local_dev_only`.

| Account | Role | Can |
| --- | --- | --- |
| `owner@raptor.local` | owner | everything, including the CMS admin console |
| `admin@raptor.local` | admin | everything except owner-only actions |
| `manager@raptor.local` | manager | member list, insights, roster |
| `analyst@raptor.local` | analyst | insights, roster |
| `coach@raptor.local` | coach | insights, roster |
| `player@raptor.local` | player | teams and competitions |
| `pending@raptor.local` | pending | nothing — refused at the workspace |

> **The demo build does not ask for a 6-digit code.** The `twoFactor` plugin
> is not installed, so a password is the whole sign-in for every role. The
> MFA *policy* is still in force — a privileged account is refused a session
> unless it carries the enrolment flag, and the seed grants that flag — but
> no challenge is ever issued. See [SECURITY.md](./SECURITY.md#demo-deviations)
> and [DEMO.md](./DEMO.md).

### The demo content, and the art that goes with it

The fan site is not empty on a fresh clone, and none of it needs a network
call or a media server:

| What | Where it comes from |
| --- | --- |
| Teams, games, players, competitions, results | `scripts/preview-seed.sql` |
| News, partners, recruitment, site settings, social links, CMS operators | `scripts/preview-seed-cms.sql` |
| Hero, division art, portraits, news art, partner logos, marks | `apps/web/public/placeholders/` (20 files, in git) |
| The whole database, byte for byte | `scripts/db-local-snapshot/raptor_os.pgdump` |

The portraits are resolved **by handle**: the roster's handle is
`person_profile.display_name`, and the site asks for
`/placeholders/player-<handle>.png`, falling back to a generic portrait when
the file is absent. The seed therefore carries the five handles the committed
art is named for — `RExANNA`, `RExFURRYJOD`, `RExIGRIS`, `RExSANKU`,
`RExZEROIGL` — and
`apps/web/src/__tests__/preview-content.test.ts` fails if the two ever drift
apart again. They did drift once, and the symptom was "the images are
missing" on a second machine with nothing to indicate a cause.

There is **no uploaded media** in the demo: every image column in the content
seed is NULL, and the art is the committed placeholder set. A file uploaded
through the CMS admin lands under `packages/cms/.media/` (or S3 in a
deployed environment) and is not part of the repository.


---

## Verifying the install

```sh
pnpm verify            # lint + typecheck + the whole test suite
node scripts/verify-assistant-roles.mjs   # every role signs in and is scoped correctly
```

`verify-assistant-roles.mjs` is the end-to-end proof: it signs in as each of
the seven accounts, asks the assistant a question, and checks the tool set it
received against the scope matrix in the source.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/api/auth/*` answers `503 Authentication is not configured` | the process has no `BETTER_AUTH_SECRET` | start with `pnpm dev:local`, not `pnpm dev` |
| `503` with "Database schema mismatch" | the identity schema was never applied | `node scripts/setup-local.mjs` |
| `connect ECONNREFUSED 127.0.0.1:5432` | Postgres is not running | start the `postgresql-x64-16` service |
| `429` on sign-in | the rate limit is 5 attempts per 60 seconds per IP | wait a minute; the seed and the verifier pace themselves |
| "role `x` may not be held without an enrolled TOTP authenticator" | a privileged account without the flag | `UPDATE auth_user SET "twoFactorEnabled" = true WHERE email = '...'` |
| `relation "person_credential_link" does not exist` | the domain schema was applied after the auth schema | `node scripts/setup-local.mjs` applies them in order |
| The port 3000 is busy | another process holds it | `Get-NetTCPConnection -LocalPort 3000` then stop it, or run on another port with `NEXT_PUBLIC_APP_URL` set to match |
| `pnpm` is not the version the lockfile expects | corepack is not active | `corepack enable && corepack prepare pnpm@12.10.1 --activate` |

---

## Where things live

```
apps/web/        the Next.js app: public site, workspace, Payload mount, API routes
packages/auth/   the Better Auth instance, the identity schema, roles and MFA policy
packages/db/     the domain schema, 16 migrations, RLS, the Drizzle client
packages/cms/    the Payload content plane and the admin session strategy
packages/core/   24 domain modules of pure rules (no I/O)
packages/ui/     the design system
packages/assistant/  the role→tool matrix and the offline assistant
packages/observability/  the logger, correlation context, health probes
scripts/         setup, migration, seeding, snapshotting and verification
docs/            this documentation
AUDIT/           the legacy-system audit this rebuild answers
```
