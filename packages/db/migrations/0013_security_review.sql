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

ALTER ROLE raptor_system NOSUPERUSER;
ALTER ROLE raptor_system NOBYPASSRLS;

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