-- =============================================================================
-- packages/db/migrations/0012_analytics.sql
--
-- ANALYTICS: read-only aggregates that are either reproducible or explicitly
-- absent.
--
-- THE PROBLEM THIS FILE EXISTS TO SOLVE
-- ------------------------------------
-- There is no shortage of numbers a dashboard can show about an esports
-- organisation. There is a shortage of numbers that survive being asked "how did
-- you get that?". ADR-0019 records what the alternative looks like, and none of
-- it was arithmetic:
--
--     "Win rate"      <- totalMatches * 0.7
--     "Team Ranking"  <- Math.ceil(totalMatches / 5)
--     OCR confidence  <- a hardcoded 85
--     bestDay         <- days.sort(...) with the return value DISCARDED, then
--                        days[0] read from a still-ascending array
--
-- Every one of those is a plausible-looking number attached to no derivation.
-- The five rules below are the whole of the response, and each one is mechanical
-- rather than aspirational.
--
-- 1. A METRIC IS A UNION, NOT A NULLABLE NUMBER
--    `analytics_metric_status` has two members and every metric carries one. A
--    metric that cannot be computed carries an `unavailable_reason` drawn from
--    a CLOSED enum, so "why is this missing?" has an answer for every figure and
--    an answer that is not in the vocabulary is impossible to state. This is the
--    type-level form of "never fabricate": there is no `value` column to fall
--    back to, so no caller can write `COALESCE(value, 0)` and get away with it.
--
-- 2. A METRIC DERIVES FROM A MATCH
--    `matches_won` counts DISTINCT `match.id`. The legacy system counted
--    player-rows, so one team win by a four-player squad reported FOUR wins
--    (`/api/public/stats/route.ts:26-28`). `player_lines_in_won_matches` is
--    reported ALONGSIDE it rather than instead of it: publishing the pair is what
--    lets a reader see which number they were shown.
--
-- 3. WINDOWS FILTER ON THE EVENT DATE
--    `match.scheduled_at`, never `created_at`. A season imported last Tuesday
--    belongs to the months it was played in. `scheduled_at` specifically rather
--    than `completed_at`, because it is the one instant on `match` that is NOT
--    NULL for every match — a `completed_at` window would silently drop every
--    match whose completion was never recorded.
--
-- 4. TRUNCATION IS REPORTED, NEVER PERFORMED SILENTLY
--    Every row of `analytics_top_teams` carries `rows_matched` and
--    `is_truncated`, on EVERY row rather than the last, and a cap below one is
--    refused rather than returning an empty set that renders as "no teams". A
--    capped set presented as a ranking looks authoritative, which is worse than a
--    refusal because the reader has no way to tell.
--
-- AND THE FIGURE THAT IS DELIBERATELY NOT PRODUCED
-- ---------------------------------------------------
-- `team_ranking` is returned as `unavailable` with reason `no_rule_recovered`,
-- every time, for every window. The legacy system's "Team Ranking" was
-- `Math.ceil(totalMatches / 5)` — a constant divided into a match count, with no
-- relationship to performance — and ADR-0019 records that there is no other
-- ranking formula anywhere in the source to recover. Any number here would be an
-- invention wearing a leaderboard's clothes.
--
-- It is emitted as a ROW rather than simply omitted, because "this metric does
-- not exist and here is why" is a report a product owner can act on, and a blank
-- space in a JSON response is a gap nobody notices until a customer asks.
-- `analytics.isolation.test.ts` asserts the row exists, that it is permanently
-- unavailable, and that `packages/core/src/analytics/metrics.ts` says the same
-- thing in the same words — read as source text, so the domain and the schema
-- cannot drift apart silently the way `operations.isolation.test.ts` does for the
-- task transition table.
--
-- TENANCY
-- -------
-- No table is added, so there is no `org_id` to declare. Every function takes NO
-- organisation argument: the tenant is read from the session by
-- `current_org_id()`, exactly as every RLS policy does (ADR-0011 rule 3), so a
-- caller cannot choose which tenant they read. With the context unset, the
-- tenant is NULL, the predicate matches no row, and every aggregate answers with
-- `no_events_in_window` rather than with somebody else's figures.
--
-- The functions are SECURITY INVOKER, not SECURITY DEFINER. They read only
-- tenant tables whose RLS policies already carry the same predicate, so the
-- function adds no authority the caller did not already have — and a
-- SECURITY DEFINER aggregate over RLS-protected tables is the shape of bug where
-- one forgotten predicate leaks a whole customer.
--
-- ENVIRONMENT FACTS THIS FILE IS WRITTEN AROUND, both recorded elsewhere and
-- neither rediscovered here: `btree_gist` is unavailable and `EXCLUDE USING gist`
-- over uuid fails, and `digest()`/pgcrypto is absent from this PGlite build so
-- the built-in `sha256(bytea)` is used instead. Neither is needed here.
-- =============================================================================

