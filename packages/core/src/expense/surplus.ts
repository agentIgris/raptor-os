/**
 * The monthly surplus split — the one real percentage rule in the legacy system.
 *
 * Recovered from `lib/team-logic.ts:126-152`. Four properties of it are
 * deliberate and each is reproduced exactly, with its own test:
 *
 * ## 1. Every deduction is taken BEFORE the percentage is applied
 *
 * ```
 * grossSurplus = monthlyPrizePool - (monthlyCost + nextMonthTierCost)
 * orgShare     = grossSurplus * orgSharePercent
 * ```
 *
 * The order is the rule. Applying the percentage first and deducting afterwards
 * is a different split of the same pot, and it is the mistake this ordering
 * exists to prevent.
 *
 * ## 2. A tournament override above 20000 bypasses deduction entirely
 *
 * When `tournamentWinnings` is **strictly greater** than 20,000, the split
 * switches to a flat 50/50 applied to the **raw** winnings — the monthly costs are
 * not deducted at all. This is not a discount on the surplus; it is a different
 * calculation with a different base.
 *
 * The comparison is strict. Exactly 20,000 does **not** override; 20,000.0001
 * does. That boundary is pinned by a test because `> 20000` and `>= 20000`
 * differ by exactly one team in one month, and the whole cost-deduction path
 * hangs on which side of it they fall.
 *
 * ## 3. The team share is a residual, so the two shares always sum exactly
 *
 * `orgShare` is the rounded percentage; `teamShare` is computed as
 * `grossSurplus - orgShare`, never as a second percentage. The consequence is
 * that the shares sum to the gross surplus with **no drift**, even when the
 * surplus does not divide evenly at four decimal places. Rounding both halves
 * independently would leave a stray minor unit that a reconciliation could never
 * explain.
 *
 * ## 4. A non-positive surplus clamps both shares to zero but still reports it
 *
 * When a month loses money, both shares are `0` — there is nothing to divide —
 * but `grossSurplus` still carries the negative figure. Clamping the shares is
 * arithmetic; erasing the loss would be falsifying the books.
 *
 * All arithmetic is `bigint` minor units (ADR-0003) via {@link Money}.
 */

import type { Money } from "../money/index.js";
import { money, parsePercent, zero } from "../money/index.js";

/**
 * Tournament winnings must be strictly greater than this to trigger the 50/50
 * override, in minor units (20,000.0000).
 *
 * Strictly greater. Exactly 20000 takes the ordinary deducted path.
 */
export const TOURNAMENT_OVERRIDE_THRESHOLD_MINOR = 20_000n * 10_000n;

/** The override's share is a flat 50/50, ignoring the configured org share. */
const OVERRIDE_ORG_SHARE_PERCENT = 500_000n;

export interface SurplusSplitInput {
  /** The month's prize income. */
  readonly monthlyPrizePool: Money;
  /** Running costs for the month. */
  readonly monthlyCost: Money;
  /** Tier cost payable for the following month, deducted in the same month. */
  readonly nextMonthTierCost: Money;
  /** Gross winnings from a tournament, if any. Triggers the override above the threshold. */
  readonly tournamentWinnings?: Money;
  /** The organisation's share of a non-overridden surplus, as a percentage. */
  readonly orgSharePercent: string;
}

export interface SurplusSplit {
  /** The basis the shares were drawn from, after any override. */
  readonly grossSurplus: Money;
  /** `monthlyCost + nextMonthTierCost`. Reported even when overridden and unused. */
  readonly deductions: Money;
  /** The organisation's share, rounded. */
  readonly orgShare: Money;
  /** The team's share, a residual so the two sum exactly to `grossSurplus`. */
  readonly teamShare: Money;
  /** True when the 50/50 tournament override was applied instead. */
  readonly appliedOverride: boolean;
  /** True when a non-positive surplus was clamped to two zero shares. */
  readonly clampedToZero: boolean;
  /** One-line derivation, persisted for disputes. */
  readonly explanation: string;
}

/**
 * Split a month's surplus between the organisation and a team.
 *
 * Pure: no clock, no I/O. See the module comment for the four rules this
 * reproduces and why each detail is there.
 */
