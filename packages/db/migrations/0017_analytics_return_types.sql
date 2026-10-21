-- packages/db/migrations/0017_analytics_return_types.sql
--
-- WHY A NEW MIGRATION AND NOT AN EDIT TO 0012
-- -------------------------------------------
-- Migrations are forward-only. 0012 landed; correcting it in place would make
-- a database that had already applied it differ from a fresh one, which is the
-- failure this ledger exists to prevent. So the function is REPLACED here, with
-- the same body and one change.
--
-- WHAT WAS WRONG
-- ---------------
-- `analytics_top_teams` is a `plpgsql` function whose signature declares
--
--     RETURNS TABLE (team_id uuid, team_name text, ...)
--
-- and whose body returns `t.name` — and `team.name` is `varchar(160)`.
--
-- A `LANGUAGE sql` function coerces its result to the declared types for you.
-- A `plpgsql` one does NOT: `RETURN QUERY` compares the shape of what the
-- query returns with the declared return types and raises
--
--     structure of query does not match function result type
--
-- AT CALL TIME, naming a column and nothing else. So the function was
-- installed cleanly, granted cleanly, and failed every time the workspace
-- asked it for a ranking: the Analytics page caught the failure and rendered
-- "Analytics unavailable", and the log said nothing about it.
--
-- The same class of defect took out `auth_active_orgs_for_token` in the
-- identity schema, where the consequence was worse: the session never got an
-- organisation bound, so every workspace page degraded. Two functions, two
-- schemas, one mistake — which is why the fix here is a cast rather than a
-- widened type: the declared type is what every caller expects, and the cast
-- says so at the one place the two meet.
--
-- THE FIX
-- -------
-- `rk.name::text`. The declared type stays `text`; the value is converted
-- where it is produced.
--
-- The same audit was run over every other function this repository ships
-- that the application calls — `analytics_metric_summary`,
-- `player_performance_leaderboard`, `auth_set_active_org` and
-- `auth_active_orgs_for_token` — and they return numeric, uuid, integer and
-- boolean columns, which need no cast. `analytics_top_teams` was the only one
-- with a text column over a varchar source.

BEGIN;

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
  -- THE CAST: `team.name` is `varchar(160)` and the declared return type is
  -- `text`. Without it, every call raises "structure of query does not match
  -- function result type".
  SELECT rk.id, rk.name::text, rk.rank_position, rk.matches_won, rk.matches_lost,
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

-- The comment and the grants survive a CREATE OR REPLACE, so they are not
-- repeated here. `COMMENT ON FUNCTION` and `GRANT EXECUTE` would be harmless
-- duplicates; the migration says what it changed and stops.

COMMIT;
