/**
 * Tier movement: win rate in, tier out.
 *
 * The thresholds are recovered from `lib/team-logic.ts:104-124` (ADR-0016 §5).
 * The single rule is strict on both ends and that strictness is the whole
 * specification:
 *
 * ```
 * winRate > 50        → promote
 * 35 <= winRate <= 50 → retain
 * winRate < 35        → demote
 * ```
 *
 * **50.0 exactly is retained.** The bands are not symmetric about any midpoint
 * and there is no rounding tolerance: `> 50` and `< 35` mean what they say.
 *
 * ## The slots clamp
 *
 * Legacy clamped `slotsWon` to `slotsPlayed` before dividing. That guard is
 * reproduced in {@link computeWinRatePercent}, and it is reproduced *before* the
 * division rather than after, because clamping afterwards would be a different
 * rule: 12 wins in 10 slots is 100%, not 120%, and only clamping first gives
 * that answer.
 *
 * ## Trial exemption
 *
 * Trial teams are exempt from tier movement entirely. A trial exists to answer
 * "would this roster work", and a team held to a promotion/demotion ladder
 * during its trial measures the ladder, not the roster. The exemption covers
 * promotion and demotion alike and is checked before the bands, so a trial team
 * at 99% is exempt and a trial team at 1% is exempt.
 *
 * `team.isTrial` is the whole of the exemption. There is deliberately no
 * "trial extension" flag with its own threshold here, because legacy had none
 * and inventing one would be inventing a rule (ADR-0016's own lesson). The
 * extension concept lives with the caller that owns trial lifecycle — it sets
 * `isTrial` — and this module only ever asks the one boolean question.
 *
 * ## An unplayed cycle demotes, and that is a consequence worth stating
 *
 * {@link computeWinRatePercent} yields `0` when nothing was played, and `0` is
 * below `35`, so a team that did not play is demoted.
 *
 * An earlier draft of this comment promised such a cycle would be retained,
 * reasoning that a team which has not played has not performed badly. That is a
 * *policy invention*, and ADR-0016's whole argument is that these thresholds
 * were read out of the source rather than designed here — adding a fourth band
 * on the strength of a good idea is exactly how a recovered rule turns back into
 * a fiction. The recovered rule is what stands: `0 < 35`, therefore `demote`.
 *
 * The tension is real and belongs to the product, not to this module. It is
 * surfaced rather than smoothed over: a caller that does not want unplayed teams
 * demoted must express that as an explicit rule of its own (an `isTrial`-style
 * exemption, or a cycle not being run), where it will be visible in the audit
 * trail, instead of it hiding inside a rate calculation.
 */

import type { Tier } from "./tiers.js";
import { demote, promote } from "./tiers.js";

/** Win rate at or above which a team is retained rather than demoted. */
export const RETENTION_FLOOR_PERCENT = 35;

/** Win rate strictly above which a team is promoted. Exactly 50 is retained. */
export const PROMOTION_THRESHOLD_PERCENT = 50;

export type TierMovementKind = "promote" | "retain" | "demote" | "exempt";

export interface ComputeTierMovementInput {
  /**
   * Win rate as a percentage in `[0, 100]`.
   *
   * Normally produced by {@link computeWinRatePercent} from the cycle's matches.
   * The caller composes the two, rather than this function accepting both a rate
   * and its slots and quietly preferring one: an input pair where one field
   * silently overrides the other is a field that will eventually be believed
   * when it should not be.
   */
  readonly winRatePercent: number;
  readonly currentTier: Tier;
  /** Trial teams are exempt from movement, both up and down. */
  readonly isTrial: boolean;
}

export interface TierMovement {
  readonly movement: TierMovementKind;
  readonly previousTier: Tier;
  /** Equals `previousTier` when the movement is `retain` or `exempt`. */
  readonly newTier: Tier;
  /** The rate the decision was made on, after clamping. */
  readonly winRatePercent: number;
  /** Why this outcome, in one line. Persisted for disputes. */
  readonly reason: string;
}

/**
 * Decide a team's tier movement for one cycle.
 *
 * Pure: no clock, no I/O. Returns the movement *and* the resulting tier, so a
 * caller cannot apply a movement kind without the clamped tier that goes with it.
 */
export function computeTierMovement(input: ComputeTierMovementInput): TierMovement {
  const { currentTier, isTrial } = input;
  const rate = validateWinRate(input.winRatePercent);

  if (isTrial) {
    return {
      movement: "exempt",
      previousTier: currentTier,
      newTier: currentTier,
      winRatePercent: rate,
      reason: "Trial team is exempt from tier movement.",
    };
  }

  if (rate > PROMOTION_THRESHOLD_PERCENT) {
    return {
      movement: "promote",
      previousTier: currentTier,
      newTier: promote(currentTier),
      winRatePercent: rate,
      reason: `Win rate ${formatRate(rate)}% is above ${PROMOTION_THRESHOLD_PERCENT}%.`,
    };
  }

  if (rate < RETENTION_FLOOR_PERCENT) {
    return {
      movement: "demote",
      previousTier: currentTier,
      newTier: demote(currentTier),
      winRatePercent: rate,
      reason: `Win rate ${formatRate(rate)}% is below ${RETENTION_FLOOR_PERCENT}%.`,
    };
  }

  return {
    movement: "retain",
    previousTier: currentTier,
    newTier: currentTier,
    winRatePercent: rate,
    reason: `Win rate ${formatRate(rate)}% is within the ${RETENTION_FLOOR_PERCENT}-${PROMOTION_THRESHOLD_PERCENT}% retention band.`,
  };
}

export interface WinRateInput {
  readonly slotsWon: number;
  readonly slotsPlayed: number;
}

/**
 * Win rate as a percentage, with `slotsWon` clamped to `slotsPlayed`.
 *
 * The clamp is the legacy behaviour and it is deliberate: a slot count that
 * exceeds the slots played is a data error, and the two defensible repairs (cap
 * at 100%, or reject) are not the same rule. Capping is what legacy did, so
 * capping is what happens, and it happens before the division.
 *
 * Zero matches played yields `0`, which {@link computeTierMovement} treats as
 * `retain`.
 */
export function computeWinRatePercent(input: WinRateInput): number {
  const { slotsWon, slotsPlayed } = input;
  assertInteger(slotsWon, "slotsWon");
  assertInteger(slotsPlayed, "slotsPlayed");

  if (slotsPlayed === 0) return 0;

  // Clamp first, divide second. A negative count is as impossible as an
  // over-count and the same clamp is the honest repair for both: a win rate
  // cannot be below 0% or above 100%. A non-integer is a different kind of
  // wrong — it means the caller passed something that is not a count — so it
  // throws rather than being silently truncated.
  const won = Math.min(Math.max(slotsWon, 0), slotsPlayed);
  return roundPercent((won / slotsPlayed) * 100);
}

function validateWinRate(winRatePercent: number): number {
  if (!Number.isFinite(winRatePercent) || winRatePercent < 0 || winRatePercent > 100) {
    throw new Error(`Invalid winRatePercent: expected a number in [0, 100], got ${String(winRatePercent)}`);
  }
  return roundPercent(winRatePercent);
}

function assertInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Invalid ${field}: expected an integer slot count, got ${String(value)}`);
  }
}

/** Two decimals, so 40% and 40.00% compare equal as numbers. */
function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatRate(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}