export function computeSurplusSplit(input: SurplusSplitInput): SurplusSplit {
  const { monthlyPrizePool, monthlyCost, nextMonthTierCost, orgSharePercent } = input;

  // Money operations throw on a currency mismatch, which is the correct failure:
  // silently converting would invent an exchange rate nobody agreed to.
  const deductions = monthlyCost.add(nextMonthTierCost);
  const deductedSurplus = monthlyPrizePool.subtract(deductions);

  const override = resolveOverride(input);
  const grossSurplus = override === null ? deductedSurplus : override;

  if (grossSurplus.isNegative() || grossSurplus.isZero()) {
    // Clamp the shares, never the surplus. A losing month must still be reportable
    // as a losing month, so `grossSurplus` carries its negative figure while both
    // shares are zero: there is nothing to divide.
    return {
      grossSurplus,
      deductions,
      orgShare: zero(grossSurplus.currency),
      teamShare: zero(grossSurplus.currency),
      appliedOverride: override !== null,
      clampedToZero: true,
      explanation: buildExplanation({ overrideApplied: override !== null, grossSurplus, deductions }),
    };
  }

  const orgPercent = override === null ? parseOrgShare(orgSharePercent) : OVERRIDE_ORG_SHARE_PERCENT;
  const orgMinor = applyPercent(grossSurplus.minor, orgPercent);

  return {
    grossSurplus,
    deductions,
    orgShare: money(formatMinor(orgMinor), grossSurplus.currency),
    // Residual, never a second percentage: this is what makes the sum exact.
    teamShare: money(formatMinor(grossSurplus.minor - orgMinor), grossSurplus.currency),
    appliedOverride: override !== null,
    clampedToZero: false,
    explanation: buildExplanation({ overrideApplied: override !== null, grossSurplus, deductions }),
  };
}

/**
 * The override basis — the RAW winnings — or `null` when it does not apply.
 *
 * Returning `null` rather than a flag keeps the call site honest: there is exactly
 * one place that chooses the basis, and the flag is derived from that choice.
 */
function resolveOverride(input: SurplusSplitInput): Money | null {
  const winnings = input.tournamentWinnings;
  if (winnings === undefined) return null;
  if (winnings.currency !== input.monthlyPrizePool.currency) {
    throw new Error(`Currency mismatch: cannot combine ${input.monthlyPrizePool.currency} with ${winnings.currency}`);
  }

  // Strictly greater than. At exactly the threshold the ordinary deducted path runs.
  return winnings.minor > TOURNAMENT_OVERRIDE_THRESHOLD_MINOR ? winnings : null;
}

/**
 * Round a percentage of a minor-unit amount, half-up.
 *
 * Only ever applied to the org share — the team share is a residual, so the pair
 * always sums exactly to the basis. Rounding half-up on the exact rational, done
 * in `bigint`, rather than by `Number`, because a float here would make the sum
 * invariant fail intermittently on exactly the amounts a reconciliation would
 * pick to dispute.
 */
function applyPercent(minor: bigint, percentScaledBy1e4: bigint): bigint {
  const numerator = minor * percentScaledBy1e4;
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;

  // floor((2n + d) / 2d) is round-half-up on the exact rational n / d.
  const rounded = (absolute * 2n + 1_000_000n) / 2_000_000n;

  return sign * rounded;
}

function parseOrgShare(value: string): bigint {
  let parsed: bigint;
  try {
    parsed = parsePercent(value, "orgSharePercent");
  } catch (error) {
    // `cause` is preserved so the original parse failure survives re-wrapping:
    // an operator debugging a bad rate card needs the underlying reason, not
    // only this wrapper's summary of it.
    throw new Error(`Invalid orgSharePercent: ${JSON.stringify(value)} is not a percentage`, { cause: error });
  }

  if (parsed > 1_000_000n) {
    throw new Error(`Invalid orgSharePercent: ${value} exceeds 100%`);
  }

  return parsed;
}

function buildExplanation(args: {
  readonly overrideApplied: boolean;
  readonly grossSurplus: Money;
  readonly deductions: Money;
}): string {
  const { overrideApplied, grossSurplus, deductions } = args;

  if (overrideApplied) {
    return `Tournament override applied: split ${format(grossSurplus)} 50/50 on raw winnings, bypassing deductions of ${format(deductions)}.`;
  }

  return `grossSurplus = pool - deductions = ${format(grossSurplus)} (deductions ${format(deductions)}); percentage applied after all deductions.`;
}

function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

function format(value: Money): string {
  return value.toDecimal();
}