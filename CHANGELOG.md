# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The repository is pre-1.0: the schema, the identity plane and the public
surfaces may still change shape between releases.

---

## [Unreleased]

### Added
- **Complete documentation set** — a README, an architecture guide, a data
  model, a security model, a development guide, a testing guide, an
  operations guide, a demo runbook, an AI-agent guide and a rulebook in
  `AGENTS.md`, all cross-linked from `docs/README.md`.
- **`pnpm bootstrap`** — one idempotent, non-interactive command that
  prepares a machine: prerequisites, databases and roles, the domain
  migrations, the identity schema, the CMS provisioning, a generated
  `.env.local`, the preview tenant and the seven role accounts.
- **Pull request, issue and conduct templates**, and a dependabot
  configuration.

### Changed
- **The demo build signs in with a password only.** The `twoFactor` plugin is
  not installed, so there is no 6-digit challenge, no enrolment route and no
  challenge cookie. The MFA *policy* is unchanged: a privileged role still
  requires the enrolment flag, the database trigger still refuses a
  privileged row without it, and both session gates still refuse a session
  to an account that lacks it. The flag is now a provisioning state rather
  than a runtime challenge. Re-enabling the challenge is documented in
  `docs/SECURITY.md`.
- **`twoFactorEnabled` is declared on the user model** (`input: false`,
  `defaultValue: false`, `returned: true`) rather than inherited from the
  plugin. The installed adapter builds every returned user object from the
  model's *declared* fields, so a column that exists in the table but is not
  declared is dropped from the session payload — and the after-hook gate
  reads that flag, so an undeclared column would refuse every privileged
  sign-in, enrolled owner included.
- The sign-in form is a single stage; the seed and the role-verification
  script no longer enrol or answer a challenge.

### Fixed
- **`schema.sql` aborted its own transaction** when it was applied before the
  domain schema. `auth_active_orgs_for_token` was a `LANGUAGE sql` function,
  and a SQL-language function resolves the relations in its body when it is
  CREATED — so creating it required three `packages/db` tables to exist
  already. The function is now `plpgsql`, like its sister
  `auth_set_active_org`, and resolves its body at call time. The auth suite
  had been red since the function was added.
- **`X-Retry-After` carried ~5.7 million years.** `auth_rate_limit.lastRequest`
  was a `bigint`; node-postgres returns `int8` as a string, and Better Auth's
  rate limiter adds to the value, so the addition concatenated. The column is
  now `double precision`, which holds epoch milliseconds exactly and comes
  back as a number from every driver. PGlite returns `int8` as a number, so
  the test database could not reproduce it — the column type is now pinned in
  the schema test and the header contract is asserted in the rate-limit test.

### Removed
- The `twoFactor` plugin, its challenge-cookie and account-lockout
  constants, and the TOTP enrolment steps in the local scripts. The
  challenge-path rate limits, the policy, the trigger, the gates and the
  `auth_two_factor` table are all retained, so the challenge can be
  re-enabled without re-deriving them.

---

## [0.1.0] — the rebuild

The first release of the rebuilt system. It replaces the legacy application
documented in `AUDIT/`.

### Added
- **Identity** — a self-hosted Better Auth instance with the role vocabulary,
  the MFA policy, the account-level password lockout, a rotating session
  token, CSRF and origin checks, and the `user_mfa_guard` trigger that makes
  "a privileged role implies an enrolled authenticator" unbypassable.
- **Tenancy** — 91 domain tables across 16 forward-only migrations, forced
  row-level security on every tenant-scoped table, three database roles
  (`raptor_app`, `raptor_migrator`, `cms_app`), and a person-centred identity
  model that survives a change of email address.
- **The domain engine** — 24 pure modules covering money and double-entry
  ledgers, largest-remainder prize allocation, contracts and acceptance
  evidence, attendance, tasks and workflows, HR state transitions, minors'
  consent, FX, authorisation and analytics.
- **The public site**, the **role-aware workspace**, the **offline
  role-scoped assistant**, and a **Payload CMS** mounted in the same process,
  authenticating with the same identity.
- **A local stack that needs nothing but PostgreSQL** — a setup script, a
  preview seed, a portable database snapshot, and a role-verification script
  that proves the scoping end to end.
- **A quality system** — a mutation-verified control suite, per-tenant
  isolation suites, an accessibility gate, and CI greps that fail the build
  on a disabled gate, a bare `console.*` or a tracked secret.

### Notes
- The legacy audit that this release answers is in `AUDIT/`, and the
  reasoning for each architectural decision is in `docs/adr/`.

[Unreleased]: https://github.com/akshuu21/raptor-os/compare/main...main
[0.1.0]: https://github.com/akshuu21/raptor-os/releases/tag/v0.1.0
