# Security

This document states what the system protects, how, and — in one place — where
the demo build deliberately departs from the model. The departure is written
down here because a security control that is quietly switched off is worse
than one that was never built.

---

## 1. Threat model

| Adversary | What they have | What stops them |
| --- | --- | --- |
| Anonymous internet user | the public site | every workspace route is session-gated; the public site reads only published content, through the `public_roster_reads` views |
| A logged-in ordinary player | a valid session | role scoping in the navigation AND in the assistant matrix; RLS on every tenant table; no client-supplied role |
| A logged-in privileged user (manager/admin/owner) | a valid session | the same, plus the fact that a privileged role may not exist without the MFA flag, and every mutation is audited |
| An attacker with a stolen password | the password | the account lockout (5 failures → 15 minutes), the per-IP limiter, and — in a build with the challenge enabled — the second factor |
| An attacker with a stolen session cookie | the cookie | real token rotation: every refresh issues a NEW token and the old one stops resolving (ADR-0007) |
| A compromised application process | the `DATABASE_URL` | the app role holds no ownership of the schema, cannot `BYPASSRLS`, and is refused outright if handed the migrator credential |
| A malicious tenant | one tenant's data | forced RLS on every tenant-scoped table; the tenant GUC is set by the server, never by the client |

The legacy system this repository replaces is documented in
[`../AUDIT/09_AUTHENTICATION.md`](../AUDIT/09_AUTHENTICATION.md) and
[`../AUDIT/15_API_SECURITY.md`](../AUDIT/15_API_SECURITY.md). The defects
named there (F-AUTH-01 through F-AUTH-05) are the reason the controls below
exist in the shape they do.

---

## 2. Identity

### The session lives in an httpOnly cookie

`advanced.defaultCookieAttributes` pins `httpOnly`, `sameSite: "lax"` and
`path: "/"`; `useSecureCookies` pins `Secure` in production. JavaScript in
the origin cannot read the session, so an XSS anywhere in the origin cannot
steal it.

The legacy application stored the session — including the refresh token — in
`localStorage`, which is readable by any script in the origin: one XSS became
persistent account takeover, for administrators included. The regression
guard is `apps/web/src/__tests__/no-client-token-storage.test.ts`, which scans
the whole source tree for `localStorage` / `sessionStorage` and fails the
build if either reappears.

### The session is identity, not tenant-scoped

A session names a person. The active organisation is a different value, and it
is written by exactly one function — `auth_set_active_org`, `SECURITY
DEFINER`, pinned to an empty `search_path`, schema-qualified throughout
(ADR-0006). It refuses unless an ACTIVE `org_membership` row proves the token
holder belongs to that organisation.

This is why the identity tables carry a **role** policy and not a tenant
predicate (ADR-0017): a tenant predicate on a session that is not tenant-scoped
would be a fiction, and the tables are protected by role grants instead.

### The session token rotates

Better Auth's only session write is `updateSession`, and the update hook
issues a NEW token. The old row is replaced, not duplicated: one row, one live
credential, and the previous value resolves to nothing. A stolen cookie dies at
the owner's next refresh, at most 15 minutes away (ADR-0007).

`packages/auth/src/session-rotation.test.ts` asserts the behaviour rather
than the configuration — an assertion on `updateAge` alone passes against the
broken implementation, which is how the defect survived a green suite in the
first place.

---

## 3. Authorisation

Three layers, each of which fails closed on its own.

### Layer 1 — the role is server-side

`role` is declared on the user model with `input: false`. Better Auth's
`parseInputData` refuses a request body carrying that key on update and
ignores it on create, so the role can only be written by the server, and
every grant is audited in `role_assignment`. The same mechanism applies to
`twoFactorEnabled`.

Asserted in `packages/auth/src/mass-assignment.test.ts`, including the nested
case (`additionalFields: { role: "owner" }` is stripped as well).

### Layer 2 — the database refuses

