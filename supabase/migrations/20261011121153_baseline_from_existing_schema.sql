-- GENERATED FILE - DO NOT EDIT.
--
-- Produced by scripts/sync-supabase-baseline.ts from packages/db/migrations/.
-- The canonical schema is packages/db/migrations/*.sql; this is a mirror for the Supabase
-- CLI, which applies migrations in filename order and records them in schema_migrations.
--
-- To change the schema: edit packages/db/migrations/, then re-run the script.
--
-- Files, in application order:
--   1. 0001_tenancy.sql
--   2. 0002_competitive.sql
--   3. 0003_registration_place_invariant.sql
--   4. 0004_money.sql
--   5. 0005_prize_pool_lifecycle.sql
--   6. 0006_history_queries.sql
--   7. 0007_performance_metrics.sql
--   8. 0008_people.sql
--   9. 0009_commercial.sql
--   10. 0010_operations.sql
--   11. 0011_portability.sql
--   12. 0012_analytics.sql
--   13. 0013_security_review.sql
--   14. 0014_person_credential_link.sql
--
-- Every statement below is reproduced verbatim from the source. Anything this file appears
-- to assert about the schema, assert against the source instead.

-- ==========================================================================
-- SOURCE: packages/db/migrations/0001_tenancy.sql
-- ==========================================================================

-- =============================================================================
-- 0001_tenancy.sql
--
-- Tenancy spine: identity, organisation, authorisation, audit, outbox.
--
-- Three rules are enforced structurally here, not by convention (ADR-0011):
--   1. org_id NOT NULL on every tenant-owned table; composite indexes lead with it.
--   2. Every FK between tenant-owned tables is composite and includes org_id, so a
--      cross-tenant reference cannot be expressed.
--   3. RLS is ENABLED and FORCED, with the tenant resolved from the session.
--
-- This script is applied by the migration ledger and is never edited in place.
-- =============================================================================

-- gen_random_uuid() is core since PostgreSQL 13. The legacy system used the pgcrypto
-- backport on older versions; we do not depend on it, which also keeps the local
-- PGlite build (a subset of contrib extensions) able to run this migration.

-- -----------------------------------------------------------------------------
-- Schema bookkeeping
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migration (
  id           integer PRIMARY KEY,
  name         text    NOT NULL,
  checksum     text    NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT now(),
  duration_ms  integer
);

CREATE TABLE IF NOT EXISTS platform_feature_flag (
  key         varchar(128) PRIMARY KEY,
  enabled     boolean     NOT NULL DEFAULT false,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Session context
--
-- The tenant is set once per request/transaction by the application and read by
-- every policy. It is NEVER accepted as a query parameter — otherwise the caller
-- chooses which tenant they act in (ADR-0011 rule 3).
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
-- IDENTITY (org-independent by design)
-- -----------------------------------------------------------------------------

CREATE TABLE person (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz
);

CREATE TABLE identity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  method      text NOT NULL CHECK (method IN ('email','oauth','sso','phone')),
  identifier  text NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_identifier_key UNIQUE (method, identifier)
);

CREATE TABLE person_profile (
  person_id          uuid PRIMARY KEY REFERENCES person(id) ON DELETE CASCADE,
  display_name       varchar(200),
  legal_name         varchar(200),
  pronouns           varchar(60),
  locale             varchar(16) NOT NULL DEFAULT 'en',
  timezone           varchar(64) NOT NULL DEFAULT 'UTC',
  bio                text,
  avatar_url         text,
  profile_visibility varchar(16) NOT NULL DEFAULT 'private',
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_profile_visibility_check
    CHECK (profile_visibility IN ('private','org','public'))
);

CREATE TABLE consent_record (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id      uuid NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  purpose        varchar(64) NOT NULL,
  granted        boolean NOT NULL,
  policy_version varchar(64) NOT NULL,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  CONSTRAINT consent_person_purpose_version_key UNIQUE (person_id, purpose, policy_version)
);

CREATE INDEX consent_person_idx ON consent_record (person_id);

CREATE TABLE guardian_consent (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id          uuid NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  guardian_name      varchar(200) NOT NULL,
  document_asset_id  uuid,
  granted_at         timestamptz NOT NULL,
  expires_at         timestamptz,
  revoked_at         timestamptz
);

CREATE INDEX guardian_consent_person_idx ON guardian_consent (person_id);

-- -----------------------------------------------------------------------------
-- ORGANISATION (the tenant)
-- -----------------------------------------------------------------------------

CREATE TYPE org_status AS ENUM ('provisioning','active','suspended','closed');
CREATE TYPE membership_status AS ENUM ('pending','active','suspended','left');
CREATE TYPE scope_type AS ENUM ('organization','department','division','team','campaign','self','assigned');
CREATE TYPE worker_classification AS ENUM
  ('employee','contractor','player','creator','intern','advisor','volunteer');

CREATE TABLE organization (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                    varchar(64)  NOT NULL UNIQUE,
  display_name            varchar(200) NOT NULL,
  legal_name              varchar(240),
  status                  org_status NOT NULL DEFAULT 'provisioning',
  default_currency        varchar(3)   NOT NULL,
  default_timezone        varchar(64)  NOT NULL DEFAULT 'UTC',
  default_locale          varchar(16)  NOT NULL DEFAULT 'en',
  fiscal_year_start_month integer      NOT NULL DEFAULT 1,
  data_region             varchar(32)  NOT NULL DEFAULT 'local',
  created_at              timestamptz  NOT NULL DEFAULT now(),
  archived_at             timestamptz,
  CONSTRAINT organization_fiscal_month_check
    CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  CONSTRAINT organization_currency_check
    CHECK (default_currency ~ '^[A-Z]{3}$')
);

CREATE TABLE org_membership (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  person_id             uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  status                membership_status NOT NULL DEFAULT 'pending',
  invited_by_person_id  uuid,
  invited_at            timestamptz,
  joined_at             timestamptz,
  left_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_membership_org_person_key UNIQUE (org_id, person_id),
  -- Composite target so child tables can enforce tenant-scoped references (ADR-0011).
  CONSTRAINT org_membership_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX org_membership_org_idx   ON org_membership (org_id);
CREATE INDEX org_membership_person_idx ON org_membership (person_id);

CREATE TABLE engagement (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  person_id                 uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  classification            worker_classification NOT NULL,
  title                     varchar(160),
  is_age_restricted         boolean NOT NULL DEFAULT false,
  is_primary                boolean NOT NULL DEFAULT false,
  scope_type                scope_type NOT NULL DEFAULT 'organization',
  scope_id                  uuid,
  reporting_line_person_id  uuid,
  valid_from                timestamptz NOT NULL,
  valid_to                  timestamptz,
  ended_reason              varchar(200),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engagement_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- Composite: lets child tables reference (org_id, engagement.id).
  CONSTRAINT engagement_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX engagement_org_idx         ON engagement (org_id);
CREATE INDEX engagement_org_person_idx  ON engagement (org_id, person_id);

-- At most one CURRENT engagement per classification. Effective dating does the rest.
CREATE UNIQUE INDEX engagement_current_per_classification_key
  ON engagement (org_id, person_id, classification)
  WHERE valid_to IS NULL;

-- -----------------------------------------------------------------------------
-- AUTHORISATION
-- -----------------------------------------------------------------------------

CREATE TABLE role (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  key          varchar(64)  NOT NULL,
  name         varchar(120) NOT NULL,
  description  text,
  is_system    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_org_key_key UNIQUE (org_id, key),
  CONSTRAINT role_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX role_org_idx ON role (org_id);

CREATE TABLE permission (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid REFERENCES organization(id) ON DELETE CASCADE, -- NULL = system
  key         varchar(128) NOT NULL UNIQUE,
  resource    varchar(64)  NOT NULL,
  action      varchar(64)  NOT NULL,
  risk_level  varchar(16)  NOT NULL DEFAULT 'low',
  description text,
  CONSTRAINT permission_risk_check CHECK (risk_level IN ('low','medium','high','critical'))
);

CREATE INDEX permission_org_idx ON permission (org_id);

CREATE TABLE role_permission (
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  role_id       uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permission(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX role_permission_org_idx ON role_permission (org_id);

CREATE TABLE role_scope_rule (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  role_id        uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  scope_type     scope_type NOT NULL,
  max_scope_rank integer NOT NULL DEFAULT 0,
  CONSTRAINT role_scope_rule_unique_key UNIQUE (role_id, scope_type),
  CONSTRAINT role_scope_rule_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX role_scope_rule_org_idx ON role_scope_rule (org_id);

CREATE TABLE role_assignment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  person_id           uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  role_id             uuid NOT NULL REFERENCES role(id) ON DELETE RESTRICT,
  scope_type          scope_type NOT NULL DEFAULT 'organization',
  scope_id            uuid,
  valid_from          timestamptz NOT NULL,
  valid_to            timestamptz,
  granted_by_person_id uuid,
  granted_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_assignment_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT role_assignment_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX role_assignment_org_idx        ON role_assignment (org_id);
CREATE INDEX role_assignment_org_person_idx ON role_assignment (org_id, person_id);

CREATE UNIQUE INDEX role_assignment_current_key
  ON role_assignment (org_id, person_id, role_id)
  WHERE valid_to IS NULL;

-- -----------------------------------------------------------------------------
-- AUDIT (append-only)
-- -----------------------------------------------------------------------------

CREATE TABLE audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid REFERENCES organization(id) ON DELETE RESTRICT,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_type     varchar(16)  NOT NULL,
  actor_id       uuid,
  actor_label    varchar(240),
  action_class   varchar(64)  NOT NULL,
  action         varchar(128) NOT NULL,
  resource_type  varchar(64),
  resource_id    varchar(128),
  correlation_id uuid,
  ip             varchar(64),
  user_agent     text,
  before         jsonb,
  after          jsonb,
  metadata       jsonb,
  CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('user','system','integration'))
);

CREATE INDEX audit_log_org_occurred_idx ON audit_log (org_id, occurred_at);
CREATE INDEX audit_log_action_class_idx ON audit_log (action_class);
CREATE INDEX audit_log_correlation_idx    ON audit_log (correlation_id);

-- The audit log is evidence. Deny UPDATE and DELETE outright rather than relying on
-- application discipline.
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- OUTBOX
-- -----------------------------------------------------------------------------

CREATE TABLE outbox_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid REFERENCES organization(id) ON DELETE CASCADE,
  topic          text    NOT NULL,
  payload        jsonb   NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  actor_type     varchar(16) NOT NULL,
  actor_id       uuid,
  correlation_id uuid,
  causation_id   uuid,
  dedupe_key     text    NOT NULL UNIQUE,
  schema_version integer NOT NULL DEFAULT 1,
  published_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  CONSTRAINT outbox_event_actor_type_check CHECK (actor_type IN ('user','system','integration'))
);

CREATE INDEX outbox_event_unpublished_idx ON outbox_event (published_at, occurred_at);

-- =============================================================================
-- ROW LEVEL SECURITY
--
-- The tenant predicate is ALWAYS the outermost condition. Every tenant-owned table is
-- enabled AND forced, so the table owner is subject to the policies too.
--
-- The application connects as a non-superuser (ADR-0006). A superuser connection
-- bypasses all of this silently, which is exactly the failure mode being prevented.
-- =============================================================================

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'org_membership','engagement','role','role_permission','role_scope_rule','role_assignment'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;

-- Audit log: tenant-scoped, readable within the tenant. Append-only.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  USING (org_id IS NULL OR org_id = current_org_id())
  WITH CHECK (org_id IS NULL OR org_id = current_org_id());

-- Outbox: the relay is a system actor that reads across tenants to publish.
-- Application inserts remain tenant-scoped.
ALTER TABLE outbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_event FORCE  ROW LEVEL SECURITY;
CREATE POLICY outbox_event_tenant_isolation ON outbox_event
  USING (org_id IS NULL OR org_id = current_org_id())
  WITH CHECK (org_id IS NULL OR org_id = current_org_id());

-- Person / identity / profile / consent are org-independent by design: a person may
-- belong to several organisations. Access is gated in the service layer by membership,
-- not by an org_id predicate that would be meaningless here.
-- These are still protected from anonymous access: no policy means no rows for anon.
ALTER TABLE person            ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity          ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_profile    ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_record    ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_consent  ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- ROLES
-- =============================================================================

-- The migration role owns the schema. The application role is a non-superuser with no
-- BYPASSRLS and receives only the privileges it needs (ADR-0006).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raptor_app') THEN
    CREATE ROLE raptor_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO raptor_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  organization, org_membership, engagement, role, role_permission,
  role_scope_rule, role_assignment, audit_log, outbox_event, person,
  identity, person_profile, consent_record, guardian_consent
TO raptor_app;

-- The app role may read roles but must never alter them: a compromised application
-- process cannot grant itself more access.
REVOKE INSERT, UPDATE, DELETE ON role, role_permission, role_scope_rule FROM raptor_app;

-- RLS is useless to a role that can simply switch it off.
--
-- Portable form: on a self-hosted PostgreSQL the migration owner is a superuser and the
-- function below enforces the attributes even if the role predates this migration. On a
-- MANAGED database (Supabase Cloud, RDS, AlloyDB) the owner is not a superuser and ALTER
-- ROLE against another role's SUPERUSER/BYPASSRLS attributes is refused with 42501 — the
-- platform owns role elevation, not the migration. There the CREATE ROLE above, which names
-- both attributes explicitly, is what sets them, and the function VERIFIES rather than
-- enforces: if the role exists with the wrong attributes and we cannot change them, the
-- migration fails loudly instead of shipping a superuser application role silently.
CREATE OR REPLACE FUNCTION ensure_role_hardened(p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  owner_is_superuser boolean;
  target_is_super    boolean;
  target_bypasses    boolean;
BEGIN
  SELECT rolsuper INTO owner_is_superuser
  FROM pg_catalog.pg_roles WHERE rolname = current_user;

  IF owner_is_superuser THEN
    EXECUTE pg_catalog.format('ALTER ROLE %I NOBYPASSRLS', p_role);
    EXECUTE pg_catalog.format('ALTER ROLE %I NOSUPERUSER', p_role);
  ELSE
    SELECT rolsuper, rolbypassrls INTO target_is_super, target_bypasses
    FROM pg_catalog.pg_roles WHERE rolname = p_role;

    IF target_is_super OR target_bypasses THEN
      RAISE EXCEPTION
        'role % must be NOSUPERUSER NOBYPASSRLS, but is rolsuper=% rolbypassrls=%, and the migration owner % is not a superuser and cannot change it',
        p_role, target_is_super, target_bypasses, current_user;
    END IF;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION ensure_role_hardened(text) FROM PUBLIC;

-- Thin wrapper kept stable for the call sites in later migrations. The inner call is
-- schema-qualified because this wrapper itself runs with SET search_path = '': an
-- unqualified name resolves against NO schema, and the call fails with
-- "function ensure_role_hardened(unknown) does not exist". That failure mode is easy to
-- misread as a missing function rather than what it is — an empty search path.
CREATE OR REPLACE FUNCTION ensure_raptor_app_hardened()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT public.ensure_role_hardened('raptor_app') $$;

REVOKE ALL ON FUNCTION ensure_raptor_app_hardened() FROM PUBLIC;

SELECT ensure_raptor_app_hardened();

-- ==========================================================================
-- SOURCE: packages/db/migrations/0002_competitive.sql
-- ==========================================================================

-- =============================================================================
-- 0002_competitive.sql
--
-- Competitive operations: the domain the legacy system never modelled.
--
-- The audit is unambiguous about why. The legacy schema had no match, no bracket,
-- no opponent, no result and no tournament entity. "Tournament" was free text on a
-- slot row, and one row was asked to mean three different things at once:
--
--   SLOT     — a purchase of capacity
--   ENTRY    — a participation by a team
--   RESULT   — an outcome of a match
--
-- Conflating them is why capacity could be oversold (a purchase was not an entry,
-- so nothing decremented anything) and why no result could ever be recorded (there
-- was nowhere to put one). This migration keeps the three apart and gives each its
-- own table.
--
-- The tenancy rules are identical to 0001 and are not restated per table:
--   1. org_id NOT NULL on every table; every composite index leads with it.
--   2. Every FK between tenant tables is composite and includes org_id, so a
--      cross-tenant reference cannot be expressed (ADR-0011). That requires
--      UNIQUE (org_id, id) on every referenced table.
--   3. RLS is ENABLED *and* FORCED, with the tenant resolved from the session.
--      The policy has no IS NULL bypass branch, so an unset tenant context yields
--      zero rows rather than every row (ADR-0015).
--
-- Money is numeric(18,4) beside a currency varchar(3) — ADR-0003 fixes the scale at
-- 4 decimal places. Never an integer minor unit here, never a float. Every
-- timestamp is timestamptz; the legacy attendances.session_time was text and the
-- audit called it the likely root cause of the whole attendance bug backlog.
--
-- Applied by the migration ledger. Never edited in place.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enumerations
-- -----------------------------------------------------------------------------

CREATE TYPE title_tier AS ENUM ('commercial', 'competitive');

CREATE TYPE game_status AS ENUM ('active', 'retired');

CREATE TYPE title_status AS ENUM ('announced', 'active', 'retired');

CREATE TYPE season_status AS ENUM ('scheduled', 'active', 'completed');

CREATE TYPE division_tier AS ENUM ('elite', 'pro', 'challenger', 'contender', 'academy');

CREATE TYPE team_status AS ENUM ('forming', 'active', 'inactive', 'disbanded');

CREATE TYPE team_member_role AS ENUM ('player', 'captain', 'substitute', 'academy', 'flex');

CREATE TYPE team_staff_role AS ENUM
  ('head_coach', 'assistant_coach', 'analyst', 'manager', 'performance_coach', 'content_coach');

CREATE TYPE competition_format AS ENUM
  ('single_elimination', 'double_elimination', 'round_robin', 'swiss', 'groups_playoffs');

CREATE TYPE competition_status AS ENUM
  ('draft', 'registration_open', 'registration_closed', 'in_progress', 'completed', 'cancelled');

CREATE TYPE registration_status AS ENUM
  ('pending', 'confirmed', 'waitlisted', 'withdrawn', 'cancelled');

CREATE TYPE match_status AS ENUM ('scheduled', 'live', 'completed', 'forfeit', 'cancelled');

CREATE TYPE match_map_result AS ENUM ('win', 'loss', 'draw', 'not_played');

-- Provenance. The legacy system recorded results with no indication of where the
-- number came from, so an OCR-derived row and a hand-typed row were indistinguishable
-- forever. The audit called that a critical finding, and it is unrecoverable after
-- the fact — so the schema refuses to store a result without it.
CREATE TYPE match_result_source AS ENUM ('manual', 'ocr', 'provider_api', 'import', 'system');

CREATE TYPE session_kind AS ENUM ('practice', 'scrim', 'review', 'coaching', 'team_meeting', 'bootcamp');

CREATE TYPE session_status AS ENUM ('planned', 'held', 'cancelled', 'no_show');

CREATE TYPE attendance_status AS ENUM ('present', 'absent', 'late', 'excused', 'remote');

CREATE TYPE attendance_record_method AS ENUM ('self_reported', 'kiosk_scan', 'coach_marked', 'import');

CREATE TYPE holiday_scope AS ENUM ('none', 'org', 'national');

-- -----------------------------------------------------------------------------
-- Competitive catalogue: game -> title -> season -> division
--
-- The legacy schema had a single free-text teams.tier column that was asked to mean
-- two unrelated things at once: the commercial product a roster was sold under, and
-- the competitive tier it played in. Those are now separate tables with a real
-- hierarchy, because they change for different reasons, at different times, and are
-- reported on differently.
-- -----------------------------------------------------------------------------

CREATE TABLE game (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name        varchar(120) NOT NULL,
  slug        varchar(64)  NOT NULL,
  publisher   varchar(160),
  status      game_status NOT NULL DEFAULT 'active',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT game_org_slug_key  UNIQUE (org_id, slug),
  CONSTRAINT game_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX game_org_idx ON game (org_id);

-- The commercial tier: the product a roster is sold under ("VCT", "ECS", "LPL").
CREATE TABLE title (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  game_id     uuid NOT NULL,
  name        varchar(160) NOT NULL,
  slug        varchar(80)  NOT NULL,
  publisher   varchar(160),
  tier        title_tier   NOT NULL DEFAULT 'commercial',
  status      title_status NOT NULL DEFAULT 'announced',
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT title_game_fk
    FOREIGN KEY (org_id, game_id) REFERENCES game (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT title_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT title_org_slug_key  UNIQUE (org_id, slug),
  CONSTRAINT title_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX title_org_idx       ON title (org_id);
CREATE INDEX title_org_game_idx  ON title (org_id, game_id);

CREATE TABLE season (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  title_id    uuid NOT NULL,
  name        varchar(120) NOT NULL,
  code        varchar(40),
  starts_on   timestamptz NOT NULL,
  ends_on     timestamptz NOT NULL,
  status      season_status NOT NULL DEFAULT 'scheduled',
  is_current  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT season_title_fk
    FOREIGN KEY (org_id, title_id) REFERENCES title (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT season_date_range_check CHECK (ends_on > starts_on),
  CONSTRAINT season_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX season_org_idx        ON season (org_id);
CREATE INDEX season_org_title_idx  ON season (org_id, title_id);

-- The competitive tier, deliberately NOT the same thing as title. A division answers
-- "how strong is this competition", a title answers "what is this sold as".
CREATE TABLE division (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  season_id   uuid NOT NULL,
  name        varchar(120) NOT NULL,
  slug        varchar(64)  NOT NULL,
  tier        division_tier NOT NULL DEFAULT 'challenger',
  rank_order  integer NOT NULL DEFAULT 1,
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT division_season_fk
    FOREIGN KEY (org_id, season_id) REFERENCES season (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT division_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT division_rank_check      CHECK (rank_order >= 1),
  CONSTRAINT division_org_slug_key   UNIQUE (org_id, season_id, slug),
  CONSTRAINT division_org_id_id_key  UNIQUE (org_id, id)
);

CREATE INDEX division_org_idx         ON division (org_id);
CREATE INDEX division_org_season_idx  ON division (org_id, season_id);

-- One current division per org+season name, so a re-run cannot create two "Elite"
-- divisions that both claim to be the live one.
CREATE UNIQUE INDEX division_current_key
  ON division (org_id, season_id, name)
  WHERE valid_to IS NULL AND archived_at IS NULL;

-- -----------------------------------------------------------------------------
-- Roster
-- -----------------------------------------------------------------------------

CREATE TABLE team (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name         varchar(160) NOT NULL,
  slug         varchar(80)  NOT NULL,
  game_id      uuid NOT NULL,
  division_id  uuid,
  status       team_status NOT NULL DEFAULT 'forming',
  is_active    boolean NOT NULL DEFAULT true,
  valid_from   timestamptz NOT NULL DEFAULT now(),
  valid_to     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT team_game_fk
    FOREIGN KEY (org_id, game_id) REFERENCES game (org_id, id) ON DELETE RESTRICT,
  -- Nullable, so a team exists before it is placed in a division. When set, the
  -- composite form still makes a cross-org division reference impossible.
  CONSTRAINT team_division_fk
    FOREIGN KEY (org_id, division_id) REFERENCES division (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT team_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT team_org_slug_key  UNIQUE (org_id, slug),
  CONSTRAINT team_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX team_org_idx         ON team (org_id);
CREATE INDEX team_org_game_idx    ON team (org_id, game_id);
CREATE INDEX team_org_division_idx ON team (org_id, division_id);

-- A person's place on a roster, effective-dated.
--
-- share_percent is what the prize allocation engine in packages/core/src/prize reads
-- to split a pool. It is stored at 4 decimal places so it matches parsePercent's scale
-- exactly (parsePercent("100") === 1_000_000n), and it is bounded by CHECK rather than
-- trusted from the client, because an over-100 share silently redistributes money.
CREATE TABLE team_membership (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  team_id       uuid NOT NULL,
  person_id     uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  role_in_team  team_member_role NOT NULL DEFAULT 'player',
  share_percent numeric(7,4) NOT NULL DEFAULT 0,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  left_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT team_membership_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT team_membership_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT team_membership_share_range_check CHECK (share_percent >= 0 AND share_percent <= 100),
  CONSTRAINT team_membership_left_check CHECK (left_at IS NULL OR left_at >= joined_at),
  CONSTRAINT team_membership_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX team_membership_org_idx          ON team_membership (org_id);
CREATE INDEX team_membership_org_team_idx     ON team_membership (org_id, team_id);
CREATE INDEX team_membership_org_person_idx   ON team_membership (org_id, person_id);

-- At most one CURRENT membership per person per team. Without this, a re-import could
-- leave two open rows for the same player and the prize engine would split between
-- both, which is a money bug that is invisible until a player disputes a payout.
CREATE UNIQUE INDEX team_membership_current_key
  ON team_membership (org_id, team_id, person_id)
  WHERE valid_to IS NULL;

-- Staff are deliberately NOT roster members. A coach manages a team without being on
-- its roster, and conflating the two is how a coach inherited a playing share.
CREATE TABLE team_staff (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  team_id        uuid NOT NULL,
  person_id      uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  role_in_team   team_staff_role NOT NULL,
  is_contracted  boolean NOT NULL DEFAULT false,
  valid_from     timestamptz NOT NULL,
  valid_to       timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  CONSTRAINT team_staff_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT team_staff_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT team_staff_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX team_staff_org_idx        ON team_staff (org_id);
CREATE INDEX team_staff_org_team_idx   ON team_staff (org_id, team_id);
CREATE INDEX team_staff_org_person_idx ON team_staff (org_id, person_id);

CREATE UNIQUE INDEX team_staff_current_key
  ON team_staff (org_id, team_id, person_id, role_in_team)
  WHERE valid_to IS NULL;

-- -----------------------------------------------------------------------------
-- Competition
-- -----------------------------------------------------------------------------

CREATE TABLE competition (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  title_id              uuid NOT NULL,
  name                  varchar(200) NOT NULL,
  format                competition_format NOT NULL,
  status                competition_status NOT NULL DEFAULT 'draft',
  starts_at             timestamptz NOT NULL,
  ends_at               timestamptz NOT NULL,
  registration_deadline timestamptz,
  external_ref          varchar(120),
  valid_from            timestamptz NOT NULL DEFAULT now(),
  valid_to              timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz,
  CONSTRAINT competition_title_fk
    FOREIGN KEY (org_id, title_id) REFERENCES title (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT competition_window_check CHECK (ends_at > starts_at),
  -- A deadline after the event starts is a deadline nobody can meet.
  CONSTRAINT competition_deadline_check
    CHECK (registration_deadline IS NULL OR registration_deadline <= starts_at),
  CONSTRAINT competition_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT competition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX competition_org_idx        ON competition (org_id);
CREATE INDEX competition_org_title_idx  ON competition (org_id, title_id);
CREATE INDEX competition_org_start_idx  ON competition (org_id, starts_at);

-- CAPACITY LIVES HERE, and nowhere else.
--
-- `capacity` is the number of teams the division can hold and `registered_count` is
-- the number currently holding a place. registered_count is maintained ONLY by the
-- trigger below, under a row lock, so the check-then-increment cannot interleave.
--
-- The CHECK is the structural guarantee and is deliberately redundant with the
-- trigger: even a direct UPDATE that bypassed the trigger could not store a state in
-- which more teams are registered than the division can hold. Overselling is not
-- "guarded against here", it is unrepresentable.
CREATE TABLE competition_division (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  competition_id   uuid NOT NULL,
  division_id      uuid,
  name             varchar(120) NOT NULL,
  capacity         integer NOT NULL,
  registered_count integer NOT NULL DEFAULT 0,
  prize_position   integer,
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_to         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  CONSTRAINT competition_division_competition_fk
    FOREIGN KEY (org_id, competition_id) REFERENCES competition (org_id, id) ON DELETE CASCADE,
  CONSTRAINT competition_division_division_fk
    FOREIGN KEY (org_id, division_id) REFERENCES division (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT competition_division_capacity_check CHECK (capacity > 0),
  CONSTRAINT competition_division_count_range_check CHECK (registered_count >= 0),
  -- The oversell guarantee, expressed as an invariant the storage cannot violate.
  CONSTRAINT competition_division_not_oversold_check CHECK (registered_count <= capacity),
  CONSTRAINT competition_division_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT competition_division_org_name_key UNIQUE (org_id, competition_id, name),
  CONSTRAINT competition_division_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX competition_division_org_idx   ON competition_division (org_id);
CREATE INDEX competition_division_org_comp_idx ON competition_division (org_id, competition_id);

-- An ENTRY: a team has entered a division. This is the replacement for the legacy
-- `slot` row, which was a purchase and an entry at once and therefore could be
-- counted as either. The purchase is entry_cost, below.
CREATE TABLE registration (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  competition_division_id uuid NOT NULL,
  team_id                uuid NOT NULL,
  status                 registration_status NOT NULL DEFAULT 'pending',
  seed_number            integer,
  registered_at          timestamptz NOT NULL DEFAULT now(),
  confirmed_at           timestamptz,
  withdrawn_at           timestamptz,
  valid_from             timestamptz NOT NULL DEFAULT now(),
  valid_to               timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz,
  CONSTRAINT registration_division_fk
    FOREIGN KEY (org_id, competition_division_id)
    REFERENCES competition_division (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT registration_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT registration_seed_check    CHECK (seed_number IS NULL OR seed_number >= 1),
  CONSTRAINT registration_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- A team enters a given division once. The legacy model allowed several rows for
  -- the same team, each of which looked like a separate place sold.
  CONSTRAINT registration_org_division_team_key UNIQUE (org_id, competition_division_id, team_id),
  CONSTRAINT registration_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX registration_org_idx             ON registration (org_id);
CREATE INDEX registration_org_division_idx   ON registration (org_id, competition_division_id);
CREATE INDEX registration_org_team_idx       ON registration (org_id, team_id);

-- What was actually paid for an entry. Money, not an integer minor unit and not a
-- float: numeric(18,4) with the currency beside it (ADR-0003).
CREATE TABLE entry_cost (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  registration_id uuid NOT NULL,
  amount          numeric(18,4) NOT NULL,
  discount        numeric(18,4) NOT NULL DEFAULT 0,
  currency        varchar(3) NOT NULL,
  paid_at         timestamptz,
  method          varchar(32),
  reference       varchar(120),
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CONSTRAINT entry_cost_registration_fk
    FOREIGN KEY (org_id, registration_id) REFERENCES registration (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT entry_cost_amount_check   CHECK (amount >= 0),
  CONSTRAINT entry_cost_discount_check CHECK (discount >= 0),
  CONSTRAINT entry_cost_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  -- One charge per entry. Two rows here would mean a player was billed twice, or
  -- that a refund was modelled as a second entry, and neither is knowable later.
  CONSTRAINT entry_cost_org_registration_key UNIQUE (org_id, registration_id),
  CONSTRAINT entry_cost_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX entry_cost_org_idx ON entry_cost (org_id);

-- -----------------------------------------------------------------------------
-- Match, opponent, result
--
-- The legacy application had none of this. A result could not be recorded because
-- there was no match to attach one to.
-- -----------------------------------------------------------------------------

-- An opponent is modelled as OUR record of another organisation's team. It is
-- deliberately not a foreign key to team: the opposing org's rows are not ours to
-- reference, and a composite FK would forbid exactly the reference we need. So the
-- external identity is stored as data, with the other org's own id kept for
-- reconciliation rather than enforced.
CREATE TABLE opponent (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name             varchar(160) NOT NULL,
  short_name       varchar(40),
  game_id          uuid NOT NULL,
  external_org_id  uuid,
  external_team_id uuid,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  CONSTRAINT opponent_game_fk
    FOREIGN KEY (org_id, game_id) REFERENCES game (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT opponent_org_name_key UNIQUE (org_id, name),
  CONSTRAINT opponent_org_id_id_key  UNIQUE (org_id, id)
);

CREATE INDEX opponent_org_idx      ON opponent (org_id);
CREATE INDEX opponent_org_game_idx ON opponent (org_id, game_id);

CREATE TABLE match (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  competition_division_id uuid,
  team_id                uuid NOT NULL,
  opponent_id            uuid NOT NULL,
  round_label            varchar(40),
  round_number           integer,
  status                 match_status NOT NULL DEFAULT 'scheduled',
  best_of                integer,
  scheduled_at           timestamptz NOT NULL,
  started_at             timestamptz,
  completed_at           timestamptz,
  stream_url             text,
  venue                  varchar(160),
  valid_from             timestamptz NOT NULL DEFAULT now(),
  valid_to               timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz,
  -- Nullable because a scrim belongs to no division; when set, the composite form
  -- still makes a cross-org division reference impossible.
  CONSTRAINT match_division_fk
    FOREIGN KEY (org_id, competition_division_id)
    REFERENCES competition_division (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT match_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT match_opponent_fk
    FOREIGN KEY (org_id, opponent_id) REFERENCES opponent (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT match_best_of_check CHECK (best_of IS NULL OR best_of >= 1),
  CONSTRAINT match_round_number_check CHECK (round_number IS NULL OR round_number >= 1),
  CONSTRAINT match_completion_check CHECK (completed_at IS NULL OR completed_at >= started_at),
  CONSTRAINT match_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT match_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX match_org_idx          ON match (org_id);
CREATE INDEX match_org_division_idx ON match (org_id, competition_division_id);
CREATE INDEX match_org_team_idx     ON match (org_id, team_id);
CREATE INDEX match_org_start_idx    ON match (org_id, scheduled_at);

CREATE TABLE match_map (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  match_id      uuid NOT NULL,
  map_order     integer NOT NULL,
  map_name      varchar(120),
  our_score     integer,
  opponent_score integer,
  result        match_map_result,
  duration_minutes integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT match_map_match_fk
    FOREIGN KEY (org_id, match_id) REFERENCES match (org_id, id) ON DELETE CASCADE,
  CONSTRAINT match_map_order_check  CHECK (map_order >= 1),
  CONSTRAINT match_map_our_score_check     CHECK (our_score IS NULL OR our_score >= 0),
  CONSTRAINT match_map_opponent_score_check CHECK (opponent_score IS NULL OR opponent_score >= 0),
  -- Map 2 of a match exists once. A duplicate row would double every map win.
  CONSTRAINT match_map_org_match_order_key UNIQUE (org_id, match_id, map_order),
  CONSTRAINT match_map_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX match_map_org_idx     ON match_map (org_id);
CREATE INDEX match_map_org_match_idx ON match_map (org_id, match_id);

-- An OUTCOME, kept separate from the entry and the purchase.
--
-- `source` and `confidence` are not decoration. The audit found results with no
-- provenance, which made an OCR-derived number and a hand-typed one permanently
-- indistinguishable — you cannot later decide which rows to re-check, because the
-- evidence was never written down. confidence is REQUIRED for machine sources:
-- a CHECK makes "this number came from a machine and nobody has verified it"
-- representable, and makes "a machine produced this and we recorded no confidence"
-- not.
CREATE TABLE match_result (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  match_id     uuid NOT NULL,
  team_id      uuid NOT NULL,
  outcome      match_map_result NOT NULL,
  placement    integer,
  rounds_won   integer NOT NULL DEFAULT 0,
  rounds_lost  integer NOT NULL DEFAULT 0,
  maps_won     integer NOT NULL DEFAULT 0,
  maps_lost    integer NOT NULL DEFAULT 0,
  source       match_result_source NOT NULL,
  confidence   numeric(5,4) NOT NULL,
  recorded_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  verified_at  timestamptz,
  verified_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT match_result_match_fk
    FOREIGN KEY (org_id, match_id) REFERENCES match (org_id, id) ON DELETE CASCADE,
  CONSTRAINT match_result_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT match_result_placement_check CHECK (placement IS NULL OR placement >= 1),
  CONSTRAINT match_result_rounds_check
    CHECK (rounds_won >= 0 AND rounds_lost >= 0 AND maps_won >= 0 AND maps_lost >= 0),
  CONSTRAINT match_result_confidence_check CHECK (confidence >= 0 AND confidence <= 1),
  -- A hand-typed number is either known or it is not, so it carries 1. A number a
  -- machine read off a screenshot is only as good as the read, and forcing the
  -- author to state that is the entire point of the column.
  CONSTRAINT match_result_manual_confidence_check
    CHECK (source <> 'manual' OR confidence = 1),
  -- "Verified" without a verifier is a claim, not a verification.
  CONSTRAINT match_result_verified_check
    CHECK (verified_at IS NULL OR (verified_by_person_id IS NOT NULL AND verified_at >= recorded_at)),
  -- One current result per match per team. A correction supersedes by archiving the
  -- previous row, so the history that produced the number is never overwritten.
  CONSTRAINT match_result_org_match_team_key UNIQUE (org_id, match_id, team_id),
  CONSTRAINT match_result_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX match_result_org_idx      ON match_result (org_id);
CREATE INDEX match_result_org_match_idx ON match_result (org_id, match_id);
CREATE INDEX match_result_org_source_idx ON match_result (org_id, source);

-- Money for one competition division.
--
-- net is constrained to gross - deductions rather than trusted, because the prize
-- engine distributes `net` and a hand-entered net that disagrees with gross is a
-- variance nobody can explain to a player.
CREATE TABLE prize_pool (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  competition_division_id uuid NOT NULL,
  gross                  numeric(18,4) NOT NULL,
  deductions             numeric(18,4) NOT NULL DEFAULT 0,
  net                    numeric(18,4) NOT NULL,
  tax_withheld           numeric(18,4) NOT NULL DEFAULT 0,
  currency               varchar(3) NOT NULL,
  sponsor_label          varchar(160),
  valid_from             timestamptz NOT NULL DEFAULT now(),
  valid_to               timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz,
  CONSTRAINT prize_pool_division_fk
    FOREIGN KEY (org_id, competition_division_id)
    REFERENCES competition_division (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_pool_gross_check    CHECK (gross >= 0),
  CONSTRAINT prize_pool_deduction_check CHECK (deductions >= 0),
  CONSTRAINT prize_pool_net_check      CHECK (net >= 0),
  CONSTRAINT prize_pool_tax_check      CHECK (tax_withheld >= 0),
  CONSTRAINT prize_pool_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  -- Exact arithmetic on numeric, so this cannot drift by a rounding error.
  CONSTRAINT prize_pool_net_identity_check CHECK (net = gross - deductions),
  CONSTRAINT prize_pool_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT prize_pool_org_division_key UNIQUE (org_id, competition_division_id),
  CONSTRAINT prize_pool_org_id_id_key    UNIQUE (org_id, id)
);

CREATE INDEX prize_pool_org_idx ON prize_pool (org_id);

-- -----------------------------------------------------------------------------
-- Sessions and attendance
--
-- The legacy attendances.session_time was `text`. The audit called it the likely root
-- cause of the entire attendance bug backlog: strings do not order, and a cutoff
-- window cannot be evaluated against a string. Every timestamp here is timestamptz.
-- -----------------------------------------------------------------------------

CREATE TABLE attendance_policy (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  team_id               uuid,
  name                  varchar(120) NOT NULL,
  -- Minutes before the session start at which the attendance window closes. Negative,
  -- because it is an offset backwards from start and a positive number here would be
  -- silently wrong.
  cutoff_offset_minutes integer NOT NULL DEFAULT -15,
  grace_minutes         integer NOT NULL DEFAULT 5,
  holiday_scope         holiday_scope NOT NULL DEFAULT 'none',
  valid_from            timestamptz NOT NULL DEFAULT now(),
  valid_to              timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz,
  CONSTRAINT attendance_policy_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_policy_cutoff_check CHECK (cutoff_offset_minutes <= 0),
  CONSTRAINT attendance_policy_grace_check  CHECK (grace_minutes >= 0),
  CONSTRAINT attendance_policy_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT attendance_policy_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX attendance_policy_org_idx  ON attendance_policy (org_id);
CREATE INDEX attendance_policy_org_team_idx ON attendance_policy (org_id, team_id);

CREATE UNIQUE INDEX attendance_policy_current_key
  ON attendance_policy (org_id, team_id, name)
  WHERE valid_to IS NULL;

CREATE TABLE session (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  team_id                uuid NOT NULL,
  kind                   session_kind NOT NULL DEFAULT 'practice',
  title                  varchar(200) NOT NULL,
  status                 session_status NOT NULL DEFAULT 'planned',
  starts_at              timestamptz NOT NULL,
  ends_at                timestamptz NOT NULL,
  attendance_policy_id   uuid,
  location               varchar(160),
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz,
  CONSTRAINT session_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT session_attendance_policy_fk
    FOREIGN KEY (org_id, attendance_policy_id)
    REFERENCES attendance_policy (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT session_window_check CHECK (ends_at > starts_at),
  CONSTRAINT session_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX session_org_idx       ON session (org_id);
CREATE INDEX session_org_team_idx  ON session (org_id, team_id);
CREATE INDEX session_org_start_idx ON session (org_id, starts_at);

CREATE TABLE session_template (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  team_id           uuid NOT NULL,
  name              varchar(160) NOT NULL,
  kind              session_kind NOT NULL DEFAULT 'practice',
  duration_minutes  integer NOT NULL,
  -- Minutes past midnight, not a `time` column: the template is a weekly pattern in
  -- the team's own timezone, so a wall-clock type would imply an offset that does not
  -- exist.
  start_minute_of_day integer NOT NULL,
  valid_from        timestamptz NOT NULL DEFAULT now(),
  valid_to          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  CONSTRAINT session_template_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT session_template_duration_check CHECK (duration_minutes > 0),
  CONSTRAINT session_template_start_minute_check
    CHECK (start_minute_of_day >= 0 AND start_minute_of_day < 1440),
  CONSTRAINT session_template_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT session_template_org_name_key UNIQUE (org_id, team_id, name),
  CONSTRAINT session_template_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX session_template_org_idx      ON session_template (org_id);
CREATE INDEX session_template_org_team_idx ON session_template (org_id, team_id);

CREATE TABLE attendance_record (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  session_id      uuid NOT NULL,
  person_id       uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  status          attendance_status NOT NULL,
  method          attendance_record_method NOT NULL DEFAULT 'self_reported',
  checked_in_at   timestamptz,
  minutes_late    integer,
  note            text,
  recorded_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CONSTRAINT attendance_record_session_fk
    FOREIGN KEY (org_id, session_id) REFERENCES session (org_id, id) ON DELETE CASCADE,
  CONSTRAINT attendance_record_minutes_late_check
    CHECK (minutes_late IS NULL OR minutes_late >= 0),
  -- 'late' is the only status that can carry a lateness figure. Allowing minutes_late
  -- on an 'absent' row is how an attendance report starts lying.
  CONSTRAINT attendance_record_late_only_check
    CHECK ((status = 'late') = (minutes_late IS NOT NULL)),
  -- The legacy system had no attendance entity, so counts were inflated by duplicates
  -- from re-scans and re-submissions. Here a second row for the same person at the
  -- same session is not rejected by application code, it is not storable.
  CONSTRAINT attendance_record_org_session_person_key UNIQUE (org_id, session_id, person_id),
  CONSTRAINT attendance_record_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX attendance_record_org_idx        ON attendance_record (org_id);
CREATE INDEX attendance_record_org_session_idx ON attendance_record (org_id, session_id);
CREATE INDEX attendance_record_org_person_idx  ON attendance_record (org_id, person_id);

-- -----------------------------------------------------------------------------
-- CAPACITY ENFORCEMENT
--
-- One function, one trigger. The decrement is atomic because the parent row is locked
-- with FOR UPDATE before the count is read, so two concurrent registrations against
-- the last remaining place serialise instead of both observing "one place left".
--
-- SECURITY DEFINER is required and is the reason this is a function at all: the
-- application role is not granted UPDATE on competition_division (see the grants
-- below), so without elevation the counter could not be maintained and the correct
-- alternative would be to grant the app the right to inflate capacity directly.
--
-- Every table reference is schema-qualified because search_path is pinned to empty.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reserve_competition_division_place()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_capacity integer;
  v_taken    integer;
BEGIN
  SELECT cd.capacity, cd.registered_count
    INTO v_capacity, v_taken
    FROM public.competition_division cd
   WHERE cd.org_id = NEW.org_id
     AND cd.id = NEW.competition_division_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'competition division % does not exist in organisation %',
      NEW.competition_division_id, NEW.org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_taken >= v_capacity THEN
    RAISE EXCEPTION 'competition division % is full (capacity %, already registered %)',
      NEW.competition_division_id, v_capacity, v_taken
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.competition_division
     SET registered_count = registered_count + 1
   WHERE org_id = NEW.org_id
     AND id = NEW.competition_division_id;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION reserve_competition_division_place() IS
  'Takes an atomic place in a competition division. Runs as the table owner because '
  'the application role is denied UPDATE on competition_division.';

-- Releasing a place. A withdrawn or cancelled registration must give its place back,
-- otherwise a single withdrawal silently costs the org a seat.
CREATE OR REPLACE FUNCTION release_competition_division_place()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.status NOT IN ('withdrawn', 'cancelled')
     AND NEW.status IN ('withdrawn', 'cancelled') THEN
    UPDATE public.competition_division
       SET registered_count = GREATEST(registered_count - 1, 0)
     WHERE org_id = NEW.org_id
       AND id = NEW.competition_division_id;
  END IF;

  RETURN NULL;
END
$$;

CREATE TRIGGER registration_reserve_place
  BEFORE INSERT ON registration
  FOR EACH ROW EXECUTE FUNCTION reserve_competition_division_place();

CREATE TRIGGER registration_release_place
  AFTER UPDATE ON registration
  FOR EACH ROW EXECUTE FUNCTION release_competition_division_place();

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- Enabled AND forced, so the owner is subject to the policy too. The tenant predicate
-- is the whole policy and has no IS NULL escape: an unset tenant context makes
-- `org_id = current_org_id()` evaluate to NULL, which is not TRUE, which hides every
-- row. That is failing closed, and it is the property ADR-0015 exists to guarantee.
--
-- Contrast with 0001's audit_log and outbox_event, which deliberately allow org_id IS
-- NULL because a system actor writes there. Nothing in competitive operations has
-- that exemption, so nothing here gets it.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  competitive_tables text[] := ARRAY[
    'game','title','season','division','team','team_membership','team_staff',
    'competition','competition_division','registration','entry_cost',
    'opponent','match','match_map','match_result','prize_pool',
    'attendance_policy','session','session_template','attendance_record'
  ];
BEGIN
  FOREACH t IN ARRAY competitive_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- PRIVILEGES
--
-- raptor_app gets ordinary DML on the competitive tables. It does NOT get UPDATE or
-- DELETE on competition_division: capacity is owned by the trigger, and a role that
-- can raise a division's capacity can also oversell one with a single statement.
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO raptor_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  game, title, season, division, team, team_membership, team_staff,
  competition, competition_division, registration, entry_cost,
  opponent, match, match_map, match_result, prize_pool,
  attendance_policy, session, session_template, attendance_record
TO raptor_app;

REVOKE UPDATE, DELETE ON competition_division FROM raptor_app;

REVOKE ALL ON FUNCTION reserve_competition_division_place() FROM PUBLIC;
REVOKE ALL ON FUNCTION release_competition_division_place() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_competition_division_place() TO raptor_app;
GRANT EXECUTE ON FUNCTION release_competition_division_place() TO raptor_app;

-- RLS is worthless to a role that can switch it off.
-- Reassert the application role attributes. Portable across self-hosted and managed databases: enforces where the owner is a superuser, verifies otherwise (see ensure_raptor_app_hardened() in 0001_tenancy.sql).
SELECT ensure_raptor_app_hardened();

-- ==========================================================================
-- SOURCE: packages/db/migrations/0003_registration_place_invariant.sql
-- ==========================================================================

-- =============================================================================
-- packages/db/migrations/0003_registration_place_invariant.sql
--
-- A CORRECTION to 0002_competitive.sql, written as a new file on purpose.
--
-- `migrations.ts` refuses to re-apply a migration whose checksum has changed, and
-- the repository rule is stricter than the checker's tolerance: an applied migration
-- is never edited, because a database that already recorded 0002 would then be
-- permanently unable to reach the corrected state. Everything this file corrects is
-- therefore restated in full rather than patched in place.
--
-- WHAT WAS WRONG
-- --------------
-- 0002 maintained `competition_division.registered_count` with two triggers that
-- disagreed about what a "place" is:
--
--   * `registration_reserve_place` — BEFORE INSERT, UNCONDITIONAL. It took a place
--     for every registration, including rows inserted as 'waitlisted', 'withdrawn'
--     or 'cancelled' — entries that were never granted a place at all. A division of
--     capacity 1 that held one waitlisted entry reported itself full and refused the
--     one team it had room for.
--
--   * `registration_release_place` — AFTER UPDATE, and only when the status moved
--     INTO 'withdrawn' or 'cancelled'. It had no counterpart for the reverse move.
--     So this pair of statements, both of them perfectly legal:
--
--         UPDATE registration SET status = 'withdrawn' WHERE ...;   -- place returned
--         UPDATE registration SET status = 'confirmed' WHERE ...;   -- place NOT retaken
--
--     leaves THREE confirmed entries sitting in a division of capacity two while
--     registered_count still reads two. The counter is accurate and the division is
--     oversold, which is strictly worse than a wrong counter: nothing in the schema
--     contradicts it, `competition_division_not_oversold_check` still holds, and every
--     report built on the counter is quietly right about the wrong thing.
--
--   This is the legacy defect restated in new tables. The legacy `slot` row could be
--   counted as a purchase, an entry or a result depending on which query read it;
--   here a registration's claim on a place depends on its status history rather than
--   on its status, and the two are allowed to disagree.
--
-- WHAT REPLACES IT
-- ----------------
-- One predicate — "this registration holds a place" — and ONE trigger that fires on
-- INSERT and on any UPDATE that could change the answer, moving the counter only when
-- the predicate flips. There is no direction left unhandled, because neither the
-- trigger nor any future caller has to decide which of several transitions exist.
--
--     holds_a_place := status IN ('pending', 'confirmed')
--
-- 'waitlisted' is the reason the predicate is explicit rather than a negation. A
-- waitlisted entry exists precisely because no place was available; giving it one by
-- omission would reintroduce the bug in the other direction, so the statuses that DO
-- hold a place are named, and a status added to the enum later holds nothing until
-- somebody decides otherwise in this file.
--
-- WHY THE COUNTER IS STILL MAINTAINED AND NOT DERIVED
-- ---------------------------------------------------
-- A view, or a correlated count of live registrations, would remove the possibility of
-- drift entirely, and that is the better design. It is not used here because the
-- read path is the hot path — every bracket render, every seed, every standings query —
-- and a `COUNT` over registrations per division per read is a different performance
-- story. The invariant is instead closed from the other end: the CHECK constraint from
-- 0002 makes an oversold counter unstorable even if this trigger is disabled, and the
-- two guards fail in different directions (this one refuses a registration, the CHECK
-- refuses a corrupt counter), so neither can mask the other.
--
-- ATOMICITY
-- ---------
-- `take_competition_division_place` reads the counter under `SELECT ... FOR UPDATE` on
-- the parent row, so a second registration blocks there until the first has committed
-- and then reads the committed count. That is what makes check-then-increment safe;
-- without the lock two contenders would both observe the last free place.
--
-- This cannot be exercised as a true race on PGlite, which is a single in-process
-- session and therefore serialises every statement. The deterministic form of the same
-- guarantee — two contenders, one place, exactly one winner — is asserted in
-- `src/competitive.isolation.test.ts`. The interleaving itself belongs in CI against a
-- real multi-connection PostgreSQL, which ADR-0015 records as unavailable locally.
--
-- WHY NOTHING IS GRANTED, AND WHY PUBLIC MUST BE REVOKED
-- --------------------------------------------------------
-- PostgreSQL makes every new function EXECUTABLE by PUBLIC. That default is not
-- neutral here: `take_competition_division_place` is SECURITY DEFINER and moves
-- registered_count, so a PUBLIC grant is a door into the counter that does not go
-- through writing a registration. 0002 granted EXECUTE on its two capacity functions
-- to raptor_app outright, which was the same door with a nicer address; dropping
-- those functions removes that grant with them.
--
-- Trigger functions are not privilege-checked when a trigger fires, so revoking
-- changes nothing about the guard working — the elevation happens inside the trigger,
-- where current_user is already the owner. `src/competitive.isolation.test.ts` proves
-- both halves: the ACL no longer names PUBLIC, and an explicit call from the
-- application role is still refused.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- The single source of truth for "does this row hold a place".
--
-- Named rather than inlined because the trigger's UPDATE branch has to compare the
-- answer for OLD against the answer for NEW, and two hand-written copies of the list
-- would drift exactly the way 0002's two triggers did.
--
-- p_status::text rather than `p_status IN (...)`: with `search_path` pinned to empty
-- the enum label would have to be schema-qualified inside the body, and the cast is
-- both cheaper and independent of where the type lives.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.registration_holds_place(p_status public.registration_status)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_status::text IN ('pending', 'confirmed')
$$;

COMMENT ON FUNCTION public.registration_holds_place(public.registration_status) IS
  'A registration holds a competition_division place only in these statuses. Everything else — including any status added to the enum later — holds none.';

-- -----------------------------------------------------------------------------
-- Taking a place. Raises foreign_key_violation for BOTH refusals.
--
-- Deliberately not `check_violation`. `23514` is what
-- `competition_division_not_oversold_check` raises when the stored counter is corrupt,
-- and about a dozen other CHECK constraints in this schema use it too. Reporting 23514
-- for a full division would make "you tried to sell past capacity" indistinguishable
-- from "somebody corrupted a counter", and only one of those is a data-integrity fault
-- worth waking somebody for; the other is an ordinary business condition a caller turns
-- into a 409.
--
-- One code for both refusals is also the honest reading: a division that does not exist
-- and a division that is full are the same failure from the caller's side, which is that
-- the division this registration references cannot satisfy the reference.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.take_competition_division_place(p_org_id uuid, p_division_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_capacity integer;
  v_taken    integer;
BEGIN
  -- FOR UPDATE is the whole atomicity argument: the row lock is taken before the
  -- count is read, so a concurrent registration of the last place blocks here and then
  -- observes the committed increment rather than the stale value.
  SELECT cd.capacity, cd.registered_count
    INTO v_capacity, v_taken
    FROM public.competition_division cd
   WHERE cd.org_id = p_org_id
     AND cd.id = p_division_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'competition division % does not exist in organisation %',
      p_division_id, p_org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_taken >= v_capacity THEN
    RAISE EXCEPTION 'competition division % is full (capacity %, already registered %)',
      p_division_id, v_capacity, v_taken
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Relative increment, never a value computed from the snapshot above: even if the
  -- read were stale the row would still be moved by exactly one.
  UPDATE public.competition_division
     SET registered_count = registered_count + 1
   WHERE org_id = p_org_id
     AND id = p_division_id;
END
$$;

COMMENT ON FUNCTION public.take_competition_division_place(uuid, uuid) IS
  'Takes one place in a competition division under a row lock. Raises foreign_key_violation when the division is absent or full.';

-- -----------------------------------------------------------------------------
-- Returning a place.
--
-- GREATEST(..., 0) is not defensive coding, it is the acknowledgement that the CHECK
-- `registered_count >= 0` is a separate guard: if this were ever called more times
-- than places were taken, the failure should be a refused decrement rather than a
-- negative counter that trips a constraint and reports the wrong fault.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.give_back_competition_division_place(p_org_id uuid, p_division_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.competition_division
     SET registered_count = GREATEST(registered_count - 1, 0)
   WHERE org_id = p_org_id
     AND id = p_division_id;
END
$$;

COMMENT ON FUNCTION public.give_back_competition_division_place(uuid, uuid) IS
  'Returns one place in a competition division. Never below zero.';

-- -----------------------------------------------------------------------------
-- The one trigger that maintains the counter.
--
-- BEFORE, so the counter is moved in the same statement as the registration. A later
-- failure in that statement — a composite FK, a CHECK — rolls the increment back with
-- it, because statement atomicity covers trigger side effects. That is what lets this
-- live before the row rather than after it without risking a counter that counts rows
-- which were never written.
--
-- `OF status, competition_division_id` rather than a bare UPDATE: touching a seed
-- number or an archived_at must not move the counter, and the column list is what
-- keeps a routine no-op UPDATE from re-deciding the question on every write.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sync_competition_division_place()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_held_old boolean;
  v_held_new boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public.registration_holds_place(NEW.status) THEN
      PERFORM public.take_competition_division_place(NEW.org_id, NEW.competition_division_id);
    END IF;
    RETURN NEW;
  END IF;

  v_held_old := public.registration_holds_place(OLD.status);
  v_held_new := public.registration_holds_place(NEW.status);

  -- A transfer between divisions is handled as a return followed by a take, and in
  -- that order so a transfer out of a division always frees the place before
  -- anything can try to claim it. The destination may legitimately be full, in which
  -- case the whole statement is refused and the transfer does not happen.
  IF OLD.competition_division_id IS DISTINCT FROM NEW.competition_division_id THEN
    IF v_held_old THEN
      PERFORM public.give_back_competition_division_place(OLD.org_id, OLD.competition_division_id);
    END IF;
    IF v_held_new THEN
      PERFORM public.take_competition_division_place(NEW.org_id, NEW.competition_division_id);
    END IF;
  ELSIF v_held_old AND NOT v_held_new THEN
    PERFORM public.give_back_competition_division_place(OLD.org_id, OLD.competition_division_id);
  ELSIF NOT v_held_old AND v_held_new THEN
    PERFORM public.take_competition_division_place(NEW.org_id, NEW.competition_division_id);
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.sync_competition_division_place() IS
  'Keeps competition_division.registered_count equal to the number of registrations that hold a place. Covers every transition in both directions.';

-- -----------------------------------------------------------------------------
-- Take the privilege back.
--
-- SECURITY DEFINER and REVOKE FROM PUBLIC together are the pattern, not either
-- alone: the elevation is what lets the counter be maintained at all, and the
-- revoke is what stops the elevation from being callable on its own. The counter
-- is maintained by triggers, so no grant to raptor_app follows — a role that can
-- register a team should not also be able to move the count without one.
--
-- Applied after the functions exist and before the trigger that uses them, and
-- idempotently, so a re-run converges rather than aborting.
-- -----------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.registration_holds_place(public.registration_status) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.take_competition_division_place(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.give_back_competition_division_place(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_competition_division_place() FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Retire 0002's pair.
--
-- Triggers are dropped before the functions because a trigger is a dependency of its
-- function; dropping the function first fails with 2BP01 and would leave the schema
-- half-migrated. Both old functions go entirely rather than being left unreferenced —
-- a SECURITY DEFINER function that nothing calls but that still compiles is a thing a
-- future caller can reach.
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS registration_reserve_place ON registration;
DROP TRIGGER IF EXISTS registration_release_place ON registration;

DROP FUNCTION IF EXISTS public.reserve_competition_division_place();
DROP FUNCTION IF EXISTS public.release_competition_division_place();

CREATE TRIGGER registration_sync_place
  BEFORE INSERT OR UPDATE OF status, competition_division_id ON registration
  FOR EACH ROW EXECUTE FUNCTION public.sync_competition_division_place();

COMMIT;

-- ==========================================================================
-- SOURCE: packages/db/migrations/0004_money.sql
-- ==========================================================================

/**
 * Money: the ledger, prize-pool lifecycle, allocation replay, budgets, expenses.
 *
 * WHAT THIS MIGRATION IS FOR
 * --------------------------
 * The design spec's Phase 3 gate is one sentence — "Allocation reproducible from
 * stored inputs; reconciliation invariant holds under fuzz" — and both halves of it
 * are properties of the STORAGE, not of the application. The pure engine in
 * packages/core/src/prize can be perfectly deterministic and an allocation still
 * become unreproducible, because recomputing it tomorrow reads
 * `team_membership.share_percent` as it stands tomorrow. Roster corrections are
 * ordinary events. A player who disputes a payout in March needs the answer to be
 * the one the database decided in November.
 *
 * So an allocation is not a live join. It is a FROZEN INPUT SNAPSHOT plus the OUTPUT
 * ROWS derived from it, plus content hashes over both. Re-running is a matter of
 * reading rows that cannot change, not of re-querying a mutable roster.
 *
 * THE HASHES ARE NOT A BACKUP OF A CLAIM — THEY ARE ENFORCED
 * --------------------------------------------------------
 * `input_hash` is the value packages/core/src/prize/allocation-engine.ts already
 * emits, and the database RECOMPUTES it from the stored snapshot and refuses the row
 * if the two disagree. Alignment is therefore not a convention this migration hopes
 * for: it is a constraint, and a snapshot shape that drifts from the engine's
 * canonical form fails loudly at INSERT.
 *
 * `snapshot_hash` and `output_hash` are computed by this database over the frozen
 * input rows and the result rows respectively. Nothing upstream emits them, so they
 * are defined here, in a length-framed canonical text, and the framing is injective
 * (the free-text explanation is length-prefixed) so two different row sets cannot
 * hash alike.
 *
 * WHY BALANCE IS A DEFERRED CONSTRAINT TRIGGER
 * --------------------------------------------
 * A journal is only balanced once its lines exist, so the check cannot be a CHECK on
 * the header. It is a DEFERRABLE INITIALLY DEFERRED constraint trigger on both
 * journal and line: it runs at COMMIT, by which time the whole entry is visible, and
 * application code is not in the position to assert its own correctness. An unbalanced
 * journal is rejected by the database with the same SQLSTATE as a corrupt counter,
 * because that is precisely what it would be.
 *
 * WHY NO archived_at ON THE APPEND-ONLY MONEY TABLES
 * --------------------------------------------------
 * The house rule is "archive columns, no hard deletes", and the money rule is
 * "append-only, no UPDATE path". For a table where no UPDATE is permitted at all the
 * two collide: an archive column can only ever be set by an UPDATE, so on these tables
 * it would be a column permanently constrained to NULL, which is a lie in the schema.
 *
 * Chosen: the strictly-append-only money tables carry no archive column, and a
 * mistake is corrected by a reversing entry — a new journal that debits what the
 * previous one credited. The money keeps its meaning (the books still add up, and the
 * error is visible as a reversal rather than hidden by an archive flag), which is what
 * the archive column exists to achieve in the first place.
 *
 * Rejected: keeping `archived_at` and permitting a narrow UPDATE that sets only it.
 * It re-opens an UPDATE path on money, and an UPDATE grant scoped to "only that one
 * column, honestly" is a promise about future code rather than a property of the
 * database. `prize_pool` is the deliberate contrast: it is mutable exactly once, to
 * record a settle, and so it keeps its archive column (see 0005).
 *
 * TENANCY
 * -------
 * Identical to 0001/0002 and not restated per table: org_id NOT NULL, UNIQUE
 * (org_id, id), every composite index leading with org_id, every FK between tenant
 * tables composite and including org_id, RLS ENABLED *and* FORCED with the tenant
 * predicate as the whole policy and no IS NULL escape (ADR-0015).
 */

BEGIN;

-- -----------------------------------------------------------------------------
-- Enumerations
-- -----------------------------------------------------------------------------

-- Mirrors ParticipantKind in the engine. A coach is never a roster member, and a
-- snapshot that blurred the two would award a prize for something that never happened.
CREATE TYPE prize_participant_kind AS ENUM ('roster', 'staff');

-- Mirrors AllocationBasis. Pinned here so a stored snapshot is readable without
-- consulting a running deployment of the application.
CREATE TYPE allocation_basis AS ENUM (
  'percentage', 'per_head', 'fixed_plus_percentage', 'weighted_by_participation'
);

-- Mirrors ParticipantKind's counterpart on the ledger side: what KIND of thing an
-- account is, which is what makes a debit to it a cost rather than an asset purchase.
CREATE TYPE ledger_account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

-- Why the entry exists. The audit's recurring finding was facts with no indication of
-- where they came from, so an OCR row and a hand-typed row stayed indistinguishable
-- forever; the same argument applies to money entries.
CREATE TYPE journal_source_kind AS ENUM (
  'expense', 'settlement', 'prize_payout', 'adjustment', 'opening'
);



-- Where an expense came from. The legacy `slot_expenses` table could not answer this,
-- which is how a registration cost and a hand-typed claim for the same event became
-- one indistinguishable sum.
CREATE TYPE expense_provenance AS ENUM ('registration_entry_cost', 'manual');

-- The rule's per-person terms. One table rather than three because the engine treats
-- percentages, fixed amounts and pool percentages as the same kind of fact — a
-- person, a number — that belongs to one versioned rule, and three tables would let
-- them drift out of step with each other inside a single frozen snapshot.
CREATE TYPE allocation_term_role AS ENUM ('percentage', 'fixed_amount', 'pool_percentage');

-- -----------------------------------------------------------------------------
-- CHART OF ACCOUNTS
--
-- A ledger without accounts is a list of signed numbers. `account_type` is not
-- labelling: the budget guard below sums debits to EXPENSE accounts and nothing else,
-- so an expense recorded against a liability account does not silently consume an
-- operating budget.
-- -----------------------------------------------------------------------------

CREATE TABLE ledger_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  code          varchar(32) NOT NULL,
  name          varchar(160) NOT NULL,
  account_type  ledger_account_type NOT NULL,
  currency      varchar(3) NOT NULL,
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_account_code_check CHECK (code ~ '^[0-9]{3,8}$'),
  CONSTRAINT ledger_account_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ledger_account_org_code_key UNIQUE (org_id, code),
  CONSTRAINT ledger_account_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX ledger_account_org_idx   ON ledger_account (org_id);
CREATE INDEX ledger_account_org_type_idx ON ledger_account (org_id, account_type);

-- -----------------------------------------------------------------------------
-- JOURNAL HEADER AND LINES
--
-- Double entry. Every line carries its own org_id and a COMPOSITE FK to its journal,
-- so a line cannot be filed under another tenant's entry (ADR-0011).
--
-- Lines are stored as (side, amount) rather than signed amounts. A signed column
-- invites a row where both the sign and the side disagree, and 'is this a debit?' is
-- exactly the question a CHECK should answer.
-- -----------------------------------------------------------------------------

CREATE TABLE ledger_journal (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  description       text NOT NULL,
  source_kind       journal_source_kind NOT NULL DEFAULT 'expense',
  -- The accounting period this entry belongs to. A DATE, not timestamptz: a period is
  -- a calendar fact ("March"), not an instant, and pretending otherwise would let an
  -- entry land in two periods depending on the reader's timezone.
  posting_period    date NOT NULL,
  -- The cost centre this entry belongs to, for budget scoping. Nullable because an
  -- org-wide entry has no single cost centre.
  cost_centre_team_id uuid,
  currency          varchar(3) NOT NULL,
  -- A reversing entry points at what it reverses. Reversal is how a mistake is undone;
  -- editing the original would destroy the evidence that the mistake ever happened.
  reverses_id       uuid,
  external_ref      varchar(120),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_journal_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ledger_journal_cost_centre_fk
    FOREIGN KEY (org_id, cost_centre_team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT ledger_journal_reverses_fk
    FOREIGN KEY (org_id, reverses_id) REFERENCES ledger_journal (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT ledger_journal_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX ledger_journal_org_idx        ON ledger_journal (org_id);
CREATE INDEX ledger_journal_org_period_idx  ON ledger_journal (org_id, posting_period);
CREATE INDEX ledger_journal_org_centre_idx  ON ledger_journal (org_id, cost_centre_team_id);

-- One reversing entry per entry. A branch — two corrections claiming the same parent —
-- is how a journal ends up reversed twice in opposite directions.
CREATE UNIQUE INDEX ledger_journal_reverses_key
  ON ledger_journal (org_id, reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TYPE ledger_line_side AS ENUM ('debit', 'credit');

CREATE TABLE ledger_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  journal_id    uuid NOT NULL,
  line_no       integer NOT NULL,
  account_id    uuid NOT NULL,
  side          ledger_line_side NOT NULL,
  amount        numeric(18,4) NOT NULL,
  currency      varchar(3) NOT NULL,
  memo          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_line_journal_fk
    FOREIGN KEY (org_id, journal_id) REFERENCES ledger_journal (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT ledger_line_account_fk
    FOREIGN KEY (org_id, account_id) REFERENCES ledger_account (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT ledger_line_no_check CHECK (line_no >= 1),
  -- Strictly positive. A zero line is a comment wearing a costume, and a negative
  -- amount is a direction, which `side` already carries — admitting both lets one row
  -- state two contradictory things about direction at once.
  CONSTRAINT ledger_line_amount_check CHECK (amount > 0),
  CONSTRAINT ledger_line_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ledger_line_org_journal_no_key UNIQUE (org_id, journal_id, line_no),
  CONSTRAINT ledger_line_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX ledger_line_org_idx       ON ledger_line (org_id);
CREATE INDEX ledger_line_org_journal_idx ON ledger_line (org_id, journal_id);
CREATE INDEX ledger_line_org_account_idx ON ledger_line (org_id, account_id);

-- Two lines share a line number inside one journal? The ledger could not be read back
-- in order, so the constraint is about legibility rather than about double-counting.

-- -----------------------------------------------------------------------------
-- THE BALANCE GUARD
--
-- Raised from a trigger, so it fires for every writer: the application's posting
-- path, a migration, an operator with psql. Money cannot be created or destroyed by
-- writing an entry whose debits and credits differ.
--
-- Three conditions, and all three are needed:
--   * at least two lines — a header with no lines is a journal that claims nothing and
--     was never finished;
--   * debits equal credits;
--   * every line carries the journal's currency — otherwise a journal can balance
--     across two currencies, which is a conversion performed by nobody, at no rate,
--     with no record.
--
-- RAISES check_violation, deliberately. An unbalanced journal is a corrupt entry, and
-- check_violation is what every other integrity violation in this schema reports, so a
-- monitoring rule on 23514 catches it without a special case.
--
-- INVOKER security, not SECURITY DEFINER: the guard needs no elevation, because the
-- application role can read the lines it just wrote and the policy limits it to the
-- tenant already fixed by WITH CHECK on the header. A definer function here would be a
 -- door around that policy for no benefit.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_journal_balanced()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_journal_id uuid;
  v_journal_currency varchar(3);
  v_debits    numeric;
  v_credits   numeric;
  v_lines     integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_journal' THEN
    v_journal_id := NEW.id;
  ELSE
    v_journal_id := NEW.journal_id;
  END IF;

  SELECT j.currency INTO v_journal_currency
    FROM public.ledger_journal j WHERE j.id = v_journal_id;

  SELECT COALESCE(sum(l.amount) FILTER (WHERE l.side = 'debit'), 0),
         COALESCE(sum(l.amount) FILTER (WHERE l.side = 'credit'), 0),
         count(*)
    INTO v_debits, v_credits, v_lines
    FROM public.ledger_line l
   WHERE l.journal_id = v_journal_id;

  IF v_lines < 2 THEN
    RAISE EXCEPTION 'journal % has % line(s); a double-entry journal needs at least two',
      v_journal_id, v_lines
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'journal % is unbalanced: debits % <> credits %',
      v_journal_id, v_debits, v_credits
      USING ERRCODE = 'check_violation';
  END IF;

  -- One comparison rather than a distinct-count plus a second EXISTS: a line in the
  -- wrong currency is the whole failure, and IS DISTINCT FROM also catches a NULL.
  IF EXISTS (
    SELECT 1 FROM public.ledger_line l
     WHERE l.journal_id = v_journal_id
       AND l.currency IS DISTINCT FROM v_journal_currency
  ) THEN
    RAISE EXCEPTION
      'journal % is in % but carries a line in another currency', v_journal_id, v_journal_currency
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_journal_balanced() IS
  'Refuses a journal whose debits and credits differ, that has fewer than two lines, or whose lines are not all in the journal currency.';

CREATE CONSTRAINT TRIGGER ledger_journal_must_balance
  AFTER INSERT ON ledger_journal
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_journal_balanced();

CREATE CONSTRAINT TRIGGER ledger_line_must_balance
  AFTER INSERT ON ledger_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_journal_balanced();

-- -----------------------------------------------------------------------------
-- APPEND-ONLY
--
-- Two independent mechanisms, deliberately redundant and failing in opposite
-- directions. REVOKE denies the application role the operation; the trigger denies it
-- to everyone, including the schema owner running a migration by hand. Either alone
-- leaves a path: a privilege grant silently widened later, or an operator with psql.
--
-- ERRCODE insufficient_privilege so both refusals carry the same SQLSTATE. A caller
-- sees "you may not do this" either way, which is the truth.
--
-- NO archived_at on these tables. See the header: a column settable only by an UPDATE
-- is on an append-only table a column permanently NULL.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.deny_money_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted on posted money rows',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

COMMENT ON FUNCTION public.deny_money_mutation() IS
  'Blocks UPDATE and DELETE on a posted money table. Reversal is a new entry, never an edit.';

CREATE TRIGGER ledger_journal_append_only
  BEFORE UPDATE OR DELETE ON ledger_journal
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

CREATE TRIGGER ledger_line_append_only
  BEFORE UPDATE OR DELETE ON ledger_line
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

CREATE TRIGGER ledger_account_append_only
  BEFORE UPDATE OR DELETE ON ledger_account
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

-- -----------------------------------------------------------------------------
-- BUDGET
--
-- A period-scoped envelope: an amount, a cost centre (or the whole org), and a window.
--
-- WHAT IS STORED AND WHY
-- ---------------------
-- Stored: limit_amount. Nothing else.
--
-- NOT stored: committed, spent, remaining.
--
-- The legacy slot system kept a stored counter that a trigger maintained, and the
-- counter drifted away from the ledger it claimed to summarise — which is how a
-- budget stops meaning anything while still being displayed. Every derivable number
-- here is therefore derived, in the `budget_balance` view, from the ledger itself. The
-- guard below reads the same expression, so the number the guard enforces and the
-- number a screen shows are the same number by construction, and there is no counter
-- left to drift.
--
-- committed: net debits to EXPENSE accounts in the envelope. A reversal, being a
--   credit, reduces it.
-- spent:    net debits to EXPENSE accounts posted by SETTLEMENT journals. A cost is
--   committed when it is recognised and spent when it is discharged; conflating the
--   two is how a budget looks 80% consumed on the day it is written.
-- remaining: limit_amount - committed. Deliberately against committed, not spent: a
--   budget is consumed by the decision to spend, not by when the cash moves. Spending
--   against `spent` would let an organisation commit its entire year in the last
--   month of it.
-- -----------------------------------------------------------------------------

CREATE TABLE budget (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name              varchar(160) NOT NULL,
  -- NULL = organisation-wide. The composite FK still makes a cross-org team reference
  -- impossible when it is set.
  scope_team_id     uuid,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  currency          varchar(3) NOT NULL,
  limit_amount      numeric(18,4) NOT NULL,
  -- Append-only like the rest of the money domain, so a limit is amended by a new
  -- version rather than by an UPDATE. Otherwise the limit that applied when an expense
  -- was posted becomes unanswerable, which is the same loss of history this migration
  -- exists to prevent.
  version           integer NOT NULL DEFAULT 1,
  supersedes_id     uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_scope_team_fk
    FOREIGN KEY (org_id, scope_team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT budget_supersedes_fk
    FOREIGN KEY (org_id, supersedes_id) REFERENCES budget (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT budget_period_check CHECK (period_end >= period_start),
  CONSTRAINT budget_limit_check CHECK (limit_amount > 0),
  CONSTRAINT budget_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT budget_version_check CHECK (version >= 1),
  CONSTRAINT budget_org_name_period_version_key UNIQUE (org_id, scope_team_id, period_start, version),
  CONSTRAINT budget_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX budget_org_idx       ON budget (org_id);
CREATE INDEX budget_org_scope_idx ON budget (org_id, scope_team_id);
CREATE INDEX budget_org_period_idx ON budget (org_id, period_start, period_end);

-- The first version of an envelope has no parent, so this admits exactly one origin per
-- (org, scope, period) and forbids two envelopes racing to be the original.
CREATE UNIQUE INDEX budget_root_key
  ON budget (org_id, scope_team_id, period_start)
  WHERE supersedes_id IS NULL;

-- Each version has at most one successor, so the history is a path and not a tree.
CREATE UNIQUE INDEX budget_supersedes_key
  ON budget (org_id, supersedes_id) WHERE supersedes_id IS NOT NULL;

-- The one derived view. Every read of a budget goes through here, which is what makes
-- "derived, never stored" a property rather than an intention.
--
-- The aggregation sits in a LATERAL subquery rather than in the outer GROUP BY, so
-- the view returns exactly one row per budget however many entries fall inside it.
CREATE VIEW budget_balance AS
SELECT b.org_id,
       b.id              AS budget_id,
       b.name,
       b.scope_team_id,
       b.period_start,
       b.period_end,
       b.currency,
       b.version,
       b.limit_amount,
       x.committed::numeric(18,4) AS committed,
       x.spent::numeric(18,4)    AS spent,
       (b.limit_amount - x.committed)::numeric(18,4) AS remaining
  FROM budget b
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(l.amount) FILTER (WHERE j.source_kind <> 'settlement'), 0) AS committed,
           COALESCE(SUM(l.amount) FILTER (WHERE j.source_kind =  'settlement'), 0) AS spent
      FROM ledger_journal j
      JOIN ledger_line l
        ON l.org_id = j.org_id AND l.journal_id = j.id AND l.side = 'debit'
      JOIN ledger_account a
        ON a.org_id = l.org_id AND a.id = l.account_id AND a.account_type = 'expense'
     WHERE j.org_id = b.org_id
       AND j.posting_period >= b.period_start
       AND j.posting_period <= b.period_end
       AND j.currency = b.currency
       AND (b.scope_team_id IS NULL OR j.cost_centre_team_id = b.scope_team_id)
  ) x ON true;

COMMENT ON VIEW budget_balance IS
  'Derived budget position. committed and spent are computed from the ledger on every read; no counter is stored, so none can drift.';

-- -----------------------------------------------------------------------------
-- THE BUDGET CEILING
--
-- A stored counter could be exceeded by a drifted UPDATE. A derived number can only be
-- exceeded by posting more cost, so the guard is the only thing standing between an
-- over-budget entry and the books — which makes it worth writing in the database
-- rather than in a service that somebody can forget to call.
--
-- DEFERRABLE so that a batch of entries for one period is evaluated once, at COMMIT,
-- against the total. An IMMEDIATE trigger would check each entry alone and would either
-- reject a batch that fits or admit one that does not, depending on order.
--
-- The expression is the same one budget_balance computes, so the ceiling and the
-- display cannot disagree.
--
-- RAISES check_violation: exceeding a budget is a corrupt entry, like an unbalanced
-- journal, and belongs in the same alarm.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_budget_not_exceeded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_budget record;
  v_journal record;
BEGIN
  -- A line carries no period of its own; the journal it belongs to does. Resolving it
  -- here rather than in a second trigger is what lets one function serve both tables.
  IF TG_TABLE_NAME = 'ledger_journal' THEN
    v_journal := NEW;
  ELSE
    SELECT j.* INTO v_journal FROM public.ledger_journal j
     WHERE j.org_id = NEW.org_id AND j.id = NEW.journal_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
  END IF;

  -- Only envelopes this journal falls inside can be pushed over by it, so the scan is
  -- the three predicates that define the envelope rather than every budget in the org.
  FOR v_budget IN
    SELECT b.name, b.limit_amount, x.committed
      FROM public.budget b
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(l.amount) FILTER (WHERE j.source_kind <> 'settlement'), 0) AS committed
          FROM public.ledger_journal j
          JOIN public.ledger_line l
            ON l.org_id = j.org_id AND l.journal_id = j.id AND l.side = 'debit'
          JOIN public.ledger_account a
            ON a.org_id = l.org_id AND a.id = l.account_id AND a.account_type = 'expense'
         WHERE j.org_id = b.org_id
           AND j.posting_period >= b.period_start
           AND j.posting_period <= b.period_end
           AND b.currency = j.currency
           AND (b.scope_team_id IS NULL OR j.cost_centre_team_id = b.scope_team_id)
      ) x
     WHERE b.org_id = v_journal.org_id
       AND v_journal.posting_period >= b.period_start
       AND v_journal.posting_period <= b.period_end
       AND b.currency = v_journal.currency
       AND (b.scope_team_id IS NULL OR v_journal.cost_centre_team_id = b.scope_team_id)
       -- The same expression budget_balance computes, so the ceiling and the display
       -- cannot disagree about the same ledger.
       AND x.committed > b.limit_amount
  LOOP
    RAISE EXCEPTION
      'budget % would be exceeded: committed % against a limit of %',
      v_budget.name, v_budget.committed, v_budget.limit_amount
      USING ERRCODE = 'check_violation';
  END LOOP;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_budget_not_exceeded() IS
  'Refuses a commit that takes committed spend in any budget envelope above its limit. Evaluated at COMMIT against the ledger, not a counter.';

CREATE CONSTRAINT TRIGGER ledger_journal_must_fit_budget
  AFTER INSERT ON ledger_journal
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_budget_not_exceeded();

-- The same guard on the line, because lines can be appended to an existing journal in a
-- later transaction. Firing only on the header would let a second, unbalanced-by-budget
-- batch land under an envelope that has no room for it.
CREATE CONSTRAINT TRIGGER ledger_line_must_fit_budget
  AFTER INSERT ON ledger_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_budget_not_exceeded();

-- -----------------------------------------------------------------------------
-- EXPENSE
--
-- Replaces the legacy `slot_expenses` model.
--
-- THE LEGACY DOUBLE-COUNT, AND WHY IT CANNOT HAPPEN HERE
-- -------------------------------------------------------
-- A registration cost was recorded twice: once by an AFTER INSERT trigger that wrote
-- the expense row, and once by the API, which wrote its own. Both components believed
-- they owned the write, so every registration cost appeared at double its value in
-- every expense report, and neither component could be told which one to remove
-- without removing both.
--
-- The structural fix is not "be careful". It is that INSERT is not available to the
-- application role at all. The only writers are the two posting functions below,
-- each keyed to a fact that exists exactly once:
--
--   * post_registration_entry_expense — keyed on registration_id, which
--     UNIQUE (org_id, registration_id) makes single. A second call is refused by the
--     database; it does not need the caller to know it already happened.
--   * post_manual_expense — one row per call, and the caller is a human filing a claim.
--
-- Because there is no trigger on registration or entry_cost that writes an expense,
-- the "two components both write" shape is not merely discouraged — it has no second
-- component. This is asserted structurally, by reflecting over pg_trigger, so the
-- guarantee cannot rot when someone adds a convenient trigger later.
--
-- PROVENANCE
-- ----------
-- `provenance` and `registration_id` are bound by a CHECK, so the two cannot disagree.
-- A row claiming to be a registration cost without naming the registration is not
-- storable, and a registration cost row with no provenance is not either. Without that
-- binding the column is documentation; with it, it is a fact the database will not let
-- you get wrong.
-- -----------------------------------------------------------------------------

CREATE TABLE expense (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  description      text NOT NULL,
  amount           numeric(18,4) NOT NULL,
  currency         varchar(3) NOT NULL,
  incurred_on      date NOT NULL,
  provenance       expense_provenance NOT NULL,
  registration_id  uuid,
  -- Every expense is a posted entry. This is the "money is a ledger, never a column"
  -- rule as a constraint rather than a slogan: an expense that is not backed by a
  -- balanced journal cannot be written, so no cost exists that the ledger has never
  -- heard of.
  journal_id       uuid NOT NULL,
  recorded_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_registration_fk
    FOREIGN KEY (org_id, registration_id) REFERENCES registration (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT expense_journal_fk
    FOREIGN KEY (org_id, journal_id) REFERENCES ledger_journal (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT expense_amount_check CHECK (amount > 0),
  CONSTRAINT expense_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  -- Provenance is bound to the row it claims to come from, in both directions.
  CONSTRAINT expense_provenance_binding_check
    CHECK ((provenance = 'registration_entry_cost') = (registration_id IS NOT NULL)),
  -- One expense per journal. Two rows against one entry is the double-count with a
  -- different name.
  CONSTRAINT expense_org_journal_key UNIQUE (org_id, journal_id),
  -- One expense per registration cost, whatever else changes.
  CONSTRAINT expense_org_registration_key UNIQUE (org_id, registration_id),
  CONSTRAINT expense_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX expense_org_idx          ON expense (org_id);
CREATE INDEX expense_org_date_idx     ON expense (org_id, incurred_on);
CREATE INDEX expense_org_registration_idx ON expense (org_id, registration_id);
CREATE INDEX expense_org_provenance_idx  ON expense (org_id, provenance);

CREATE TRIGGER expense_append_only
  BEFORE UPDATE OR DELETE ON expense
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

-- -----------------------------------------------------------------------------
-- POSTING FUNCTIONS — the only writers of expense
--
-- The org is never a parameter. It comes from the session (ADR-0011 rule 3), so a
-- caller cannot choose which tenant the write lands in; an unset context yields NULL,
-- which is not a valid org_id, and the INSERT fails closed.
--
-- SECURITY DEFINER is required and is the reason these are functions at all: the
-- application role has no INSERT on expense, so without elevation there would be no
-- lawful way to record a cost — and the obvious alternative, granting INSERT back,
-- is the two-components defect in a different costume.
--
-- Every reference is schema-qualified because search_path is pinned to empty.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.post_registration_entry_expense(
  p_registration_id     uuid,
  p_incurred_on         date,
  p_debit_account_id    uuid,
  p_credit_account_id   uuid,
  p_description         text,
  p_cost_centre_team_id uuid DEFAULT NULL,
  p_recorded_by_person_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id     uuid := public.current_org_id();
  v_entry      record;
  v_journal_id uuid;
  v_expense_id uuid;
  v_amount     numeric(18,4);
BEGIN
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'no organisation in the session context; refusing to post an expense'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT ec.amount, ec.discount, ec.currency
    INTO v_entry
    FROM public.entry_cost ec
   WHERE ec.org_id = v_org_id
     AND ec.registration_id = p_registration_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no entry cost recorded for registration % in organisation %',
      p_registration_id, v_org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- The amount is DERIVED from the entry cost, not supplied. A caller who can choose
  -- the figure can choose a wrong figure, and the figure is the thing being audited.
  v_amount := v_entry.amount - v_entry.discount;

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'entry cost for registration % nets to %; there is no cost to post',
      p_registration_id, v_amount
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.ledger_journal
    (org_id, description, source_kind, posting_period, cost_centre_team_id, currency)
  VALUES
    (v_org_id, p_description, 'expense', p_incurred_on, p_cost_centre_team_id, v_entry.currency)
  RETURNING id INTO v_journal_id;

  INSERT INTO public.ledger_line (org_id, journal_id, line_no, account_id, side, amount, currency)
  VALUES
    (v_org_id, v_journal_id, 1, p_debit_account_id,  'debit', v_amount, v_entry.currency),
    (v_org_id, v_journal_id, 2, p_credit_account_id, 'credit', v_amount, v_entry.currency);

  INSERT INTO public.expense
    (org_id, description, amount, currency, incurred_on, provenance, registration_id,
     journal_id, recorded_by_person_id)
  VALUES
    (v_org_id, p_description, v_amount, v_entry.currency, p_incurred_on,
     'registration_entry_cost', p_registration_id, v_journal_id, p_recorded_by_person_id)
  RETURNING id INTO v_expense_id;

  RETURN v_expense_id;
END
$$;

COMMENT ON FUNCTION public.post_registration_entry_expense(uuid, date, uuid, uuid, text, uuid, uuid) IS
  'Records the entry cost of one registration as one expense and one balanced journal. The amount is derived from entry_cost, never supplied. A second call for the same registration is refused by UNIQUE (org_id, registration_id).';

CREATE OR REPLACE FUNCTION public.post_manual_expense(
  p_incurred_on         date,
  p_amount              numeric(18,4),
  p_currency            varchar(3),
  p_debit_account_id    uuid,
  p_credit_account_id   uuid,
  p_description         text,
  p_cost_centre_team_id uuid DEFAULT NULL,
  p_recorded_by_person_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id     uuid := public.current_org_id();
  v_journal_id uuid;
  v_expense_id uuid;
BEGIN
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'no organisation in the session context; refusing to post an expense'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'invalid currency %', p_currency USING ERRCODE = 'check_violation';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'expense amount must be positive, got %', p_amount
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.ledger_journal
    (org_id, description, source_kind, posting_period, cost_centre_team_id, currency)
  VALUES
    (v_org_id, p_description, 'expense', p_incurred_on, p_cost_centre_team_id, p_currency)
  RETURNING id INTO v_journal_id;

  INSERT INTO public.ledger_line (org_id, journal_id, line_no, account_id, side, amount, currency)
  VALUES
    (v_org_id, v_journal_id, 1, p_debit_account_id,  'debit',  p_amount, p_currency),
    (v_org_id, v_journal_id, 2, p_credit_account_id, 'credit', p_amount, p_currency);

  INSERT INTO public.expense
    (org_id, description, amount, currency, incurred_on, provenance, registration_id,
     journal_id, recorded_by_person_id)
  VALUES
    (v_org_id, p_description, p_amount, p_currency, p_incurred_on, 'manual', NULL,
     v_journal_id, p_recorded_by_person_id)
  RETURNING id INTO v_expense_id;

  RETURN v_expense_id;
END
$$;

COMMENT ON FUNCTION public.post_manual_expense(date, numeric, varchar, uuid, uuid, text, uuid, uuid) IS
  'Records one hand-filed expense as one expense row and one balanced journal. Provenance is manual, so registration_id is necessarily NULL.';

-- -----------------------------------------------------------------------------
-- PRIZE ALLOCATION
--
-- The header names WHICH settled pool version was drawn, and COPIES its figures.
-- The copy is not denormalisation for speed. The pool can be superseded by a later
-- version (a sponsor correction, a re-run of the deductions), and an allocation
-- computed against version 1 must still reconcile against version 1's numbers long
-- after version 2 exists.
--
-- The basis and the rule version are stored as data rather than resolved by reading a
-- CompensationAgreement, because resolving them now is precisely the as-of join that
-- makes an allocation unreproducible.
-- -----------------------------------------------------------------------------

CREATE TABLE prize_allocation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  competition_division_id uuid NOT NULL,
  prize_pool_id         uuid NOT NULL,
  -- The pool VERSION this draw was made against, so "which numbers?" has an answer
  -- that does not depend on reading a mutable row.
  pool_version          integer NOT NULL,
  team_id               uuid NOT NULL,
  basis                 allocation_basis NOT NULL,
  rule_version          integer NOT NULL,
  -- Pinned in the snapshot and CHECKed to the one policy the spec fixes. A snapshot
  -- whose remainder policy was a free-text column would let a replay disagree with the
  -- original over rounding alone.
  remainder_policy      varchar(64) NOT NULL DEFAULT 'largest_remainder_stable_sort',
  -- The pool figures, copied.
  gross                 numeric(18,4) NOT NULL,
  deductions            numeric(18,4) NOT NULL,
  net_prize             numeric(18,4) NOT NULL,
  tax_withheld          numeric(18,4) NOT NULL,
  currency              varchar(3) NOT NULL,
  -- Emitted by the engine, RECOMPUTED and enforced by the trigger below.
  input_hash            char(64) NOT NULL,
  -- Computed here over the frozen input rows.
  snapshot_hash         char(64) NOT NULL,
  -- Computed here over the result rows, so an allocation can be verified without
  -- re-running the engine.
  output_hash           char(64) NOT NULL,
  computed_at           timestamptz NOT NULL,
  computed_by           varchar(120) NOT NULL,
  -- Corrections are new allocations that name the one they replace. Never an UPDATE.
  supersedes_id         uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prize_allocation_division_fk
    FOREIGN KEY (org_id, competition_division_id)
    REFERENCES competition_division (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_pool_fk
    FOREIGN KEY (org_id, prize_pool_id) REFERENCES prize_pool (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_supersedes_fk
    FOREIGN KEY (org_id, supersedes_id) REFERENCES prize_allocation (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_gross_check CHECK (gross >= 0),
  CONSTRAINT prize_allocation_deductions_check CHECK (deductions >= 0),
  CONSTRAINT prize_allocation_net_check CHECK (net_prize >= 0),
  CONSTRAINT prize_allocation_tax_check CHECK (tax_withheld >= 0),
  CONSTRAINT prize_allocation_net_identity_check CHECK (net_prize = gross - deductions),
  CONSTRAINT prize_allocation_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT prize_allocation_rule_version_check CHECK (rule_version >= 1),
  CONSTRAINT prize_allocation_pool_version_check CHECK (pool_version >= 1),
  CONSTRAINT prize_allocation_remainder_policy_check
    CHECK (remainder_policy = 'largest_remainder_stable_sort'),
  CONSTRAINT prize_allocation_input_hash_check CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT prize_allocation_snapshot_hash_check CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT prize_allocation_output_hash_check CHECK (output_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT prize_allocation_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX prize_allocation_org_idx       ON prize_allocation (org_id);
CREATE INDEX prize_allocation_org_division_idx ON prize_allocation (org_id, competition_division_id);
CREATE INDEX prize_allocation_org_pool_idx  ON prize_allocation (org_id, prize_pool_id);
CREATE INDEX prize_allocation_org_team_idx  ON prize_allocation (org_id, team_id);

CREATE UNIQUE INDEX prize_allocation_supersedes_key
  ON prize_allocation (org_id, supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE TRIGGER prize_allocation_append_only
  BEFORE UPDATE OR DELETE ON prize_allocation
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

-- Note what is NOT here yet: a foreign key on
-- (org_id, competition_division_id, pool_version), and a guard refusing an allocation
-- against an unsettled pool. Both need `prize_pool.version` and `prize_pool.status`,
-- which are added by 0005_prize_pool_lifecycle.sql — 0002's UNIQUE
-- (org_id, competition_division_id) has to be dropped before a pool can be versioned at
-- all, and that is a change to an already-applied table, so it belongs in its own
-- corrective file rather than in the middle of the money schema.
--
-- The cost of that ordering is stated rather than hidden: between 0004 and 0005 an
-- allocation could name a pool version that does not exist and a draft pool could be
-- drawn against. Both files ship in the same change and 0005 closes them, so no released
-- schema ever has that window. Leaving them out of 0004 is still the honest choice —
-- inventing the FK here would mean the migration could not be applied at all.

-- -----------------------------------------------------------------------------
-- THE FROZEN INPUT SNAPSHOT
--
-- Two child tables, because the two halves answer different questions.
--
--   prize_allocation_input — WHO was in the draw and what the ROSTER said at the
--     moment. `share_percent` is the value read from team_membership at decision
--     time. It is NOT the rule's percentage (that is in the terms table), and the
--     difference matters: the common dispute is "my share was changed before the
--     draw", and answering it needs the roster value frozen next to the rule value,
--     not one column standing in for both.
--
--   prize_allocation_term — what the RULE said: one row per person per term role.
--
-- Weight is numeric(38,0), not an integer column: the engine's weights are bigint and
-- a participation count is a whole number by definition, but numeric is what keeps the
-- arithmetic in exact decimal space with no integer overflow and no float anywhere
-- near a prize.
-- -----------------------------------------------------------------------------

CREATE TABLE prize_allocation_input (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  allocation_id     uuid NOT NULL,
  person_id         uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  participant_kind  prize_participant_kind NOT NULL,
  -- The roster's share for this person, frozen. NULL for staff: a coach holds no
  -- playing share, and a zero here would be indistinguishable from a real zero.
  share_percent     numeric(7,4),
  weight            numeric(38,0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prize_allocation_input_allocation_fk
    FOREIGN KEY (org_id, allocation_id) REFERENCES prize_allocation (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_input_share_check
    CHECK (share_percent IS NULL OR (share_percent >= 0 AND share_percent <= 100)),
  CONSTRAINT prize_allocation_input_weight_check CHECK (weight IS NULL OR weight >= 0),
  -- One row per person. A duplicate participant is the engine's own rejection, frozen
  -- here as a constraint so it cannot be stored even if a caller bypassed the engine.
  CONSTRAINT prize_allocation_input_org_allocation_person_key UNIQUE (org_id, allocation_id, person_id),
  CONSTRAINT prize_allocation_input_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX prize_allocation_input_org_idx ON prize_allocation_input (org_id);
CREATE INDEX prize_allocation_input_org_allocation_idx ON prize_allocation_input (org_id, allocation_id);

CREATE TABLE prize_allocation_term (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  allocation_id  uuid NOT NULL,
  person_id      uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  term_role      allocation_term_role NOT NULL,
  amount         numeric(18,4) NOT NULL,
  -- The EXACT string the engine was given, verbatim.
  --
  -- This is not redundant with `amount`, and the reason is specific rather than
  -- decorative. The engine's input hash is taken over the rule's raw percentage
  -- STRINGS, not over parsed values: `parsePercent("60")` and `parsePercent("60.0000")`
  -- are the same number and hash differently. Storing only the parsed numeric would
  -- mean the database could not reproduce the hash it is supposed to verify — the
  -- snapshot would be arithmetically complete and cryptographically useless. So the
  -- literal is what is frozen, and `amount` is the derived decimal the schema can
  -- reason about. The CHECK binds them: the literal must parse to the stored number, so
  -- they cannot drift into telling different stories about the same rule.
  raw_value      varchar(64) NOT NULL,
  -- A term is a percentage OR a money amount (the `fixed_amount` role), and a money
  -- amount with no currency beside it is exactly the mistake ADR-0003 exists to prevent.
  -- Carried on the row rather than read from the header so the term is self-describing.
  currency       varchar(3) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prize_allocation_term_allocation_fk
    FOREIGN KEY (org_id, allocation_id) REFERENCES prize_allocation (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_term_amount_check CHECK (amount >= 0),
  CONSTRAINT prize_allocation_term_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT prize_allocation_term_raw_format_check CHECK (raw_value ~ '^-?[0-9]+(\.[0-9]+)?$'),
  CONSTRAINT prize_allocation_term_raw_value_check CHECK (raw_value::numeric = amount),
  -- One term per person per role. Two percentages for one person means the snapshot
  -- does not say which was used.
  CONSTRAINT prize_allocation_term_org_allocation_person_role_key
    UNIQUE (org_id, allocation_id, person_id, term_role),
  CONSTRAINT prize_allocation_term_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX prize_allocation_term_org_idx ON prize_allocation_term (org_id);
CREATE INDEX prize_allocation_term_org_allocation_idx ON prize_allocation_term (org_id, allocation_id);

CREATE TRIGGER prize_allocation_input_append_only
  BEFORE UPDATE OR DELETE ON prize_allocation_input
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

CREATE TRIGGER prize_allocation_term_append_only
  BEFORE UPDATE OR DELETE ON prize_allocation_term
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

-- -----------------------------------------------------------------------------
-- RESULT ROWS — the engine's Allocation, persisted verbatim
--
-- `explanation` is stored, not re-rendered. The engine writes it for exactly this
-- purpose: a human-readable derivation is only evidence if it is the derivation that
-- was actually used, and re-deriving it at read time from a rule that may since have
-- been corrected produces a confident, wrong answer to a player in dispute.
-- -----------------------------------------------------------------------------

CREATE TABLE prize_allocation_result (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  allocation_id   uuid NOT NULL,
  person_id       uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  participant_kind prize_participant_kind NOT NULL,
  basis_amount    numeric(18,4) NOT NULL,
  computed_amount numeric(18,4) NOT NULL,
  currency        varchar(3) NOT NULL,
  rule_version    integer NOT NULL,
  computed_at     timestamptz NOT NULL,
  computed_by     varchar(120) NOT NULL,
  explanation     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prize_allocation_result_allocation_fk
    FOREIGN KEY (org_id, allocation_id) REFERENCES prize_allocation (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_result_basis_check CHECK (basis_amount >= 0),
  -- NEGATIVE IS LEGAL, and deliberately. An adjustment may take money back, and
  -- `applyAdjustment` in the engine produces exactly such rows. Refusing a negative
  -- award would make a clawback unrepresentable, which is the opposite of what an
  -- append-only ledger is for.
  CONSTRAINT prize_allocation_result_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT prize_allocation_result_org_allocation_person_key UNIQUE (org_id, allocation_id, person_id),
  CONSTRAINT prize_allocation_result_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX prize_allocation_result_org_idx ON prize_allocation_result (org_id);
CREATE INDEX prize_allocation_result_org_allocation_idx ON prize_allocation_result (org_id, allocation_id);
CREATE INDEX prize_allocation_result_org_person_idx ON prize_allocation_result (org_id, person_id);

CREATE TRIGGER prize_allocation_result_append_only
  BEFORE UPDATE OR DELETE ON prize_allocation_result
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

-- -----------------------------------------------------------------------------
-- RECONCILIATION
--
-- A persisted first-class row, not a view — the spec is explicit about this, and it is
-- right. A view recomputed from the allocations cannot say what the books said when
-- the draw was run, which is the only statement anybody actually needs when a figure
-- is disputed.
--
-- The CHECK below is the invariant as arithmetic: variance is not an independent
-- input, it is defined as allocated + unallocated - net. A stored variance that
-- disagreed with its inputs would be a stored lie. The trigger below goes further and
-- recomputes the totals from the result rows, so a reconciliation that balances with
-- numbers nobody allocated is refused too.
-- -----------------------------------------------------------------------------

CREATE TABLE prize_allocation_reconciliation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  allocation_id    uuid NOT NULL,
  net_prize        numeric(18,4) NOT NULL,
  allocated_total  numeric(18,4) NOT NULL,
  unallocated      numeric(18,4) NOT NULL,
  variance         numeric(18,4) NOT NULL,
  -- ADR-0003: every monetary column has a currency beside it, not a global one. Four
  -- money figures without it would be unreadable in isolation, which is precisely the
  -- mistake the legacy schema made.
  currency         varchar(3) NOT NULL,
  is_balanced      boolean NOT NULL,
  explanation      text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prize_allocation_reconciliation_allocation_fk
    FOREIGN KEY (org_id, allocation_id) REFERENCES prize_allocation (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT prize_allocation_reconciliation_net_check CHECK (net_prize >= 0),
  CONSTRAINT prize_allocation_reconciliation_unallocated_check CHECK (unallocated >= 0),
  CONSTRAINT prize_allocation_reconciliation_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  -- The invariant, as a constraint the storage cannot violate.
  CONSTRAINT prize_allocation_reconciliation_variance_check
    CHECK (variance = allocated_total + unallocated - net_prize),
  CONSTRAINT prize_allocation_reconciliation_balanced_check
    CHECK (is_balanced = (variance = 0)),
  -- Exactly one reconciliation per allocation. Two would be two answers to "do the
  -- books balance?", which is worse than none.
  CONSTRAINT prize_allocation_reconciliation_org_allocation_key UNIQUE (org_id, allocation_id),
  CONSTRAINT prize_allocation_reconciliation_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX prize_allocation_reconciliation_org_idx ON prize_allocation_reconciliation (org_id);

CREATE TRIGGER prize_allocation_reconciliation_append_only
  BEFORE UPDATE OR DELETE ON prize_allocation_reconciliation
  FOR EACH ROW EXECUTE FUNCTION public.deny_money_mutation();

-- -----------------------------------------------------------------------------
-- HASH ENFORCEMENT
--
-- Four triggers, one function, all DEFERRABLE: the snapshot, the terms and the result
-- rows may be inserted in any order inside the posting transaction, and the check
-- happens once at COMMIT when the whole allocation is visible.
--
--   input_hash    recomputed from the stored snapshot using the engine's canonical
--                 form, and compared to the value the engine emitted. This is the
--                 alignment contract between packages/core and this schema.
--   snapshot_hash recomputed over the frozen inputs INCLUDING the roster shares and
--                 the pool figures.
--   output_hash   recomputed over the result rows.
--   reconciliation recomputed from the result rows; a variance other than zero, or
--                 totals that do not match the rows, is refused.
--
-- CANONICAL FORMS
-- ---------------
-- 1. input_hash must equal sha256(JSON.stringify(C)) in JavaScript, where C is
--    exactly the object allocation-engine.ts builds in hashInputs():
--
--      {"netPrize":"<4dp>","currency":"INR",
--       "participants":[{"personId":"...","kind":"roster","weight":null}, ...],
--       "rule":{"version":1,"basis":"percentage",
--               "percentages":{"<uuid>":"60.0000"},
--               "fixedAmounts":{},"poolPercentage":{},
--               "remainderPolicy":"largest_remainder_stable_sort"}}
--
--    Participants are ordered by uuid; each record map is ordered by key. That is the
--    engine's own ordering, and reimplementing it in SQL is deliberate — a hash over a
--    canonically ordered set is what makes the two independent implementations
--    comparable at all.
--
-- 2. snapshot_hash is a length-framed text of the header figures followed by one
--    line per frozen input and one per rule term, all ordered by uuid.
--
-- 3. output_hash is one length-framed line per result row. The explanation is
--    length-prefixed, because it is free text: an engine adjustment appends a line
--    break to it, and without the length prefix two different result sets could
--    serialise to the same bytes and hash alike.
--
-- Why compute rather than trust: a hash the database only stores is a comment. A hash
-- it recomputes is a check, and it turns "the snapshot was tampered with" from an
-- unfalsifiable claim into an INSERT that fails.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_allocation_hashes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_allocation_id uuid;
  a              record;
  v_canonical     text;
  v_recomputed    text;
  v_participants  text;
  v_percentages   text;
  v_fixed         text;
  v_pool_pct      text;
  v_snapshot      text;
  v_output        text;
  v_inputs        integer;
  v_results       integer;
  v_allocated     numeric;
  v_stored_total  numeric;
  v_stored_net    numeric;
  v_stored_unall  numeric;
  v_stored_bal    boolean;
  v_stored_currency varchar(3);
BEGIN
  IF TG_TABLE_NAME = 'prize_allocation' THEN
    v_allocation_id := NEW.id;
  ELSE
    v_allocation_id := NEW.allocation_id;
  END IF;

  SELECT * INTO a FROM public.prize_allocation WHERE id = v_allocation_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- ---- 1. input_hash, reconstructed in the engine's own canonical form --------
  SELECT COALESCE(string_agg(
           '{"personId":"' || i.person_id::text
           || '","kind":"' || i.participant_kind::text
           || '","weight":' || COALESCE(i.weight::text, 'null') || '}',
           ',' ORDER BY i.person_id), '')
    INTO v_participants
    FROM public.prize_allocation_input i
   WHERE i.allocation_id = a.id;

  -- The engine hashes the rule's RAW strings, so the reconstruction reads raw_value
  -- and not amount. Using amount would rebuild a canonical form the engine never
  -- produced, and the comparison would then fail for reasons that have nothing to do
  -- with tampering.
  SELECT '{' || COALESCE(string_agg('"' || t.person_id::text || '":"' || t.raw_value || '"',
                                    ',' ORDER BY t.person_id), '') || '}'
    INTO v_percentages
    FROM public.prize_allocation_term t
   WHERE t.allocation_id = a.id AND t.term_role = 'percentage';

  SELECT '{' || COALESCE(string_agg('"' || t.person_id::text || '":"' || t.raw_value || '"',
                                    ',' ORDER BY t.person_id), '') || '}'
    INTO v_fixed
    FROM public.prize_allocation_term t
   WHERE t.allocation_id = a.id AND t.term_role = 'fixed_amount';

  SELECT '{' || COALESCE(string_agg('"' || t.person_id::text || '":"' || t.raw_value || '"',
                                    ',' ORDER BY t.person_id), '') || '}'
    INTO v_pool_pct
    FROM public.prize_allocation_term t
   WHERE t.allocation_id = a.id AND t.term_role = 'pool_percentage';

  v_canonical :=
    '{"netPrize":"' || a.net_prize::text
    || '","currency":"' || a.currency
    || '","participants":[' || v_participants || ']'
    || ',"rule":{"version":' || a.rule_version::text
    || ',"basis":"' || a.basis::text || '"'
    || ',"percentages":' || v_percentages
    || ',"fixedAmounts":' || v_fixed
    || ',"poolPercentage":' || v_pool_pct
    || ',"remainderPolicy":"' || a.remainder_policy || '"}}';

  v_recomputed := encode(sha256(convert_to(v_canonical, 'utf8')), 'hex');

  IF v_recomputed <> a.input_hash THEN
    RAISE EXCEPTION
      'allocation % input_hash does not match its frozen snapshot: recomputed %, stored %',
      a.id, v_recomputed, a.input_hash
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---- 2. snapshot_hash over the frozen inputs -------------------------------
  v_snapshot :=
    'gross=' || a.gross::text || E'\n'
    || 'deductions=' || a.deductions::text || E'\n'
    || 'net=' || a.net_prize::text || E'\n'
    || 'tax=' || a.tax_withheld::text || E'\n'
    || 'currency=' || a.currency || E'\n'
    || 'basis=' || a.basis::text || E'\n'
    || 'rule_version=' || a.rule_version::text || E'\n'
    || 'remainder_policy=' || a.remainder_policy || E'\n'
    || COALESCE((
         SELECT string_agg(
                  'p|' || i.person_id::text
                  || '|' || i.participant_kind::text
                  || '|' || COALESCE(i.share_percent::text, '')
                  || '|' || COALESCE(i.weight::text, '') || E'\n', '' ORDER BY i.person_id)
           FROM public.prize_allocation_input i WHERE i.allocation_id = a.id), '')
    || COALESCE((
         SELECT string_agg(
                  't|' || t.person_id::text || '|' || t.term_role::text
                  || '|' || t.amount::text || E'\n', '' ORDER BY t.person_id, t.term_role)
           FROM public.prize_allocation_term t WHERE t.allocation_id = a.id), '');

  IF encode(sha256(convert_to(v_snapshot, 'utf8')), 'hex') <> a.snapshot_hash THEN
    RAISE EXCEPTION 'allocation % snapshot_hash does not match its frozen input rows', a.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---- 3. output_hash over the result rows -----------------------------------
  v_output := COALESCE((
    SELECT string_agg(
             r.person_id::text || '|' || r.participant_kind::text
             || '|' || r.basis_amount::text
             || '|' || r.computed_amount::text
             || '|' || r.currency
             || '|' || r.rule_version::text
             || '|' || length(r.explanation)::text || ':' || r.explanation || E'\n',
             '' ORDER BY r.person_id)
      FROM public.prize_allocation_result r WHERE r.allocation_id = a.id), '');

  IF encode(sha256(convert_to(v_output, 'utf8')), 'hex') <> a.output_hash THEN
    RAISE EXCEPTION 'allocation % output_hash does not match its result rows', a.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---- 4. the frozen participant set and the result set correspond -----------
  -- Without this the three hashes above would still agree on an allocation that
  -- silently dropped a player, because an empty or short result set hashes perfectly
  -- happily. The engine refuses to allocate with no participants and refuses a
  -- duplicate participant, so a mismatch here is not something this engine could have
  -- emitted.
  SELECT count(*) INTO v_inputs  FROM public.prize_allocation_input  WHERE allocation_id = a.id;
  SELECT count(*) INTO v_results FROM public.prize_allocation_result WHERE allocation_id = a.id;

  IF v_inputs = 0 OR v_inputs <> v_results THEN
    RAISE EXCEPTION
      'allocation % froze % participant(s) but holds % result row(s); they must correspond',
      a.id, v_inputs, v_results
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.prize_allocation_result r
     WHERE r.allocation_id = a.id
       AND NOT EXISTS (SELECT 1 FROM public.prize_allocation_input i
                        WHERE i.allocation_id = a.id AND i.person_id = r.person_id)
  ) THEN
    RAISE EXCEPTION 'allocation % has a result for a person absent from its frozen snapshot', a.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every frozen row must also be in the allocation's currency. A term quoted in USD
  -- inside an INR draw is a conversion somebody performed at no rate and recorded nowhere.
  IF EXISTS (
    SELECT 1 FROM public.prize_allocation_result r
     WHERE r.allocation_id = a.id AND r.currency <> a.currency
  ) OR EXISTS (
    SELECT 1 FROM public.prize_allocation_term t
     WHERE t.allocation_id = a.id AND t.currency <> a.currency
  ) THEN
    RAISE EXCEPTION 'allocation % carries rows in a currency other than %', a.id, a.currency
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---- 5. the reconciliation invariant, recomputed ---------------------------
  IF EXISTS (SELECT 1 FROM public.prize_allocation_reconciliation rc WHERE rc.allocation_id = a.id) THEN
    SELECT COALESCE(sum(r.computed_amount), 0)
      INTO v_allocated
      FROM public.prize_allocation_result r WHERE r.allocation_id = a.id;

    SELECT rc.allocated_total, rc.net_prize, rc.unallocated, rc.is_balanced, rc.currency
      INTO v_stored_total, v_stored_net, v_stored_unall, v_stored_bal, v_stored_currency
      FROM public.prize_allocation_reconciliation rc
     WHERE rc.allocation_id = a.id;

    IF v_stored_currency <> a.currency THEN
      RAISE EXCEPTION
        'allocation % reconciles in % but was drawn against %', a.id, v_stored_currency, a.currency
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_stored_total <> v_allocated THEN
      RAISE EXCEPTION
        'allocation % reconciliation claims % allocated but its result rows total %',
        a.id, v_stored_total, v_allocated
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_stored_net <> a.net_prize THEN
      RAISE EXCEPTION
        'allocation % reconciliation is against net % but the frozen pool net is %',
        a.id, v_stored_net, a.net_prize
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_allocated + v_stored_unall <> v_stored_net THEN
      RAISE EXCEPTION
        'allocation % does not reconcile: allocated % + unallocated % <> net %',
        a.id, v_allocated, v_stored_unall, v_stored_net
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_stored_bal IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'allocation % is stored as an unbalanced allocation', a.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_allocation_hashes() IS
  'Recomputes input_hash, snapshot_hash, output_hash and the reconciliation totals from the stored rows and refuses the allocation if any of them disagrees. Deferred to COMMIT.';

-- DEFERRABLE on every allocation table: the header, the snapshot, the terms, the
-- results and the reconciliation may be written in any order inside one posting
-- transaction, and the check happens once, at COMMIT, when the whole allocation is
-- visible. An IMMEDIATE trigger would check after the header, before any row existed,
-- and reject every correct posting.
CREATE CONSTRAINT TRIGGER prize_allocation_header_hashes
  AFTER INSERT ON prize_allocation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_allocation_hashes();

CREATE CONSTRAINT TRIGGER prize_allocation_participant_hashes
  AFTER INSERT ON prize_allocation_input
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_allocation_hashes();

CREATE CONSTRAINT TRIGGER prize_allocation_term_hashes
  AFTER INSERT ON prize_allocation_term
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_allocation_hashes();

CREATE CONSTRAINT TRIGGER prize_allocation_result_hashes
  AFTER INSERT ON prize_allocation_result
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_allocation_hashes();

CREATE CONSTRAINT TRIGGER prize_allocation_reconciliation_hashes
  AFTER INSERT ON prize_allocation_reconciliation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_allocation_hashes();

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- Enabled AND forced, tenant predicate first, no IS NULL escape. An unset session
-- context makes `org_id = current_org_id()` evaluate to NULL, which is not TRUE, which
-- hides every row. That is failing closed, and it is the property ADR-0015 exists to
-- guarantee.
--
-- budget_balance is a plain view, so it runs with the privileges of its invoker and
-- every underlying table's RLS applies to it. It therefore exposes exactly what its
-- tables expose and nothing wider.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  money_tables text[] := ARRAY[
    'ledger_account','ledger_journal','ledger_line','budget','expense',
    'prize_allocation','prize_allocation_input','prize_allocation_term',
    'prize_allocation_result','prize_allocation_reconciliation'
  ];
BEGIN
  FOREACH t IN ARRAY money_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- PRIVILEGES
--
-- raptor_app gets SELECT and INSERT on the money tables and NOTHING else. No UPDATE,
-- no DELETE: posted money is corrected by a reversing entry, and a role that can
-- rewrite a posted figure is a role that can invent one.
--
-- `expense` additionally gets NO INSERT. It is written only by the two posting
-- functions below, which is what makes "exactly one component can create an expense
-- row" a property of the GRANT rather than a convention two components agreed between
-- themselves. The legacy double-count happened because two components both believed
-- they owned the write; here the second one has no grant.
--
-- Those functions are SECURITY DEFINER, so EXECUTE on them is a door into `expense`.
-- PostgreSQL grants EXECUTE on every new function to PUBLIC by default, which would
-- hand that door to every role in the database, so PUBLIC is revoked and the grant is
-- made explicitly to raptor_app only.
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO raptor_app;

GRANT SELECT, INSERT ON
  ledger_account, ledger_journal, ledger_line, budget,
  prize_allocation, prize_allocation_input, prize_allocation_term,
  prize_allocation_result, prize_allocation_reconciliation
TO raptor_app;

GRANT SELECT ON expense TO raptor_app;
GRANT SELECT ON budget_balance TO raptor_app;

REVOKE ALL ON FUNCTION public.assert_journal_balanced() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_budget_not_exceeded() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deny_money_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_allocation_hashes() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.post_registration_entry_expense(uuid, date, uuid, uuid, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.post_manual_expense(date, numeric, varchar, uuid, uuid, text, uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  public.post_registration_entry_expense(uuid, date, uuid, uuid, text, uuid, uuid),
  public.post_manual_expense(date, numeric, varchar, uuid, uuid, text, uuid, uuid)
TO raptor_app;

-- RLS is worthless to a role that can switch it off.
-- Reassert the application role attributes. Portable across self-hosted and managed databases: enforces where the owner is a superuser, verifies otherwise (see ensure_raptor_app_hardened() in 0001_tenancy.sql).
SELECT ensure_raptor_app_hardened();

COMMIT;

-- ==========================================================================
-- SOURCE: packages/db/migrations/0005_prize_pool_lifecycle.sql
-- ==========================================================================

-- =============================================================================
-- packages/db/migrations/0005_prize_pool_lifecycle.sql
--
-- A CORRECTION to 0002_competitive.sql, written as a new file on purpose.
--
-- `migrations.ts` refuses to re-apply a migration whose checksum has changed, and the
-- repository rule is stricter than the checker's tolerance: an applied migration is
-- never edited. Everything this file changes is therefore stated here in full rather
-- than patched into 0002.
--
-- WHAT WAS WRONG
-- --------------
-- 0002's `prize_pool` is a mutable row with `UNIQUE (org_id, competition_division_id)`.
-- Two things follow, and both of them are unreproducible allocations:
--
--   1. The figures can change after the fact. `gross`, `deductions`, `net` and
--      `tax_withheld` are ordinary columns, so a sponsor correction two days after the
--      final rewrites the net the prize was split from. Every allocation already
--      computed from the old net now reconciles against a number nobody divided.
--      0002 constrains `net = gross - deductions`, so the rewrite is internally
--      consistent — it is completely undetectable, which is worse.
--
--   2. There is no version. The UNIQUE constraint means one pool per division FOREVER,
--      so the only way to record a correction is to overwrite the row. The first value
--      is not merely changed, it ceases to exist.
--
-- The spec is unambiguous that this must not happen: "`Allocation` and `PrizePool`
-- append-only. No `UPDATE`, no `DELETE`." 0002 could satisfy neither half.
--
-- WHAT REPLACES IT
-- ----------------
-- 1. A version chain. `version` starts at 1 and each row may name the row it
--    supersedes. UNIQUE (org_id, competition_division_id) is dropped, and two partial
--    unique indexes replace it: one row per (org, division) with no parent — the
--    original — and at most one child per row, so the history is a path and not a tree.
--
-- 2. An explicit settle transition. 'draft' may be superseded by a new draft; 'settled'
--    may not be changed at all. The transition is the moment the figures stop moving,
--    and it is the precondition for an allocation: only a SETTLED pool may be drawn
--    against, which 0004 could not express because the column did not exist yet.
--
-- 3. Immutability in the database, for everyone. The trigger refuses any UPDATE or
--    DELETE on a settled row, and refuses a settle that does not carry the evidence a
--    settle needs — who did it and when.
--
-- WHY prize_pool KEEPS archived_at
-- --------------------------------
-- Every other money table in 0004 is strictly append-only and therefore has no archive
-- column: a column settable only by an UPDATE would be permanently NULL there, which
-- is a lie in the schema. prize_pool is the deliberate contrast, and the reason is
-- that it is NOT strictly append-only. A draft pool is a working document — it is
-- expected to be edited — and archiving an abandoned draft is a legitimate UPDATE.
-- The rule that matters is narrower and stronger: once settled, never again.
--
-- WHY SETTLING DOES NOT DELETE THE PREVIOUS VERSION
-- --------------------------------------------------
-- A settled pool is never un-settled. A sponsor correction after settlement produces a
-- NEW version, which is itself drafted and then settled. So the history of a pool is
-- monotonic in version and every figure the organisation ever published to a player is
-- still readable. This is why a March dispute about a January payout has an answer.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Lifecycle column
-- -----------------------------------------------------------------------------

CREATE TYPE prize_pool_status AS ENUM ('draft', 'settled', 'void');

ALTER TABLE prize_pool ADD COLUMN status      prize_pool_status NOT NULL DEFAULT 'draft';
ALTER TABLE prize_pool ADD COLUMN version     integer       NOT NULL DEFAULT 1;
ALTER TABLE prize_pool ADD COLUMN supersedes_id uuid;
ALTER TABLE prize_pool ADD COLUMN settled_at  timestamptz;
ALTER TABLE prize_pool ADD COLUMN settled_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT;

-- The version chain, as a composite FK. Cross-org supersession is impossible by
-- construction, like every other tenant reference in this schema (ADR-0011).
ALTER TABLE prize_pool ADD CONSTRAINT prize_pool_supersedes_fk
  FOREIGN KEY (org_id, supersedes_id) REFERENCES prize_pool (org_id, id) ON DELETE RESTRICT;

ALTER TABLE prize_pool ADD CONSTRAINT prize_pool_version_check CHECK (version >= 1);

-- Settling is an assertion by a named person at a known time. A 'settled' row with
-- neither is a claim with no author, which is the class of row the audit spent most of
-- its findings on — and here it is refused rather than merely discouraged.
ALTER TABLE prize_pool ADD CONSTRAINT prize_pool_settled_evidence_check
  CHECK (status <> 'settled' OR (settled_at IS NOT NULL AND settled_by_person_id IS NOT NULL));

-- 0002's UNIQUE (org_id, competition_division_id) is dropped: one pool per division
-- forever is exactly what makes a correction impossible to record. It is replaced
-- immediately below by two tighter partial indexes, so no window exists in which two
-- unrelated pools can both claim to be the original of the same division.
ALTER TABLE prize_pool DROP CONSTRAINT prize_pool_org_division_key;

-- The composite target an allocation uses to name an exact pool version. Without this
-- a snapshot could claim version 3 against a division whose pool is still version 1.
ALTER TABLE prize_pool ADD CONSTRAINT prize_pool_org_division_version_key
  UNIQUE (org_id, competition_division_id, version);

-- Exactly one ORIGINAL per (org, division): the row with no parent. This is what stops
-- a re-import from creating a second, competing history for a pool that already exists.
CREATE UNIQUE INDEX prize_pool_root_key
  ON prize_pool (org_id, competition_division_id)
  WHERE supersedes_id IS NULL;

-- At most one successor per row, so the versions form a path and not a tree. A branch
-- would let two corrections claim the same parent, and "which figure was published" would
-- have two answers.
CREATE UNIQUE INDEX prize_pool_supersedes_key
  ON prize_pool (org_id, supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE INDEX prize_pool_org_version_idx ON prize_pool (org_id, competition_division_id, version);

-- -----------------------------------------------------------------------------
-- IMMUTABILITY
--
-- One rule, stated once:
--
--   a SETTLED row never changes, for anybody.
--
-- The trigger covers UPDATE and DELETE on a settled row, and separately refuses to
-- settle a row whose figures disagree with a version already settled on the same
-- division — so 'settle' cannot be used to launder a second, different answer to the
-- same question.
--
-- SECURITY DEFINER is needed only to read the sibling versions, which the application
-- role may not see across tenants. It is REVOKE'd from PUBLIC immediately below, so the
-- elevation is reachable only through writing a pool, not by calling the function.
--
-- RAISES insufficient_privilege: "you may not do this" is the truth, and it is the
-- same code the GRANT on prize_pool produces, so a caller sees one refusal either way.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_prize_pool_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'settled' THEN
      RAISE EXCEPTION 'prize pool % is settled and may not be deleted; supersede it with a new version',
        OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'settled' THEN
    RAISE EXCEPTION 'prize pool % is settled and immutable; supersede it with a new version',
      OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A correction after settlement is a new version that is drafted and then settled in
  -- its own right, not a settle applied to the already-published row.
  IF NEW.status = 'settled' AND EXISTS (
    SELECT 1 FROM public.prize_pool p
     WHERE p.org_id = NEW.org_id
       AND p.competition_division_id = NEW.competition_division_id
       AND p.id <> NEW.id
       AND p.status = 'settled'
  ) THEN
    RAISE EXCEPTION
      'competition division % already has a settled pool; a further change must be a new version',
      NEW.competition_division_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_prize_pool_mutation() IS
  'A settled prize pool is immutable. A correction is a new version, drafted and settled in its own right.';

REVOKE ALL ON FUNCTION public.guard_prize_pool_mutation() FROM PUBLIC;

CREATE TRIGGER prize_pool_immutable
  BEFORE UPDATE OR DELETE ON prize_pool
  FOR EACH ROW EXECUTE FUNCTION public.guard_prize_pool_mutation();

-- -----------------------------------------------------------------------------
-- ALLOCATIONS MAY ONLY DRAW A SETTLED POOL, AT A VERSION THAT EXISTS
--
-- Added here rather than in 0004 because both need `prize_pool.status` and
-- `prize_pool.version`, which 0002 does not have.
--
-- The composite FK makes "version 3 of this division" a thing the database can check
-- rather than a thing the application asserts. And the trigger refuses a draft pool
-- outright, because an allocation against a pool that can still move is precisely the
-- unreproducible case this pair of files exists to prevent.
-- -----------------------------------------------------------------------------

ALTER TABLE prize_allocation ADD CONSTRAINT prize_allocation_pool_version_fk
  FOREIGN KEY (org_id, competition_division_id, pool_version)
  REFERENCES prize_pool (org_id, competition_division_id, version) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.assert_pool_is_settled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status public.prize_pool_status;
  v_version integer;
BEGIN
  SELECT p.status, p.version INTO v_status, v_version
    FROM public.prize_pool p
   WHERE p.org_id = NEW.org_id AND p.id = NEW.prize_pool_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'prize pool % does not exist in organisation %', NEW.prize_pool_id, NEW.org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_status <> 'settled' THEN
    RAISE EXCEPTION 'prize pool % is %; only a settled pool may be allocated', NEW.prize_pool_id, v_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_version <> NEW.pool_version THEN
    RAISE EXCEPTION
      'allocation names pool version % but pool % is at version %',
      NEW.pool_version, NEW.prize_pool_id, v_version
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER prize_allocation_requires_settled_pool
  BEFORE INSERT ON prize_allocation
  FOR EACH ROW EXECUTE FUNCTION public.assert_pool_is_settled();

-- -----------------------------------------------------------------------------
-- PRIVILEGES
--
-- 0002 granted raptor_app UPDATE and DELETE on prize_pool, which is how a settled pool
-- would have been rewritten. Those are taken back.
--
-- UPDATE is granted back at COLUMN level for the settle transition only — status,
-- settled_at, settled_by_person_id. The figures are not grantable at all, so a
-- published pool cannot be edited even through a mistake in a query builder, and the
-- trigger refuses the transition anyway. Belt, braces, and the reason each is here:
-- the column grant keeps the settle path usable without an UPDATE-everything grant, and
-- the trigger is what actually makes a settled pool immutable.
--
-- DELETE is not granted back at any level.
-- -----------------------------------------------------------------------------

REVOKE DELETE ON prize_pool FROM raptor_app;
REVOKE UPDATE ON prize_pool FROM raptor_app;
GRANT UPDATE (status, settled_at, settled_by_person_id) ON prize_pool TO raptor_app;

REVOKE ALL ON FUNCTION public.assert_pool_is_settled() FROM PUBLIC;
-- Reassert the application role attributes. Portable across self-hosted and managed databases: enforces where the owner is a superuser, verifies otherwise (see ensure_raptor_app_hardened() in 0001_tenancy.sql).
SELECT ensure_raptor_app_hardened();

COMMIT;

-- ==========================================================================
-- SOURCE: packages/db/migrations/0006_history_queries.sql
-- ==========================================================================

-- =============================================================================
-- packages/db/migrations/0006_history_queries.sql
--
-- A CORRECTION to 0002_competitive.sql, written as a new file on purpose.
--
-- `migrations.ts` refuses to re-apply a migration whose checksum has changed, and
-- the repository rule is stricter than the checker's tolerance: an applied migration
-- is never edited, because a database that already recorded 0002 would then be
-- permanently unable to reach the corrected state. Everything this file corrects is
-- therefore restated in full rather than patched into 0002.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- Phase 2's completion criterion (design spec section 8) is "Attendance and roster
-- history queries answerable by date". `0002` built the tables; it did not prove the
-- question could be answered, and `src/competitive.isolation.test.ts` could not prove
-- it either, because that suite asserts what the schema REFUSES. A table nothing can
-- interrogate passes every isolation assertion.
--
-- So the history queries were written for real, against real data, for arbitrary
-- historical dates — and three of them had no answer. This file supplies what was
-- missing, and `src/history.queries.test.ts` proves each answer against a live
-- instance. Nothing here was inferred from the DDL; every claim below is the observed
-- behaviour of the schema as it stood before this migration.
--
-- WHAT WAS WRONG
-- --------------
--
-- 1. A SESSION COULD NOT SAY WHERE IT CAME FROM.
--
--    `session` had no provenance column and no reference to `session_template` at all.
--    ADR-0016 records the consequence: the legacy generator had no column either, so
--    "generated" and "made by hand" could only be told apart by substring-matching a
--    cosmetic title — the exact undecidability the ADR listed as unrecoverable. 0002
--    gave `match_result` a mandatory `source` and `confidence` for precisely this
--    reason and gave `session` nothing. Verified before this migration: a query for a
--    generated session either had to read `title` or return every row.
--
-- 2. `attendance_policy.holiday_scope` WAS DECORATIVE.
--
--    The column is an enum ('none', 'org', 'national') with no holidays table anywhere
--    in the schema. A policy could be set to 'org' and there was nowhere to record an
--    org holiday, so the column could not change any query's answer. The legacy system
--    had a real `holidays` table (AUDIT/26_ATTENDANCE.md F-ATT-10) and this schema
--    dropped it without noticing.
--
-- 3. HISTORICAL MEMBERSHIP WINDOWS COULD OVERLAP.
--
--    `team_membership_current_key` and `team_staff_current_key` are PARTIAL unique
--    indexes — `WHERE valid_to IS NULL`. They stop a second CURRENT row and they say
--    nothing whatsoever about two CLOSED rows. Two memberships for one person on one
--    team, both with a `valid_to`, sharing any instant at all, were accepted by the
--    database. That is not a theoretical concern: "who was on the team on date D" is
--    exactly the query Phase 2 promised, and with overlapping windows it returns two
--    rows for one person and cannot say which was real.
--
--    Verified before this migration, by executing it: two CLOSED memberships for one
--    person on one team sharing an instant were ACCEPTED. `src/history.queries.test.ts`
--    asserts the refusal that this file adds, and asserts the two cases the guard must
--    NOT refuse — a different team, and abutting half-open windows — so that a guard
--    which simply rejected everything would not pass.
--
-- WHAT REPLACES IT
-- ----------------
--
-- 1. `session.origin` ('manual' | 'generated') and `session.session_template_id`, with
--    a composite FK and a CHECK tying the two together, so "generated" cannot be
--    claimed without naming what generated it and "manual" cannot name a template.
--
-- 2. `session_holiday`, so `holiday_scope` has rows to select.
--
-- 3. A trigger guard refusing overlapping windows on (org, team, person[, role]) for
--    team_membership and team_staff, on INSERT and on UPDATE.
--
-- WHY A TRIGGER AND NOT `EXCLUDE USING gist`
-- -------------------------------------------
-- A declarative exclusion constraint is the better tool and would raise the identical
-- SQLSTATE. It cannot be used here, and both halves of that were executed rather than
-- assumed:
--
--   CREATE EXTENSION btree_gist
--     -> error 0A000, "extension \"btree_gist\" is not available"
--
--   CREATE TABLE ... EXCLUDE USING gist (org WITH =, team WITH =, person WITH =,
--                                             r tstzrange WITH &&)
--     -> error 42704, "data type uuid has no default operator class for access
--                      method \"gist\""
--
-- ADR-0015 records that the local engine is a subset of contrib for exactly this kind
-- of reason.
--
-- The consequence for callers is nil, and that is the point of the choice:
-- `exclusion_violation` (23P01) is what PostgreSQL itself raises for an EXCLUDE
-- constraint, and it is what this guard raises, so a future switch to the declarative
-- form on a full server is not an observable change to any caller. A different code
-- here would force every caller to learn two error paths for one business rule.
--
-- The guard also takes an advisory transaction lock keyed on the identity it is
-- checking, which is what makes two concurrent inserts of overlapping CLOSED windows
-- serialise instead of both observing an empty table. As 0003 records, that cannot be
-- exercised as a true race on PGlite (one in-process session); the lock is present
-- because the real PostgreSQL target needs it, and it is honestly unverified locally.
--
-- WHY OVERLAP IS STILL REFUSED EVEN THOUGH EFFECTIVE DATING IS THE POINT
-- ----------------------------------------------------------------------
-- Effective dating exists to record a person leaving and rejoining, which is why
-- `valid_to` exists at all. It does not exist to permit two contradictory truths about
-- one instant. The windows are half-open — `[valid_from, valid_to)` — so a handover is
-- recorded by a row ending exactly where the next begins, and those two rows share no
-- instant and are accepted. What is refused is two rows sharing an instant, which has
-- no reading: a person cannot be two share-holding members of one team at 18:00 on
-- the same evening, and if they could, the prize engine in packages/core would split a
-- pool between both.
--
-- The same rule applies to team_staff, keyed on (team, person, role) to match the
-- existing partial index. Being head coach and analyst at the same time is a real
-- thing and is still permitted; being head coach twice is not.
--
-- WHY RETROACTIVE TEMPLATE EDITS DO NOT PROPAGATE
-- ------------------------------------------------
-- Recorded here because it is a decision and not an accident, and ADR-0016's complaint
-- about the legacy generator was never that it copied — it was that a copy with no
-- record of its origin is indistinguishable from a hand-written row.
--
-- `session_template` is a recurring PATTERN; `session` is a FACT about a past evening.
-- Editing the template changes what will be generated next week. It must not rewrite
-- the start time, duration or attendance policy of a session that already happened,
-- because attendance records, absences and disputes hang off those facts. So a
-- generated session keeps the configuration it was generated with, and
-- `session_template_id` records which template produced it, which is what makes a
-- session that looks stale explicable ("this predates the current template") instead
-- of a mystery.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. SESSION PROVENANCE
--
-- An enum rather than a boolean because "where did this come from" has more than two
-- honest answers the moment anyone imports a schedule from a spreadsheet, and adding
-- a fourth answer then means an ALTER TYPE on a live table rather than a new column.
-- -----------------------------------------------------------------------------

CREATE TYPE session_origin AS ENUM ('manual', 'generated');

ALTER TABLE session ADD COLUMN origin session_origin NOT NULL DEFAULT 'manual';

-- NOT NULL with a DEFAULT, so every existing row is valid immediately. 'manual' is
-- the correct backfill rather than a placeholder: a session written before this
-- column existed was, in fact, not recorded as generated, and claiming otherwise would
-- invent provenance for historical rows. It also fails the CHECK below if it does
-- name a template, so a backfilled row can never claim a source it does not have.

ALTER TABLE session ADD COLUMN session_template_id uuid;

-- Composite, for the same reason every other tenant reference in this schema is:
-- a session naming another organisation's template must be rejected by the database,
-- not merely hidden by a policy (ADR-0011).
ALTER TABLE session ADD CONSTRAINT session_template_fk
  FOREIGN KEY (org_id, session_template_id)
  REFERENCES session_template (org_id, id) ON DELETE RESTRICT;

-- The two columns are one fact. A session that claims to be generated without naming
-- the template that generated it reproduces the legacy defect inside a new table: the
-- provenance is recorded but the question "generated from what?" still has no answer.
-- A manual session naming a template is the mirror image — it claims a human wrote
-- something a rule produced, which is how a hand-edited generated row becomes
-- indistinguishable from a hand-written one.
ALTER TABLE session ADD CONSTRAINT session_origin_template_check
  CHECK ((origin = 'generated') = (session_template_id IS NOT NULL));

CREATE INDEX session_org_origin_idx  ON session (org_id, origin);
CREATE INDEX session_org_template_idx ON session (org_id, session_template_id);

COMMENT ON COLUMN session.origin IS
  'Provenance: a session written by a person, or produced from a session_template. Recorded rather than inferred from title text, which was the legacy defect (ADR-0016).';

COMMENT ON COLUMN session.session_template_id IS
  'The template this session was generated from. A generated session keeps the configuration it was generated with; editing the template does not rewrite history.';

-- -----------------------------------------------------------------------------
-- 2. HOLIDAY CALENDAR
--
-- `attendance_policy.holiday_scope` was already an enum before this file and there was
-- nothing for it to select. The scope lives on the HOLIDAY rather than on the policy,
-- because a given date is a holiday for the organisation and for the country at once,
-- and which of those applies to a session is a property of the date, not of the team
-- that happened to be training.
--
-- `team_id` is nullable: NULL is an organisation-wide or national day, which is also
-- how the legacy table modelled it. F-ATT-10 in AUDIT/26_ATTENDANCE.md called mixing
-- the two in one table with no discriminator a defect, so the discriminator here is an
-- explicit `scope` column rather than the nullability of team_id.
-- -----------------------------------------------------------------------------

CREATE TYPE holiday_kind AS ENUM ('org', 'national');

CREATE TABLE session_holiday (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- NULL for an organisation-wide or national day. The composite FK still makes a
  -- reference to another organisation's team impossible when it is set (ADR-0011).
  team_id         uuid,
  scope           holiday_kind NOT NULL DEFAULT 'org',
  holiday_date    date NOT NULL,
  description     varchar(200),
  -- The legacy table had this, and it is the one case where a "holiday" is a working
  -- day: a bootcamp held on a public holiday. Without it the column would have to be
  -- either false or absent information.
  is_working_day  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CONSTRAINT session_holiday_team_fk
    FOREIGN KEY (org_id, team_id) REFERENCES team (org_id, id) ON DELETE CASCADE,
  -- A NATIONAL day is a day for the whole country and belongs to no team, so naming a
  -- team on one is a claim with two parts that contradict: the team also trained that
  -- day, and nobody did. Stated positively rather than as "scope = 'national' OR
  -- team_id IS NULL", which was the first form tried and which permits exactly this
  -- row while forbidding the legitimate one (a TEAM-specific organisation holiday,
  -- which is the case team_id exists for).
  CONSTRAINT session_holiday_scope_team_check
    CHECK (scope = 'org' OR team_id IS NULL),
  -- One holiday per team per date. NULLs compare distinct in a plain UNIQUE, so this
  -- does nothing at all for organisation-wide rows — which is what the partial index
  -- below is for. Two constraints rather than one because they cover disjoint cases,
  -- not redundant ones.
  CONSTRAINT session_holiday_team_date_key UNIQUE (org_id, team_id, holiday_date),
  CONSTRAINT session_holiday_org_id_id_key    UNIQUE (org_id, id)
);

-- Organisation-wide and national holidays. Partial rather than a table constraint
-- because a bare UNIQUE (org_id, holiday_date) would also refuse a NATIONAL holiday
-- falling on the same date as an organisation holiday, and those are independent
-- facts: a country-wide holiday does not stop an organisation declaring its own
-- founder's day, and the absence rate must be able to read both.
--
-- `scope` is part of the key precisely so that pairing is allowed while a genuine
-- duplicate — Founders Day recorded twice — is still refused. Verified by inserting
-- both and expecting them to coexist.
CREATE UNIQUE INDEX session_holiday_org_date_key
  ON session_holiday (org_id, holiday_date, scope)
  WHERE team_id IS NULL;

CREATE INDEX session_holiday_org_idx       ON session_holiday (org_id);
CREATE INDEX session_holiday_org_team_idx  ON session_holiday (org_id, team_id);
CREATE INDEX session_holiday_org_date_idx  ON session_holiday (org_id, holiday_date);

COMMENT ON TABLE session_holiday IS
  'Non-working days. Exists so attendance_policy.holiday_scope selects real rows; before 0006 that column had nothing behind it.';

-- Tenant-scoped exactly as every other competitive table: ENABLED and FORCED, with
-- the predicate as the whole policy and no IS NULL escape, so an unset tenant context
-- fails closed rather than exposing the calendar (ADR-0015).

ALTER TABLE session_holiday ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_holiday FORCE  ROW LEVEL SECURITY;

CREATE POLICY session_holiday_tenant_isolation ON session_holiday
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON session_holiday TO raptor_app;

-- -----------------------------------------------------------------------------
-- 3. OVERLAPPING EFFECTIVE-DATED WINDOWS
--
-- One function, two triggers. Membership and staff differ only in the key columns, and
-- two hand-written copies of the predicate are exactly how 0002's two capacity triggers
-- came to disagree about what a "place" is (0003's opening paragraph). The predicate
-- takes the table as an argument rather than naming one, so the rule is written once.
--
-- The advisory lock is taken on the identity being checked, not on the row being
-- written, because the row being written does not exist yet and the whole hazard is
-- two statements both finding no conflicting row.
--
-- `o.id IS DISTINCT FROM NEW.id` rather than `<>`: on UPDATE the row is its own
-- neighbour, and IS DISTINCT FROM is NULL-safe so a NULL id could not silently widen
-- the comparison.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.effective_window_overlaps(
  p_org_id      uuid,
  p_team_id     uuid,
  p_person_id   uuid,
  p_new_from    timestamptz,
  p_new_to      timestamptz,
  p_self_id     uuid,
  p_role        text,
  p_match_role  boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_found boolean;
BEGIN
  -- Half-open on both ends, so `tstzrange(a_from, a_to, '[)')` is the same convention
  -- the query side uses and a clean handover shares no instant.
  IF p_match_role THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.team_staff s
       WHERE s.org_id    = p_org_id
         AND s.team_id   = p_team_id
         AND s.person_id = p_person_id
         AND s.role_in_team::text = p_role
         AND s.id IS DISTINCT FROM p_self_id
         AND tstzrange(s.valid_from, s.valid_to, '[)')
          && tstzrange(p_new_from, p_new_to, '[)')
    ) INTO v_found;
  ELSE
    SELECT EXISTS (
      SELECT 1
        FROM public.team_membership m
       WHERE m.org_id    = p_org_id
         AND m.team_id   = p_team_id
         AND m.person_id = p_person_id
         AND m.id IS DISTINCT FROM p_self_id
         AND tstzrange(m.valid_from, m.valid_to, '[)')
          && tstzrange(p_new_from, p_new_to, '[)')
    ) INTO v_found;
  END IF;

  RETURN v_found;
END
$$;

COMMENT ON FUNCTION public.effective_window_overlaps(uuid, uuid, uuid, timestamptz, timestamptz, uuid, text, boolean) IS
  'True when [p_new_from, p_new_to) shares an instant with an existing membership or staff window for the same person and team. Half-open on both ends.';

CREATE OR REPLACE FUNCTION public.guard_membership_window_overlap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Serialise on the identity, not the row: the hazard is two statements both
  -- observing no conflicting neighbour, and neither row exists yet at this point.
  -- hashtext is only ever used to derive a lock key, so a collision costs an
  -- unnecessary wait and can never admit an overlap.
  PERFORM pg_advisory_xact_lock(
    hashtext(NEW.org_id::text || '|' || NEW.team_id::text || '|' || NEW.person_id::text)
  );

  IF public.effective_window_overlaps(
       NEW.org_id, NEW.team_id, NEW.person_id,
       NEW.valid_from, NEW.valid_to, NEW.id, NULL, false
     ) THEN
    RAISE EXCEPTION
      'person % already holds a membership of team % overlapping [%, %)',
      NEW.person_id, NEW.team_id, NEW.valid_from, NEW.valid_to
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.guard_membership_window_overlap() IS
  'Refuses two memberships for one person on one team that share an instant. Covers INSERT and UPDATE; abutting half-open windows are not an overlap.';

CREATE OR REPLACE FUNCTION public.guard_staff_window_overlap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(NEW.org_id::text || '|' || NEW.team_id::text || '|' ||
             NEW.person_id::text || '|' || NEW.role_in_team::text)
  );

  IF public.effective_window_overlaps(
       NEW.org_id, NEW.team_id, NEW.person_id,
       NEW.valid_from, NEW.valid_to, NEW.id, NEW.role_in_team::text, true
     ) THEN
    RAISE EXCEPTION
      'person % already holds staff role % of team % overlapping [%, %)',
      NEW.person_id, NEW.role_in_team, NEW.team_id, NEW.valid_from, NEW.valid_to
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.guard_staff_window_overlap() IS
  'Refuses two staff appointments of the same role for one person on one team that share an instant. Different roles at once remain permitted.';

-- AFTER rather than BEFORE, deliberately: BEFORE would run before the partial unique
-- index and turn "two CURRENT rows" from a 23505 into a 23P01. Keeping the existing
-- index's code means an existing caller's error handling still means what it meant,
-- and the 23P01 is reserved for the case the index could not see.
--
-- Trigger functions are not privilege-checked when a trigger fires, so the REVOKE
-- below changes nothing about the guard working. It removes the elevation as a
-- directly callable door, which is the same pairing 0003 and 0005 use.

CREATE TRIGGER team_membership_no_window_overlap
  AFTER INSERT OR UPDATE ON team_membership
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_window_overlap();

CREATE TRIGGER team_staff_no_window_overlap
  AFTER INSERT OR UPDATE ON team_staff
  FOR EACH ROW EXECUTE FUNCTION public.guard_staff_window_overlap();

REVOKE ALL ON FUNCTION public.effective_window_overlaps(uuid, uuid, uuid, timestamptz, timestamptz, uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_membership_window_overlap() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_staff_window_overlap() FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 4. WHAT THIS FILE DELIBERATELY DID NOT CHANGE — `attendance_record.minutes_late`
--
-- Recorded because it is a live finding, not because it is fixed here.
--
-- ADR-0016 section "Recovered rules" records that the legacy system never computed
-- "late" at all: it was a button the player pressed, and the schema stored no arrival
-- time, so afterwards nobody could tell a genuine arrival from a claim. The ADR's
-- remedy was "attendance gets an arrival timestamp", and 0002 delivered that part —
-- `attendance_record.checked_in_at` is the instant.
--
-- What 0002 did NOT deliver is the other half. `minutes_late` is still supplied by
-- the caller, and `attendance_record_late_only_check` only ties it to the presence
-- of a `late` status — not to `checked_in_at`. The database will happily store
--
--     status = 'late', minutes_late = 3, checked_in_at = <40 minutes after start>
--
-- which is a self-declared three-minute lateness contradicted by the arrival instant
-- sitting in the same row. Verified against this build rather than assumed.
--
-- No constraint is added here, deliberately. A CHECK cannot read `session.starts_at`
-- (it is on another table), and a trigger that overwrote `minutes_late` would destroy
-- the declared value that a player or coach actually entered, replacing one kind of
-- untrustworthy record with a differently-untrustworthy one. The honest position is
-- that `checked_in_at` is the evidence and `minutes_late` is the claim, and every
-- attendance-rate query must derive lateness from the evidence against
-- `attendance_policy`, never from the claim.
--
-- `src/history.queries.test.ts` asserts this by storing a row whose declared
-- lateness and recorded arrival contradict each other, and requiring the rate query to
-- follow the arrival. Fixing the storage side is a decision for whoever owns the
-- attendance write path, not a side effect of closing a history-query criterion.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- RLS IS WORTHLESS TO A ROLE THAT CAN SWITCH IT OFF
--
-- Restated at the end of the file, as 0001, 0002 and 0005 each do. A corrective
-- migration that added a table without re-asserting this would be the one place in
-- the chain where the property could quietly lapse.
-- -----------------------------------------------------------------------------
-- Reassert the application role attributes. Portable across self-hosted and managed databases: enforces where the owner is a superuser, verifies otherwise (see ensure_raptor_app_hardened() in 0001_tenancy.sql).
SELECT ensure_raptor_app_hardened();

COMMIT;

-- ==========================================================================
-- SOURCE: packages/db/migrations/0007_performance_metrics.sql
-- ==========================================================================

-- =============================================================================
-- packages/db/migrations/0007_performance_metrics.sql
--
-- The PERFORMANCE bounded context, designed rather than recovered.
--
-- ADR-0019 (`docs/adr/0019-performance-metrics-designed-not-recovered.md`) is the
-- only ADR in this repository whose outcome is the ABSENCE of a rule. The legacy
-- system had no performance formula to carry forward, so this file had to invent
-- one — and the ADR's own closing line is the permission and the limit:
--
--     "Inventing a formula is acceptable; inventing a claim is not."
--
-- So: no `win_rate = totalMatches * 0.7`, no `Math.ceil(totalMatches / 5)` as a
-- "Team Ranking", no OCR confidence hardcoded to 85, no `bestDay` that returns
-- the oldest day, no window that filters on `created_at`, and no limit that
-- silently caps at 1000 rows and presents the result as a ranking. Each of those
-- is answered here by a different shape, and each is asserted by a named test in
-- `src/performance.isolation.test.ts`.
--
-- WHAT THIS FILE CONTAINS
-- -----------------------
--
--   performance_extraction    the machine read itself: which pipeline, what it
--                             literally said, and how sure it was.
--
--   match_player_performance  one player's line in one match: the raw inputs, the
--                             derived figures, and the provenance of both.
--
--   player_performance_leaderboard()
--                             the ranking, which cannot present a capped set as a
--                             ranking and takes no tenant parameter.
--
-- Plus one corrective rename at the top, below.
--
-- WHY A PERFORMANCE LINE CANNOT FLOAT FREE
-- ----------------------------------------
-- The legacy schema had no match entity. A "match" existed only as one player's
-- row, so `/api/public/stats/route.ts:26-28` — which counted rows for matches and
-- rows with `placement = 1` for WWCD — reported FOUR wins for a four-player squad
-- win. Every aggregate built on player-rows inherits that defect structurally;
-- there is no way to count matches from them.
--
-- So `match_player_performance.match_id` is NOT NULL and carries a composite
-- foreign key to `match (org_id, id)`. A line without a match is unexpressible.
-- Match-level facts come from `match_result`, which is UNIQUE
-- (org_id, match_id, team_id), so joining a squad's four lines to one result row
-- cannot multiply it. And `match_player_performance_current_key` is UNIQUE
-- (org_id, match_id, person_id) WHERE archived_at IS NULL, so one player cannot
-- contribute twice to the same match even by re-import.
--
-- There is deliberately no `team_id` here. The team is a property of the match,
-- so "which squad is this line for" has exactly one answer and a disagreeing one
-- is not storable rather than merely discouraged.
--
-- WHY EVERY DERIVED FIGURE IS STORED *AND* CONSTRAINED
-- ----------------------------------------------------
-- A metric that is recalculated on read can be changed by changing an input, and
-- the historical figure a player was shown then disappears. A metric that is
-- stored without its derivation cannot be checked by anybody.
--
-- Both halves are here. The raw inputs sit on the row beside the derived figure,
-- and each derived column has a CHECK that recomputes it from those inputs and
-- refuses the row when the two disagree — the same form as
-- `prize_pool_net_identity_check` in 0002, used here for a dispute rather than for
-- money. An organisation disputing a figure reads the inputs and recomputes it in
-- SQL; `src/performance.isolation.test.ts` does exactly that and asserts the two
-- agree.
--
-- `derivation_version` names the formula that produced the stored value. Without
-- it a stored figure is a number nobody can reproduce once the formula changes,
-- which is the auditability this whole design exists to deliver.
--
-- WHAT IS DELIBERATELY ABSENT
-- ----------------------------
-- ADR-0019 searched the entire legacy source and found no ADR, ACS, impact
-- rating, headshot percentage formula, KAST, computed column, tier sort or
-- month-granularity rollup — and no death tracking at all, which is why there was
-- no K/D to recover. Nothing here invents one.
--
--   * No ADR / ACS / impact rating. There is no raw input in this schema that
--     could produce one, so a column for it would be a number with no derivation.
--   * No headshot-percentage column, because that is an INDUSTRY-WIDE definition
--     nobody agreed on and a wrong one is worse than an absent one. What IS stored
--     is the raw pair — `headshots` and `headshot_attempts` — from which any
--     definition is derivable by whoever has to defend it.
--   * No round-level survival bitmap, hence no KAST.
--   * No monthly rollup table. A stored rollup drifts from the lines it summarises,
--     which is the budget-counter failure 0004 refused to reproduce; the
--     leaderboard aggregates on read from lines that cannot silently double.
--
-- WHAT A METRIC THAT CANNOT BE COMPUTED LOOKS LIKE
-- ------------------------------------------------
-- NULL, and a CHECK that refuses anything else.
--
-- `rounds_played = 0` makes every per-round figure undefined; `deaths = 0` makes
-- the K/D undefined, not infinite; `headshot_attempts = 0` makes the rate
-- undefined. Each is stored as NULL, each is recomputed to NULL by its CHECK, and
-- an assertion that a figure exists when its denominator does not is refused with
-- check_violation. A zero would be a lie; a guess would be worse. This is the
-- mechanical form of ADR-0019's "a metric that cannot be computed must be absent,
-- not fabricated", and it is the assertion this migration exists to make
-- unarguable.
--
-- PROVENANCE
-- ----------
-- `match_result` already carries `source` and `confidence` and 0002 already
-- refused a machine-sourced row with no confidence. This file inherits all of it
-- and adds the part 0002 had no table for: `performance_extraction`. A line whose
-- source is a machine MUST name the extraction that holds that machine's verbatim
-- output and the machine's own stated confidence, and a hand-entered line MUST
-- name none. The binding runs both ways, so neither "an OCR row with nothing
-- behind it" nor "a typed row wearing an OCR provenance" is storable.
--
-- `confidence` has NO DEFAULT on either table. A row cannot be written without
-- somebody stating how sure the source was, which is the exact thing the legacy
-- OCR path got wrong when it wrote 85 into every row.
--
-- UNITS
-- -----
-- ADR-0019 lists `survival_time`'s unit as genuinely unresolvable from the legacy
-- data: minutes on one surface, seconds on another, and a stored `10` is
-- indistinguishable from a stored `600` forever after. The fix is the NAME.
-- Every duration column in this schema carries an explicit unit suffix, and
-- `src/performance.isolation.test.ts` scans every table in the schema for a
-- duration column whose name omits its unit.
--
-- That scan is what found the one corrective step below.
--
-- WINDOWS AND TRUNCATION
-- ----------------------
-- The leaderboard filters on `match.scheduled_at` — the event date — and never on
-- `created_at`, so backfilled history belongs to the period in which it happened.
-- It takes NO organisation argument: the tenant comes from the session
-- (ADR-0011 rule 3), so a caller cannot choose which tenant they read.
--
-- It reports truncation rather than performing it silently. Every returned row
-- carries `rows_matched` (the true size of the set) and `is_truncated`, and a cap
-- of zero or less is refused outright rather than returning an empty ranking that
-- renders as "no performers".
--
-- ORDERING IS DETERMINISTIC, WITH A TIE-BREAKER
-- ---------------------------------------------
-- ADR-0019 records that no leaderboard sort in the legacy system had one, so two
-- players with identical records came back in whatever order the rows arrived. The
-- sort here is wins, then K/D, then person id — the last key being a stored,
-- immutable value rather than a function of row order, which is what makes the
-- ranking reproducible.
--
-- TENANCY
-- -------
-- Identical to 0001/0002/0006 and not restated per table: org_id NOT NULL,
-- UNIQUE (org_id, id), every composite index leading with org_id, every FK between
-- tenant tables composite and including org_id, RLS ENABLED *and* FORCED with the
-- tenant predicate as the whole policy and no IS NULL escape (ADR-0015).
--
-- WHY THESE TABLES ARE NOT APPEND-ONLY
-- ------------------------------------
-- The money tables in 0004 are strictly append-only and carry no archive column,
-- because an archive column on a table with no UPDATE path is a column
-- permanently NULL. These two are the opposite case and take the `prize_pool`
-- treatment from 0005: a performance line is a working document that is corrected
-- by ARCHIVING the old line and writing a new one that supersedes it. The chain is
-- a path, not a tree (`match_player_performance_supersedes_key`), and the
-- superseding line must be an archived line for the SAME match and the SAME
-- person — otherwise "this corrects that" is a claim with no reading and the audit
-- trail that exists to answer disputes would itself be the thing that misleads.
-- There is no hard delete on either table.
--
-- Applied by the migration ledger. Never edited in place.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- CORRECTIVE: `attendance_record.minutes_late` NAMED ITS UNIT NOWHERE
-- ------------------------------------------------------------------
--
-- Found by the schema-wide unit scan this migration adds a test for, and it is
-- the only remaining instance of ADR-0019's item 3. The value is minutes — every
-- caller in the legacy code and in `history.queries.test.ts` computes against
-- `cutoff_offset_minutes`, which is declared in minutes — but the column name says
-- "late", not "late in minutes", which is the same ambiguity that made
-- `survival_time` unrecoverable.
--
-- Renamed rather than commented. A comment explaining that the unit is minutes is
-- read once, by the next person to open the file; the name is read every time.
--
-- The constraint is renamed with it so the two names do not drift apart — a CHECK
-- called `attendance_record_minutes_late_check` guarding `late_minutes` would be
-- the sort of thing the next person stops trusting.
--
-- This is the established corrective pattern, not an edit to 0002: an applied
-- migration is never rewritten, so a fix to an existing table lands in a later
-- file (0003, 0005 and 0006 are the precedents).
-- -----------------------------------------------------------------------------

ALTER TABLE attendance_record RENAME COLUMN minutes_late TO late_minutes;

ALTER TABLE attendance_record
  RENAME CONSTRAINT attendance_record_minutes_late_check TO attendance_record_late_minutes_check;

-- -----------------------------------------------------------------------------
-- THE MACHINE READ
--
-- The evidence a disputed number is settled against. Without it, an OCR-derived
-- figure and a hand-typed one are the same row forever — which is precisely how a
-- hardcoded 85 came to be presented as a confidence.
--
-- The tenant predicate on this table is the same as every other competitive table:
-- no IS NULL branch, so an unset context yields zero rows rather than every row.
-- -----------------------------------------------------------------------------

CREATE TABLE performance_extraction (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- Anchored to a MATCH for the same reason a performance line is. An extraction
  -- that belongs to no match could be attached to any of them.
  match_id     uuid NOT NULL,
  -- 'manual' is refused. An extraction a person typed is not an extraction, and
  -- admitting one would let a hand-entered row wear a machine's provenance —
  -- the defect in reverse.
  source       match_result_source NOT NULL,
  -- WHICH pipeline produced this. "Where did this come from" has no answer
  -- without it, and the legacy schema recorded no source at all.
  extractor    varchar(160) NOT NULL,
  -- The machine's output VERBATIM. A dispute about a parsed number is settled by
  -- looking at what was actually read, which is impossible once only the parsed
  -- figures survive.
  payload_text text NOT NULL,
  -- The machine's OWN stated confidence. NO DEFAULT: a row cannot be written
  -- without somebody stating how sure the source was. The legacy OCR path wrote
  -- 85 into every row, which is a constant wearing a column's name.
  confidence   numeric(5,4) NOT NULL,
  -- The instant the machine read it, not the instant the row was inserted. A
  -- backfilled extraction belongs to the match, and the match carries the date.
  extracted_at timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT performance_extraction_match_fk
    FOREIGN KEY (org_id, match_id) REFERENCES match (org_id, id) ON DELETE CASCADE,
  CONSTRAINT performance_extraction_source_check
    CHECK (source <> 'manual'),
  CONSTRAINT performance_extraction_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT performance_extraction_extractor_check
    CHECK (btrim(extractor) <> ''),
  CONSTRAINT performance_extraction_payload_check
    CHECK (btrim(payload_text) <> ''),
  CONSTRAINT performance_extraction_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX performance_extraction_org_idx        ON performance_extraction (org_id);
CREATE INDEX performance_extraction_org_match_idx   ON performance_extraction (org_id, match_id);
CREATE INDEX performance_extraction_org_source_idx  ON performance_extraction (org_id, source);

COMMENT ON TABLE performance_extraction IS
  'A machine read of one match''s scoreboard, kept verbatim with the confidence the machine itself stated. Exists so a parsed performance figure can be checked against what was actually read, and so a hardcoded confidence is unexpressible (ADR-0019).';

COMMENT ON COLUMN performance_extraction.confidence IS
  'The confidence the EXTRACTION reports about itself, supplied by the writer and never defaulted. The legacy OCR path hardcoded 85.';

-- -----------------------------------------------------------------------------
-- THE PER-PLAYER LINE
--
-- Raw inputs, derived figures and provenance on one row, because a dispute needs
-- all three together: the figure, the numbers it came from, and who claimed them.
-- -----------------------------------------------------------------------------

CREATE TABLE match_player_performance (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- NOT NULL, and composite. There is no such thing as a performance line that
  -- belongs to no match; that is the whole defect ADR-0019 opens with.
  match_id     uuid NOT NULL,
  person_id    uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  -- A correction names the line it corrects. Never an UPDATE of a live figure:
  -- the archived predecessor is what an auditor reads.
  supersedes_id uuid,

  -- RAW INPUTS. Everything a derived figure below is computed from, and the whole
  -- of what this table knows. Chosen for what the domain can actually measure and
  -- for nothing else — ADR-0019 lists no ADR, ACS, impact or KAST anywhere in the
  -- legacy source, and there is no raw input here that would produce one.
  rounds_played         integer NOT NULL DEFAULT 0,
  kills                 integer NOT NULL DEFAULT 0,
  -- Deaths were never tracked in the legacy system, which is why there was no K/D
  -- to recover. They are tracked here, so the ratio below is DERIVABLE rather than
  -- inherited — and a ratio with no deaths in it is stored as NULL, not invented.
  deaths                integer NOT NULL DEFAULT 0,
  assists               integer NOT NULL DEFAULT 0,
  damage_dealt          integer NOT NULL DEFAULT 0,
  damage_taken          integer NOT NULL DEFAULT 0,
  -- The raw PAIR, never a percentage. "Headshot percentage" has at least three
  -- industry definitions; storing the counts means whichever one a sponsor later
  -- invokes is at least computable from what was recorded.
  headshot_attempts     integer NOT NULL DEFAULT 0,
  headshots             integer NOT NULL DEFAULT 0,
  -- UNIT IN THE NAME. `survival_time` was minutes on one legacy surface and
  -- seconds on another, and a stored 10 is indistinguishable from a stored 600
  -- afterwards. This is the fix.
  survival_time_seconds integer NOT NULL DEFAULT 0,

  -- DERIVED FIGURES. Stored rather than recalculated on read, so the figure a
  -- player was shown still exists after an input is corrected — and each one is
  -- CHECKed against the raw inputs on this same row, so it is an auditable
  -- claim rather than an assertion of faith.
  kills_per_round       numeric(14,4),
  deaths_per_round      numeric(14,4),
  assists_per_round     numeric(14,4),
  damage_per_round      numeric(14,4),
  kd_ratio              numeric(14,4),
  headshot_rate_pct     numeric(7,4),
  -- WHICH formula produced the six figures above. A stored figure whose derivation
  -- is unidentified cannot be reproduced a year from now, which is the exact
  -- failure this column exists to prevent.
  derivation_version    integer NOT NULL DEFAULT 1,

  -- PROVENANCE. Inherited from `match_result` (0002) in full, plus the reference
  -- to the machine read that 0002 had no table for.
  source                match_result_source NOT NULL,
  confidence            numeric(5,4) NOT NULL,
  extraction_id         uuid,
  recorded_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  verified_at           timestamptz,
  verified_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,

  created_at            timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz,

  CONSTRAINT match_player_performance_match_fk
    FOREIGN KEY (org_id, match_id) REFERENCES match (org_id, id) ON DELETE CASCADE,
  CONSTRAINT match_player_performance_supersedes_fk
    FOREIGN KEY (org_id, supersedes_id)
    REFERENCES match_player_performance (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT match_player_performance_extraction_fk
    FOREIGN KEY (org_id, extraction_id)
    REFERENCES performance_extraction (org_id, id) ON DELETE RESTRICT,

  -- Bounds, not just signs. A negative count is not a measurement, and an upper
  -- bound is what keeps the derived ratios from overflowing their numeric scale
  -- and reporting a numeric_value_out_of_range instead of the real problem.
  CONSTRAINT match_player_performance_counts_check CHECK (
        rounds_played      BETWEEN 0 AND 999
    AND kills              BETWEEN 0 AND 999
    AND deaths             BETWEEN 0 AND 999
    AND assists            BETWEEN 0 AND 999
    AND headshots          BETWEEN 0 AND 9999
    AND headshot_attempts  BETWEEN 0 AND 9999
    AND damage_dealt       BETWEEN 0 AND 1000000
    AND damage_taken       BETWEEN 0 AND 1000000
    -- A day. Anything longer is not a match, and an unbounded duration is how a
    -- unit error becomes a number nobody can sanity-check.
    AND survival_time_seconds BETWEEN 0 AND 86400
  ),
  -- More headshots than attempts describes a match that cannot have happened. A
  -- CHECK that only bounded the sign would store it.
  CONSTRAINT match_player_performance_headshot_check
    CHECK (headshots <= headshot_attempts),

  -- THE DERIVATIONS.
  --
  -- Each recomputes the stored figure from the raw inputs on the SAME row and
  -- refuses the row when the two disagree. `IS NOT DISTINCT FROM` rather than
  -- `=`, so the undefined case is compared as NULL = NULL and holds.
  --
  -- The CASE arm is the whole point of each one: a zero denominator yields NULL,
  -- and a row that supplies any figure at all in that situation is refused. That
  -- is the mechanical difference between "this metric is unavailable" and "this
  -- metric is 0.7 times the match count".
  CONSTRAINT match_player_performance_kills_per_round_check CHECK (
    kills_per_round IS NOT DISTINCT FROM
      (CASE WHEN rounds_played = 0 THEN NULL
            ELSE round(kills::numeric / rounds_played, 4) END)
  ),
  CONSTRAINT match_player_performance_deaths_per_round_check CHECK (
    deaths_per_round IS NOT DISTINCT FROM
      (CASE WHEN rounds_played = 0 THEN NULL
            ELSE round(deaths::numeric / rounds_played, 4) END)
  ),
  CONSTRAINT match_player_performance_assists_per_round_check CHECK (
    assists_per_round IS NOT DISTINCT FROM
      (CASE WHEN rounds_played = 0 THEN NULL
            ELSE round(assists::numeric / rounds_played, 4) END)
  ),
  CONSTRAINT match_player_performance_damage_per_round_check CHECK (
    damage_per_round IS NOT DISTINCT FROM
      (CASE WHEN rounds_played = 0 THEN NULL
            ELSE round(damage_dealt::numeric / rounds_played, 4) END)
  ),
  CONSTRAINT match_player_performance_kd_ratio_check CHECK (
    kd_ratio IS NOT DISTINCT FROM
      (CASE WHEN deaths = 0 THEN NULL
            ELSE round(kills::numeric / deaths, 4) END)
  ),
  CONSTRAINT match_player_performance_headshot_rate_check CHECK (
    headshot_rate_pct IS NOT DISTINCT FROM
      (CASE WHEN headshot_attempts = 0 THEN NULL
            ELSE round(headshots::numeric * 100 / headshot_attempts, 4) END)
  ),
  CONSTRAINT match_player_performance_derivation_version_check
    CHECK (derivation_version >= 1),

  -- PROVENANCE CONSTRAINTS. Same rules as `match_result`, restated because this is
  -- the table a per-player figure is actually disputed in.
  CONSTRAINT match_player_performance_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  -- A hand-typed number is either known or it is not, so it carries 1. A number a
  -- machine read is only as good as the read, and forcing the author to state
  -- that is the entire point of the column.
  CONSTRAINT match_player_performance_manual_confidence_check
    CHECK (source <> 'manual' OR confidence = 1),
  -- The binding, both directions. A machine-sourced line with nothing behind it is
  -- the legacy defect; a hand-entered line naming a machine read is how a corrected
  -- OCR row becomes indistinguishable from a typed one.
  CONSTRAINT match_player_performance_extraction_binding_check
    CHECK ((source IN ('ocr', 'provider_api', 'import', 'system')) = (extraction_id IS NOT NULL)),
  -- "Verified" without a verifier is a claim, not a verification.
  CONSTRAINT match_player_performance_verified_check
    CHECK (verified_at IS NULL OR (verified_by_person_id IS NOT NULL AND verified_at >= recorded_at)),

  CONSTRAINT match_player_performance_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX match_player_performance_org_idx       ON match_player_performance (org_id);
CREATE INDEX match_player_performance_org_match_idx  ON match_player_performance (org_id, match_id);
CREATE INDEX match_player_performance_org_person_idx ON match_player_performance (org_id, person_id);
CREATE INDEX match_player_performance_org_source_idx ON match_player_performance (org_id, source);

-- ONE CURRENT LINE per player per match. The partial form rather than a bare
-- UNIQUE, because a correction is legitimate and two live lines are not: without
-- this, a re-import could leave two lines for one player in one match and every
-- per-player count would double. That is the same class of defect as the duplicate
-- attendance row that inflated the legacy attendance numbers, and here it is
-- unstorable rather than countable.
CREATE UNIQUE INDEX match_player_performance_current_key
  ON match_player_performance (org_id, match_id, person_id)
  WHERE archived_at IS NULL;

-- At most one successor per line, so the correction history is a PATH and not a
-- tree. A branch would let two corrections claim the same predecessor and "which
-- figure superseded which" would have two answers.
CREATE UNIQUE INDEX match_player_performance_supersedes_key
  ON match_player_performance (org_id, supersedes_id)
  WHERE supersedes_id IS NOT NULL;

COMMENT ON TABLE match_player_performance IS
  'One player''s line in one match: raw inputs, figures derived from them, and the provenance of both. A line always references a match, so a four-player squad win is one match won and no aggregate can double-count it (ADR-0019).';

COMMENT ON COLUMN match_player_performance.survival_time_seconds IS
  'Whole seconds alive. The legacy `survival_time` was minutes on one surface and seconds on another and the data can no longer say which, so the unit is in the name here.';

COMMENT ON COLUMN match_player_performance.derivation_version IS
  'Which formula produced the derived figures on this row. Without it a stored figure cannot be reproduced once the formula changes.';

COMMENT ON COLUMN match_player_performance.extraction_id IS
  'The machine read this line came from. Required for every machine source and forbidden for a hand-entered one, so provenance cannot be claimed without evidence.';

COMMENT ON COLUMN match_player_performance.kd_ratio IS
  'kills / deaths, or NULL when deaths = 0. Deaths were never tracked in the legacy system, which is why there was no K/D to recover; a ratio with no deaths in it is undefined, not infinite and not zero.';

-- -----------------------------------------------------------------------------
-- THE CORRECTION CHAIN
--
-- A trigger, not a CHECK, because the rule spans a row and its predecessor and a
-- CHECK cannot read another table.
--
-- `exclusion_violation` (23P01) rather than check_violation: it is what a
-- declarative EXCLUDE constraint would raise for exactly this shape, so a future
-- switch to one on a full server is not an observable change to any caller.
--
-- Not `EXCLUDE USING gist`, for the reasons 0006 verified rather than assumed —
-- `btree_gist` is unavailable on PGlite (0A000) and gist has no operator class
-- for uuid (42704).
--
-- SECURITY DEFINER because the predecessor may be in a team the application role
-- cannot read across; REVOKEd from PUBLIC immediately below, so the elevation is
-- reachable only by writing a line.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_performance_supersession()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.supersedes_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The predecessor must be an ARCHIVED line for the SAME match and the SAME
  -- person. Naming any other line makes "this corrects that" a claim with no
  -- reading, and the chain that exists to answer disputes would itself be the
  -- thing that misleads. Archiving is required so that a live figure is never
  -- both current and corrected.
  --
  -- `id <> NEW.id` rather than IS DISTINCT FROM: NEW.id is NOT NULL by the primary
  -- key, so the NULL-safe form would buy nothing here and would read as though it
  -- were guarding something.
  IF NOT EXISTS (
    SELECT 1
      FROM public.match_player_performance p
     WHERE p.org_id         = NEW.org_id
       AND p.id             = NEW.supersedes_id
       AND p.match_id       = NEW.match_id
       AND p.person_id      = NEW.person_id
       AND p.archived_at    IS NOT NULL
       AND p.id             <> NEW.id
  ) THEN
    RAISE EXCEPTION
      'performance line % cannot supersede %: the predecessor must be an archived line for the same match and the same person',
      NEW.id, NEW.supersedes_id
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_performance_supersession() IS
  'Refuses a correction that names anything other than an archived line for the same match and the same person. A legitimate correction is still accepted.';

REVOKE ALL ON FUNCTION public.guard_performance_supersession() FROM PUBLIC;

CREATE TRIGGER match_player_performance_corrects
  BEFORE INSERT ON match_player_performance
  FOR EACH ROW EXECUTE FUNCTION public.guard_performance_supersession();

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- Enabled AND forced, with the tenant predicate as the whole policy and no IS NULL
-- escape, so an unset tenant context hides every row rather than exposing them
-- (ADR-0015). Exactly as `session_holiday` in 0006.
-- -----------------------------------------------------------------------------

ALTER TABLE performance_extraction ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_extraction FORCE  ROW LEVEL SECURITY;

CREATE POLICY performance_extraction_tenant_isolation ON performance_extraction
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

ALTER TABLE match_player_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_player_performance FORCE  ROW LEVEL SECURITY;

CREATE POLICY match_player_performance_tenant_isolation ON match_player_performance
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

-- -----------------------------------------------------------------------------
-- THE LEADERBOARD
--
-- SECURITY INVOKER, deliberately. It reads and nothing more, so no elevation is
-- wanted: RLS on the tables it reads already limits it to the tenant in the
-- session, which is the whole of its authority.
--
-- It takes NO organisation argument. ADR-0011 rule 3: the tenant is resolved from
-- the session, never from a request parameter, or the caller chooses which tenant
-- they read. `current_org_id()` returns NULL for an unset context, which matches
-- no row, so the answer is empty rather than everybody's.
--
-- THE WINDOW IS ON THE EVENT DATE
-- ------------------------------
-- `match.scheduled_at` and never `created_at`. A season imported today belongs to
-- the months it was played in; filtering on the insert timestamp is how backfilled
-- history lands in the present bucket (ADR-0019).
--
-- `scheduled_at` specifically, rather than `completed_at`: it is the one instant
-- on `match` that is NOT NULL for every match, so the window is well defined
-- whether or not a backfill filled in the rest. A completed_at window would drop a
-- match whose completion was never recorded — the same class of "history silently
-- disappears" failure, in a different costume.
--
-- Halves are cancelled out. A cancelled match is not an event anybody played.
--
-- AGGREGATION IS sum(inputs) / sum(inputs), NEVER mean(ratios)
-- -----------------------------------------------------------
-- Averaging per-round ratios weights a one-round cameo exactly as heavily as a
-- full match, which is how a leaderboard ends up ranking a player above the team
-- that outranked them. Every aggregate here is computed from the summed RAW
-- inputs, and the stored per-row ratios are never averaged. The per-row ratios are
-- still stored and CHECKed — that is the audit trail — but an aggregate over a
-- window is a read, and it is computed from the evidence rather than from the
-- derived figures.
--
-- TRUNCATION IS REPORTED, NEVER PERFORMED SILENTLY
-- -----------------------------------------------
-- `performances/route.ts:63-64` capped at 1000 when a limit was supplied and told
-- nobody, then presented the capped set as a ranking. A leaderboard that looks
-- authoritative while being incomplete is worse than one that refuses, because
-- the reader has no way to tell.
--
-- So every returned row carries `rows_matched` — the true size of the set — and
-- `is_truncated`. The flag is on EVERY row, not on the last one: a caller reading
-- page one would otherwise never see it. And a cap of zero or less is refused
-- outright rather than returning an empty ranking that renders as "no performers".
--
-- NO cap at all means no truncation, and `rows_matched` says how big the set
-- actually was either way.
--
-- ORDERING IS TOTAL
-- -----------------
-- wins, then K/D, then person id. ADR-0019 records that no legacy leaderboard
-- sort had a tie-breaker, so two players with identical records came back in
-- whatever order the rows happened to arrive. The final key is a stored immutable
-- value rather than a function of row order, which is what makes the ranking
-- reproducible. `COALESCE(kd_ratio, -1)` puts an undefined ratio last rather than
-- first: DESC alone would rank NULL above every real number.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.player_performance_leaderboard(
  p_from  timestamptz,
  p_to    timestamptz,
  p_limit integer DEFAULT NULL
)
RETURNS TABLE (
  person_id             uuid,
  rank_position         integer,
  matches_played        integer,
  wins                  integer,
  losses                integer,
  draws                 integer,
  rounds_played         integer,
  kills                 integer,
  deaths                integer,
  assists               integer,
  damage_dealt          integer,
  damage_taken          integer,
  headshots             integer,
  headshot_attempts     integer,
  survival_time_seconds integer,
  kd_ratio              numeric(14,4),
  damage_per_round      numeric(14,4),
  headshot_rate_pct     numeric(7,4),
  rows_matched          integer,
  is_truncated          boolean
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_org_id uuid := public.current_org_id();
BEGIN
  -- An open-ended window is refused rather than defaulted. "All time" and "this
  -- month" are very different claims and a caller that means one of them should
  -- have to say which.
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'a leaderboard window needs both a start and an end; an open-ended window hides unbounded history'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_to <= p_from THEN
    RAISE EXCEPTION 'leaderboard window [% , % ) is empty', p_from, p_to
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_limit IS NOT NULL AND p_limit < 1 THEN
    RAISE EXCEPTION 'a leaderboard cap of % would return nothing while looking like a ranking', p_limit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN QUERY
  WITH lines AS (
    SELECT s.match_id,
           s.person_id,
           s.rounds_played,
           s.kills,
           s.deaths,
           s.assists,
           s.damage_dealt,
           s.damage_taken,
           s.headshots,
           s.headshot_attempts,
           s.survival_time_seconds,
           r.outcome
      FROM public.match_player_performance s
      JOIN public.match m
        ON m.org_id = s.org_id
       AND m.id     = s.match_id
      -- ONE result row per (match, team): `match_result` is UNIQUE
      -- (org_id, match_id, team_id), so joining a squad's four lines here cannot
      -- multiply it. That single constraint is what stops a four-player win being
      -- counted four times.
      JOIN public.match_result r
        ON r.org_id  = s.org_id
       AND r.match_id = m.id
       AND r.team_id  = m.team_id
     WHERE s.org_id = v_org_id
       -- An archived line is history, not a fact about the match. Counting it
       -- alongside its replacement would double the player.
       AND s.archived_at IS NULL
       AND m.status <> 'cancelled'
       -- THE EVENT DATE. Not created_at.
       AND m.scheduled_at >= p_from
       AND m.scheduled_at <  p_to
  ),
  totals AS (
    -- count(DISTINCT match_id) rather than count(*): the partial unique index
    -- already forbids two live lines for one player in one match, so the two agree
    -- today. The DISTINCT is what keeps them agreeing if that index is ever relaxed,
    -- and it states the intent — a MATCH is what is counted — where count(*) would
    -- only state it by accident.
    SELECT l.person_id,
           count(DISTINCT l.match_id)::integer                                        AS matches_played,
           count(DISTINCT l.match_id) FILTER (WHERE l.outcome = 'win')::integer     AS wins,
           count(DISTINCT l.match_id) FILTER (WHERE l.outcome = 'loss')::integer    AS losses,
           count(DISTINCT l.match_id) FILTER (WHERE l.outcome = 'draw')::integer    AS draws,
           sum(l.rounds_played)::integer                                             AS rounds_played,
           sum(l.kills)::integer                                                     AS kills,
           sum(l.deaths)::integer                                                    AS deaths,
           sum(l.assists)::integer                                                   AS assists,
           sum(l.damage_dealt)::integer                                              AS damage_dealt,
           sum(l.damage_taken)::integer                                              AS damage_taken,
           sum(l.headshots)::integer                                                 AS headshots,
           sum(l.headshot_attempts)::integer                                         AS headshot_attempts,
           sum(l.survival_time_seconds)::integer                                     AS survival_time_seconds
      FROM lines l
     GROUP BY l.person_id
  ),
  derived AS (
    SELECT t.*,
           CASE WHEN t.deaths = 0 THEN NULL
                ELSE round(t.kills::numeric / t.deaths, 4) END::numeric(14,4)      AS kd_ratio,
           CASE WHEN t.rounds_played = 0 THEN NULL
                ELSE round(t.damage_dealt::numeric / t.rounds_played, 4) END::numeric(14,4) AS damage_per_round,
           CASE WHEN t.headshot_attempts = 0 THEN NULL
                ELSE round(t.headshots::numeric * 100 / t.headshot_attempts, 4) END::numeric(7,4) AS headshot_rate_pct
      FROM totals t
  ),
  ranked AS (
    SELECT d.*,
           (row_number() OVER (
             ORDER BY d.wins DESC,
                      COALESCE(d.kd_ratio, -1) DESC,
                      d.person_id ASC
           ))::integer AS rank_position,
           (count(*) OVER ())::integer AS rows_matched
      FROM derived d
  )
  SELECT r.person_id,
         r.rank_position,
         r.matches_played,
         r.wins,
         r.losses,
         r.draws,
         r.rounds_played,
         r.kills,
         r.deaths,
         r.assists,
         r.damage_dealt,
         r.damage_taken,
         r.headshots,
         r.headshot_attempts,
         r.survival_time_seconds,
         r.kd_ratio,
         r.damage_per_round,
         r.headshot_rate_pct,
         r.rows_matched,
         -- COALESCE(p_limit, rows_matched) rather than "rank_position > p_limit":
         -- the rows past the cap are filtered out below, so a per-row comparison
         -- would report "not truncated" on every row the caller can actually see.
         -- This compares the SET against the cap.
         (COALESCE(p_limit, r.rows_matched) < r.rows_matched) AS is_truncated
    FROM ranked r
   WHERE p_limit IS NULL OR r.rank_position <= p_limit
   ORDER BY r.rank_position;
END
$$;

COMMENT ON FUNCTION public.player_performance_leaderboard(timestamptz, timestamptz, integer) IS
  'Per-player performance over an event-dated window. Takes no organisation argument — the tenant comes from the session. Every returned row carries rows_matched and is_truncated, so a capped set can never be mistaken for a complete ranking; a cap below one is refused.';

-- -----------------------------------------------------------------------------
-- PRIVILEGES
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON
  performance_extraction, match_player_performance
TO raptor_app;

-- No INSERT on performance_extraction through the application role: an extraction
-- is evidence produced by a machine, and a row a person typed into it would be
-- indistinguishable from one the pipeline wrote. Writers are the extraction
-- pipeline and migrations, both of which run as the schema owner.

REVOKE INSERT ON performance_extraction FROM raptor_app;

-- PostgreSQL grants EXECUTE on a new function to PUBLIC. The leaderboard reads
-- only and reads through the caller's policies, so that grant exposes nothing
-- beyond what the caller could already select — but it is taken back anyway, so
-- the only way in is a session with a tenant set and grants on the tables.

REVOKE ALL ON FUNCTION public.player_performance_leaderboard(timestamptz, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.player_performance_leaderboard(timestamptz, timestamptz, integer) TO raptor_app;

-- -----------------------------------------------------------------------------
-- RLS IS WORTHLESS TO A ROLE THAT CAN SWITCH IT OFF
--
-- Restated at the end of the file, as 0001, 0002, 0005 and 0006 each do. A
-- migration that added tables without re-asserting this would be the one place in
-- the chain where the property could quietly lapse.
-- -----------------------------------------------------------------------------
-- Reassert the application role attributes. Portable across self-hosted and managed databases: enforces where the owner is a superuser, verifies otherwise (see ensure_raptor_app_hardened() in 0001_tenancy.sql).
SELECT ensure_raptor_app_hardened();

COMMIT;

-- ==========================================================================
-- SOURCE: packages/db/migrations/0008_people.sql
-- ==========================================================================

-- =============================================================================
-- packages/db/migrations/0008_people.sql
--
-- The PEOPLE bounded context: contracts, provable acceptance, compensation, the HR
-- lifecycle, documents with expiry, and minors/consent.
--
-- THE DESIGN PROBLEM THIS FILE EXISTS TO SOLVE
-- -------------------------------------------
-- An esports organisation's most expensive disputes are "I never signed that" and
-- "that was not the version I signed". Both are answered the same way: by evidence
-- rather than by assertion. So every property below is enforced BY THE DATABASE, and
-- each is asserted by a named test in `src/people.isolation.test.ts`:
--
--   1. A contract document is immutable once any version has been accepted.
--   2. Every version carries a content hash COMPUTED BY THE DATABASE, and an INSERT
--      whose stored hash disagrees with that computation is refused.
--   3. Acceptance names a specific version. Accepting N never accepts N+1.
--   4. Acceptance is append-only: no UPDATE, no DELETE.
--   5. Withdrawal is a separate append-only record, never a mutation.
--
-- Property 2 is the one that is easy to fake. A hash column with a CHECK on its
-- SHAPE is decorative — the writer supplies 64 hex characters and the database has
-- no idea whether they describe the document beside them. So the hash here is not a
-- value the database accepts, it is a value the database RECOMPUTES from the stored
-- content and refuses to disagree with. A claim the database cannot contradict is
-- not evidence, and this file refuses to store one.
--
-- WHAT IS EXTENDED RATHER THAN DUPLICATED
-- ---------------------------------------
-- `0001_tenancy.sql` already created `person`, `person_profile`, `consent_record`
-- and `guardian_consent`. None of them is recreated here. The corrections land in
-- this file rather than as an edit to 0001, because an applied migration is never
-- rewritten (0003, 0005, 0006 and 0007 are the precedents):
--
--   person.birth_date          ADD COLUMN. A person's date of birth belongs to the
--                              person, not to an organisation: one human is the
--                              same age everywhere, and ADR-0018 makes `person` the
--                              identity root that outlives every auth provider.
--
--   guardian_consent           The 0001 shape is a global per-person flag — no
--                              organisation, no engagement, no relationship, and a
--                              `revoked_at` column on a table that must be
--                              append-only (a revocation column that can never be
--                              written is a permanent lie). It is corrected into an
--                              engagement-scoped, organisation-scoped, append-only
--                              consent record. `revoked_at` is DROPPED and replaced
--                              by `guardian_consent_revocation`.
--
-- WHY `consent_record` IS LEFT ALONE
-- ----------------------------------
-- It records consent to data processing, which is a different question from consent
-- to be engaged. A minor's ability to consent to data processing is a jurisdiction-
-- specific legal question this schema has no standing to answer, and inventing an
-- answer would be the ADR-0016 failure mode: taking a noun out of a narrative and
-- treating it as a specification. The rule this file enforces is the one the domain
-- turns on: a minor cannot be ENGAGED without a guardian who consented to that
-- specific engagement.
--
-- WHERE THE LIMIT OF THE DATABASE IS, STATED PLAINLY
-- --------------------------------------------------
-- Two things are NOT provable here, and pretending otherwise would be the same
-- defect the rest of this file exists to prevent.
--
--   * A `birth_date` of NULL does NOT mean "adult". It means unknown, and
--     `majority_status()` returns 'unknown' for it. The minor-engagement guard fires
--     only on a KNOWN minor, because most real players have no recorded date of birth
--     and refusing every one of them would be a decision this schema has no basis
--     for. Where the law genuinely requires proof of age,
--     `engagement.is_age_restricted` requires a recorded birth date — that guard IS
--     strict. The residual gap (a minor with no birth date engaged under a
--     non-age-restricted engagement) is a gap in the DATA, not in the constraint.
--     It is named here rather than hidden.
--
--   * The application may still pass the wrong `person_id`, the wrong `valid_from`,
--     or the wrong `is_age_restricted`. No schema can know which person a caller
--     meant. What the database guarantees is that whatever the caller asserts is
--     CONSISTENT and EVIDENCED: no minor is engaged without an engagement-scoped
--     guardian consent, no accepted document can change, and no acceptance exists
--     without the hash of the exact text it accepted.
--
-- TENANCY
-- -------
-- Identical to 0001/0002/0006/0007 and not restated per table: org_id NOT NULL,
-- UNIQUE (org_id, id), every composite index leading with org_id, every FK between
-- tenant tables composite and including org_id, RLS ENABLED *and* FORCED with the
-- tenant predicate as the whole policy and no IS NULL escape (ADR-0015). `person` is
-- org-independent by design (ADR-0018) and is therefore referenced by single-column
-- foreign keys from tenant tables, exactly as `engagement.person_id` already is.
--
-- NO HARD DELETES. Mutable tables carry `archived_at`; strictly append-only tables
-- carry none, because on a table where UPDATE is impossible an archive column is a
-- column permanently NULL (the 0004 header states this rule; this file obeys it).
--
-- Applied by the migration ledger. Never edited in place.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- CORRECTIVE: `person.birth_date`
-- -----------------------------------------------------------------------------
--
-- A DATE, not timestamptz, and the reasoning is the same as
-- `ledger_journal.posting_period` in 0004: a birthday is a calendar fact, not an
-- instant. Nobody is born at a particular UTC offset, and storing an instant would
-- mean "this person turned eighteen" resolves to a different day depending on the
-- reader's timezone.
--
-- It is NULLABLE on purpose. `person` is the identity root and most of its rows are
-- players the organisation has never asked for a passport from. NOT NULL here would
-- either force a fabricated date or exclude the people the product exists to manage.
-- NULL means UNKNOWN; it never means adult, and `majority_status()` is where that
-- distinction is made.
-- -----------------------------------------------------------------------------

ALTER TABLE person ADD COLUMN birth_date date;

COMMENT ON COLUMN person.birth_date IS
  'Calendar date of birth. NULL means UNKNOWN, never "adult": majority_status() returns ''unknown'' for it. A date rather than an instant because a birthday is a calendar fact, not a moment (the reasoning of ledger_journal.posting_period in 0004).';

-- -----------------------------------------------------------------------------
-- AGE OF MAJORITY — IN EXACTLY ONE PLACE
-- -----------------------------------------------------------------------------

-- Returns 'minor', 'adult' or 'unknown'. Three values rather than two, because the
-- implicit binary was "no birth date recorded therefore adult", and a binary that
-- cannot express "we do not know" is how an unknown becomes a false permission.
--
-- The threshold 18 lives HERE AND NOWHERE ELSE. It is a legal parameter that varies
-- by jurisdiction and this schema deliberately does not pretend to know which applies
-- where; what it does is make the number impossible to change in one place and leave
-- three copies in another. `people.isolation.test.ts` asserts that no table in the
-- schema stores a majority boolean, so the value cannot be frozen into a column that
-- a query could consult while bypassing this function entirely.
CREATE OR REPLACE FUNCTION public.majority_status(p_birth_date date, p_on date)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
           WHEN p_birth_date IS NULL OR p_on IS NULL THEN 'unknown'
           WHEN p_on >= (p_birth_date + INTERVAL '18 years')::date THEN 'adult'
           ELSE 'minor'
         END
$$;

COMMENT ON FUNCTION public.majority_status(date, date) IS
  'minor | adult | unknown for a birth date on a reference date. The age-of-majority threshold is stated HERE AND NOWHERE ELSE: it is a jurisdiction-specific legal parameter, and scattering it would let two parts of the product disagree about who is a child.';

-- -----------------------------------------------------------------------------
-- ENUMERATIONS
-- -----------------------------------------------------------------------------

CREATE TYPE guardian_relationship AS ENUM
  ('parent', 'legal_guardian', 'grandparent', 'sibling', 'other');

CREATE TYPE contract_kind AS ENUM
  ('employment', 'player_agreement', 'contractor', 'nda', 'sponsorship', 'talent_loan', 'other');

CREATE TYPE acceptance_method AS ENUM
  ('electronic_signature', 'in_person_witnessed', 'imported_legacy');

-- How the acceptor's identity was established at the moment of acceptance. Kept
-- separate from `identity.method` in 0001 because that table records WHICH login a
-- person HAS, and this records what was PROVED when they signed — a person may sign
-- a paper contract in a venue with no login at all (ADR-0018 explicitly permits a
-- person to exist without credentials).
CREATE TYPE acceptance_identity_method AS ENUM
  ('email_otp', 'sso', 'government_id', 'in_person_document', 'witnessed_oath');

CREATE TYPE compensation_kind AS ENUM
  ('salary', 'match_fee', 'win_bonus', 'per_diem', 'appearance_fee', 'retainer', 'other');

CREATE TYPE hr_record_state AS ENUM
  ('draft', 'offered', 'onboarding', 'active', 'leave', 'suspended', 'notice', 'terminated', 'offboarded');

CREATE TYPE person_document_kind AS ENUM
  ('identity', 'right_to_work', 'tax_form', 'contract', 'bank_details', 'medical', 'background_check', 'other');

-- -----------------------------------------------------------------------------
-- CORRECTIVE: `guardian_consent`
--
-- The 0001 shape, and the three reasons it cannot stand:
--
--   * It has no org_id, so consent given to one organisation silently authorised
--     every other one. A guardian who agreed to a roster spot in Org A had agreed to
--     nothing in Org B, and the schema could not tell the difference.
--   * It has no engagement_id, so it is a GLOBAL FLAG: "this minor's guardian said
--     yes, somewhere, at some point, to something". A consent not bound to the thing
--     consented to is not consent, it is a note.
--   * It carries `revoked_at` on a table that must be append-only. A revocation
--     column whose UPDATE is impossible is a column permanently NULL. Dropped, and
--     replaced by `guardian_consent_revocation`.
--
-- The ALTERs are staged — nullable first, NOT NULL immediately after — so that a
-- pre-existing row is MIGRATED rather than silently dropped, while a row written
-- after this migration still cannot omit the tenant, the engagement or the
-- relationship. `SET NOT NULL` with no default: a tenant cannot be invented for a
-- consent that already exists, and a migration that guessed one would attach a real
-- guardian's consent to an organisation nobody chose. Failing loudly is correct.
-- -----------------------------------------------------------------------------

ALTER TABLE guardian_consent ADD COLUMN org_id uuid REFERENCES organization(id) ON DELETE CASCADE;
ALTER TABLE guardian_consent ADD COLUMN engagement_id uuid;
ALTER TABLE guardian_consent ADD COLUMN guardian_person_id uuid REFERENCES person(id) ON DELETE RESTRICT;
ALTER TABLE guardian_consent ADD COLUMN relationship guardian_relationship;

-- One organisation's consent is one organisation's business. An org cannot both grant
-- and lose sight of it.
ALTER TABLE guardian_consent ADD CONSTRAINT guardian_consent_org_id_id_key UNIQUE (org_id, id);

ALTER TABLE guardian_consent ALTER COLUMN org_id          SET NOT NULL;
ALTER TABLE guardian_consent ALTER COLUMN engagement_id    SET NOT NULL;
ALTER TABLE guardian_consent ALTER COLUMN relationship     SET NOT NULL;

-- A guardian cannot be the person they are guarding.
--
-- This is the hard case, and it is made IMPOSSIBLE rather than handled, because the
-- alternative — "a self-consent is allowed as long as a second guardian also signs"
-- — is worse than useless. It admits a record that names a person as the independent
-- authority consenting to their own engagement, which is exactly the unverifiable
-- claim the whole People context is built to exclude. Independence of the consenting
-- party is not a field the schema can verify; it is a condition the schema refuses to
-- represent. Whether a court accepts a guardian is a legal question this schema does
-- not answer; that the guardian is a DIFFERENT PERSON is a fact it can hold.
ALTER TABLE guardian_consent ADD CONSTRAINT guardian_consent_not_self_check
  CHECK (guardian_person_id IS DISTINCT FROM person_id);

-- ------------------------------------------------------------------ PROBLEM
-- `guardian_consent` in 0001 declared `person_id ... ON DELETE CASCADE`. On an
-- append-only table a CASCADE is a silent hard delete: erasing a person would erase
-- the evidence that they were ever a minor, which is the one row nobody may remove.
-- Changed to RESTRICT. (Corrective migration, not an edit to 0001.)
-- ------------------------------------------------------------------ PROBLEM
ALTER TABLE guardian_consent DROP CONSTRAINT guardian_consent_person_id_fkey;
ALTER TABLE guardian_consent ADD CONSTRAINT guardian_consent_person_fk
  FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE RESTRICT;

-- Revocation is a record, not a mutation. See `guardian_consent_revocation` below.
ALTER TABLE guardian_consent DROP COLUMN revoked_at;

CREATE INDEX guardian_consent_org_idx            ON guardian_consent (org_id);
CREATE INDEX guardian_consent_org_engagement_idx ON guardian_consent (org_id, engagement_id);
CREATE INDEX guardian_consent_org_person_idx     ON guardian_consent (org_id, person_id);

-- At most one live guardian consent per engagement. A second, different guardian for
-- the same engagement is refused: consent to an engagement is a fact about that
-- engagement, and two guardians "consented" to it means neither of them did.
CREATE UNIQUE INDEX guardian_consent_one_per_engagement_key
  ON guardian_consent (org_id, engagement_id);

COMMENT ON TABLE guardian_consent IS
  'One guardian''s consent to ONE engagement for ONE organisation, for a person known to be a minor on the engagement''s start date. Append-only: a withdrawal is a separate row in guardian_consent_revocation, never an UPDATE, because an UPDATE would destroy the record that consent was once given and then taken back.';

COMMENT ON COLUMN guardian_consent.guardian_person_id IS
  'The guardian as an identity this platform knows, so the consent is provable against a real party rather than a typed name. NULL is permitted only for an offline guardian, who must then be evidenced by document_asset_id — a name alone is not a party.';

-- The policy itself is created in the RLS block at the foot of this file, together
-- with every other table's, so that `guardian_consent` is not the one table whose
-- tenancy is defined somewhere else. What is asserted HERE is the FORCE, because
-- 0001 enabled RLS without forcing it and without ever writing a policy: the table
-- was enabled, which is a flag, and not isolated, which is a guarantee.

ALTER TABLE guardian_consent FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- THE CONTRACT
--
-- The agreement as a container, distinct from its versions. `contract` says WHO
-- agreed with WHOM and about WHAT; `contract_version` says what the text said at a
-- particular point. Keeping them apart is what makes "corrections are a new version"
-- expressible: a version is a fact about a moment, and a fact about a moment has no
-- UPDATE.
--
-- `contract` itself carries no content and is never accepted, so it is mutable and
-- carries `archived_at`.
-- -----------------------------------------------------------------------------

CREATE TABLE contract (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- The person who is a party to this contract. NOT NULL: a contract with no party is
  -- a document, and documents are a different table with a different lifecycle.
  person_id     uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  -- The engagement this contract governs, when it governs one. Nullable because an
  -- NDA can exist before any engagement does, and requiring the reverse would make
  -- "sign an NDA before an offer" unexpressible. The composite FK makes a
  -- cross-tenant engagement reference impossible when it IS set.
  engagement_id uuid,
  kind          contract_kind NOT NULL,
  title         varchar(200) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT contract_engagement_fk
    FOREIGN KEY (org_id, engagement_id) REFERENCES engagement (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT contract_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT contract_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX contract_org_idx          ON contract (org_id);
CREATE INDEX contract_org_person_idx   ON contract (org_id, person_id);
CREATE INDEX contract_org_engagement_idx ON contract (org_id, engagement_id);

-- -----------------------------------------------------------------------------
-- THE CONTENT HASH — COMPUTED, NOT ACCEPTED
--
-- `contract_content_hash` is the single definition of what a version's content IS.
-- Everything else in this file refers to it; nothing recomputes a hash any other way.
--
-- The canonical form is LENGTH-FRAMED (`name=len:value`), the same shape 0004 uses
-- for `snapshot_hash`. Framing is not decoration: a plain concatenation lets a
-- document whose text is "ab"+"c" hash identically to one whose text is "a"+"bc", so
-- two different contracts could share a hash and the hash would prove nothing about
-- which one was signed.
--
-- IMMUTABLE and pure. It reads no table and takes no tenant parameter, so it cannot
-- be the place where the tenant sneaks in.
--
-- WHAT IS AND IS NOT IN THE HASH
-- -----------------------------
-- The identity of the contract (org, contract, version number) is IN, because "this
-- text" is only evidence about a document when it is evidence about WHICH document.
-- The signing and expiry instants are OUT, deliberately: acceptance records them on
-- the acceptance row, and the whole point of property 3 is that an acceptance points
-- at one version — so putting the instant in the hash would make every acceptance
-- need a new version, which is exactly backwards.
--
-- REPLICATED from application code: the writer MAY compute this hash ahead of time
-- (in packages/core, where ADR-0010 puts business rules) and supply it. It may also
-- supply a wrong one, and the trigger below refuses the row. Both paths produce the
-- same bytes because both are the same function over the same inputs.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.contract_content_hash(
  p_contract_id     uuid,
  p_version_no      integer,
  p_title           text,
  p_document_body   text
)
RETURNS char(64)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT encode(
    sha256(convert_to(
      'contract_id=' || length(p_contract_id::text) || ':' || p_contract_id::text || E'\n'
      || 'version_no='  || length(p_version_no::text)  || ':' || p_version_no::text  || E'\n'
      || 'title='       || length(coalesce(p_title, ''))          || ':' || coalesce(p_title, '')          || E'\n'
      || 'document_body=' || length(coalesce(p_document_body, '')) || ':' || coalesce(p_document_body, '') || E'\n',
      'utf8'
    )),
    'hex'
  )::char(64)
$$;

COMMENT ON FUNCTION public.contract_content_hash(uuid, integer, text, text) IS
  'The content hash of one contract version, computed from the version''s identity and its stored text. The single definition of what a version''s content IS: length-framed so two different documents cannot share a hash by running their text together.';

-- -----------------------------------------------------------------------------
-- CONTRACT VERSIONS
--
-- Append-only. There is no UPDATE path here at all, and no `archived_at`: a version
-- is either a draft nobody has accepted, or an accepted fact, and a fact about a
-- moment is not edited. The sealing rule below narrows the INSERT side:
--
--   * Version 1 of a fresh contract is a draft and may be written freely.
--   * Once ANY version of a contract has been accepted, no further version may be
--     written without a `supersedes_id`, and the superseding version must number
--     exactly one above the highest version so far. So a correction is a new version
--     on an existing chain, never a replacement for an accepted one.
--
-- This is property 1 expressed as an INSERT guard rather than a mutation guard,
-- because on this table there is no mutation to guard.
-- -----------------------------------------------------------------------------

CREATE TABLE contract_version (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contract_id  uuid NOT NULL,
  version_no   integer NOT NULL,
  title        varchar(200) NOT NULL,
  -- The document itself. The hash below is a function of THIS text, so the text is
  -- the evidence and the hash is only ever a way of naming it.
  document_body text NOT NULL,
  content_hash char(64) NOT NULL,
  -- A correction names the version it replaces. The chain is the audit trail: it is
  -- what answers "which text was in force on the day the player was paid".
  supersedes_id uuid,
  -- Set when the author intended this version to be signed; it does NOT mean it was.
  -- Acceptance is a separate row and this flag cannot create one.
  is_draft     boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contract_version_contract_fk
    FOREIGN KEY (org_id, contract_id) REFERENCES contract (org_id, id) ON DELETE CASCADE,
  CONSTRAINT contract_version_supersedes_fk
    FOREIGN KEY (org_id, supersedes_id) REFERENCES contract_version (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT contract_version_body_check CHECK (btrim(document_body) <> ''),
  CONSTRAINT contract_version_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT contract_version_no_check CHECK (version_no >= 1),
  CONSTRAINT contract_version_hash_shape_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT contract_version_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX contract_version_org_idx        ON contract_version (org_id);
CREATE INDEX contract_version_org_contract_idx ON contract_version (org_id, contract_id);

-- One version number per contract. Without this, "version 2" could name two different
-- texts and an acceptance pointing at version 2 would be ambiguous — which is the
-- whole dispute this table exists to end.
CREATE UNIQUE INDEX contract_version_number_key
  ON contract_version (org_id, contract_id, version_no);

-- One successor per version: the correction history is a PATH, not a tree. A branch
-- would let two corrections claim the same predecessor and "which version replaced
-- which" would have two answers.
CREATE UNIQUE INDEX contract_version_supersedes_key
  ON contract_version (org_id, supersedes_id) WHERE supersedes_id IS NOT NULL;

COMMENT ON TABLE contract_version IS
  'One immutable version of one contract''s text. There is no UPDATE and no archived_at: a version is a fact about a moment, and a fact about a moment is not edited. Acceptance of one version never carries to another (contract_acceptance), which is why the chain matters more than the latest row.';

-- -----------------------------------------------------------------------------
-- PROPERTY 2 — THE HASH IS RECOMPUTED, NOT ACCEPTED
--
-- A BEFORE INSERT trigger, so the row never exists in a state the database would
-- refuse. `23514` (check_violation) is raised deliberately: a disagreeing hash is a
-- violated claim about the row's own contents, and the same SQLSTATE a CHECK on a
-- derived figure uses, so a caller distinguishing "the stored figure disagrees with
-- its inputs" from "some other shape error" gets the same answer here.
--
-- It covers UPDATE too. There is no UPDATE today; if a later migration adds one, this
-- trigger makes it useless to lie in it, and the absence of an UPDATE trigger becomes
-- a deliberate statement rather than an oversight.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_contract_version_hash()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_expected char(64);
BEGIN
  v_expected := public.contract_content_hash(NEW.contract_id, NEW.version_no, NEW.title, NEW.document_body);

  IF NEW.content_hash IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION
      'contract version % (contract %, version %): content_hash % is not the hash of the content stored on this row (%); the database computes the hash, so a hash that disagrees with the text is refused',
      NEW.id, NEW.contract_id, NEW.version_no, NEW.content_hash, v_expected
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_contract_version_hash() IS
  'Recomputes the version''s content hash from its own stored text and refuses the row when the supplied hash disagrees. A hash the database merely stores is a claim; a hash the database computes is evidence.';

REVOKE ALL ON FUNCTION public.guard_contract_version_hash() FROM PUBLIC;

CREATE TRIGGER contract_version_hash_is_computed
  BEFORE INSERT OR UPDATE ON contract_version
  FOR EACH ROW EXECUTE FUNCTION public.guard_contract_version_hash();

-- -----------------------------------------------------------------------------
-- PROPERTY 1 — A CONTRACT IS SEALED ONCE ANY VERSION IS ACCEPTED
--
-- The rule spans three rows (the new version, the contract it belongs to, and the
-- acceptances on that contract's versions), so it is a trigger rather than a CHECK.
--
-- WHY THE SEAL IS PER-CONTRACT AND NOT PER-VERSION
-- -----------------------------------------------
-- A per-version rule would say "an accepted version cannot change" — true, and not
-- enough. The dispute is "that was not the version I signed", and the dangerous move
-- is not editing version 1 after signing it; it is REPLACING version 1 with new text
-- under the same number, so that a later read of "version 1" returns an agreement the
-- signer never saw. Sealing the whole contract on first acceptance makes the version
-- NUMBER a stable name for the text that number always had.
--
-- The insert guard therefore requires, for any version written after the contract is
-- sealed:
--
--   * a `supersedes_id` — a correction names what it corrects;
--   * that predecessor to be the contract's CURRENT head, not some ancestor of it, so
--     the chain cannot be forked at a historical version and the head stays unique;
--   * `version_no` to be exactly one above the predecessor's — the numbering is a
--     sequence, not a label the writer chooses freely.
--
-- `exclusion_violation` (23P01) rather than check_violation, matching
-- `guard_performance_supersession` in 0007: this is what a declarative constraint
-- would raise for the same shape, so moving to one on a full server is not an
-- observable change to any caller.
--
-- SECURITY DEFINER because the acceptances it reads may belong to a version the
-- caller's policies would otherwise hide — which is precisely the row a caller most
-- needs to be checked against. REVOKEd from PUBLIC immediately below, so the
-- elevation is reachable only by writing a version.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_contract_version_sealing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sealed       boolean;
  v_head_id      uuid;
  v_head_no      integer;
BEGIN
  -- Is ANY version of this contract already accepted? One query, because the rule is
  -- about the contract and not about the version being written.
  SELECT EXISTS (
           SELECT 1
             FROM public.contract_acceptance a
             JOIN public.contract_version v ON v.org_id = a.org_id AND v.id = a.contract_version_id
            WHERE a.org_id = NEW.org_id
              AND v.contract_id = NEW.contract_id
         )
    INTO v_sealed;

  -- An unsealed contract is still being drafted. The very first version is untracked
  -- by definition (nothing supersedes it), which is what makes a draft editable in
  -- the only way this table permits: by adding the next version of it.
  IF NOT v_sealed THEN
    RETURN NEW;
  END IF;

  -- The head is the version nothing supersedes. There is exactly one on a well-formed
  -- chain, because contract_version_supersedes_key makes every predecessor claimed
  -- once and contract_version_number_key makes every number unique.
  SELECT v.id, v.version_no
    INTO v_head_id, v_head_no
    FROM public.contract_version v
   WHERE v.org_id      = NEW.org_id
     AND v.contract_id = NEW.contract_id
     AND NOT EXISTS (
           SELECT 1 FROM public.contract_version s
            WHERE s.org_id = NEW.org_id AND s.supersedes_id = v.id
         )
   ORDER BY v.version_no DESC
   LIMIT 1;

  IF NEW.supersedes_id IS NULL THEN
    RAISE EXCEPTION
      'contract % is sealed: version % has been accepted, so any further version must supersede the current version (% = version %) rather than exist alongside it',
      NEW.contract_id, NEW.contract_id, v_head_id, v_head_no
      USING ERRCODE = 'exclusion_violation';
  END IF;

  IF NEW.supersedes_id <> v_head_id THEN
    RAISE EXCEPTION
      'contract % is sealed: version % must supersede the current version (%), not %; a chain that forks at an old version gives "which text is current" two answers',
      NEW.contract_id, NEW.id, v_head_id, NEW.supersedes_id
      USING ERRCODE = 'exclusion_violation';
  END IF;

  IF NEW.version_no <> v_head_no + 1 THEN
    RAISE EXCEPTION
      'contract % is sealed: the next version is % (superseding version %), not %; a version number must mean one text forever',
      NEW.contract_id, v_head_no + 1, v_head_no, NEW.version_no
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_contract_version_sealing() IS
  'Once any version of a contract has been accepted, a further version must supersede the current one and number exactly one above it. Refuses a version that would exist alongside the accepted chain, fork it at an old version, or reuse a number.';

REVOKE ALL ON FUNCTION public.guard_contract_version_sealing() FROM PUBLIC;

-- The TRIGGER for this function is created below, immediately after
-- `contract_acceptance` exists. Declaring it here would work — plpgsql resolves its
-- statements lazily — but a trigger whose body reads a table declared two hundred
-- lines further down is a reader's problem for no benefit, and moving it costs
-- nothing.

-- -----------------------------------------------------------------------------
-- ACCEPTANCE — PROPERTY 3, 4 AND 5
--
-- Append-only, and never an UPDATE of a contract. It names ONE version, records WHO
-- accepted, WHEN, and UNDER WHAT IDENTITY, and pins the hash of the text that was in
-- front of them.
--
-- WHY THE HASH IS COPIED ONTO THE ACCEPTANCE
-- -------------------------------------------
-- The version's hash is already stored, and a composite FK would reach it. The copy
-- is not redundancy for its own sake: it is the thing that makes the acceptance
-- SELF-CONTAINING evidence. A reader holding one acceptance row — which is what gets
-- exported when a contract is disputed, and what a regulator's discovery request
-- returns — can see exactly which bytes were signed without a second query that might
-- resolve differently later. And because the trigger below recomputes it from the
-- version, the copy cannot drift from the thing it copies.
--
-- `accepted_by_person_id` may not be the contract's own party signing their own
-- contract? No — it may: a person absolutely signs their own contract. What must not
-- happen is an acceptance attributed to a person who is not a party to the contract
-- at all, so the trigger checks party membership rather than forbidding self-signing.
-- -----------------------------------------------------------------------------

CREATE TABLE contract_acceptance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contract_id       uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  -- WHO accepted.
  accepted_by_person_id uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  -- WHEN, as an instant. The instant acceptance happened, not the instant the row was
  -- written, so a backfilled acceptance sorts into the day it was signed.
  accepted_at      timestamptz NOT NULL,
  -- UNDER WHAT IDENTITY: how the acceptor's identity was established at that moment.
  -- Separate from `identity` (0001), which records which login a person HAS.
  identity_method  acceptance_identity_method NOT NULL,
  -- WHAT the identity resolved to at the time — the email address that received the
  -- OTP, the document number that was shown. A method with no subject is "we checked
  -- them somehow", which is not a provable acceptance.
  identity_assertion varchar(240) NOT NULL,
  method           acceptance_method NOT NULL,
  -- The hash of the text that was accepted, pinned at the moment of acceptance.
  content_hash     char(64) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contract_acceptance_version_fk
    FOREIGN KEY (org_id, contract_version_id) REFERENCES contract_version (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT contract_acceptance_contract_fk
    FOREIGN KEY (org_id, contract_id) REFERENCES contract (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT contract_acceptance_hash_shape_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT contract_acceptance_identity_assertion_check CHECK (btrim(identity_assertion) <> ''),
  CONSTRAINT contract_acceptance_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX contract_acceptance_org_idx        ON contract_acceptance (org_id);
CREATE INDEX contract_acceptance_org_contract_idx ON contract_acceptance (org_id, contract_id);
CREATE INDEX contract_acceptance_org_version_idx  ON contract_acceptance (org_id, contract_version_id);
CREATE INDEX contract_acceptance_org_person_idx   ON contract_acceptance (org_id, accepted_by_person_id);

-- At most ONE acceptance per version. A second acceptance of the same text is either
-- a double-click or a second signer, and in both cases "who accepted this version"
-- stops having one answer. A re-signature of corrected text is a NEW VERSION, which
-- is the entire mechanism.
CREATE UNIQUE INDEX contract_acceptance_one_per_version_key
  ON contract_acceptance (org_id, contract_version_id);

COMMENT ON TABLE contract_acceptance IS
  'One person''s acceptance of one specific version of one contract, naming the hash of the text they were shown. Append-only. Acceptance of version N is never acceptance of version N+1 — a later version is a later acceptance or it is nothing.';

-- The acceptance must name a version OF THIS CONTRACT, and the hash it pins must be
-- the hash of that version. Both would be reassuring to check and neither is
-- guaranteed by the foreign keys: a composite FK on (org_id, contract_version_id)
-- cannot know which contract the version belongs to, because contract_version's
-- identity includes its contract.
CREATE OR REPLACE FUNCTION public.guard_contract_acceptance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_version_contract uuid;
  v_version_hash     char(64);
  v_party            boolean;
BEGIN
  SELECT v.contract_id, v.content_hash
    INTO v_version_contract, v_version_hash
    FROM public.contract_version v
   WHERE v.org_id = NEW.org_id
     AND v.id     = NEW.contract_version_id;

  IF v_version_contract IS DISTINCT FROM NEW.contract_id THEN
    RAISE EXCEPTION
      'acceptance % names version % which belongs to contract %, not contract %',
      NEW.id, NEW.contract_version_id, v_version_contract, NEW.contract_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.content_hash IS DISTINCT FROM v_version_hash THEN
    RAISE EXCEPTION
      'acceptance % pins content_hash % but version % hashes to %; an acceptance that names text other than the text it accepted is not evidence of anything',
      NEW.id, NEW.content_hash, NEW.contract_version_id, v_version_hash
      USING ERRCODE = 'check_violation';
  END IF;

  -- The acceptor must be a party to the contract. Self-signing is ordinary and
  -- legitimate; signing somebody ELSE''s contract is not an acceptance, it is a
  -- forgery with a row in the table.
  SELECT EXISTS (
           SELECT 1 FROM public.contract c
            WHERE c.org_id    = NEW.org_id
              AND c.id        = NEW.contract_id
              AND c.person_id = NEW.accepted_by_person_id
         )
    INTO v_party;

  IF NOT v_party THEN
    RAISE EXCEPTION
      'acceptance % is attributed to person %, who is not a party to contract %',
      NEW.id, NEW.accepted_by_person_id, NEW.contract_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_contract_acceptance() IS
  'Refuses an acceptance that names a version of a different contract, pins a hash other than that version''s, or is attributed to somebody who is not a party to the contract.';

REVOKE ALL ON FUNCTION public.guard_contract_acceptance() FROM PUBLIC;

CREATE TRIGGER contract_acceptance_is_evidenced
  BEFORE INSERT ON contract_acceptance
  FOR EACH ROW EXECUTE FUNCTION public.guard_contract_acceptance();

-- Property 1's trigger, attached now that the table it reads exists.
CREATE TRIGGER contract_version_sealed_after_acceptance
  BEFORE INSERT ON contract_version
  FOR EACH ROW EXECUTE FUNCTION public.guard_contract_version_sealing();

-- -----------------------------------------------------------------------------
-- PROPERTY 5 — WITHDRAWAL IS A ROW, NOT A MUTATION
--
-- A withdrawal/revocation of consent or of an acceptance is a separate append-only
-- record. The two tables below exist so that the answer to "did they withdraw?" is a
-- query over events, never a column someone flipped.
--
-- WHY THIS IS NOT A `withdrawn_at` COLUMN
-- ---------------------------------------
-- A nullable timestamp on the acceptance would make withdrawal and acceptance the
-- same kind of fact: both would be properties of one row, and a withdrawal that
-- happened would be indistinguishable from one that was asserted later by whoever
-- last wrote the row. Making it a row means the withdrawal carries its own actor, its
-- own instant and its own reason — and that the acceptance row, which is evidence
-- that someone signed, cannot be edited by the same act that undoes it.
-- -----------------------------------------------------------------------------

CREATE TABLE acceptance_withdrawal (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  acceptance_id uuid NOT NULL,
  withdrawn_by_person_id uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  withdrawn_at  timestamptz NOT NULL,
  reason        varchar(400) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acceptance_withdrawal_acceptance_fk
    FOREIGN KEY (org_id, acceptance_id) REFERENCES contract_acceptance (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT acceptance_withdrawal_reason_check CHECK (btrim(reason) <> ''),
  CONSTRAINT acceptance_withdrawal_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX acceptance_withdrawal_org_idx        ON acceptance_withdrawal (org_id);
CREATE INDEX acceptance_withdrawal_org_acceptance_idx ON acceptance_withdrawal (org_id, acceptance_id);

-- One withdrawal per acceptance. A second withdrawal of the same acceptance is a
-- duplicate notification, not a second event.
CREATE UNIQUE INDEX acceptance_withdrawal_one_per_acceptance_key
  ON acceptance_withdrawal (org_id, acceptance_id);

COMMENT ON TABLE acceptance_withdrawal IS
  'One withdrawal of one acceptance. A row, not a column on contract_acceptance: the acceptance is evidence that someone signed, and the same act that undoes it must not be able to edit it.';

-- -----------------------------------------------------------------------------
-- APPEND-ONLY, ENFORCED
--
-- Two independent mechanisms, deliberately redundant and failing in opposite
-- directions, exactly as 0004 does for the money tables. The GRANT denies the
-- application role the operation; the trigger denies it to EVERYONE including the
-- schema owner running a migration by hand. Either alone leaves a path open — a
-- privilege grant silently widened later, or an operator with psql.
--
-- `insufficient_privilege` (42501) for both, so a caller sees "you may not do this"
-- whichever one refused, which is the truth.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.deny_people_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted; record the change as a new row',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

COMMENT ON FUNCTION public.deny_people_append_only_mutation() IS
  'Blocks UPDATE and DELETE on the People tables where history is the product: a version, an acceptance, a withdrawal and a consent. Correction is a new row, never an edit.';

REVOKE ALL ON FUNCTION public.deny_people_append_only_mutation() FROM PUBLIC;

CREATE TRIGGER contract_version_append_only
  BEFORE UPDATE OR DELETE ON contract_version
  FOR EACH ROW EXECUTE FUNCTION public.deny_people_append_only_mutation();

CREATE TRIGGER contract_acceptance_append_only
  BEFORE UPDATE OR DELETE ON contract_acceptance
  FOR EACH ROW EXECUTE FUNCTION public.deny_people_append_only_mutation();

CREATE TRIGGER acceptance_withdrawal_append_only
  BEFORE UPDATE OR DELETE ON acceptance_withdrawal
  FOR EACH ROW EXECUTE FUNCTION public.deny_people_append_only_mutation();

CREATE TRIGGER guardian_consent_append_only
  BEFORE UPDATE OR DELETE ON guardian_consent
  FOR EACH ROW EXECUTE FUNCTION public.deny_people_append_only_mutation();

-- The withdrawal of a guardian consent. Separated from the consent for the same
-- reason a withdrawal of an acceptance is separated from the acceptance: the row
-- that records that consent was given must not be editable by the act that takes it
-- back.
CREATE TABLE guardian_consent_withdrawal (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  guardian_consent_id uuid NOT NULL,
  withdrawn_by_person_id uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  withdrawn_at        timestamptz NOT NULL,
  reason              varchar(400) NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guardian_consent_withdrawal_consent_fk
    FOREIGN KEY (org_id, guardian_consent_id) REFERENCES guardian_consent (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT guardian_consent_withdrawal_reason_check CHECK (btrim(reason) <> ''),
  CONSTRAINT guardian_consent_withdrawal_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX guardian_consent_withdrawal_org_idx        ON guardian_consent_withdrawal (org_id);
CREATE INDEX guardian_consent_withdrawal_org_consent_idx ON guardian_consent_withdrawal (org_id, guardian_consent_id);

CREATE UNIQUE INDEX guardian_consent_withdrawal_one_per_consent_key
  ON guardian_consent_withdrawal (org_id, guardian_consent_id);

COMMENT ON TABLE guardian_consent_withdrawal IS
  'One withdrawal of one guardian consent. A row, not a column on guardian_consent: the consent is evidence that a guardian agreed, and the act that takes it back must not be able to edit it.';

CREATE TRIGGER guardian_consent_withdrawal_append_only
  BEFORE UPDATE OR DELETE ON guardian_consent_withdrawal
  FOR EACH ROW EXECUTE FUNCTION public.deny_people_append_only_mutation();

-- -----------------------------------------------------------------------------
-- IS A CONSENT VALID ON A GIVEN DATE
--
-- The one question the minors rules turn on, asked in one place so that the answer
-- cannot differ between the guard below and anything a screen displays.
--
-- Three ways a consent stops covering an engagement:
--
--   * it was never given for THIS engagement (the composite FK already guarantees
--     the linkage, and this is re-asserted so the function is safe to call alone);
--   * it was withdrawn (an event exists);
--   * it expired before the engagement began (expires_at is a stored instant, not a
--     flag, so "is it still valid" is arithmetic rather than an assertion).
--
-- TWO ENTRY POINTS, ONE DEFINITION, DELIBERATELY
-- ------------------------------------------------
-- `guardian_consent_covers_in_org` is the definition and it takes an explicit
-- organisation. `guardian_consent_covers` is the application-facing wrapper that
-- supplies the tenant from the session (ADR-0011 rule 3).
--
-- The split is not tidiness. The integrity trigger BELOW must call the definition,
-- not the wrapper, because a trigger firing on `engagement` already knows the row's
-- own org_id and must not consult `current_org_id()` for it. Two reasons, and the
-- second is the serious one:
--
--   * `current_org_id()` is NULL whenever `app.org_id` is unset, so a guard written
--     against it would silently permit every minor engagement whenever the write
--     came from a maintenance session, a migration, or a superuser — precisely the
--     sessions in which nobody is watching.
--   * Worse, it makes integrity depend on session state an attacker controls. A
--     session that set `app.org_id` to another tenant could change which consent
--     rows the guard reads, and the constraint would be evaluated against a tenant
--     the row does not belong to.
--
-- A constraint that can be switched off by not setting a variable is not a
-- constraint.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guardian_consent_covers_in_org(
  p_org_id uuid,
  p_person_id uuid,
  p_engagement_id uuid,
  p_from_instant timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.guardian_consent gc
      LEFT JOIN public.guardian_consent_withdrawal w
        ON w.org_id = gc.org_id AND w.guardian_consent_id = gc.id
     WHERE gc.org_id           = p_org_id
       AND gc.person_id        = p_person_id
       AND gc.engagement_id    = p_engagement_id
       -- An INSTANT comparison, not a date one. `expires_at` is the instant the
       -- consent stops covering, so the only correct test is "the engagement begins
       -- before the consent ends". Converting the engagement's start to a calendar
       -- date and back again would make the answer depend on the session's
       -- TimeZone — and the local PGlite session is not UTC, so a consent expiring
       -- at midnight could read as covering an engagement that began the previous
       -- day. Same reasoning as `person_document_expiry_status`, and for the same
       -- reason: a half-open interval on instants has no timezone in it.
       AND (gc.expires_at IS NULL OR gc.expires_at > p_from_instant)
       AND w.id IS NULL
  )
$$;

COMMENT ON FUNCTION public.guardian_consent_covers_in_org(uuid, uuid, uuid, timestamptz) IS
  'Whether a guardian''s consent covers this person for this engagement in this organisation, starting at an instant: granted, not withdrawn, and not expired by then. Takes an explicit organisation because it is the definition the integrity trigger uses, and a constraint must not depend on session state.';

CREATE OR REPLACE FUNCTION public.guardian_consent_covers(
  p_person_id uuid,
  p_engagement_id uuid,
  p_from_instant timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.guardian_consent_covers_in_org(
    public.current_org_id(), p_person_id, p_engagement_id, p_from_instant)
$$;

COMMENT ON FUNCTION public.guardian_consent_covers(uuid, uuid, timestamptz) IS
  'Whether a guardian''s consent covers this person for this engagement, starting at an instant. Takes no organisation argument — the tenant comes from the session (ADR-0011 rule 3), and an unset context fails closed.';

-- -----------------------------------------------------------------------------
-- MINORS CANNOT BE ENGAGED WITHOUT GUARDIAN CONSENT
--
-- A trigger on `engagement`, which is the actual gate. Without it, the minor rules
-- are a note next to an unguarded column — the same shape as the legacy system,
-- which recorded a guardian's name and then engaged whoever it liked.
--
-- THE THRESHOLD IS NOT SCATTERED: this reads public.majority_status() and nothing
-- else. There is no 18 here.
--
-- WHY THE REFERENCE DATE IS valid_from AND NOT now()
-- -----------------------------------------------
-- A player who is 17 today and turns 18 next month is engageable next month. Judging
-- them by the clock at insert time would refuse a contract that is correct on the day
-- it starts, and would let the same engagement be legal or illegal depending on when
-- somebody re-ran the query. `valid_from` is the instant the engagement exists, so
-- that is the date the age question is asked.
--
-- WHY THE GUARD IS DEFERRABLE AND INITIALLY DEFERRED
-- -------------------------------------------------
-- A deferrable constraint trigger, because the obvious insert order is impossible
-- otherwise: consent names an engagement (FK), so the engagement must exist first,
-- but the engagement needs consent to exist. Deferring to COMMIT lets one transaction
-- write the engagement and its consent in the order it actually happens, while still
-- refusing the COMMIT if the consent was never written. An IMMEDIATE trigger would
-- make the domain unexpressible and would be disabled by the first person who hit it.
--
-- The same deferral is what makes the reverse case work: a person whose guardian
-- withdraws consent after the engagement is written cannot have the engagement
-- retroactively un-written either (it is history), so the verdict is asked ONCE per
-- set of judged inputs and not revisited.
--
-- WHICH IS WHY THE TRIGGER LISTENS TO SPECIFIC COLUMNS
-- ------------------------------------------------------
-- `AFTER INSERT OR UPDATE OF person_id, valid_from, is_age_restricted` — and not a
-- bare `OR UPDATE`. The guard's inputs are those three columns and nothing else, so
-- those are the only changes that can change the answer.
--
-- A bare `OR UPDATE` would make the guard re-judge the WHOLE historical row every
-- time anything at all was written to it — including `valid_to`, which is how an
-- engagement is closed. The consequence is not theoretical: a guardian withdrawing
-- consent would make the existing engagement row UNWRITABLE, because closing it
-- would re-run the guard against a consent that no longer exists. History would be
-- frozen by a later event, and an org could not record that a contract ended. That is
-- precisely the "rewrite history on the strength of a later event" this section
-- exists to prevent, reached by the opposite route.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_minor_engagement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_birth date;
  v_status text;
BEGIN
  SELECT p.birth_date INTO v_birth FROM public.person p WHERE p.id = NEW.person_id;

  v_status := public.majority_status(v_birth, (NEW.valid_from AT TIME ZONE 'UTC')::date);

  -- An age-restricted engagement is the case where the law REQUIRES proof of age, so
  -- there an absent birth date is a refusal rather than an unknown. This is the strict
  -- half of the rule; the guard below is the lenient half, and the asymmetry is
  -- deliberate and is stated in the file header.
  IF NEW.is_age_restricted AND v_birth IS NULL THEN
    RAISE EXCEPTION
      'engagement % is age-restricted but person % has no recorded birth_date; an age-restricted engagement cannot be created without proof of age',
      NEW.id, NEW.person_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_status = 'minor' THEN
    -- NEW.org_id, NOT current_org_id(). See the note on guardian_consent_covers: an
    -- integrity trigger must evaluate against the row it fires on, not against
    -- whatever tenant the session happens to name.
    IF NOT public.guardian_consent_covers_in_org(NEW.org_id, NEW.person_id, NEW.id, NEW.valid_from) THEN
      RAISE EXCEPTION
        'engagement % engages person %, who is a minor on % (born %); a guardian consent for THIS engagement is required, and none is in force',
        NEW.id, NEW.person_id,
        to_char((NEW.valid_from AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD'), v_birth
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.guard_minor_engagement() IS
  'Refuses a COMMIT that would engage a known minor without a guardian consent covering that exact engagement from its start instant, and refuses an age-restricted engagement for a person with no recorded birth date. Deferred, because consent names an engagement and so cannot be written first. Wired to INSERT and to changes of person_id / valid_from / is_age_restricted ONLY, so closing an engagement never re-judges it against a consent withdrawn since.';

REVOKE ALL ON FUNCTION public.guard_minor_engagement() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER engagement_minor_requires_guardian_consent
  AFTER INSERT OR UPDATE OF person_id, valid_from, is_age_restricted ON engagement
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.guard_minor_engagement();

-- -----------------------------------------------------------------------------
-- COMPENSATION
--
-- A pay figure is a contract with numbers in it, and it is disputed exactly the same
-- way: "that is not what I was signed up for". So it takes the same discipline as a
-- contract — append-only, superseded rather than edited, money as numeric(18,4)
-- beside an ISO-4217 currency (ADR-0003; never an integer minor unit, never a float).
--
-- `compensation_agreement` is the CONTAINER (who, for what engagement, what kind of
-- money); `compensation_figure` is the VERSIONED content, mirroring
-- contract/contract_version exactly. The split is the point: an agreement's identity
-- is stable, its figures move, and a dispute is always about which figure was in
-- force on a date — a question with one answer per version and no answer at all if
-- the figure lives on the mutable row.
--
-- EFFECTIVE DATING follows the convention in 0002 (`valid_from`/`valid_to`,
-- `valid_to IS NULL` meaning current, `valid_to > valid_from`): half-open, so two
-- consecutive agreements meet without overlapping and none is current twice.
-- -----------------------------------------------------------------------------

CREATE TABLE compensation_agreement (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  person_id     uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  engagement_id uuid NOT NULL,
  kind          compensation_kind NOT NULL,
  title         varchar(200) NOT NULL,
  currency      varchar(3) NOT NULL,
  -- ANNUAL / PERIODIC figure. What it means depends on `kind`, which is why the kind
  -- is a column and not a convention: a "salary" of 3000000 and a "per_diem" of
  -- 3000000 are not the same claim, and nothing in the number says which.
  amount        numeric(18,4) NOT NULL,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT compensation_agreement_engagement_fk
    FOREIGN KEY (org_id, engagement_id) REFERENCES engagement (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT compensation_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  -- Non-negative, and the bound is on the numeric SCALE as well as the sign: a pay
  -- figure that overflows numeric(18,4) fails here with a readable error rather than
  -- later as a numeric_value_out_of_range in a payroll query nobody was looking at.
  CONSTRAINT compensation_amount_check CHECK (amount >= 0 AND amount < 1000000000000),
  CONSTRAINT compensation_valid_range_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT compensation_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT compensation_agreement_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX compensation_agreement_org_idx          ON compensation_agreement (org_id);
CREATE INDEX compensation_agreement_org_person_idx   ON compensation_agreement (org_id, person_id);
CREATE INDEX compensation_agreement_org_engagement_idx ON compensation_agreement (org_id, engagement_id);
CREATE INDEX compensation_agreement_org_valid_idx    ON compensation_agreement (org_id, valid_from);

-- At most one CURRENT agreement per (engagement, kind). The partial form rather than
-- a bare UNIQUE because superseding is legitimate and two live agreements are not:
-- without this, "what does this player currently earn" would have two answers and
-- every payroll query would need a tie-break nobody wrote down.
CREATE UNIQUE INDEX compensation_agreement_current_key
  ON compensation_agreement (org_id, engagement_id, kind)
  WHERE valid_to IS NULL AND archived_at IS NULL;

COMMENT ON TABLE compensation_agreement IS
  'One person''s pay agreement for one engagement. Mutable ONLY while it has never been contracted: once contract_acceptance names a contract covering this engagement, every figure on it is frozen and a change is a NEW agreement superseding this one, because a pay figure editable after signing is a different dispute.';

-- The freeze. `compensation_is_under_contract` is the query that answers "has anybody
-- signed anything about this engagement", and it is written once because a check that
-- existed in two places would eventually disagree with itself.
CREATE OR REPLACE FUNCTION public.compensation_is_under_contract(p_org_id uuid, p_engagement_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.contract c
      JOIN public.contract_version v
        ON v.org_id = c.org_id AND v.contract_id = c.id
      JOIN public.contract_acceptance a
        ON a.org_id = v.org_id AND a.contract_version_id = v.id
     WHERE c.org_id = p_org_id
       AND c.engagement_id = p_engagement_id
  )
$$;

CREATE OR REPLACE FUNCTION public.guard_compensation_freeze()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- DELETE is always refused. This table has no UPDATE path after a contract, but
    -- it has one before, and a rule that only guarded UPDATE would leave the door open
    -- for the whole time the table was still draft.
    RAISE EXCEPTION
      'compensation_agreement is not deletable; supersede it with a new agreement or archive it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Archiving is permitted at any time and is not a change to any figure, so it is
  -- allowed past the freeze. Only a change to the money or the window is not.
  IF NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.valid_to IS DISTINCT FROM OLD.valid_to
     OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.engagement_id IS DISTINCT FROM OLD.engagement_id
     OR NEW.kind IS DISTINCT FROM OLD.kind THEN

    IF public.compensation_is_under_contract(OLD.org_id, OLD.engagement_id) THEN
      RAISE EXCEPTION
        'compensation_agreement % covers engagement %, which is under an accepted contract; its figures cannot be changed, because the figure that applied when the contract was signed must remain answerable. Record a new agreement instead.',
        OLD.id, OLD.engagement_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_compensation_freeze() IS
  'Refuses DELETE on a compensation agreement, and refuses a change to any figure or effective date once an accepted contract covers the engagement. Archiving stays available: it is not a change to what was agreed.';

REVOKE ALL ON FUNCTION public.guard_compensation_freeze() FROM PUBLIC;

CREATE TRIGGER compensation_agreement_frozen_under_contract
  BEFORE UPDATE OR DELETE ON compensation_agreement
  FOR EACH ROW EXECUTE FUNCTION public.guard_compensation_freeze();

-- -----------------------------------------------------------------------------
-- HR LIFECYCLE — AN EXPLICIT STATE MACHINE WITH A TRANSITION TABLE
--
-- WHERE THE STATE IS STORED, AND WHAT ENFORTS THE TRANSITIONS. Stated here rather
-- than left for a reader to infer, because the honest answer is split:
--
--   * The CURRENT state is stored on `hr_record.state`. Not derived, not computed,
--     not cached — stored, so that "where is this person in their employment" is one
--     indexed read rather than a fold over a history.
--
--   * The ALLOWED TRANSITIONS are stored as DATA in `hr_state_transition`, one row
--     per legal (from_state, to_state) pair, seeded per organisation. This is a table
--     and not a constant in a trigger, so that the legal moves are queryable — a
--     compliance report on "what can happen to a suspended contract" is a SELECT,
--     not a reading of application source.
--
--   * The database DOES enforce them. A BEFORE UPDATE trigger refuses a state change
--     that has no row in the transition table, and refuses one whose declared
--     `requires_reason` is not satisfied by an actual reason. An application that
--     writes an illegal transition gets check_violation from the database, not a
--     silently illegal record.
--
--   * WHAT THE DATABASE DOES NOT ENFORCE, said plainly: it does not enforce WHO may
--     perform a transition. Row-level authorisation is packages/auth's concern, and a
--     migration cannot see which session a write came from. The state machine here is
--     about legality of the move, not authority to make it.
--
-- WHY NO `entered_at` PER STATE AND NO AUTO-ADVANCE
-- A transition trigger that auto-advanced a state on a timer would make the stored
-- state a function of the clock rather than of an event, and an HR record that says
-- someone is ACTIVE because nobody has run a job is a claim, not a fact. Every state
-- change is a write somebody chose to make, with a reason where the transition
-- demands one.
-- -----------------------------------------------------------------------------

CREATE TABLE hr_state_transition (
  -- An `id` like every other table, even though nothing references a transition by
  -- one. Carried for uniformity and for the tenancy rule it makes possible:
  -- UNIQUE (org_id, id) is what a child table needs in order to reference this one
  -- without a cross-tenant edge, and a rule that says "every tenant table has it"
  -- and then has one exception is a rule that will be copied.
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  from_state   hr_record_state NOT NULL,
  to_state     hr_record_state NOT NULL,
  -- Whether the move needs a stated reason. Terminations and suspensions do;
  -- ordinary progression does not. A reason required and not given is the failure
  -- this column exists to catch.
  requires_reason boolean NOT NULL DEFAULT false,
  description varchar(300),
  CONSTRAINT hr_state_transition_key UNIQUE (org_id, from_state, to_state),
  CONSTRAINT hr_state_transition_no_self_check CHECK (from_state <> to_state),
  CONSTRAINT hr_state_transition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX hr_state_transition_org_idx ON hr_state_transition (org_id);

-- The legal lifecycle. Seeded per organisation rather than held in a global table,
-- because an organisation that runs a bootcamp pipeline legitimately has states a
-- sponsorship org does not — and because a global table would be one more thing an
-- organisation could not be different about.
--
-- States NOT reachable from `draft` are the point of the table: `suspended` is only
-- reachable from `active`, so a record cannot be born suspended, and `terminated` is
-- a dead end except for `offboarded`, so a terminated person cannot silently become
-- active again.
CREATE OR REPLACE FUNCTION public.seed_hr_state_transition(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.hr_state_transition (org_id, from_state, to_state, requires_reason, description)
  VALUES
    (p_org_id, 'draft',       'offered',     false, 'Offer extended'),
    (p_org_id, 'draft',       'terminated',  true,  'Withdrawn before an offer was made'),
    (p_org_id, 'offered',     'onboarding',  false, 'Offer accepted'),
    (p_org_id, 'offered',     'terminated',  true,  'Offer declined or withdrawn'),
    (p_org_id, 'onboarding',  'active',      false, 'Onboarding complete'),
    (p_org_id, 'onboarding',  'terminated',  true,  'Onboarding abandoned'),
    (p_org_id, 'active',      'leave',       true,  'Extended leave'),
    (p_org_id, 'active',      'suspended',   true,  'Suspension'),
    (p_org_id, 'active',      'notice',      false, 'Notice given'),
    (p_org_id, 'leave',       'active',      false, 'Returned from leave'),
    (p_org_id, 'leave',       'notice',      true,  'Notice given while on leave'),
    (p_org_id, 'leave',       'terminated',  true,  'Terminated while on leave'),
    (p_org_id, 'suspended',   'active',      true,  'Suspension lifted'),
    (p_org_id, 'suspended',   'terminated',  true,  'Terminated while suspended'),
    (p_org_id, 'suspended',   'notice',      true,  'Notice given while suspended'),
    (p_org_id, 'notice',      'terminated',  true,  'Termination effective'),
    (p_org_id, 'notice',      'active',      true,  'Notice withdrawn'),
    (p_org_id, 'terminated',  'offboarded',  false, 'Offboarding complete')
  ON CONFLICT DO NOTHING;
END
$$;

COMMENT ON FUNCTION public.seed_hr_state_transition(uuid) IS
  'Seeds an organisation''s legal HR transitions. Data rather than code so the lifecycle is queryable, and per-organisation so an org with a different pipeline is not forced into this one.';

REVOKE ALL ON FUNCTION public.seed_hr_state_transition(uuid) FROM PUBLIC;

-- Fired when an organisation is created, so the machine exists before anybody can
-- write a record and there is no window in which a record could be written into an
-- organisation with an empty (and therefore "nothing is legal") transition set.
--
-- Empty-means-nothing-legal is the safe direction: an organisation whose seed failed
-- refuses every state change rather than accepting every one.
CREATE OR REPLACE FUNCTION public.on_organization_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.seed_hr_state_transition(NEW.id);
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.on_organization_created() IS
  'Seeds the HR state machine for a new organisation at creation, so no organisation can exist without one and every record is judged against a populated transition table.';

REVOKE ALL ON FUNCTION public.on_organization_created() FROM PUBLIC;

CREATE TRIGGER organization_seeds_hr_transitions
  AFTER INSERT ON organization
  FOR EACH ROW EXECUTE FUNCTION public.on_organization_created();

CREATE TABLE hr_record (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  person_id     uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  engagement_id uuid NOT NULL,
  state         hr_record_state NOT NULL DEFAULT 'draft',
  -- WHY the record is in this state, and the mandatory reason when the transition
  -- table says the move required one. Stored beside the state rather than on a
  -- separate transition-history table so that "why is this person suspended" is one
  -- indexed read; the reasons accumulate on the record the way a file does.
  state_reason  varchar(400),
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  state_changed_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT hr_record_engagement_fk
    FOREIGN KEY (org_id, engagement_id) REFERENCES engagement (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_record_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX hr_record_org_idx          ON hr_record (org_id);
CREATE INDEX hr_record_org_person_idx   ON hr_record (org_id, person_id);
CREATE INDEX hr_record_org_engagement_idx ON hr_record (org_id, engagement_id);
CREATE INDEX hr_record_org_state_idx    ON hr_record (org_id, state);

-- One CURRENT HR record per engagement. A person may be re-engaged later, and that is
-- a second record with a second window; but an engagement with two live HR records
-- would give "what state is this person in" two answers.
CREATE UNIQUE INDEX hr_record_current_key
  ON hr_record (org_id, engagement_id)
  WHERE archived_at IS NULL;

COMMENT ON TABLE hr_record IS
  'The current HR state of one engagement. The state is STORED here, and the legal transitions are DATA in hr_state_transition, enforced by a trigger — see the header for exactly what that does and does not guarantee.';

CREATE OR REPLACE FUNCTION public.guard_hr_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_requires boolean;
  v_known    boolean;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    -- Nothing about the lifecycle changed. An edit to the reason text alone is not a
    -- transition and is not guarded, because refusing it would make the row
    -- uneditable in every other respect too.
    RETURN NEW;
  END IF;

  SELECT t.requires_reason, true
    INTO v_requires, v_known
    FROM public.hr_state_transition t
   WHERE t.org_id     = OLD.org_id
     AND t.from_state = OLD.state
     AND t.to_state   = NEW.state;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'HR record % cannot move from % to %: no such transition is defined for this organisation. hr_state_transition is where the legal moves are recorded, and it is the authority — not application code.',
      OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_requires AND (NEW.state_reason IS NULL OR btrim(NEW.state_reason) = '') THEN
    RAISE EXCEPTION
      'HR record % moving from % to % requires a stated reason',
      OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  -- The actor is who moved it, not who created it. Without this, "who suspended
  -- this player" has no answer for anybody but the database.
  IF NEW.state_changed_by_person_id IS NULL THEN
    RAISE EXCEPTION
      'HR record % changed state from % to % without naming who made the change',
      OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_hr_transition() IS
  'Refuses an HR state change that hr_state_transition does not declare, a declared-but-reason-requiring change with no reason, and a change with no actor. Does not check WHO may make the transition — authorisation is not a database concern here and is not implied by this trigger.';

REVOKE ALL ON FUNCTION public.guard_hr_transition() FROM PUBLIC;

CREATE TRIGGER hr_record_transition_is_legal
  BEFORE UPDATE OF state ON hr_record
  FOR EACH ROW EXECUTE FUNCTION public.guard_hr_transition();

-- -----------------------------------------------------------------------------
-- DOCUMENTS AND EXPIRY
--
-- `issued_at` and `expires_at` are INSTANTS, not dates, and that is the whole point
-- of this section: a work permit that expires "at 00:00 on the 31st" and one that
-- expires "at 23:59 on the 30th" are different facts, and flattening either to a date
-- invents a day nobody agreed to.
--
-- `date` IS used in exactly one place in this table — `expiry_notice_days`, a notice
-- period — because a notice period is a count of days, not an instant. That column is
-- an integer, so the naming is what carries the unit, the same discipline 0007 applied
-- to `survival_time_seconds`.
--
-- THE BOUNDARY IS INCLUSIVE ON EXPIRY AND THE QUERY SAYS SO EXPLICITLY
-- ------------------------------------------------------------------
-- "What is expired as of date D" is asked of a `timestamptz` boundary constantly, and
-- the two halves of that sentence come apart at the exact instant:
--
--   expires_at <= D  says "already expired at D"
--   expires_at <  D  says "not expired until the moment AFTER D"
--
-- Which one is correct depends entirely on whether `expires_at` is the instant the
-- document STOPS being valid or the instant it CEASES to be valid. A document whose
-- `expires_at` is 00:00:00 on the 31st is valid for every second up to that instant
-- and expired AT it, so `expires_at <= D` is the correct reading and `expires_at < D`
-- would expire the document one instant early — at 23:59:59.999 on the 30th, a day
-- nobody wrote down.
--
-- So `person_document_expiry_status` below uses `<=` and says so in a COMMENT, and
-- the boundary is asserted by a named test at D-1ms, D exactly, and D+1ms. A reader
-- who disagrees with that reading can see exactly one line to change, and the change
-- is visible as a failing boundary test rather than as a silent off-by-one.
--
-- NO QUEUE, NO JOB, NO outbox row here. Reminding anybody about an expiry is
-- DELIVERY, and another package owns delivery; this table's whole job is to make the
-- question ANSWERABLE (`person_document_expiry_status`, plus the plain composite
-- index below for anyone who would rather write the predicate themselves). A
-- `next_reminder_at` column written by this schema would be a claim that a reminder
-- was scheduled, which is exactly the kind of claim ADR-0019 exists to stop storing.
-- -----------------------------------------------------------------------------

CREATE TABLE person_document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  person_id     uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  kind          person_document_kind NOT NULL,
  title         varchar(200) NOT NULL,
  -- WHERE the document is. The bytes live outside this database; this is the pointer
  -- and the checksum, and `document_hash` is what makes the pointer checkable.
  storage_ref   text NOT NULL,
  document_hash char(64) NOT NULL,
  -- WHEN IT WAS ISSUED and WHEN IT STOPS BEING VALID. Both instants, both NOT NULL
  -- for a document that can expire. An issued_at in the future is not refused — a
  -- signed contract is issued when it is signed, and a scheduled visa may be recorded
  -- before it exists — but the CHECK below refuses an expiry that PRECEDES its issue,
  -- which is not a future document but an arithmetic error.
  issued_at     timestamptz NOT NULL,
  expires_at    timestamptz,
  -- Days before expiry at which somebody should be told. An INTEGER because it counts
  -- days; naming it is the discipline, the type is just the consequence.
  expiry_notice_days integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT person_document_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT person_document_hash_shape_check CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT person_document_storage_check CHECK (btrim(storage_ref) <> ''),
  -- An expiry before the issue is not a very short document, it is a mistake, and it
  -- is the kind that makes "is this expired" answerable in a way nobody can defend.
  CONSTRAINT person_document_expiry_after_issue_check
    CHECK (expires_at IS NULL OR expires_at > issued_at),
  CONSTRAINT person_document_notice_days_check
    CHECK (expiry_notice_days IS NULL OR expiry_notice_days BETWEEN 0 AND 365)
);

CREATE INDEX person_document_org_idx      ON person_document (org_id);
CREATE INDEX person_document_org_person_idx ON person_document (org_id, person_id);

-- The expiry query, answered by an index rather than by a table scan. Leading with
-- org_id is the tenancy rule; `expires_at` follows because the only question anyone
-- asks this table in a loop is "what is about to expire".
CREATE INDEX person_document_org_expiry_idx ON person_document (org_id, expires_at);

-- At most one current document per (person, kind). Two current right-to-work checks
-- would leave "does this player have right to work" with two answers, and the second
-- one is presumably a replacement that was never marked as one.
CREATE UNIQUE INDEX person_document_current_key
  ON person_document (org_id, person_id, kind)
  WHERE archived_at IS NULL;

COMMENT ON TABLE person_document IS
  'One document belonging to one person, with the instants it was issued and stops being valid. Reminders are NOT scheduled here: delivery belongs to another package, and this table''s job is to make the question answerable.';

CREATE OR REPLACE FUNCTION public.person_document_expiry_status(p_as_of timestamptz)
RETURNS TABLE (
  document_id      uuid,
  person_id        uuid,
  kind             person_document_kind,
  title            varchar(200),
  issued_at        timestamptz,
  expires_at       timestamptz,
  expiry_notice_days integer,
  is_expired       boolean,
  seconds_to_expiry numeric
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT d.id,
         d.person_id,
         d.kind,
         d.title,
         d.issued_at,
         d.expires_at,
         d.expiry_notice_days,
         -- `<=` NOT `<`. `expires_at` is the instant validity ENDS, so a document is
         -- expired AT that instant and not one microsecond before it. Using `<` here
         -- would expire every document an instant early — at 23:59:59.999999 on the
         -- previous day — which is a day nobody agreed to. The boundary is asserted by
         -- a named test so that changing this line changes a failing test rather than
         -- silently shifting every expiry by a day.
         (d.expires_at <= p_as_of) AS is_expired,
         -- Numeric, not an interval: the caller wants a sortable number for "soonest
         -- first", and an interval does not order across a timestamptz gap without a
         -- cast that each caller would then have to remember.
         round(extract(epoch FROM (d.expires_at - p_as_of))::numeric, 0) AS seconds_to_expiry
    FROM public.person_document d
   WHERE d.org_id = public.current_org_id()
     AND d.archived_at IS NULL
     AND d.expires_at IS NOT NULL
     -- The same `<=` boundary as is_expired, so the two can never disagree: a
     -- document reported as expired by this filter is expired by the expression
     -- beside it. A query whose two halves could disagree is a query nobody trusts.
     AND d.expires_at <= p_as_of
   ORDER BY d.expires_at ASC, d.id ASC
$$;

COMMENT ON FUNCTION public.person_document_expiry_status(timestamptz) IS
  'Documents expired as of an instant, tenant-scoped from the session with no tenant parameter (ADR-0011 rule 3). The boundary is expires_at <= p_as_of: expiry is the instant validity ends, so a document is expired AT that instant, not one microsecond before. Returns every expired document with no cap and no silent truncation; the caller filters by severity.';

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- Enabled AND forced on every table this file creates, with the tenant predicate as
-- the whole policy and no IS NULL escape, so an unset tenant context hides every row
-- rather than exposing them (ADR-0015). `guardian_consent` was enabled but had NO
-- policy and NO org_id in 0001; both are corrected above, and the policy added here
-- is the first one it has ever had.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'contract','contract_version','contract_acceptance','acceptance_withdrawal',
    'compensation_agreement','hr_record','hr_state_transition','person_document',
    'guardian_consent','guardian_consent_withdrawal'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- PRIVILEGES
--
-- The GRANT is the second of the two independent append-only mechanisms. The trigger
-- above denies UPDATE and DELETE to everybody; the GRANT removes the application
-- role's permission before it can be attempted, so the refusal a caller sees is a
-- privilege error rather than a surprising one.
--
-- `hr_state_transition` gets NO INSERT for the application: it is seeded when the
-- organisation is created, and an organisation editing its own legal transitions is a
-- governance act belonging to a migration or an operator, not to the request path.
-- The same argument as 0004's `expense`: "exactly one component can create this row"
-- is a property of the GRANT rather than a convention two components agreed between
-- themselves.
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO raptor_app;

-- Mutable tables get INSERT and UPDATE. UPDATE is what makes a draft editable, a
-- compensation figure amendable BEFORE it is contracted, and an HR state machine
-- walkable — three different things that all need it, and the guards above are what
-- stop it being used for anything else.
GRANT SELECT, INSERT, UPDATE ON
  contract, compensation_agreement, hr_record, person_document
TO raptor_app;

-- Append-only tables: INSERT only. See the note below on why this is also a REVOKE.
GRANT SELECT, INSERT ON
  contract_version, contract_acceptance, acceptance_withdrawal,
  guardian_consent, guardian_consent_withdrawal
TO raptor_app;

GRANT SELECT ON hr_state_transition TO raptor_app;
REVOKE INSERT, UPDATE, DELETE ON hr_state_transition FROM raptor_app;

-- Append-only tables: SELECT and INSERT, and nothing else. Stated as an explicit
-- REVOKE as well as an absent GRANT, because 0001 granted ALL on `guardian_consent`
-- and this is where that grant is taken back.
REVOKE UPDATE, DELETE ON
  contract_version, contract_acceptance, acceptance_withdrawal,
  guardian_consent, guardian_consent_withdrawal
FROM raptor_app;

REVOKE DELETE ON contract, compensation_agreement, hr_record, person_document FROM raptor_app;

-- The reporting functions are SECURITY DEFINER for the ones that must read past a
-- policy (guardian_consent_covers, compensation_is_under_contract, guard_*), and
-- SECURITY INVOKER for the ones that only report. Both are revoked from PUBLIC and
-- granted explicitly, so a role in the database with no grants on these tables cannot
-- call them.
REVOKE ALL ON FUNCTION public.majority_status(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.contract_content_hash(uuid, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guardian_consent_covers_in_org(uuid, uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guardian_consent_covers(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compensation_is_under_contract(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.seed_hr_state_transition(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.on_organization_created() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_contract_version_hash() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_contract_version_sealing() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_contract_acceptance() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_minor_engagement() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_compensation_freeze() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_hr_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deny_people_append_only_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.person_document_expiry_status(timestamptz) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  public.majority_status(date, date),
  public.contract_content_hash(uuid, integer, text, text),
  public.guardian_consent_covers(uuid, uuid, timestamptz),
  public.person_document_expiry_status(timestamptz)
TO raptor_app;

-- RLS is worthless to a role that can switch it off. Restated at the end of the file,
-- as 0001, 0002, 0004, 0005, 0006 and 0007 each do.
-- Reassert the application role attributes. Portable across self-hosted and managed databases: enforces where the owner is a superuser, verifies otherwise (see ensure_raptor_app_hardened() in 0001_tenancy.sql).
SELECT ensure_raptor_app_hardened();

COMMIT;

-- ==========================================================================
-- SOURCE: packages/db/migrations/0009_commercial.sql
-- ==========================================================================

-- =============================================================================
-- packages/db/migrations/0009_commercial.sql
--
-- The COMMERCIAL + CONTENT bounded context, and the one public surface.
--
-- THE DESIGN PROBLEM THIS FILE EXISTS TO SOLVE
-- -------------------------------------------
-- The design spec closes Phase 5 on one sentence: "Obligation fulfilment provable end
-- to end". Read carefully, "end to end" is the whole of the claim. A sponsorship that
-- says "4 streams, 2 social posts, appear at the final" is provable only if every link in
-- that chain is separately checkable: what was owed, what was promised as evidence, what
-- was actually delivered, and what discharged it — with no step that can be quietly
-- skipped or faked. The failure this rebuild exists to prevent is an organisation marking
-- a sponsorship "fulfilled" with nothing behind it.
--
-- So the five properties below are enforced BY THE DATABASE, and each has a named test in
-- `src/commercial.isolation.test.ts`:
--
--   1. A parent obligation is NEVER directly fulfilled. It is discharged only as an
--      AGGREGATE of its parts.
--   2. Fulfilment requires evidence, and every evidence record carries its provenance:
--      who captured it, when, and whether a machine derived it or a human asserted it.
--   3. Evidence is append-only. A retraction is a new row, never a mutation or a delete.
--   4. The whole chain is answerable from ONE query, and the stored parent state cannot
--      drift from it.
--   5. Quantities are exact, and over-fulfilment is a distinct reportable state.
--
-- Property 4 is where the design earns or loses. There are two ways to hold a discharge
-- state: store it and trust it, or derive it on every read. Deriving is honest but makes
-- "where is this sponsorship" a fold over evidence; storing is fast but is exactly the
-- flag that can drift. This file does BOTH and makes the stored value a CONSTRAINT on the
-- derived one:
--
--   * `obligation_derived_state_in_org` is the single definition of the aggregate.
--   * `contract_obligation.state` is the cached aggregate a screen reads.
--   * `assert_obligation_discharge_consistent` re-derives at COMMIT and refuses any
--     transaction that leaves the two disagreeing.
--
-- The stored value therefore cannot drift, including in the case a hand-set flag cannot
-- survive: a retraction of the last supporting evidence row, in a transaction that does
-- not also move the parent back. That is refused, and the legal path — retract AND move
-- the parent, in one transaction — is the same shape as the ledger reversal 0004 uses for
-- a posted entry. The alternative, letting the flag go stale, is the defect.
--
-- WHY INVENTORY IS A LEDGER, NOT A BALANCE
-- -----------------------------------------
-- ADR-0016 recorded a drifting balance in the legacy slot system as a real defect, and
-- 0004 refused the stored counter for budgets on exactly that ground: "the counter drifted
-- away from the ledger it claimed to summarise — which is how a budget stops meaning
-- anything while still being displayed." So there is no `on_hand` column anywhere in this
-- schema. `inventory_item` says what a thing is, `inventory_movement` says what happened,
-- and `inventory_position` derives the position on every read.
--
-- The one thing a ledger can still get wrong is handing out more than you hold, so that
-- is checked — at COMMIT, by a DEFERRABLE CONSTRAINT TRIGGER, because a batch of movements
-- for one delivery must be judged as a batch. An IMMEDIATE check would refuse a batch
-- that fits and admit one that does not, depending on the order the rows arrived in.
--
-- A COMMITMENT is a movement of kind `commitment` that changes the committed figure
-- WITHOUT changing what is owned. That is the whole of "what the org owns or has
-- committed", and keeping the two apart means `available = on_hand - committed` is a
-- derivation rather than a second counter that can disagree with the first.
--
-- WHY CREATORS ARE `person` ROWS
-- ------------------------------
-- ADR-0018 forbids a second identity model. A creator is therefore a `person` with a
-- `creator_profile` beside it — not a `creator` table carrying its own name, email and
-- credentials. `creator_profile.person_id` is NOT NULL and carries a SINGLE-COLUMN foreign
-- key, which is correct rather than a lapse: `person` is org-independent by design, so a
-- composite FK to it is neither expressible nor wanted. The test asserts the column list,
-- so a future migration that adds `creator_profile.email` fails rather than ships.
--
-- WHY IRREVERSIBILITY IS ENFORCED ON THE TRANSITION TABLE ITSELF
-- -----------------------------------------------------------
-- An `is_irreversible` column nobody reads is a comment. So irreversibility is enforced
-- where it can actually be broken: a transition marked one-way may not have its reverse
-- declared. A later migration, or an operator with psql, cannot quietly add
-- `signed → negotiation` after `negotiation → signed` was recorded as one-way. The guard
-- is on `partner_state_transition`, not on `partner`, because that is the only place the
-- damage can be done.
--
-- WHY AN INVOICE TOTAL IS A CONSTRAINT, NOT A COLUMN
-- --------------------------------------------------
-- 0004's reconciliation already made this argument for the ledger: a stored figure that
-- disagrees with the rows it summarises is a stored lie. So `invoice.total_amount` is
-- CHECKed against the sum of its lines at COMMIT, every line must be in the header's
-- currency (an invoice that balances across two currencies is a conversion performed at no
-- rate by nobody), an issued invoice must have at least one line, and `paid` requires a
-- settlement journal — so "paid" is not a claim the database cannot contradict.
--
-- THE PUBLIC SURFACE, AND WHERE PUBLIC COLLIDES WITH MULTI-TENANT
-- ----------------------------------------------------------------
-- This is the one place the two collide, so the decision is stated rather than implied.
--
-- MAY be read with NO tenant filter: an organisation's slug, display name and status, and
-- the PUBLISHED projections of its content items. Nothing else.
--
-- MUST NEVER be read with no tenant filter: obligations, evidence, retractions, invoices,
-- invoice lines, inventory movements, partners, creator private details, contracts, and
-- anything at all about a person.
--
-- The mechanism is NOT a `SECURITY DEFINER` view over the tenant tables. Such a view is
-- correct only while nobody remembers to widen it, and it re-introduces RLS elevation —
-- which is precisely what this schema spends 0001 through 0008 refusing to hand out.
-- Instead:
--
--   * `public_site_publication` is a DENORMALISED, publish-time MATERIALISATION carrying
--     only columns vetted as publishable when the row was written: id, org_id,
--     content_item_id, creator_handle, title, body, published_at. There is no obligation
--     id, no invoice, no amount, no contact, and no person id — not "hidden by policy",
--     but ABSENT.
--   * It is written by exactly one function, `publish_content_to_public_site`, which takes
--     the organisation from `current_org_id()` and NEVER from a parameter, and which
--     refuses content that is not in the `published` state. An unset tenant context fails
--     closed.
--   * `public_site_org` exposes three organisation columns and no more, so the public
--     role can be granted the projection and the org's public name and NOTHING else —
--     asserted over the catalogue, grant by grant.
--   * `public_site_content(slug)` reads those two, joins on `org_id` throughout, and
--     returns nothing for an organisation that is not `active`. It is SECURITY INVOKER,
--     so no elevation exists to misuse.
--
-- The consequence is the property the test asserts: a public read cannot cross an
-- organisation boundary because the address IS the boundary, and it cannot expose a
-- private fact because the public relation does not contain one.
--
-- TENANCY
-- -------
-- Identical to 0001/0002/0006/0007/0008 and not restated per table: org_id NOT NULL,
-- UNIQUE (org_id, id), every composite index leading with org_id, every FK between tenant
-- tables composite and including org_id, RLS ENABLED *and* FORCED with the tenant
-- predicate as the whole policy and no IS NULL escape (ADR-0015).
--
-- `public_site_publication` is the ONE deliberate exception and carries NO policy. That is
-- a decision with a mechanism rather than a gap: it is populated only through a
-- session-scoped publisher and holds no private column, and the test asserts both facts.
--
-- NO HARD DELETES. Mutable tables carry `archived_at`; strictly append-only tables carry
-- none, because on a table where UPDATE is impossible an archive column is a column
-- permanently NULL (the 0004 header states that rule; this file obeys it).
--
-- Applied by the migration ledger. Never edited in place.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- ENUMERATIONS
-- -----------------------------------------------------------------------------

-- What was promised. Each value is a thing a sponsor can be told they got, and each has
-- its own quantity and its own evidence — which is the whole point of the aggregate.
CREATE TYPE obligation_part_kind AS ENUM (
  'live_stream', 'social_post', 'appearance', 'video', 'logo_placement',
  'jersey_inclusion', 'content_delivery', 'custom'
);

-- Two values only. A third one — 'waived', 'at_risk', 'partially_fulfilled' — would be a
-- place for a caller to record a judgement the evidence does not support. The intermediate
-- position an obligation is genuinely in ("some parts done, some not") is carried by the
-- PARENT's state, which is derived; the part itself is binary on purpose.
CREATE TYPE obligation_part_state AS ENUM ('outstanding', 'fulfilled');

-- The cached aggregate, and the only states it may take. There is deliberately no
-- 'fulfilled' boolean: the string is the claim, the deferred trigger is what makes it
-- honest, and a boolean would let the same claim be expressed in a shape nothing checks.
CREATE TYPE obligation_discharge_status AS ENUM ('open', 'partially_fulfilled', 'discharged');

-- ADR-0019's finding was that the legacy system stored a hardcoded confidence of 85 beside
-- facts nobody could trace, so a machine read and a hand-typed row stayed
-- indistinguishable forever. The provenance is therefore a first-class enum with two
-- values, and the CHECK below binds each to the fields it actually requires — so neither
-- "an OCR row with nothing behind it" nor "a typed row wearing an OCR provenance" is
-- storable.
CREATE TYPE obligation_evidence_origin AS ENUM ('machine_derived', 'human_asserted');

CREATE TYPE partner_stage AS ENUM (
  'lead', 'qualified', 'negotiation', 'signed', 'active', 'lapsed'
);

CREATE TYPE content_stage AS ENUM (
  'draft', 'review', 'approved', 'scheduled', 'published', 'archived'
);

CREATE TYPE invoice_state AS ENUM ('draft', 'issued', 'paid', 'void');

-- WHY THE SIGN IS BOUND TO THE KIND
-- ----------------------------------
-- A receipt that subtracts is either a typo or a lie, and both make the derived position
-- wrong in a way nobody could later detect. `adjustment` is the only kind that may go
-- either way, because that is exactly what a recount is.
CREATE TYPE inventory_movement_kind AS ENUM (
  'receipt', 'issue', 'commitment', 'release', 'adjustment', 'write_off'
);

-- -----------------------------------------------------------------------------
-- THE PARTNERSHIP AND ITS OBLIGATIONS
-- -----------------------------------------------------------------------------

-- A partner is a commercial counterparty, NOT a person. The schema refuses to pretend
-- otherwise by giving this table no `person_id`: the people who work at a partner are
-- recorded where a contract needs them to be — as the party to `contract` — and inventing
-- a second identity model for an organisation's employees is exactly the ADR-0018 failure
-- wearing a CRM's clothes.
CREATE TABLE partner (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name         varchar(200) NOT NULL,
  -- The commercial relationship's terms of record, as first-class columns rather than a
  -- note. `stage` is the one a pipeline is filtered by; the rest is what a signed
  -- partnership looks like when someone asks what was agreed.
  legal_name   varchar(240),
  website_url  text,
  stage        partner_stage NOT NULL DEFAULT 'lead',
  stage_reason varchar(400),
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  stage_changed_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  -- An INSTANT, not a `date`. The legal reasoning is 0003's and 0004's: a calendar date
  -- flattened from an instant resolves to a different day per reader's timezone, and a
  -- signed agreement date is a fact about a moment.
  contracted_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT partner_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT partner_url_check CHECK (website_url IS NULL OR btrim(website_url) <> ''),
  CONSTRAINT partner_org_name_key UNIQUE (org_id, name),
  CONSTRAINT partner_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX partner_org_idx       ON partner (org_id);
CREATE INDEX partner_org_stage_idx ON partner (org_id, stage);

-- At most one LIVE partner by name. Two live rows with the same name make "who is our
-- Acme contact" ambiguous in a way a stage filter does not fix; a archived one coexists
-- because a former sponsor called Acme is still a former sponsor.
CREATE UNIQUE INDEX partner_current_name_key
  ON partner (org_id, name) WHERE archived_at IS NULL;

COMMENT ON TABLE partner IS
  'A commercial counterparty. NOT a person: the people at a partner are parties to a contract, not rows here. The current stage is STORED here and the legal transitions are DATA in partner_state_transition, enforced by a trigger.';

-- -----------------------------------------------------------------------------
-- THE OBLIGATION AND ITS PARTS
-- -----------------------------------------------------------------------------

-- The PROMISE. It carries no quantity and no fulfilment claim of its own beyond the
-- CACHED aggregate in `state`, which `assert_obligation_discharge_consistent` re-derives
-- at COMMIT. An obligation with no parts can never be discharged: nothing was promised in
-- a form that could be fulfilled, so nothing can have been.
CREATE TABLE contract_obligation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- The contract it was owed under. An obligation that names no contract is a wish, and
  -- the composite FK makes a cross-tenant reference to one unexpressible (ADR-0011).
  contract_id uuid NOT NULL,
  -- Which commercial relationship this was agreed with. Nullable because a legacy
  -- obligation imported from a contract sheet may predate any CRM record; when it IS set
  -- the composite FK still refuses another tenant's partner.
  partner_id  uuid,
  title       varchar(200) NOT NULL,
  description text,
  -- An INSTANT. A deadline that flattened to a date would make "was it late" resolve to a
  -- different day per reader's timezone (ADR-0003, and the legacy attendance backlog).
  due_at      timestamptz NOT NULL,
  -- The CACHED AGGREGATE. See the file header for why it exists and what stops it
  -- drifting. It is never a hand-set flag: the deferred trigger compares it with
  -- obligation_derived_state_in_org and refuses the COMMIT if they differ.
  state       obligation_discharge_status NOT NULL DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT contract_obligation_contract_fk
    FOREIGN KEY (org_id, contract_id) REFERENCES contract (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT contract_obligation_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES partner (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT contract_obligation_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT contract_obligation_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX contract_obligation_org_idx        ON contract_obligation (org_id);
CREATE INDEX contract_obligation_org_contract_idx ON contract_obligation (org_id, contract_id);
CREATE INDEX contract_obligation_org_partner_idx  ON contract_obligation (org_id, partner_id);
CREATE INDEX contract_obligation_org_due_idx      ON contract_obligation (org_id, due_at);
CREATE INDEX contract_obligation_org_state_idx    ON contract_obligation (org_id, state);

COMMENT ON TABLE contract_obligation IS
  'A promise owed under a contract. It is discharged only as an AGGREGATE of its parts: `state` is a cached aggregate that the database re-derives at COMMIT and refuses to let disagree with the parts and their evidence. An obligation with no parts is always ''open''.';

-- One part of a promise. A part is the unit that can be fulfilled, because a part has its
-- own quantity, its own deadline and its own evidence — "deliver 4 streams" cannot be
-- half done in a way a reader can check, whereas "3 of 4 streams delivered" can.
CREATE TABLE contract_obligation_part (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  obligation_id     uuid NOT NULL,
  kind              obligation_part_kind NOT NULL,
  -- A WHOLE COUNT, an integer, and never numeric(18,4): this is a number of streams, not
  -- money, and forcing it to a money scale would be a lie about what it is.
  promised_quantity integer NOT NULL,
  due_at            timestamptz NOT NULL,
  state             obligation_part_state NOT NULL DEFAULT 'outstanding',
  description       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  CONSTRAINT contract_obligation_part_obligation_fk
    FOREIGN KEY (org_id, obligation_id)
    REFERENCES contract_obligation (org_id, id) ON DELETE RESTRICT,
  -- Strictly positive. Zero is the "fulfilled with nothing behind it" defect wearing a
  -- quantity's name: a part promising nothing is discharged the instant it is created.
  CONSTRAINT contract_obligation_part_quantity_check CHECK (promised_quantity > 0),
  CONSTRAINT contract_obligation_part_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX contract_obligation_part_org_idx            ON contract_obligation_part (org_id);
CREATE INDEX contract_obligation_part_org_obligation_idx ON contract_obligation_part (org_id, obligation_id);
CREATE INDEX contract_obligation_part_org_due_idx        ON contract_obligation_part (org_id, due_at);

-- NO unique index on (obligation, kind, quantity), and this is a decision rather than an
-- omission. An earlier draft of this file had one, on the reasoning that "two parts that
-- say the same thing twice make the promise ambiguous". That is wrong: a sponsorship that
-- promises "a stream at the group stage and a stream at the final" is two live_stream
-- parts of one unit each, and an index shaped that way would make the most ordinary
-- sponsorship unrepresentable. What makes a part distinguishable is its `due_at` and its
-- `description`, both of which are already there, and neither of which a uniqueness rule
-- can summarise without forbidding a legitimate case.

COMMENT ON TABLE contract_obligation_part IS
  'One promised deliverable with a quantity, a deadline and a fulfilment state. Mutable only in `state` (and by archiving a part written in error); the promise itself — the kind and the quantity — is frozen because a changed quantity is a different promise. Two parts of the same kind are ordinary (a stream at the group stage and a stream at the final), so nothing keys on (obligation, kind).';

-- -----------------------------------------------------------------------------
-- EVIDENCE — PROPERTY 2 AND 3
-- -----------------------------------------------------------------------------

-- WHAT WAS ACTUALLY DELIVERED, as an append-only record.
--
-- Append-only with no `archived_at`, because on a table where UPDATE is impossible an
-- archive column is a column permanently NULL (0004's rule). A mistake is corrected by a
-- RETRACTION, which is its own row: the evidence that something was claimed is not
-- permitted to vanish because the claim turned out to be wrong.
CREATE TABLE obligation_evidence (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  obligation_part_id uuid NOT NULL,
  -- HOW MANY UNITS THIS PROVES. Not a boolean. "Four streams" is satisfied by four rows
  -- of one, or one row of four, or any mix — the aggregate sums them, so the shape of
  -- the evidence does not decide whether the promise was kept.
  quantity           integer NOT NULL,
  origin             obligation_evidence_origin NOT NULL,
  -- WHEN THE ARTEFACT WAS CAPTURED, as an instant. Not `created_at`: a backfilled
  -- capture belongs to the month the stream went live, and filtering a report on the
  -- insert timestamp is how backfilled history lands in the present bucket (ADR-0019).
  captured_at        timestamptz NOT NULL,
  -- WHO ASSERTED IT. Required for a human assertion, forbidden for a machine read: a
  -- person either stood behind the claim or the machine did, and a row claiming both is
  -- a row nobody can audit.
  captured_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  -- WHICH MACHINE, and HOW SURE IT WAS. Both required for a machine read, both forbidden
  -- for a human assertion. `confidence` has NO DEFAULT: the legacy OCR path wrote 85
  -- into every row, and a default is how a constant gets to look like a measurement.
  extractor          varchar(160),
  -- Deliberately WIDER than the 0..1 range the CHECK below enforces, rather than exactly
  -- as wide as it. numeric(5,4) would refuse the legacy value 85 with a storage overflow
  -- before the constraint ever ran, which would mean the constraint is never actually
  -- tested — and a bound that has only ever been enforced by a type width is a bound that
  -- a later `numeric` change silently removes. The column must be able to hold a wrong
  -- confidence so that the CHECK is what refuses it.
  confidence         numeric(9,4),
  -- WHERE THE BYTES ARE. The file or the VOD lives outside this database; this is the
  -- pointer, and the pointer is what makes the row checkable by a human who does not
  -- trust the database.
  source_ref         text NOT NULL,
  detail             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT obligation_evidence_part_fk
    FOREIGN KEY (org_id, obligation_part_id)
    REFERENCES contract_obligation_part (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT obligation_evidence_quantity_check CHECK (quantity > 0),
  CONSTRAINT obligation_evidence_source_ref_check CHECK (btrim(source_ref) <> ''),
  -- The provenance binding, BOTH directions, in one CHECK so the two halves cannot drift
  -- apart when somebody edits it:
  --   machine_derived — an extractor AND a stated confidence, and no asserting person.
  --   human_asserted  — an asserting person, and no extractor and no confidence.
  -- A machine read naming a person, or a human assertion naming a machine, is refused:
  -- both make a corrected or hand-typed row indistinguishable from a machine reading.
  CONSTRAINT obligation_evidence_provenance_binding_check CHECK (
        CASE WHEN origin = 'machine_derived'
             THEN (extractor IS NOT NULL AND confidence IS NOT NULL AND captured_by_person_id IS NULL)
             ELSE (captured_by_person_id IS NOT NULL AND extractor IS NULL AND confidence IS NULL)
        END
      ),
  CONSTRAINT obligation_evidence_extractor_check
    CHECK (extractor IS NULL OR btrim(extractor) <> ''),
  -- 0..1, so the legacy "85" is not storable in a column that means a proportion. This is
  -- the mechanical form of "a number presented as a measurement while being an invented
  -- constant is the precise failure this rebuild exists to eliminate".
  CONSTRAINT obligation_evidence_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT obligation_evidence_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX obligation_evidence_org_idx   ON obligation_evidence (org_id);
CREATE INDEX obligation_evidence_org_part_idx ON obligation_evidence (org_id, obligation_part_id);
CREATE INDEX obligation_evidence_org_origin_idx ON obligation_evidence (org_id, origin);

COMMENT ON TABLE obligation_evidence IS
  'One piece of evidence that a part was delivered, with its provenance: who captured it, when, and whether a machine derived it or a human asserted it. Append-only, and a mistake is corrected by a retraction rather than an UPDATE (obligation_evidence_retraction).';

-- The retraction. A row, not a column, for the reason 0008 gives for
-- `acceptance_withdrawal`: the evidence is a fact about what happened, so the act that
-- takes it back must not be able to edit it. Both rows exist afterwards, and the reason
-- travels with the retraction rather than being written over the claim.
CREATE TABLE obligation_evidence_retraction (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  obligation_evidence_id  uuid NOT NULL,
  retracted_by_person_id  uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  retracted_at            timestamptz NOT NULL,
  reason                  varchar(400) NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT obligation_evidence_retraction_evidence_fk
    FOREIGN KEY (org_id, obligation_evidence_id)
    REFERENCES obligation_evidence (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT obligation_evidence_retraction_reason_check CHECK (btrim(reason) <> ''),
  CONSTRAINT obligation_evidence_retraction_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX obligation_evidence_retraction_org_idx ON obligation_evidence_retraction (org_id);
CREATE INDEX obligation_evidence_retraction_org_evidence_idx
  ON obligation_evidence_retraction (org_id, obligation_evidence_id);

-- One retraction per evidence row. A second retraction of the same claim is a duplicate
-- notification, not a second event — and "was this retracted, and how many times" must
-- have one answer.
CREATE UNIQUE INDEX obligation_evidence_retraction_one_per_evidence_key
  ON obligation_evidence_retraction (org_id, obligation_evidence_id);

COMMENT ON TABLE obligation_evidence_retraction IS
  'One retraction of one evidence row. The evidence row survives and still says what it said; only the SUPPORT is withdrawn, and the reason travels with the retraction.';

-- -----------------------------------------------------------------------------
-- THE DERIVATION — ONE DEFINITION, WRITTEN ONCE
-- -----------------------------------------------------------------------------

-- How much of a part is actually supported, counting only evidence nobody has retracted.
--
-- The subtraction is expressed as a LEFT JOIN with an IS NULL test rather than
-- "subtract the retracted rows", because the two are equivalent only while a retraction
-- exists for zero or one row per evidence — which UNIQUE (org_id, obligation_evidence_id)
-- guarantees, but which a future migration could relax. The EXISTS form then keeps
-- meaning what it says.
CREATE OR REPLACE FUNCTION public.obligation_part_supported_quantity(p_org_id uuid, p_part_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT sum(e.quantity)::integer
      FROM public.obligation_evidence e
     WHERE e.org_id             = p_org_id
       AND e.obligation_part_id = p_part_id
       AND NOT EXISTS (
             SELECT 1
               FROM public.obligation_evidence_retraction r
              WHERE r.org_id                 = e.org_id
                AND r.obligation_evidence_id = e.id
           )
  ), 0)
$$;

COMMENT ON FUNCTION public.obligation_part_supported_quantity(uuid, uuid) IS
  'Units of a part supported by evidence that has not been retracted. Takes an EXPLICIT organisation because it is the definition the integrity triggers below use, and a constraint must not depend on session state (the reasoning of guardian_consent_covers_in_org in 0008).';

-- The state of one part, as a REPORTABLE string rather than a stored column.
--
-- Six states, and the two in the middle are the ones a naive schema cannot express:
--
--   not_started    outstanding, nothing evidenced. What the legacy system looked like.
--   in_progress    outstanding, some evidence exists. Real work, not yet a promise kept.
--   under_fulfilled 'fulfilled' on the part row while the evidence does not support it.
--                   Reachable ONLY by retracting evidence after fulfilment, which the
--                   part row — append-only evidence, immutable claim — cannot record. It
--                   is reported rather than hidden because hiding it is how a dispute
--                   becomes unanswerable.
--   fulfilled      'fulfilled' and supported exactly meets the promise.
--   over_fulfilled 'fulfilled' and the evidence EXCEEDS the promise.
--
-- THE DECISION ON OVER-FULFILMENT, stated because it is a judgement and not a law:
-- over-fulfilment does NOT block the discharge, and it is NOT an error. A sponsor who got
-- five streams instead of four is owed nothing further and the obligation IS discharged;
-- `over_fulfilled` is a reportable surplus. Refusing it would make generosity
-- unrepresentable — the org could not record that it over-delivered — and silently
-- absorbing it would make it unreportable, which is the defect this file exists to
-- remove. So the surplus is named, summed and shown, and the discharge proceeds.
CREATE OR REPLACE FUNCTION public.obligation_part_discharge_status(p_org_id uuid, p_part_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
           WHEN p.archived_at IS NOT NULL                        THEN 'archived'
           WHEN p.state = 'outstanding' AND s.supported = 0        THEN 'not_started'
           WHEN p.state = 'outstanding'                            THEN 'in_progress'
           WHEN s.supported <  p.promised_quantity                  THEN 'under_fulfilled'
           WHEN s.supported >  p.promised_quantity                  THEN 'over_fulfilled'
           ELSE 'fulfilled'
         END
  FROM public.contract_obligation_part p
  CROSS JOIN LATERAL (
    SELECT public.obligation_part_supported_quantity(p.org_id, p.id) AS supported
  ) s
 WHERE p.org_id = p_org_id
   AND p.id     = p_part_id
$$;

COMMENT ON FUNCTION public.obligation_part_discharge_status(uuid, uuid) IS
  'archived | not_started | in_progress | under_fulfilled | fulfilled | over_fulfilled for one part. Under-fulfilled means the part row claims fulfilment the evidence does not support — reachable only by retracting evidence, and REPORTED rather than hidden. Over-fulfilled is a reportable surplus and does NOT block the discharge.';

-- THE SINGLE DEFINITION OF DISCHARGE, and the thing property 4 turns on.
--
-- Three states and no fourth:
--
--   open                 no part is discharged. This includes "there are no parts at all",
--                        which is the purest form of the defect this file exists to
--                        prevent: nothing was promised in a checkable form, so nothing can
--                        have been delivered.
--   partially_fulfilled  at least one part is discharged and at least one is not.
--   discharged           the obligation has at least one part AND every one of them is
--                        fulfilled or over_fulfilled.
--
-- Two definitions on purpose, for the same reason 0008 splits
-- `guardian_consent_covers_in_org` from `guardian_consent_covers`: the integrity trigger
-- BELOW calls the one that takes an explicit organisation, because a trigger must evaluate
-- against the row it fires on and never against whatever tenant the session happens to
-- name. A constraint that can be switched off by not setting a variable is not a
-- constraint.
CREATE OR REPLACE FUNCTION public.obligation_derived_state_in_org(p_org_id uuid, p_obligation_id uuid)
RETURNS obligation_discharge_status
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH parts AS (
    SELECT p.id,
           p.state = 'fulfilled'
           AND public.obligation_part_supported_quantity(p.org_id, p.id) >= p.promised_quantity
             AS discharged
      FROM public.contract_obligation_part p
     WHERE p.org_id         = p_org_id
       AND p.obligation_id  = p_obligation_id
       AND p.archived_at IS NULL
  ),
  totals AS (
    SELECT count(*)::integer AS total,
           count(*) FILTER (WHERE discharged)::integer AS discharged
      FROM parts
  )
  -- The casts are schema-qualified because this function pins search_path to empty, and a
  -- body is parsed at CREATION time: an unqualified type name would not resolve there.
  -- That is a real constraint of the pinning, not a stylistic choice, and it is why every
  -- table and type in this file is referenced with its schema.
  SELECT CASE
           WHEN t.total = 0 OR t.discharged = 0 THEN 'open'::public.obligation_discharge_status
           WHEN t.discharged = t.total          THEN 'discharged'::public.obligation_discharge_status
           ELSE 'partially_fulfilled'::public.obligation_discharge_status
         END
    FROM totals t
$$;

COMMENT ON FUNCTION public.obligation_derived_state_in_org(uuid, uuid) IS
  'The aggregate discharge state of one obligation in one organisation, recomputed from its parts and their evidence. The SINGLE definition: contract_obligation.state is constrained to equal it at COMMIT, and every report reads it rather than reading the stored column. An obligation with no parts is always ''open''.';

-- The application-facing wrapper. It takes NO organisation argument (ADR-0011 rule 3), so
-- a caller cannot choose which tenant they ask about, and an unset context resolves to
-- NULL and therefore to ''open'' rather than to somebody else's data.
CREATE OR REPLACE FUNCTION public.obligation_derived_state(p_obligation_id uuid)
RETURNS obligation_discharge_status
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.obligation_derived_state_in_org(public.current_org_id(), p_obligation_id)
$$;

COMMENT ON FUNCTION public.obligation_derived_state(uuid) IS
  'The aggregate discharge state, with the tenant taken from the session. An unset context reads nothing, so it returns ''open'' rather than exposing another tenant''s obligation.';

-- -----------------------------------------------------------------------------
-- PROPERTY 2 — A PART CANNOT REACH 'fulfilled' WITHOUT THE EVIDENCE TO SUPPORT IT
-- -----------------------------------------------------------------------------

-- BEFORE UPDATE, so the row never exists in a state the database would refuse.
--
-- Immediate rather than deferred, deliberately. The ordering is not circular: evidence
-- names a part, so the part exists before the evidence does, so the evidence is always
-- written first and the claim second. Claiming fulfilment BEFORE the evidence exists is
-- not a legitimate ordering to support — it is the defect.
--
-- The comparison is `>=`, not `=`, because over-fulfilment is legitimate and reportable
-- (see obligation_part_discharge_status). What is refused is claiming more than has been
-- evidenced.
CREATE OR REPLACE FUNCTION public.guard_obligation_part_fulfilment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_supported integer;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state OR NEW.state <> 'fulfilled' THEN
    RETURN NEW;
  END IF;

  v_supported := public.obligation_part_supported_quantity(NEW.org_id, NEW.id);

  IF v_supported < NEW.promised_quantity THEN
    RAISE EXCEPTION
      'obligation part % cannot be marked fulfilled: % unit(s) promised, % evidenced. A fulfilment claim the evidence does not support is the defect this schema exists to prevent.',
      NEW.id, NEW.promised_quantity, v_supported
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_obligation_part_fulfilment() IS
  'Refuses to mark an obligation part fulfilled unless the unretracted evidence for it covers the promised quantity. Fires BEFORE UPDATE, so the row never exists in the refused state. Over-fulfilment is allowed and reported; under-fulfilment is not.';

REVOKE ALL ON FUNCTION public.guard_obligation_part_fulfilment() FROM PUBLIC;

CREATE TRIGGER contract_obligation_part_needs_evidence
  BEFORE UPDATE OF state ON contract_obligation_part
  FOR EACH ROW EXECUTE FUNCTION public.guard_obligation_part_fulfilment();

-- -----------------------------------------------------------------------------
-- PROPERTY 4 — THE STORED STATE AND THE DERIVED AGGREGATE CANNOT DISAGREE
-- -----------------------------------------------------------------------------

-- THE guard that makes the stored `contract_obligation.state` honest.
--
-- Fires at COMMIT, on FOUR tables, because every one of them can change the answer:
--
--   contract_obligation          the claim itself is what is being checked
--   contract_obligation_part     a part fulfilled, archived, or re-promised
--   obligation_evidence          new support appears
--   obligation_evidence_retraction support is withdrawn
--
-- Deferred, because the only legal way to retract evidence is to retract it AND move the
-- parent back in ONE transaction — and an IMMEDIATE trigger would refuse the retraction
-- before the correction could be written. Deferring is what makes the ledger-reversal shape
-- 0004 uses for a posted entry expressible here.
--
-- WHY IT IS ATTACHED TO `obligation_evidence` AS WELL
-- ---------------------------------------------------
-- Without it, "mark the parent discharged" and "add the evidence" could be two separate
-- transactions, and between them the parent would be claiming a discharge no evidence
-- supports. The trigger makes them one atomic claim.
--
-- RAISES check_violation (23514): a stale aggregate is a violated claim about the row's
-- own parts, which is the same SQLSTATE every other integrity violation in this schema
-- reports, so one monitoring rule catches all of them.
CREATE OR REPLACE FUNCTION public.assert_obligation_discharge_consistent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id        uuid;
  v_obligation_id uuid;
  -- Schema-qualified because this function pins search_path to empty, so an unqualified
  -- type name would not resolve. Every reference below is qualified for the same reason.
  v_stored        public.obligation_discharge_status;
  v_derived       public.obligation_discharge_status;
BEGIN
  -- Resolve WHICH obligation was touched, from whichever of the four tables fired.
  IF TG_TABLE_NAME = 'contract_obligation' THEN
    v_org_id        := NEW.org_id;
    v_obligation_id := NEW.id;

  ELSIF TG_TABLE_NAME = 'contract_obligation_part' THEN
    v_org_id        := NEW.org_id;
    v_obligation_id := NEW.obligation_id;

  ELSIF TG_TABLE_NAME = 'obligation_evidence' THEN
    v_org_id := NEW.org_id;
    SELECT p.obligation_id INTO v_obligation_id
      FROM public.contract_obligation_part p
     WHERE p.org_id = NEW.org_id AND p.id = NEW.obligation_part_id;

  ELSE
    v_org_id := NEW.org_id;
    SELECT p.obligation_id INTO v_obligation_id
      FROM public.obligation_evidence_retraction r
      JOIN public.obligation_evidence e
        ON e.org_id = r.org_id AND e.id = r.obligation_evidence_id
      JOIN public.contract_obligation_part p
        ON p.org_id = e.org_id AND p.id = e.obligation_part_id
     WHERE r.org_id = NEW.org_id AND r.id = NEW.id;
  END IF;

  IF v_obligation_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT o.state INTO v_stored
    FROM public.contract_obligation o
   WHERE o.org_id = v_org_id AND o.id = v_obligation_id;

  -- The obligation was archived or removed between the firing and here. Nothing to judge.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_derived := public.obligation_derived_state_in_org(v_org_id, v_obligation_id);

  IF v_stored IS DISTINCT FROM v_derived THEN
    RAISE EXCEPTION
      'obligation % stores state ''%'' but its parts and evidence aggregate to ''%''. An obligation is discharged only as an aggregate of its parts, so the stored state must equal the derivation; move the state to ''%'' in this same transaction.',
      v_obligation_id, v_stored, v_derived, v_derived
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_obligation_discharge_consistent() IS
  'Re-derives an obligation''s discharge state from its parts and their evidence at COMMIT and refuses any transaction that leaves contract_obligation.state disagreeing with it. Deferred, so retracting evidence and moving the parent back can be written as one transaction — the ledger-reversal shape 0004 uses.';

REVOKE ALL ON FUNCTION public.assert_obligation_discharge_consistent() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER contract_obligation_state_is_derived
  AFTER INSERT OR UPDATE ON contract_obligation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_obligation_discharge_consistent();

CREATE CONSTRAINT TRIGGER contract_obligation_part_rejustifies_parent
  AFTER INSERT OR UPDATE OF state, promised_quantity, archived_at ON contract_obligation_part
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_obligation_discharge_consistent();

CREATE CONSTRAINT TRIGGER obligation_evidence_rejustifies_parent
  AFTER INSERT ON obligation_evidence
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_obligation_discharge_consistent();

CREATE CONSTRAINT TRIGGER obligation_evidence_retraction_rejustifies_parent
  AFTER INSERT ON obligation_evidence_retraction
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_obligation_discharge_consistent();

-- -----------------------------------------------------------------------------
-- THE CHAIN, ANSWERED FROM ONE PLACE
-- -----------------------------------------------------------------------------

-- PROPERTY 4's deliverable: for obligation O, which parts are done, which are
-- outstanding, what evidence supports each done part, and THEREFORE whether O is
-- discharged — one query, one row per part.
--
-- It reads the DERIVATION, not the stored column, for `derived_state`, and reports
-- `states_agree` beside it so a reader can see the two side by side without trusting
-- either. A report that computed its "therefore" from the same column it is checking would
-- be circular.
--
-- SECURITY INVOKER, deliberately: it reads and nothing more, so no elevation is wanted,
-- and every underlying table's RLS applies to it. It therefore exposes exactly what its
-- caller's policies expose and nothing wider — which is why a call in ORG_B's session for
-- ORG_A's obligation returns zero rows rather than zero-valued rows.
--
-- NO LIMIT. ADR-0019's finding was a `limit` that silently capped at 1000 and presented
-- the capped set as a ranking. A discharge report that returned an obligation's first 50
-- parts would be worse than useless, because the caller would have no way to tell.
--
-- `evidence_count` counts evidence rows that SURVIVE retraction. Retracted evidence is
-- not absent from history — it is in `obligation_evidence_retraction` — but it supports
-- nothing, and a count that included it would be a claim of support that does not exist.
CREATE OR REPLACE FUNCTION public.obligation_discharge_report(p_obligation_id uuid)
RETURNS TABLE (
  obligation_id      uuid,
  obligation_title   varchar(200),
  stored_state       obligation_discharge_status,
  derived_state      obligation_discharge_status,
  states_agree       boolean,
  part_id            uuid,
  part_kind          obligation_part_kind,
  promised_quantity  integer,
  supported_quantity integer,
  surplus_quantity   integer,
  part_state         obligation_part_state,
  discharge_status   text,
  evidence_count     integer,
  due_at             timestamptz,
  is_overdue         boolean
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH obligation AS (
    SELECT o.id, o.title, o.state, o.org_id
      FROM public.contract_obligation o
     WHERE o.id = p_obligation_id
       AND o.org_id = public.current_org_id()
       AND o.archived_at IS NULL
  ),
  parts AS (
    SELECT p.*
      FROM public.contract_obligation_part p
     WHERE p.org_id = (SELECT org_id FROM obligation)
       AND p.obligation_id = p_obligation_id
       AND p.archived_at IS NULL
  ),
  per_part AS (
    SELECT pp.id,
           pp.org_id,
           pp.kind,
           pp.promised_quantity,
           pp.state,
           pp.due_at,
           public.obligation_part_supported_quantity(pp.org_id, pp.id) AS supported,
           (
             SELECT count(*)::integer
               FROM public.obligation_evidence e
              WHERE e.org_id             = pp.org_id
                AND e.obligation_part_id = pp.id
                AND NOT EXISTS (
                      SELECT 1
                        FROM public.obligation_evidence_retraction r
                       WHERE r.org_id                 = e.org_id
                         AND r.obligation_evidence_id = e.id
                    )
           ) AS evidence_count
      FROM parts pp
  )
  SELECT o.id,
         o.title,
         o.state,
         public.obligation_derived_state_in_org(o.org_id, o.id),
         (o.state = public.obligation_derived_state_in_org(o.org_id, o.id)),
         x.id,
         x.kind,
         x.promised_quantity,
         x.supported,
         GREATEST(x.supported - x.promised_quantity, 0),
         x.state,
         public.obligation_part_discharge_status(x.org_id, x.id),
         x.evidence_count,
         x.due_at,
         (x.due_at < now())
    FROM obligation o
    LEFT JOIN per_part x ON TRUE
   ORDER BY x.due_at NULLS FIRST, x.id
$$;

COMMENT ON FUNCTION public.obligation_discharge_report(uuid) IS
  'For one obligation: every promised part with what is evidenced against it, the derived aggregate, and whether the stored state agrees. Takes no organisation argument (ADR-0011 rule 3) and carries no LIMIT, because a report that silently capped its result set and presented it as the whole would be the defect ADR-0019 recorded.';

-- -----------------------------------------------------------------------------
-- INVENTORY
-- -----------------------------------------------------------------------------

-- WHAT A THING IS. No quantity and no balance: a balance is derived, and a stored balance
-- is the counter that drifts (ADR-0016's legacy slot system, and 0004's refusal to store
-- committed/spent/remaining on a budget).
--
-- Effective-dated half-open, exactly as 0002 does it: `valid_to IS NULL` means current and
-- `valid_to > valid_from` means the window is real. Two live windows for one SKU would make
-- "which version of this thing was in force on that date" answerable two ways, so the
-- database refuses one by trigger rather than leaving it to a query to disambiguate.
CREATE TABLE inventory_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  sku         varchar(64) NOT NULL,
  name        varchar(200) NOT NULL,
  -- THE UNIT, NAMED. ADR-0019's lesson about `survival_time` is that a count without a
  -- unit is a number nobody can check later; "6" chairs and "6" cases are the same row
  -- shape and a completely different fact.
  unit        varchar(24) NOT NULL,
  valid_from  timestamptz NOT NULL,
  valid_to    timestamptz,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT inventory_item_sku_check CHECK (btrim(sku) <> ''),
  -- A lowercase or spaced unit is a typo that nobody notices for a year.
  CONSTRAINT inventory_item_unit_check CHECK (unit ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT inventory_item_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT inventory_item_window_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT inventory_item_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX inventory_item_org_idx        ON inventory_item (org_id);
CREATE INDEX inventory_item_org_valid_idx ON inventory_item (org_id, valid_from, valid_to);

-- ONE LIVE ROW PER SKU, and this is where effective dating has to be reconciled with
-- uniqueness.
--
-- An earlier draft of this file carried `UNIQUE (org_id, sku)`, and it contradicts the
-- supersession model this same table implements: a superseded item KEEPS its row, closes
-- its window, and is followed by a NEW row for the same SKU. Under a blanket UNIQUE,
-- supersession is unexpressible and the overlap guard below would be guarding something
-- the schema already forbids outright, so the guard could never fire and its test would
-- have been passing for the wrong reason.
--
-- Uniqueness is therefore on the CURRENT row only, and the guard handles the history:
-- overlapping CLOSED windows are still refused, which is what makes "which version was in
-- force on that date" have exactly one answer across the whole history and not merely
-- across the live set.
CREATE UNIQUE INDEX inventory_item_current_sku_key
  ON inventory_item (org_id, sku) WHERE valid_to IS NULL;

-- At most one CURRENT window per SKU. Enforced by a trigger rather than a unique index
-- because the index can only see this table, and the question "are two windows for one SKU
-- overlapping?" needs to be asked of the whole history.
CREATE OR REPLACE FUNCTION public.guard_inventory_window_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_other record;
BEGIN
  IF NEW.valid_to IS NULL THEN
    -- A new current window conflicts with every window that is still open, and with any
    -- window that closes after this one starts.
    SELECT i.id, i.valid_from INTO v_other
      FROM public.inventory_item i
     WHERE i.org_id = NEW.org_id
       AND i.sku    = NEW.sku
       AND i.id    <> NEW.id
       AND i.valid_to IS NULL
       AND NEW.valid_from < COALESCE(i.valid_to, 'infinity'::timestamptz)
       AND i.valid_from < COALESCE(NEW.valid_to, 'infinity'::timestamptz)
     LIMIT 1;
  ELSE
    SELECT i.id, i.valid_from INTO v_other
      FROM public.inventory_item i
     WHERE i.org_id = NEW.org_id
       AND i.sku    = NEW.sku
       AND i.id    <> NEW.id
       AND i.valid_from < NEW.valid_to
       AND NEW.valid_from < COALESCE(i.valid_to, 'infinity'::timestamptz)
     LIMIT 1;
  END IF;

  IF FOUND THEN
    RAISE EXCEPTION
      'inventory item % for sku % overlaps an existing window (item % open from %), so "which version was in force on that date" would have two answers',
      NEW.id, NEW.sku, v_other.id, v_other.valid_from
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_inventory_window_overlap() IS
  'Refuses an effective-dated window that overlaps another window for the same SKU, so an as-of query has exactly one answer. Half-open, exactly like 0002''s effective dating.';

REVOKE ALL ON FUNCTION public.guard_inventory_window_overlap() FROM PUBLIC;

CREATE TRIGGER inventory_item_windows_do_not_overlap
  BEFORE INSERT OR UPDATE OF sku, valid_from, valid_to ON inventory_item
  FOR EACH ROW EXECUTE FUNCTION public.guard_inventory_window_overlap();

-- WHAT HAPPENED. Append-only: a stock movement is a fact about a moment, so a mistake is
-- corrected by a reversing movement rather than by editing the original — the same rule
-- 0004 applies to a journal line, for the same reason.
CREATE TABLE inventory_movement (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  item_id     uuid NOT NULL,
  kind        inventory_movement_kind NOT NULL,
  -- SIGNED. Positive increases, negative decreases, and the CHECK below binds the sign to
  -- the kind so "a receipt of minus five" is unstoreable rather than merely surprising.
  -- `adjustment` is the one kind allowed either way, because that is what a recount is.
  quantity    integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  -- WHAT THIS MOVEMENT WAS FOR. An 'issue' with no reference is stock that vanished, and
  -- stock that vanishes is the defect a movements ledger exists to make visible.
  reference   varchar(200) NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movement_item_fk
    FOREIGN KEY (org_id, item_id) REFERENCES inventory_item (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_movement_sign_check CHECK (
        quantity <> 0
        AND (
          (kind = 'adjustment')
          OR ((kind IN ('receipt', 'commitment')) = (quantity > 0))
          OR ((kind IN ('issue', 'write_off', 'release')) = (quantity < 0))
        )
      ),
  CONSTRAINT inventory_movement_reference_check CHECK (btrim(reference) <> ''),
  CONSTRAINT inventory_movement_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX inventory_movement_org_idx       ON inventory_movement (org_id);
CREATE INDEX inventory_movement_org_item_idx  ON inventory_movement (org_id, item_id);
CREATE INDEX inventory_movement_org_time_idx  ON inventory_movement (org_id, occurred_at);

COMMENT ON TABLE inventory_movement IS
  'One stock movement: what happened, in which direction, when, and why. Append-only with no archived_at — a mistake is corrected by a reversing movement, because a movement is a fact about a moment. The position is DERIVED (inventory_position); no balance is stored anywhere.';

-- The derived position. Three figures and the arithmetic between them, recomputed on every
-- read so none can drift:
--
--   on_hand    receipt + return + adjustments — issue — write_off. What is physically there.
--   committed  commitments — releases. What is promised to somebody and not yet ours.
--   available  on_hand — committed. What could honestly be promised to somebody else.
--
-- A commitment deliberately does NOT move on_hand: it is not stock, and treating it as
-- stock would let an org promise the same chair twice. It is its own figure, and
-- `available` is the subtraction.
CREATE VIEW inventory_position AS
SELECT i.org_id,
       i.id AS item_id,
       i.sku,
       i.name,
       i.unit,
       i.valid_from,
       i.valid_to,
       COALESCE(x.on_hand, 0)   AS on_hand,
       COALESCE(x.committed, 0) AS committed,
       COALESCE(x.on_hand, 0) - COALESCE(x.committed, 0) AS available,
       COALESCE(x.movements_counted, 0) AS movements_counted
  FROM inventory_item i
  LEFT JOIN LATERAL (
    SELECT sum(m.quantity) FILTER (
             WHERE m.kind IN ('receipt', 'issue', 'adjustment', 'write_off')
           ) AS on_hand,
           sum(m.quantity) FILTER (
             WHERE m.kind IN ('commitment', 'release')
           ) AS committed,
           count(*) AS movements_counted
      FROM inventory_movement m
     WHERE m.org_id  = i.org_id
       AND m.item_id = i.id
  ) x ON true;

COMMENT ON VIEW inventory_position IS
  'Derived stock position: on_hand, committed and available, all recomputed from inventory_movement on every read. No counter is stored, so none can drift. available is on_hand minus committed, and a commitment deliberately does not move on_hand — it is stock promised, not stock held.';

-- The one thing a movements ledger can still get wrong, and the reason the balance is
-- checked at COMMIT rather than trusted.
--
-- You cannot hand out chairs you do not have. A commitment is NOT checked, because
-- committing stock that has not arrived yet is normal — an org promises a venue's worth of
-- kit before the shipment lands — so `available` may legitimately go negative, and that
-- negative is a reportable fact rather than an error.
--
-- DEFERRABLE so a batch of movements for one delivery is judged ONCE, against the total.
-- An IMMEDIATE trigger would evaluate each row alone and would therefore reject a batch
-- that fits (receipt after issue) and accept one that does not (issue before receipt).
CREATE OR REPLACE FUNCTION public.assert_inventory_not_oversold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id  uuid;
  v_item_id uuid;
  v_on_hand integer;
BEGIN
  v_org_id  := NEW.org_id;
  v_item_id := NEW.item_id;

  SELECT COALESCE(sum(m.quantity) FILTER (
           WHERE m.kind IN ('receipt', 'issue', 'adjustment', 'write_off')
         ), 0)::integer
    INTO v_on_hand
    FROM public.inventory_movement m
   WHERE m.org_id  = v_org_id
     AND m.item_id = v_item_id;

  IF v_on_hand < 0 THEN
    RAISE EXCEPTION
      'inventory item % stands at % unit(s) after this movement; stock cannot be issued below zero. A balance that can go negative without comment is exactly the drifting counter ADR-0016 recorded.',
      v_item_id, v_on_hand
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_inventory_not_oversold() IS
  'Refuses a COMMIT that would leave an item''s on_hand negative. Deferred to COMMIT so a batch of movements is judged as a batch. Commitments are NOT checked, because promising stock before it arrives is normal and a negative `available` is a reportable fact rather than an error.';

REVOKE ALL ON FUNCTION public.assert_inventory_not_oversold() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER inventory_movement_must_not_oversell
  AFTER INSERT ON inventory_movement
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_inventory_not_oversold();

-- -----------------------------------------------------------------------------
-- PARTNER PIPELINE — A STATE MACHINE
-- -----------------------------------------------------------------------------

-- Mirrors hr_state_transition in 0008 exactly: the CURRENT stage is STORED on the row
-- (one indexed read rather than a fold over history), and the ALLOWED MOVES are DATA in
-- this table, so "what can happen to a lapsed deal" is a SELECT and not a reading of
-- application source. The database enforces them.
--
-- WHAT THE DATABASE DOES NOT ENFORCE, said plainly because 0008 says it of the HR
-- machine and it is true here too: it does not check WHO may make a transition.
-- Authorisation is packages/auth's concern and a migration cannot see which session a
-- write came from. This is about the LEGALITY of the move, not authority to make it.
CREATE TABLE partner_state_transition (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  from_stage   partner_stage NOT NULL,
  to_stage     partner_stage NOT NULL,
  requires_reason boolean NOT NULL DEFAULT false,
  -- WHY THIS COLUMN IS ENFORCED RATHER THAN DECORATED
  -- ------------------------------------------------
  -- True means: the reverse move (`to_stage → from_stage`) may NEVER be declared in this
  -- table. A later migration, or an operator with psql, cannot quietly add
  -- `signed → negotiation` after `negotiation → signed` was recorded as one-way. Without
  -- the guard below, `is_irreversible` would be a comment, and a comment is not a
  -- constraint.
  is_irreversible boolean NOT NULL DEFAULT false,
  description  varchar(300),
  CONSTRAINT partner_state_transition_key UNIQUE (org_id, from_stage, to_stage),
  CONSTRAINT partner_state_transition_no_self_check CHECK (from_stage <> to_stage),
  CONSTRAINT partner_state_transition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX partner_state_transition_org_idx ON partner_state_transition (org_id);

CREATE OR REPLACE FUNCTION public.seed_partner_state_transition(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.partner_state_transition (org_id, from_stage, to_stage, requires_reason, is_irreversible, description)
  VALUES
    (p_org_id, 'lead',        'qualified',   false, false, 'Qualified after a first conversation'),
    (p_org_id, 'lead',        'lapsed',      true,  true,  'Never engaged'),
    (p_org_id, 'qualified',   'negotiation', false, false, 'Terms being discussed'),
    (p_org_id, 'qualified',   'lapsed',      true,  true,  'Went with a competitor'),
    (p_org_id, 'negotiation', 'signed',      false, true,  'Agreement executed'),
    (p_org_id, 'signed',      'active',      false, true,  'First delivery under way'),
    (p_org_id, 'signed',      'lapsed',      true,  true,  'Agreement terminated before activation'),
    (p_org_id, 'active',      'lapsed',      true,  true,  'Relationship ended')
  ON CONFLICT DO NOTHING;
END
$$;

COMMENT ON FUNCTION public.seed_partner_state_transition(uuid) IS
  'Seeds an organisation''s legal partner moves. `negotiation → signed`, `signed → active` and every move into `lapsed` are marked irreversible, so no reverse of them can ever be declared.';

REVOKE ALL ON FUNCTION public.seed_partner_state_transition(uuid) FROM PUBLIC;

-- The irreversibility guard. BEFORE INSERT OR UPDATE on the TRANSITION TABLE, because
-- that is the only place the damage can be done — guarding `partner` instead would stop
-- the wrong write and leave the machine free to grow a way back.
--
-- `exclusion_violation` (23P01) rather than check_violation, matching
-- `guard_performance_supersession` in 0007: it is what a declarative constraint would
-- raise for exactly this shape (two moves that may not coexist), so moving to one on a
-- full server is not an observable change to any caller.
--
-- Only IRREVERSIBLE transitions are checked against their reverse. A reversible move may
-- obviously be reversed — an ordinary renegotiation from qualified back to lead is real
-- work — so "no backwards moves" would be the wrong rule and is not the rule here.
-- One rule, TWO trigger functions.
--
-- The duplication is deliberate and it is the smallest useful duplication available. A
-- single function branching on `TG_TABLE_NAME` reads tidier, and it is wrong: PL/pgSQL
-- caches each statement's plan against the row type of the FIRST record it is handed, so
-- a function that reads `NEW.from_stage` in one branch and `NEW.from_state` in another
-- resolves both against whichever table fired first. The failure is a "column does not
-- exist" raised from a seed, which reads like a typo and is actually a plan-cache
-- artefact — and it would appear only in whichever table was seeded second.
--
-- The SHARED part is the refusal itself, which is the part that could actually drift:
-- `reject_irreversible_reverse` is the only place the error is raised and the only place
-- the reason is written down.
CREATE OR REPLACE FUNCTION public.reject_irreversible_reverse(
  p_label text,
  p_from  text,
  p_to    text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION
    '% % — % cannot be declared: % — % is recorded as irreversible, and a one-way move must not grow a way back',
    p_label, p_from, p_to, p_to, p_from
    USING ERRCODE = 'exclusion_violation';
END
$$;

COMMENT ON FUNCTION public.reject_irreversible_reverse(text, text, text) IS
  'The single place the irreversibility refusal is raised. Both transition-table guards call it, so the two can never disagree about what a one-way move means.';

CREATE OR REPLACE FUNCTION public.guard_partner_transition_irreversibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_forward record;
BEGIN
  -- Only a REVERSIBLE move can possibly close a loop. If the move being declared is
  -- itself irreversible, its forward partner is the one that will be refused when IT is
  -- declared; checking here as well would refuse both halves of a legitimate chain.
  IF NEW.is_irreversible THEN
    RETURN NEW;
  END IF;

  SELECT t.id, t.is_irreversible INTO v_forward
    FROM public.partner_state_transition t
   WHERE t.org_id     = NEW.org_id
     AND t.from_stage = NEW.to_stage
     AND t.to_stage   = NEW.from_stage
   LIMIT 1;

  IF FOUND AND v_forward.is_irreversible THEN
    PERFORM public.reject_irreversible_reverse(
      'partner transition', NEW.from_stage::text, NEW.to_stage::text);
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.guard_content_transition_irreversibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_forward record;
BEGIN
  IF NEW.is_irreversible THEN
    RETURN NEW;
  END IF;

  SELECT t.id, t.is_irreversible INTO v_forward
    FROM public.content_state_transition t
   WHERE t.org_id     = NEW.org_id
     AND t.from_state = NEW.to_state
     AND t.to_state   = NEW.from_state
   LIMIT 1;

  IF FOUND AND v_forward.is_irreversible THEN
    PERFORM public.reject_irreversible_reverse(
      'content state transition', NEW.from_state::text, NEW.to_state::text);
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_partner_transition_irreversibility() IS
  'Refuses to declare the reverse of a partner transition marked irreversible. Enforced on the transition TABLE rather than on partner, because the table is the only place a later migration could quietly grow a way back. Reversible moves may still be reversed.';

COMMENT ON FUNCTION public.guard_content_transition_irreversibility() IS
  'The content-table sibling of guard_partner_transition_irreversibility. Separate because PL/pgSQL caches a statement plan against the first NEW row type it sees; the shared refusal is reject_irreversible_reverse.';

-- REVOKEd from PUBLIC immediately, so the elevation is reachable only by declaring a
-- transition. Repeated in the privileges block at the foot of the file with the rest.
REVOKE ALL ON FUNCTION public.reject_irreversible_reverse(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_partner_transition_irreversibility() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_content_transition_irreversibility() FROM PUBLIC;

CREATE TRIGGER partner_state_transition_is_one_way
  BEFORE INSERT OR UPDATE OF from_stage, to_stage, is_irreversible ON partner_state_transition
  FOR EACH ROW EXECUTE FUNCTION public.guard_partner_transition_irreversibility();

-- The stage guard. The same shape as `guard_hr_transition` in 0008, for the same reasons:
-- the state is stored, the transitions are data, and an application that writes an illegal
-- move gets check_violation from the DATABASE rather than a silently illegal record.
CREATE OR REPLACE FUNCTION public.guard_partner_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_requires boolean;
BEGIN
  IF NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
    -- Not a transition. An edit to the reason text alone is not a stage change and is not
    -- guarded, because refusing it would make the row uneditable in every other respect.
    RETURN NEW;
  END IF;

  PERFORM 1
    FROM public.partner_state_transition t
   WHERE t.org_id     = OLD.org_id
     AND t.from_stage = OLD.stage
     AND t.to_stage   = NEW.stage;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'partner % cannot move from % to %: no such transition is defined for this organisation. partner_state_transition is where the legal moves are recorded, and it is the authority — not application code.',
      OLD.id, OLD.stage, NEW.stage
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT t.requires_reason INTO v_requires
    FROM public.partner_state_transition t
   WHERE t.org_id     = OLD.org_id
     AND t.from_stage = OLD.stage
     AND t.to_stage   = NEW.stage;

  IF v_requires AND (NEW.stage_reason IS NULL OR btrim(NEW.stage_reason) = '') THEN
    RAISE EXCEPTION
      'partner % moving from % to % requires a stated reason',
      OLD.id, OLD.stage, NEW.stage
      USING ERRCODE = 'check_violation';
  END IF;

  -- Who moved it. Without this, "who signed this deal off" has an answer only for the
  -- database.
  IF NEW.stage_changed_by_person_id IS NULL THEN
    RAISE EXCEPTION
      'partner % changed stage from % to % without naming who made the change',
      OLD.id, OLD.stage, NEW.stage
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_partner_transition() IS
  'Refuses a partner stage change that partner_state_transition does not declare, a declared-but-reason-requiring change with no reason, and a change with no actor. Does NOT check WHO may make the transition: authorisation is not a database concern here and is not implied by this trigger.';

REVOKE ALL ON FUNCTION public.guard_partner_transition() FROM PUBLIC;

CREATE TRIGGER partner_transition_is_legal
  BEFORE UPDATE OF stage ON partner
  FOR EACH ROW EXECUTE FUNCTION public.guard_partner_transition();

-- -----------------------------------------------------------------------------
-- CREATORS
-- -----------------------------------------------------------------------------

-- A creator IS a person (ADR-0018). This table holds only what is true of a creator AS A
-- CREATOR — the handle they publish under and the name shown — and no contact address, no
-- credential and no external identifier, because `person` and `identity` already own those
-- and two places to record an email address is how they stop agreeing.
CREATE TABLE creator_profile (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- SINGLE-COLUMN and CORRECTLY so. `person` is the org-independent identity root, so it
  -- has no org_id to compose a composite key with. Every other FK in this file is
  -- composite; this one is the deliberate exception, and the test asserts exactly one FK
  -- and that it is this one.
  person_id    uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  handle       varchar(64) NOT NULL,
  display_name varchar(200) NOT NULL,
  bio          text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT creator_profile_handle_check CHECK (handle ~ '^[a-z0-9_]{3,64}$'),
  CONSTRAINT creator_profile_display_name_check CHECK (btrim(display_name) <> ''),
  -- One creator profile per person per organisation. The same human may be profiled by
  -- several organisations — that is a tenant-scoped fact about them, not part of who they
  -- are — but two profiles in one org would make "who is our creator named X" ambiguous.
  CONSTRAINT creator_profile_org_person_key UNIQUE (org_id, person_id),
  CONSTRAINT creator_profile_org_handle_key UNIQUE (org_id, handle),
  CONSTRAINT creator_profile_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX creator_profile_org_idx       ON creator_profile (org_id);
CREATE INDEX creator_profile_org_person_idx ON creator_profile (org_id, person_id);

COMMENT ON TABLE creator_profile IS
  'What a person is known as AS A CREATOR for this organisation. Not an identity: `person_id` is NOT NULL and there is deliberately no email, login or credential column, because `person` and `identity` own those (ADR-0018) and two places to record an email is how they stop agreeing.';

-- -----------------------------------------------------------------------------
-- CONTENT PIPELINE
-- -----------------------------------------------------------------------------

-- Same shape as partner_state_transition, same reasons. `published → archived` is
-- irreversible, so `archived → published` can never be declared and an archived item
-- cannot be quietly resurrected.
CREATE TABLE content_state_transition (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  from_state   content_stage NOT NULL,
  to_state     content_stage NOT NULL,
  requires_reason boolean NOT NULL DEFAULT false,
  is_irreversible boolean NOT NULL DEFAULT false,
  description  varchar(300),
  CONSTRAINT content_state_transition_key UNIQUE (org_id, from_state, to_state),
  CONSTRAINT content_state_transition_no_self_check CHECK (from_state <> to_state),
  CONSTRAINT content_state_transition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX content_state_transition_org_idx ON content_state_transition (org_id);

CREATE OR REPLACE FUNCTION public.seed_content_state_transition(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.content_state_transition (org_id, from_state, to_state, requires_reason, is_irreversible, description)
  VALUES
    (p_org_id, 'draft',     'review',     false, false, 'Submitted for review'),
    (p_org_id, 'draft',     'archived',   true,  false, 'Abandoned before review'),
    (p_org_id, 'review',    'approved',   false, false, 'Passed review'),
    (p_org_id, 'review',    'draft',      true,  false, 'Changes requested'),
    (p_org_id, 'review',    'archived',   true,  false, 'Rejected'),
    (p_org_id, 'approved',  'scheduled',  false, false, 'Queued for release'),
    (p_org_id, 'approved',  'draft',      true,  false, 'Pulled back for rework'),
    (p_org_id, 'approved',  'archived',   true,  false, 'Never released'),
    (p_org_id, 'scheduled', 'published',  false, true,  'Released'),
    (p_org_id, 'scheduled', 'approved',   true,  false, 'Un-scheduled'),
    (p_org_id, 'scheduled', 'archived',   true,  false, 'Cancelled before release'),
    (p_org_id, 'published', 'archived',   false, true,  'Taken down'),
    (p_org_id, 'published', 'draft',      true,  false, 'Rework after publication')
  ON CONFLICT DO NOTHING;
END
$$;

COMMENT ON FUNCTION public.seed_content_state_transition(uuid) IS
  'Seeds an organisation''s legal content moves. `scheduled → published` and `published → archived` are irreversible, so an item can be un-scheduled before release but never resurrected after it has been taken down.';

REVOKE ALL ON FUNCTION public.seed_content_state_transition(uuid) FROM PUBLIC;

CREATE TRIGGER content_state_transition_is_one_way
  BEFORE INSERT OR UPDATE OF from_state, to_state, is_irreversible ON content_state_transition
  FOR EACH ROW EXECUTE FUNCTION public.guard_content_transition_irreversibility();

CREATE TABLE content_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- COMPOSITE. A content item belongs to a creator profile in THIS organisation, and the
  -- composite FK is what makes a cross-tenant reference unexpressible rather than merely
  -- discouraged (ADR-0011).
  creator_id  uuid NOT NULL,
  title       varchar(200) NOT NULL,
  body        text NOT NULL,
  state       content_stage NOT NULL DEFAULT 'draft',
  state_reason varchar(400),
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  state_changed_by_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  -- WHEN IT WAS PLANNED FOR, and WHEN IT ACTUALLY WENT OUT. Both INSTANTS, both supplied
  -- by the caller and neither defaulted: a default would be a fabricated instant, which
  -- is precisely the class of claim ADR-0019 exists to stop storing.
  scheduled_for timestamptz,
  published_at  timestamptz,
  -- WHERE THE BYTES ARE. Required before publication — see the guard below.
  storage_ref   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT content_item_creator_fk
    FOREIGN KEY (org_id, creator_id) REFERENCES creator_profile (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT content_item_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT content_item_body_check CHECK (btrim(body) <> ''),
  CONSTRAINT content_item_storage_ref_check CHECK (storage_ref IS NULL OR btrim(storage_ref) <> ''),
  CONSTRAINT content_item_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX content_item_org_idx          ON content_item (org_id);
CREATE INDEX content_item_org_creator_idx  ON content_item (org_id, creator_id);
CREATE INDEX content_item_org_state_idx    ON content_item (org_id, state);
CREATE INDEX content_item_org_scheduled_idx ON content_item (org_id, scheduled_for);

COMMENT ON TABLE content_item IS
  'One creator''s content item and where it is in the lifecycle. The state is STORED and the legal transitions are DATA in content_state_transition, enforced by trigger. Publishing requires a storage_ref and a supplied published_at, so a published row always names something to look at and the instant it went out.';

-- The content state machine, plus the one content-specific rule: a published item must
-- name what was published and when.
--
-- The publication rule is the shape of every other guard in this file — a claim the
-- database can contradict. A `published` row with no `storage_ref` says something is live
-- while naming nothing, and a `published_at` that DEFAULTED to now() would be an invented
-- instant. Both are refused, and the legal path is to supply them.
CREATE OR REPLACE FUNCTION public.guard_content_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_requires boolean;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  PERFORM 1
    FROM public.content_state_transition t
   WHERE t.org_id     = OLD.org_id
     AND t.from_state = OLD.state
     AND t.to_state   = NEW.state;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'content item % cannot move from % to %: no such transition is defined for this organisation. content_state_transition is the authority — not application code.',
      OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT t.requires_reason INTO v_requires
    FROM public.content_state_transition t
   WHERE t.org_id     = OLD.org_id
     AND t.from_state = OLD.state
     AND t.to_state   = NEW.state;

  IF v_requires AND (NEW.state_reason IS NULL OR btrim(NEW.state_reason) = '') THEN
    RAISE EXCEPTION
      'content item % moving from % to % requires a stated reason',
      OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state_changed_by_person_id IS NULL THEN
    RAISE EXCEPTION
      'content item % changed state from % to % without naming who made the change',
      OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  -- THE PUBLICATION RULE. Both halves are required, and neither is defaulted.
  IF NEW.state = 'published' THEN
    IF NEW.storage_ref IS NULL OR btrim(NEW.storage_ref) = '' THEN
      RAISE EXCEPTION
        'content item % cannot be published with no storage_ref: a published row that names nothing is a claim the database cannot check',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.published_at IS NULL THEN
      RAISE EXCEPTION
        'content item % cannot be published with no published_at: the publication instant is supplied by the caller, never defaulted, because a default is an invented instant',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- "Scheduled for" a moment that has already passed is not a schedule.
  IF NEW.state = 'scheduled' THEN
    IF NEW.scheduled_for IS NULL THEN
      RAISE EXCEPTION
        'content item % cannot be scheduled with no scheduled_for instant', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.scheduled_for <= now() THEN
      RAISE EXCEPTION
        'content item % cannot be scheduled for an instant that has already passed', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_content_transition() IS
  'Refuses an undeclared content state change, a reason-requiring change with no reason, a change with no actor, a publication with no storage_ref or no supplied published_at, and a scheduling for an instant that has already passed. Does NOT check WHO may make the transition.';

REVOKE ALL ON FUNCTION public.guard_content_transition() FROM PUBLIC;

CREATE TRIGGER content_item_transition_is_legal
  BEFORE UPDATE OF state ON content_item
  FOR EACH ROW EXECUTE FUNCTION public.guard_content_transition();

-- -----------------------------------------------------------------------------
-- INVOICING
-- -----------------------------------------------------------------------------

-- `ledger_journal` is referenced COMPOSITELY, so an invoice settling against another
-- tenant's journal is unexpressible rather than merely refused by a check.
CREATE TABLE invoice (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  partner_id   uuid NOT NULL,
  -- THE DOCUMENT NUMBER, as a stable name for the invoice rather than a row of facts. It
  -- is UNIQUE per organisation, so "invoice INV-2026-001" has exactly one referent — the
  -- same reasoning as `contract_version.version_no` in 0008.
  invoice_number varchar(64) NOT NULL,
  currency     varchar(3) NOT NULL,
  -- DERIVED, AND CONSTRAINED. `assert_invoice_balanced` recomputes this from the lines at
  -- COMMIT and refuses any invoice whose total disagrees with them. A supplied total that
  -- the lines do not support is how an organisation bills one number and accounts for
  -- another, and the difference is only ever found by a human, late.
  total_amount numeric(18,4) NOT NULL,
  state        invoice_state NOT NULL DEFAULT 'draft',
  issued_at    timestamptz,
  due_at       timestamptz,
  -- THE JOURNAL THAT DISCHARGES THIS IN THE BOOKS. Required before `paid`: "paid" with
  -- nothing in the ledger is the invoice-domain version of a hardcoded confidence, a claim
  -- the database cannot contradict.
  settled_journal_id uuid,
  external_ref varchar(120),
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT invoice_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES partner (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT invoice_settlement_fk
    FOREIGN KEY (org_id, settled_journal_id) REFERENCES ledger_journal (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT invoice_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT invoice_total_check CHECK (total_amount >= 0),
  CONSTRAINT invoice_number_check CHECK (btrim(invoice_number) <> ''),
  CONSTRAINT invoice_window_check CHECK (due_at IS NULL OR issued_at IS NULL OR due_at > issued_at),
  -- An issued invoice has an issue instant; a draft does not need one. Bound so the two
  -- states cannot be asserted independently of each other.
  CONSTRAINT invoice_issued_at_binding_check CHECK (state = 'draft' OR issued_at IS NOT NULL),
  -- Paid names the books. Void names why.
  CONSTRAINT invoice_settlement_binding_check CHECK (state <> 'paid' OR settled_journal_id IS NOT NULL),
  CONSTRAINT invoice_org_number_key UNIQUE (org_id, invoice_number),
  CONSTRAINT invoice_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX invoice_org_idx          ON invoice (org_id);
CREATE INDEX invoice_org_partner_idx  ON invoice (org_id, partner_id);
CREATE INDEX invoice_org_state_idx    ON invoice (org_id, state);
CREATE INDEX invoice_org_due_idx      ON invoice (org_id, due_at);

-- A charge. `amount > 0` for 0004's reason: a zero line is a comment wearing a costume.
-- A credit note is expressed by a reversal invoice, not by a negative line, so that
-- "what did we bill" is a sum of positive obligations rather than an arithmetic accident.
CREATE TABLE invoice_line (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  invoice_id   uuid NOT NULL,
  line_no      integer NOT NULL,
  description  varchar(300) NOT NULL,
  amount       numeric(18,4) NOT NULL,
  -- The line carries its own currency so it is self-describing, and the guard below
  -- refuses a line that disagrees with its header — an invoice that balances across two
  -- currencies is a conversion performed at no rate by nobody, recorded nowhere.
  currency     varchar(3) NOT NULL,
  -- WHICH OBLIGATION THIS CHARGES FOR, when it charges for one. Nullable because an
  -- invoice may bundle a one-off fee that owes nothing; when set, the composite FK makes a
  -- cross-tenant reference unexpressible.
  obligation_part_id uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_line_invoice_fk
    FOREIGN KEY (org_id, invoice_id) REFERENCES invoice (org_id, id) ON DELETE CASCADE,
  CONSTRAINT invoice_line_obligation_part_fk
    FOREIGN KEY (org_id, obligation_part_id)
    REFERENCES contract_obligation_part (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT invoice_line_no_check CHECK (line_no >= 1),
  CONSTRAINT invoice_line_amount_check CHECK (amount > 0),
  CONSTRAINT invoice_line_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT invoice_line_description_check CHECK (btrim(description) <> ''),
  -- One line number per invoice, so the invoice reads back in the order it was written.
  CONSTRAINT invoice_line_org_invoice_no_key UNIQUE (org_id, invoice_id, line_no),
  CONSTRAINT invoice_line_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX invoice_line_org_idx        ON invoice_line (org_id);
CREATE INDEX invoice_line_org_invoice_idx ON invoice_line (org_id, invoice_id);

COMMENT ON TABLE invoice IS
  'An invoice to a partner. `total_amount` is DERIVED from invoice_line and constrained against it at COMMIT — an invoice whose total disagrees with its lines is refused. `paid` requires a settlement journal in this tenant''s ledger, so the claim is backed by double entry (ADR-0003, and 0004''s reconciliation rule).';

-- THE GUARD that makes the total a constraint rather than a column.
--
-- Four conditions, all needed, mirroring `assert_journal_balanced` in 0004 for the same
-- reason — a money figure that can be stated two ways is a figure nobody trusts:
--
--   1. total_amount = the sum of the lines. COALESCE handles the zero-line invoice,
--      whose total must therefore be zero rather than absent.
--   2. every line carries the header's currency.
--   3. an invoice that is not a draft has at least one line, because a zero-line invoice
--      that has been ISSUED is a document nobody asked for and nobody owes.
--   4. a paid invoice names a settlement journal in this organisation's currency, checked
--      here rather than left to the FK alone — the FK proves the journal is in the tenant,
--      and only this proves the currency agrees.
--
-- DEFERRABLE, because the only legal order is to write the header and then the lines:
-- an IMMEDIATE trigger would judge the header against zero lines and reject every correct
-- invoice.
CREATE OR REPLACE FUNCTION public.assert_invoice_balanced()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_invoice_id uuid;
  v_total      numeric(18,4);
  v_stored     numeric(18,4);
  v_currency   varchar(3);
  v_stored_currency varchar(3);
  v_state      public.invoice_state;
  v_journal_currency varchar(3);
  v_lines      integer;
BEGIN
  IF TG_TABLE_NAME = 'invoice' THEN
    v_invoice_id := NEW.id;
  ELSE
    v_invoice_id := NEW.invoice_id;
  END IF;

  SELECT i.total_amount, i.currency, i.state, i.settled_journal_id
    INTO v_stored, v_currency, v_state, v_journal_currency
    FROM public.invoice i
   WHERE i.id = v_invoice_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(l.amount), 0)::numeric(18,4), count(*)::integer,
         min(l.currency)
    INTO v_total, v_lines, v_stored_currency
    FROM public.invoice_line l
   WHERE l.invoice_id = v_invoice_id;

  IF v_stored <> v_total THEN
    RAISE EXCEPTION
      'invoice % states a total of % but its lines sum to %; an invoice whose total disagrees with its lines is refused rather than corrected, because a caller who can choose the figure can choose a wrong figure',
      v_invoice_id, v_stored, v_total
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.invoice_line l
     WHERE l.invoice_id = v_invoice_id
       AND l.currency IS DISTINCT FROM v_currency
  ) THEN
    RAISE EXCEPTION
      'invoice % is in % but carries a line in another currency; a conversion performed at no rate by nobody is not a reconciliation',
      v_invoice_id, v_currency
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_state <> 'draft' AND v_lines = 0 THEN
    RAISE EXCEPTION
      'invoice % is % with no lines at all; a document nobody was sent and nobody owes is not an invoice',
      v_invoice_id, v_state
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_state = 'paid' AND v_journal_currency IS NOT NULL THEN
    SELECT j.currency INTO v_stored_currency
      FROM public.ledger_journal j
     WHERE j.id = v_journal_currency;

    IF v_stored_currency IS DISTINCT FROM v_currency THEN
      RAISE EXCEPTION
        'invoice % is settled in % by a journal in %',
        v_invoice_id, v_currency, v_stored_currency
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_invoice_balanced() IS
  'Refuses a COMMIT in which an invoice''s stated total differs from the sum of its lines, in which a line carries another currency, in which a non-draft invoice has no lines, or in which a paid invoice is settled by a journal in another currency. Deferred to COMMIT, because the header must be written before the lines exist.';

REVOKE ALL ON FUNCTION public.assert_invoice_balanced() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER invoice_total_must_match_lines
  AFTER INSERT ON invoice
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_invoice_balanced();

CREATE CONSTRAINT TRIGGER invoice_line_must_match_total
  AFTER INSERT ON invoice_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_invoice_balanced();

-- -----------------------------------------------------------------------------
-- THE PUBLIC SURFACE
-- -----------------------------------------------------------------------------

-- Read the header of this file before changing anything here. The decision is stated
-- there: this is the ONE surface read with no tenant filter, and it is safe because
-- everything on it was vetted as publishable at write time — not because a policy is
-- remembered.

-- THE PUBLIC READ ROLE. NOLOGIN, NOSUPERUSER, NOBYPASSRLS.
--
-- NOBYPASSRLS is asserted by the test, because a public read role that could bypass RLS
-- would make the absence of a tenant policy here irrelevant: it would also be able to read
-- past every policy in the schema, and the whole argument for this table being safe would
-- collapse.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raptor_public') THEN
    CREATE ROLE raptor_public NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- The projection. Seven columns, and the absence of the others is the design:
--
--   NO person_id        a public page does not know who made the content
--   NO creator_id       ...and not which internal profile it came from
--   NO stage / reason   the editorial pipeline is not public
--   NO obligation id    and therefore nothing about what was owed
--   NO amount / invoice nothing about money, ever
--   NO partner id       ...and nothing about who the contract was with
--
-- What it DOES carry is org_id, and that is not a leak: the public read joins on it
-- throughout and selects one organisation's rows by its own unique slug. The tenant
-- boundary here is the slug, and the join makes crossing it unexpressible rather than
-- filtered.
--
-- NO ROW LEVEL SECURITY, deliberately. Adding a policy here would hide the public site,
-- which is the opposite of what it is for. The table's safety comes from its COLUMNS and
-- from its single writer, not from a predicate — and the test asserts both.
CREATE TABLE public_site_publication (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- Which item this is, so the projection can be traced back. NOT a foreign key: this
  -- table outlives nothing, but the reference must not become a JOIN for a reader to
  -- follow, and a FK to a tenant table would invite exactly that.
  content_item_id uuid NOT NULL,
  creator_handle  varchar(64) NOT NULL,
  title           varchar(200) NOT NULL,
  body            text NOT NULL,
  published_at    timestamptz NOT NULL,
  CONSTRAINT public_site_publication_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT public_site_publication_body_check CHECK (btrim(body) <> ''),
  -- One public row per content item, so a page has one answer for what an item says.
  CONSTRAINT public_site_publication_item_key UNIQUE (org_id, content_item_id),
  CONSTRAINT public_site_publication_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX public_site_publication_org_idx ON public_site_publication (org_id, published_at);

COMMENT ON TABLE public_site_publication IS
  'The public projection of published content, materialised at publish time. The ONLY table read without a tenant filter, and it carries NO RLS policy on purpose — its safety is structural: seven vetted columns, no person, no money, no obligation, no partner, and a single session-scoped writer. A test asserts the column list, so a future column is a failing test rather than a silent leak.';

-- THE ORGANISATION'S PUBLIC FACE. Three columns out of `organization`, exposed as a view so
-- the public role can be granted THIS and not the table. `organization` has no RLS policy
-- in 0001 (it is the tenant root), so a grant on the table itself would expose
-- `legal_name`, `data_region`, `fiscal_year_start_month` and everything else to an
-- anonymous reader. The view is the narrowing.
CREATE VIEW public_site_org AS
SELECT id, slug, display_name, status
  FROM organization;

COMMENT ON VIEW public_site_org IS
  'The three organisation columns a public page may read. A view rather than a grant on `organization`, so the public role never sees legal_name, data_region or fiscal settings.';

-- THE PUBLISHER. The single writer of public_site_publication.
--
-- SECURITY DEFINER, and the elevation is deliberately narrow: the function takes ONE
-- argument, an obligation-free content item id, and resolves the organisation from
-- `current_org_id()` — never from a parameter (ADR-0011 rule 3). An unset context is a
-- refusal, not a default, so the whole path fails CLOSED.
--
-- Every refusal is `insufficient_privilege` rather than "not found", because ADR-0011
-- rule 4 requires cross-tenant access to be indistinguishable from absence: a caller must
-- not be able to learn that another tenant's content item exists by being told it cannot
-- publish it.
CREATE OR REPLACE FUNCTION public.publish_content_to_public_site(p_content_item_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id uuid := public.current_org_id();
  v_item   record;
  v_id     uuid;
BEGIN
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION
      'no organisation in the session context; refusing to publish'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT c.id, c.title, c.body, c.published_at, c.state, c.archived_at, p.handle
    INTO v_item
    FROM public.content_item c
    JOIN public.creator_profile p
      ON p.org_id = c.org_id AND p.id = c.creator_id
   WHERE c.org_id = v_org_id
     AND c.id     = p_content_item_id;

  -- Not found and "belongs to somebody else" are the SAME refusal, on purpose.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'content item % is not publishable in the current organisation', p_content_item_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_item.archived_at IS NOT NULL OR v_item.state <> 'published' THEN
    RAISE EXCEPTION
      'content item % is in state ''%''; only published content may be put on the public site, or the public site becomes a preview channel for work that was not released',
      v_item.id, v_item.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_item.published_at IS NULL THEN
    RAISE EXCEPTION
      'content item % has no published_at; a public row with no publication instant says something is live without saying when',
      v_item.id
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.public_site_publication
    (org_id, content_item_id, creator_handle, title, body, published_at)
  VALUES
    (v_org_id, v_item.id, v_item.handle, v_item.title, v_item.body, v_item.published_at)
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

COMMENT ON FUNCTION public.publish_content_to_public_site(uuid) IS
  'The ONLY writer of public_site_publication. Takes a content item id and nothing else — the organisation comes from the session and an unset context fails closed. Refuses a cross-tenant id with insufficient_privilege, not "not found", so a refusal cannot confirm that the row exists (ADR-0011 rule 4).';

REVOKE ALL ON FUNCTION public.publish_content_to_public_site(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_content_to_public_site(uuid) TO raptor_app;

-- THE PUBLIC READ.
--
-- SECURITY INVOKER, and this is the point of the whole section: there is no elevation to
-- misuse. It reads `public_site_publication` (no RLS) and `public_site_org` (a view over
-- `organization`), joins on `org_id` throughout, and every table it touches is one the
-- caller may already read.
--
-- It takes a SLUG and never an org id, which is what makes the boundary structural rather
-- than conventional: `organization.slug` is UNIQUE, so exactly one organisation can match,
-- and the answer cannot be another tenant's page however the caller phrases the request.
--
-- An organisation that is not ACTIVE serves nothing. Its content stays perfectly readable
-- by the tenant that owns it — going public-dark is a visibility decision, not a deletion,
-- and conflating the two would turn a suspension into data loss.
--
-- NO LIMIT, for the reason `person_document_expiry_status` gives: a silently capped page
-- that presents itself as the whole is the ADR-0019 defect in a new surface.
CREATE OR REPLACE FUNCTION public.public_site_content(p_slug text)
RETURNS TABLE (
  org_slug        varchar(64),
  org_display_name varchar(200),
  title           varchar(200),
  body            text,
  creator_handle  varchar(64),
  published_at    timestamptz
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT o.slug,
         o.display_name,
         p.title,
         p.body,
         p.creator_handle,
         p.published_at
    FROM public.public_site_publication p
    JOIN public.public_site_org o
      ON o.id    = p.org_id
     AND o.status = 'active'
   WHERE o.slug = p_slug
   ORDER BY p.published_at DESC, p.id
$$;

COMMENT ON FUNCTION public.public_site_content(text) IS
  'Published content for one organisation, addressed by its UNIQUE slug. SECURITY INVOKER: it reads only the public projection and a three-column organisation view, so there is no RLS elevation to misuse and no private table in its body. Returns nothing for an organisation that is not active.';

REVOKE ALL ON FUNCTION public.public_site_content(text) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- SEEDING THE STATE MACHINES AT ORGANISATION CREATION
-- -----------------------------------------------------------------------------

-- Fired when an organisation is created, so no organisation can exist without a partner
-- machine or a content machine, and no record can be written into an organisation whose
-- tables are empty.
--
-- Empty-means-nothing-legal is the safe direction: an organisation whose seed failed
-- refuses every stage change rather than accepting every one. 0008 does this for the HR
-- machine and this trigger is its sibling — a second AFTER INSERT trigger on
-- `organization`, which is why 0008's trigger and this one coexist rather than being
-- merged into an edit to an applied migration.
CREATE OR REPLACE FUNCTION public.on_organization_created_commercial()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.seed_partner_state_transition(NEW.id);
  PERFORM public.seed_content_state_transition(NEW.id);
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.on_organization_created_commercial() IS
  'Seeds the partner and content state machines for a new organisation, so no organisation can exist without one and every record is judged against a populated transition table.';

REVOKE ALL ON FUNCTION public.on_organization_created_commercial() FROM PUBLIC;

CREATE TRIGGER organization_seeds_commercial_transitions
  AFTER INSERT ON organization
  FOR EACH ROW EXECUTE FUNCTION public.on_organization_created_commercial();

-- -----------------------------------------------------------------------------
-- APPEND-ONLY
-- -----------------------------------------------------------------------------

-- Two independent mechanisms, deliberately redundant and failing in opposite directions,
-- exactly as 0004 and 0008 do. The GRANT denies the application role the operation; the
-- trigger denies it to EVERYONE including the schema owner running a migration by hand.
-- Either alone leaves a path open — a privilege grant silently widened later, or an
-- operator with psql.
--
-- `insufficient_privilege` (42501) for both, so a caller sees "you may not do this"
-- whichever one refused, which is the truth.
CREATE OR REPLACE FUNCTION public.deny_commercial_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted; record the change as a new row',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

COMMENT ON FUNCTION public.deny_commercial_append_only_mutation() IS
  'Blocks UPDATE and DELETE on the Commercial tables where the history IS the product: an evidence row, a retraction, a stock movement and a published public row. Correction is a new row, never an edit.';

REVOKE ALL ON FUNCTION public.deny_commercial_append_only_mutation() FROM PUBLIC;

-- Evidence. The headline case: a row a sponsor disputes must say what it said forever, and
-- the only honest correction is a retraction that says who retracted it and why.
CREATE TRIGGER obligation_evidence_append_only
  BEFORE UPDATE OR DELETE ON obligation_evidence
  FOR EACH ROW EXECUTE FUNCTION public.deny_commercial_append_only_mutation();

-- The retraction, for the same reason `acceptance_withdrawal` is append-only in 0008: the
-- row that records that a claim was withdrawn must not itself be withdrawable, or "was
-- this ever retracted" becomes unanswerable.
CREATE TRIGGER obligation_evidence_retraction_append_only
  BEFORE UPDATE OR DELETE ON obligation_evidence_retraction
  FOR EACH ROW EXECUTE FUNCTION public.deny_commercial_append_only_mutation();

-- A stock movement is a fact about a moment. A mistake is a reversing movement, and the
-- books still add up — which is what the archive column exists to achieve, achieved
-- without a column that could never be set.
CREATE TRIGGER inventory_movement_append_only
  BEFORE UPDATE OR DELETE ON inventory_movement
  FOR EACH ROW EXECUTE FUNCTION public.deny_commercial_append_only_mutation();

-- A published public row. A page that can be silently edited after the fact is a claim
-- nobody can check; the correction is to republish, and the history of what was said is
-- what the projection is for.
CREATE TRIGGER public_site_publication_append_only
  BEFORE UPDATE OR DELETE ON public_site_publication
  FOR EACH ROW EXECUTE FUNCTION public.deny_commercial_append_only_mutation();

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- -----------------------------------------------------------------------------

-- Enabled AND forced, with the tenant predicate as the WHOLE policy and no IS NULL escape,
-- so an unset tenant context hides every row rather than exposing them (ADR-0015).
--
-- `public_site_publication` is NOT in this list, and that is the one deliberate exception
-- in the file. It is the public surface; a tenant predicate there would hide it. Its
-- safety is structural — seven vetted columns and a single session-scoped writer — and
-- `commercial.isolation.test.ts` asserts both facts, so the exception cannot quietly become
-- an oversight.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'partner','partner_state_transition',
    'contract_obligation','contract_obligation_part',
    'obligation_evidence','obligation_evidence_retraction',
    'inventory_item','inventory_movement',
    'creator_profile','content_item','content_state_transition',
    'invoice','invoice_line'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- PRIVILEGES
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO raptor_app;

-- Mutable tables: SELECT, INSERT and UPDATE, and NO DELETE. These are the tables with a
-- working document in them — a draft obligation, an item still being written, a partner
-- being worked. The guards above are what stop UPDATE being used for anything else.
GRANT SELECT, INSERT, UPDATE ON
  partner, partner_state_transition,
  contract_obligation, contract_obligation_part,
  inventory_item,
  creator_profile, content_item, content_state_transition,
  invoice, invoice_line
TO raptor_app;

-- The transition tables get NO INSERT and NO UPDATE from the application role: they are
-- governance data, seeded when the organisation is created. An organisation editing its
-- own legal lifecycle from a request handler is the "a stage table the app role can
-- rewrite is not a state machine" failure, and 0008 makes the same argument about
-- `hr_state_transition`. Only a migration or an operator changes them.
REVOKE INSERT, UPDATE, DELETE ON
  partner_state_transition, content_state_transition
FROM raptor_app;

-- Append-only tables: SELECT and INSERT only, and nothing else. Stated as an explicit
-- REVOKE as well as an absent GRANT, so a later migration that widens a grant cannot
-- accidentally hand back an UPDATE by omission.
GRANT SELECT, INSERT ON
  obligation_evidence, obligation_evidence_retraction, inventory_movement
TO raptor_app;

REVOKE UPDATE, DELETE ON
  obligation_evidence, obligation_evidence_retraction, inventory_movement
FROM raptor_app;

-- No hard deletes anywhere in this domain.
REVOKE DELETE ON
  partner, partner_state_transition,
  contract_obligation, contract_obligation_part,
  inventory_item, creator_profile, content_item, content_state_transition,
  invoice, invoice_line
FROM raptor_app;

-- The public read role gets EXACTLY TWO things, and the test asserts this grant list
-- column by column rather than trusting the comment here:
--
--   SELECT on public_site_publication   the vetted projection
--   SELECT on public_site_org           three organisation columns and no more
--
-- It gets NO grant on `organization`, on `person`, or on any tenant table — so an
-- anonymous page render cannot reach a person, an invoice or an obligation, and cannot
-- reach the organisation's own private fields either.
GRANT USAGE ON SCHEMA public TO raptor_public;
GRANT SELECT ON public.public_site_publication, public.public_site_org TO raptor_public;
GRANT EXECUTE ON FUNCTION public.public_site_content(text) TO raptor_public;

REVOKE ALL ON TABLE public.public_site_publication FROM PUBLIC;
REVOKE ALL ON TABLE public.public_site_org FROM PUBLIC;

-- The reporting and derivation functions. PUBLIC's automatic EXECUTE is taken back from
-- every one of them, so a role with no grants on the tables cannot reach the logic through
-- a function.
REVOKE ALL ON FUNCTION public.obligation_part_supported_quantity(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.obligation_part_discharge_status(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.obligation_derived_state_in_org(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.obligation_derived_state(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.obligation_discharge_report(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_obligation_part_fulfilment() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_obligation_discharge_consistent() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_inventory_window_overlap() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_inventory_not_oversold() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.seed_partner_state_transition(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.seed_content_state_transition(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_irreversible_reverse(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_partner_transition_irreversibility() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_content_transition_irreversibility() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_partner_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_content_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_invoice_balanced() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.on_organization_created_commercial() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deny_commercial_append_only_mutation() FROM PUBLIC;

-- The functions the application actually calls. The pure derivations and the report are
-- here; the guard and seeding functions are NOT, because a role that can call a guard
-- directly has no use for it — they are reachable only through a write.
--
-- `obligation_part_supported_quantity` and `obligation_part_discharge_status` are granted
-- because `obligation_discharge_report` is SECURITY INVOKER: it runs as its caller, so
-- every function it calls has to be executable BY that caller or the report is unusable
-- for exactly the role that is supposed to read it. Granting them widens nothing — they
-- are pure reads that return a count and a status string, and neither can read a row the
-- caller's own policies would hide, because the caller must already be able to SELECT the
-- evidence tables to have been given anything.
GRANT EXECUTE ON FUNCTION
  public.obligation_derived_state(uuid),
  public.obligation_derived_state_in_org(uuid, uuid),
  public.obligation_discharge_report(uuid),
  public.obligation_part_supported_quantity(uuid, uuid),
  public.obligation_part_discharge_status(uuid, uuid),
  public.publish_content_to_public_site(uuid)
TO raptor_app;

-- RLS is worthless to a role that can switch it off. Restated at the end of the file, as
-- 0001, 0002, 0004, 0005, 0006, 0007 and 0008 each do.
-- Reassert the application role attributes. Portable across self-hosted and managed databases: enforces where the owner is a superuser, verifies otherwise (see ensure_role_hardened(text) in 0001_tenancy.sql).
SELECT ensure_raptor_app_hardened();
SELECT ensure_role_hardened('raptor_public');

COMMIT;

-- ==========================================================================
-- SOURCE: packages/db/migrations/0010_operations.sql
-- ==========================================================================

-- =============================================================================
-- packages/db/migrations/0010_operations.sql
--
-- OPERATIONS: tasks, workflow runs, travel, assets and facilities.
--
-- THE DESIGN PROBLEM THIS FILE EXISTS TO SOLVE
-- ---------------------------------------------
-- The design spec closes Phase 6 on one sentence: "Tasks, workflows, travel,
-- assets, facilities provable end to end". Read carefully, the hard half of
-- that is the word PROVABLE. An operations tool that records "this task is done"
-- or "this laptop is with Priya" as a COLUMN is recording a claim. Four of the
-- five domains here have a specific historical failure to answer:
--
--   TASKS      A `status` column with a CHECK constraint can say what a row may
--              BE. It cannot say what a row may BECOME, because that is a
--              relation between two rows in time. So the legal transitions are
--              DATA in `task_state_transition`, seeded from the same table
--              `packages/core/src/tasks/task.ts` declares, and a trigger
--              refuses any move the table does not contain.
--
--   WORKFLOWS  A run is interrupted. Always. The design question is what the
--              second attempt is allowed to assume about the first, and the
--              answer is: the step record. `workflow_step_run` keeps its own
--              started_at, so a RESUMED step is distinguishable from a RESTARTED
--              one — which is the question an operator asks after an incident.
--              Every step carries a retry token derived from
--              (run_id, idempotency_scope) so a retry after a network timeout is
--              recognisable rather than performed twice.
--
--   TRAVEL     Travel for a minor carries guardian-sensitive detail and real
--              spend. ADR-0005's audit taxonomy has a `travel` class for exactly
--              this, and ADR-0016 records that the legacy system had no concept
--              of minors at all. So a trip traveller is REFUSED unless a guardian
--              consent exists that names THIS trip — and the consent must be
--              live, un-withdrawn, and the traveller must be over the floor.
--              `packages/core/src/minors` owns those rules; this file enforces
--              the storage of their evidence, not a second copy of them.
--
--   ASSETS     ADR-0016 found the legacy system could not say where a thing was.
--              The fix is structural: there is NO `holder_id` column anywhere in
--              this file. Custody is an append-only record and the holder is
--              DERIVED, exactly as `inventory_position` derives a stock balance in
--              0009 and for the same reason.
--
--   FACILITIES Double-booking. 0009 and 0006 both hit the same wall and both
--              record it: `btree_gist` is unavailable under PGlite and
--              `EXCLUDE USING gist` over uuid fails, so the overlap guard is a
--              TRIGGER, judged at COMMIT by a DEFERRABLE constraint trigger so a
--              batch of reservations is judged as a batch.
--
-- WHAT IS EXTENDED RATHER THAN DUPLICATED
-- ----------------------------------------
--   person, engagement, guardian_consent      0001 + 0008. Never recreated.
--   organization                               0001.
--
--   The guardian rules themselves live in 0008 (`guardian_consent_covers_in_org`)
--   and in `packages/core/src/minors`. This file STORES the evidence and calls
--   0008's function; it does not restate a majority threshold, and there is no
--   `is_minor` column anywhere in it — `trip_traveller.majority_at_travel` is a
--   DERIVED column maintained by a trigger from `person.birth_date`, so a
--   corrected date of birth corrects it everywhere at once rather than leaving
--   three copies to drift.
--
-- TENANCY
-- -------
-- Identical to 0001 through 0009 and not restated per table: org_id NOT NULL,
-- UNIQUE (org_id, id), every composite index leading with org_id, every FK
-- between tenant tables composite and including org_id, RLS ENABLED *and*
-- FORCED with the tenant predicate as the whole policy and no IS NULL escape
-- (ADR-0015). `person` is org-independent by design (ADR-0018) and is therefore
-- referenced by single-column foreign keys, exactly as `engagement.person_id` is.
--
-- NO HARD DELETES. Mutable tables carry `archived_at`; strictly append-only
-- tables carry none, because on a table where UPDATE is impossible an archive
-- column is a column permanently NULL (0004's rule).
--
-- Applied by the migration ledger. Never edited in place.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- ENUMERATIONS
-- -----------------------------------------------------------------------------

-- The vocabulary is declared ONCE here and in `packages/core/src/tasks/task.ts`.
-- `tasks.operators.test.ts` asserts the two agree by name, so the domain and the
-- schema cannot drift without a test failing — which is the whole reason the
-- transition table is DATA rather than prose in either place.
--
-- EVERY type is schema-qualified, and every function body that names one is too.
-- That is not tidiness: the functions below pin `search_path` to empty, and a
-- body is PARSED AT CREATION, so an unqualified type name would not resolve
-- there. 0009 states the same rule and gives the same reason.
CREATE TYPE public.task_state AS ENUM (
  'open', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'
);

CREATE TYPE public.task_priority AS ENUM ('low', 'normal', 'high', 'urgent');

CREATE TYPE public.workflow_run_status AS ENUM ('running', 'completed', 'declined', 'failed');

-- `failed` is DISTINCT from `completed`, not an outcome kind of it. A step that
-- errored ENDED without doing its work, and collapsing the two would let a
-- progress figure count it — the invented metric ADR-0019 was written against.
CREATE TYPE public.workflow_step_status AS ENUM ('pending', 'in_progress', 'completed', 'failed');

CREATE TYPE public.step_outcome_kind AS ENUM ('succeeded', 'declined', 'failed');

CREATE TYPE public.trip_status AS ENUM ('draft', 'awaiting_approval', 'approved', 'in_progress', 'completed', 'cancelled');

CREATE TYPE public.traveller_role AS ENUM ('player', 'staff', 'guardian', 'observer');

CREATE TYPE public.custody_kind AS ENUM ('issue', 'return', 'transfer', 'loss', 'disposal');

CREATE TYPE public.facility_reservation_state AS ENUM ('held', 'confirmed', 'cancelled');

-- -----------------------------------------------------------------------------
-- TASKS
-- -----------------------------------------------------------------------------

-- WHAT WAS PROMISED. `state` is the only mutable field, and a trigger refuses any
-- move the transition table does not contain — so a task cannot be born done,
-- and cannot skip review. See the file header.
CREATE TABLE task (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  title           varchar(200) NOT NULL,
  description     text,
  state           task_state NOT NULL DEFAULT 'open',
  priority        task_priority NOT NULL DEFAULT 'normal',
  -- Single-column: `person` is org-independent by design (ADR-0018), and a task
  -- assigned to somebody from another organisation is a business question, not
  -- a referential one. It is NOT NULL for the same reason `in_progress` requires
  -- an assignee in the domain: a task nobody owns is a task nobody does.
  assignee_id     uuid REFERENCES person(id) ON DELETE RESTRICT,
  due_at          timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- WHEN the task last MOVED, not when the row was written. Backfilled history
  -- belongs to the period it happened in (ADR-0019 rule 5).
  transitioned_at timestamptz,
  state_changed_by uuid REFERENCES person(id) ON DELETE RESTRICT,
  -- Required for `blocked` and `cancelled` and forbidden otherwise, by the same
  -- CHECK that binds evidence provenance in 0009: a reason beside a state that
  -- records no causation would read as authoritative and mean nothing.
  state_reason    varchar(400),
  -- THE TASK/WORKFLOW LINKAGE. Both null, or both set. A task a workflow step
  -- created names the run AND the step, so "which step produced this" is
  -- answerable from the task alone. A half-set pair is refused by the CHECK
  -- rather than completed with a guess.
  origin_run_id     uuid,
  origin_step_id    uuid,
  archived_at     timestamptz,
  CONSTRAINT task_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT task_state_reason_check CHECK (
        (state IN ('blocked', 'cancelled') AND state_reason IS NOT NULL AND btrim(state_reason) <> '')
     OR (state NOT IN ('blocked', 'cancelled') AND state_reason IS NULL)
      ),
  CONSTRAINT task_due_after_creation_check CHECK (due_at IS NULL OR due_at > created_at),
  CONSTRAINT task_transitioned_fields_check CHECK (
        (transitioned_at IS NULL AND state_changed_by IS NULL)
     OR (transitioned_at IS NOT NULL AND state_changed_by IS NOT NULL)
      ),
  CONSTRAINT task_origin_pair_check CHECK (
        (origin_run_id IS NULL AND origin_step_id IS NULL)
     OR (origin_run_id IS NOT NULL AND origin_step_id IS NOT NULL)
      ),
  CONSTRAINT task_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX task_org_idx             ON task (org_id);
CREATE INDEX task_org_state_idx       ON task (org_id, state);
CREATE INDEX task_org_assignee_idx    ON task (org_id, assignee_id);
CREATE INDEX task_org_due_idx         ON task (org_id, due_at);
CREATE INDEX task_org_origin_idx      ON task (org_id, origin_run_id, origin_step_id);
CREATE INDEX task_org_priority_idx    ON task (org_id, priority, due_at);

COMMENT ON TABLE task IS
  'A unit of work. `state` is the ONLY mutable field and every move is checked against task_state_transition at COMMIT. `done` is unreachable except through in_review, so a completed task has by construction passed a state somebody looked at. NO stored derived counts and NO stored progress: those are the stored-flag drift ADR-0016 records.';

-- THE LEGAL TRANSITIONS, AS DATA. The same table `packages/core/src/tasks/task.ts`
-- exports as `TASK_TRANSITIONS`; `tasks.operators.test.ts` asserts the two agree.
--
-- Seeded per organisation, exactly as 0008 seeds `hr_state_transition` and 0009
-- seeds `partner_state_transition`, and with the same argument: an organisation
-- whose transition table is empty refuses every move rather than accepting every
-- one. Empty-means-nothing-legal is the safe direction.
CREATE TABLE task_state_transition (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  from_state   task_state NOT NULL,
  to_state     task_state NOT NULL,
  -- NO self-edge. `x -> x` is a no-op that reads as a second occurrence of the
  -- thing, and in an append-only transition log it would inflate the count of
  -- real moves.
  CONSTRAINT task_state_transition_no_self_edge_check CHECK (from_state <> to_state),
  -- One edge per (from, to). A duplicate would make "which rules apply here" a
  -- question with two answers.
  CONSTRAINT task_state_transition_edge_key UNIQUE (org_id, from_state, to_state),
  -- ADR-0011 requires UNIQUE (org_id, id) on every tenant table so that a child
  -- table may reference one by the composite form. This table has no child today,
  -- which is exactly why it is easy to omit — and exactly why it should not be,
  -- because the next table to reference a transition edge would then be unable
  -- to do so with a composite FK and would fall back to a single-column one,
  -- reopening the isolation hole this convention exists to close.
  CONSTRAINT task_state_transition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX task_state_transition_org_idx ON task_state_transition (org_id);

COMMENT ON TABLE task_state_transition IS
  'The legal task transitions for one organisation, as DATA. Seeded from the same table packages/core declares; a trigger refuses any state change not present here. Immutable governance: only a migration or an operator changes it.';

-- Dependencies as EDGES rather than a self-referencing id list, because a cycle in
-- a self-list needs a recursive CTE to detect and an edge set does not.
--
-- The database does NOT try to detect cycles here, and that is a decision rather
-- than an omission: a cycle is a SCHEDULING property of a whole graph, and
-- `packages/core/src/tasks/dependencies.ts` owns it with a three-colour DFS. What
-- the database does own is the weaker, row-local guarantee — a dependency must
-- name a task that EXISTS in the same organisation — which a composite FK gives
-- structurally (ADR-0011). The cycle refusal is tested in core, where the
-- algorithm lives, and the test file here says so rather than implying otherwise.
CREATE TABLE task_dependency (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- The blocked task.
  task_id             uuid NOT NULL,
  -- The blocker. Composite FK, so a cross-tenant dependency cannot be created
  -- even by a careless developer: the referenced row does not exist in the other
  -- organisation, so the insert fails.
  depends_on_task_id  uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_dependency_task_fk
    FOREIGN KEY (org_id, task_id) REFERENCES task (org_id, id) ON DELETE CASCADE,
  CONSTRAINT task_dependency_blocker_fk
    FOREIGN KEY (org_id, depends_on_task_id) REFERENCES task (org_id, id) ON DELETE RESTRICT,
  -- A task blocked by itself is the degenerate cycle and is unreadable on a
  -- board as well as unschedulable.
  CONSTRAINT task_dependency_no_self_check CHECK (task_id <> depends_on_task_id),
  CONSTRAINT task_dependency_edge_key UNIQUE (org_id, task_id, depends_on_task_id),
  CONSTRAINT task_dependency_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX task_dependency_org_idx      ON task_dependency (org_id);
CREATE INDEX task_dependency_org_task_idx ON task_dependency (org_id, task_id);
CREATE INDEX task_dependency_org_block_idx ON task_dependency (org_id, depends_on_task_id);

COMMENT ON TABLE task_dependency IS
  'Task A depends on task B: A may not start until B is done. Composite FKs make a cross-organisation dependency structurally impossible (ADR-0011). CYCLE detection is NOT here — it is a property of the whole graph and lives in packages/core/src/tasks/dependencies.ts with a three-colour DFS; this table guarantees only that every edge names a real task in the same organisation.';

-- WHAT HAPPENED. Append-only: a transition is a fact about a moment, so a
-- correction is a new row, never an UPDATE of the old one. There is no
-- `archived_at` here because UPDATE is impossible (0004's rule).
CREATE TABLE task_transition (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  task_id      uuid NOT NULL,
  from_state   task_state NOT NULL,
  to_state     task_state NOT NULL,
  -- WHEN the move happened, not when the row was written. A backfilled
  -- transition belongs to the day it happened (ADR-0019 rule 5).
  occurred_at  timestamptz NOT NULL,
  actor_id     uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  -- Required for `blocked` and `cancelled`, forbidden otherwise — the same binding
  -- `task.state_reason_check` enforces on the row itself, asserted here so a
  -- transition LOG cannot disagree with the task it describes. A log entry that
  -- recorded a cancellation with no reason would be a record of a decision
  -- nobody could be shown.
  reason       varchar(400),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_transition_task_fk
    FOREIGN KEY (org_id, task_id) REFERENCES task (org_id, id) ON DELETE CASCADE,
  CONSTRAINT task_transition_no_self_edge_check CHECK (from_state <> to_state),
  CONSTRAINT task_transition_reason_check CHECK (
        (to_state IN ('blocked', 'cancelled') AND reason IS NOT NULL AND btrim(reason) <> '')
     OR (to_state NOT IN ('blocked', 'cancelled') AND reason IS NULL)
      ),
  CONSTRAINT task_transition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX task_transition_org_idx       ON task_transition (org_id);
CREATE INDEX task_transition_org_task_idx  ON task_transition (org_id, task_id);
CREATE INDEX task_transition_org_time_idx  ON task_transition (org_id, occurred_at);

COMMENT ON TABLE task_transition IS
  'One recorded task move: what it was, what it became, when, and who. Append-only with no archived_at, because UPDATE is impossible — a mistake is corrected by a further transition, not by editing this one.';

-- -----------------------------------------------------------------------------
-- WORKFLOWS
-- -----------------------------------------------------------------------------

-- THE SHAPE of a process. No state of its own, which is the point: two runs of
-- one definition execute concurrently and must not be able to see each other.
CREATE TABLE workflow_definition (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  slug           varchar(80) NOT NULL,
  name           varchar(200) NOT NULL,
  -- An INSTANT, supplied rather than defaulted from a clock, so a definition
  -- imported from another system keeps its real age.
  created_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  CONSTRAINT workflow_definition_slug_check CHECK (slug ~ '^[a-z0-9][a-z0-9_-]*$'),
  CONSTRAINT workflow_definition_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT workflow_definition_org_slug_key UNIQUE (org_id, slug),
  CONSTRAINT workflow_definition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX workflow_definition_org_idx ON workflow_definition (org_id);

CREATE TABLE workflow_step_definition (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  definition_id      uuid NOT NULL,
  step_id            varchar(80) NOT NULL,
  title              varchar(200) NOT NULL,
  -- ZERO-BASED and EXPLICIT rather than derived from array position or a
  -- sequence: step order IS the workflow, and "quote, approve, book" sorted
  -- alphabetically becomes "approve, book, quote" — a process that approves a
  -- quote nobody has written.
  position           integer NOT NULL,
  -- Names the real-world effect and is UNIQUE within the definition. The run's
  -- retry token is derived from it, so it is what a downstream system dedupes
  -- on. Two steps sharing one scope would share one token, and a retry of the
  -- first would be swallowed by the second's record.
  idempotency_scope  varchar(120) NOT NULL,
  -- Whether this step must record an outcome. Set on any step that can end
  -- without doing its work, so "declined" and "never reached" stay distinct.
  outcome_required   boolean NOT NULL DEFAULT false,
  -- A step that may only be started after this instant.
  not_before         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_step_definition_definition_fk
    FOREIGN KEY (org_id, definition_id) REFERENCES workflow_definition (org_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_step_definition_step_key UNIQUE (org_id, definition_id, step_id),
  CONSTRAINT workflow_step_definition_position_key UNIQUE (org_id, definition_id, position),
  CONSTRAINT workflow_step_definition_scope_key UNIQUE (org_id, definition_id, idempotency_scope),
  CONSTRAINT workflow_step_definition_position_check CHECK (position >= 0),
  CONSTRAINT workflow_step_definition_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT workflow_step_definition_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX workflow_step_definition_org_idx ON workflow_step_definition (org_id);
CREATE INDEX workflow_step_definition_org_def_idx ON workflow_step_definition (org_id, definition_id, position);

-- ONE EXECUTION of one definition against one subject.
CREATE TABLE workflow_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  definition_id  uuid NOT NULL,
  -- The thing being processed. A run with no subject cannot say what it
  -- accomplished.
  subject_id     uuid NOT NULL,
  -- A CACHED AGGREGATE over the step rows, and the same bargain 0009 strikes for
  -- `contract_obligation.state`: stored because "where is this request" must be
  -- one indexed read, and made honest by a DEFERRED trigger that re-derives it
  -- at COMMIT and refuses any transaction leaving the two disagreeing.
  status         workflow_run_status NOT NULL DEFAULT 'running',
  started_at     timestamptz NOT NULL,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_run_definition_fk
    FOREIGN KEY (org_id, definition_id) REFERENCES workflow_definition (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT workflow_run_subject_check CHECK (subject_id IS NOT NULL),
  -- A terminal status carries a completion instant and a running one does not.
  -- Otherwise "when did this finish" has two answers for a finished run.
  CONSTRAINT workflow_run_completion_check CHECK (
        (status IN ('completed', 'declined', 'failed') AND completed_at IS NOT NULL)
     OR (status = 'running' AND completed_at IS NULL)
      ),
  CONSTRAINT workflow_run_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX workflow_run_org_idx           ON workflow_run (org_id);
CREATE INDEX workflow_run_org_def_idx       ON workflow_run (org_id, definition_id);
CREATE INDEX workflow_run_org_subject_idx   ON workflow_run (org_id, subject_id);
CREATE INDEX workflow_run_org_status_idx    ON workflow_run (org_id, status);

COMMENT ON TABLE workflow_run IS
  'One execution of a workflow definition against one subject. `status` is a CACHED AGGREGATE over workflow_step_run, constrained to equal its derivation at COMMIT by assert_workflow_run_consistent — stored for one indexed read, made honest by a trigger, and therefore unable to drift.';

-- THE DURABLE FACT OF RESUMABILITY.
--
-- `started_at` is written once and never moved. That single fact is what makes
-- a RESUME distinguishable from a RESTART: after an incident, "has this step
-- been running for four hours or did something just retry it" is answerable, and
-- it is the question an operator actually asks.
CREATE TABLE workflow_step_run (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  run_id            uuid NOT NULL,
  definition_step_id uuid NOT NULL,
  status            workflow_step_status NOT NULL DEFAULT 'pending',
  started_at        timestamptz,
  completed_at      timestamptz,
  -- Derived from (run_id, idempotency_scope), length-framed, by the function
  -- below. STORED as well as derived, because a token a downstream system
  -- deduped on has to be re-verifiable from the row alone years later.
  retry_token       varchar(64) NOT NULL,
  outcome_kind      step_outcome_kind,
  outcome_reason    varchar(400),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_step_run_run_fk
    FOREIGN KEY (org_id, run_id) REFERENCES workflow_run (org_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_step_run_step_fk
    FOREIGN KEY (org_id, definition_step_id) REFERENCES workflow_step_definition (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT workflow_step_run_step_key UNIQUE (org_id, run_id, definition_step_id),
  CONSTRAINT workflow_step_run_token_key UNIQUE (org_id, retry_token),
  -- The lifecycle each status permits, in one CHECK. A `pending` row with a
  -- completed_at is a record that claims work finished before anyone began it.
  CONSTRAINT workflow_step_run_timing_check CHECK (
        (status = 'pending'    AND started_at IS NULL     AND completed_at IS NULL)
     OR (status = 'in_progress' AND started_at IS NOT NULL AND completed_at IS NULL)
     OR (status IN ('completed', 'failed') AND started_at IS NOT NULL AND completed_at IS NOT NULL)
      ),
  CONSTRAINT workflow_step_run_outcome_check CHECK (
        (outcome_kind IS NULL AND outcome_reason IS NULL)
     OR (outcome_kind IN ('succeeded') AND outcome_reason IS NULL)
     OR (outcome_kind IN ('declined', 'failed') AND outcome_reason IS NOT NULL AND btrim(outcome_reason) <> '')
      ),
  CONSTRAINT workflow_step_run_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX workflow_step_run_org_idx      ON workflow_step_run (org_id);
CREATE INDEX workflow_step_run_org_run_idx   ON workflow_step_run (org_id, run_id);
CREATE INDEX workflow_step_run_org_time_idx  ON workflow_step_run (org_id, started_at);

-- The composite key a task's origin is checked against. Declared HERE rather
-- than inline in `workflow_step_run` because `task` is created earlier in this
-- file and cannot be given a forward reference; the alternative — creating
-- `task` after this table — would reorder the whole domain for one constraint.
ALTER TABLE workflow_step_run
  ADD CONSTRAINT workflow_step_run_run_step_key UNIQUE (org_id, run_id, definition_step_id);

-- THE TASK→STEP LINK IS A FOREIGN KEY, not merely a pair of columns.
--
-- A task naming a (run, step) that does not exist is a task with no traceable
-- origin, and the composite form means the step row must be in THIS
-- organisation's run — so a cross-tenant origin is structurally impossible
-- rather than merely discouraged (ADR-0011).
--
-- DEFERRABLE INITIALLY DEFERRED, because the legal order in a real workflow is
-- the REVERSE of the obvious one: the step is started, then the task is created
-- naming it. An immediate constraint would refuse the task until the step row
-- committed, which for a single transaction containing both is impossible.
ALTER TABLE task
  ADD CONSTRAINT task_origin_fk
  FOREIGN KEY (org_id, origin_run_id, origin_step_id)
  REFERENCES workflow_step_run (org_id, run_id, definition_step_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

COMMENT ON TABLE workflow_step_run IS
  'One step''s durable state within one run. `started_at` is written once and never moved, which is what makes a resume distinguishable from a restart. `status = failed` is DISTINCT from completed because a step that errored ended without doing its work, and collapsing the two would let a progress figure count it.';

-- THE RETRY TOKEN.
--
-- sha-256 over (run_id, idempotency_scope), separated by `|`, via the BUILT-IN
-- `sha256(bytea)` function.
--
-- `digest()` from pgcrypto is NOT used, and that is an environment fact rather
-- than a preference: 0001 already records that the PGlite build ships a subset
-- of contrib, and this one does not carry pgcrypto. `sha256(bytea)` is core
-- PostgreSQL 14+ and yields the same digest, so the token is identical on every
-- target.
--
-- The `|` separator stands in for the length-framed form `packages/core` uses in
-- `contracts/version.ts`, and the gap is closed structurally rather than
-- lexically: `p_run_id` is a uuid and can never contain `|`, so no pair of
-- distinct inputs can produce one token. That argument is recorded because a
-- reader comparing this function with `contracts/version.ts` will notice the
-- difference and should find it already answered.
--
-- SECURITY DEFINER because it reads `workflow_step_definition` and the trigger
-- that calls it runs as its invoker.
CREATE OR REPLACE FUNCTION public.workflow_retry_token(p_org_id uuid, p_run_id uuid, p_step_definition_id uuid)
RETURNS varchar
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT encode(
           sha256(convert_to(p_run_id::text || '|' || s.idempotency_scope, 'UTF8')),
           'hex'
         )
    FROM public.workflow_step_definition s
   WHERE s.org_id = p_org_id
     AND s.id     = p_step_definition_id
$$;

COMMENT ON FUNCTION public.workflow_retry_token(uuid, uuid, uuid) IS
  'The retry token for one step of one run: sha-256 over the run id and the step''s idempotency scope. Stored on workflow_step_run so a token a downstream system deduped on is re-verifiable from the row alone. Returns NULL when the step is not part of the named organisation.';

-- -----------------------------------------------------------------------------
-- TRAVEL
-- -----------------------------------------------------------------------------

CREATE TABLE trip (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- THE ENGAGEMENT a guardian consents to.
  --
  -- Not nullable and not defaulted. 0008 established that consent is to an
  -- ENGAGEMENT and never a global flag — "this person's guardian said yes at
  -- some point" is not "this person's guardian said yes to THIS trip" — so a
  -- trip with no engagement could never carry a valid consent, and the column is
  -- required rather than optional to make that unexpressible.
  engagement_id   uuid NOT NULL,
  title           varchar(200) NOT NULL,
  status          trip_status NOT NULL DEFAULT 'draft',
  purpose         text,
  -- WHEN the trip BEGINS. The event date, not `created_at`: a trip booked in
  -- March for June belongs to June in every report (ADR-0019 rule 5).
  departs_at      timestamptz NOT NULL,
  returns_at      timestamptz NOT NULL,
  -- REAL SPEND, in the column types ADR-0003 governs. A trip's cost is real
  -- money that leaves the organisation, and ADR-0005's `travel` audit class
  -- exists because the legacy system had both the minors and the spend
  -- untracked.
  budget_amount   numeric(18,4),
  budget_currency varchar(3),
  actual_amount   numeric(18,4),
  actual_currency varchar(3),
  created_by      uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CONSTRAINT trip_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT trip_window_check CHECK (returns_at > departs_at),
  -- Composite FK to 0001's engagement, so a trip cannot be attached to another
  -- organisation's engagement — and therefore cannot carry another
  -- organisation's guardian consent (ADR-0011).
  CONSTRAINT trip_engagement_fk
    FOREIGN KEY (org_id, engagement_id) REFERENCES engagement (org_id, id) ON DELETE RESTRICT,
  -- Both columns of a money pair or neither. A budget with no currency is a
  -- number whose unit nobody stated.
  --
  -- THE `IS NOT NULL` ON THE CURRENCY IS LOAD-BEARING, and it was found by a test
  -- rather than by reading. Written as
  --     (budget_amount IS NOT NULL AND budget_currency ~ '^[A-Z]{3}$')
  -- this CHECK PASSES for a row with an amount and a NULL currency, because
  -- `NULL ~ '...'` is NULL and a CHECK constraint rejects only an explicit FALSE
  -- — a three-valued-logic hole through which "500.0000 in no currency at all"
  -- walks straight in. `IS NOT NULL AND` closes it: a NULL currency now makes
  -- the whole conjunction FALSE rather than UNKNOWN.
  --
  -- This is the same class of bug as the `trip_traveller` consent check that was
  -- removed for a related reason, and the rule generalises: **a CHECK that can
  -- evaluate to NULL is not enforcing anything.** Every money-pair CHECK in this
  -- file is written to be total.
  CONSTRAINT trip_budget_money_check CHECK (
        (budget_amount IS NULL AND budget_currency IS NULL)
     OR (budget_amount IS NOT NULL AND budget_currency IS NOT NULL AND budget_currency ~ '^[A-Z]{3}$')
      ),
  CONSTRAINT trip_actual_money_check CHECK (
        (actual_amount IS NULL AND actual_currency IS NULL)
     OR (actual_amount IS NOT NULL AND actual_currency IS NOT NULL AND actual_currency ~ '^[A-Z]{3}$')
      ),
  CONSTRAINT trip_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX trip_org_idx        ON trip (org_id);
CREATE INDEX trip_org_departs_idx ON trip (org_id, departs_at);
CREATE INDEX trip_org_status_idx  ON trip (org_id, status);

COMMENT ON TABLE trip IS
  'A journey with legs, travellers and destinations. `departs_at` is the EVENT date every travel report filters on, never created_at (ADR-0019 rule 5). Budget and actual spend are numeric(18,4) with an ISO 4217 currency beside them (ADR-0003); ADR-0005''s `travel` audit class exists because the legacy system tracked neither this spend nor the minors travelling.';

CREATE TABLE trip_destination (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  trip_id      uuid NOT NULL,
  -- WHERE. Free text rather than a reference table: the set of places an esports
  -- organisation travels to is not a closed vocabulary, and inventing one would
  -- make a genuinely new venue unrepresentable.
  place        varchar(200) NOT NULL,
  country_code char(2),
  -- Arrival order within the trip, explicit for the same reason step position is.
  position     integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_destination_trip_fk
    FOREIGN KEY (org_id, trip_id) REFERENCES trip (org_id, id) ON DELETE CASCADE,
  CONSTRAINT trip_destination_place_check CHECK (btrim(place) <> ''),
  CONSTRAINT trip_destination_position_key UNIQUE (org_id, trip_id, position),
  CONSTRAINT trip_destination_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX trip_destination_org_idx     ON trip_destination (org_id);
CREATE INDEX trip_destination_org_trip_idx ON trip_destination (org_id, trip_id, position);

-- A leg. Real spend per leg, so "which leg cost the most" is answerable rather
-- than inferred from a trip-level total.
CREATE TABLE trip_leg (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  trip_id          uuid NOT NULL,
  from_destination_id uuid NOT NULL,
  to_destination_id   uuid NOT NULL,
  position         integer NOT NULL,
  -- INSTANTS, not a date: a leg that departs at 02:00 on the 3rd and arrives at
  -- 06:00 on the 4th is a fact about two moments.
  departs_at       timestamptz NOT NULL,
  arrives_at       timestamptz NOT NULL,
  cost_amount      numeric(18,4),
  cost_currency    varchar(3),
  carrier          varchar(120),
  confirmation_ref varchar(120),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_leg_trip_fk
    FOREIGN KEY (org_id, trip_id) REFERENCES trip (org_id, id) ON DELETE CASCADE,
  CONSTRAINT trip_leg_from_destination_fk
    FOREIGN KEY (org_id, from_destination_id) REFERENCES trip_destination (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT trip_leg_to_destination_fk
    FOREIGN KEY (org_id, to_destination_id) REFERENCES trip_destination (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT trip_leg_position_key UNIQUE (org_id, trip_id, position),
  -- A leg arriving before it departs, or from where it arrives to, is either a
  -- typo or a lie, and both make "when was this trip" unanswerable.
  CONSTRAINT trip_leg_window_check CHECK (arrives_at > departs_at),
  CONSTRAINT trip_leg_distinct_destination_check CHECK (from_destination_id <> to_destination_id),
  -- `IS NOT NULL` on the currency for the three-valued-logic reason spelled out
  -- at `trip_budget_money_check`: `NULL ~ '^[A-Z]{3}$'` is NULL, and a CHECK
  -- rejects only an explicit FALSE.
  CONSTRAINT trip_leg_money_check CHECK (
        (cost_amount IS NULL AND cost_currency IS NULL)
     OR (cost_amount IS NOT NULL AND cost_currency IS NOT NULL AND cost_currency ~ '^[A-Z]{3}$')
      ),
  CONSTRAINT trip_leg_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX trip_leg_org_idx     ON trip_leg (org_id);
CREATE INDEX trip_leg_org_trip_idx ON trip_leg (org_id, trip_id, position);
CREATE INDEX trip_leg_org_time_idx ON trip_leg (org_id, departs_at);

-- WHO IS GOING, AND — FOR A MINOR — WHO CONSENTED.
--
-- `guardian_consent_id` is the WHOLE of the guardian link in storage. It is a
-- composite FK to 0008's `guardian_consent`, so a consent from another
-- organisation cannot be attached (ADR-0011), and the guard below checks that
-- the consent actually COVERS this trip — that it names this engagement, is not
-- withdrawn, and has not expired.
--
-- NO `is_minor` COLUMN. A stored minority flag is wrong the moment a date of
-- birth is corrected, and wrong SILENTLY; `majority_at_departure` is derived by
-- a trigger from `person.birth_date` using 0008's `majority_status`, so a
-- corrected birth date corrects it everywhere at once.
CREATE TABLE trip_traveller (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  trip_id                uuid NOT NULL,
  -- Single-column: `person` is org-independent (ADR-0018).
  person_id              uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  role                   traveller_role NOT NULL,
  -- DERIVED by trigger from person.birth_date, never written by a caller.
  --
  -- NOT NULL is safe here and NOT safe on the consent requirement, and the
  -- difference is worth stating: `guard_trip_traveller_consent` is a BEFORE
  -- INSERT trigger, so it has ALWAYS run by the time this column's NOT NULL is
  -- evaluated. It always sets a value — 'minor', 'adult' or 'unknown' — so NOT
  -- NULL cannot fire spuriously, and it makes "a traveller whose majority was
  -- never derived" unrepresentable rather than merely unlikely.
  majority_at_departure  text NOT NULL,
  -- Null for an adult. Required by the guard below for a KNOWN minor — which is
  -- the whole point of the table.
  guardian_consent_id    uuid,
  -- Free-text emergency and medical detail, deliberately NOT modelled as
  -- columns: the shape varies by jurisdiction and by traveller, and a fixed
  -- schema would be a guess dressed as a standard. The audit trail is the row.
  emergency_contact      text,
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_traveller_trip_fk
    FOREIGN KEY (org_id, trip_id) REFERENCES trip (org_id, id) ON DELETE CASCADE,
  CONSTRAINT trip_traveller_consent_fk
    FOREIGN KEY (org_id, guardian_consent_id) REFERENCES guardian_consent (org_id, id) ON DELETE RESTRICT,
  -- One traveller per person per trip. Two rows would mean the traveller is
  -- going twice, which is either a duplicate or a lie about capacity.
  CONSTRAINT trip_traveller_person_key UNIQUE (org_id, trip_id, person_id),
  --
  -- NO "a minor needs a consent" CHECK HERE, and the absence is a correction.
  --
  -- An earlier draft put it here as a CHECK on `majority_at_departure`, which
  -- does not work and fails OPEN — the worst possible direction. PostgreSQL
  -- evaluates a CHECK against the row as it stands when the statement runs, and
  -- `majority_at_departure` is NULL at that moment because it is filled in by a
  -- BEFORE INSERT trigger that fires afterwards. So `NULL IS DISTINCT FROM
  -- 'minor'` was TRUE, every minor was admitted with no consent, and the check
  -- silently protected nobody.
  --
  -- The rule therefore lives in `guard_trip_traveller_consent` below, which is
  -- guaranteed to run BEFORE the row is checked and which computes majority
  -- itself. A constraint that cannot see the value it is constraining is not a
  -- constraint.
  -- A known minor needs a live consent; an adult does not, and neither does a
  -- person whose birth date nobody recorded — `unknown` means UNKNOWN and never
  -- means adult, and 0008's reasoning applies unchanged: refusing every traveller
  -- whose birth date is missing would be a decision this schema has no basis for.
  -- The residual gap (an unknown-age traveller with no consent) is a gap in the
  -- DATA, not in the constraint, and is named in the file header rather than
  -- hidden.
  CONSTRAINT trip_traveller_majority_check CHECK (
        majority_at_departure IN ('minor', 'adult', 'unknown')
      ),
  CONSTRAINT trip_traveller_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX trip_traveller_org_idx       ON trip_traveller (org_id);
CREATE INDEX trip_traveller_org_trip_idx  ON trip_traveller (org_id, trip_id);
CREATE INDEX trip_traveller_org_person_idx ON trip_traveller (org_id, person_id);

COMMENT ON TABLE trip_traveller IS
  'One person travelling on one trip. `majority_at_departure` is DERIVED by trigger from person.birth_date through 0008''s majority_status() — there is no stored is_minor flag anywhere, because a stored flag is wrong the moment a birth date is corrected and wrong silently. A KNOWN minor REQUIRES a guardian_consent_id, and the guard below additionally requires that consent to COVER this trip, be un-withdrawn and unexpired.';

-- -----------------------------------------------------------------------------
-- ASSETS
-- -----------------------------------------------------------------------------

-- WHAT A THING IS. There is NO `holder_id` column anywhere in this file, and
-- that absence is the design.
--
-- ADR-0016 found the legacy system could not say where a thing was. The fix it
-- implies is structural rather than procedural: a mutable holder column records
-- the CURRENT holder and destroys every previous one, so "who had this in March"
-- becomes unanswerable the moment the column is updated. `asset_custody` is
-- append-only and `asset_holder_at` DERIVES the answer, exactly as
-- `inventory_position` derives a stock balance in 0009 and for the same reason.
CREATE TABLE asset (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- Tagged. A barcode or asset tag, which is how the thing is found in a room.
  asset_tag       varchar(64) NOT NULL,
  name            varchar(200) NOT NULL,
  category        varchar(60) NOT NULL,
  serial_number   varchar(120),
  -- Free text rather than a FK to a purchase: the provenance of a laptop lives
  -- in a procurement system this schema does not model, and a dangling FK is a
  -- worse answer than an honest reference.
  purchased_at    timestamptz,
  purchase_amount numeric(18,4),
  purchase_currency varchar(3),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CONSTRAINT asset_tag_check CHECK (btrim(asset_tag) <> ''),
  CONSTRAINT asset_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT asset_category_check CHECK (category ~ '^[a-z][a-z0-9_]*$'),
  -- `IS NOT NULL` on the currency: see `trip_budget_money_check` for why a CHECK
  -- that can evaluate to NULL enforces nothing.
  CONSTRAINT asset_purchase_money_check CHECK (
        (purchase_amount IS NULL AND purchase_currency IS NULL)
     OR (purchase_amount IS NOT NULL AND purchase_currency IS NOT NULL AND purchase_currency ~ '^[A-Z]{3}$')
      ),
  CONSTRAINT asset_org_tag_key UNIQUE (org_id, asset_tag),
  CONSTRAINT asset_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX asset_org_idx       ON asset (org_id);
CREATE INDEX asset_org_category_idx ON asset (org_id, category);

COMMENT ON TABLE asset IS
  'A trackable thing. There is deliberately NO holder column: custody is an append-only record and the current holder is DERIVED, because a mutable holder_id overwrites every previous holder and makes "where was this last March" unanswerable — precisely the gap ADR-0016 found in the legacy system.';

-- WHO HELD IT, WHEN. Strictly append-only, no `archived_at` because UPDATE is
-- impossible (0004's rule).
--
-- A custody record either ASSIGNS the asset (`to_person_id` set, `from_person_id`
-- null — the first issue) or TRANSFERS it (both set — a hand-over). That
-- distinction is a CHECK rather than a convention because "who returned it and
-- to whom" is the question the table exists to answer.
CREATE TABLE asset_custody (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  asset_id       uuid NOT NULL,
  kind           custody_kind NOT NULL,
  -- Null on the FIRST issue only.
  from_person_id uuid REFERENCES person(id) ON DELETE RESTRICT,
  to_person_id   uuid REFERENCES person(id) ON DELETE RESTRICT,
  -- WHEN the custody changed, not when the row was written.
  occurred_at    timestamptz NOT NULL,
  -- A loss or disposal ends custody with nobody holding it; an issue or transfer
  -- ends with somebody holding it.
  condition_note text,
  reason         varchar(400),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_custody_asset_fk
    FOREIGN KEY (org_id, asset_id) REFERENCES asset (org_id, id) ON DELETE CASCADE,
  -- The shape each kind is allowed. The reading is about WHERE THE ASSET GOES,
  -- and it is the thing that makes the derived holder correct:
  --
  --   issue    from = the stockroom (NULL), to = the person. The FIRST event.
  --   return   from = the person,   to = the stockroom (NULL). The LAST event,
  --            and `to_person_id IS NULL` is exactly what makes
  --            `asset_holder_at` answer "nobody" afterwards rather than naming
  --            whoever last had it.
  --   transfer from = the person,   to = the next person. A hand-over.
  --   loss / disposal   to = NULL. It is with nobody, which is a real state and
  --            the one `asset_holder_at` reports as NULL.
  --
  -- So `to_person_id IS NULL` is REQUIRED for return/loss/disposal, not merely
  -- permitted for it. An earlier draft of this file allowed a `return` to name a
  -- recipient, and every return then left the asset looking held by them — which
  -- is the "where was this" answer being wrong in the direction that hides a
  -- missing item.
  CONSTRAINT asset_custody_shape_check CHECK (
        (kind = 'issue'                 AND from_person_id IS NULL     AND to_person_id IS NOT NULL)
     OR (kind IN ('return', 'transfer') AND from_person_id IS NOT NULL AND to_person_id IS NOT NULL)
     OR (kind IN ('loss', 'disposal')    AND to_person_id IS NULL)
      ),
  -- The asset cannot be handed to the person returning it. That is not an
  -- unusual hand-over; it is nobody handing over.
  CONSTRAINT asset_custody_distinct_people_check CHECK (
        to_person_id IS NULL OR from_person_id IS NULL OR to_person_id <> from_person_id
      ),
  CONSTRAINT asset_custody_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX asset_custody_org_idx       ON asset_custody (org_id);
CREATE INDEX asset_custody_org_asset_idx ON asset_custody (org_id, asset_id, occurred_at);
CREATE INDEX asset_custody_org_to_idx    ON asset_custody (org_id, to_person_id);
CREATE INDEX asset_custody_org_from_idx  ON asset_custody (org_id, from_person_id);

COMMENT ON TABLE asset_custody IS
  'One append-only custody record: who held the asset, from when, and what changed. NOT a mutable holder column. Two events may not share an instant for one asset — that ambiguity is refused below — so "who held this at 14:00" has exactly one answer.';

-- -----------------------------------------------------------------------------
-- FACILITIES
-- -----------------------------------------------------------------------------

CREATE TABLE facility (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name           varchar(200) NOT NULL,
  -- Bookable or not: a server room that nobody may book is a fact worth
  -- recording, and encoding it as a row rather than as its absence from the book
  -- means "why can I not book this" has an answer.
  bookable       boolean NOT NULL DEFAULT true,
  -- Concurrent capacity. 1 for a room; more for a booth bank. NULL for
  -- unbounded, which is a different claim from 1 and not the same default.
  capacity       integer,
  time_zone      varchar(64) NOT NULL DEFAULT 'UTC',
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  CONSTRAINT facility_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT facility_capacity_check CHECK (capacity IS NULL OR capacity > 0),
  CONSTRAINT facility_org_name_key UNIQUE (org_id, name),
  CONSTRAINT facility_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX facility_org_idx ON facility (org_id);

COMMENT ON TABLE facility IS
  'A bookable resource. `capacity` is NULL for unbounded, which is a DIFFERENT claim from 1 — a room holds one booking and a booth bank holds several, and defaulting one to the other silently loses bookings.';

CREATE TABLE facility_reservation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  facility_id       uuid NOT NULL,
  purpose           varchar(200) NOT NULL,
  state             facility_reservation_state NOT NULL DEFAULT 'confirmed',
  -- HALF-OPEN [starts_at, ends_at), the same convention `inventory_item` uses for
  -- effective dating. A 09:00–10:00 booking and a 10:00–11:00 booking therefore
  -- do NOT overlap, which is what makes back-to-back scheduling possible at all.
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  requested_by      uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facility_reservation_facility_fk
    FOREIGN KEY (org_id, facility_id) REFERENCES facility (org_id, id) ON DELETE CASCADE,
  CONSTRAINT facility_reservation_window_check CHECK (ends_at > starts_at),
  CONSTRAINT facility_reservation_purpose_check CHECK (btrim(purpose) <> ''),
  CONSTRAINT facility_reservation_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX facility_reservation_org_idx       ON facility_reservation (org_id);
CREATE INDEX facility_reservation_org_facility_idx ON facility_reservation (org_id, facility_id, starts_at);
CREATE INDEX facility_reservation_org_time_idx  ON facility_reservation (org_id, starts_at);

COMMENT ON TABLE facility_reservation IS
  'One booking of one facility, half-open [starts_at, ends_at) so back-to-back bookings are legal. Overlap is refused by a DEFERRABLE CONSTRAINT TRIGGER, judged at COMMIT so a batch of bookings is judged as a batch — an IMMEDIATE check would reject a batch that fits and admit one that does not, depending only on the order the rows arrived in.';

-- =============================================================================
-- GUARDS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- THE TASK TRANSITION GUARD
-- -----------------------------------------------------------------------------
--
-- BEFORE UPDATE OF state, so the row never exists in a state the database would
-- refuse. Immediate rather than deferred: the ordering is not circular — a
-- transition is written AFTER the state change it records — so deferring would
-- buy nothing and would let an illegal state be visible to the transaction that
-- created it.
CREATE OR REPLACE FUNCTION public.guard_task_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_allowed boolean;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
           SELECT 1
             FROM public.task_state_transition t
            WHERE t.org_id     = NEW.org_id
              AND t.from_state = OLD.state
              AND t.to_state   = NEW.state
         )
    INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION
      'task % cannot move from % to %: that transition is not in this organisation''s task_state_transition table.',
      NEW.id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_task_transition() IS
  'Refuses a task state change whose edge is absent from task_state_transition. Fires BEFORE UPDATE, so the row never exists in the refused state. An organisation whose transition table is empty refuses every move rather than accepting every one.';

REVOKE ALL ON FUNCTION public.guard_task_transition() FROM PUBLIC;

CREATE TRIGGER task_transition_is_declared
  BEFORE UPDATE OF state ON task
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_transition();

-- -----------------------------------------------------------------------------
-- THE WORKFLOW RUN STATUS GUARD — THE CACHED AGGREGATE CANNOT DRIFT
-- -----------------------------------------------------------------------------
--
-- The definition of a run's status, written ONCE. `workflow_run.status` is the
-- cached aggregate a screen reads; this is the derivation; and the trigger below
-- refuses any COMMIT that leaves them disagreeing.
--
--   failed     any step failed. Terminal — the next step is not pending, it is
--              blocked on a decision the caller has not made.
--   declined   the LAST step declined, and none failed.
--   completed  every step is `completed`, and none failed.
--   running    anything else, including a run where an earlier step declined and
--              later steps still apply.
CREATE OR REPLACE FUNCTION public.workflow_derived_status_in_org(p_org_id uuid, p_run_id uuid)
RETURNS workflow_run_status
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH counts AS (
    SELECT count(*)::integer                                                        AS total,
           count(*) FILTER (WHERE s.status = 'completed')::integer                   AS completed,
           count(*) FILTER (WHERE s.status = 'failed')::integer                      AS failed,
           count(*) FILTER (WHERE s.status = 'completed' AND s.outcome_kind = 'declined')::integer AS declined
      FROM public.workflow_step_run s
     WHERE s.org_id = p_org_id
       AND s.run_id = p_run_id
  )
  SELECT CASE
           WHEN c.failed > 0                             THEN 'failed'::public.workflow_run_status
           WHEN c.total > 0 AND c.completed = c.total
             THEN CASE WHEN c.declined = c.total
                        THEN 'declined'::public.workflow_run_status
                        ELSE 'completed'::public.workflow_run_status
                      END
           ELSE 'running'::public.workflow_run_status
         END
    FROM counts c
$$;

COMMENT ON FUNCTION public.workflow_derived_status_in_org(uuid, uuid) IS
  'The aggregate status of one run in one organisation, recomputed from its step rows. THE SINGLE DEFINITION: workflow_run.status is constrained to equal it at COMMIT. A run with no steps is ''running'', never ''completed'' — an execution that did nothing is not a finished one.';

CREATE OR REPLACE FUNCTION public.assert_workflow_run_consistent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id   uuid;
  v_run_id   uuid;
  v_stored   public.workflow_run_status;
  v_derived  public.workflow_run_status;
BEGIN
  IF TG_TABLE_NAME = 'workflow_run' THEN
    v_org_id := NEW.org_id;
    v_run_id := NEW.id;
  ELSE
    v_org_id := NEW.org_id;
    v_run_id := NEW.run_id;
  END IF;

  SELECT r.status INTO v_stored
    FROM public.workflow_run r
   WHERE r.org_id = v_org_id
     AND r.id     = v_run_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_derived := public.workflow_derived_status_in_org(v_org_id, v_run_id);

  IF v_stored IS DISTINCT FROM v_derived THEN
    RAISE EXCEPTION
      'workflow run % stores status ''%'' but its % step row(s) aggregate to ''%''. Move the status to ''%'' in this same transaction.',
      v_run_id, v_stored, v_derived, v_derived, v_derived
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_workflow_run_consistent() IS
  'Re-derives a run''s status from its step rows at COMMIT and refuses any transaction that leaves workflow_run.status disagreeing. Deferred, so "complete the step AND move the run" is one transaction — the same shape 0004 uses for a ledger reversal and 0009 uses for an obligation discharge.';

REVOKE ALL ON FUNCTION public.assert_workflow_run_consistent() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER workflow_run_status_is_derived
  AFTER INSERT OR UPDATE ON workflow_run
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_workflow_run_consistent();

CREATE CONSTRAINT TRIGGER workflow_step_run_rejustifies_parent
  AFTER INSERT OR UPDATE ON workflow_step_run
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_workflow_run_consistent();

-- The same judgement, on the OTHER side of the same disagreement.
--
-- `assert_workflow_run_consistent` catches "the steps say finished and the run
-- does not". This catches "the run says finished and a step does not" — which the
-- first cannot see, because a run updated on its own fires only the run's own
-- trigger and re-derives from steps that have not moved.
--
-- Without it the asymmetry is a hole: a caller could `UPDATE workflow_run SET
-- status='completed'` alone and the deferred check would derive `running` from
-- the untouched steps and refuse — so the hole is closed by the OTHER trigger,
-- but only for that direction. The honest fix is to check the run's status
-- against its steps from BOTH sides, and this is the missing side.
CREATE CONSTRAINT TRIGGER workflow_run_agrees_with_its_steps
  AFTER INSERT OR UPDATE OF status ON workflow_run
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_workflow_run_consistent();

-- And the task/step agreement, fired from the STEP side as well as the task side.
-- `assert_task_matches_its_step` is attached to `task`, so it sees a task change
-- but not a step change. Attaching it to `workflow_step_run` closes that: a step
-- completing while its task is still open is exactly the disagreement, and the
-- task-side trigger cannot observe it because the task did not move.
CREATE OR REPLACE FUNCTION public.assert_step_matches_its_task()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_task_id    uuid;
  v_task_state public.task_state;
BEGIN
  IF NEW.status <> 'completed' THEN
    RETURN NULL;
  END IF;

  SELECT t.id, t.state INTO v_task_id, v_task_state
    FROM public.task t
   WHERE t.org_id         = NEW.org_id
     AND t.origin_run_id  = NEW.run_id
     AND t.origin_step_id = NEW.definition_step_id;

  IF NOT FOUND THEN
    -- No task was created by this step. Not every step creates one, so this is
    -- the normal case rather than a gap.
    RETURN NULL;
  END IF;

  IF v_task_state NOT IN ('done', 'cancelled') THEN
    RAISE EXCEPTION
      'workflow step % of run % is complete but the task it created (%) is ''%''. The run and the backlog disagree, and one of them is lying.',
      NEW.definition_step_id, NEW.run_id, v_task_id, v_task_state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_step_matches_its_task() IS
  'The step-side half of the task/workflow agreement. assert_task_matches_its_step fires on the TASK, so it cannot observe a step completing under a task that did not move; this fires on the STEP and closes that direction. A step that created no task passes, because not every step creates one.';

REVOKE ALL ON FUNCTION public.assert_step_matches_its_task() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER workflow_step_agrees_with_its_task
  AFTER INSERT OR UPDATE OF status ON workflow_step_run
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_step_matches_its_task();

-- -----------------------------------------------------------------------------
-- THE TASK AND WORKFLOW STATE MUST AGREE
-- -----------------------------------------------------------------------------
--
-- A task a workflow step created carries `origin_run_id` / `origin_step_id`, and
-- a completed step whose task is not `done` means the run and the backlog
-- disagree. `assert_task_matches_its_step` refuses the disagreement at COMMIT,
-- for the same reason the run status is checked: two records of the same fact
-- that can drift apart is the defect, not the feature.
--
-- DEFERRABLE because the legal order is "the task is created, then the step
-- completes", and an IMMEDIATE trigger would refuse the step completion before
-- the task update could be written.
CREATE OR REPLACE FUNCTION public.assert_task_matches_its_step()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_task_id uuid;
  v_org_id  uuid;
  v_status  public.workflow_step_status;
BEGIN
  IF TG_TABLE_NAME = 'task' THEN
    v_task_id := NEW.id;
    v_org_id  := NEW.org_id;
  ELSE
    RETURN NULL;
  END IF;

  IF NEW.origin_run_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.status INTO v_status
    FROM public.workflow_step_run s
   WHERE s.org_id = NEW.org_id
     AND s.run_id = NEW.origin_run_id
     AND s.definition_step_id = NEW.origin_step_id;

  -- The step row does not exist yet, which is the normal order: a step is started
  -- before the task it creates. Nothing to judge.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_status = 'completed' AND NEW.state NOT IN ('done', 'cancelled') THEN
    RAISE EXCEPTION
      'workflow step % of run % is complete but its task % is ''%''. The run and the backlog disagree, and one of them is lying.',
      NEW.origin_step_id, NEW.origin_run_id, v_task_id, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.assert_task_matches_its_step() IS
  'Refuses a COMMIT in which a workflow step is complete while the task it created is neither done nor cancelled. Deferred, so "finish the step AND finish the task" is one transaction.';

REVOKE ALL ON FUNCTION public.assert_task_matches_its_step() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER task_agrees_with_its_workflow_step
  AFTER INSERT OR UPDATE OF state ON task
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_task_matches_its_step();

-- -----------------------------------------------------------------------------
-- THE MINOR TRAVELLER GUARD — GUARDIAN CONSENT, REUSED NOT RESTATED
-- -----------------------------------------------------------------------------
--
-- BEFORE INSERT OR UPDATE, so a row never exists in a state that would be
-- refused. It does two things and NOTHING else:
--
--   1. Derives `majority_at_departure` from `person.birth_date` through 0008's
--      `majority_status`, so there is no stored minority flag anywhere.
--   2. For a KNOWN minor, requires that the named `guardian_consent_id` actually
--      COVERS this trip — names this engagement, is not withdrawn, and has not
--      expired at the departure instant.
--
-- The rules themselves are 0008's `guardian_consent_covers_in_org` and
-- `packages/core/src/minors`. Nothing about majority, consent or the engagement
-- floor is restated here; a second copy is how two parts of a product come to
-- disagree about who is a child, which is exactly what 0008's single-threshold
-- comment exists to prevent.
CREATE OR REPLACE FUNCTION public.guard_trip_traveller_consent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_departs    timestamptz;
  v_engagement uuid;
  v_birth      date;
  v_majority   text;
  v_covers     boolean;
BEGIN
  SELECT t.departs_at, t.engagement_id INTO v_departs, v_engagement
    FROM public.trip t
   WHERE t.org_id = NEW.org_id
     AND t.id     = NEW.trip_id;

  IF v_departs IS NULL THEN
    RAISE EXCEPTION
      'trip_traveller names trip %, which does not exist in organisation %.',
      NEW.trip_id, NEW.org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT p.birth_date INTO v_birth
    FROM public.person p
   WHERE p.id = NEW.person_id;

  -- 0008's function is the ONLY definition of majority in this schema.
  v_majority := public.majority_status(v_birth, (v_departs AT TIME ZONE 'UTC')::date);
  NEW.majority_at_departure := v_majority;

  IF v_majority <> 'minor' THEN
    RETURN NEW;
  END IF;

  IF NEW.guardian_consent_id IS NULL THEN
    RAISE EXCEPTION
      'person % is a minor on % (trip %) and no guardian consent is recorded. A minor may not travel without a guardian who consented to THIS trip.',
      NEW.person_id, v_departs, NEW.trip_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- 0008's `guardian_consent_covers_in_org` is the ONLY definition of "this
  -- consent covers this engagement", and it takes the ENGAGEMENT — which is why
  -- `trip.engagement_id` exists and is NOT NULL. Restating the rule here would be
  -- a second copy of it drifting.
  SELECT public.guardian_consent_covers_in_org(
           NEW.org_id, NEW.person_id, v_engagement, v_departs
         )
    INTO v_covers;

  IF NOT v_covers THEN
    RAISE EXCEPTION
      'no guardian consent covers person % on engagement % departing % (trip %): the recorded consent % must name THIS engagement, be un-withdrawn and unexpired. A consent for another engagement is not a consent for this one.',
      NEW.person_id, v_engagement, v_departs, NEW.trip_id, NEW.guardian_consent_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_trip_traveller_consent() IS
  'Derives majority_at_departure from person.birth_date through 0008''s majority_status — there is no stored minority flag — and refuses a KNOWN minor travelling without a guardian consent that COVERS this trip at the departure instant. The rules are 0008''s and packages/core/src/minors''; none of them is restated here.';

REVOKE ALL ON FUNCTION public.guard_trip_traveller_consent() FROM PUBLIC;

CREATE TRIGGER trip_traveller_requires_live_guardian_consent
  BEFORE INSERT OR UPDATE OF person_id, trip_id, guardian_consent_id ON trip_traveller
  FOR EACH ROW EXECUTE FUNCTION public.guard_trip_traveller_consent();

-- -----------------------------------------------------------------------------
-- THE ASSET CUSTODY GUARD
-- -----------------------------------------------------------------------------
--
-- Two events may not share an instant for one asset, and a transfer must name the
-- person who actually held it.
--
-- The first is what makes "who held this at 14:00" have exactly ONE answer. Two
-- rows at the same instant make it answerable two ways, and a custody history is
-- worthless the moment it has two answers to its central question.
--
-- The second is the integrity that matters day to day: a hand-over FROM somebody
-- who does not hold the thing is a custody record that will not reconcile with
-- the row before it.
CREATE OR REPLACE FUNCTION public.guard_asset_custody()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_conflict   uuid;
  v_previous   record;
BEGIN
  -- 1. One event per instant per asset.
  SELECT c.id INTO v_conflict
    FROM public.asset_custody c
   WHERE c.org_id    = NEW.org_id
     AND c.asset_id  = NEW.asset_id
     AND c.occurred_at = NEW.occurred_at
     AND c.id <> NEW.id
   LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION
      'asset % already has a custody event at % (record %). "Who held this then" must have exactly one answer.',
      NEW.asset_id, NEW.occurred_at, v_conflict
      USING ERRCODE = 'check_violation';
  END IF;

  -- 2. A transfer names the person who actually held it.
  IF NEW.kind = 'transfer' THEN
    SELECT c.to_person_id INTO v_previous
      FROM public.asset_custody c
     WHERE c.org_id     = NEW.org_id
       AND c.asset_id   = NEW.asset_id
       AND c.occurred_at < NEW.occurred_at
     ORDER BY c.occurred_at DESC
     LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'asset % cannot be transferred at %: it has no custody history, so it has never been issued.',
        NEW.asset_id, NEW.occurred_at
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_previous.to_person_id IS DISTINCT FROM NEW.from_person_id THEN
      RAISE EXCEPTION
        'asset % is recorded as held by % at the moment before this transfer, but the transfer names % as the sender. A custody history that does not reconcile with itself is not a history.',
        NEW.asset_id, v_previous.to_person_id, NEW.from_person_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.guard_asset_custody() IS
  'Refuses two custody events for one asset at one instant — which would make "who held this then" answerable two ways — and refuses a transfer naming a sender who does not hold the asset. The second check is what keeps the derived holder consistent with the rows above it.';

REVOKE ALL ON FUNCTION public.guard_asset_custody() FROM PUBLIC;

CREATE TRIGGER asset_custody_is_unambiguous
  BEFORE INSERT OR UPDATE ON asset_custody
  FOR EACH ROW EXECUTE FUNCTION public.guard_asset_custody();

-- WHO HELD IT, AT AN INSTANT. The derivation, answering the question the legacy
-- system could not.
--
-- Half-open [occurred_at, …), so an event AT the queried instant has already
-- happened. "Who held this at 10:00" with an event logged at 10:00 should answer
-- with the 10:00 holder, not the one before it.
CREATE OR REPLACE FUNCTION public.asset_holder_at(p_org_id uuid, p_asset_id uuid, p_at timestamptz)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.to_person_id
    FROM public.asset_custody c
   WHERE c.org_id       = p_org_id
     AND c.asset_id     = p_asset_id
     AND c.occurred_at <= p_at
   ORDER BY c.occurred_at DESC, c.id
   LIMIT 1
$$;

COMMENT ON FUNCTION public.asset_holder_at(uuid, uuid, timestamptz) IS
  'Who held an asset at an instant, DERIVED from the append-only custody record rather than stored. NULL means nobody: never issued, lost, or disposed. Takes an explicit organisation because an integrity trigger must not depend on session state (the reasoning of guardian_consent_covers_in_org in 0008).';

-- The whole custody history, answered in one query. NO LIMIT, for ADR-0019's
-- reason: a report that silently capped its result set and presented it as the
-- whole would be the defect that ADR exists to record.
CREATE OR REPLACE FUNCTION public.asset_custody_trail(p_asset_id uuid)
RETURNS TABLE (
  custody_id     uuid,
  kind           custody_kind,
  from_person_id uuid,
  to_person_id   uuid,
  occurred_at    timestamptz,
  reason         varchar(400),
  held_from      timestamptz,
  held_until     timestamptz
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.id,
         c.kind,
         c.from_person_id,
         c.to_person_id,
         c.occurred_at,
         c.reason,
         c.occurred_at,
         lead(c.occurred_at) OVER (PARTITION BY c.asset_id ORDER BY c.occurred_at, c.id)
    FROM public.asset_custody c
   WHERE c.org_id   = public.current_org_id()
     AND c.asset_id = p_asset_id
   ORDER BY c.occurred_at, c.id
$$;

COMMENT ON FUNCTION public.asset_custody_trail(uuid) IS
  'The full custody history of one asset in the session''s organisation, each row carrying the window during which that holder held it. Takes no organisation argument (ADR-0011 rule 3), so an unset context reads nothing. SECURITY INVOKER, and carries NO LIMIT, because a report that silently capped its result set and presented it as the whole would be the defect ADR-0019 recorded.';

-- -----------------------------------------------------------------------------
-- THE DOUBLE-BOOKING GUARD
-- -----------------------------------------------------------------------------
--
-- Overlapping reservations for one facility are impossible.
--
-- WHY A TRIGGER AND NOT `EXCLUDE USING gist`
-- ------------------------------------------
-- Both alternatives were tried and both are recorded as failures in this
-- project's environment history: `btree_gist` is UNAVAILABLE in PGlite, and
-- `EXCLUDE USING gist` over a `uuid` column FAILS because the uuid GiST operator
-- class does not exist in the build PGlite ships. So the overlap guard is a
-- plain BEFORE trigger comparing timestamps, which works everywhere.
--
-- WHY DEFERRABLE, AND JUDGED AT COMMIT
-- -----------------------------------
-- An IMMEDIATE trigger would judge each row ALONE. A batch of reservations
-- moved from `held` to `confirmed` would then reject a batch that fits and admit
-- one that does not, depending only on the order the rows arrived in — and a
-- correctness rule whose outcome depends on row order is not a correctness rule.
-- Deferring to COMMIT judges the SET, which is the thing the rule is about.
--
-- This is the same bargain 0005 and 0009 strike for a prize pool and an
-- obligation, and it is why this trigger is a CONSTRAINT trigger.
CREATE OR REPLACE FUNCTION public.guard_facility_overlap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_capacity  integer;
  v_live      integer;
  v_other     record;
BEGIN
  -- A cancelled reservation holds nothing and blocks nothing. Modelling that here
  -- rather than with a partial index is deliberate: the same rule then applies
  -- to an UPDATE that cancels, and there is no second path to get wrong.
  IF NEW.state = 'cancelled' THEN
    RETURN NULL;
  END IF;

  SELECT f.capacity INTO v_capacity
    FROM public.facility f
   WHERE f.org_id = NEW.org_id
     AND f.id     = NEW.facility_id;

  -- NULL capacity means UNBOUNDED, so there is nothing to overlap-check: the
  -- capacity rule below is the only one, and it permits any number. A facility
  -- that can hold any number of concurrent bookings does not "double-book" at
  -- all — treating it as capacity-1 would be inventing a constraint nobody asked
  -- for.
  IF v_capacity IS NULL THEN
    RETURN NULL;
  END IF;

  -- Count how many LIVE reservations already overlap this window. If the facility
  -- has capacity N, then N simultaneous bookings are FINE and only the (N+1)th
  -- overlapping one is a double-booking. Enforcing a hard "no two overlap ever"
  -- rule here would make a capacity-3 booth bank behave like a capacity-1 room,
  -- which is the mistake of treating "bookable" as "single occupancy".
  SELECT count(*)::integer INTO v_live
    FROM public.facility_reservation r
   WHERE r.org_id      = NEW.org_id
     AND r.facility_id = NEW.facility_id
     AND r.id <> NEW.id
     AND r.state <> 'cancelled'
     AND NEW.starts_at < r.ends_at
     AND r.starts_at < NEW.ends_at;

  IF v_live < v_capacity THEN
    -- Room remains for this one.
    RETURN NULL;
  END IF;

  -- At or over capacity: name the specific booking it clashes with so the caller
  -- is not left counting rows.
  SELECT r.id, r.starts_at, r.ends_at INTO v_other
    FROM public.facility_reservation r
   WHERE r.org_id      = NEW.org_id
     AND r.facility_id = NEW.facility_id
     AND r.id <> NEW.id
     AND r.state <> 'cancelled'
     AND NEW.starts_at < r.ends_at
     AND r.starts_at < NEW.ends_at
   LIMIT 1;

  RAISE EXCEPTION
    'facility % holds capacity % and already has % booking(s) overlapping % to %; this one (% to %) makes % , which is over capacity. Half-open windows: a booking may begin exactly when another ends, but not before.',
    NEW.facility_id, v_capacity, v_live, v_other.starts_at, v_other.ends_at, NEW.starts_at, NEW.ends_at, v_live + 1
    USING ERRCODE = 'check_violation';
END
$$;

COMMENT ON FUNCTION public.guard_facility_overlap() IS
  'Refuses a booking that would push a facility past its concurrent CAPACITY. Half-open [starts_at, ends_at): a booking may begin exactly when another ends. A capacity-1 room refuses any overlap; a capacity-5 booth bank permits five and refuses the sixth; NULL capacity is UNBOUNDED and never refuses. A cancelled reservation blocks nothing. Enforced as a DEFERRABLE CONSTRAINT TRIGGER so a batch of bookings is judged at COMMIT as a batch rather than row by row in arrival order.';

REVOKE ALL ON FUNCTION public.guard_facility_overlap() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER facility_reservations_do_not_overlap
  AFTER INSERT OR UPDATE OF starts_at, ends_at, facility_id, state ON facility_reservation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.guard_facility_overlap();

-- -----------------------------------------------------------------------------
-- WHY THERE IS NO SECOND CAPACITY TRIGGER
-- ---------------------------------------
-- An earlier draft of this file carried a SEPARATE `assert_facility_capacity`
-- alongside the overlap guard: the first refused any two overlapping bookings,
-- the second refused any that exceeded `capacity`. Both fired on every row, and a
-- capacity-1 facility was checked twice for the same fact.
--
-- Worse, the pair was jointly WRONG. The overlap guard refused any overlap at
-- all, so a booth bank with capacity 5 behaved exactly like a room with capacity
-- 1 � three teams could not book three booths for the same scrim block. Fixing
-- that inside the overlap guard (count the live overlaps, refuse only past
-- capacity) makes the separate capacity trigger REDUNDANT: it counts precisely
-- the same rows and refuses precisely the same condition.
--
-- One rule, one trigger. A second mechanism enforcing the same fact is not
-- defence in depth, it is a second thing to get wrong.
-- -----------------------------------------------------------------------------
-- -----------------------------------------------------------------------------
-- THE TOKEN IS WRITTEN, NOT SUPPLIED
-- -----------------------------------------------------------------------------
--
-- A caller-supplied retry token is a claim the database has no way to check, and
-- the whole point of storing one is that a downstream system deduped on it. So
-- the token is DERIVED on insert and a caller cannot supply one at all.
CREATE OR REPLACE FUNCTION public.derive_workflow_step_run_token()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.retry_token := public.workflow_retry_token(NEW.org_id, NEW.run_id, NEW.definition_step_id);

  IF NEW.retry_token IS NULL THEN
    RAISE EXCEPTION
      'workflow step definition % is not part of organisation %, so no retry token can be derived for it.',
      NEW.definition_step_id, NEW.org_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.derive_workflow_step_run_token() IS
  'Derives workflow_step_run.retry_token from the run and the step''s idempotency scope, so a caller cannot supply a token the database cannot verify. A NULL scope lookup — a step definition from another organisation — is refused rather than stored as a NULL token.';

REVOKE ALL ON FUNCTION public.derive_workflow_step_run_token() FROM PUBLIC;

CREATE TRIGGER workflow_step_run_token_is_derived
  BEFORE INSERT OR UPDATE OF run_id, definition_step_id ON workflow_step_run
  FOR EACH ROW EXECUTE FUNCTION public.derive_workflow_step_run_token();

-- =============================================================================
-- SEEDING
-- =============================================================================

-- The task state machine, seeded for a new organisation.
--
-- The edges are the same ones `packages/core/src/tasks/task.ts` declares, and
-- `tasks.operators.test.ts` asserts the two agree by name. `open -> done` is
-- ABSENT deliberately: completion is reachable only through in_review, so a
-- completed task has by construction passed a state somebody looked at.
CREATE OR REPLACE FUNCTION public.seed_task_state_transition(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  edge record;
BEGIN
  FOR edge IN
    SELECT * FROM (VALUES
      ('open'::public.task_state,        'in_progress'::public.task_state),
      ('open'::public.task_state,        'blocked'::public.task_state),
      ('open'::public.task_state,        'cancelled'::public.task_state),
      ('in_progress'::public.task_state, 'blocked'::public.task_state),
      ('in_progress'::public.task_state, 'in_review'::public.task_state),
      ('in_progress'::public.task_state, 'cancelled'::public.task_state),
      ('blocked'::public.task_state,     'in_progress'::public.task_state),
      ('blocked'::public.task_state,     'cancelled'::public.task_state),
      ('in_review'::public.task_state,   'in_progress'::public.task_state),
      ('in_review'::public.task_state,   'done'::public.task_state),
      ('in_review'::public.task_state,   'cancelled'::public.task_state)
    ) AS e(from_state, to_state)
  LOOP
    INSERT INTO public.task_state_transition (org_id, from_state, to_state)
    VALUES (p_org_id, edge.from_state, edge.to_state)
    ON CONFLICT DO NOTHING;
  END LOOP;
END
$$;

COMMENT ON FUNCTION public.seed_task_state_transition(uuid) IS
  'Seeds the task state machine for a new organisation, so no organisation can exist without one and every state change is judged against a populated transition table. The edges are those packages/core/src/tasks declares; a test asserts the two agree.';

REVOKE ALL ON FUNCTION public.seed_task_state_transition(uuid) FROM PUBLIC;

-- A second AFTER INSERT trigger on `organization`, alongside 0008''s and 0009''s.
-- They coexist rather than being merged into an edit to an applied migration, and
-- all three are independently idempotent.
CREATE OR REPLACE FUNCTION public.on_organization_created_operations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.seed_task_state_transition(NEW.id);
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.on_organization_created_operations() IS
  'Seeds the task state machine for a new organisation, so no organisation can exist without one.';

REVOKE ALL ON FUNCTION public.on_organization_created_operations() FROM PUBLIC;

CREATE TRIGGER organization_seeds_task_transitions
  AFTER INSERT ON organization
  FOR EACH ROW EXECUTE FUNCTION public.on_organization_created_operations();

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

-- Identical to 0001 through 0009 and not restated in prose per table: the tenant
-- predicate is the WHOLE policy, and there is no `IS NULL` escape — an unset
-- `app.org_id` therefore matches nothing and the session fails CLOSED rather
-- than reading every tenant (ADR-0015).
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'task','task_state_transition','task_dependency','task_transition',
    'workflow_definition','workflow_step_definition','workflow_run','workflow_step_run',
    'trip','trip_destination','trip_leg','trip_traveller',
    'asset','asset_custody',
    'facility','facility_reservation'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;

-- =============================================================================
-- PRIVILEGES
-- =============================================================================

GRANT USAGE ON SCHEMA public TO raptor_app;

-- Mutable tables: SELECT, INSERT, UPDATE, and NO DELETE.
GRANT SELECT, INSERT, UPDATE ON
  task, task_dependency,
  workflow_definition, workflow_step_definition, workflow_run,
  trip, trip_destination, trip_leg, trip_traveller,
  asset,
  facility, facility_reservation
TO raptor_app;

-- Governance data. An organisation editing its own legal task machine from a
-- request handler is "a stage table the app role can rewrite is not a state
-- machine", which 0008 argues about `hr_state_transition` and 0009 about
-- `partner_state_transition`. Only a migration or an operator changes these.
REVOKE INSERT, UPDATE, DELETE ON
  task_state_transition
FROM raptor_app;

-- Append-only tables: SELECT and INSERT only. Stated as an explicit REVOKE as
-- well as an absent GRANT, so a later migration that widens a grant cannot
-- accidentally hand back an UPDATE by omission.
GRANT SELECT, INSERT ON
  task_transition, asset_custody, workflow_step_run
TO raptor_app;

REVOKE UPDATE, DELETE ON
  task_transition, asset_custody, workflow_step_run
FROM raptor_app;

-- No hard deletes anywhere in this domain.
REVOKE DELETE ON
  task, task_dependency, task_state_transition,
  workflow_definition, workflow_step_definition, workflow_run, workflow_step_run,
  trip, trip_destination, trip_leg, trip_traveller,
  asset, asset_custody,
  facility, facility_reservation
FROM raptor_app;

-- PUBLIC's automatic EXECUTE is taken back from every function, so a role with no
-- grants on the tables cannot reach the logic through a function.
REVOKE ALL ON FUNCTION public.workflow_retry_token(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workflow_derived_status_in_org(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_task_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_workflow_run_consistent() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_task_matches_its_step() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_step_matches_its_task() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_trip_traveller_consent() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_asset_custody() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.asset_holder_at(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.asset_custody_trail(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_facility_overlap() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.derive_workflow_step_run_token() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.seed_task_state_transition(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.on_organization_created_operations() FROM PUBLIC;

-- The derivations and reports. The guards and seeding functions are NOT granted,
-- because a role that can call a guard directly has no use for it — they are
-- reachable only through a write.
GRANT EXECUTE ON FUNCTION
  public.workflow_derived_status_in_org(uuid, uuid),
  public.asset_holder_at(uuid, uuid, timestamptz),
  public.asset_custody_trail(uuid)
TO raptor_app;

COMMIT;

-- ==========================================================================
-- SOURCE: packages/db/migrations/0011_portability.sql
-- ==========================================================================

-- =============================================================================
-- packages/db/migrations/0011_portability.sql
--
-- PORTABILITY: a complete, self-describing, byte-reproducible export of ONE
-- organisation's data, and an import that is all-or-nothing.
--
-- WHY THIS FILE IS THE HIGHEST-RISK ARTEFACT IN THE SCHEMA
-- ---------------------------------------------------------
-- Every other migration adds tables. This one adds the ability to move every
-- table at once, and the failure mode is a CROSS-TENANT DATA LEAK. A query that
-- forgets `org_id` leaks a few rows; an export that forgets it leaks the whole
-- customer. So the design below never asks the caller to remember a predicate:
--
--   * The export takes NO organisation argument. The tenant is read from the
--     session by `current_org_id()`, exactly as every RLS policy does
--     (ADR-0011 rule 3). A caller cannot ask for another organisation's data
--     because there is no parameter to ask with.
--   * An unset tenant context RAISES. It does not return an empty document.
--     "This organisation has no data" and "we could not tell which organisation
--     you are" are different answers, and returning the first for the second is
--     how a leak looks like a clean report.
--   * The export is SECURITY DEFINER because `person` carries RLS with no policy
--     (0001 gates it through membership), and a tenant's export must contain the
--     people its own rows reference. The one place that power could be abused is
--     closed structurally: the person set is a CLOSURE over the tenant's own
--     rows, so a person who belongs only to another organisation is never in it.
--   * The import REFUSES a document whose `organization_id` is not the session's
--     tenant. It never rewrites `org_id` to make a document fit. Reparenting a
--     rejected record is how a security violation becomes silent corruption
--     (ADR-0011).
--
-- DETERMINISM, AND WHY IT IS A SECURITY PROPERTY HERE
-- --------------------------------------------------
-- Every exported value is the canonical TEXT rendering of the PostgreSQL value,
-- in UTC, and every row array is ordered by the row's declared key. Therefore:
--
--   * Two exports of the same data are byte-identical, so `diff` is a complete
--     leak detector. An export whose row order varies between runs cannot be
--     diffed, and a leak test that cannot be diffed is a leak test that cannot
--     fail.
--   * `numeric(18,4)` money survives the round trip exactly. Rendering money as
--     a JSON number would hand it to an IEEE-754 double, and 99999999999999.9999
--     does not survive that.
--   * `timestamptz` survives as an unambiguous UTC instant rather than as a
--     host-timezone artefact. PGlite returns `timestamptz` to Node as HOST-timezone
--     `Date` objects, and every instant this schema compares is cast to text IN
--     SQL for exactly that reason.
--
-- There is NO `exported_at`. A clock in the header would make two exports of the
-- same data differ, which is the one thing determinism exists to prevent.
--
-- THE CONTRACT IS DATA, AND A TEST PROVES IT IS COMPLETE
-- -------------------------------------------------------
-- `portability_export_contract()` returns the ordered list of tables. A test
-- reflects `pg_attribute` for every table with `org_id NOT NULL` and asserts the
-- two sets are EQUAL, so a migration that adds a table and forgets to export it
-- fails a test rather than silently shipping a backup that omits a domain.
--
-- `person`, `person_profile` and `organization` are in the contract but are not
-- tenant tables; the test asserts they are the ONLY additions, and that the
-- contract lists every table exactly once.
--
-- WHAT IS DELIBERATELY NOT EXPORTED, AND WHY
-- -------------------------------------------
--
--   identity          How a human AUTHENTICATES. Re-importing it would create
--                     credentials in another tenant, and a credential is not an
--                     organisation's business data.
--   consent_record    A revocable permission grant. Copying it would resurrect a
--                     permission the person has since withdrawn.
--   audit_log         The record of what happened IN THIS INSTALLATION. Exporting
--                     it and re-importing it elsewhere forges history.
--   outbox_event      Delivery bookkeeping for messages this installation still
--                     owes. Importing it elsewhere would re-send them.
--   portability_import_run  Operational metadata about a transfer into THIS
--                     installation — the import's own receipt. Exporting a receipt
--                     and re-importing it would forge that too.
--
-- All five are asserted absent by name in the test, because "deliberately
-- excluded" is only a real claim while something is checking it.
--
-- ALL-OR-NOTHING
-- --------------
-- The import runs entirely inside the caller's transaction and writes an audit
-- row in the same transaction, so a receipt exists if and only if the data does.
-- A malformed record raises and the transaction — including every row inserted
-- before it — rolls back. `packages/core/src/portability` proves the same thing
-- without a database: it validates the WHOLE payload before producing a plan,
-- and a plan is the only thing that can be handed to a writer.
--
-- CYCLIC REFERENCES
-- -----------------
-- Six tables reference themselves (`contract_version`, `budget`, `ledger_journal`,
-- `match_player_performance`, `prize_allocation`, `prize_pool` — a version that
-- supersedes an earlier one). The declared ordinal order is a topological order
-- over the INTER-table graph, which exists (a test proves it), but a self
-- reference has no topological order at all. So a row whose references do not yet
-- exist is DEFERRED and retried, and the loop raises as soon as a whole pass
-- makes no progress. Termination is structural: every pass either inserts at
-- least one row or raises, and the payload is finite.
--
-- `btree_gist` is unavailable and `EXCLUDE USING gist` over uuid fails here
-- (0006, 0010), and neither is needed: nothing about this design depends on an
-- exclusion constraint.
-- =============================================================================

BEGIN;

-- =============================================================================
-- THE CONTRACT
-- =============================================================================

-- scope:
--   'tenant'         rows where org_id = current_org_id()   — the tenant's own data
--   'tenant_root'    the single organisation row           — who this document is
--   'person'         person rows in the tenant's closure
--   'person_profile' profiles for exactly those people
--
-- writable: false means the table is DESCRIBED by a document but never WRITTEN
-- by one. `organization` is the tenant rather than the tenant's data — importing
-- it would mean creating a tenant, which is a different operation with different
-- authorisation.
--
-- Sort key: the column list each table's rows are ordered by, so that two
-- exports of the same data are byte-identical. `role_permission` is the one
-- table with no `id` (its primary key is (role_id, permission_id)), which is why
-- the key is declared per table rather than assumed.
--
-- THE ORDER IS A TOPOLOGICAL ORDER over the inter-table foreign-key graph, and
-- `portability.isolation.test.ts` recomputes that graph from `pg_constraint` and
-- asserts the declaration, so a table cannot be placed before something it
-- references without a test failing.
CREATE OR REPLACE FUNCTION public.portability_export_contract()
RETURNS TABLE (
  ordinal     integer,
  table_name  text,
  scope       text,
  key_columns text[],
  writable    boolean
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $fn$
  SELECT * FROM (VALUES
    ( 1, 'organization'                   , 'tenant_root'   , ARRAY['id']::text[], false),
    ( 2, 'person'                         , 'person'        , ARRAY['id']::text[], true),
    ( 3, 'person_profile'                 , 'person_profile', ARRAY['person_id']::text[], true),
    ( 4, 'asset'                          , 'tenant'        , ARRAY['id']::text[], true),
    ( 5, 'content_state_transition'       , 'tenant'        , ARRAY['id']::text[], true),
    ( 6, 'creator_profile'                , 'tenant'        , ARRAY['id']::text[], true),
    ( 7, 'engagement'                     , 'tenant'        , ARRAY['id']::text[], true),
    ( 8, 'facility'                       , 'tenant'        , ARRAY['id']::text[], true),
    ( 9, 'game'                           , 'tenant'        , ARRAY['id']::text[], true),
    (10, 'guardian_consent'               , 'tenant'        , ARRAY['id']::text[], true),
    (11, 'hr_state_transition'            , 'tenant'        , ARRAY['id']::text[], true),
    (12, 'inventory_item'                 , 'tenant'        , ARRAY['id']::text[], true),
    (13, 'ledger_account'                 , 'tenant'        , ARRAY['id']::text[], true),
    (14, 'org_membership'                 , 'tenant'        , ARRAY['id']::text[], true),
    (15, 'partner'                        , 'tenant'        , ARRAY['id']::text[], true),
    (16, 'partner_state_transition'       , 'tenant'        , ARRAY['id']::text[], true),
    (17, 'person_document'                , 'tenant'        , ARRAY['id']::text[], true),
    (18, 'public_site_publication'        , 'tenant'        , ARRAY['id']::text[], true),
    (19, 'role'                           , 'tenant'        , ARRAY['id']::text[], true),
    (20, 'task_state_transition'          , 'tenant'        , ARRAY['id']::text[], true),
    (21, 'workflow_definition'            , 'tenant'        , ARRAY['id']::text[], true),
    (22, 'asset_custody'                  , 'tenant'        , ARRAY['id']::text[], true),
    (23, 'compensation_agreement'         , 'tenant'        , ARRAY['id']::text[], true),
    (24, 'content_item'                   , 'tenant'        , ARRAY['id']::text[], true),
    (25, 'contract'                       , 'tenant'        , ARRAY['id']::text[], true),
    (26, 'facility_reservation'           , 'tenant'        , ARRAY['id']::text[], true),
    (27, 'guardian_consent_withdrawal'    , 'tenant'        , ARRAY['id']::text[], true),
    (28, 'hr_record'                      , 'tenant'        , ARRAY['id']::text[], true),
    (29, 'inventory_movement'             , 'tenant'        , ARRAY['id']::text[], true),
    (30, 'opponent'                       , 'tenant'        , ARRAY['id']::text[], true),
    (31, 'role_assignment'                , 'tenant'        , ARRAY['id']::text[], true),
    (32, 'role_permission'                , 'tenant'        , ARRAY['role_id','permission_id']::text[], true),
    (33, 'role_scope_rule'                , 'tenant'        , ARRAY['id']::text[], true),
    (34, 'title'                          , 'tenant'        , ARRAY['id']::text[], true),
    (35, 'trip'                           , 'tenant'        , ARRAY['id']::text[], true),
    (36, 'workflow_run'                   , 'tenant'        , ARRAY['id']::text[], true),
    (37, 'workflow_step_definition'       , 'tenant'        , ARRAY['id']::text[], true),
    (38, 'competition'                    , 'tenant'        , ARRAY['id']::text[], true),
    (39, 'contract_obligation'            , 'tenant'        , ARRAY['id']::text[], true),
    (40, 'contract_version'               , 'tenant'        , ARRAY['id']::text[], true),
    (41, 'season'                         , 'tenant'        , ARRAY['id']::text[], true),
    (42, 'trip_destination'               , 'tenant'        , ARRAY['id']::text[], true),
    (43, 'trip_traveller'                 , 'tenant'        , ARRAY['id']::text[], true),
    (44, 'workflow_step_run'              , 'tenant'        , ARRAY['id']::text[], true),
    (45, 'contract_acceptance'            , 'tenant'        , ARRAY['id']::text[], true),
    (46, 'contract_obligation_part'       , 'tenant'        , ARRAY['id']::text[], true),
    (47, 'division'                       , 'tenant'        , ARRAY['id']::text[], true),
    (48, 'task'                           , 'tenant'        , ARRAY['id']::text[], true),
    (49, 'trip_leg'                       , 'tenant'        , ARRAY['id']::text[], true),
    (50, 'acceptance_withdrawal'          , 'tenant'        , ARRAY['id']::text[], true),
    (51, 'competition_division'           , 'tenant'        , ARRAY['id']::text[], true),
    (52, 'obligation_evidence'            , 'tenant'        , ARRAY['id']::text[], true),
    (53, 'task_dependency'                , 'tenant'        , ARRAY['id']::text[], true),
    (54, 'task_transition'                , 'tenant'        , ARRAY['id']::text[], true),
    (55, 'team'                           , 'tenant'        , ARRAY['id']::text[], true),
    (56, 'attendance_policy'              , 'tenant'        , ARRAY['id']::text[], true),
    (57, 'budget'                         , 'tenant'        , ARRAY['id']::text[], true),
    (58, 'ledger_journal'                 , 'tenant'        , ARRAY['id']::text[], true),
    (59, 'match'                          , 'tenant'        , ARRAY['id']::text[], true),
    (60, 'obligation_evidence_retraction' , 'tenant'        , ARRAY['id']::text[], true),
    (61, 'prize_pool'                     , 'tenant'        , ARRAY['id']::text[], true),
    (62, 'registration'                   , 'tenant'        , ARRAY['id']::text[], true),
    (63, 'session_holiday'                , 'tenant'        , ARRAY['id']::text[], true),
    (64, 'session_template'               , 'tenant'        , ARRAY['id']::text[], true),
    (65, 'team_membership'                , 'tenant'        , ARRAY['id']::text[], true),
    (66, 'team_staff'                     , 'tenant'        , ARRAY['id']::text[], true),
    (67, 'entry_cost'                     , 'tenant'        , ARRAY['id']::text[], true),
    (68, 'expense'                        , 'tenant'        , ARRAY['id']::text[], true),
    (69, 'invoice'                        , 'tenant'        , ARRAY['id']::text[], true),
    (70, 'ledger_line'                    , 'tenant'        , ARRAY['id']::text[], true),
    (71, 'match_map'                      , 'tenant'        , ARRAY['id']::text[], true),
    (72, 'match_result'                   , 'tenant'        , ARRAY['id']::text[], true),
    (73, 'performance_extraction'         , 'tenant'        , ARRAY['id']::text[], true),
    (74, 'prize_allocation'               , 'tenant'        , ARRAY['id']::text[], true),
    (75, 'session'                        , 'tenant'        , ARRAY['id']::text[], true),
    (76, 'attendance_record'              , 'tenant'        , ARRAY['id']::text[], true),
    (77, 'invoice_line'                   , 'tenant'        , ARRAY['id']::text[], true),
    (78, 'match_player_performance'       , 'tenant'        , ARRAY['id']::text[], true),
    (79, 'prize_allocation_input'         , 'tenant'        , ARRAY['id']::text[], true),
    (80, 'prize_allocation_reconciliation', 'tenant'        , ARRAY['id']::text[], true),
    (81, 'prize_allocation_result'        , 'tenant'        , ARRAY['id']::text[], true),
    (82, 'prize_allocation_term'          , 'tenant'        , ARRAY['id']::text[], true)
  ) AS c(ordinal, table_name, scope, key_columns, writable)
  ORDER BY c.ordinal
$fn$;

COMMENT ON FUNCTION public.portability_export_contract() IS
  'The ordered portability contract: every table an export describes and an import writes, its scope, and the key its rows are sorted by. A test reflects pg_attribute for every table carrying org_id NOT NULL and asserts the two sets are equal, so a new tenant table that forgets to join the contract fails a test instead of silently shipping a backup that omits a domain.';

-- -----------------------------------------------------------------------------
-- COLUMN PROJECTIONS
-- -----------------------------------------------------------------------------
--
-- Two inverse helpers, both derived from the catalogue rather than hand-written,
-- which is what lets one function export 82 tables without 82 bespoke queries.
--
-- `to_regclass('public.' || quote_ident(p_table))` and NOT `p_table::regclass`:
-- a `regclass` input is resolved through `search_path`, and both functions pin
-- `search_path` to empty — so the bare form fails with `relation "organization"
-- does not exist` at the first call. The schema is written into the string
-- instead, which is also what keeps the lookup from ever reaching another
-- schema's identically-named table.
--
-- The cast list is schema-qualified by name and the table name is always
-- interpolated with %I from the CONTRACT, never from a caller's string, so there
-- is no injection surface here.
CREATE OR REPLACE FUNCTION public.portability_text_projection(p_table text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $fn$
  SELECT pg_catalog.string_agg(pg_catalog.format('(%I)::text AS %I', a.attname, a.attname), ', ' ORDER BY a.attname)
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(p_table))
     AND a.attnum > 0
     AND NOT a.attisdropped
$fn$;

COMMENT ON FUNCTION public.portability_text_projection(text) IS
  'The SELECT list that renders every column of a table as its canonical text form. Text rather than jsonb-native values because numeric(18,4) money must survive an IEEE-754 double and timestamptz must survive a host-timezone change.';

CREATE OR REPLACE FUNCTION public.portability_text_cast(p_table text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $fn$
  SELECT pg_catalog.string_agg(pg_catalog.format('(x.value->>%L)::%s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod)), ', ' ORDER BY a.attname)
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(p_table))
     AND a.attnum > 0
     AND NOT a.attisdropped
$fn$;

COMMENT ON FUNCTION public.portability_text_cast(text) IS
  'The SELECT list that reads a document row back into typed columns, the exact inverse of portability_text_projection. A JSON null casts to SQL NULL through (->>), so an absent value and an explicit null are the same thing, which is what the export wrote.';

-- `portability_text_cast` orders its expressions ALPHABETICALLY, so an
-- `INSERT INTO t SELECT ...` without a column list would bind them to the
-- table's own column order and fail with `column "id" is of type uuid but
-- expression is of type timestamp with time zone` — position 1 of the SELECT
-- happens to be `account_id`'s text, bound to `id`. The column list is emitted
-- from the SAME query and the SAME ordering, so the two cannot drift.
CREATE OR REPLACE FUNCTION public.portability_column_list(p_table text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $fn$
  SELECT pg_catalog.string_agg(pg_catalog.format('%I', a.attname), ', ' ORDER BY a.attname)
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(p_table))
     AND a.attnum > 0
     AND NOT a.attisdropped
$fn$;

COMMENT ON FUNCTION public.portability_column_list(text) IS
  'The column list an import names explicitly, in the same alphabetical order portability_text_cast emits its expressions in. Naming the columns is what stops the import from depending on a table''s physical column order, which no other migration promises not to change.';

-- -----------------------------------------------------------------------------
-- THE PERSON CLOSURE
-- -----------------------------------------------------------------------------
--
-- WHICH PEOPLE an organisation's export contains.
--
-- `person` has no `org_id` (ADR-0018): one human may work for several
-- organisations, so "this organisation's people" is not a column, it is a
-- question whose answer lives in the rows that reference them.
--
-- The answer is the CLOSURE: every `*_person_id` value appearing in any of this
-- tenant's rows. One hop, and one hop is enough — the only tables that can
-- reference a person without themselves being tenant-owned are `person`,
-- `person_profile`, `identity` and `consent_record`, and of those `person` and
-- `person_profile` are in the contract while `identity` and `consent_record` are
-- deliberately not.
--
-- A person who belongs only to another organisation is therefore NEVER in the
-- closure, and so never in the export. That is the sharpest form of the leak
-- this file has to prevent: the other tenant's data is ALL in `person`, because
-- `person` is the one table with no tenant predicate available to get wrong.
CREATE OR REPLACE FUNCTION public.portability_person_closure(p_org_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  c        record;
  v_sql    text;
  v_here   uuid[];
  v_people uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_org_id IS NULL THEN
    RETURN v_people;
  END IF;

  -- Built from the catalogue: every uuid column of every tenant table whose name
  -- ENDS IN `person_id` — person_id, guardian_person_id, recorded_by_person_id,
  -- verified_by_person_id, granted_by_person_id and the rest.
  --
  -- The pattern ends at `person_id` and does not begin with an underscore. An
  -- earlier draft wrote `'%\_person\_id'`, which requires a literal underscore
  -- BEFORE `person` — so it matched `guardian_person_id` and every other
  -- `*_person_id` column, and silently missed `person_id` itself. The export
  -- then contained no people at all, which is the failure mode this function
  -- exists to prevent, introduced by the function meant to prevent it. The
  -- membership column is the one that matters most, and it is the one that was
  -- skipped.
  FOR c IN
    SELECT cl.relname AS table_name, a.attname AS column_name
      FROM pg_catalog.pg_class cl
      JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_catalog.pg_attribute a
        ON a.attrelid = cl.oid
       AND a.atttypid = 'uuid'::regtype
       AND a.attname LIKE '%person\_id'
      WHERE n.nspname = 'public'
        AND cl.relkind = 'r'
        AND cl.relname IN (
              SELECT k.table_name FROM public.portability_export_contract() k WHERE k.scope = 'tenant'
            )
      ORDER BY cl.relname, a.attname
  LOOP
    EXECUTE format(
      'SELECT coalesce(array_agg(DISTINCT (%I)::uuid), ARRAY[]::uuid[]) FROM public.%I WHERE org_id = $1 AND %I IS NOT NULL',
      c.column_name, c.table_name, c.column_name
    ) INTO v_here USING p_org_id;

    -- UNION each table's people onto the accumulator. Assigning `v_people :=
    -- v_people` here instead would keep only the LAST table's answer, and the
    -- export would contain the people named by `team_staff` and nobody else —
    -- a leak-shaped bug wearing the costume of a tidy loop.
    v_people := v_people || v_here;
  END LOOP;

  RETURN (SELECT coalesce(array_agg(DISTINCT p), ARRAY[]::uuid[]) FROM unnest(v_people) AS p);
END
$fn$;

COMMENT ON FUNCTION public.portability_person_closure(uuid) IS
  'The people this organisation''s own rows reference, as a uuid[]. One hop over every *_person_id column of every tenant table, because person has no org_id and "this organisation''s people" is a derived question rather than a column. A person belonging only to another organisation is never in the result.';

-- -----------------------------------------------------------------------------
-- THE EXPORT
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.portability_export_document()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
SET TimeZone = 'UTC'
AS $fn$
DECLARE
  v_org      uuid;
  v_people   uuid[];
  c          record;
  v_cols     text;
  v_order    text;
  v_rows     jsonb;
  v_tables   jsonb := '{}'::jsonb;
  v_migrated integer;
  v_last     text;
BEGIN
  v_org := public.current_org_id();

  -- FAILS CLOSED. An empty document is indistinguishable from an organisation
  -- with no data, and a caller who cannot name the tenant must not be handed one.
  IF v_org IS NULL THEN
    RAISE EXCEPTION
      'no tenant is set in this session, so there is no organisation to export. Refusing rather than returning an empty document: "this organisation has no data" and "we could not tell which organisation you are" are different answers.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_people := public.portability_person_closure(v_org);

  SELECT count(*), max(name) INTO v_migrated, v_last FROM public.schema_migration;

  FOR c IN SELECT * FROM public.portability_export_contract() ORDER BY ordinal LOOP
    v_cols  := public.portability_text_projection(c.table_name);
    v_order := (SELECT string_agg(format('__r.%I', k), ', ' ORDER BY t.ord)
                  FROM unnest(c.key_columns) WITH ORDINALITY AS t(k, ord));

    CASE c.scope
      WHEN 'tenant_root' THEN
        EXECUTE format(
          'SELECT coalesce(jsonb_agg(to_jsonb(__r) ORDER BY %s), ''[]''::jsonb) FROM (SELECT %s FROM public.%I WHERE id = $1) AS __r',
          v_order, v_cols, c.table_name
        ) INTO v_rows USING v_org;

      WHEN 'person' THEN
        EXECUTE format(
          'SELECT coalesce(jsonb_agg(to_jsonb(__r) ORDER BY %s), ''[]''::jsonb) FROM (SELECT %s FROM public.%I WHERE id = ANY($1)) AS __r',
          v_order, v_cols, c.table_name
        ) INTO v_rows USING v_people;

      WHEN 'person_profile' THEN
        EXECUTE format(
          'SELECT coalesce(jsonb_agg(to_jsonb(__r) ORDER BY %s), ''[]''::jsonb) FROM (SELECT %s FROM public.%I WHERE person_id = ANY($1)) AS __r',
          v_order, v_cols, c.table_name
        ) INTO v_rows USING v_people;

      ELSE
        EXECUTE format(
          'SELECT coalesce(jsonb_agg(to_jsonb(__r) ORDER BY %s), ''[]''::jsonb) FROM (SELECT %s FROM public.%I WHERE org_id = $1) AS __r',
          v_order, v_cols, c.table_name
        ) INTO v_rows USING v_org;
    END CASE;

    v_tables := v_tables || jsonb_build_object(c.table_name, v_rows);
  END LOOP;

  -- jsonb key order is canonical (length, then bytewise), so the serialisation of
  -- this document is a pure function of its contents. No `exported_at`: a clock
  -- in the header is the one field that would make two exports of identical data
  -- differ, and diffing is how a leak is detected.
  RETURN jsonb_build_object(
    'format',            'raptor.portability.export',
    'format_version',    1,
    'schema_migrations', v_migrated,
    'last_migration',    v_last,
    'organization_id',   v_org::text,
    'contract', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'ordinal',     k.ordinal,
               'table',       k.table_name,
               'scope',       k.scope,
               'key_columns', to_jsonb(k.key_columns),
               'writable',    k.writable
             ) ORDER BY k.ordinal), '[]'::jsonb)
        FROM public.portability_export_contract() k
    ),
    'tables', v_tables
  );
END
$fn$;

COMMENT ON FUNCTION public.portability_export_document() IS
  'A complete, self-describing, byte-reproducible export of ONE organisation. Takes no organisation argument: the tenant comes from the session, so there is no parameter with which a caller could ask for another organisation''s data. Every value is canonical text in UTC and every row array is ordered by the contract''s key, so two exports of the same data are byte-identical and diffable. An unset tenant context raises rather than returning an empty document. SECURITY DEFINER because person is gated by membership (0001) and a tenant''s export must carry the people its own rows reference; the person set is a closure over the tenant''s own rows, so nobody else''s people can appear.';

-- -----------------------------------------------------------------------------
-- THE IMPORT
-- -----------------------------------------------------------------------------
--
-- Order of operations, and the reason for it:
--
--   1. Format and version.     A document from another system is data, not a
--                               document, and parsing it would be guessing.
--   2. Tenant agreement.       REFUSED, never rewritten.
--   3. Schema agreement.       A document written against a different schema is
--                               refused rather than reinterpreted: guessing what
--                               a column meant is how data is corrupted.
--   4. Contract agreement.     Every table the document claims must be one this
--                               installation imports, and every writable table
--                               must be present — an empty array is not the same
--                               claim as an absent one.
--   5. Row tenant agreement.   Every row's org_id must equal the session tenant,
--                               checked for every row of every table BEFORE a
--                               single row is inserted.
--   6. Rows, in contract order, deferring references that do not resolve yet.
--   7. The receipt, in the same transaction as the data.
--
-- Steps 1 to 5 all run before step 6 begins, so a payload with a malformed record
-- at position 9000 has written nothing when it is refused. Steps 6 and 7 share
-- the caller's transaction, so an error in 6 rolls 7 back with everything else.
CREATE OR REPLACE FUNCTION public.portability_import_document(p_document jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET TimeZone = 'UTC'
AS $fn$
DECLARE
  v_org        uuid;
  c            record;
  v_doc_tables jsonb;
  v_pending    jsonb;
  v_next       jsonb;
  v_row        record;
  v_progress   integer;
  v_written    integer := 0;
  v_tables     integer := 0;
  v_bad        text[];
BEGIN
  v_org := public.current_org_id();

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'no tenant is set in this session, so there is nothing to import into.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_document IS NULL OR (p_document ->> 'format') IS DISTINCT FROM 'raptor.portability.export' THEN
    RAISE EXCEPTION 'this is not a portability export document (format = %)',
      coalesce(p_document ->> 'format', 'null')
      USING ERRCODE = 'invalid_text_representation';
  END IF;

  IF (p_document ->> 'format_version')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'export format version % is not understood by this installation, which reads version 1',
      p_document ->> 'format_version'
      USING ERRCODE = 'invalid_text_representation';
  END IF;

  -- THE TENANT CHECK. The document says whose data it is; the session says whose
  -- data we are writing. If they differ, the import FAILS.
  --
  -- It is not repaired by rewriting org_id to the session's tenant. A document
  -- naming another organisation is either the wrong file or an attempt, and
  -- quietly re-aiming it would convert a refusal into data that looks right and
  -- belongs to the wrong people.
  IF (p_document ->> 'organization_id') IS DISTINCT FROM v_org::text THEN
    RAISE EXCEPTION
      'refusing to import a document for organisation % into organisation %: the references inside it name the other organisation''s entities, and rewriting them to local ones would corrupt them silently.',
      p_document ->> 'organization_id', v_org
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF (p_document ->> 'last_migration') IS DISTINCT FROM (SELECT max(name) FROM public.schema_migration) THEN
    RAISE EXCEPTION
      'this document was written against schema % but this installation is at %; refusing rather than guessing which column meant what',
      p_document ->> 'last_migration', (SELECT max(name) FROM public.schema_migration)
      USING ERRCODE = 'invalid_text_representation';
  END IF;

  v_doc_tables := coalesce(p_document -> 'tables', '{}'::jsonb);

  -- Every table the document carries must be one this installation KNOWS, and
  -- every writable contract table must be present in the document. A table that
  -- is missing and a table that is empty are different claims, and treating them
  -- alike would let a partial document import as a complete one.
  --
  -- The first check accepts NON-writable contract tables — `organization` is in
  -- every document and is never written by one, because the tenant is not the
  -- tenant's data. Only the second check is restricted to writable tables, and
  -- the two checks ask different questions on purpose: "is this a table I know?"
  -- and "is this complete?".
  --
  -- The alias is `x`, never `c`: `c` is this function's plpgsql record variable,
  -- and a query that aliases a FROM item to the same name shadows it, so the
  -- next reference to `c.table_name` reads the unassigned record and the import
  -- fails with `record "c" is not assigned yet` — before a single row is written,
  -- and for a reason that has nothing to do with the document.
  SELECT array_agg(k.t) INTO v_bad
    FROM jsonb_object_keys(v_doc_tables) AS k(t)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.portability_export_contract() x
      WHERE x.table_name = k.t
   );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'document carries table(s) % that this installation does not import', array_to_string(v_bad, ', ')
      USING ERRCODE = 'invalid_text_representation';
  END IF;

  SELECT array_agg(x.table_name) INTO v_bad
    FROM public.portability_export_contract() x
   WHERE x.writable
     AND NOT (v_doc_tables ? x.table_name);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'document is missing table(s) % that this installation imports; a partial document is not a small import, it is an incomplete one', array_to_string(v_bad, ', ')
      USING ERRCODE = 'invalid_text_representation';
  END IF;

  -- ROW TENANT AGREEMENT, for every row of every tenant table, before a single
  -- row is inserted. This is the second half of "rejected, never reparented":
  -- the composite foreign keys stop a row from REFERENCING another tenant's
  -- entity, and this stops a row from BELONGING to another tenant.
  SELECT array_agg(DISTINCT x.table_name) INTO v_bad
    FROM public.portability_export_contract() x
    CROSS JOIN LATERAL jsonb_array_elements(v_doc_tables -> x.table_name) AS e(elem)
   WHERE x.scope = 'tenant'
     AND (e.elem ->> 'org_id') IS DISTINCT FROM v_org::text;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'refusing to import: table(s) % carry rows whose org_id is not this organisation. Every row of an import must belong to the organisation being imported into; a row that does not is a cross-tenant reference and is refused rather than reparented.',
      array_to_string(v_bad, ', ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR c IN SELECT * FROM public.portability_export_contract() WHERE writable ORDER BY ordinal LOOP
    v_pending := v_doc_tables -> c.table_name;

    -- Retry loop. A row whose references are not present yet is deferred rather
    -- than failed, because six tables reference themselves and a self reference
    -- has no order. The loop exits when everything has landed, and RAISES the
    -- moment a whole pass inserts nothing — which is what turns "cannot resolve"
    -- into a refusal rather than an infinite wait.
    LOOP
      v_progress := 0;
      v_next    := '[]'::jsonb;

      FOR v_row IN SELECT x.value AS value FROM jsonb_array_elements(v_pending) AS x LOOP
        BEGIN
          EXECUTE format(
            'INSERT INTO public.%I (%s) SELECT %s FROM jsonb_array_elements($1) AS x',
            c.table_name,
            public.portability_column_list(c.table_name),
            public.portability_text_cast(c.table_name)
          ) USING jsonb_build_array(v_row.value);
          v_written   := v_written + 1;
          v_progress  := v_progress + 1;
        EXCEPTION WHEN foreign_key_violation THEN
          v_next := v_next || jsonb_build_array(v_row.value);
        END;
      END LOOP;

      EXIT WHEN jsonb_array_length(v_next) = 0;

      IF v_progress = 0 THEN
        RAISE EXCEPTION
          'row % of % cannot be imported: its references do not resolve in organisation %. A cross-tenant reference is refused here rather than rewritten, because a rewritten reference points at a different entity and the result would look correct.',
          coalesce(v_next -> 0 ->> 'id', '<no id>'), c.table_name, v_org
          USING ERRCODE = 'foreign_key_violation';
      END IF;

      v_pending := v_next;
    END LOOP;

    v_tables := v_tables + 1;
  END LOOP;

  -- THE RECEIPT, in the same transaction as the data it describes. A run row
  -- exists if and only if the import happened, which is a property of sharing the
  -- transaction rather than a convention someone has to remember.
  --
  -- `sha256(bytea)` is the BUILT-IN function for the reason 0010 records: this
  -- PGlite build does not ship pgcrypto, so `digest()` is unavailable. jsonb's
  -- text rendering is canonical (length then bytewise on keys), so the digest is
  -- a function of the document's CONTENTS and not of how it was serialised.
  INSERT INTO public.portability_import_run
    (org_id, source_schema_migrations, source_last_migration,
     tables_written, rows_written, document_digest, imported_at)
  VALUES
    (v_org, (p_document ->> 'schema_migrations')::integer, p_document ->> 'last_migration',
     v_tables, v_written, encode(sha256(convert_to(p_document::text, 'UTF8')), 'hex'), now());

  RETURN v_written;
END
$fn$;

COMMENT ON FUNCTION public.portability_import_document(jsonb) IS
  'Writes one organisation''s export back into that organisation, all-or-nothing. Refuses — never repairs — a document whose organization_id is not the session tenant, whose schema differs from this installation''s, or that carries rows whose org_id belongs elsewhere. Rows whose references have not landed yet are retried; a pass that inserts nothing raises the foreign-key violation rather than waiting forever. Runs entirely inside the caller''s transaction, so any error rolls back every row inserted before it, including the receipt.';

-- -----------------------------------------------------------------------------
-- THE RECEIPT
-- -----------------------------------------------------------------------------
CREATE TABLE portability_import_run (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  source_schema_migrations integer NOT NULL,
  source_last_migration    text NOT NULL,
  tables_written           integer NOT NULL,
  rows_written             integer NOT NULL,
  document_digest          char(64) NOT NULL,
  imported_at              timestamptz NOT NULL,
  CONSTRAINT portability_import_run_rows_check   CHECK (rows_written >= 0 AND tables_written >= 0),
  -- A CHECK that can evaluate to NULL is not enforcing anything: `NULL ~ '...'`
  -- is NULL and a CHECK rejects only an explicit FALSE. Both operands here are
  -- NOT NULL so the expression cannot be three-valued, and the pattern is the one
  -- 0010's money checks use for the same reason.
  CONSTRAINT portability_import_run_digest_check CHECK (document_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT portability_import_run_schema_check  CHECK (source_schema_migrations >= 0),
  CONSTRAINT portability_import_run_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX portability_import_run_org_idx      ON portability_import_run (org_id);
CREATE INDEX portability_import_run_org_time_idx ON portability_import_run (org_id, imported_at);

COMMENT ON TABLE portability_import_run IS
  'The receipt for one import. Written in the SAME transaction as the data, so a receipt exists if and only if the import happened — which is why a refused import leaves no record of itself at all rather than a record claiming otherwise. Deliberately NOT in the export contract: it is a note about a transfer into this installation, and re-importing one would forge it.';

ALTER TABLE portability_import_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE portability_import_run FORCE  ROW LEVEL SECURITY;
CREATE POLICY portability_import_run_tenant_isolation ON portability_import_run
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());

COMMENT ON POLICY portability_import_run_tenant_isolation ON portability_import_run IS
  'The tenant predicate and nothing else. No IS NULL branch, so an unset context reads nothing rather than everything (ADR-0006).';

-- =============================================================================
-- WHY EACH EXCLUDED TABLE IS EXCLUDED, RECORDED IN THE SCHEMA
-- =============================================================================
--
-- The file header argues these exclusions. An argument in a comment is a claim; a
-- comment ON THE OBJECT is something a test can read out of `obj_description` and
-- something a reader sees in a schema browser without opening this file at all.
-- `portability.isolation.test.ts` asserts each one says more than a sentence,
-- because an exclusion nobody can find is an exclusion nobody will challenge.

COMMENT ON TABLE identity IS
  'DELIBERATELY NOT EXPORTED (0011). How a human authenticates: the identifier they present to this installation. Copying it into another tenant would create credentials where they were never issued, and a credential is not an organisation''s business data. `person` IS exported, so a restored organisation still knows who its people are; it just cannot impersonate them.';

COMMENT ON TABLE consent_record IS
  'DELIBERATELY NOT EXPORTED (0011). A revocable permission grant: the record that a person said yes to a purpose, and possibly no since. Copying it into another tenant would resurrect a permission the person has withdrawn, which is the opposite of what a consent record is for. Withdrawing consent is an append of a withdrawal rather than an absence, and 0011 refuses to move that append between organisations.';

COMMENT ON TABLE audit_log IS
  'DELIBERATELY NOT EXPORTED (0011). The record of what happened IN THIS INSTALLATION, including who looked at what. Exporting it and re-importing it elsewhere forges history rather than preserving it: an auditor reading the restored copy would be reading a document this installation invented. ADR-0005''s audit taxonomy is about provability HERE, and a copied log proves nothing about there.';

COMMENT ON TABLE outbox_event IS
  'DELIBERATELY NOT EXPORTED (0011). Delivery bookkeeping for messages THIS installation still owes to somebody. Importing it into another organisation would make that installation re-send this organisation''s notifications to its people — a data leak that presents as working mail.';

COMMENT ON TABLE permission IS
  'DELIBERATELY NOT EXPORTED (0011). The platform''s VOCABULARY of what may be done: (resource, action, risk_level) pairs, with org_id NULL for the system set every tenant shares. It is to permissions what an enum type is to a column — a closed set the installation defines, not data an organisation owns. Exporting one tenant''s custom permissions would either create duplicate vocabulary in the destination or collide with its own, and the destination''s role_permission rows would then point at whichever copy won. Roles ARE exported; what they may do is the installation''s to decide.';

-- =============================================================================
-- PRIVILEGES
-- =============================================================================
--
-- EXPORT needs SELECT on every table in the contract, because a portability
-- export that cannot read a table is a backup with a hole in it. It grants no
-- UPDATE and no DELETE anywhere: reading is the whole of its authority.
--
-- IMPORT is a FUNCTION, not a grant. Handing `raptor_app` INSERT on the six
-- governance transition tables would let a request handler rewrite an
-- organisation's own state machine, which 0008, 0009 and 0010 each refuse for
-- exactly that reason. A test asserts those grants are still absent after this
-- migration.
GRANT USAGE ON SCHEMA public TO raptor_app;

GRANT SELECT ON
  person, person_profile,
  content_state_transition, creator_profile, engagement, facility, game,
  guardian_consent, hr_state_transition, inventory_item, ledger_account,
  org_membership, partner, partner_state_transition, person_document,
  public_site_publication, role, task_state_transition, workflow_definition,
  asset_custody, compensation_agreement, content_item, contract,
  facility_reservation, guardian_consent_withdrawal, hr_record,
  inventory_movement, opponent, role_assignment, role_permission,
  role_scope_rule, title, trip, workflow_run, workflow_step_definition,
  competition, contract_obligation, contract_version, season, trip_destination,
  trip_traveller, workflow_step_run, contract_acceptance, contract_obligation_part,
  division, task, trip_leg, acceptance_withdrawal, competition_division,
  obligation_evidence, task_dependency, task_transition, team,
  attendance_policy, budget, ledger_journal, "match",
  obligation_evidence_retraction, prize_pool, registration, session_holiday,
  session_template, team_membership, team_staff, entry_cost, expense, invoice,
  ledger_line, match_map, match_result, performance_extraction, prize_allocation,
  session, attendance_record, invoice_line, match_player_performance,
  prize_allocation_input, prize_allocation_reconciliation, prize_allocation_result,
  prize_allocation_term, asset
TO raptor_app;

GRANT SELECT, INSERT ON portability_import_run TO raptor_app;
REVOKE UPDATE, DELETE ON portability_import_run FROM raptor_app;

GRANT EXECUTE ON FUNCTION public.portability_export_document() TO raptor_app;
GRANT EXECUTE ON FUNCTION public.portability_import_document(jsonb) TO raptor_app;
GRANT EXECUTE ON FUNCTION public.portability_export_contract() TO raptor_app;
GRANT EXECUTE ON FUNCTION public.portability_text_projection(text) TO raptor_app;
GRANT EXECUTE ON FUNCTION public.portability_text_cast(text) TO raptor_app;
GRANT EXECUTE ON FUNCTION public.portability_column_list(text) TO raptor_app;
GRANT EXECUTE ON FUNCTION public.portability_person_closure(uuid) TO raptor_app;

COMMIT;

-- ==========================================================================
-- SOURCE: packages/db/migrations/0012_analytics.sql
-- ==========================================================================

-- =============================================================================
-- packages/db/migrations/0012_analytics.sql
--
-- ANALYTICS: read-only aggregates that are either reproducible or explicitly
-- absent.
--
-- THE PROBLEM THIS FILE EXISTS TO SOLVE
-- ------------------------------------
-- There is no shortage of numbers a dashboard can show about an esports
-- organisation. There is a shortage of numbers that survive being asked "how did
-- you get that?". ADR-0019 records what the alternative looks like, and none of
-- it was arithmetic:
--
--     "Win rate"      <- totalMatches * 0.7
--     "Team Ranking"  <- Math.ceil(totalMatches / 5)
--     OCR confidence  <- a hardcoded 85
--     bestDay         <- days.sort(...) with the return value DISCARDED, then
--                        days[0] read from a still-ascending array
--
-- Every one of those is a plausible-looking number attached to no derivation.
-- The five rules below are the whole of the response, and each one is mechanical
-- rather than aspirational.
--
-- 1. A METRIC IS A UNION, NOT A NULLABLE NUMBER
--    `analytics_metric_status` has two members and every metric carries one. A
--    metric that cannot be computed carries an `unavailable_reason` drawn from
--    a CLOSED enum, so "why is this missing?" has an answer for every figure and
--    an answer that is not in the vocabulary is impossible to state. This is the
--    type-level form of "never fabricate": there is no `value` column to fall
--    back to, so no caller can write `COALESCE(value, 0)` and get away with it.
--
-- 2. A METRIC DERIVES FROM A MATCH
--    `matches_won` counts DISTINCT `match.id`. The legacy system counted
--    player-rows, so one team win by a four-player squad reported FOUR wins
--    (`/api/public/stats/route.ts:26-28`). `player_lines_in_won_matches` is
--    reported ALONGSIDE it rather than instead of it: publishing the pair is what
--    lets a reader see which number they were shown.
--
-- 3. WINDOWS FILTER ON THE EVENT DATE
--    `match.scheduled_at`, never `created_at`. A season imported last Tuesday
--    belongs to the months it was played in. `scheduled_at` specifically rather
--    than `completed_at`, because it is the one instant on `match` that is NOT
--    NULL for every match — a `completed_at` window would silently drop every
--    match whose completion was never recorded.
--
-- 4. TRUNCATION IS REPORTED, NEVER PERFORMED SILENTLY
--    Every row of `analytics_top_teams` carries `rows_matched` and
--    `is_truncated`, on EVERY row rather than the last, and a cap below one is
--    refused rather than returning an empty set that renders as "no teams". A
--    capped set presented as a ranking looks authoritative, which is worse than a
--    refusal because the reader has no way to tell.
--
-- AND THE FIGURE THAT IS DELIBERATELY NOT PRODUCED
-- ---------------------------------------------------
-- `team_ranking` is returned as `unavailable` with reason `no_rule_recovered`,
-- every time, for every window. The legacy system's "Team Ranking" was
-- `Math.ceil(totalMatches / 5)` — a constant divided into a match count, with no
-- relationship to performance — and ADR-0019 records that there is no other
-- ranking formula anywhere in the source to recover. Any number here would be an
-- invention wearing a leaderboard's clothes.
--
-- It is emitted as a ROW rather than simply omitted, because "this metric does
-- not exist and here is why" is a report a product owner can act on, and a blank
-- space in a JSON response is a gap nobody notices until a customer asks.
-- `analytics.isolation.test.ts` asserts the row exists, that it is permanently
-- unavailable, and that `packages/core/src/analytics/metrics.ts` says the same
-- thing in the same words — read as source text, so the domain and the schema
-- cannot drift apart silently the way `operations.isolation.test.ts` does for the
-- task transition table.
--
-- TENANCY
-- -------
-- No table is added, so there is no `org_id` to declare. Every function takes NO
-- organisation argument: the tenant is read from the session by
-- `current_org_id()`, exactly as every RLS policy does (ADR-0011 rule 3), so a
-- caller cannot choose which tenant they read. With the context unset, the
-- tenant is NULL, the predicate matches no row, and every aggregate answers with
-- `no_events_in_window` rather than with somebody else's figures.
--
-- The functions are SECURITY INVOKER, not SECURITY DEFINER. They read only
-- tenant tables whose RLS policies already carry the same predicate, so the
-- function adds no authority the caller did not already have — and a
-- SECURITY DEFINER aggregate over RLS-protected tables is the shape of bug where
-- one forgotten predicate leaks a whole customer.
--
-- ENVIRONMENT FACTS THIS FILE IS WRITTEN AROUND, both recorded elsewhere and
-- neither rediscovered here: `btree_gist` is unavailable and `EXCLUDE USING gist`
-- over uuid fails, and `digest()`/pgcrypto is absent from this PGlite build so
-- the built-in `sha256(bytea)` is used instead. Neither is needed here.
-- =============================================================================

BEGIN;

-- =============================================================================
-- THE VOCABULARY
-- =============================================================================

-- TWO members, and there is deliberately no third. A `metric_status` of
-- 'unknown' would be where every fabricated figure would go to hide: it reads
-- as "we could not tell", which is indistinguishable from "there was nothing to
-- tell", which is a real answer that would then be lost.
CREATE TYPE public.analytics_metric_status AS ENUM ('available', 'unavailable');

-- The CLOSED set of reasons a metric can be unavailable. Same members, same
-- order, as `UNAVAILABLE_REASONS` in `packages/core/src/analytics/metric.ts`:
--
--   no_events_in_window  the window is genuinely empty
--   no_decided_events    events happened, none were won or lost
--   zero_denominator      the specific input the ratio needs was never recorded
--   input_not_tracked     this schema records no such input at all
--   no_rule_recovered     the inputs exist and NO FORMULA was recoverable
--
-- `no_rule_recovered` is the load-bearing one: it is how the layer says "there
-- is nothing to recover here" instead of inventing something. A reason outside
-- this enum cannot be written, so an invented one cannot be reported.
CREATE TYPE public.analytics_unavailable_reason AS ENUM (
  'no_events_in_window',
  'no_decided_events',
  'zero_denominator',
  'input_not_tracked',
  'no_rule_recovered'
);

COMMENT ON TYPE public.analytics_unavailable_reason IS
  'Why a metric could not be computed. Closed by design: an invented figure needs an invented reason, and this enum refuses to store one. Mirrors UNAVAILABLE_REASONS in packages/core/src/analytics/metric.ts, which analytics.isolation.test.ts asserts member-for-member.';

-- =============================================================================
-- THE AGGREGATES
-- =============================================================================

-- THE CORE FUNCTION.
--
-- One row per metric, always the same set of rows in the same order, so a caller
-- can render a stable report and so a test can assert a key is PRESENT rather
-- than merely that no number was returned. A summary that omits what it could
-- not compute is the defect: it looks like a complete report.
--
-- Every window is [from, to), HALF-OPEN. An event at exactly `to` belongs to the
-- next window, so a daily bucket and its neighbour cannot both claim it.
--
-- Cancelled matches are excluded from every count. A cancelled match is not an
-- event anybody played, and including it would report a fixture as a fixture.
--
-- An archived performance line is history, not a fact about the match: counting
-- it beside its replacement would double the player. An archived match result is
-- excluded for the same reason.
CREATE OR REPLACE FUNCTION public.analytics_metric_summary(
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS TABLE (
  metric_key          text,
  metric_status       public.analytics_metric_status,
  unavailable_reason  public.analytics_unavailable_reason,
  unavailable_text    text,
  numerator           bigint,
  denominator         bigint,
  value               numeric
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $fn$
DECLARE
  v_org      uuid := public.current_org_id();
  v_matches  bigint;
  v_wins     bigint := 0;
  v_losses   bigint := 0;
  v_draws    bigint := 0;
  v_maps_won bigint := 0;
  v_maps_lost bigint := 0;
  v_kills    bigint := 0;
  v_deaths   bigint := 0;
  v_hs       bigint := 0;
  v_hsa      bigint := 0;
  v_survival bigint := 0;
  v_lines    bigint := 0;
  v_win_matches  bigint := 0;
  v_win_lines    bigint := 0;
BEGIN
  -- A window with no bounds is refused rather than defaulted. "All time" and
  -- "this month" are different claims, and a report that quietly treats one as
  -- the other stops meaning anything the first time history is truncated. This is
  -- the same refusal `packages/core/src/analytics/window.ts` makes and 0007's
  -- leaderboard makes.
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'an analytics window needs both a start and an end; an open-ended window hides unbounded history'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_to <= p_from THEN
    RAISE EXCEPTION 'analytics window [% , % ) is empty', p_from, p_to
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every aggregate below is scoped to the session tenant BEFORE anything is
  -- counted, and the tenant comes from the session rather than from an argument
  -- (ADR-0011 rule 3). With the context unset, v_org IS NULL matches no row and
  -- every count is zero — which is reported as `no_events_in_window`, not as a
  -- plausible set of figures about somebody else.
  SELECT count(*)
    INTO v_matches
    FROM public."match" m
   WHERE m.org_id = v_org
     AND m.status <> 'cancelled'
     AND m.archived_at IS NULL
     AND m.scheduled_at >= p_from
     AND m.scheduled_at <  p_to;

  -- ONE RESULT ROW PER (match, team): `match_result` is UNIQUE
  -- (org_id, match_id, team_id), so joining a squad's four lines here cannot
  -- multiply it. That single constraint is what stops a four-player win being
  -- counted four times.
  SELECT
      count(DISTINCT r.match_id) FILTER (WHERE r.outcome = 'win'),
      count(DISTINCT r.match_id) FILTER (WHERE r.outcome = 'loss'),
      count(DISTINCT r.match_id) FILTER (WHERE r.outcome = 'draw'),
      coalesce(sum(r.maps_won), 0),
      coalesce(sum(r.maps_lost), 0),
      count(DISTINCT r.match_id) FILTER (WHERE r.outcome = 'win')
    INTO v_wins, v_losses, v_draws, v_maps_won, v_maps_lost, v_win_matches
    FROM public.match_result r
    JOIN public."match" m ON m.org_id = r.org_id AND m.id = r.match_id
   WHERE r.org_id = v_org
     AND r.archived_at IS NULL
     AND m.status <> 'cancelled'
     AND m.archived_at IS NULL
     AND m.scheduled_at >= p_from
     AND m.scheduled_at <  p_to;

  -- SUMMED RAW INPUTS, NEVER AVERAGED RATIOS. Averaging per-row ratios weights a
  -- one-round cameo exactly as heavily as a full match, which is how a leaderboard
  -- ends up ranking a player above the team that outranked them. The stored
  -- per-row ratios are never read here; the evidence is summed and the ratio is
  -- taken once, at the end.
  SELECT coalesce(sum(s.kills), 0),
         coalesce(sum(s.deaths), 0),
         coalesce(sum(s.headshots), 0),
         coalesce(sum(s.headshot_attempts), 0),
         coalesce(sum(s.survival_time_seconds), 0),
         count(*)
    INTO v_kills, v_deaths, v_hs, v_hsa, v_survival, v_lines
    FROM public.match_player_performance s
    JOIN public."match" m ON m.org_id = s.org_id AND m.id = s.match_id
   WHERE s.org_id = v_org
     AND s.archived_at IS NULL
     AND m.status <> 'cancelled'
     AND m.archived_at IS NULL
     AND m.scheduled_at >= p_from
     AND m.scheduled_at <  p_to;

  -- THE DOUBLE COUNT, COUNTED. Distinct MATCHES won, and distinct PLAYER LINES
  -- recorded against a won match. They differ by the squad size, and a report
  -- showing only the second is how one team win became four.
  SELECT count(DISTINCT s.match_id)
    INTO v_win_lines
    FROM public.match_player_performance s
    JOIN public."match" m ON m.org_id = s.org_id AND m.id = s.match_id
    JOIN public.match_result r
      ON r.org_id = s.org_id AND r.match_id = m.id AND r.team_id = m.team_id
   WHERE s.org_id = v_org
     AND s.archived_at IS NULL
     AND r.archived_at IS NULL
     AND m.status <> 'cancelled'
     AND m.archived_at IS NULL
     AND m.scheduled_at >= p_from
     AND m.scheduled_at <  p_to
     AND r.outcome = 'win';

  -- ---------------------------------------------------------------------------
  -- THE ROWS
  -- ---------------------------------------------------------------------------
  --
  -- Counted by hand rather than emitted by a loop, because the ORDER of this list
  -- is part of the contract and a loop over a hash-ordered set is not.

  metric_key := 'matches_played'; v_matches := v_matches;
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_matches; denominator := 1; value := v_matches::numeric;
  RETURN NEXT;

  metric_key := 'match_wins';
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_wins; denominator := 1; value := v_wins::numeric;
  RETURN NEXT;

  metric_key := 'match_losses';
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_losses; denominator := 1; value := v_losses::numeric;
  RETURN NEXT;

  metric_key := 'match_draws';
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_draws; denominator := 1; value := v_draws::numeric;
  RETURN NEXT;

  -- THE ANTI-`totalMatches * 0.7` METRIC.
  --
  -- The denominator is wins + losses, NOT wins + losses + draws. A draw is a real
  -- result with no winner, and counting it would report a team that drew its
  -- whole season as having a 0% win rate — a claim about failure where the data
  -- says something else entirely.
  metric_key := 'win_rate';
  IF (v_wins + v_losses) = 0 THEN
    metric_status := 'unavailable'; unavailable_reason := 'no_decided_events';
    unavailable_text := 'No match in this window was won or lost (' || v_draws::text
                        || ' drawn), so a win rate has no denominator. Reporting 0% would say the team lost; reporting nothing says the question does not apply.';
    numerator := NULL; denominator := NULL; value := NULL;
  ELSE
    metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
    numerator := v_wins; denominator := v_wins + v_losses;
    value := round(v_wins::numeric / (v_wins + v_losses)::numeric, 4);
  END IF;
  RETURN NEXT;

  metric_key := 'map_win_rate';
  IF (v_maps_won + v_maps_lost) = 0 THEN
    metric_status := 'unavailable'; unavailable_reason := 'no_decided_events';
    unavailable_text := 'No map in this window was won or lost, so a map win rate has no denominator.';
    numerator := NULL; denominator := NULL; value := NULL;
  ELSE
    metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
    numerator := v_maps_won; denominator := v_maps_won + v_maps_lost;
    value := round(v_maps_won::numeric / (v_maps_won + v_maps_lost)::numeric, 4);
  END IF;
  RETURN NEXT;

  metric_key := 'kd_ratio';
  IF v_deaths = 0 THEN
    -- `zero_denominator`, not `no_decided_events`: ADR-0019 records that the
    -- legacy system tracked no deaths at all, so a stored 0 and a stored
    -- "unrecorded" are indistinguishable there. This schema tracks them (0007),
    -- so a genuine zero is a real answer and an undefined ratio is a different one.
    metric_status := 'unavailable'; unavailable_reason := 'zero_denominator';
    unavailable_text := 'No death was recorded in this window, so a K/D ratio has no denominator. An undefined ratio is reported as undefined; it is not reported as zero and not reported as infinite.';
    numerator := NULL; denominator := NULL; value := NULL;
  ELSE
    metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
    numerator := v_kills; denominator := v_deaths;
    value := round(v_kills::numeric / v_deaths::numeric, 4);
  END IF;
  RETURN NEXT;

  metric_key := 'headshot_rate_pct';
  IF v_hsa = 0 THEN
    metric_status := 'unavailable'; unavailable_reason := 'no_decided_events';
    unavailable_text := 'No headshot attempt was recorded in this window, so a headshot rate has no denominator. A zero here would say the player missed every attempt, which is a different claim from nobody having tried.';
    numerator := NULL; denominator := NULL; value := NULL;
  ELSE
    metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
    -- Numerator scaled by 100 so the value reads as a PERCENTAGE while staying
    -- exactly numerator/denominator at four decimals. Rescaling the rendered
    -- number afterwards would produce the right figure by a route the metric no
    -- longer describes.
    numerator := v_hs * 100; denominator := v_hsa;
    value := round((v_hs * 100)::numeric / v_hsa::numeric, 4);
  END IF;
  RETURN NEXT;

  -- A SUM under a name that carries its unit, never a unitless average.
  -- `survival_time` was minutes on one legacy surface and seconds on another
  -- (ADR-0019, unresolvable item 3), which is why 0007 renamed the column
  -- `survival_time_seconds`. A mean would additionally divide by a "match count"
  -- whose meaning is exactly what was in doubt.
  metric_key := 'total_survival_seconds';
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_survival; denominator := 1; value := v_survival::numeric;
  RETURN NEXT;

  metric_key := 'performance_lines';
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_lines; denominator := 1; value := v_lines::numeric;
  RETURN NEXT;

  -- THE PAIR. Two rows rather than one, so a reader can see that the second is
  -- four times the first for a four-player squad — which is the whole defect
  -- ADR-0019 opens with, rendered instead of hidden.
  metric_key := 'matches_won';
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_win_matches; denominator := 1; value := v_win_matches::numeric;
  RETURN NEXT;

  metric_key := 'player_lines_in_won_matches';
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_win_lines; denominator := 1; value := v_win_lines::numeric;
  RETURN NEXT;

  -- THE FIGURE THAT IS NOT PRODUCED.
  --
  -- Always, for every window, on purpose. `Math.ceil(totalMatches / 5)` was
  -- displayed as "Team Ranking" in the legacy system and there is no other ranking
  -- formula anywhere in the source to recover (ADR-0019). Emitting the row with
  -- its reason is what turns "we did not build this" into a report somebody can
  -- read, instead of a key that is quietly missing from a JSON response.
  metric_key := 'team_ranking';
  metric_status := 'unavailable'; unavailable_reason := 'no_rule_recovered';
  unavailable_text := 'No ranking rule exists to recover. The legacy system displayed ''Math.ceil(totalMatches / 5)'' as Team Ranking — a constant divided into a match count, with no relationship to performance (ADR-0019). Any rank produced here would be an invention wearing a leaderboard''s clothes.';
  numerator := NULL; denominator := NULL; value := NULL;
  RETURN NEXT;

  metric_key := 'impact_rating';
  metric_status := 'unavailable'; unavailable_reason := 'input_not_tracked';
  unavailable_text := 'Nothing in this schema records the inputs an impact rating would be computed from. ADR-0019 searched the legacy source exhaustively and found no ADR, no ACS and no impact formula, so there is no raw input to aggregate and no formula to aggregate it with.';
  numerator := NULL; denominator := NULL; value := NULL;
  RETURN NEXT;
END
$fn$;

COMMENT ON FUNCTION public.analytics_metric_summary(timestamptz, timestamptz) IS
  'Every metric for one organisation over one event-dated window, each either available with its own numerator and denominator, or unavailable with a reason drawn from a closed enum. Takes NO organisation argument — the tenant comes from the session (ADR-0011 rule 3). Filters on match.scheduled_at, never created_at (ADR-0019 rule 5). Never fabricates: win_rate, kd_ratio and headshot_rate_pct are absent rather than zero when they have no denominator, and team_ranking is permanently absent with reason no_rule_recovered. SECURITY INVOKER, so it adds no authority the caller did not already have.';

-- =============================================================================
-- THE TEAM LEADERBOARD
-- =============================================================================
--
-- Ordered by a STATED rule, and the rule is stated in the function's comment
-- because an ordering nobody can see is not reproducible:
--
--   map win rate DESC, then matches won DESC, then team id ASC.
--
-- `team id` last, and it is a STORED IMMUTABLE value rather than a function of
-- row order — which is what makes the ranking reproducible. ADR-0019 records that
-- no legacy leaderboard sort had a tie-breaker, so two teams with identical
-- records came back in whatever order the rows happened to arrive.
--
-- COALESCE(kv, -1) puts an undefined rate last rather than first: a DESC sort
-- would otherwise rank NULL above every real number, and a team with no maps
-- played would top the table.
CREATE OR REPLACE FUNCTION public.analytics_top_teams(
  p_from  timestamptz,
  p_to    timestamptz,
  p_limit integer DEFAULT NULL
)
RETURNS TABLE (
  team_id         uuid,
  team_name       text,
  rank_position   integer,
  matches_won     integer,
  matches_lost    integer,
  maps_won        integer,
  maps_lost       integer,
  map_win_rate    numeric,
  rows_matched    integer,
  is_truncated    boolean
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $fn$
DECLARE
  v_org uuid := public.current_org_id();
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'a leaderboard window needs both a start and an end; an open-ended window hides unbounded history'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_to <= p_from THEN
    RAISE EXCEPTION 'leaderboard window [% , % ) is empty', p_from, p_to
      USING ERRCODE = 'check_violation';
  END IF;

  -- A cap of zero or less is REFUSED rather than returning an empty ranking that
  -- renders as "no teams exist". An empty table and a truncated one are different
  -- answers and only one of them is true.
  IF p_limit IS NOT NULL AND p_limit < 1 THEN
    RAISE EXCEPTION 'a leaderboard cap of % would return nothing while looking like a ranking', p_limit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN QUERY
  WITH results AS (
    SELECT t.id,
           t.name,
           count(DISTINCT r.match_id) FILTER (WHERE r.outcome = 'win')::integer  AS matches_won,
           count(DISTINCT r.match_id) FILTER (WHERE r.outcome = 'loss')::integer AS matches_lost,
           coalesce(sum(r.maps_won), 0)::integer                                AS maps_won,
           coalesce(sum(r.maps_lost), 0)::integer                               AS maps_lost,
           CASE WHEN coalesce(sum(r.maps_won), 0) + coalesce(sum(r.maps_lost), 0) = 0 THEN NULL
                ELSE round(coalesce(sum(r.maps_won), 0)::numeric
                           / (coalesce(sum(r.maps_won), 0) + coalesce(sum(r.maps_lost), 0))::numeric, 4)
           END::numeric                                                       AS map_win_rate
      FROM public.team t
      JOIN public."match" m
        ON m.org_id = t.org_id AND m.team_id = t.id
      JOIN public.match_result r
        ON r.org_id = m.org_id AND r.match_id = m.id AND r.team_id = t.id
     WHERE t.org_id = v_org
       AND r.archived_at IS NULL
       AND m.status <> 'cancelled'
       AND m.archived_at IS NULL
       AND m.scheduled_at >= p_from
       AND m.scheduled_at <  p_to
     GROUP BY t.id, t.name
  ),
  ranked AS (
    SELECT res.*,
           (row_number() OVER (
             ORDER BY COALESCE(res.map_win_rate, -1) DESC, res.matches_won DESC, res.id ASC
           ))::integer AS rank_position,
           (count(*) OVER ())::integer AS rows_matched
      FROM results res
  )
  SELECT rk.id, rk.name, rk.rank_position, rk.matches_won, rk.matches_lost,
         rk.maps_won, rk.maps_lost, rk.map_win_rate, rk.rows_matched,
         -- ON EVERY ROW, not on the last: a caller reading page one would
         -- otherwise never see that the set was capped. A capped set presented as
         -- a ranking looks authoritative, which is worse than a refusal (rule 6).
         (COALESCE(p_limit, rk.rows_matched) < rk.rows_matched) AS is_truncated
    FROM ranked rk
   WHERE p_limit IS NULL OR rk.rank_position <= p_limit
   ORDER BY rk.rank_position;
END
$fn$;

COMMENT ON FUNCTION public.analytics_top_teams(timestamptz, timestamptz, integer) IS
  'Teams ordered by map win rate, then matches won, then team id — a total ordering, because ADR-0019 records that no legacy leaderboard sort had a tie-breaker. Takes NO organisation argument (ADR-0011 rule 3). Window is on match.scheduled_at, never created_at (rule 5). Every row carries rows_matched and is_truncated, so a capped set can never be mistaken for a complete ranking; a cap below one is refused. A team with no maps played has a NULL rate and sorts LAST, not first.';

-- =============================================================================
-- PRIVILEGES
-- =============================================================================
--
-- Read-only, and both functions are granted to the role that already reads the
-- underlying tenant tables. No table is created, so no grant on a table is needed
-- and none is made: an analytics migration that quietly added a writable table
-- would be a different migration wearing this one's name.
GRANT USAGE ON SCHEMA public TO raptor_app;
GRANT EXECUTE ON FUNCTION public.analytics_metric_summary(timestamptz, timestamptz) TO raptor_app;
GRANT EXECUTE ON FUNCTION public.analytics_top_teams(timestamptz, timestamptz, integer) TO raptor_app;

COMMIT;

-- ==========================================================================
-- SOURCE: packages/db/migrations/0013_security_review.sql
-- ==========================================================================

-- =============================================================================
-- 0013_security_review.sql
--
-- Four defects found by red-team review, all REPRODUCED first and only then fixed.
-- `scripts/security-review-repro.ts` runs each one against a real PGlite instance
-- built from the migration files, and `src/security_review.isolation.test.ts`
-- carries the same checks as named assertions. An applied migration is never
-- edited, so the corrections live here.
--
--   CRITICAL-1  role_permission, role_scope_rule and role_assignment named a role
--               with a SINGLE-COLUMN foreign key on `role(id)`. The row's own
--               `org_id` was not part of the reference, so an organisation could
--               grant one of its people a role that belongs to a DIFFERENT
--               organisation. ADR-0011 claims this "cannot be expressed". It could.
--   CRITICAL-2  `organization` had NO row-level security at all, while 0001 granted
--               `raptor_app` SELECT, INSERT, UPDATE and DELETE on it. Any tenant
--               could read every other tenant's row and UPDATE its status.
--   HIGH-2      `audit_log` and `outbox_event` used `USING (org_id IS NULL OR
--               org_id = current_org_id())`. The IS NULL branch exists so a system
--               actor can write platform-level rows, but nothing distinguished a
--               SYSTEM write from a TENANT write — so with no tenant set at all,
--               `raptor_app` read every NULL-org row, and a tenant could forge
--               NULL-org rows that every other tenant then read.
--   MEDIUM-1    Three SECURITY DEFINER functions in 0011 were executable by PUBLIC
--               because the `REVOKE ... FROM PUBLIC` every other migration in this
--               schema carries was missed. One of them,
--               `portability_person_closure(uuid)`, took a CALLER-CHOSEN
--               organisation, so it handed any tenant's person roster to the
--               anonymous `raptor_public` role.
--
-- WHAT IS DELIBERATELY NOT HERE
-- -----------------------------
-- No `IS NULL` branch and no `OR true` appears in any policy this file creates.
-- Those two shapes ARE the defect: a predicate that cannot be false. Where a
-- genuinely different actor needs a genuinely different scope, this file gives
-- that actor its own ROLE and its own policy, so the widened scope is reachable
-- only by the role that is supposed to have it.
--
-- ORDERING NOTE
-- -------------
-- `provision_organization` is created after the `organization` policy and before
-- the grants are asserted, because it is the only way a tenant comes into
-- existence and it has to satisfy that policy the same way any other insert does.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- CRITICAL-1 — THE THREE ROLE REFERENCES BECOME COMPOSITE
--
-- `role` already carries `CONSTRAINT role_org_id_id_key UNIQUE (org_id, id)`
-- (0001), so the composite target exists and nothing needs to be invented. The
-- only change is that `org_id` joins the reference.
--
-- `ON DELETE` behaviour is preserved EXACTLY, because it is load-bearing and
-- different in each direction:
--   role_permission    CASCADE  — deleting a role deletes what it may do.
--   role_scope_rule    CASCADE  — deleting a role deletes how far it reaches.
--   role_assignment    RESTRICT — deleting a role is refused while somebody holds
--                              it, because a silently deleted grant is an
--                              authority nobody decided to remove.
--
-- FAIL LOUDLY, DO NOT REPAIR. `ADD CONSTRAINT ... FOREIGN KEY` validates the
-- existing rows and refuses if any of them is cross-tenant. An installation that
-- already holds a cross-tenant grant must find out, here, rather than discover it
-- later in a support ticket. The count below only turns "violates foreign key
-- constraint" into a message that names the table.
-- -----------------------------------------------------------------------------

DO $fix$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad FROM public.role_assignment ra
    JOIN public.role r ON r.id = ra.role_id
   WHERE r.org_id <> ra.org_id;
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'refusing to apply 0013: % role_assignment row(s) name a role owned by another organisation. This is the defect this migration closes, so it is reported rather than quietly deleted — reconcile them, then re-run.',
      v_bad
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END
$fix$;

ALTER TABLE public.role_permission   DROP CONSTRAINT role_permission_role_id_fkey;
ALTER TABLE public.role_scope_rule   DROP CONSTRAINT role_scope_rule_role_id_fkey;
ALTER TABLE public.role_assignment   DROP CONSTRAINT role_assignment_role_id_fkey;

ALTER TABLE public.role_permission
  ADD CONSTRAINT role_permission_role_org_id_fkey
  FOREIGN KEY (org_id, role_id) REFERENCES public.role (org_id, id) ON DELETE CASCADE;

ALTER TABLE public.role_scope_rule
  ADD CONSTRAINT role_scope_rule_role_org_id_fkey
  FOREIGN KEY (org_id, role_id) REFERENCES public.role (org_id, id) ON DELETE CASCADE;

ALTER TABLE public.role_assignment
  ADD CONSTRAINT role_assignment_role_org_id_fkey
  FOREIGN KEY (org_id, role_id) REFERENCES public.role (org_id, id) ON DELETE RESTRICT;

COMMENT ON CONSTRAINT role_assignment_role_org_id_fkey ON public.role_assignment IS
  'Composite on purpose (0013). The single-column `role(id)` reference this replaced let an organisation grant its own people a role owned by another organisation, which is the cross-tenant escalation the whole tenancy spine exists to prevent. ADR-0011 claimed that reference was inexpressible; it was not, and this constraint is what makes the claim true.';

COMMENT ON CONSTRAINT role_permission_role_org_id_fkey ON public.role_permission IS
  'Composite on purpose (0013). The single-column `role(id)` reference this replaced let one organisation attach its permissions to another organisation''s role.';

COMMENT ON CONSTRAINT role_scope_rule_role_org_id_fkey ON public.role_scope_rule IS
  'Composite on purpose (0013). The single-column `role(id)` reference this replaced let one organisation set how far another organisation''s role reaches.';

-- -----------------------------------------------------------------------------
-- CRITICAL-2 — `organization` GETS ROW LEVEL SECURITY
--
-- `organization.id` IS the tenant id, so the policy is the same one every other
-- tenant table carries, written against the column that happens to hold the
-- tenant:
--
--     USING (id = current_org_id()) WITH CHECK (id = current_org_id())
--
-- FORCE as well as ENABLE, for the reason 0001 gives: without FORCE the table
-- owner is not subject to the policy, and "RLS is useless to a role that can
-- simply switch it off" (0001) applies to the owner too.
--
-- WHY THIS DOES NOT BREAK THE 83 FOREIGN KEYS THAT POINT AT THIS TABLE
-- -------------------------------------------------------------------
-- Empirically checked, not assumed, because "FORCE RLS on the tenant root must not
-- break every tenant table" is exactly the kind of claim that is safe to be
-- wrong about. PostgreSQL evaluates a referential-integrity check in a
-- SECURITY RESTRICTED OPERATION: the check runs with the privileges of the
-- REFERENCING TABLE'S OWNER, as a security-restricted operation rather than as
-- the user who issued the INSERT. RLS is therefore not applied to the RI query.
--
-- Verified under BOTH owners this repository can have — the superuser migration
-- role ADR-0015's topology table describes, and a NOSUPERUSER NOBYPASSRLS owner,
-- which is what ADR-0006 describes for production. In both, an `raptor_app` row
-- whose `org_id` matches its own tenant still satisfies
-- `FOREIGN KEY (org_id) REFERENCES organization(id)` with no tenant context set at
-- all. The consequence is the desirable one: the FK keeps proving that the parent
-- organisation EXISTS while RLS keeps proving the caller may not READ it. Those
-- are different questions and they now have different mechanisms.
--
-- A bonus that falls out of the same fact: `organization`'s RLS no longer hides
-- an organisation's existence from the database engine, so a cross-tenant
-- reference still fails on the constraint rather than on the policy. The
-- constraint is the sharper error and it is the one that survives.
--
-- ONE DEPENDENCY THIS CHANGE CREATES, MEASURED RATHER THAN ASSUMED
-- -----------------------------------------------------------------
-- `public_site_org` is a plain VIEW over `organization`, and `public_site_content`
-- joins it. A view is queried with the privileges of its OWNER, so RLS on
-- `organization` now applies as the view owner rather than as `raptor_public`.
-- The public site addresses an organisation by SLUG with no tenant in the
-- session, so it can only read the tenant root if the view owner is not subject
-- to the policy.
--
-- Measured on this schema, both ways:
--
--   schema owner is SUPERUSER (this repository's local and CI topology,
--     ADR-0015's "Owner role" row)          -> public_site_content returns the row
--   schema owner is NOSUPERUSER NOBYPASSRLS
--     (ADR-0006's production shape)          -> public_site_content returns 0 rows
--
-- So under FORCE RLS the public site's ability to read the tenant root depends on
-- the migration role being exempt from RLS. That is a REAL dependency and it is
-- stated here rather than left to be discovered: if production's migration role is
-- ever a plain NOSUPERUSER, the public site goes dark. It does not affect any
-- test here, because this repository's owner IS a superuser, and
-- `commercial.isolation.test.ts` publishes content and reads it back as
-- `raptor_public` on every run, so a regression in THIS topology would fail.
--
-- Two ways out, both of which change 0009's deliberate public-site boundary and
-- so are not taken inside a security fix:
--   * a column-level `GRANT SELECT (id, slug, display_name, status) ON
--     organization TO raptor_public` plus a `status = 'active'` policy and
--     `public_site_org` rebuilt as a `security_invoker` view. The narrowing moves
--     from a view to a column grant; RLS stays a row-level mechanism.
--   * a dedicated role holding BYPASSRLS. Rejected: 0001's own rule is that RLS
--     is useless to a role that can simply switch it off, and a permanent
--     BYPASSRLS role is exactly that.
--
-- The first is the right answer and belongs with whoever owns the production
-- migration role, not with this migration.
-- -----------------------------------------------------------------------------

ALTER TABLE public.organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization FORCE  ROW LEVEL SECURITY;

CREATE POLICY organization_tenant_isolation ON public.organization
  USING      (id = current_org_id())
  WITH CHECK (id = current_org_id());

COMMENT ON POLICY organization_tenant_isolation ON public.organization IS
  'The tenant predicate and nothing else (0013). `organization.id` IS the tenant id, so the same rule every other tenant table carries applies with `id` in place of `org_id`. No IS NULL branch: an unset context reads zero organisations, which is the fail-closed direction.';

-- -----------------------------------------------------------------------------
-- ONBOARDING — A NEW ORGANISATION, DELIBERATELY
--
-- THE PROBLEM. `WITH CHECK (id = current_org_id())` refuses every row that is not
-- the session's own tenant, and a brand-new organisation has no session yet: its
-- id does not exist anywhere. So the policy above makes provisioning impossible —
-- if the only way in is an INSERT.
--
-- WHAT WAS NOT DONE. The two shortcuts that make this "work" are the exact shape
-- of the defect this migration exists to close:
--
--     USING (id = current_org_id() OR current_org_id() IS NULL)
--     USING (id IS NULL OR true)
--
-- The first is a hole every tenant walks through by forgetting a setting; the
-- second is not a policy. Neither is written here.
--
-- WHAT WAS CHOSEN, AND WHY. A narrow SECURITY DEFINER provisioning function.
--
-- The alternative on the table was to restrict creation to the platform/migrator
-- role and remove `raptor_app`'s INSERT. That is simpler and it is genuinely
-- defensible — but it is a product decision taken inside a security fix, and it
-- silently removes a capability the application has today. `raptor_app` can
-- currently create an organisation, and three separate AFTER INSERT triggers
-- (`on_organization_created`, `..._commercial`, `..._operations`) exist purely so
-- that an organisation is never born without its state machines. Taking INSERT
-- away would leave that machinery unreachable from the application with no
-- replacement. A function keeps the capability, narrows the authority to one named
-- operation, and is auditable.
--
-- HOW IT SATISFIES THE POLICY INSTE OF BYPASSING IT. This is the part worth being
-- precise about. The function does NOT run as a role that ignores RLS. It sets
-- the session tenant to the organisation it is about to create, and then performs
-- an ordinary INSERT that satisfies the ordinary policy:
--
--     set_config('app.org_id', <new id>)
--     INSERT INTO organization (id, ...) VALUES (<new id>, ...)
--     -> WITH CHECK (id = current_org_id()) holds
--
-- So `organization` is created INSIDE its own policy rather than outside it. That
-- is what makes this safe under a NOSUPERUSER NOBYPASSRLS owner, where the owner
-- is itself subject to FORCE RLS and would be refused by its own policy — it was
-- verified under exactly that owner, not only under the superuser.
--
-- It also makes the seeding triggers correct under a non-superuser owner for the
-- first time: those triggers are SECURITY DEFINER and INSERT into tenant tables
-- whose policies require `org_id = current_org_id()`. Before this change they
-- depended on the owner bypassing RLS; now the context is already right.
--
-- The caller's context is restored in both the success and the failure path, and
-- the whole body is written against a pinned empty `search_path` with every name
-- schema-qualified, so nothing here resolves through a caller's search_path.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.provision_organization(
  p_slug             text,
  p_display_name     text,
  p_default_currency text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_id       uuid := gen_random_uuid();
  v_previous text;
BEGIN
  v_previous := current_setting('app.org_id', true);

  BEGIN
    -- The organisation being created becomes the tenant context for the INSERT
    -- below, so the row satisfies organization_tenant_isolation exactly as a
    -- later write by that organisation's own session would.
    PERFORM set_config('app.org_id', v_id::text, false);

    INSERT INTO public.organization (id, slug, display_name, default_currency)
    VALUES (v_id, p_slug, p_display_name, p_default_currency);
  EXCEPTION WHEN OTHERS THEN
    -- Restore before re-raising. A provisioning failure that left the session
    -- pointing at an organisation that does not exist would turn a duplicate slug
    -- into a confusing failure for every request that followed.
    PERFORM set_config('app.org_id', coalesce(v_previous, ''), false);
    RAISE;
  END;

  PERFORM set_config('app.org_id', coalesce(v_previous, ''), false);
  RETURN v_id;
END
$fn$;

COMMENT ON FUNCTION public.provision_organization(text, text, text) IS
  'The ONLY way a new organisation is created (0013). `organization` carries a strict tenant policy from this migration, and a new tenant has no session yet, so onboarding goes through this function. It sets the session tenant to the organisation it is creating and performs an ordinary INSERT, so the row satisfies that policy rather than escaping it; the caller''s context is restored on both the success and the failure path. SECURITY DEFINER with an empty search_path and every name schema-qualified. Takes no organisation id — the row''s own id is generated here, so a caller cannot name a tenant.';

-- Creation and destruction of the tenant root are provisioning operations, not
-- request-handler operations. UPDATE stays: an organisation setting its own
-- display name, or moving itself from `provisioning` to `active`, is a tenant
-- acting on its own row, which is exactly what the policy permits.
REVOKE INSERT, DELETE ON public.organization FROM raptor_app;

REVOKE ALL ON FUNCTION public.provision_organization(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provision_organization(text, text, text) TO raptor_app;

-- -----------------------------------------------------------------------------
-- HIGH-2 — PLATFORM-LEVEL ROWS GET THEIR OWN ROLE
--
-- `audit_log` and `outbox_event` carry a NULLABLE `org_id` because a system actor
-- writes rows that belong to no tenant: "the relay started", "the schema was
-- migrated", "the import refused a document". 0001 handled that by writing
-- `org_id IS NULL OR org_id = current_org_id()` into a policy that EVERY role was
-- subject to, which made the null branch reachable by every tenant.
--
-- The defect is not the branch. The branch is legitimate. The defect is that
-- nothing decided WHO it was for. Two policies, and the role does the deciding:
--
--   audit_log_tenant_isolation      unqualified, so it applies to every role that
--                                    is not named by a policy of its own. For
--                                    `raptor_app` this is the whole answer:
--                                    `org_id = current_org_id()`, and NULL-org
--                                    rows are invisible because `org_id = NULL`
--                                    is not true.
--
--   audit_log_system_scope          `TO raptor_system`. A role matching several
--                                    PERMISSIVE policies gets their UNION, so
--                                    `raptor_system` receives the IS NULL branch
--                                    while every other role does not. Widening the
--                                    system scope therefore cannot widen anybody
--                                    else's, which is what an `OR` in a single
--                                    shared predicate could never guarantee.
--
-- `raptor_system` is NOLOGIN and has no tenant: it is granted to, never assumed
-- by a request handler. It is NOT superuser and does NOT bypass RLS — the point
-- is that a system write is a DIFFERENT SCOPE, not a higher privilege.
-- -----------------------------------------------------------------------------

DO $sys$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raptor_system') THEN
    CREATE ROLE raptor_system NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$sys$;

-- Portable like ensure_raptor_app_hardened(): enforce where the owner is a superuser,
-- verify otherwise (see ensure_role_hardened(text) in 0001_tenancy.sql). A managed
-- database refuses ALTER ROLE against another role's elevation attributes.
SELECT ensure_role_hardened('raptor_system');

-- ENVIRONMENT TRAP, RECORDED SO THE NEXT MIGRATION DOES NOT RE-DISCOVER IT.
-- `ALTER TABLE ... DROP POLICY` is a PARSE-LEVEL FAILURE in this PGlite build
-- (PostgreSQL 18.3 / PGlite 0.5.8): it reports `syntax error at or near "<name>"`,
-- and even with IF EXISTS reports `syntax error at or near "IF"`. The same build
-- parses `ALTER TABLE ... DROP CONSTRAINT` perfectly well and then fails it
-- semantically, so this is a grammar gap specific to DROP POLICY rather than a
-- general problem with ALTER TABLE. Routing the identical statement through
-- `EXECUTE` inside a DO block works, and is checked against `pg_policies`
-- afterwards in the test suite rather than trusted.
DO $drop_policy$
BEGIN
  EXECUTE 'DROP POLICY audit_log_tenant_isolation ON public.audit_log';
  EXECUTE 'DROP POLICY outbox_event_tenant_isolation ON public.outbox_event';
END
$drop_policy$;

CREATE POLICY audit_log_tenant_isolation ON public.audit_log
  USING      (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());
CREATE POLICY audit_log_system_scope ON public.audit_log
  FOR ALL TO raptor_system
  USING      (org_id IS NULL OR org_id = current_org_id())
  WITH CHECK (org_id IS NULL OR org_id = current_org_id());

CREATE POLICY outbox_event_tenant_isolation ON public.outbox_event
  USING      (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());
CREATE POLICY outbox_event_system_scope ON public.outbox_event
  FOR ALL TO raptor_system
  USING      (org_id IS NULL OR org_id = current_org_id())
  WITH CHECK (org_id IS NULL OR org_id = current_org_id());

COMMENT ON POLICY audit_log_system_scope ON public.audit_log IS
  'The IS NULL branch, scoped to the one role that is supposed to have it (0013). Platform-level audit rows belong to the installation rather than to a tenant, and the outbox relay reads across tenants to publish. Before this migration that branch sat in the single policy every role shared, so a tenant could both read and forge rows with no organisation set — and every other tenant could read what it forged.';

COMMENT ON POLICY outbox_event_system_scope ON public.outbox_event IS
  'The IS NULL branch, scoped to `raptor_system` (0013). A tenant writes its own events and sees only its own; the relay reads across tenants and writes platform-level rows. The two roles get different scopes from different policies rather than one scope from a shared OR.';

-- The system role's authority is exactly: append to the audit log, and publish
-- (which means read, write, and mark delivered). No UPDATE and no DELETE on the
-- audit log — it is evidence, for everybody including the relay.
GRANT SELECT, INSERT ON public.audit_log   TO raptor_system;
GRANT SELECT, INSERT, UPDATE ON public.outbox_event TO raptor_system;

-- -----------------------------------------------------------------------------
-- MEDIUM-1 — NO SECURITY DEFINER FUNCTION IS EXECUTABLE BY PUBLIC
--
-- PostgreSQL grants EXECUTE on every new function to PUBLIC by default. 0002,
-- 0003, 0004, 0005, 0006, 0007, 0008, 0009 and 0010 each carry a `REVOKE ALL ON
-- FUNCTION ... FROM PUBLIC` for every SECURITY DEFINER function they create.
-- 0011 granted EXECUTE to `raptor_app` for its seven functions and revoked from
-- PUBLIC for none of them, which left the elevation on the default grant.
--
-- `portability_person_closure` was the worst of the three because of its SHAPE,
-- not its grant: it took `p_org_id uuid` from the caller and walked every
-- `*_person_id` column of every tenant table for that organisation. With the
-- default PUBLIC grant, the anonymous `raptor_public` role could name any
-- tenant and read its person roster out of a SECURITY DEFINER function that no
-- policy was standing in front of.
--
-- THE FIX IS THE SHAPE. The parameter is REMOVED. The function now takes no
-- argument and derives the tenant from the session by calling `current_org_id()`,
-- which is precisely the shape 0011 argues for one paragraph above its own
-- `portability_export_document`: "The export takes NO organisation argument...
-- A caller cannot ask for another organisation's data because there is no
-- parameter to ask with." The sibling function now obeys the rule its own file
-- states. An unset context RAISES rather than returning an empty array, because
-- "this organisation has no people" and "we cannot tell which organisation you
-- are" are different answers.
--
-- `portability_export_document` is reissued because its body called the old
-- signature. It is otherwise byte-identical to 0011; only the call changes.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.portability_person_closure()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  c        record;
  v_sql    text;
  v_org    uuid;
  v_here   uuid[];
  v_people uuid[] := ARRAY[]::uuid[];
BEGIN
  v_org := public.current_org_id();

  -- FAILS CLOSED, the same way the export does. An empty array is
  -- indistinguishable from an organisation with no people, and handing that to a
  -- caller who cannot name their own tenant is how a refusal looks like a result.
  IF v_org IS NULL THEN
    RAISE EXCEPTION
      'no tenant is set in this session, so there is no person closure to compute. Refusing rather than returning an empty array: "this organisation has no people" and "we cannot tell which organisation you are" are different answers.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Built from the catalogue: every uuid column of every tenant table whose name
  -- ENDS IN `person_id` — person_id, guardian_person_id, recorded_by_person_id,
  -- verified_by_person_id, granted_by_person_id and the rest.
  --
  -- The pattern ends at `person_id` and does not begin with an underscore. An
  -- earlier draft wrote `'%\_person\_id'`, which requires a literal underscore
  -- BEFORE `person` — so it matched `guardian_person_id` and every other
  -- `*_person_id` column, and silently missed `person_id` itself. The export
  -- then contained no people at all, which is the failure mode this function
  -- exists to prevent, introduced by the function meant to prevent it. The
  -- membership column is the one that matters most, and it is the one that was
  -- skipped.
  FOR c IN
    SELECT cl.relname AS table_name, a.attname AS column_name
      FROM pg_catalog.pg_class cl
      JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_catalog.pg_attribute a
        ON a.attrelid = cl.oid
       AND a.atttypid = 'uuid'::regtype
       AND a.attname LIKE '%person\_id'
      WHERE n.nspname = 'public'
        AND cl.relkind = 'r'
        AND cl.relname IN (
              SELECT k.table_name FROM public.portability_export_contract() k WHERE k.scope = 'tenant'
            )
      ORDER BY cl.relname, a.attname
  LOOP
    EXECUTE format(
      'SELECT coalesce(array_agg(DISTINCT (%I)::uuid), ARRAY[]::uuid[]) FROM public.%I WHERE org_id = $1 AND %I IS NOT NULL',
      c.column_name, c.table_name, c.column_name
    ) INTO v_here USING v_org;

    -- UNION each table's people onto the accumulator. Assigning `v_people :=
    -- v_people` here instead would keep only the LAST table's answer, and the
    -- export would contain the people named by `team_staff` and nobody else —
    -- a leak-shaped bug wearing the costume of a tidy loop.
    v_people := v_people || v_here;
  END LOOP;

  RETURN (SELECT coalesce(array_agg(DISTINCT p), ARRAY[]::uuid[]) FROM unnest(v_people) AS p);
END
$fn$;

COMMENT ON FUNCTION public.portability_person_closure() IS
  'The people THIS SESSION''S organisation owns rows that reference, as a uuid[]. Takes no argument (0013): the single-column `p_org_id` it used to take let the caller choose the tenant, and with the default PUBLIC grant on a SECURITY DEFINER function the anonymous `raptor_public` role could name any organisation and read its roster. The tenant now comes from current_org_id(), the same rule portability_export_document already followed, and an unset context raises rather than returning an empty array.';

-- Reissued only because its body called the old one-argument signature. Every
-- other line, every comment and every property is 0011's; the single change is
-- `portability_person_closure(v_org)` -> `portability_person_closure()`.
CREATE OR REPLACE FUNCTION public.portability_export_document()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
SET TimeZone = 'UTC'
AS $fn$
DECLARE
  v_org      uuid;
  v_people   uuid[];
  c          record;
  v_cols     text;
  v_order    text;
  v_rows     jsonb;
  v_tables   jsonb := '{}'::jsonb;
  v_migrated integer;
  v_last     text;
BEGIN
  v_org := public.current_org_id();

  -- FAILS CLOSED. An empty document is indistinguishable from an organisation
  -- with no data, and a caller who cannot name the tenant must not be handed one.
  IF v_org IS NULL THEN
    RAISE EXCEPTION
      'no tenant is set in this session, so there is no organisation to export. Refusing rather than returning an empty document: "this organisation has no data" and "we could not tell which organisation you are" are different answers.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_people := public.portability_person_closure();

  SELECT count(*), max(name) INTO v_migrated, v_last FROM public.schema_migration;

  FOR c IN SELECT * FROM public.portability_export_contract() ORDER BY ordinal LOOP
    v_cols  := public.portability_text_projection(c.table_name);
    v_order := (SELECT string_agg(format('__r.%I', k), ', ' ORDER BY t.ord)
                  FROM unnest(c.key_columns) WITH ORDINALITY AS t(k, ord));

    CASE c.scope
      WHEN 'tenant_root' THEN
        EXECUTE format(
          'SELECT coalesce(jsonb_agg(to_jsonb(__r) ORDER BY %s), ''[]''::jsonb) FROM (SELECT %s FROM public.%I WHERE id = $1) AS __r',
          v_order, v_cols, c.table_name
        ) INTO v_rows USING v_org;

      WHEN 'person' THEN
        EXECUTE format(
          'SELECT coalesce(jsonb_agg(to_jsonb(__r) ORDER BY %s), ''[]''::jsonb) FROM (SELECT %s FROM public.%I WHERE id = ANY($1)) AS __r',
          v_order, v_cols, c.table_name
        ) INTO v_rows USING v_people;

      WHEN 'person_profile' THEN
        EXECUTE format(
          'SELECT coalesce(jsonb_agg(to_jsonb(__r) ORDER BY %s), ''[]''::jsonb) FROM (SELECT %s FROM public.%I WHERE person_id = ANY($1)) AS __r',
          v_order, v_cols, c.table_name
        ) INTO v_rows USING v_people;

      ELSE
        EXECUTE format(
          'SELECT coalesce(jsonb_agg(to_jsonb(__r) ORDER BY %s), ''[]''::jsonb) FROM (SELECT %s FROM public.%I WHERE org_id = $1) AS __r',
          v_order, v_cols, c.table_name
        ) INTO v_rows USING v_org;
    END CASE;

    v_tables := v_tables || jsonb_build_object(c.table_name, v_rows);
  END LOOP;

  -- jsonb key order is canonical (length, then bytewise), so the serialisation of
  -- this document is a pure function of its contents. No `exported_at`: a clock
  -- in the header is the one field that would make two exports of identical data
  -- differ, and diffing is how a leak is detected.
  RETURN jsonb_build_object(
    'format',            'raptor.portability.export',
    'format_version',    1,
    'schema_migrations', v_migrated,
    'last_migration',    v_last,
    'organization_id',   v_org::text,
    'contract', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'ordinal',     k.ordinal,
               'table',       k.table_name,
               'scope',       k.scope,
               'key_columns', to_jsonb(k.key_columns),
               'writable',    k.writable
             ) ORDER BY k.ordinal), '[]'::jsonb)
        FROM public.portability_export_contract() k
    ),
    'tables', v_tables
  );
END
$fn$;

-- The one-argument shape is GONE, not merely revoked: a revoked function that
-- still exists is a footgun the next migration can re-grant, and leaving it in
-- place would keep the vulnerable signature in the catalogue where a reader
-- would assume it was safe.
DROP FUNCTION public.portability_person_closure(uuid);

-- And the REVOKEs 0011 omitted. Written out by name rather than generated over
-- pg_proc, because a generated loop cannot be reviewed and a named list can be
-- diffed against the list of SECURITY DEFINER functions.
REVOKE ALL ON FUNCTION public.portability_export_document()   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.portability_import_document(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.portability_person_closure()    FROM PUBLIC;

-- 0011 already granted all three to `raptor_app`; only the new signature needs it.
GRANT EXECUTE ON FUNCTION public.portability_person_closure() TO raptor_app;

COMMENT ON FUNCTION public.portability_export_document() IS
  'A complete, self-describing, byte-reproducible export of ONE organisation. Takes no organisation argument: the tenant comes from the session, so there is no parameter with which a caller could ask for another organisation''s data. Every value is canonical text in UTC and every row array is ordered by the contract''s key, so two exports of the same data are byte-identical and diffable. An unset tenant context raises rather than returning an empty document. SECURITY DEFINER because person is gated by membership (0001) and a tenant''s export must carry the people its own rows reference; the person set is a closure over the tenant''s own rows, so nobody else''s people can appear. 0013 revoked EXECUTE from PUBLIC, which 0011 left on the default grant.';

-- =============================================================================
-- WHAT A FUTURE MIGRATION MUST DO
-- =============================================================================
--
-- 0011 was not careless; it was the fourth migration in a row to add SECURITY
-- DEFINER functions and the first in that run not to remember the REVOKE. That is
-- not a discipline problem a comment fixes, so the rule is now enforced over the
-- whole schema by `security.conformance.test.ts`, which reflects every function
-- in `public` on every test run. A migration that adds one without revoking it
-- fails the suite.
--
-- The second rule is the same shape. `security.conformance.test.ts` reflects
-- every foreign key from every tenant-owned table, derived from `pg_attribute`
-- rather than from a hand-maintained list, and asserts the composite form. The
-- list-based version of that test missed all four authorisation tables, which is
-- why CRITICAL-1 shipped while the suite was green.

-- ==========================================================================
-- SOURCE: packages/db/migrations/0014_person_credential_link.sql
-- ==========================================================================

-- =============================================================================
-- 0014 — person_credential_link: the join between the domain identity and the
-- login identity (ADR-0018, item 1).
-- =============================================================================
--
-- THE GAP THIS CLOSES
-- -------------------
-- `packages/db` models people as person(id) + identity + org_membership(person_id).
-- `packages/auth` (Better Auth) models them as "user"(id) + "account" + "session"(userId).
-- Nothing joined them. Every authorisation decision keys on person_id; every
-- authentication decision keys on "user".id. `auth_set_active_org` could not execute:
-- it needed an active org_membership for the session's user, and there was no path
-- from a user to a person. It failed closed, which was correct but useless.
--
-- DECISION (ADR-0018): person is the identity root. Better Auth's "user" is an
-- authentication detail — a credential set by which a person proves who they are.
-- This table binds them.
--
-- WHY NO org_id, NO RLS
-- ---------------------
-- Both sides are global: person is org-independent by design (a human may work for
-- several organisations), and "user" is likewise global. An org_id here would answer
-- "which organisation does this LOGIN belong to", which is the wrong question — the
-- login belongs to the person, and membership answers the org question per org.
-- person, identity and person_profile are likewise global and RLS-less; this table
-- follows the same precedent deliberately, not by omission.
--
-- WHY NO FOREIGN KEY TO "user"
-- -----------------------------
-- "user" is owned by packages/auth and does not exist when these migrations run
-- standalone (and must not: the domain layer cannot depend on the auth provider's
-- lifecycle — that coupling is what ADR-0007 exists to avoid). A REFERENCES clause
-- to a table that may not exist would make this migration unappliable. So:
--   - person_id REFERENCES person(id) ON DELETE RESTRICT (losing a credential must
--     not delete a person; deleting a person must not orphan a credential silently).
--   - user_id is a bare uuid with UNIQUE(user_id): one credential resolves to at most
--     one person. Two "user" rows linked to one person would grant the union of their
--     reach, so the uniqueness is the load-bearing constraint.
-- Orphan user_ids (a "user" row deleted while its link survives) resolve to a person
-- with no credential — which reads as "no login", the safe direction.
--
-- PRIVILEGE
-- ---------
-- No grant to raptor_app. Linking is a privileged, audited act (ADR-0018 rule 3:
-- creating the first link for a person is an authentication.link_created event),
-- performed through the migration/owner path. `auth_set_active_org` reads this table
-- as its SECURITY DEFINER owner, so it needs no grant to function.
-- THAT IS LOAD-BEARING, NOT INCIDENTAL: if a future migration grants DML here to an
-- application role, the membership check becomes bypassable by link forgery.

CREATE TABLE IF NOT EXISTS person_credential_link (
  person_id   uuid        NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  user_id     uuid        NOT NULL,
  linked_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_credential_link_pkey PRIMARY KEY (person_id, user_id),
  CONSTRAINT person_credential_link_user_id_key UNIQUE (user_id)
);

COMMENT ON TABLE person_credential_link IS
  'Binds a domain person to a Better Auth "user" (ADR-0018). person is the identity root; "user" is a credential set. A person with no link is legitimate (invited, never issued a login) and remains rosterable and payable. A "user" with no link may not transact: membership cannot be satisfied without a person, so auth_set_active_org fails closed. Deliberately NOT exported by portability_export_contract(): a credential binding is authentication material, not business data — re-importing it elsewhere would point at user rows that do not exist there, or worse at a different human''s login. Like identity, links are re-established by re-authentication, never by transfer.';

COMMENT ON CONSTRAINT person_credential_link_user_id_key ON person_credential_link IS
  'One credential resolves to at most one person. Without this, two "user" rows linked to one person would grant the union of their reach.';

-- Self-guardianship of the constraint set: the link table must never become a
-- second identity model. A display name, an email, a credential hash or anything
-- that answers "who is this human" belongs on person/person_profile or on "user",
-- never here. Enforced by inspection, not by DDL — but stated so the next column
-- addition has to argue with this comment first.
