# Operations

How Raptor OS is configured, deployed, migrated, observed and recovered.

---

## 1. Environments

| | Local | Preview / staging | Production |
| --- | --- | --- | --- |
| Database | native Postgres 16, loopback | managed Postgres (Supabase), pooled | managed Postgres, pooled |
| App role | `raptor_app` | `raptor_app` | `raptor_app` |
| Migrator | `raptor_migrator` | `raptor_migrator` | `raptor_migrator` |
| CMS role | `cms_app` | `cms_app` | `cms_app` |
| Media | local disk under `.data/` | S3-compatible bucket | S3-compatible bucket |
| App process | `next start --port 3000` | one Vercel origin | one origin behind an edge |
| Email | console (development fallback) | Resend | Resend |

The roles are the same in every environment, and the application role never
owns the schema. That is the property that makes a preview deployment
behave like production rather than like a different system.

---

## 2. Environment variables

The full list with explanations is in [`.env.example`](../.env.example). The
ones that decide whether the system starts at all:

| Variable | Required | Rule |
| --- | --- | --- |
| `DATABASE_URL` | yes | the **app** role. A migrator credential here is refused by `packages/auth/src/env.ts` |
| `DATABASE_MIGRATION_URL` | for migrations | the schema owner. Must never appear in an application environment |
| `BETTER_AUTH_SECRET` | yes | ≥32 characters, ≥12 distinct, not a placeholder. Mints a session for any account |
| `BETTER_AUTH_URL` | yes | this deployment's own origin; also the only trusted origin |
| `NEXT_PUBLIC_APP_URL` | yes | the public origin, used for links and the origin check |
| `PAYLOAD_SECRET` | yes | the CMS signing key, per environment |
| `PAYLOAD_DATABASE_URI` | yes | the `cms_app` role |
| `RESEND_API_KEY` | in production | absent + `NODE_ENV=development` prints links to the console instead |
| `EMAIL_FROM` | with Resend | the sending address |
| `AUTH_TRUSTED_IP_HEADERS` | behind an edge | **only** a header your edge overwrites |
| `AUTH_TRUSTED_PROXIES` | with the above | the CIDR ranges of that edge |
| `PUBLIC_ORG_ID` / `PUBLIC_ORG_SLUG` | yes | which single tenant the public site renders |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | optional | all five, or none — with none set, media lands on local disk |
| `STORAGE_ROOT` | optional | where local media lands (`.data/storage`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `SENTRY_DSN` | optional | telemetry |

Two of these are traps, and both are traps the code guards:

- **A forwarding header that your edge does not overwrite** hands every client
  its own rate-limit budget. Leave `AUTH_TRUSTED_IP_HEADERS` empty unless you
  can name the header your edge overwrites.
- **A weak `BETTER_AUTH_SECRET`** lets anyone mint a session for any
  account, including one whose email was never verified. The development
  secret is the secret that gets promoted; the check does not travel with
  `NODE_ENV`.

---

## 3. Migrations

```sh
pnpm db:migrate      # apply pending migrations
pnpm db:rollback     # reverse the last one
pnpm db:generate     # generate a migration from the Drizzle schema
```

Rules:

- **Forward-only.** A landed migration is never edited. A correction is a new
  migration.
- **One prefix per migration**, numbered. A duplicate fails CI.
- **Applied under an advisory lock**, so two instances starting at once cannot
  race.
- The **identity schema is not a migration.** `packages/auth/src/schema.sql`
  is a deployment-time asset owned by the auth package, applied as
  `raptor_migrator` and idempotent. `scripts/setup-local.mjs` applies it
  after the domain migrations, in that order — the order matters, because the
  identity schema's functions read domain tables.
- The **CMS schema belongs to Payload**. `pnpm --filter @raptor/cms cms:migrate`
  owns the `cms_*` tables. They are not in the domain ledger and never in the
  Supabase baseline.

A deployment order that works:

```
1. apply the domain migrations        (pnpm db:migrate)
2. apply the identity schema          (packages/auth/src/schema.sql, as migrator)
3. apply the CMS migrations           (payload migrate)
4. deploy the application
```

---

## 4. Deployment

### Vercel (the preview target)

- Build: `pnpm build`; the web app is the only deployable.
- Environment: every variable in §2, set in the project settings.
- `DATABASE_URL` points at the **pooled** connection string; the migration
  role is used by the migration step only, never by the running app.
- `sentry`/OTEL optional.

### A managed Postgres (Supabase)

- Create the three roles by hand from `packages/db/scripts/local-bootstrap.sql`,
  adapted to the managed environment.
- Apply `packages/cms/provision.sql` for the RLS policies and grants.
- Keep `packages/cms/provision.sql` as the source of truth for RLS: it is
  applied on every environment, so a policy cannot exist in one place and not
  another.

### A plain VM

The same three roles, the same order, one origin behind an edge that
overwrites the client-IP header.

---

## 5. Health and observability

| Endpoint | Meaning |
| --- | --- |
| `/api/health` | liveness — the process is up |
| `/api/ready` | readiness — the process AND its dependencies are usable |

Both are built on `@raptor/observability`'s probe helpers, and both answer
without touching a tenant.

Logs are structured (`logger.info(...)` from `@raptor/observability`), carry a
correlation id that follows a request across layers, and never contain a
token, a password, a cookie, a connection string or a request body. A URL
that carries a password-reset link is a bearer credential and is not logged
outside the email that carries it.

---

## 6. Backups and portability

```sh
node scripts/dump-local-db.mjs     # snapshot the database into the repository
node scripts/restore-local-db.mjs  # replay a snapshot
```

The snapshot is a full custom-format dump plus the credential fixture, and it
makes a local environment portable: a fresh clone can reach a populated stack
without re-seeding.

For a real deployment, take the backups your provider takes and restore them
into a scratch instance **before** you need them. The rule is the same one
the rest of this repository follows: a backup that has never been restored is
a hypothesis.

---

## 7. Incident playbooks

### "Every sign-in reports an unknown email"

The identity schema was never applied, or was applied before the domain
schema. The tables are missing, and the RLS-protected lookup finds no rows —
which is indistinguishable from a wrong password.

```sh
node scripts/setup-local.mjs      # applies the schemas in the right order
```

### "The sign-in rate limit is tripping in production"

The per-IP budget is 5 attempts per 60 seconds per path, and with no
forwarding header configured there is exactly ONE bucket per path for the
whole deployment. One determined client can lock everyone else out of signing
in for the length of the window — fail-closed against spoofing, fail-open
against availability. If you run behind an edge that overwrites the
client-IP header, set `AUTH_TRUSTED_IP_HEADERS` to that header and
`AUTH_TRUSTED_PROXIES` to the edge's ranges.

### "A privileged account cannot sign in"

Its `twoFactorEnabled` is not true, and the policy refuses a session to a
privileged account without it. That is the control working. Set the flag
server-side — the flag is a provisioning state, never a client assertion.

### "The app is slow, or a query returns nothing"

Check the tenant GUC. Every tenant read runs with
`SET LOCAL app.org_id = <org>`; a missing or stale value returns no rows
rather than an error, because RLS is doing its job. `packages/db/src/*.isolation.test.ts`
is the reference for what each query should return.

### "A client's `Retry-After` says to wait five million years"

The persisted rate-limit counter is being read as a string and added to
instead of being added to as a number. `auth_rate_limit.lastRequest` must be
`double precision`; `bigint` comes back from node-postgres as a string.
`packages/auth/src/schema.test.ts` pins the type.

---

## 8. The demo build

The build this repository currently ships does not issue a TOTP challenge:
the `twoFactor` plugin is not installed, so a password is the whole sign-in
for every role, including owner and the CMS admin.

**A privileged account in that build is protected by its password alone.**
That is fine for a local demo and is not fine for a deployment holding real
data. The full statement of what is and is not still enforced — and the
three steps to re-enable the challenge — is in
[SECURITY.md → Demo deviations](./SECURITY.md#demo-deviations).
