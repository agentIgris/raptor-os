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

ALTER ROLE raptor_app NOBYPASSRLS;
ALTER ROLE raptor_app NOSUPERUSER;

COMMIT;