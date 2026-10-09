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
-- identifiers (`"emailVerified"`, `"twoFactor"`, `"lastRequest"`) and the
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

CREATE TABLE IF NOT EXISTS "user" (
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
ALTER TABLE "user"      ADD COLUMN IF NOT EXISTS "twoFactorEnabled" boolean;
ALTER TABLE "user"      ADD COLUMN IF NOT EXISTS "role"             text;

-- -----------------------------------------------------------------------------
-- session
--
-- The ONLY Better Auth table that carries an org scope. A session is issued
-- inside one organisation's context; `orgId` records which.
--
-- `orgId` is declared `input: false` in `config.ts`, so no client can set it, and
-- it is written server-side once the tenant is resolved from the session's user.
-- A NULL `orgId` means "not yet bound to a tenant".
--
-- A dedicated uuid index is added because the RLS policy filters on `orgId`, and
-- without it every tenant-scoped session read degrades to a sequential scan of
-- every session in the deployment.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "session" (
  "id"        uuid        DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token"     text        NOT NULL UNIQUE,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId"    uuid        NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "orgId"     text,

  -- A session that expires before it is created can only come from a clock
  -- disagreement or a tampered row, and either way it is not a session.
  CONSTRAINT session_expiry_after_creation_check
    CHECK ("expiresAt" > "createdAt")
);

ALTER TABLE "session"  ADD COLUMN IF NOT EXISTS "orgId" text;

CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");
CREATE INDEX IF NOT EXISTS "session_orgId_idx"  ON "session" ("orgId");

-- -----------------------------------------------------------------------------
-- account
--
-- Holds the password hash and, for OAuth providers, the provider's tokens.
-- Those columns are marked `returned: false` in Better Auth, so they never leave
-- the server; the column names are kept because that is what the adapter reads.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "account" (
  "id"                     uuid        DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "accountId"              text        NOT NULL,
  "providerId"             text        NOT NULL,
  "userId"                 uuid        NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");

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

CREATE TABLE IF NOT EXISTS "verification" (
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

CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");

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

CREATE TABLE IF NOT EXISTS "twoFactor" (
  "id"                      uuid        DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "secret"                  text        NOT NULL,
  "backupCodes"             text        NOT NULL,
  "userId"                  uuid        NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "verified"                boolean     DEFAULT true,
  "failedVerificationCount" integer,
  "lockedUntil"             timestamptz,

  -- The counter is decremented and incremented by the plugin. A negative value
  -- would mean an underflow that silently defeats the lockout, so it is rejected
  -- at the source rather than trusted.
  CONSTRAINT two_factor_failed_count_nonnegative_check
    CHECK ("failedVerificationCount" IS NULL OR "failedVerificationCount" >= 0),

  -- An account is either locked until some instant or it is not locked.
  CONSTRAINT two_factor_verified_only_when_not_locked_check
    CHECK ("lockedUntil" IS NULL OR "verified" IS NOT TRUE)
);

CREATE INDEX IF NOT EXISTS "twoFactor_secret_idx" ON "twoFactor" ("secret");
CREATE INDEX IF NOT EXISTS "twoFactor_userId_idx" ON "twoFactor" ("userId");

-- -----------------------------------------------------------------------------
-- rateLimit
--
-- Counters live in Postgres rather than process memory. An in-memory counter
-- resets on every deploy and every restart, so an attacker able to induce a
-- restart resets their own budget; and it is per-process, so N instances
-- multiply the effective limit by N.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "rateLimit" (
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

DROP TRIGGER IF EXISTS user_mfa_guard_trigger ON "user";
CREATE TRIGGER user_mfa_guard_trigger
  BEFORE INSERT OR UPDATE ON "user"
  FOR EACH ROW EXECUTE FUNCTION user_mfa_guard();

-- =============================================================================
-- ROW LEVEL SECURITY
--
-- WHICH TABLES CARRY AN ORG SCOPE, AND WHY THE OTHERS ARE ONLY "ENABLED"
-- ---------------------------------------------------------------------
-- Exactly one of Better Auth's six tables is tenant-scoped: "session", via
-- "orgId". It is ENABLED and FORCED below.
--
-- "user", "account", "verification", "twoFactor" and "rateLimit" are identity,
-- which is org-INDEPENDENT by design — the same decision `packages/db` already
-- took for `person` and `identity`, because one human may work for several
-- organisations. An `org_id` predicate on `user` would be meaningless rather
-- than merely redundant. They are therefore ENABLED with no policy, exactly as
-- `0001_tenancy.sql` does for `person`:
--
--     no policy => no rows for any role that has not been granted explicitly
--
-- and the grants at the foot of this file give `raptor_app` exactly the DML it
-- needs and nothing else.
--
-- A TABLE WITH RLS ENABLED AND NO POLICY IS NOT "PROTECTED BUT WORKING" — IT IS
-- "PROTECTED AND UNUSABLE". Row Level Security is default-deny, so a non-owner
-- role sees zero rows no matter what it was granted. This is verified against the
-- real database rather than assumed: `SELECT count(*) FROM "user"` as `raptor_app`
-- returns 0 on a policy-less table, which in production would look like every
-- user's password being wrong. Hence the explicit `*_app_role_access` policies
-- below.
--
-- THE POLICY ON "session": NO BOOTSTRAP BRANCH, IT FAILS CLOSED
-- ------------------------------------------------------------
-- FORCED, so the table OWNER is subject to the policy too. A policy that only
-- binds the application role is one `ALTER TABLE ... OWNER TO` away from being
-- decorative.
--
-- The predicate is a single conjunction with no escape hatch:
--
--     current_org_id() IS NOT NULL AND "orgId" = current_org_id()::text
--
-- and it says exactly one thing: you may see a session if, and only if, you
-- have already been resolved to the tenant that owns it.
--
-- WHY THERE IS NO `current_org_id() IS NULL` BRANCH
-- -----------------------------------------------
-- An earlier revision of this file read:
--
--     USING (current_org_id() IS NULL OR "orgId" IS NULL
--            OR "orgId" = current_org_id()::text)
--
-- and the middle argument for the first branch was "the application cannot know
-- which organisation the caller belongs to until it has read the session". That
-- argument describes a real ordering constraint and it is correct as a
-- description of the flow — but as a POLICY it inverts into the opposite of a
-- boundary. `current_org_id() IS NULL` is TRUE for every request that has not
-- yet resolved a tenant, so the OR short-circuits and every such request sees
-- every session in the deployment, for every tenant, including the token and
-- `userId` of every live credential. `"session"` is the credential store: that
-- is a cross-tenant credential-store exposure, not a bootstrap convenience.
-- Documenting it as "identity bootstrap" did not change what the database did,
-- and a documented hole is still a hole.
--
-- The ordering constraint is real and is now satisfied by a different
-- mechanism — one that does not hand out the whole table to resolve it. See
-- `auth_session_by_token` above: identity resolution reads AT MOST the single
-- row whose token the caller already holds, through a `SECURITY DEFINER`
-- function that is revoked from PUBLIC. Knowing which tenant a token belongs to
-- requires possessing that token; that is the whole of the bootstrap, and it
-- grants no access beyond the one bearer credential the caller already had.
--
-- `"orgId" IS NOT NULL` is likewise load-bearing and is not merely redundant:
-- `NULL = anything` is NULL, not TRUE, so a session not yet bound to a tenant
-- is invisible to EVERY request, including the one that created it. It is
-- reachable only through `auth_session_by_token`, which is exactly the narrow
-- path it needs.
--
-- THE CONSEQUENCE, STATED PLAINLY RATHER THAN BURIED
-- --------------------------------------------------
-- A request that has not yet called `auth_session_by_token` and set
-- `app.org_id` sees zero sessions. That is the intended direction of failure:
-- unavailable, not unrestricted. `session-isolation.test.ts` proves it against
-- the real database rather than asserting it.
-- =============================================================================

ALTER TABLE "session"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session"  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS session_tenant_isolation ON "session";
CREATE POLICY session_tenant_isolation ON "session"
  USING (
    current_org_id() IS NOT NULL
    AND "orgId" = current_org_id()::text
  )
  WITH CHECK (
    current_org_id() IS NOT NULL
    AND "orgId" = current_org_id()::text
  );

-- -----------------------------------------------------------------------------
-- auth_session_by_token — THE ONLY WAY TO RESOLVE A SESSION BEFORE THE TENANT
-- IS KNOWN
--
-- ADR-0011 rule 3: the tenant is resolved from the SESSION, never from a request
-- parameter, because otherwise the caller chooses which tenant they act in.
-- That produces an unavoidable ordering: to learn the tenant you must read the
-- session, and the session read cannot itself require a tenant.
--
-- Previously that ordering was satisfied by a permissive branch in the policy,
-- which also handed every other session in the deployment to the same request.
-- This function replaces that with the narrowest elevation that actually works:
--
--   * `SECURITY DEFINER` — it runs as the table owner, so it is not subject to
--     `session_tenant_isolation`. That is the entire point, and it is the only
--     reason it may be granted at all.
--
--   * `SET search_path = ''` — MANDATORY, per ADR-0006. A `SECURITY DEFINER`
--     function that resolves unqualified names lets any caller who can create an
--     object in a directory on the path shadow the tables the body refers to and
--     run the function's privileges against their own objects. Pinning the path
--     to empty means every name must be schema-qualified, which is why the body
--     says `public."session"` rather than `"session"`.
--
--   * NO `p_org_id` PARAMETER, deliberately. A signature of
--     `auth_session_by_token(p_token, p_org_id)` would let a caller name the
--     tenant it reads from, which is exactly the substitution ADR-0011 rule 3
--     forbids. The only input is the bearer token the caller already holds, and
--     the tenant comes out of the row the token selects.
--
-- WHAT IT DOES AND DOES NOT GRANT
-- -------------------------------
-- It returns AT MOST ONE row, and only the one whose `token` equals the supplied
-- value. A caller that holds no token cannot name a session, so it reads nothing;
-- there is no branch that widens the result set. Identity resolution therefore
-- gains exactly the credential the caller already presented and nothing else.
--
-- If `app.org_id` IS set, the row must belong to it — so a token minted in org A
-- is not resolvable from a connection resolved as org B, even by this function.
-- That keeps the elevation from becoming a cross-tenant read: it bypasses RLS
-- only for the caller's own tenant, never for another tenant's.
--
-- EXECUTE is revoked from PUBLIC and granted to `raptor_app` alone. In
-- PostgreSQL a new function is EXECUTABLE by PUBLIC by default, so the REVOKE is
-- not optional bookkeeping: without it, any role — including an anonymous login
-- role — could read any session by token.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_session_by_token(p_token text)
RETURNS SETOF public."session"
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.*
  FROM public."session" s
  WHERE s."token" = p_token
    AND (
      public.current_org_id() IS NULL
      OR s."orgId" = public.current_org_id()::text
    )
$$;

COMMENT ON FUNCTION auth_session_by_token(text) IS
  'Security-definer single-row session lookup by token. Takes no org_id: the tenant comes from the row. EXECUTE is revoked from PUBLIC.';

REVOKE ALL ON FUNCTION auth_session_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_session_by_token(text) TO raptor_app;

-- Identity tables: org-independent, so there is no tenant predicate to enforce.
-- See the reasoning above and `0001_tenancy.sql`.
--
-- "account" AND "verification" NEED NO SPECIAL TREATMENT, and that is worth
-- stating explicitly rather than leaving to inspection. The bootstrap defect was
-- a `current_org_id() IS NULL` branch, and these two tables never had one: their
-- policy is `session_user = 'raptor_app'`, which compares the *invoking role*,
-- not a request-scoped GUC. There is no value of `app.org_id` — set, empty, or
-- absent — that changes what `raptor_app` may read on them, so there is no
-- ordering constraint to solve with a `SECURITY DEFINER` function. Their
-- protection is the combination of the role predicate and the GRANTs at the foot
-- of this file: a future role must clear both bars.
--
-- THEY STILL NEED A POLICY, and this is worth stating because getting it wrong is
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
ALTER TABLE "user"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "twoFactor"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rateLimit"   ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
  identity_tables text[] := ARRAY['user','account','verification','twoFactor','rateLimit'];
BEGIN
  FOREACH t IN ARRAY identity_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_app_role_access', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (session_user = %L) WITH CHECK (session_user = %L)',
      t || '_app_role_access', t, 'raptor_app', 'raptor_app');
  END LOOP;
END
$$;

COMMENT ON POLICY user_app_role_access ON "user" IS
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
  "user", "session", "account", "verification", "twoFactor", "rateLimit"
TO raptor_app;

-- No DELETE on "verification" for the app role beyond token consumption? Kept
-- deliberately: the two-factor plugin deletes a consumed 2fa-* challenge through
-- the same path it created it, and revoking DELETE would break that flow rather
-- than protect anything, since the row is a single-use token either way.

-- RLS is useless to a role that can simply switch it off.
ALTER ROLE raptor_app NOBYPASSRLS;
ALTER ROLE raptor_app NOSUPERUSER;

COMMIT;