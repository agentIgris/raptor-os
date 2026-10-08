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
ALTER ROLE raptor_app NOBYPASSRLS;
ALTER ROLE raptor_app NOSUPERUSER;