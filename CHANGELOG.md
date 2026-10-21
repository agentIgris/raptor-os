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
  `.env.local`, the preview data, the preview CONTENT and the seven role
  accounts.
- **`scripts/preview-seed-cms.sql`** — the preview content as a committed,
  idempotent seed: three news stories, five partners, the recruitment panel,
  the site settings, the social links and the two CMS operator accounts. It
  used to exist only inside the database snapshot, which meant a clone that
  ran the documented setup had the domain preview data and **no news, no
  partners and no site settings at all** — the content was in a binary blob,
  unreviewable, unreproducible and invisible to every test.
- **`apps/web/src/__tests__/preview-content.test.ts`** — the check that the
  seeded roster and the committed art agree, and that the preview content is
  a seed rather than a snapshot. Verified by mutation: renaming the handles
  back to the old set fails two of the five cases.
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
- **The workspace was degraded on every page.** The session never got an
  organisation bound, so teams, competitions, members, analytics and the
  organisation profile all rendered "unavailable" — and nothing was logged,
  because the callers swallow the failure by design.
  `auth_active_orgs_for_token` is a `plpgsql` function whose signature declares
  `display_name text, slug text` while its body returns `varchar(200)` and
  `varchar(64)`. A `LANGUAGE sql` function coerces its result to the declared
  types; a `plpgsql` one does not, and `RETURN QUERY` raises *structure of
  query does not match function result type* at CALL time. The casts are now
  explicit, and `packages/auth/src/org-binding.test.ts` CALLS both functions —
  they had only ever been asserted about.
- **The Analytics page was degraded** — the same defect in a different schema.
  `analytics_top_teams` returned `team.name` (`varchar(160)`) where it declares
  `team_name text`. Fixed by a new forward-only migration,
  `packages/db/migrations/0017_analytics_return_types.sql`, and covered by
  `packages/db/src/analytics.isolation.test.ts`, which calls the two analytics
  functions for the first time.
- **Signing in as several roles was refused with a 429.** The per-address
  sign-in budget was 5 per minute, and a developer or a demo has ONE address:
  owner, then admin, then coach to show a colleague is three sign-ins in a row.
  The budget now follows the environment — **5 per minute in production, 30
  outside it** — and `AUTH_RATE_LIMIT_SIGNIN_MAX` overrides both. The
  per-ACCOUNT lockout, which is the control that actually bounds guessing, does
  not move.
- **The CMS admin rendered its collections as large empty icons.** The admin's
  component import map was hand-written and EMPTY, so the key that draws a
  collection card — `@payloadcms/next/rsc#CollectionCards` — was unresolved.
  It is generated now (`payload generate:importmap`, committed), and the
  Payload config points the generator at the file the app reads.
- **The CMS could not resize images.** The Payload config imports `sharp`, but
  the process that EVALUATES that config is the web app, and `apps/web` did not
  depend on sharp — so the bundler could not resolve it, the dynamic import
  threw, and the catch swallowed it. `apps/web` now depends on the same pinned
  version as `packages/cms`.
- **The roster showed a generic portrait for every player, and the featured
  team had no players in it.** Portraits are resolved by handle, and the
  committed art is named for the `REx*` handles; the seed now carries them.
  Every team renders its players' portraits, not only the featured one, and
  the featured card is the first team that HAS players.
- **The roster had the wrong captain and the wrong squad.** RExSANKU captains
  Raptor BGMI Main, and RExZEROIGL is in the squad — with the division — rather
  than in the Academy, which has no division and no published lineup.
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
- **The CI build-gate check fired on correct code.** It grepped for the
  property NAMES, so it matched a config that deliberately sets
  `ignoreBuildErrors: false`. It now checks that no gate is set to `true`,
  which is the question the step is named for.
- **The roster showed a generic portrait for every player.** Portraits are
  resolved by handle — `person_profile.display_name` →
  `/placeholders/player-<handle>.png` — and the committed art is named for
  five `REx*` handles while the seed carried five other names, so the art was
  unreachable and every player on the site wore the fallback. The seed now
  carries the handles the art is for. The portraits are illustrated brand art
  in the Raptor palette, not photographs, so this is a naming decision and
  not an attribution one.

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
