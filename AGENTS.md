<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

---

# Working on Raptor OS

You are working on a multi-tenant operating system for an esports
organisation: a Next.js monorepo with a workspace app, a public site, a
Payload CMS, an identity package, a domain database and a pure domain
engine. Read `docs/ARCHITECTURE.md` before your first structural change.

The full playbook is **[docs/AI-AGENT-GUIDE.md](./docs/AI-AGENT-GUIDE.md)**.
This file is the short version: the rules that always apply.

---

## 1. Set the environment up

```sh
pnpm install
pnpm bootstrap      # databases, roles, schema, migrations, .env.local, seed accounts
pnpm dev:local      # http://localhost:3000
```

`pnpm bootstrap` is idempotent, takes no input and is safe to re-run. It is
the only supported way to prepare a machine.

**Never boot the workspace with `pnpm dev`.** Next.js reads `.env*` from
`apps/web/`, but this repository keeps one `.env.local` at the root.
`scripts/dev-env.mjs` loads it and starts the packages with it; without it
every auth route answers 503 and it looks like a broken backend.

Check the stack is alive before you change anything:

```sh
curl -s http://localhost:3000/api/health
```

---

## 2. The invariants — do not break these

Each has a test that fails when it is broken.

1. **The session is identity, not tenant-scoped** (ADR-0017). It names a
   person. The active organisation is a separate, server-chosen value
   written only by `auth_set_active_org`.
2. **The role is never client-supplied.** `role` is `input: false`. The same
   is true of `twoFactorEnabled`.
3. **A privileged role requires the enrolment flag**, and the authority is
   the `user_mfa_guard` trigger in `packages/auth/src/schema.sql` — not
   application code.
4. **Every tenant-scoped table has forced RLS**, and the app role cannot
   bypass it. A table with RLS and no policy is invisible, not merely
   unprotected.
5. **The application role never owns the schema.** `packages/auth/src/env.ts`
   refuses a migrator credential in `DATABASE_URL`.
6. **Migrations are forward-only.** Never edit a landed migration; add a new
   one. A duplicate ordering prefix fails CI.
7. **The build gates stay enabled** (ADR-0012) and there is no bare
   `console.*` in application code. Both are CI greps.
8. **No secret is ever committed**, and no secret appears in a document, a
   fixture or a test.
9. **The session never reaches client-side storage.**
   `apps/web/src/__tests__/no-client-token-storage.test.ts` fails the build
   if `localStorage` or `sessionStorage` reappears.

---

## 3. Make the change

- Read the file's header comment first. In this repository the header is
  where the reasoning, the measurements and the traps live.
- Write the failing test first, and **watch it fail**. A test that passes
  whether or not the control exists is decoration.
- Change the smallest thing that makes it pass.
- Update the comments that describe what you changed. A comment that
  describes a control that no longer exists is a defect.
- Never weaken an assertion to make a suite pass. If the old behaviour was
  wrong, change the test and say so in the commit message.

Where things belong:

| Change | Goes in |
| --- | --- |
| a business rule | `packages/core/src/<module>/` with its test beside it |
| a schema change | a NEW file in `packages/db/migrations/` |
| a page or component | `apps/web/src/app/(site)` or `(app)`, on `@raptor/ui` primitives |
| a publishable content type | `packages/cms/src/` plus a Payload migration |
| preview data or preview content | `scripts/preview-seed.sql` (domain) or `scripts/preview-seed-cms.sql` (CMS) — never only inside the database snapshot |
| an auth behaviour | `packages/auth/src/config.ts`, with the reason in the header |

---

## 4. Verify

```sh
pnpm --filter @raptor/auth test    # the package you touched
pnpm verify                        # lint + typecheck + every suite — the gate
```

Then, for anything that touches the running stack, prove it live:

```sh
node scripts/create-role-accounts.mjs
node scripts/verify-assistant-roles.mjs
```

Report what you ran and what it printed. If a test fails and you did not fix
it, say so and paste the failure. If you could not run something, say that
too. A report that claims more than the evidence supports is the one failure
mode this repository was rebuilt to eliminate.

---

## 5. Commit and hand over

```sh
git add -A
git status && git diff --stat
git commit -F <file>
git push fork <branch>
gh pr create --repo akshuu21/raptor-os --base main --head agentIgris:<branch> \
  --title "feat(scope): ..." --body "..."
```

Conventional subject, and a body that explains **why** and **how it was
verified**. The pull request template is in
`.github/PULL_REQUEST_TEMPLATE.md`.

---

## 6. Traps

| Trap | Symptom | Fix |
| --- | --- | --- |
| The TOTP challenge is off, the policy is not | a privileged account is refused a session for a missing flag | set the flag server-side; never loosen the policy |
| An undeclared column vanishes from a payload | the adapter builds returned objects from the model's **declared** fields | declare the field on the model |
| `LANGUAGE sql` in a schema file | the function needs another package's tables to exist at CREATE time | use `plpgsql` |
| `bigint` and node-postgres | `int8` comes back as a string and `+` concatenates | use `double precision` for arithmetic values |
| A handle and its portrait drift apart | the roster silently shows the generic portrait | the seed and `apps/web/public/placeholders/` must agree; `preview-content.test.ts` checks it |
| A `plpgsql` function returns a `varchar` where it declares `text` | "structure of query does not match function result type" at CALL time, swallowed by the caller | cast at the source: `name::text` |
| The sign-in budget refuses the second role | the per-ADDRESS budget is per IP, and a dev machine has one | 30 per minute outside production; `AUTH_RATE_LIMIT_SIGNIN_MAX` overrides it |
| Content only in the database snapshot | a clone that runs `pnpm bootstrap` has no news, no partners, no site settings | seed it in `scripts/preview-seed-cms.sql` |
| `pnpm dev` without `dev:local` | every auth route answers 503 | use `pnpm dev:local` |
| PowerShell mangles `\|\|` and quotes | a command works in bash and not here | write a temporary `.mjs` and run it with `node` |
