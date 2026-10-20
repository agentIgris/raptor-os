# AI Agent Guide

This is the playbook for an autonomous agent working on Raptor OS. It is
written to be executed, not read: every step has an exact command, and every
step says what "done" looks like.

`AGENTS.md` at the repository root is the short version — the rules that
always apply. This document is the long version: the how and the why.

---

## 0. The golden rule

**Prove it, do not assume it.** This repository was rebuilt after an audit
found that the legacy system shipped code whose comments described behaviour
it did not have. The house style, therefore, is:

- a claim about the system is backed by a measurement or a test that fails when
  the claim stops being true;
- a comment describes what the code **does**, not what it was meant to do;
- when you change a behaviour, the test that asserted the old behaviour is
  changed **with a comment saying why the new behaviour is correct** — never
  deleted silently.

An agent that cannot verify a change must say so in its final report, in
those words. "Probably works" is not a report.

---

## 1. Bootstrap the environment (one command)

```sh
pnpm install
pnpm bootstrap
```

`pnpm bootstrap` runs `scripts/bootstrap-local.mjs`, which is idempotent and
non-interactive. It checks the prerequisites, creates the databases and the
three roles, applies the domain migrations, the identity schema, the CMS
provisioning and the Payload migrations, writes `.env.local` with generated
secrets (never overwriting an existing one), seeds the preview tenant and the
seven role accounts, and prints the result.

**Done when** the command exits 0 and prints the account table. It is safe to
re-run: every step is either idempotent or skipped when its output already
exists.

If it cannot connect to Postgres, the message says so explicitly. Start the
service and re-run:

```powershell
Get-Service postgresql-x64-16 | Start-Service   # Windows
```

```sh
brew services start postgresql@16              # macOS
```

```sh
sudo systemctl start postgresql                # Debian/Ubuntu
```

---

## 2. Start the stack

```sh
pnpm dev:local
```

**Not** `pnpm dev`. `scripts/dev-env.mjs` reads the repository-root
`.env.local` and injects it into every package; booting the workspace directly
starts it with an empty environment, and `/api/auth/*` answers 503. That
failure looks like a broken backend and is not one.

**Done when** <http://localhost:3000/api/health> returns
`{"status":"ok",...}` and <http://localhost:3000/sign-in> renders.

---

## 3. Orient yourself before editing

The repository is a pnpm + Turborepo monorepo. Run this once per session:

```sh
pnpm --filter @raptor/auth test        # the package you are about to change
pnpm --filter web typecheck
git log --oneline -10
git status
```

Read before you write:

| Before touching | Read |
| --- | --- |
| `packages/auth/src/config.ts` | the file header — it explains the installed API shape, and every option in it was read out of the installed library rather than from documentation |
| `packages/auth/src/schema.sql` | the file header — it explains why the schema is hand-written and not a migration |
| `packages/db/migrations/*.sql` | the ledger; migrations are forward-only and never edited after they land |
| `packages/core/src/<module>` | the module's own header; the rules are pure and the tests are the specification |
| `apps/web/src/app/...` | `apps/web/AGENTS.md` — Next.js conventions differ from your training data, and the installed version's guide is in `node_modules/next/dist/docs/` |
| Anything in `docs/adr/` | the ADR for that decision; it records the reasoning, including the options rejected |

---

## 4. The invariants you must not break

These are load-bearing. Each has a test that fails when it is broken, and CI
fails on the build-gate and console-log versions of them.

1. **The session is identity, not tenant-scoped** (ADR-0017). A session names
   a person. The active organisation is a separate, server-chosen value
   written only by `auth_set_active_org`.
2. **The role is never client-supplied.** `role` is `input: false`. Do not
   make it writable, and do not add a request path that writes it.
3. **A privileged role requires the MFA flag**, and that rule lives in a
   database trigger (`user_mfa_guard`). Application code is the early,
   well-messaged rejection; the trigger is the authority.
4. **Every tenant-scoped table has forced RLS**, and the app role cannot
   bypass it. A new tenant table without a policy is invisible to the app,
   not merely unprotected.
5. **The application role never owns the schema.** `packages/auth/src/env.ts`
   refuses a `DATABASE_URL` pointing at the migrator — do not weaken that
   check.
6. **Migrations are forward-only.** Never edit a landed migration; add a new
   one. A duplicate ordering prefix fails CI.
7. **The build gates stay enabled.** `ignoreBuildErrors` and
   `ignoreDuringBuilds` are asserted absent by CI (ADR-0012).
8. **No bare `console.*` in application code.** Use the structured logger
   from `@raptor/observability`. CI greps for it.
9. **No secret is ever committed.** A tracked `.env` fails CI. Never put a
   credential in a document, a fixture or a test.

---

## 5. Make the change

1. **Write the failing test first** when the change has a behaviour. In this
   repository a test that passes whether or not the control exists is
   decoration, and the mutation notes in `packages/auth/src/load-bearing-settings.test.ts`
   show the standard: run the test against the broken value and watch it fail.
