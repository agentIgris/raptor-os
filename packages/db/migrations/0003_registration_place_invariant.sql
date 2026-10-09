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