`user_mfa_guard_trigger` is a `BEFORE INSERT OR UPDATE` trigger on
`auth_user`. A `manager`, `admin` or `owner` may not exist unless
`twoFactorEnabled` is true, and MFA may not be switched off while the account
is privileged. It sees the complete resulting row, so one predicate covers
every direction, and it runs atomically with the write — there is no window
in which a non-compliant row exists.

A trigger rather than only an application check, because an application check
can be bypassed by any code path that does not call it. That is precisely how
the legacy system ended up with no MFA anywhere.

### Layer 3 — the row set is filtered

Every tenant-scoped table has `ROW LEVEL SECURITY` forced, with a policy
keyed on `current_org_id()` — a session GUC the server sets with
`SET LOCAL app.org_id = <org>` inside the transaction. The application role
is not the table owner and does not hold `BYPASSRLS`, so it cannot see
another tenant's rows even if the handler asks it to.

A table with RLS enabled and no policy is invisible to the application, not
merely unprotected — the symptom reads exactly like a wrong password, which
is why `packages/db/src/*.isolation.test.ts` exists.

---

## 4. Account-level throttling

Two budgets, deliberately separate:

| Budget | Scope | Where |
| --- | --- | --- |
| Per-IP limiter | 5 sign-in attempts per 60 s per path in production, 30 outside it | Better Auth's rate limiter, counters in Postgres |
| Per-account counter | 5 failed passwords → 15-minute lock | `packages/auth/src/account-lockout.ts`, keyed on a SHA-256 digest of the lower-cased address |
| Per-IP forwarding headers | none by default | `advanced.ipAddress` reads no header unless the edge overwrites one |

The per-IP budget is per ADDRESS, and a developer or a demo has exactly one:
signing in as owner, then admin, then coach to show a colleague is three
sign-ins in a row from 127.0.0.1, and the fourth was refused with a 429 that
read as "sign-in does not work". The budget therefore follows the environment —
**5 per minute in production, 30 outside it** — and `AUTH_RATE_LIMIT_SIGNIN_MAX`
overrides both for a deployment that shares one address across an office. The
per-ACCOUNT lockout, which is the control that actually bounds guessing, does
not move.

The per-IP budget alone is not a credential defence: with a unique
`X-Forwarded-For` per request, 200 of 200 guesses against one named account
were accepted in the legacy system, because a client that chooses its own
address is handed a fresh budget. The per-account counter is what actually
bounds guessing, and no address is ever stored in a row, a log or an error
message.

> A note on `X-Retry-After`: the value is computed from a persisted epoch
> millisecond counter. That column is `double precision` and not `bigint`,
> because node-postgres returns `int8` as a **string** and Better Auth adds to
> the value — with a string on the left of a `+`, JavaScript concatenates and
> the header goes out as ~5.7 million years. PGlite returns `int8` as a
> number, so the test database could not have reproduced it. The column type
> is pinned in `schema.test.ts` and the header contract is asserted in
> `rate-limit.test.ts`.

---

## 5. The MFA policy

The rule, in one line: **a privileged role may not exist without the
enrolment flag, and a session is refused to a privileged account that lacks
it.** It is implemented three times — in `roles.ts` (the pure policy), in the
two gates in `config.ts` (the session-creation gate and the after-hook gate),
and in the database trigger (the authority).

### Demo deviations

**This build does not ask for a 6-digit code.** The `twoFactor` plugin is not
installed, so:

| | With the challenge | In this build |
| --- | --- | --- |
| Enrolment (`/two-factor/enable`) | available | **404** |
| Verification (`/two-factor/verify-totp`) | available | **404** |
| Sign-in for an enrolled account | `twoFactorRedirect`, then a code | a password, and a session |
| `twoFactorEnabled` | proof that the user holds a secret | a **provisioning state**: the server grants it, and the policy reads it |
| A privileged account with no flag | refused a session | **still refused a session** |