BEGIN;

-- =============================================================================
-- THE VOCABULARY
-- =============================================================================

-- TWO members, and there is deliberately no third. A `metric_status` of
-- 'unknown' would be where every fabricated figure would go to hide: it reads
-- as "we could not tell", which is indistinguishable from "there was nothing to
-- tell", which is a real answer that would then be lost.
CREATE TYPE public.analytics_metric_status AS ENUM ('available', 'unavailable');

-- The CLOSED set of reasons a metric can be unavailable. Same members, same
-- order, as `UNAVAILABLE_REASONS` in `packages/core/src/analytics/metric.ts`:
--
--   no_events_in_window  the window is genuinely empty
--   no_decided_events    events happened, none were won or lost
--   zero_denominator      the specific input the ratio needs was never recorded
--   input_not_tracked     this schema records no such input at all
--   no_rule_recovered     the inputs exist and NO FORMULA was recoverable
--
-- `no_rule_recovered` is the load-bearing one: it is how the layer says "there
-- is nothing to recover here" instead of inventing something. A reason outside
-- this enum cannot be written, so an invented one cannot be reported.
CREATE TYPE public.analytics_unavailable_reason AS ENUM (
  'no_events_in_window',
  'no_decided_events',
  'zero_denominator',
  'input_not_tracked',
  'no_rule_recovered'
);

COMMENT ON TYPE public.analytics_unavailable_reason IS
  'Why a metric could not be computed. Closed by design: an invented figure needs an invented reason, and this enum refuses to store one. Mirrors UNAVAILABLE_REASONS in packages/core/src/analytics/metric.ts, which analytics.isolation.test.ts asserts member-for-member.';

-- =============================================================================
-- THE AGGREGATES
-- =============================================================================

