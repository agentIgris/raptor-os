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
