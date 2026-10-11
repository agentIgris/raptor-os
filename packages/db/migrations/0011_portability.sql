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