What this means, stated plainly: **a privileged account in this build is
protected by its password alone.** A stolen owner password is immediate,
unchallenged access to an owner account. That is acceptable for a demo on a
local stack and it is not acceptable for a deployment holding real data.

What has NOT been switched off: the policy, the trigger, the two gates, the
account lockout, the per-IP limiter, the session rotation, the CSRF and
origin checks, the RLS policies, the audit log, or the role scoping. The
plugin was the *challenge*; it was never the *requirement*.

### Re-enabling the challenge

Everything needed is still here: the flag, the policy, the trigger, the gates,
the rate limits for the challenge paths, the `auth_two_factor` table and its
columns, and the RFC 6238 arithmetic in `scripts/totp.mjs`. It is:

1. install the plugin in `packages/auth/src/config.ts` (the block is
   documented in place, with the options it used to carry);
2. restore the enrolment stage in
   `apps/web/src/app/(site)/sign-in/sign-in-form.tsx`;
3. restore the enrolment steps in `scripts/create-role-accounts.mjs` and
   `scripts/verify-assistant-roles.mjs`.

The `twoFactorEnabled` field must stay declared on the user model. The
installed adapter builds every returned user object from the model's
**declared** fields, so a column that exists in the table but is not declared
in the model is dropped from the session payload — and the after-hook gate,
which reads the flag off that payload, would then read `false` for every
account and refuse every privileged sign-in, enrolled owner included, with
nothing in the logs to say why.

---

## 6. Secrets

| Secret | Grants | Rule |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | mints a session for ANY account, including an unverified one | ≥32 characters, ≥12 distinct, not a placeholder; `env.ts` refuses the known placeholders by name |
| `PAYLOAD_SECRET` | the CMS signing key | per environment, generated |
| `DATABASE_MIGRATION_URL` | owns the schema | must never appear in an application environment; `env.ts` refuses it in `DATABASE_URL` |
| `DATABASE_URL` | the app role only | no ownership, no `BYPASSRLS` |
| `RESEND_API_KEY` | sends mail | links are bearer credentials; they are never logged |

`.env` files are gitignored, CI fails on a tracked one, and no secret appears
in a document, a fixture or a test. The local passwords
(`raptor_local_dev_only`) unlock a database bound to loopback and nothing
else.

---

## 7. Audit and observability

- `audit_log` records every mutation with the actor, the action, the entity
  and the evidence.
- `outbox_event` carries domain events for consumers that must not be in the
  request path.
- `@raptor/observability` provides the structured logger, a correlation id
  that follows a request across layers, and liveness/readiness probes
  (`/api/health`, `/api/ready`).
- Bare `console.*` in application code is a CI failure: every line must be
  structured, parseable, and free of request bodies.

---

## 8. What is checked, and where

| Control | Asserted by |
| --- | --- |
| The role cannot be client-supplied | `packages/auth/src/mass-assignment.test.ts` |
| A privileged role needs the flag (database) | `packages/auth/src/mfa-enforcement.test.ts` |
| A privileged unenrolled sign-in is refused (both gates) | `packages/auth/src/load-bearing-settings.test.ts` |
| The session does not leak into `localStorage` | `apps/web/src/__tests__/no-client-token-storage.test.ts` |
| The session token really rotates | `packages/auth/src/session-rotation.test.ts` |
| A password change evicts the other sessions | `packages/auth/src/session-revocation.test.ts` |
| Identity tables carry no tenant predicate | `packages/auth/src/session-isolation.test.ts` |
| Tenant tables are isolated | `packages/db/src/*.isolation.test.ts` |
| The build gates are on; no bare `console.*`; no tracked `.env` | `.github/workflows/ci.yml` |
| The dependency tree has no high or critical advisory | `.github/workflows/ci.yml` |

---

## 9. Reporting a vulnerability

Open a security advisory on the repository, or email the maintainer. Please
do not open a public issue for a vulnerability. See
[`../SECURITY.md`](../SECURITY.md) for the disclosure policy.
