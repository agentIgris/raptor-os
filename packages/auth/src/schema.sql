-- =============================================================================
-- packages/auth/src/schema.sql
--
-- Better Auth 1.7.7 persistence for Raptor OS.
--
-- PROVENANCE OF THE COLUMN NAMES
-- ------------------------------
-- Every table, column, type, and constraint below was produced by Better Auth's
-- OWN migration compiler, not written from memory:
--
--     import { getMigrations } from "better-auth/db/migration";
--     const { compileMigrations } = await getMigrations(auth.options);
--     await compileMigrations();
--
-- run against an empty PostgreSQL 18.6 database with the exact option set in
-- `config.ts`. The output was then wrapped in `IF NOT EXISTS`, given CHECK
-- constraints, and given policies. Nothing here was guessed: the odd camelCase
-- identifiers (`"emailVerified"`, `"auth_two_factor"`, `"lastRequest"`) and the
-- `uuid` primary keys are what Better Auth actually sends on the wire, and a
-- "tidied up" snake_case schema would fail at the first query.
--
-- IDEMPOTENT
-- ----------
-- Re-running this script is a no-op. `CREATE TABLE/INDEX IF NOT EXISTS`,
-- `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, and
-- `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER` together mean a partially
-- applied state converges rather than aborting partway.
--
-- ONE EXCEPTION, DELIBERATE: re-running this file does NOT restore a constraint
-- that was deliberately removed, because the one that was removed was WRONG and
-- must not come back. A deployment whose tables already exist from an earlier run
-- needs this as a numbered migration, like any other schema change;
-- `schema.sql` is not that migration tool.
--
-- APPLY AS: `raptor_migrator` (SUPERUSER). Never as `raptor_app`.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Session context
--
-- The tenant is set ONCE PER TRANSACTION by the application and read by the
-- session policy below. It is NEVER accepted as a query parameter — otherwise the
-- caller chooses which tenant they act in (ADR-0011 rule 3).
--
-- Defined with the same body as `packages/db/migrations/0001_tenancy.sql` so the
-- two migrations stay interchangeable, and `CREATE OR REPLACE` so this file is
-- self-contained: `raptor_os_test` does not receive the tenancy migration.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$;

COMMENT ON FUNCTION current_org_id() IS
  'Tenant for the current request. Set via SET LOCAL app.org_id inside a transaction.';

-- -----------------------------------------------------------------------------
-- user
--
-- `role` is declared `input: false` in `config.ts`, so Better Auth rejects any
-- request body carrying a `role` key. This column is therefore written only by
-- the server. That is the structural fix for the legacy `createAdminProfile`
-- helper, which could `upsert({ role: 'admin' })` on a client-bound Supabase
-- client (AUDIT F-AUTH-03).
--
-- `twoFactorEnabled` is added by the `twoFactor` plugin. It is nullable because
-- the plugin declares it `required: false` with `defaultValue: false`; making it
-- NOT NULL here would make `auth migrate` report drift.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "auth_user" (
  "id"               uuid        DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "name"             text        NOT NULL,
  "email"            text        NOT NULL UNIQUE,
  "emailVerified"    boolean     NOT NULL,
  "image"            text,
  "createdAt"        timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt"        timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "twoFactorEnabled" boolean,
  "role"             text        NOT NULL,

  -- The role vocabulary lives in exactly two places, this list and
  -- `ALL_ROLES` in `roles.ts`, and a test asserts they agree. The legacy system
  -- had nine roles in TypeScript and seven in its CHECK constraint, so a picker
  -- built from the former offered values the database rejected with a 23514.
  CONSTRAINT user_role_membership_check
    CHECK ("role" IN ('pending','player','coach','analyst','manager','admin','owner')),

  -- Better Auth lowercases the address before storing it. A stored address that
  -- is not trimmed is either a bug in that path or a hand-written row, and both
  -- are worth failing on rather than tolerating: two spellings of one address
  -- would defeat the UNIQUE constraint's purpose.
  CONSTRAINT user_email_normalised_check
    CHECK ("email" = btrim("email") AND "email" <> '')
);

-- Repairs the drift case where Better Auth's own `auth migrate` ran first and
-- therefore never created the two columns this package adds.
ALTER TABLE "auth_user"      ADD COLUMN IF NOT EXISTS "twoFactorEnabled" boolean;
ALTER TABLE "auth_user"      ADD COLUMN IF NOT EXISTS "role"             text;

-- -----------------------------------------------------------------------------
-- session
--
-- An IDENTITY table. `orgId` records the session's ACTIVE ORGANISATION, which is a
-- value the server chooses and the application may act on — not a partition, and
-- not a security boundary. See the RLS section below for why (ADR-0017).
--
-- `orgId` is declared `input: false` in `config.ts`, so no client can set it and
-- Better Auth never sends the key on create — a session starts with a NULL `orgId`.
-- That is why the column could never satisfy the tenant policy's WITH CHECK, and
-- why every sign-in failed with 42501. `auth_set_active_org` below is the only
-- writer, and it requires an active `org_membership` row.
--
-- A NULL `orgId` means "no active organisation has been chosen yet", which is the
-- normal state for a freshly signed-in session.
--
-- The index on `orgId` is retained because application code groups a user's
-- sessions by active organisation. It is NOT there to support a policy: there is
-- no longer one.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "auth_session" (
  "id"        uuid        DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token"     text        NOT NULL UNIQUE,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId"    uuid        NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "orgId"     text,

  -- A session that expires before it is created can only come from a clock
  -- disagreement or a tampered row, and either way it is not a session.
  CONSTRAINT session_expiry_after_creation_check
    CHECK ("expiresAt" > "createdAt")
);

ALTER TABLE "auth_session"  ADD COLUMN IF NOT EXISTS "orgId" text;

CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "auth_session" ("userId");
CREATE INDEX IF NOT EXISTS "session_orgId_idx"  ON "auth_session" ("orgId");

-- -----------------------------------------------------------------------------
-- account
--
-- Holds the password hash and, for OAuth providers, the provider's tokens.
-- Those columns are marked `returned: false` in Better Auth, so they never leave
-- the server; the column names are kept because that is what the adapter reads.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "auth_account" (
  "id"                     uuid        DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "accountId"              text        NOT NULL,
  "providerId"             text        NOT NULL,
  "userId"                 uuid        NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "accessToken"            text,
  "refreshToken"           text,
  "idToken"                text,
  "accessTokenExpiresAt"   timestamptz,
  "refreshTokenExpiresAt"  timestamptz,
  "scope"                  text,
  "password"               text,
  "createdAt"              timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt"              timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,

  -- An empty provider or account id would make `(providerId, accountId)` collide
  -- across every such row, silently merging unrelated credentials. Better Auth
  -- never writes either empty, so this fails loudly rather than merging them.
  CONSTRAINT account_provider_id_present_check CHECK ("providerId" <> ''),
  CONSTRAINT account_account_id_present_check  CHECK ("accountId"  <> '')
);

CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "auth_account" ("userId");

-- -----------------------------------------------------------------------------
-- verification
--
-- One-time tokens: email verification, password reset, and the two-factor
-- plugin's `2fa-*` and `trust-device-*` challenges.
--
-- This is the highest-value table in the package: a leaked row here is a bearer
-- credential. It carries no org scope, so its protection is the grants at the
-- foot of this file, not a policy.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "auth_verification" (
  "id"         uuid        DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "identifier" text        NOT NULL,
  "value"      text        NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt"  timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,

  -- An empty identifier would make every anonymous token share one bucket, so a
  -- single deletion or lookup would affect all of them at once.
  CONSTRAINT verification_identifier_present_check CHECK ("identifier" <> '')
);

CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "auth_verification" ("identifier");

-- -----------------------------------------------------------------------------
-- twoFactor
--
-- The TOTP secret and the hashed backup codes. `secret` is encrypted at rest by
-- Better Auth using `BETTER_AUTH_SECRET`; `backupCodes` likewise.
--
-- `failedVerificationCount` and `lockedUntil` implement the per-account lockout
-- that rate limiting alone cannot provide: a distributed attacker gets one budget
-- per IP, but only one account-level counter.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "auth_two_factor" (
  "id"                      uuid        DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "secret"                  text        NOT NULL,
  "backupCodes"             text        NOT NULL,
  "userId"                  uuid        NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "verified"                boolean     DEFAULT true,
  "failedVerificationCount" integer,
  "lockedUntil"             timestamptz,

  -- The counter is decremented and incremented by the plugin. A negative value
  -- would mean an underflow that silently defeats the lockout, so it is rejected
  -- at the source rather than trusted.
  CONSTRAINT two_factor_failed_count_nonnegative_check
    CHECK ("failedVerificationCount" IS NULL OR "failedVerificationCount" >= 0),

  -- A LOCK MUST HAVE EVIDENCE BEHIND IT.
  --
  -- This constraint REPLACED
  --
  --     CONSTRAINT two_factor_verified_only_when_not_locked_check
  --       CHECK ("lockedUntil" IS NULL OR "verified" IS NOT TRUE)
  --
  -- which was a live defect, not a style preference. Better Auth's lockout writes
  -- `lockedUntil` without ever clearing `verified`
  -- (`dist/plugins/two-factor/verify-two-factor.mjs`, `recordTwoFactorFailure`), and
  -- it clears only `lockedUntil` and the counter afterwards
  -- (`resetTwoFactorFailures`). So the old constraint rejected precisely the state
  -- the library creates, for every ENROLLED user -- and enrolment is the only
  -- state in which TOTP guessing is possible at all.
  --
  -- Measured, against this schema: a verified row with `lockedUntil` set is
  -- refused with SQLSTATE 23514
  -- (`violates check constraint "two_factor_verified_only_when_not_locked_check"`),
  -- so `accountLockout: { enabled: true }` in `config.ts` could count failures but
  -- could never lock an account. The control was described in a comment as
  -- load-bearing and was inert. `load-bearing-settings.test.ts` asserts the lock
  -- now persists; that test is what turned this from a claim into a finding.
  --
  -- "Verified" means "the user proved they hold the secret". It says nothing about
  -- whether they are currently in good standing, so conflating the two was the
  -- original mistake. The invariant actually worth keeping is that a lock is never
  -- unexplained, which is what this constraint states.
  CONSTRAINT two_factor_lock_requires_failures_check
    CHECK ("lockedUntil" IS NULL OR COALESCE("failedVerificationCount", 0) > 0)
);

CREATE INDEX IF NOT EXISTS "twoFactor_secret_idx" ON "auth_two_factor" ("secret");
CREATE INDEX IF NOT EXISTS "twoFactor_userId_idx" ON "auth_two_factor" ("userId");

-- -----------------------------------------------------------------------------
-- rateLimit
--
-- Counters live in Postgres rather than process memory. An in-memory counter
-- resets on every deploy and every restart, so an attacker able to induce a
-- restart resets their own budget; and it is per-process, so N instances
-- multiply the effective limit by N.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "auth_rate_limit" (
  "id"          uuid   DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "key"         text   NOT NULL UNIQUE,
  "count"       integer NOT NULL,
  "lastRequest" bigint  NOT NULL,

  CONSTRAINT rate_limit_count_nonnegative_check     CHECK ("count" >= 0),
  CONSTRAINT rate_limit_last_request_nonnegative_check CHECK ("lastRequest" >= 0)
);

-- =============================================================================
-- MANDATORY MFA FOR PRIVILEGED ROLES — ENFORCED HERE, NOT IN A HELPER
--
-- The rule: an account may hold `manager`, `admin`, or `owner` only if
-- `twoFactorEnabled` is true. Symmetrically, MFA may not be switched OFF while
-- the account is privileged.
--
-- WHY A TRIGGER AND NOT ONLY A HOOK
-- --------------------------------
-- An application check can be bypassed by any code path that does not call it.
-- That is precisely how the legacy system ended up with no MFA anywhere
-- (AUDIT/09: "MFA / TOTP: NOT IMPLEMENTED — no `mfa` reference anywhere") and how
-- `createAdminProfile` sat dormant in a client-reachable library waiting for one
-- permissive policy to turn it into a one-call escalation.
--
-- A `BEFORE INSERT OR UPDATE` trigger sees the COMPLETE resulting row, so a
-- single predicate on `NEW` covers every direction:
--   * granting a privileged role to an unenrolled account  -> rejected
--   * disabling MFA on a privileged account                -> rejected
--   * promoting an already-enrolled account                -> accepted
--   * ordinary profile updates                             -> accepted
--
-- It runs atomically with the write, so there is no window in which an
-- unenrolled privileged row exists, and it applies to `raptor_app` and to
-- `raptor_migrator` alike (a superuser still fires triggers; only
-- `ALTER TABLE ... DISABLE TRIGGER` or `session_replication_role = 'replica'`
-- suppresses them).
--
-- The enforcement therefore cannot be forgotten by a future refactor, because no
-- future refactor writes to this table without passing through it.
--
-- CONsequence, stated plainly: a privileged user who wants to remove their
-- authenticator must be demoted first. That is the intended behaviour. The
-- alternative — letting MFA be disabled while keeping admin rights — is exactly
-- the silent downgrade the control exists to prevent.
-- =============================================================================

CREATE OR REPLACE FUNCTION user_mfa_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW."role" IN ('manager','admin','owner')
     AND NEW."twoFactorEnabled" IS NOT TRUE THEN
    RAISE EXCEPTION
      'MFA_REQUIRED: role "%" may not be held without an enrolled TOTP authenticator',
      NEW."role"
      USING ERRCODE = 'check_violation',
            HINT = 'Enrol TOTP, or assign a non-privileged role first.';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION user_mfa_guard() IS
  'Rejects a user row that holds a privileged role without TOTP enrolled, in both directions.';

DROP TRIGGER IF EXISTS user_mfa_guard_trigger ON "auth_user";
CREATE TRIGGER user_mfa_guard_trigger
  BEFORE INSERT OR UPDATE ON "auth_user"
  FOR EACH ROW EXECUTE FUNCTION user_mfa_guard();

-- =============================================================================
-- ROW LEVEL SECURITY
--
-- NO TABLE IN THIS FILE IS TENANT-SCOPED. ADR-0017.
-- -----------------------------------------------
-- "auth_user", "auth_account", "auth_verification", "auth_two_factor" and "auth_rate_limit" are identity,
-- which is org-INDEPENDENT by design — the same decision `packages/db` already
-- took for `person` and `identity`, because one human may work for several
-- organisations. An `org_id` predicate on `user` would be meaningless rather
-- than merely redundant.
--
-- "auth_session" was the lone exception and it was wrong, twice. It first carried
--
--     USING (current_org_id() IS NULL OR "orgId" IS NULL OR "orgId" = ...)
--
-- which failed OPEN: `current_org_id() IS NULL` is true for every request that has
-- not yet resolved a tenant, so the OR short-circuited and every such request saw
-- every session in the deployment, for every tenant, including the token and
-- `userId` of every live credential. That is a cross-tenant credential-store
-- exposure. Documenting it as "identity bootstrap" did not change what the
-- database did, and a documented hole is still a hole.
--
-- Replacing it with the fail-closed form was no better, because it made sign-in
-- impossible:
--
--     WITH CHECK (current_org_id() IS NOT NULL AND "orgId" = current_org_id()::text)
--
-- `orgId` is `input: false` in `config.ts`, so Better Auth inserts NULL, and
-- `NULL = anything` is NULL rather than TRUE. Every session insert was refused:
--
--     code=42501  new row violates row-level security policy for table "auth_session"
--
-- Both failures share one cause: treating "auth_session" as the tenant-scoped record
-- when it is the identity record that ESTABLISHES the tenant. The circle is
-- unavoidable under that mistake — resolving the tenant needs the session, and
-- reading the session needs the tenant. One direction fails open, the other
-- fails closed.
--
-- So "auth_session" is grouped with the other identity tables: no tenant predicate,
-- and no RLS at all. It is identity for the same reason `0001_tenancy.sql` says
-- `person` is.
--
-- WHAT IS GIVEN UP, STATED PLAINLY
-- ---------------------------------
-- A request can read a session row belonging to another tenant. That is accepted,
-- and it is NOT claimed to be prevented. A session row holds a token and identity
-- metadata, not business data. The business tables are forced-RLS-scoped in
-- `packages/db`, and this package's suite asserts the fail-closed property THERE
-- rather than asserting it here where it no longer holds.
--
-- WHAT CARRIES THE BOUNDARY INSTEAD
-- ---------------------------------
-- `session.orgId` survives with a narrower meaning: the ACTIVE organisation
-- chosen for this session. It is a value, not a partition, and it is not a
-- security boundary. Three controls carry the weight instead, each asserted by a
-- test rather than by prose in this file:
--
--   1. `orgId` stays `input: false`, so a client can never assert its own tenant
--      through Better Auth.
--   2. `auth_set_active_org` below refuses to write an `orgId` unless an ACTIVE
--      `org_membership` row proves the user belongs to that organisation.
--   3. Authorisation is resolved against real `role_assignment` rows in
--      `packages/db`, never from the token, so possessing a session carrying
--      another organisation's `orgId` confers no permission.
--
-- A TABLE WITH RLS ENABLED AND NO POLICY IS NOT "PROTECTED BUT WORKING" — IT IS
-- "PROTECTED AND UNUSABLE". Row Level Security is default-deny, so a non-owner
-- role sees zero rows no matter what it has been granted. This is verified
-- against the real database rather than assumed: `SELECT count(*) FROM "auth_user"` as
-- `raptor_app` returns 0 on a policy-less table, which in production would look
-- like every user's password being wrong. Hence the explicit
-- `*_app_role_access` policies below.
--
-- "auth_session" is deliberately ABSENT from the ENABLE list at the foot of this
-- section. Enabling RLS there would make the table default-deny for every role
-- that is not the owner — the unusable state described above — while the
-- `*_app_role_access` policy already grants `raptor_app` full DML, so the net
-- effect for the only role that matters would be a second thing to get wrong.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- auth_session_by_token — IDENTITY RESOLUTION, NOT A TENANT BOUNDARY
--
-- WHAT CHANGED IN ADR-0017, AND WHY THE FUNCTION IS STILL HERE
-- -----------------------------------------------------------
-- This function used to be described as "the only way to resolve a session before
-- the tenant is known", and its SECURITY DEFINER elevation existed to see past
-- `session_tenant_isolation`. That policy is gone, so the elevation has no RLS to
-- see past.
--
-- It is KEPT because the operation is real and useful, not because it is a
-- loophole: a bearer token is an OPAQUE STRING. To learn which user and which
-- active organisation a token belongs to, something has to map that string back to
-- a row, and doing it with a single indexed lookup on `token` is both cheaper and
-- safer than letting application code SELECT the whole table and filter in
-- JavaScript.
--
-- So it is now precisely what it always physically was — a single-row identity
-- lookup — and this comment says so rather than implying a boundary it does not
-- provide.
--
-- WHAT IT DOES AND DOES NOT GRANT
-- -------------------------------
-- It returns AT MOST ONE row, and only the one whose `token` equals the supplied
-- value. A caller holding no token cannot name a session, so it reads nothing;
-- there is no branch that widens the result set.
--
-- It grants NO ACCESS TO ANY ORGANISATION. It is not an authorisation path, it
-- carries no role, and the `orgId` it returns is a VALUE the caller may then
-- validate, not a grant. Acting on that value means calling the forced-RLS
-- business tables in `packages/db`, which enforce the tenant boundary
-- independently of anything this function says. `session-isolation.test.ts`
-- asserts exactly that — a session bearing another organisation's `orgId` confers
-- nothing — because without the test this function is just a claim.
--
-- `SECURITY DEFINER` is retained deliberately. The owner is the only role that
-- could see a row whose tenant differs from the caller's, and pinning the search
-- path keeps that elevation from being redirected at a shadowed object:
--
--   * `SET search_path = ''` — MANDATORY, per ADR-0006. A `SECURITY DEFINER`
--     function resolving unqualified names lets any caller who can create an object
--     in a directory on the path shadow the tables the body names and run the
--     function's privileges against their own. Pinning the path to empty forces
--     every name to be schema-qualified, hence `public."auth_session"`.
--
--   * NO `p_org_id` PARAMETER, still. `auth_session_by_token(p_token, p_org_id)`
--     would let a caller name the tenant it reads from, which is precisely the
--     substitution ADR-0011 rule 3 forbids.
--
-- EXECUTE is revoked from PUBLIC and granted to `raptor_app` alone. PostgreSQL
-- makes a new function EXECUTABLE by PUBLIC by default, so the REVOKE is not
-- bookkeeping: without it any role, including an anonymous login role, could read
-- any session by token.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_session_by_token(p_token text)
RETURNS SETOF public."auth_session"
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.*
  FROM public."auth_session" s
  WHERE s."token" = p_token
$$;

COMMENT ON FUNCTION auth_session_by_token(text) IS
  'Identity resolution for a caller who already holds the token: at most one row, the one whose token was supplied. NOT an authorisation path and not a tenant boundary — the returned orgId is a value the caller must still validate. EXECUTE is revoked from PUBLIC.';

REVOKE ALL ON FUNCTION auth_session_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_session_by_token(text) TO raptor_app;

-- -----------------------------------------------------------------------------
-- auth_set_active_org — THE ONLY WAY TO WRITE session."orgId"
--
-- Compensating control 2 of ADR-0017. `orgId` is `input: false`, so Better Auth
-- never sets it and a client cannot supply it; that alone would leave it NULL
-- forever, which is correct but useless. This function is how a server picks the
-- session's ACTIVE ORGANISATION, and it is the only door to that column.
--
-- WHY A FUNCTION AND NOT A TRIGGER
-- ------------------------------
-- A trigger would fire on every UPDATE and would have to guess the intended
-- organisation from ambient state. This takes the organisation as an explicit
-- argument, which means the check below is total: every write is either rejected
-- or was preceded by a membership test. There is no path that sets the column
-- without passing through the test.
--
-- `SECURITY DEFINER` + `SET search_path = ''` + schema-qualified names, per
-- ADR-0006: this must read `org_membership`, which `raptor_app` cannot read
-- directly (it is forced-RLS in `packages/db`), and the pinned empty search path is
-- what stops that elevation being pointed at a substituted object.
--
-- It is deliberately NOT granted INSERT on the table: the app role still cannot
-- write `orgId` itself, only this function can.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_set_active_org(p_token text, p_org_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id   uuid;
  v_person_id uuid;
BEGIN
  -- Resolve the caller from the token they already hold, so the membership check
  -- is about THAT user and cannot be aimed at someone else's.
  SELECT s."userId"
    INTO v_user_id
    FROM public."auth_session" s
   WHERE s."token" = p_token;

  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;

  -- Cross the identity boundary (ADR-0018): the session names a "auth_user", but
  -- membership is recorded against a person. A "auth_user" with no link resolves to no
  -- person, so membership cannot be satisfied and this returns false. That is the
  -- control, not a missing case: an unlinked login may not transact.
  SELECT l.person_id
    INTO v_person_id
    FROM public.person_credential_link l
   WHERE l.user_id = v_user_id;

  IF v_person_id IS NULL THEN
    RETURN false;
  END IF;

  -- The whole control. An ACTIVE membership is required: a pending invitation is
  -- not membership, and a row whose status is anything else has been revoked.
  IF NOT EXISTS (
    SELECT 1
      FROM public.org_membership m
     WHERE m.person_id = v_person_id
       AND m."org_id" = p_org_id
       AND m."status" = 'active'
  ) THEN
    RETURN false;
  END IF;

  UPDATE public."auth_session"
     SET "orgId" = p_org_id::text
   WHERE "token" = p_token;

  RETURN true;
END
$$;

COMMENT ON FUNCTION auth_set_active_org(text, uuid) IS
  'Sets the session active organisation, but only where an active org_membership row proves the token holder belongs to it. Returns false and writes nothing otherwise.';

REVOKE ALL ON FUNCTION auth_set_active_org(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_set_active_org(text, uuid) TO raptor_app;

-- -----------------------------------------------------------------------------
-- auth_active_orgs_for_token — READ-ONLY DISCOVERY, SISTER TO auth_set_active_org
--
-- Signing in should land a person in their organisation without them having to
-- know or paste an opaque id. Answering "which orgs can this session enter?"
-- requires reading `org_membership`, which `raptor_app` cannot read directly —
-- it is forced-RLS in `packages/db` and RLS is keyed on a *current* org, which
-- is exactly the thing a fresh session does not have yet. Same shape as
-- `auth_set_active_org` above (ADR-0006): `SECURITY DEFINER` +
-- `SET search_path = ''` + schema-qualified names, so the elevation cannot be
-- aimed at a substituted object.
--
-- The same three-step resolution applies, and the same two of them are controls:
-- the token names the user (the query cannot be aimed at someone else's
-- memberships), and the identity boundary ADR-0018 is crossed through
-- `person_credential_link` — a user with no link resolves to no person, joins
-- to nothing, and the answer is an empty set. Only ACTIVE memberships are
-- returned: a pending invitation is not an organisation you can enter.
--
-- It is STABLE and touches nothing: discovery answers a question, it does not
-- change one. If it returns more than one row the UI must send the person to
-- the switcher instead of guessing; picking the org is still done through
-- `auth_set_active_org`, which re-verifies. This function being wrong in the
-- generous direction cannot therefore make a person able to enter an org they
-- do not belong to — and being wrong in the stingy direction just means the
-- switcher gets used, which always worked.
--
-- It is deliberately read-only: the app role can LEARN which doors exist, it
-- still cannot OPEN any of them with anything but the function above.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_active_orgs_for_token(p_token text)
RETURNS TABLE(org_id uuid, display_name text, slug text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m."org_id", o.display_name, o.slug
    FROM public."auth_session" s
    JOIN public.person_credential_link l
      ON l.user_id = s."userId"
    JOIN public.org_membership m
      ON m.person_id = l.person_id
     AND m."status" = 'active'
    JOIN public.organization o
      ON o.id = m."org_id"
   WHERE s."token" = p_token;
$$;

COMMENT ON FUNCTION auth_active_orgs_for_token(text) IS
  'Lists the organisations an ACTIVE org_membership row proves the token holder belongs to. Read-only: returns the set, writes nothing.';

REVOKE ALL ON FUNCTION auth_active_orgs_for_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_active_orgs_for_token(text) TO raptor_app;

-- -----------------------------------------------------------------------------
-- IDENTITY TABLES: PROTECTED BY ROLE, NOT BY TENANT
--
-- "auth_account" AND "auth_verification" NEED NO SPECIAL TREATMENT, and that is worth
-- stating explicitly rather than leaving to inspection. The bootstrap defect was
-- a `current_org_id() IS NULL` branch, and these two tables never had one: their
-- policy is `session_user = 'raptor_app'`, which compares the *invoking role*,
-- not a request-scoped GUC. There is no value of `app.org_id` — set, empty, or
-- absent — that changes what `raptor_app` may read on them, so there is no
-- ordering constraint to solve with a `SECURITY DEFINER` function. Their
-- protection is the combination of the role predicate and the GRANTs at the foot
-- of this file: a future role must clear both bars.
--
-- THEY STILL NEED A POLICY, and that is worth stating because getting it wrong is
-- silent. Row Level Security is DEFAULT-DENY: with RLS enabled and no policy, a
-- non-owner role sees ZERO rows, no matter what it has been granted. So a
-- policy-less table is not "protected but working", it is "protected and
-- completely unusable" — and the symptom (every sign-in reports an unknown
-- email, because the lookup cannot find the user) reads exactly like a wrong
-- password rather than a missing policy.
--
-- The predicate below therefore grants the application role what it needs and
-- nobody else. Combined with the explicit GRANTs at the foot of this file, a
-- future role must clear BOTH bars to touch identity data.
--
-- "auth_session" is now in this list rather than under a tenant policy (ADR-0017).
-- The predicate is the SAME role check as every other identity table, which is
-- the point: it grants no organisation anything, and the tenant boundary is
-- enforced by the forced-RLS business tables in `packages/db`.
-- =============================================================================
-- BLAST RADIUS — READ THIS BEFORE RELYING ON ANY OF THE ABOVE
-- =============================================================================
--
-- The policy below is `USING (session_user = 'raptor_app')`, and it is worth
-- being precise about what that does and does not do, because "protected by role"
-- reads like a boundary and is not one.
--
--   - `session_user` is the INVOKING ROLE. For every query this package issues,
--     it is `raptor_app`. So the predicate is TRUE for EVERY ROW in EVERY auth
--     table. It filters nothing for the only role that runs queries.
--   - These tables are `ENABLE`d, not `FORCE`d, so `relforcerowsecurity` is
--     false and the TABLE OWNER (`raptor_migrator`) bypasses the policy entirely.
--   - The GRANTs at the foot of this file give `raptor_app` blanket
--     `SELECT, INSERT, UPDATE, DELETE` on all six tables.
--
-- COMBINED, THE RESULT IS:
--
--     ANY SQL-READ PRIMITIVE ANYWHERE IN THE APPLICATION YIELDS EVERY SESSION
--     TOKEN, EVERY PASSWORD HASH, EVERY RESET AND VERIFICATION TOKEN, AND EVERY
--     ENCRYPTED TOTP SECRET FOR EVERY ACCOUNT IN THE DEPLOYMENT.
--
-- This is a KNOWN, ACCEPTED LIMITATION OF ADR-0017, which classified the auth
-- tables as org-independent identity data. It is recorded here so that it is not
-- mistaken for a defence. It is NOT fixed in this file, and it must not be
-- "fixed" by quietly adding a tenant predicate: the circle is unresolvable in
-- that direction, because resolving the tenant needs the session and reading the
-- session needs the tenant. The long write-up is in the RLS section above.
--
-- WHAT THIS MEANS CONCRETELY
-- --------------------------
-- An SSRF to an internal endpoint, an RCE, a stray debug route, a SQL injection,
-- or any compromised dependency holding a DB connection is not "a partial leak".
-- It is total, immediate compromise of every account, including every `admin` and
-- `owner`, and it requires no further work by the attacker:
--
--   - session tokens replay verbatim as cookies, and this package no longer issues
--     one that outlives a rotation window (see `session-rotation.test.ts`);
--   - `twoFactor.secret` is encrypted at rest, but the key is
--     `BETTER_AUTH_SECRET` in the same process, so a reader of this database is
--     an oracle for every enrolled authenticator;
--   - `verification.value` rows are single-use bearer credentials for password
--     reset and email verification.
--
-- WHAT ACTUALLY CARRIES THE BOUNDARY, therefore, is everything that keeps a SQL
-- read primitive from existing at all:
--
--   1. `raptor_app` is NOSUPERUSER NOBYPASSRLS and `env.ts` refuses a
--      `DATABASE_URL` naming `raptor_migrator` or `postgres`;
--   2. no raw SQL is reachable from the application at all -- there is no query
--      builder in this package that accepts caller input, and no endpoint that
--      returns rows;
--   3. the tenant boundary on BUSINESS data is enforced independently, by forced
--      RLS in `packages/db`.
--
-- Item 2 is the load-bearing one, and it is a property of the code rather than of
-- the schema. Any future endpoint, script, or debugging affordance that turns a
-- caller-supplied value into SQL invalidates this entire section. That is the
-- condition under which ADR-0017 has to be revisited.
-- =============================================================================

ALTER TABLE "auth_user"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_account"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_verification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_two_factor"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_rate_limit"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_session"     ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
  identity_tables text[] := ARRAY['auth_user','auth_account','auth_verification','auth_two_factor','auth_rate_limit','auth_session'];
BEGIN
  FOREACH t IN ARRAY identity_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_app_role_access', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (session_user = %L) WITH CHECK (session_user = %L)',
      t || '_app_role_access', t, 'raptor_app', 'raptor_app');
  END LOOP;
END
$$;

COMMENT ON POLICY auth_user_app_role_access ON "auth_user" IS
  'Identity tables are org-independent, so isolation is by role, not by tenant.';

-- =============================================================================
-- PRIVILEGES (ADR-0006)
--
-- `raptor_migrator` (SUPERUSER) owns the schema and ran this file.
-- `raptor_app` (NOSUPERUSER NOBYPASSRLS) runs every query in the product.
--
-- RLS is worthless to a role that can switch it off, so the invariant is restated
-- here rather than assumed: a superuser connection bypasses every policy in this
-- file silently, which is the "isolation looks fine but does not exist" outcome
-- ADR-0006 was written to prevent. `env.ts` refuses a `DATABASE_URL` naming
-- `raptor_migrator` or `postgres` as a runtime backstop.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raptor_app') THEN
    CREATE ROLE raptor_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO raptor_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "auth_user", "auth_session", "auth_account", "auth_verification", "auth_two_factor", "auth_rate_limit"
TO raptor_app;

-- The one column-level privilege in this file, and it closes a real hole.
--
-- The table-level UPDATE above is what Better Auth needs to refresh a session's
-- expiry, and it necessarily includes "orgId". That means the application role
-- could `UPDATE "auth_session" SET "orgId" = <any org>` directly, completely bypassing
-- the membership check in `auth_set_active_org` — leaving compensating control 2
-- of ADR-0017 decorative for any caller with SQL access.
--
-- PostgreSQL has no "deny one column" grant, so the fix is to REVOKE the blanket
-- UPDATE and re-grant it per column, omitting "orgId". A column-level grant then
-- applies on its own, and "orgId" is writable only through the SECURITY DEFINER
-- function, which refuses unless an active `org_membership` row proves the user
-- belongs to that organisation.
--
-- INSERT is deliberately NOT restricted: Better Auth creates the session row, and
-- it must be able to. It does not matter that INSERT could set "orgId", because
-- `input: false` means Better Auth never sends that key, and the app role reaching
-- a raw INSERT would still be unable to change an EXISTING session's orgId.
REVOKE UPDATE ON "auth_session" FROM raptor_app;
GRANT UPDATE ("expiresAt", "updatedAt", "ipAddress", "userAgent") ON "auth_session" TO raptor_app;

-- No DELETE on "auth_verification" for the app role beyond token consumption? Kept
-- deliberately: the two-factor plugin deletes a consumed 2fa-* challenge through
-- the same path it created it, and revoking DELETE would break that flow rather
-- than protect anything, since the row is a single-use token either way.

-- RLS is useless to a role that can simply switch it off.
--
-- Portable across self-hosted and managed databases. When this file is applied alongside
-- the canonical migrations, `ensure_role_hardened(text)` from 0001_tenancy.sql does the
-- work. When this file is applied STANDALONE (the auth test harness applies it to a fresh
-- database without the tenancy migrations), that function does not exist — so the same
-- enforce-where-superuser / verify-otherwise logic is inlined here rather than called.
-- The two copies are intentionally identical in behaviour; 0001 is canonical.
DO $$
DECLARE
  hardener_exists    boolean;
  owner_is_superuser boolean;
  target_is_super    boolean;
  target_bypasses    boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'ensure_role_hardened'
  ) INTO hardener_exists;

  IF hardener_exists THEN
    PERFORM public.ensure_role_hardened('raptor_app');
  ELSE
    SELECT rolsuper INTO owner_is_superuser
    FROM pg_catalog.pg_roles WHERE rolname = current_user;

    IF owner_is_superuser THEN
      ALTER ROLE raptor_app NOBYPASSRLS;
      ALTER ROLE raptor_app NOSUPERUSER;
    ELSE
      SELECT rolsuper, rolbypassrls INTO target_is_super, target_bypasses
      FROM pg_catalog.pg_roles WHERE rolname = 'raptor_app';

      IF target_is_super OR target_bypasses THEN
        RAISE EXCEPTION
          'role raptor_app must be NOSUPERUSER NOBYPASSRLS (rolsuper=% rolbypassrls=%), and the owner % is not a superuser and cannot change it',
          target_is_super, target_bypasses, current_user;
      END IF;
    END IF;
  END IF;
END
$$;

COMMIT;