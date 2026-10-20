# Architecture

Raptor OS is a multi-tenant operating system for an esports organisation. It is
one Next.js process serving four surfaces, one Postgres database with 91
domain tables plus the identity and CMS schemas, and one domain engine that
holds the rules.

This document describes the shape of the system and the reasoning behind it.
For the decisions themselves, see [`docs/adr/`](./adr/README.md) — an ADR is
the record of a choice; this file is the map of what exists.

---

## 1. The one-line summary

```
                      ┌──────────────────────────────────────────┐
   browser  ────────▶ │  apps/web — one Next.js process (:3000)   │
                      │                                          │
                      │   (site)      public fan site            │
                      │   (app)       role-aware workspace       │
                      │   (payload)   /cms-admin                  │
                      │   /api/auth   Better Auth handler        │
                      │   /api/assistant   offline assistant      │
                      └───────┬──────────────────────┬───────────┘
                              │                      │
                    ┌─────────▼─────────┐   ┌────────▼──────────┐
                    │  packages/auth    │   │  packages/cms     │
                    │  identity + policy│   │  content plane    │
                    └─────────┬─────────┘   └────────┬──────────┘
                              │                      │
                    ┌─────────▼──────────────────────▼───────────┐
                    │            PostgreSQL 16                    │
                    │  auth_* (identity) · cms_* (content)         │
                    │  91 domain tables, RLS on every tenant table│
                    └──────────────────────┬──────────────────────┘
                                           │
                    ┌──────────────────────▼──────────────────────┐
                    │  packages/db  ·  packages/core  ·  observability
                    │  schema + RLS      pure rules      logs
                    └─────────────────────────────────────────────┘
```

Everything a browser touches is served by a single origin on port 3000. There
is no second process to run, no API gateway to configure and no separate CMS
server to remember a port for: the public site, the workspace, the admin
console and the API are route groups inside one Next.js app.

---

## 2. Packages

| Package | What it owns | What it must never own |
| --- | --- | --- |
| `@raptor/web` | The four surfaces, the API routes, the server-side data access, the session guard | Business rules; direct SQL |
| `@raptor/auth` | The Better Auth instance, the identity schema, the role vocabulary, the MFA policy, the account lockout, transactional email | The domain schema; tenant data |
| `@raptor/db` | The domain schema, 16 forward-only migrations, RLS policies and grants, the Drizzle client | Auth tables; CMS tables |
| `@raptor/cms` | Payload CMS: publishable collections and globals, the `cms_*` tables, the Better Auth session strategy for the admin console | The domain schema; product identity |
| `@raptor/core` | 24 domain modules of pure business rules — money, prize allocation, ledgers, contracts, attendance, workflows, HR, minors, FX, authorisation | Any I/O; any framework |
| `@raptor/ui` | The design system: tokens, primitives, layout, accessibility behaviour | Data fetching; product copy |
| `@raptor/assistant` | The role→tool matrix and the offline workspace assistant | Write tools; data outside the caller's tenant |
| `@raptor/observability` | The structured logger, correlation context, liveness and readiness probes | Secrets; request bodies |

The boundaries are not decoration. `packages/core` is DB-free and framework-free
on purpose: it is the part of the system whose rules can be read, tested and
argued about without a database, which is what makes 1 545 of its tests cheap
and fast.

---

## 3. Request lifecycle

```
  1. Request arrives at :3000
        │
  2. Middleware resolves the session cookie (httpOnly) → session row
        │     (packages/auth — the session is identity, NOT tenant-scoped:
        │      it names a person, not an organisation; see ADR-0017)
        │
  3. The route handler asks for the ACTIVE ORGANISATION
        │     (auth_set_active_org — the only writer of auth_session.orgId)
        │
  4. Every tenant table is read through the app role with
        │     SET LOCAL app.org_id = <org>
        │     → row-level security filters the result set
        │
  5. The domain rule runs (packages/core) on the rows RLS returned
        │
  6. The response is rendered, and the audit log records the mutation
```

Step 4 is the load-bearing one. The application role cannot read another
tenant's rows even if the handler asks it to: the policy on the table is
`org_id = current_org_id()`, and `current_org_id()` reads a session GUC that
only the server sets. A bug in application code is therefore a bug in one
tenant's data, not a cross-tenant breach.

---

## 4. Identity and tenancy

Three identities, one person.

```
   auth_user                person                 organization
   (a login)                (the human)             (the tenant)
       │                       │                          │
       │  person_credential_link (ADR-0018)               │
       └───────────────────────┼──────────────────────────┘
                               │
                     org_membership (active?) ──▶ org_membership.person_id
```

- **`auth_user`** — the login. A person may hold more than one login (or none:
  a person can exist before they ever sign in).
- **`person`** — the root of the identity. Contracts, HR records, attendance
  and documents hang off a person, not off a login, so the record survives the
  person changing email address or the organisation changing its email
  provider.
- **`person_credential_link`** — the join, and the reason a login with no link
  resolves to no person, joins to nothing, and therefore cannot transact
  anywhere. It is the boundary the ADR calls the identity boundary.

### Roles

Seven roles, written in exactly two places — `packages/auth/src/roles.ts` and
the `user_role_membership_check` constraint in the schema — and a test asserts
that the two agree:

