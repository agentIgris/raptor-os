# Raptor OS

**A multi-tenant operating system for an esports organisation.**

One Next.js process serving four surfaces — a public fan site, a role-aware
operations workspace, a Payload CMS and the API — on one PostgreSQL database
with 91 domain tables behind forced row-level security, one identity for
every human, and a domain engine that keeps the rules in one place.

```sh
pnpm install
pnpm bootstrap        # database, roles, schema, migrations, .env.local, seed accounts
pnpm dev:local        # http://localhost:3000
```

That is the whole setup. No Docker, no cloud account, no Supabase, no Vercel
account: a local PostgreSQL 16 and Node.js 22.

| Surface | URL | |
| --- | --- | --- |
| Public site | `/` | the fan-facing roster, competitions, partners and content |
| Workspace | `/dashboard` | teams, members, insights, content, partners, settings |
| Assistant | `/assistant` | an offline, role-scoped read tool over your own data |
| CMS admin | `/cms-admin` | the content plane, on the same identity as the product |

---

## Table of contents

- [What it is](#what-it-is)
- [Quick start](#quick-start)
- [The accounts](#the-accounts)
- [Architecture at a glance](#architecture-at-a-glance)
- [The security model](#the-security-model)
- [Repository layout](#repository-layout)
- [Commands](#commands)
- [Documentation](#documentation)
- [Project status](#project-status)
- [Contributing](#contributing)

---

## What it is

Running an esports organisation means spreadsheets for rosters, chat apps for
coordination, scattered files for contracts, and a website that is stale
within weeks. Nothing agrees with anything else: a prize payout cannot be
traced, nobody can say who is allowed to do what, and the fans see last
season's roster.

Raptor OS is the system that replaces that:

- **One backend.** Every team, player, match, rupee and document lives in one
  database, with the rules — money, prize allocation, contracts, attendance,
  workflows, HR — in one pure, tested engine.
- **One identity.** A person, not a login, is the root. A login is linked to
  a person; contracts and attendance survive a change of email address.
- **One tenancy.** Every organisation-scoped row is filtered by the database
  itself. A bug in application code stays inside one tenant.
- **One way in.** The CMS admin, the workspace and the assistant are the same
  session. There is no second admin password to leak.

The repository is a rebuild. The system it replaces is documented, defect by
defect, in [`AUDIT/`](./AUDIT/00_AUDIT_README.md) — 96 documents, five auth
defects, four cross-tenant defects, and a green test suite that passed
through all of them. Every control in this codebase exists to close one of
those findings, and the reasoning is in
[`docs/adr/`](./docs/adr/README.md).

---

## Quick start

### Prerequisites

| Requirement | Version |
| --- | --- |
| Node.js | 22 or newer |
| pnpm | 12.10.1 (`corepack enable`) |
| PostgreSQL | 16, local, on `127.0.0.1:5432` |

No Docker required.

### One command

```sh
pnpm install
pnpm bootstrap
pnpm dev:local
```

`pnpm bootstrap` is idempotent and non-interactive: it checks the
prerequisites, creates the databases and the three roles (`raptor_app`,
`raptor_migrator`, `cms_app`), applies the domain migrations, the identity
schema, the CMS provisioning and the Payload migrations, writes `.env.local`
with freshly generated secrets, seeds a preview tenant and the seven role
accounts, and prints the result.

The step-by-step path, and what to do when something fails, is in
**[docs/SETUP.md](./docs/SETUP.md)**.

### For an AI agent

```sh
pnpm install && pnpm bootstrap && pnpm dev:local
```

Then read **[`AGENTS.md`](./AGENTS.md)** — the rulebook — and
**[docs/AI-AGENT-GUIDE.md](./docs/AI-AGENT-GUIDE.md)** — the playbook, with
the exact commands, the invariants that must not break, the verification
ladder and the traps.

---

## The accounts

All seven use the local-only password `raptor_local_dev_only`.

| Account | Role | Sees |
| --- | --- | --- |
| `owner@raptor.local` | owner | everything, including the CMS admin console |
| `admin@raptor.local` | admin | the org overview, the member list |
| `manager@raptor.local` | manager | member data, insights, roster |
| `analyst@raptor.local` | analyst | insights, roster |
| `coach@raptor.local` | coach | insights, roster |
| `player@raptor.local` | player | teams and competitions |
| `pending@raptor.local` | pending | nothing — the default a sign-up lands on |

> **The demo build does not ask for a 6-digit code.** The `twoFactor` plugin
> is not installed, so a password is the whole sign-in for every role. The
> MFA *policy* is untouched: a privileged account is refused a session unless
> it carries the enrolment flag, and the seed grants that flag. What this
> means, and how to put the second factor back, is in
> **[docs/SECURITY.md → Demo deviations](./docs/SECURITY.md#demo-deviations)**.

---

## Architecture at a glance

```
                      ┌──────────────────────────────────────────┐
   browser  ────────▶ │  apps/web — one Next.js process (:3000)   │
                      │   (site) fan site · (app) workspace        │
                      │   (payload) /cms-admin · /api/*            │
                      └───────┬──────────────────────┬───────────┘
                              │                      │
                    ┌─────────▼─────────┐   ┌────────▼──────────┐
                    │  packages/auth    │   │  packages/cms     │
                    │  identity + policy│   │  content plane    │
                    └─────────┬─────────┘   └────────┬──────────┘
                              │                      │
                    ┌─────────▼──────────────────────▼───────────┐
                    │            PostgreSQL 16                    │
                    │  auth_* (6) · cms_* · 91 domain tables     │
                    │  forced RLS on every tenant-scoped table   │
                    └──────────────────────┬──────────────────────┘
                                           │
                    ┌──────────────────────▼──────────────────────┐
                    │  packages/db · packages/core · observability│
                    └─────────────────────────────────────────────┘
```

| Package | Owns |
| --- | --- |
| `@raptor/web` | the four surfaces, the API routes, the session guard |
| `@raptor/auth` | the Better Auth instance, the identity schema, roles, the MFA policy, the account lockout |
| `@raptor/db` | the domain schema, 16 forward-only migrations, RLS, the Drizzle client |
| `@raptor/cms` | the Payload content plane and the admin session strategy |
| `@raptor/core` | 24 domain modules of pure rules — no I/O, no framework |
| `@raptor/ui` | the design system and its accessibility behaviour |
| `@raptor/assistant` | the role→tool matrix and the offline assistant |
| `@raptor/observability` | the structured logger, correlation context, health probes |

The full map, with the request lifecycle and the deployment topology, is in
**[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**.

---

## The security model

Seven properties, each with a test that fails when it is broken:

1. **The session lives in an `httpOnly` cookie** and never reaches
   `localStorage` — the legacy system's worst defect, now a build failure.
2. **The session is identity, not tenant-scoped**; the active organisation is
   a separate, server-chosen value (ADR-0017).
3. **The role is never client-supplied** — `input: false`, and a body
   carrying it is refused.
4. **A privileged role requires the enrolment flag**, enforced by a database
   trigger, so no future code path can forget it.
5. **Every tenant table has forced RLS** and the app role cannot bypass it.
6. **The session token really rotates** — a stolen cookie dies at the next
   refresh.
7. **Password guessing is bounded per ACCOUNT** (5 failures → 15 minutes), not
   only per IP, because a client that chooses its own address is handed its
   own budget.

The threat model, the three authorisation layers, the secrets rules and the
audit trail are in **[docs/SECURITY.md](./docs/SECURITY.md)**.

---

## Repository layout

```
apps/web/                the Next.js app: public site, workspace, Payload mount, API
packages/auth/           identity: the Better Auth instance, roles, the MFA policy
packages/db/             the domain schema, migrations, RLS, the Drizzle client
packages/cms/            the Payload content plane and the admin session strategy
packages/core/           24 pure domain modules
packages/ui/             the design system
packages/assistant/      the role→tool matrix and the offline assistant
packages/observability/  logging, correlation, health probes
scripts/                 setup, bootstrap, seeding, snapshotting, verification
docs/                    the documentation, including the ADRs
AUDIT/                   the audit of the legacy system this rebuild answers
```

---

## Commands

| Command | What it does |
| --- | --- |
| `pnpm bootstrap` | the whole local setup, idempotently |
| `pnpm dev:local` | start everything with the root `.env.local` loaded |
| `pnpm verify` | lint + typecheck + the whole test suite — what CI runs |
| `pnpm test` | every suite |
| `pnpm test:unit` | the suites that need no database |
| `pnpm test:integration` / `pnpm test:e2e` / `pnpm test:a11y` | the rest |
| `pnpm lint` / `pnpm typecheck` | the gates, individually |
| `pnpm db:migrate` / `pnpm db:rollback` / `pnpm db:studio` | the domain schema |
| `node scripts/create-role-accounts.mjs` | seed the seven role accounts |
| `node scripts/verify-assistant-roles.mjs` | end-to-end proof of role scoping |

`pnpm verify` is the gate. It is what CI runs and it must be green before a
change is claimed to work.

---

## Documentation

| Document | Contents |
| --- | --- |
| [docs/README.md](./docs/README.md) | the documentation index |
| [docs/SETUP.md](./docs/SETUP.md) | prerequisites, bootstrap, step-by-step, troubleshooting |
| [docs/AI-AGENT-GUIDE.md](./docs/AI-AGENT-GUIDE.md) | the agent playbook |
| [AGENTS.md](./AGENTS.md) | the rulebook, always in force |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | the system map and the request lifecycle |
| [docs/DATA-MODEL.md](./docs/DATA-MODEL.md) | the three planes, the ERD, all 91 tables |
| [docs/SECURITY.md](./docs/SECURITY.md) | the threat model and the demo deviations |
| [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) | day-to-day work and conventions |
| [docs/TESTING.md](./docs/TESTING.md) | the test strategy and what each suite proves |
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | deployment, environment, migrations, playbooks |
| [docs/DEMO.md](./docs/DEMO.md) | the demo runbook |
| [docs/adr/](./docs/adr/README.md) | the decision records |
| [AUDIT/](./AUDIT/00_AUDIT_README.md) | the audit of the legacy system |

---

## Project status

- The domain schema, the identity plane, the content plane, the workspace,
  the public site, the assistant and the CMS are implemented and running.
- The identity and domain rules are covered by 2 400+ tests, including
  per-tenant isolation suites and a mutation-verified control suite.
- The demo build signs in with a password only. The second factor is
  implemented and its policy is enforced; the challenge itself is switched
  off, deliberately, and the deviation is documented rather than hidden.
- The legacy audit's open findings are tracked in
  [`AUDIT/95_FINAL_RECOMMENDATION.md`](./AUDIT/95_FINAL_RECOMMENDATION.md).

---

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) first. The short version: the gates
are `pnpm verify`, the commit convention is conventional commits with a body
that explains **why**, and a change to behaviour comes with a change to the
test that asserted the old behaviour — never a silent deletion.

Security issues go through the disclosure process in
[SECURITY.md](./SECURITY.md), not a public issue.

---

## License

See [LICENSE](./LICENSE). All rights reserved unless the owner publishes a
different license for this repository.
