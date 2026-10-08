-- Local development bootstrap. Idempotent; safe to re-run.
--
-- The application role is deliberately NOT a superuser and has NO BYPASSRLS.
-- A superuser connection silently bypasses every RLS policy, which is exactly the
-- failure mode that made the legacy system's tenancy appear correct while absent.
-- See ADR-0006.
--
-- CREATE DATABASE cannot run inside a DO block, so each is guarded separately and
-- executed only when missing.

SELECT 'CREATE DATABASE raptor_os'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'raptor_os')
\gexec

SELECT 'CREATE DATABASE raptor_os_test'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'raptor_os_test')
\gexec

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raptor_app') THEN
    CREATE ROLE raptor_app LOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
      PASSWORD 'raptor_local_dev_only';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raptor_migrator') THEN
    CREATE ROLE raptor_migrator LOGIN
      SUPERUSER
      PASSWORD 'raptor_local_dev_only';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE raptor_os       TO raptor_app;
GRANT CONNECT ON DATABASE raptor_os_test  TO raptor_app;