| Role | May | Notes |
| --- | --- | --- |
| `pending` | nothing | the default a sign-up lands on |
| `player` | read-only team and competition views | |
| `coach` | + insights and roster | |
| `analyst` | + insights and roster | |
| `manager` | + member list | privileged: may not exist without the MFA flag |
| `admin` | + organisation overview | privileged |
| `owner` | everything | privileged |

"Privileged" is a security boundary, not a label: `manager`, `admin` and
`owner` may not hold their role unless the account carries the enrolment flag,
and that rule is enforced by a database trigger, not by application code.

---

## 5. The content plane

`packages/cms` is a Payload CMS mounted inside the same Next.js process:

- `/cms-admin` — the admin console
- `/cms-api` — Payload's own API

It owns the `cms_*` tables and nothing else. The canonical SQL schema and the
Supabase baseline never mention them, and the domain schema never mentions
them. The two planes meet at exactly one place: `public_site_publication`, the
table that says which published content belongs to which organisation.

The admin console authenticates with the SAME identity as the product. The
`better-auth` session strategy resolves a session cookie through
`cms_operator_session(token)`, a `SECURITY DEFINER` function that checks the
session is live, the email is verified, and the email matches a `cms_operators`
row. There is no second set of admin credentials, and no separate CMS
password to leak.

---

## 6. The assistant

`packages/assistant` is an offline, role-scoped read tool. Its scope matrix is
a single object:

```ts
export const TOOL_SCOPES = {
  listTeams:        ["player", "coach", "analyst", "manager", "admin", "owner"],
  listCompetitions: ["player", "coach", "analyst", "manager", "admin", "owner"],
  getInsights:      ["coach", "analyst", "manager", "admin", "owner"],
  getRoster:        ["coach", "analyst", "manager", "admin", "owner"],
  listMembers:      ["manager", "admin", "owner"],
  getOrgOverview:   ["admin", "owner"],
};
```

Every role not listed for a tool is denied, so a new tool is unreachable until
a role is explicitly added. The matrix mirrors the workspace navigation
(`apps/web/src/server/nav.ts`) — the navigation is the human-facing half of
the same contract — and the assistant enforces it independently, failing
closed. `scripts/verify-assistant-roles.mjs` proves both halves agree against
the running stack.

---

## 7. Data planes at a glance

| Schema | Owner | Tables | Protection |
| --- | --- | --- | --- |
| `auth_*` | `packages/auth` | 6 | Role-based grants; no tenant predicate (ADR-0017) |
| `cms_*` | `packages/cms` | Payload's | RLS from `packages/cms/provision.sql` |
| domain | `packages/db` | 91 | Forced RLS on every tenant-scoped table |

The identity tables are protected by ROLE, not by tenant, and that is a
deliberate inversion: a session is not tenant-scoped, so a tenant predicate on
it would be a fiction. The reasoning is in ADR-0017 and the assertions are in
`packages/auth/src/session-isolation.test.ts`.

---

## 8. Deployment topology

The same code runs in three places, and only the environment changes.

```
  local (Windows/macOS/Linux)          preview (Vercel + managed Postgres)
  ───────────────────────────          ─────────────────────────────────
  next start --port 3000               Vercel: next build, one origin
  native Postgres 16 on loopback       managed Postgres (Supabase) w/ pooler
  cms_app + raptor_app + migrator     same three roles
  local disk under .data/              S3-compatible bucket for media
```

The application role is the same in both: it never owns the schema and never
holds a superuser bit. `packages/auth/src/env.ts` refuses a `DATABASE_URL`
that points at the migration role, so a deployment cannot accidentally hand
the application the keys to the schema.

---

## 9. Design constraints that survive refactors

These are the properties the rest of the system is built to keep. Each one
has a test that fails when it is broken.

1. **The session is identity, not tenant-scoped.** A session names a person.
   The active organisation is a separate, server-chosen value.
2. **The role is not client-supplied.** `role` is declared `input: false`; a
   request body carrying it is refused.
3. **A privileged role requires the MFA flag**, and the rule lives in a
   database trigger so no future code path can forget it.
4. **Every tenant table has forced RLS** and the app role cannot bypass it.
5. **The schema is applied by a migration ledger, forward-only**, under an
   advisory lock, and a duplicate ordering prefix fails CI.
6. **The build gates stay enabled** (`ignoreBuildErrors` and
   `ignoreDuringBuilds` are asserted absent by CI).
7. **No bare `console.*` in application code** — the structured logger is the
   only channel, so logs are parseable and never carry a secret.
8. **No secret is ever committed**, and a tracked `.env` file fails CI.

---

## 10. Where to read next

| Question | Document |
| --- | --- |
| How do I run it? | [SETUP.md](./SETUP.md), [DEMO.md](./DEMO.md) |
| How does an AI agent set it up? | [AI-AGENT-GUIDE.md](./AI-AGENT-GUIDE.md), [`AGENTS.md`](../AGENTS.md) |
| What are the rules and why? | [SECURITY.md](./SECURITY.md) |
| What does the data look like? | [DATA-MODEL.md](./DATA-MODEL.md) |
| How do I work on it day to day? | [DEVELOPMENT.md](./DEVELOPMENT.md) |
| How is it tested? | [TESTING.md](./TESTING.md) |
| How is it deployed and run? | [OPERATIONS.md](./OPERATIONS.md) |
| Why was it built this way? | [adr/](./adr/README.md) |
| What was wrong with the legacy system? | [`../AUDIT/00_AUDIT_README.md`](../AUDIT/00_AUDIT_README.md) |
