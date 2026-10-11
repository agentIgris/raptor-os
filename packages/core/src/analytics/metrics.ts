/**
 * The metrics ADR-0019 admits exist, and the arithmetic behind each.
 *
 * Every function here takes RAW, COUNTED INPUTS as arguments and returns a
 * {@link Metric}. Nothing is read from a database and nothing is defaulted, which
 * is what makes each one independently checkable: a caller can hand it four
 * numbers and read the derivation out of the result.
 *
 * ## The three rules these functions exist to enforce
 *
 * 1. **A metric derives from a MATCH, never from a free-floating row.**
 *    `matchOutcomeCounts` counts distinct matches, and `squadVersusPlayerLines`
 *    deliberately reports the two counts side by side. ADR-0019 opens with the
 *    legacy system counting player-rows: one team win by a four-player squad was
 *    reported as four wins. The counting is the fabrication, not the display.
 *
 * 2. **A zero denominator is an ABSENCE with a reason, never a zero.**
 *    Three draws in a row has no win rate. Returning `0.0000` there says the
 *    team won nothing, which is a different claim from "the question does not
 *    apply", and it is the claim a sponsor disputes.
 *
 * 3. **A metric whose formula was never recovered is ABSENT.**
 *    `teamRanking` is the worked example. ADR-0019 records the legacy system's
 *    "Team Ranking" as `Math.ceil(totalMatches / 5)` — a function of the match
 *    count with no relationship to performance. There is no honest version of it
 *    to recover, so the function returns `no_rule_recovered` and says so, and
 *    `packages/db`'s analytics suite asserts the database agrees.
 */

import { count, ratioOr, unavailableMetric } from "./metric.js";
import type { Metric } from "./metric.js";

/** One match's outcome, as stored on `match_result.outcome`. */
export const MATCH_OUTCOMES = ["win", "loss", "draw", "not_played"] as const;
export type MatchOutcome = (typeof MATCH_OUTCOMES)[number];

export interface OutcomeCounts {
  readonly wins: bigint;
  readonly losses: bigint;
  readonly draws: bigint;
}

/**
 * Win rate over DECIDED matches.
 *
 * Denominator is `wins + losses`, not `wins + losses + draws`. A draw is a real
 * result with no winner, and counting it in the denominator would report a team
 * that drew every match as having a 0% win rate — a claim about failure where
 * the data says something quite different.
 *
 * Refused rather than defaulted when the window is open-ended; see
 * {@link assertClosedWindow} in `./window.js`.
 */
export function winRate(counts: OutcomeCounts): Metric {
  const decided = counts.wins + counts.losses;
  return ratioOr(
    "win_rate",
    counts.wins,
    decided,
    `No match in this window was won or lost (${counts.draws} drawn), so a win rate has no denominator. Reporting 0% would say the team lost; reporting nothing says the question does not apply.`,
  );
}

/**
 * Map win rate.
 *
 * Same shape as {@link winRate} and the same reason for the denominator: a map
 * nobody played is not a map lost.
 */
export function mapWinRate(mapsWon: bigint, mapsLost: bigint): Metric {
  return ratioOr(
    "map_win_rate",
    mapsWon,
    mapsWon + mapsLost,
    "No map in this window was won or lost, so a map win rate has no denominator.",
  );
}

/**
 * K/D ratio.
 *
 * `zero_denominator` is the reason, not `no_decided_events`: ADR-0019 records
 * that the legacy system never tracked deaths at all, so a stored 10 deaths and a
 * stored 0 deaths are indistinguishable in old data. This schema tracks deaths
 * (0007), so the ratio is derivable here — and where a window genuinely contains
 * no deaths, saying "no deaths were recorded" is more useful than either a zero
 * or an infinity.
 */
export function kdRatio(kills: bigint, deaths: bigint): Metric {
  return ratioOr(
    "kd_ratio",
    kills,
    deaths,
    "No death was recorded in this window, so a K/D ratio has no denominator. An undefined ratio is reported as undefined; it is not reported as zero and not reported as infinite.",
    "zero_denominator",
  );
}

/**
 * Headshot percentage.
 *
 * Stored as the raw PAIR of attempts and hits rather than a percentage, because
 * "headshot percentage" has at least three industry definitions (0007 records
 * this). Whichever one a sponsor invokes is computable from what was recorded;
 * which one to report is a product decision and is not made here.
 *
 * The numerator is scaled by 100 so the VALUE reads as a percentage — 25 hits
 * from 100 attempts is `25.0000`, not `0.2500` — while staying exactly
 * `numerator / denominator` at four decimals, so the derivation a reader can
 * check is the derivation that was performed. Rescaling the rendered string
 * afterwards would have produced the right number by a route the metric no longer
 * describes.
 */
