/**
 * Analytics: figures that are either reproducible or explicitly absent.
 *
 * Deliverable 6 is *"analytics"*, and the word hides the actual problem. There is
 * no shortage of numbers a dashboard can show about an esports organisation; there
 * is a shortage of numbers that survive being asked "how did you get that?".
 * ADR-0019 records what happens otherwise — `totalMatches * 0.7` rendered as
 * "Win rate", `Math.ceil(totalMatches / 5)` rendered as "Team Ranking", a
 * hardcoded `85` rendered as OCR confidence — and none of those were arithmetic
 * errors. They were *unattributed* figures, presented identically to real ones.
 *
 * Four decisions, together, make this layer different:
 *
 * 1. **A metric is a union, not a nullable number.** `available` carries its own
 *    numerator and denominator; `unavailable` carries a reason drawn from a
 *    CLOSED set. A value that cannot be explained is a value that was invented.
 * 2. **A metric derives from a MATCH.** `matchesWon` takes a SET of match ids, so
 *    a four-player squad win cannot be counted four times, and
 *    `squadVersusPlayerLines` publishes both counts so the reader can see which
 *    one they were shown.
 * 3. **Windows are on the event date and are closed.** Rule 5 of ADR-0019 is not
 *    a filter, it is a type: {@link EventInstant} cannot hold `created_at`, and an
 *    open-ended window is refused rather than defaulted.
 * 4. **A metric with no recovered rule is ABSENT, with that stated.**
 *    {@link teamRanking} is the worked example and returns nothing on purpose.
 *
 * Truncation is the database's job and is reported by the SQL, not modelled here:
 * a capped set presented as a ranking is worse than a refusal (rule 6), and the
 * refusal is `rows_matched`/`is_truncated` on every row rather than a flag on the
 * last one.
 *
 * Pure: no database, no network, no clock. Every instant is an argument, so
 * "was this in March?" is answerable for a date in the past and a test never
 * depends on the day it runs.
 */

export {
  RATIO_FACTOR,
  RATIO_SCALE,
  UNAVAILABLE_REASONS,
  available,
  count,
  indexReport,
  isUnavailableReason,
  metricValue,
  ratioOr,
  unavailableMetric,
} from "./metric.js";
export type { AvailableMetric, Metric, MetricReport, UnavailableMetric, UnavailableReason } from "./metric.js";

export {
  MATCH_OUTCOMES,
  headshotRate,
  impactRating,
  kdRatio,
  mapWinRate,
  matchesWon,
  squadVersusPlayerLines,
  teamRanking,
  totalSurvivalSeconds,
  winRate,
} from "./metrics.js";
export type { MatchOutcome, OutcomeCounts } from "./metrics.js";

export {
  assertClosedWindow,
  assertEventDate,
  eventWindow,
  isInWindow,
  utcDayBucket,
} from "./window.js";
export type { EventInstant, EventWindow } from "./window.js";
