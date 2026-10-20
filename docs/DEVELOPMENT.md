# Development

How to work on Raptor OS day to day: the commands, the conventions, the
places things live, and the process for a change that needs a decision
recorded.

---

## 1. The command vocabulary

```sh
pnpm dev:local                # start everything with the root .env.local loaded
pnpm build                    # turbo build across the workspace
pnpm lint                     # eslint, zero warnings tolerated
pnpm typecheck                # tsc --noEmit across the workspace
pnpm test                     # every suite
pnpm verify                   # lint + typecheck + test — what CI runs
pnpm ci                       # the per-package ci task (lint, typecheck, test)
```

Per package:

```sh
pnpm --filter @raptor/auth test
pnpm --filter @raptor/core test
pnpm --filter @raptor/db test
pnpm --filter web test
pnpm --filter web typecheck
```

Database:

```sh
pnpm db:migrate               # apply pending migrations
pnpm db:rollback              # reverse the last migration
pnpm db:seed                  # seed data
pnpm db:studio                # Drizzle Studio
```

Local scripts:

```sh
node scripts/setup-local.mjs            # databases, roles, schema, preview seed
node scripts/create-role-accounts.mjs   # the seven role accounts
node scripts/verify-assistant-roles.mjs  # end-to-end proof of role scoping
node scripts/dump-local-db.mjs           # snapshot the database into the repo
node scripts/restore-local-db.mjs        # restore that snapshot
```

---

## 2. The shape of a change

1. **Understand the area.** Read the file's header comment before the code —
   in this repository the header is where the reasoning, the measurements and
   the traps live.
2. **Write the failing test.** A test that passes whether or not the control
   exists is decoration. If you can break the implementation and watch the
   test fail, you have a test.
3. **Change the implementation** — the smallest change that makes the test
   pass.
4. **Update the comments** that describe what you changed.
5. **Verify.** `pnpm --filter <package> test`, then `pnpm verify`.
6. **Prove it live** if it touches the running stack:
   `node scripts/verify-assistant-roles.mjs`.
7. **Commit** with a conventional subject and a body that explains why.

---

## 3. Where things live

```
apps/web/
  src/app/(site)/        public fan site
  src/app/(app)/         role-aware workspace
  src/app/(payload)/     Payload admin mount
  src/app/api/           auth, assistant, health, ready
  src/components/        app/ (workspace) and public/ (fan site)
  src/server/            server-side data access, session guard, nav gating
  src/__tests__/         jsdom suites, including the token-storage guard

packages/auth/
  src/config.ts          the Better Auth instance — the heart of the identity
  src/roles.ts           the role vocabulary and the MFA policy
  src/schema.sql         the identity schema (hand-written, not a migration)
  src/account-lockout.ts the per-account password budget
  src/email.ts           transactional email
  src/*.test.ts          the suites that prove the controls

packages/db/
  migrations/            16 forward-only SQL migrations
  src/index.ts           the Drizzle client
  src/*.isolation.test.ts  one per domain area: does the app role see only
                          its own tenant's rows?

packages/core/           24 pure domain modules (no I/O, no framework)
packages/cms/            Payload collections, globals, the admin session strategy
packages/ui/             the design system
packages/assistant/      the role→tool matrix and the offline assistant
packages/observability/  the logger, the correlation context, the health probes
```

---

## 4. Conventions

### TypeScript

- Strict, and no `any`. When a library type does not fit, narrow it to
  `unknown` and read the value structurally — the repo does this in several
  places and the comments say why.
- `import type` for type-only imports.
- No `as` casts to silence a type error. If a cast is genuinely
  unavoidable, the comment above it explains the boundary.

### Comments

- Comments describe what the code **does**, and say why where the why is not
  obvious.
- A comment that quotes a measurement is worth ten that assert a virtue.
- A comment that is wrong is a defect. When the behaviour changes, the
  comment changes with it — including the ones that describe a control that
  has been removed.

### Logging

- `logger.info(...)` from `@raptor/observability`. Never `console.*` in
  application code; CI greps for it.
- Never log a token, a password, a cookie, a connection string or a request
  body. A URL that carries a reset link is a bearer credential.

### Styling

- `@raptor/ui` primitives and the design tokens. No ad-hoc colours, no
  one-off spacing, no inline `style` where a token exists.
- Both themes must work. A mark that is legible on one background and
  invisible on the other is a bug, not a preference.

### Accessibility

- Keyboard reachable, focus moved deliberately, live regions for status
  changes, and the a11y suite as the gate. The UI package's own tests assert
  the behaviour of its primitives.

---

## 5. Decisions that need a record

When a change is a decision rather than an implementation — a trade-off, a
reversal, a constraint that will bite later — it gets an ADR.

```sh
# docs/adr/NNNN-short-kebab-title.md
```

The format is in [`adr/README.md`](./adr/README.md). The short version:

```markdown
# NNNN. Title in a sentence

Status: Accepted | Superseded by NNNN

## Context
What forced the decision. Facts, measurements, constraints.

## Decision
What was chosen, in the present tense.

## Consequences
What this makes easy, what it makes hard, and what it forecloses.
```

An ADR is written when the decision is made, not afterwards, and it is never
rewritten to reflect a later decision — a later decision supersedes it.

---

## 6. Git conventions

- Conventional commits: `feat(scope):`, `fix(scope):`, `docs(scope):`,
  `refactor(scope):`, `test(scope):`, `chore(scope):`.
- The subject is a command and fits on one line.
- The body explains **why** and, where a claim is being made, **how it was
  verified**. Paste the evidence.
- One concern per commit. A refactor and a behaviour change in the same
  commit is two commits.
- Branches: `feat/…`, `fix/…`, `docs/…`, `chore/…`.

---

## 7. The portable snapshot

The repository carries a snapshot of a working local database, so a fresh
clone can reach a populated environment without re-seeding:

```sh
node scripts/setup-local.mjs     # create the database and the roles
node scripts/restore-local-db.mjs # replay the snapshot
node scripts/create-role-accounts.mjs  # (optional) rebuild the role accounts
```

The snapshot holds LOCAL-DEV-ONLY data: fixed local passwords and a
development database. It is not a production export and must never point at
one.

---

## 8. Performance

- The domain queries are index-backed; the migrations create the indexes
  alongside the tables.
- `packages/core` is pure, so the hot rules (allocation, eligibility,
  reconciliation) can be memoised and tested without a database.
- The assistant is offline by design: it reads the tenant database and
  formats the answer. No request leaves the machine.
- Measure before optimising. The `performance_extraction` and
  `match_player_performance` tables exist because the metrics were designed
  rather than recovered (ADR-0019).

---

## 9. When you are stuck

| Symptom | Where to look |
| --- | --- |
| "the schema does not match" | `packages/auth/src/schema.sql` header |
| "the migration ledger is out of order" | `packages/db/migrations/`, and `packages/db/src/migrations.ts` |
| "the policy is invisible" | the table has RLS and no policy — `packages/db/src/*.isolation.test.ts` |
| "the role is not what I expected" | `packages/auth/src/roles.ts` and the `user_role_membership_check` constraint |
| "the session is null" | `apps/web/src/server/session.ts`, and the `orgId` on `auth_session` |
| "the assistant refuses a role" | `packages/assistant/src/matrix.ts` and `apps/web/src/server/nav.ts` — they must agree |
| "the audit found a control that is decorative" | `packages/auth/src/load-bearing-settings.test.ts` — the mutation method |