-- THE CORE FUNCTION.
--
-- One row per metric, always the same set of rows in the same order, so a caller
-- can render a stable report and so a test can assert a key is PRESENT rather
-- than merely that no number was returned. A summary that omits what it could
-- not compute is the defect: it looks like a complete report.
--
-- Every window is [from, to), HALF-OPEN. An event at exactly `to` belongs to the
-- next window, so a daily bucket and its neighbour cannot both claim it.
--
-- Cancelled matches are excluded from every count. A cancelled match is not an
-- event anybody played, and including it would report a fixture as a fixture.
--
-- An archived performance line is history, not a fact about the match: counting
-- it beside its replacement would double the player. An archived match result is
-- excluded for the same reason.
CREATE OR REPLACE FUNCTION public.analytics_metric_summary(
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS TABLE (
  metric_key          text,
  metric_status       public.analytics_metric_status,
  unavailable_reason  public.analytics_unavailable_reason,
  unavailable_text    text,
  numerator           bigint,
  denominator         bigint,
  value               numeric
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $fn$
DECLARE
  v_org      uuid := public.current_org_id();
  v_matches  bigint;
  v_wins     bigint := 0;
  v_losses   bigint := 0;
  v_draws    bigint := 0;
  v_maps_won bigint := 0;
  v_maps_lost bigint := 0;
  v_kills    bigint := 0;
  v_deaths   bigint := 0;
  v_hs       bigint := 0;
  v_hsa      bigint := 0;
  v_survival bigint := 0;
  v_lines    bigint := 0;
  v_win_matches  bigint := 0;
  v_win_lines    bigint := 0;
BEGIN
  -- A window with no bounds is refused rather than defaulted. "All time" and
  -- "this month" are different claims, and a report that quietly treats one as
  -- the other stops meaning anything the first time history is truncated. This is
  -- the same refusal `packages/core/src/analytics/window.ts` makes and 0007's
  -- leaderboard makes.
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'an analytics window needs both a start and an end; an open-ended window hides unbounded history'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_to <= p_from THEN
    RAISE EXCEPTION 'analytics window [% , % ) is empty', p_from, p_to
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every aggregate below is scoped to the session tenant BEFORE anything is
  -- counted, and the tenant comes from the session rather than from an argument
  -- (ADR-0011 rule 3). With the context unset, v_org IS NULL matches no row and
  -- every count is zero — which is reported as `no_events_in_window`, not as a
  -- plausible set of figures about somebody else.
  SELECT count(*)
    INTO v_matches
    FROM public."match" m
   WHERE m.org_id = v_org
     AND m.status <> 'cancelled'
     AND m.archived_at IS NULL
     AND m.scheduled_at >= p_from
     AND m.scheduled_at <  p_to;

  -- ONE RESULT ROW PER (match, team): `match_result` is UNIQUE
  -- (org_id, match_id, team_id), so joining a squad's four lines here cannot
  -- multiply it. That single constraint is what stops a four-player win being
  -- counted four times.
  SELECT
      count(DISTINCT r.match_id) FILTER (WHERE r.outcome = 'win'),
      count(DISTINCT r.match_id) FILTER (WHERE r.outcome = 'loss'),
      count(DISTINCT r.match_id) FILTER (WHERE r.outcome = 'draw'),
      coalesce(sum(r.maps_won), 0),
      coalesce(sum(r.maps_lost), 0),
      count(DISTINCT r.match_id) FILTER (WHERE r.outcome = 'win')
    INTO v_wins, v_losses, v_draws, v_maps_won, v_maps_lost, v_win_matches
    FROM public.match_result r
    JOIN public."match" m ON m.org_id = r.org_id AND m.id = r.match_id
   WHERE r.org_id = v_org
     AND r.archived_at IS NULL
     AND m.status <> 'cancelled'
     AND m.archived_at IS NULL
     AND m.scheduled_at >= p_from
     AND m.scheduled_at <  p_to;

  -- SUMMED RAW INPUTS, NEVER AVERAGED RATIOS. Averaging per-row ratios weights a
  -- one-round cameo exactly as heavily as a full match, which is how a leaderboard
  -- ends up ranking a player above the team that outranked them. The stored
  -- per-row ratios are never read here; the evidence is summed and the ratio is
  -- taken once, at the end.
  SELECT coalesce(sum(s.kills), 0),
         coalesce(sum(s.deaths), 0),
         coalesce(sum(s.headshots), 0),
         coalesce(sum(s.headshot_attempts), 0),
         coalesce(sum(s.survival_time_seconds), 0),
         count(*)
    INTO v_kills, v_deaths, v_hs, v_hsa, v_survival, v_lines
    FROM public.match_player_performance s
    JOIN public."match" m ON m.org_id = s.org_id AND m.id = s.match_id
   WHERE s.org_id = v_org
     AND s.archived_at IS NULL
     AND m.status <> 'cancelled'
     AND m.archived_at IS NULL
     AND m.scheduled_at >= p_from
     AND m.scheduled_at <  p_to;

  -- THE DOUBLE COUNT, COUNTED. Distinct MATCHES won, and distinct PLAYER LINES
  -- recorded against a won match. They differ by the squad size, and a report
  -- showing only the second is how one team win became four.
  SELECT count(DISTINCT s.match_id)
    INTO v_win_lines
    FROM public.match_player_performance s
    JOIN public."match" m ON m.org_id = s.org_id AND m.id = s.match_id
    JOIN public.match_result r
      ON r.org_id = s.org_id AND r.match_id = m.id AND r.team_id = m.team_id
   WHERE s.org_id = v_org
     AND s.archived_at IS NULL
     AND r.archived_at IS NULL
     AND m.status <> 'cancelled'
     AND m.archived_at IS NULL
     AND m.scheduled_at >= p_from
     AND m.scheduled_at <  p_to
     AND r.outcome = 'win';

  -- ---------------------------------------------------------------------------
  -- THE ROWS
  -- ---------------------------------------------------------------------------
  --
  -- Counted by hand rather than emitted by a loop, because the ORDER of this list
  -- is part of the contract and a loop over a hash-ordered set is not.

  metric_key := 'matches_played'; v_matches := v_matches;
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_matches; denominator := 1; value := v_matches::numeric;
  RETURN NEXT;

  metric_key := 'match_wins';
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_wins; denominator := 1; value := v_wins::numeric;
  RETURN NEXT;

  metric_key := 'match_losses';
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_losses; denominator := 1; value := v_losses::numeric;
  RETURN NEXT;

  metric_key := 'match_draws';
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_draws; denominator := 1; value := v_draws::numeric;
  RETURN NEXT;

  -- THE ANTI-`totalMatches * 0.7` METRIC.
  --
  -- The denominator is wins + losses, NOT wins + losses + draws. A draw is a real
  -- result with no winner, and counting it would report a team that drew its
  -- whole season as having a 0% win rate — a claim about failure where the data
  -- says something else entirely.
  metric_key := 'win_rate';
  IF (v_wins + v_losses) = 0 THEN
    metric_status := 'unavailable'; unavailable_reason := 'no_decided_events';
    unavailable_text := 'No match in this window was won or lost (' || v_draws::text
                        || ' drawn), so a win rate has no denominator. Reporting 0% would say the team lost; reporting nothing says the question does not apply.';
    numerator := NULL; denominator := NULL; value := NULL;
  ELSE
    metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
    numerator := v_wins; denominator := v_wins + v_losses;
    value := round(v_wins::numeric / (v_wins + v_losses)::numeric, 4);
  END IF;
  RETURN NEXT;

  metric_key := 'map_win_rate';
  IF (v_maps_won + v_maps_lost) = 0 THEN
    metric_status := 'unavailable'; unavailable_reason := 'no_decided_events';
    unavailable_text := 'No map in this window was won or lost, so a map win rate has no denominator.';
    numerator := NULL; denominator := NULL; value := NULL;
  ELSE
    metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
    numerator := v_maps_won; denominator := v_maps_won + v_maps_lost;
    value := round(v_maps_won::numeric / (v_maps_won + v_maps_lost)::numeric, 4);
  END IF;
  RETURN NEXT;

  metric_key := 'kd_ratio';
  IF v_deaths = 0 THEN
    -- `zero_denominator`, not `no_decided_events`: ADR-0019 records that the
    -- legacy system tracked no deaths at all, so a stored 0 and a stored
    -- "unrecorded" are indistinguishable there. This schema tracks them (0007),
    -- so a genuine zero is a real answer and an undefined ratio is a different one.
    metric_status := 'unavailable'; unavailable_reason := 'zero_denominator';
    unavailable_text := 'No death was recorded in this window, so a K/D ratio has no denominator. An undefined ratio is reported as undefined; it is not reported as zero and not reported as infinite.';
    numerator := NULL; denominator := NULL; value := NULL;
  ELSE
    metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
    numerator := v_kills; denominator := v_deaths;
    value := round(v_kills::numeric / v_deaths::numeric, 4);
  END IF;
  RETURN NEXT;

  metric_key := 'headshot_rate_pct';
  IF v_hsa = 0 THEN
    metric_status := 'unavailable'; unavailable_reason := 'no_decided_events';
    unavailable_text := 'No headshot attempt was recorded in this window, so a headshot rate has no denominator. A zero here would say the player missed every attempt, which is a different claim from nobody having tried.';
    numerator := NULL; denominator := NULL; value := NULL;
  ELSE
    metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
    -- Numerator scaled by 100 so the value reads as a PERCENTAGE while staying
    -- exactly numerator/denominator at four decimals. Rescaling the rendered
    -- number afterwards would produce the right figure by a route the metric no
    -- longer describes.
    numerator := v_hs * 100; denominator := v_hsa;
    value := round((v_hs * 100)::numeric / v_hsa::numeric, 4);
  END IF;
  RETURN NEXT;

  -- A SUM under a name that carries its unit, never a unitless average.
  -- `survival_time` was minutes on one legacy surface and seconds on another
  -- (ADR-0019, unresolvable item 3), which is why 0007 renamed the column
  -- `survival_time_seconds`. A mean would additionally divide by a "match count"
  -- whose meaning is exactly what was in doubt.
  metric_key := 'total_survival_seconds';
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_survival; denominator := 1; value := v_survival::numeric;
  RETURN NEXT;

  metric_key := 'performance_lines';
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_lines; denominator := 1; value := v_lines::numeric;
  RETURN NEXT;

  -- THE PAIR. Two rows rather than one, so a reader can see that the second is
  -- four times the first for a four-player squad — which is the whole defect
  -- ADR-0019 opens with, rendered instead of hidden.
  metric_key := 'matches_won';
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_win_matches; denominator := 1; value := v_win_matches::numeric;
  RETURN NEXT;

  metric_key := 'player_lines_in_won_matches';
  metric_status := 'available'; unavailable_reason := NULL; unavailable_text := NULL;
  numerator := v_win_lines; denominator := 1; value := v_win_lines::numeric;
  RETURN NEXT;

  -- THE FIGURE THAT IS NOT PRODUCED.
  --
  -- Always, for every window, on purpose. `Math.ceil(totalMatches / 5)` was
  -- displayed as "Team Ranking" in the legacy system and there is no other ranking
  -- formula anywhere in the source to recover (ADR-0019). Emitting the row with
  -- its reason is what turns "we did not build this" into a report somebody can
  -- read, instead of a key that is quietly missing from a JSON response.
  metric_key := 'team_ranking';
  metric_status := 'unavailable'; unavailable_reason := 'no_rule_recovered';
  unavailable_text := 'No ranking rule exists to recover. The legacy system displayed ''Math.ceil(totalMatches / 5)'' as Team Ranking — a constant divided into a match count, with no relationship to performance (ADR-0019). Any rank produced here would be an invention wearing a leaderboard''s clothes.';
  numerator := NULL; denominator := NULL; value := NULL;
  RETURN NEXT;

  metric_key := 'impact_rating';
  metric_status := 'unavailable'; unavailable_reason := 'input_not_tracked';
  unavailable_text := 'Nothing in this schema records the inputs an impact rating would be computed from. ADR-0019 searched the legacy source exhaustively and found no ADR, no ACS and no impact formula, so there is no raw input to aggregate and no formula to aggregate it with.';
  numerator := NULL; denominator := NULL; value := NULL;
  RETURN NEXT;
END
$fn$;

COMMENT ON FUNCTION public.analytics_metric_summary(timestamptz, timestamptz) IS
  'Every metric for one organisation over one event-dated window, each either available with its own numerator and denominator, or unavailable with a reason drawn from a closed enum. Takes NO organisation argument — the tenant comes from the session (ADR-0011 rule 3). Filters on match.scheduled_at, never created_at (ADR-0019 rule 5). Never fabricates: win_rate, kd_ratio and headshot_rate_pct are absent rather than zero when they have no denominator, and team_ranking is permanently absent with reason no_rule_recovered. SECURITY INVOKER, so it adds no authority the caller did not already have.';

-- =============================================================================
-- THE TEAM LEADERBOARD
-- =============================================================================
--
-- Ordered by a STATED rule, and the rule is stated in the function's comment
-- because an ordering nobody can see is not reproducible:
--
--   map win rate DESC, then matches won DESC, then team id ASC.
--
-- `team id` last, and it is a STORED IMMUTABLE value rather than a function of
-- row order — which is what makes the ranking reproducible. ADR-0019 records that
-- no legacy leaderboard sort had a tie-breaker, so two teams with identical
-- records came back in whatever order the rows happened to arrive.
--
-- COALESCE(kv, -1) puts an undefined rate last rather than first: a DESC sort
-- would otherwise rank NULL above every real number, and a team with no maps
-- played would top the table.
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
  SELECT rk.id, rk.name, rk.rank_position, rk.matches_won, rk.matches_lost,
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

COMMENT ON FUNCTION public.analytics_top_teams(timestamptz, timestamptz, integer) IS
  'Teams ordered by map win rate, then matches won, then team id — a total ordering, because ADR-0019 records that no legacy leaderboard sort had a tie-breaker. Takes NO organisation argument (ADR-0011 rule 3). Window is on match.scheduled_at, never created_at (rule 5). Every row carries rows_matched and is_truncated, so a capped set can never be mistaken for a complete ranking; a cap below one is refused. A team with no maps played has a NULL rate and sorts LAST, not first.';

-- =============================================================================
-- PRIVILEGES
-- =============================================================================
--
-- Read-only, and both functions are granted to the role that already reads the
-- underlying tenant tables. No table is created, so no grant on a table is needed
-- and none is made: an analytics migration that quietly added a writable table
-- would be a different migration wearing this one's name.
GRANT USAGE ON SCHEMA public TO raptor_app;
GRANT EXECUTE ON FUNCTION public.analytics_metric_summary(timestamptz, timestamptz) TO raptor_app;
GRANT EXECUTE ON FUNCTION public.analytics_top_teams(timestamptz, timestamptz, integer) TO raptor_app;

COMMIT;
