-- packages/cms/provision.sql
--
-- Least-privilege runtime role for the Payload CMS plane.
--
-- OWNERSHIP MODEL
-- ---------------
-- Payload migrates as `postgres` (DDL only, via `payload migrate`), but the
-- running admin/API must never hold superuser: a superuser connection
-- silently bypasses every RLS policy, which is ADR-0006's exact failure mode.
-- So every table Payload manages is TRANSFERRED to `cms_app`, and both
-- `payload migrate` and the Next runtime connect as `cms_app` — owner of its
-- own tables, stranger to everything else.
--
-- SCOPE
-- -----
-- Matched by NAME PREFIX, never by bare schema: `cms_%`, `payload_%`, and
-- Payload's own versions tables (`_cms_%`). No domain table carries those
-- prefixes, so a future collection cannot silently widen this grant — but a
-- future collection that does NOT follow the prefix convention stays
-- postgres-owned and breaks at runtime until renamed. That failure is loud
-- (permission denied on first write), which is the point.
--
-- Re-run this file after every CMS migration: new tables arrive owned by
-- whoever ran the migrate.
--
-- PASSWORD
-- --------
-- Set separately, never in this file:
--   ALTER ROLE cms_app WITH LOGIN PASSWORD '<from .env.local, PAYLOAD_DATABASE_URI>';
--
-- Apply as: `postgres` (or any superuser). Never as `raptor_app` or `cms_app`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cms_app') THEN
    CREATE ROLE cms_app LOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO cms_app;

-- Whatever database this file is applied against IS the CMS database, so the
-- runtime role needs CONNECT on it. CONNECT is a cluster-level grant, resolved
-- here from the current database — identical behaviour locally and in staging.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO cms_app', current_database());
END
$$;

-- Membership + CREATE are for the MIGRATION job, not the app: `payload
-- migrate` runs as `cms_app`, and PostgreSQL requires the migrating role to
-- be a member of a role to receive table ownership, plus CREATE on the
-- schema to make new tables at all. `postgres` holding `cms_app` membership
-- grants it nothing it does not already have as the migrator identity.
GRANT cms_app TO postgres;
GRANT CREATE ON SCHEMA public TO cms_app;

-- Every CMS-managed table, present or future, as long as it keeps the prefix.
DO $$
DECLARE
  target text;
BEGIN
  FOR target IN
    SELECT quote_ident(schemaname) || '.' || quote_ident(tablename)
    FROM pg_tables
    WHERE schemaname = 'public'
      AND (
        tablename LIKE 'cms\_%' ESCAPE '\'
        OR tablename LIKE 'payload\_%' ESCAPE '\'
        OR tablename LIKE '\_cms\_%' ESCAPE '\'
      )
  LOOP
    EXECUTE 'ALTER TABLE ' || target || ' OWNER TO cms_app';
  END LOOP;
END
$$;

-- Serial sequences backing those tables.
DO $$
DECLARE
  seq text;
BEGIN
  FOR seq IN
    SELECT quote_ident(schemaname) || '.' || quote_ident(sequencename)
    FROM pg_sequences
    WHERE schemaname = 'public'
      AND (
        sequencename LIKE 'cms\_%' ESCAPE '\'
        OR sequencename LIKE 'payload\_%' ESCAPE '\'
        OR sequencename LIKE '\_cms\_%' ESCAPE '\'
      )
  LOOP
    EXECUTE 'ALTER SEQUENCE ' || seq || ' OWNER TO cms_app';
  END LOOP;
END
$$;

-- CMS enum types.
DO $$
DECLARE
  typ text;
BEGIN
  FOR typ IN
    SELECT quote_ident(n.nspname) || '.' || quote_ident(t.typname)
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname LIKE 'enum\_cms\_%' ESCAPE '\'
  LOOP
    EXECUTE 'ALTER TYPE ' || typ || ' OWNER TO cms_app';
  END LOOP;
END
$$;
