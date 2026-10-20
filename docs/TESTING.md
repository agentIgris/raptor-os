# Testing

The test suite is the reason this repository looks the way it does. The
legacy system had a green suite that passed while shipping four
cross-tenant defects and five auth defects; every rule below exists to stop
that from being possible again.

---

## 1. The standard

**A test that passes whether or not the control exists is not a weaker test;
it is decoration.** It reports coverage of the line while proving nothing
about the behaviour, and it reads as evidence during review.

So the rule is simple: *every* test must fail when the thing it names is
broken. That is verified by mutation, not assumed — the control is broken
deliberately, the suite is run, and the failure is observed.

`packages/auth/src/load-bearing-settings.test.ts` is the worked example. Its
header records the mutation harness:

> Seven settings in `config.ts` are each described in a code comment as
> something the system depends on. A mutation test replaced EVERY ONE of them
> with its broken value — both TypeScript MFA gates turned into no-ops,
> `trustedOrigins` widened to `["*"]`, CSRF disabled, `skipVerificationOnEnable`
> flipped, the MFA lockout turned off — and all 171 tests still passed.

Those seven are now guarded one test at a time, and each test states the
observable difference that makes it fail when its own control is removed.

---

## 2. The suites

| Suite | Command | Needs a database | What it proves |
| --- | --- | --- | --- |
| Unit (core) | `pnpm --filter @raptor/core test` | no | the domain rules: money, allocation, attendance, contracts, workflows, HR, minors, FX, authorisation |
| Unit (auth) | `pnpm --filter @raptor/auth test` | no (PGlite) | the identity controls and the gates |
| Unit (web) | `pnpm --filter web test` | no | components, the session guard, the token-storage invariant |
| Unit (ui) | `pnpm --filter @raptor/ui test` | no | the design system, including the accessibility behaviour of the primitives |
| Unit (cms) | `pnpm --filter @raptor/cms test` | no | the admin session strategy |
| Unit (assistant) | `pnpm --filter @raptor/assistant test` | no | the role→tool matrix |
| Integration | `pnpm test:integration` | yes (Postgres) | the domain schema under real RLS |
| End-to-end | `pnpm test:e2e` | yes | the browser paths against a production build |
| Accessibility | `pnpm test:a11y` | no | the accessibility gate |
| Live verification | `node scripts/verify-assistant-roles.mjs` | yes, running stack | every role signs in and is scoped correctly |

Everything runs in-process against **PGlite** (PostgreSQL in WebAssembly) where
a database is needed but a server is not, so the suite is hermetic and needs
no service. The one place a real Postgres is required is the integration
suite and the live scripts.

---

## 3. The suites that guard the security controls

| Control | Suite |
| --- | --- |
| The role cannot be supplied by a client, at sign-up or update, including nested | `packages/auth/src/mass-assignment.test.ts` |
| A privileged role requires the enrolment flag — in the database | `packages/auth/src/mfa-enforcement.test.ts` |
| A privileged unenrolled sign-in is refused, by each gate separately | `packages/auth/src/load-bearing-settings.test.ts` |
| The session token really rotates, and the old one dies | `packages/auth/src/session-rotation.test.ts` |
| A password change and a password reset evict the other sessions | `packages/auth/src/session-revocation.test.ts` |
| The session never reaches client-side storage | `apps/web/src/__tests__/no-client-token-storage.test.ts` |
| The identity tables carry no tenant predicate, and no fail-open branch | `packages/auth/src/session-isolation.test.ts`, `auth-tenancy.test.ts` |
| The app role sees only its own tenant's rows, per domain area | `packages/db/src/*.isolation.test.ts` |
| A password guess is bounded per ACCOUNT, not only per IP | `packages/auth/src/signin-throttle.test.ts` |
| The rate limiter is on everywhere, and its counters live in Postgres | `packages/auth/src/rate-limit.test.ts` |
| The `X-Retry-After` header is a number of seconds a client can obey | `packages/auth/src/rate-limit.test.ts` |
| The schema is idempotent and re-appliable | `packages/auth/src/schema.test.ts` |
| The migration ledger has no duplicate ordering | `.github/workflows/ci.yml` |
| The build gates stay enabled; no bare `console.*`; no tracked `.env` | `.github/workflows/ci.yml` |
| The dependency tree carries no high or critical advisory | `.github/workflows/ci.yml` |

---

## 4. How the auth tests work

They run against a real Postgres — PGlite — with the identity schema applied
as `raptor_migrator`, the three roles created with production attributes, and
the session dropped to the application role afterwards. That means the tests
exercise the same grants, the same RLS and the same triggers a deployment
does.

Two consequences worth knowing:

- **The database trigger can be disabled for a test**, but it must be
  disabled for the UPDATE as well as the INSERT. The trigger is
  `BEFORE INSERT OR UPDATE`, so disabling it only for the sign-up looks right
  and fails on the update with SQLSTATE 23514 — a fixture bug that reads
  exactly like the control under test misbehaving.
- **PGlite and node-postgres do not agree about `int8`.** PGlite returns a
  `bigint` as a number, node-postgres returns it as a string. A defect that
  depends on the driver therefore cannot be reproduced in the test database —
  which is why the column type is asserted in `schema.test.ts` rather than
  left to the behaviour.

---

## 5. Writing a test

```ts
it("refuses a privileged unenrolled sign-in by leaving NO session row behind", async () => {
  await createLoginableUser("hook-only@example.invalid", "admin", false, true);

  const response = await signIn("hook-only@example.invalid");
  expect(response.status).toBeGreaterThanOrEqual(400);

  // THE DISCRIMINATOR. Another gate answers with an error too, but it answers
  // AFTER the session row exists, so a response-only assertion cannot tell the
  // two apart.
  const rows = await fixture.ownerPool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM "auth_session"',
  );
  expect(rows.rows[0]?.n).toBe(0);
});
```

The habits:

- **Name the behaviour, not the function.** "refuses … by leaving NO session
  row behind" says what is true; "calls the hook" says what is called.
- **Assert the discriminator**, not the status code, when two paths can
  produce the same status.
- **State the scope.** If a control covers one thing only, say so in the
  test, or the next reader will assume it covers more.
- **Comment the reason for the assertion**, especially when the obvious
  assertion would pass for the wrong reason.

---

## 6. The gates

`pnpm verify` is what CI runs, and it must be green before a change is
claimed to work. In order:

1. `pnpm lint` — eslint, zero warnings tolerated.
2. `pnpm typecheck` — `tsc --noEmit` across the workspace.
3. `pnpm test` — every suite.

Then, for a change that touches the running stack, the live proof:

```sh
node scripts/create-role-accounts.mjs
node scripts/verify-assistant-roles.mjs
```

---

## 7. When a test fails

1. **Read the failure before theorising.** The error names the assertion.
2. **Decide whether the implementation or the expectation is wrong.** They are
   not equally likely, and the test is not automatically right.
3. **Never weaken an assertion to make a suite pass.** If the old behaviour
   was correct, fix the implementation. If the old behaviour was wrong, change
   the test and say so in the commit message and in the test's own comment.
4. **Reproduce it against the pristine tree** before assuming your change
   caused it. A red suite on `main` is a finding, not an excuse.

---

## 8. Coverage

Coverage is a smoke detector, not a proof. The number is not a target here:
what matters is that every control named in a comment has a test that fails
when the control is removed. The mutation harness in
`load-bearing-settings.test.ts` is the instrument for that, and the isolation
suites in `packages/db` are the instrument for tenancy.

If you add a control, add the test that kills it.