2. **Change the smallest thing that makes the test pass.**
3. **Update the comments that describe what you changed.** They are not
   optional. A comment that says "the plugin challenges this" when the plugin
   is gone is worse than no comment.
4. **Do not weaken an assertion to make a test pass.** If the old behaviour
   was correct and the new one is not, fix the implementation instead. If the
   old behaviour was wrong, say so in the commit message and in the test.

### Where things belong

| Change | Goes in |
| --- | --- |
| A business rule | `packages/core/src/<module>/` with its test beside it |
| A query | `packages/db/src/`, behind the existing Drizzle client |
| A schema change | a NEW file in `packages/db/migrations/`, numbered next |
| A page or component | `apps/web/src/app/(site)` or `(app)`, using `@raptor/ui` primitives |
| A publishable content type | `packages/cms/src/`, with a migration for the `cms_*` table |
| An auth behaviour | `packages/auth/src/config.ts` and its test — and the reason goes in the header |

---

## 6. Verify — the ladder

Run the narrowest thing first, then widen:

```sh
pnpm --filter @raptor/auth test              # one package
pnpm --filter web typecheck
pnpm --filter web test
pnpm verify                                   # everything: lint + typecheck + all tests
```

`pnpm verify` is what CI runs. It must exit 0 before you claim anything.

Then, for anything that touches the running stack, prove it live:

```sh
node scripts/create-role-accounts.mjs        # seeds and signs in, password-only
node scripts/verify-assistant-roles.mjs       # every role signs in and is scoped correctly
```

And for a real sign-in, the shape of the proof is:

```sh
curl -sS -X POST http://localhost:3000/api/auth/sign-in/email \
  -H 'content-type: application/json' -H 'origin: http://localhost:3000' \
  -d '{"email":"owner@raptor.local","password":"raptor_local_dev_only"}' -i
```

A 200 with a `session_token` cookie is the result. `twoFactorRedirect` in the
body would mean a challenge is being issued — it should not be, in this build.

### Reporting honestly

State what you ran and what it printed. If a test fails and you did not fix
it, say so and paste the failure. If you could not run something (no database,
no browser), say that too. A report that claims more than the evidence
supports is the one failure mode this repository was rebuilt to eliminate.

---

## 7. Commit and hand over

```sh
git add -A
git status                      # look at every path before you commit
git diff --stat
git commit -F <message file>
```

The commit message follows the repository's convention — a conventional
subject, then a body that explains **why**:

```
feat(auth,web): <what changed, in one line>

<why it changed, what was measured, what a reviewer must know>
```

Then push to the fork and open a pull request against the upstream:

```sh
git push fork <branch>
gh pr create --repo akshuu21/raptor-os --base main --head agentIgris:<branch> \
  --title "..." --body "..."
```

The pull request body should answer: what changed, why, how it was verified
(paste the evidence), and what a reviewer must check. The template is in
`.github/PULL_REQUEST_TEMPLATE.md`.

---

## 8. Traps

| Trap | What it looks like | What to do |
| --- | --- | --- |
| The TOTP challenge is gone but the policy is not | a privileged account is refused a session because the enrolment flag is missing | set the flag server-side; never loosen the policy |
| An undeclared column vanishes from a payload | the installed adapter builds returned objects from the model's **declared** fields | declare the field on the model |
| `LANGUAGE sql` in a migration | a SQL-language function resolves its body's relations at CREATION time, so it needs other packages' tables to exist first | use `plpgsql`, which resolves at call time |
| `bigint` columns and node-postgres | `int8` comes back as a STRING, so `+` concatenates | use `double precision` for values that are arithmetic, or convert at the driver |
| Rate limits are per-IP and per-account | 5 sign-ins per 60s, 5 password failures per account | pace yourself; the scripts do |
| `pnpm dev` without `dev:local` | every auth route answers 503 | always use `pnpm dev:local` |
| PowerShell mangles `\|\|` and quotes | a command "works" in bash and not in the shell | write a temporary `.mjs` file and run it with `node` |

---

## 9. Reference

| Document | Contents |
| --- | --- |
| [SETUP.md](./SETUP.md) | the human setup guide, prerequisites, troubleshooting |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | the system map, request lifecycle, data planes |
| [SECURITY.md](./SECURITY.md) | the security model and the demo deviations |
| [DATA-MODEL.md](./DATA-MODEL.md) | the 91 domain tables, the identity boundary, the ERD |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | day-to-day workflow, conventions, the ADR process |
| [TESTING.md](./TESTING.md) | the test strategy and what each suite proves |
| [OPERATIONS.md](./OPERATIONS.md) | deployment, environment, migrations, observability |
| [DEMO.md](./DEMO.md) | the portable demo runbook |
| [adr/](./adr/README.md) | the decision records |
| [`../AGENTS.md`](../AGENTS.md) | the short rulebook, always in force |
