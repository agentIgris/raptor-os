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