export function headshotRate(headshots: bigint, attempts: bigint): Metric {
  if (headshots > attempts) {
    throw new Error(
      `Headshot rate built from ${headshots} hits out of ${attempts} attempts, which describes a match that cannot have happened. Refused here rather than reported as a rate above 100%.`,
    );
  }
  return ratioOr(
    "headshot_rate_pct",
    headshots * 100n,
    attempts,
    "No headshot attempt was recorded in this window, so a headshot rate has no denominator. A zero here would say the player missed every attempt, which is a different claim from nobody having tried.",
  );
}

/**
 * Matches won, counted as MATCHES.
 *
 * The input is the set of distinct match ids, not a count, so that a four-player
 * squad cannot contribute four wins by passing four lines in. Counting is where
 * the legacy double-count happened, and it is therefore where the guard belongs.
 */
export function matchesWon(matchIds: ReadonlySet<string>): Metric {
  return count("matches_won", BigInt(matchIds.size));
}

/**
 * The double-count, made visible.
 *
 * Returns BOTH numbers rather than choosing one: how many distinct MATCHES were
 * won, and how many PLAYER LINES were recorded against a won match. When a squad
 * is four players these differ by a factor of four, and a report that showed only
 * the second would look like a great week. Publishing the pair is what lets a
 * reader see which number they are being shown.
 */
export function squadVersusPlayerLines(winningMatchIds: ReadonlySet<string>, winningPlayerLineIds: ReadonlySet<string>): {
  readonly matches: Metric;
  readonly playerLines: Metric;
} {
  return {
    matches: count("matches_won", BigInt(winningMatchIds.size)),
    playerLines: count("player_lines_in_won_matches", BigInt(winningPlayerLineIds.size)),
  };
}

/**
 * Team ranking: ABSENT, always, with the reason named.
 *
 * This is the deliverable's centrepiece and it is a function that refuses to
 * compute anything. ADR-0019 records that the legacy system's "Team Ranking" was
 * `Math.ceil(totalMatches / 5)` — a division by a constant with no relationship
 * to how the team performed, presented to users as a ranking. There is no honest
 * version of that formula to recover and no other one in the source, so the only
 * truthful output is an absence that says so.
 *
 * `performance` is accepted and IGNORED. It is here so a caller who reaches for a
 * ranking cannot do so by accident: the argument is right there, named, and doing
 * nothing with it is the point. A future implementation replaces this function
 * with a documented ordering — it does not quietly start using its argument.
 */
export function teamRanking(_performance: OutcomeCounts): Metric {
  return unavailableMetric(
    "team_ranking",
    "no_rule_recovered",
    "No ranking rule exists to recover. The legacy system displayed 'Math.ceil(totalMatches / 5)' as Team Ranking — a constant divided into a match count, with no relationship to performance (ADR-0019). Any rank produced here would be an invention wearing a leaderboard's clothes.",
  );
}

/**
 * A per-input metric the schema does not record at all.
 *
 * ADR-0019 searched the legacy source exhaustively and found no ADR, no ACS, no
 * impact rating and no headshot formula. `impact_rating` is carried here so the
 * ABSENCE is a reported fact with a key somebody can ask for, rather than a gap
 * a dashboard discovers silently by rendering nothing.
 */
export function impactRating(): Metric {
  return unavailableMetric(
    "impact_rating",
    "input_not_tracked",
    "Nothing in this schema records the inputs an impact rating would be computed from. ADR-0019 searched the legacy source exhaustively and found no ADR, no ACS and no impact formula, so there is no raw input to aggregate and no formula to aggregate it with.",
  );
}

/**
 * Total survival time.
 *
 * A SUM, deliberately, with no per-match average. ADR-0019 records `survival_time`
 * as minutes on one legacy surface and seconds on another, and a stored 10 is
 * indistinguishable from a stored 600 afterwards — which is why 0007 put the unit
 * in the column name (`survival_time_seconds`) and why this metric reports the
 * raw total under a name that carries the unit. An average would additionally have
 * to divide by a number of "matches" whose meaning is exactly what was in doubt.
 */
export function totalSurvivalSeconds(seconds: bigint): Metric {
  if (seconds < 0n) {
    throw new Error(`Total survival time is negative (${seconds} seconds); a duration cannot be negative.`);
  }
  return Object.freeze({
    key: "total_survival_seconds",
    status: "available" as const,
    numerator: seconds,
    denominator: 1n,
    value: seconds.toString(),
  });
}
