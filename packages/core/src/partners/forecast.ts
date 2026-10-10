/**
 * Pipeline forecast: a weighted value for a set of open deals.
 *
 * A pipeline is a list of deals, each worth something and each with a
 * probability of closing. "What is this quarter worth if everybody in it lands?"
 * is `sum(value × probability)` — a real question a commercial lead asks on
 * Monday morning and a finance lead disputes in the quarterly review.
 *
 * ## Money rules apply without exception
 *
 * Every amount here is the repository's {@link Money}: `bigint` minor units at
 * four decimal places, carrying an ISO 4217 code (ADR-0003). A weighted forecast
 * is money — it is the number a renewal is sized against — so a `number` return
 * type would put a float one multiplication away from the ledger. There is no
 * `amount: number` anywhere in this file and `MONEY_FACTOR` is the only scale
 * constant.
 *
 * ## Rounding: to the nearest minor unit, and always reported
 *
 * `value × probability` in minor units is *usually* not a whole number of minor
 * units: `123.4567 INR × 9999%` has no exact representation here. So each deal is
 * rounded **half up to the nearest minor unit**, and `weightedTotal` is the sum
 * of those rounded figures — never the exact rational, which is not an amount.
 *
 * Two consequences, both deliberate:
 *
 * 1. **The breakdown reconciles.** `sum(byStage.weighted) === weightedTotal`
 *    exactly, to the minor unit. A breakdown whose parts do not add up to its
 *    total is one nobody can reconcile, and the fuzz test checks the invariant
 *    across 300 randomised pipelines.
 * 2. **The rounding is reported, not hidden.** {@link PipelineForecast.roundingDrift}
 *    is the signed difference, in minor units, between the rounded headline and
 *    the exact rational one. ADR-0019 §6 is the precedent: *"a leaderboard that
 *    silently capped at 1000 rows and presented the result as a ranking is worse
 *    than one that refuses: it looks authoritative."* The same applies here. A
 *    drift of a few minor units across a whole quarter is not worth halting the
 *    forecast over; a drift nobody mentioned is how a board pack acquires a
 *    number nobody can reproduce.
 *
 * Rounding half up is used rather than `money/allocate.ts`'s largest remainder
 * because that algorithm apportions a **known integer** total across shares, and
 * here the exact total is not an integer in the first place — the leftover is a
 * fraction of a minor unit, not a pile of indivisible units. Per deal the error
 * is therefore bounded by half a minor unit, and the headline's by half the deal
 * count.
 *
 * The rounding is also **bounded above by the pipeline itself**, which is a
 * theorem rather than a hope: a deal's rounded amount is at most
 * `ceil(value × probability / 10000)`, and since `probability ≤ 10000` and
 * `value` is a whole number of minor units, `ceil(…) ≤ value`. So a forecast can
 * never report more money in the pipeline than is actually in it.
 *
 * ## Lapsed deals are shown at zero, not hidden
 *
 * A lapsed deal contributes nothing to the weighted headline, but it stays in the
 * per-stage breakdown. A forecast that silently drops closed-lost deals cannot
 * explain why last quarter's number fell, which is the first question anybody
 * asks of a falling number.
 *
 * ## What is a product decision
 *
 * {@link stageDefaultProbability} is **designed, not recovered**: ADR-0016
 * records that the legacy system had no recoverable commercial rules at all. The
 * ordering is the ordinary commercial intuition — a signed deal is more likely to
 * land than a cold lead — but the specific numbers are a starting point for the
 * organisation to calibrate, and they are held in one exported table so that
 * calibrating them is a one-line, visible change rather than a hunt through
 * call sites.
 *
 * Pure: no database, no network, no clock, no randomness.
 */

import type { Money } from "../money/index.js";
import { minorToDecimal, money as toMoney } from "../money/index.js";
import { PARTNER_STAGES } from "./pipeline.js";
import type { PartnerStage } from "./pipeline.js";

/**
 * 100%, on the scale `money.parsePercent` produces.
 *
 * Named as well as inlined because a bare `1_000_000n` in three places is three
 * constants that will eventually drift, and "30%" appearing as both `300_000` and
 * `30_000` in the same file is a factor-of-ten bug nobody catches until a forecast
 * is ten times out.
 */
const CERTAIN = 1_000_000n;

/** One deal in the pipeline. */
export interface PartnerDeal {
  readonly dealId: string;
  readonly partnerId: string;
  readonly organizationId: string;
  readonly stage: PartnerStage;
  /** Face value of the deal, in minor units. */
  readonly value: Money;
  /**
   * Likelihood of closing, as a `bigint` on `money.parsePercent`'s scale:
   * `300_000n` is 30%, and `1_000_000n` is 100%.
   *
   * A `bigint` rather than a `number` because `0.3` is not representable in
   * binary and a forecast that quietly reports 29.999999999999996% is a
   * forecast nobody can put in a board pack.
   */
  readonly probability: bigint;
}

/**
 * A conventional starting probability per stage, as `bigint` scaled by 10^4.
 *
 * **Product decision, not a recovered rule.** Read this instead of writing `30`
 * at a call site; override per deal where the commercial judgement differs.
 * Frozen, because a forecast that changes because somebody assigned to a table
 * constant is a forecast nobody can reproduce.
 */
export const stageDefaultProbability: Readonly<Record<PartnerStage, bigint>> = Object.freeze({
  lead: 50_000n, // 5%
  qualified: 150_000n, // 15%
  negotiation: 400_000n, // 40%
  signed: CERTAIN, // 100% — the contract is signed
  active: CERTAIN, // 100% — the deal is live
  lapsed: 0n, // closed-lost; present for the count, worth nothing
});

/**
 * The weighted value of one deal: `value × probability`, rounded half up to the
 * nearest minor unit.
 *
 * The nearest unit rather than the floor, because a pipeline of a hundred deals
 * floored individually loses up to a hundred minor units — 0.01 of an INR — for
 * no reason a reader could reconstruct. The cost of rounding rather than flooring
 * is at most half a minor unit per deal and it points in both directions, so it
 * does not accumulate.
 *
 * The same figure is what {@link computeWeightedForecast} puts on the breakdown,
 * so a per-deal column and the headline never disagree.
 */
export function dealWeightedValue(deal: PartnerDeal): Money {
  assertDeal(deal);
  return fromMinor(weightedMinor(deal.value.minor, deal.probability), deal.value.currency);
}

/**
 * `minor × probability / 100%`, rounded half up, in exact integer arithmetic.
 *
 * `floor(n/100% + 1/2)` is `floor((2n + 100%) / 200%)` for a non-negative `n`,
 * and both divisions are exact `bigint` operations. Half up rather than banker's
 * rounding because there is no reason to prefer the even figure here and half up
 * is the convention a person doing this by hand would use.
 *
 * The identical formula is already used by `expense/surplus.ts` for the surplus
 * share. Two copies of the same rounding rule is one of them drifting; this one
 * cites the other.
 */
function weightedMinor(minor: bigint, probability: bigint): bigint {
  return (2n * minor * probability + CERTAIN) / (2n * CERTAIN);
}

/** One stage's contribution to the forecast. */
export interface StageForecast {
  readonly stage: PartnerStage;
  readonly dealCount: number;
  /** Face value of the deals at this stage. */
  readonly pipeline: Money;
  /** Probability-weighted value of the deals at this stage. */
  readonly weighted: Money;
}

/** A pipeline forecast: both figures, a breakdown that reconciles, and the drift. */
export interface PipelineForecast {
  readonly currency: string;
  /** Face value of every deal considered. */
  readonly totalPipeline: Money;
  /** Probability-weighted value. Never greater than {@link totalPipeline}. */
  readonly weightedTotal: Money;
  /** One entry per stage that has at least one deal, in pipeline order. */
  readonly byStage: readonly StageForecast[];
  /**
   * The difference between {@link weightedTotal} and the exact rational
   * `sum(value × probability)`, **in units of 1/1,000,000 of a minor unit**.
   *
   * Signed. `1_000_000n` is one whole minor unit; `500_000n` is half of one.
   * The scale is not incidental: the exact weighted total is a rational whose
   * denominator is the percent scale, so a drift expressed in whole minor units
   * would have to round a second time and would report `0` for a real half-unit
   * error. Exposing the exact numerator avoids that.
   *
   * Reported because it happened, not because it is interesting. Bounded in
   * absolute value by half the deal count in minor units, and the fuzz test
   * checks that bound holds.
   */
  readonly roundingDrift: bigint;
}

/**
 * Weight a set of deals by probability, exactly.
 *
 * `currency` is required even though every deal already carries one: a forecast
 * has a single headline figure, and a caller assembling deals from several
 * sources needs the assertion that they agree to be told rather than to find out
 * from the first mismatched `add`.
 *
 * Deals must all be in that currency and must have distinct `dealId`s. Both are
 * refused rather than reconciled: a duplicate id would make the per-stage
 * breakdown double-count one deal, and a mixed-currency pipeline would need a
 * rate nobody has stated.
 */
export function computeWeightedForecast(deals: readonly PartnerDeal[], currency: Money): PipelineForecast {
  if (typeof currency.currency !== "string" || currency.currency.length === 0) {
    throw new Error("computeWeightedForecast requires a currency to state its headline in");
  }

  const seen = new Set<string>();
  for (const deal of deals) {
    assertDeal(deal);
    if (deal.value.currency !== currency.currency) {
      throw new Error(
        `Deal ${deal.dealId} has currency ${deal.value.currency} but the forecast's currency is ${currency.currency}. Currencies are never combined implicitly (ADR-0003); state which one the headline is in and convert the rest deliberately.`,
      );
    }
    if (seen.has(deal.dealId)) {
      throw new Error(
        `Deal ${deal.dealId} appears more than once in this forecast. A repeated id would make the per-stage breakdown double-count it, and the headline would not match its own parts.`,
      );
    }
    seen.add(deal.dealId);
  }

  const byStage = buildStageBreakdown(deals, currency);
  const weightedTotal = byStage.reduce<Money>((total, entry) => total.add(entry.weighted), zeroOf(currency));

  return Object.freeze({
    currency: currency.currency,
    totalPipeline: deals.reduce<Money>((total, deal) => total.add(deal.value), zeroOf(currency)),
    weightedTotal,
    byStage: Object.freeze(byStage),
    roundingDrift: roundingDrift(deals),
  });
}

/**
 * How far the rounded headline sits from the exact rational one, in units of
 * 1/CERTAIN of a minor unit.
 *
 * Accumulated per deal against a fixed denominator, so it is exact: no second
 * rounding happens here, which is the whole reason for the unusual scale. A drift
 * that was itself rounded would report `0` for a real half-unit error, and the
 * one thing this figure must never do is understate itself.
 */
function roundingDrift(deals: readonly PartnerDeal[]): bigint {
  let drift = 0n;

  for (const deal of deals) {
    drift += weightedMinor(deal.value.minor, deal.probability) * CERTAIN - deal.value.minor * deal.probability;
  }

  return drift;
}

/**
 * Per-stage figures, summing the same per-deal figures the headline is built
 * from.
 *
 * Each deal is weighted exactly once, by {@link dealWeightedValue} — the very
 * function a caller would use for a per-deal column. That is what makes
 * `sum(byStage.weighted) === weightedTotal` hold by construction rather than by
 * two implementations of one rounding rule agreeing, which is the failure mode
 * this repository has already paid for once in a different guise.
 */
function buildStageBreakdown(deals: readonly PartnerDeal[], currency: Money): StageForecast[] {
  return PARTNER_STAGES.map((stage) => {
    const atStage = deals.filter((deal) => deal.stage === stage);
    if (atStage.length === 0) return undefined;

    return Object.freeze({
      stage,
      dealCount: atStage.length,
      pipeline: atStage.reduce<Money>((total, deal) => total.add(deal.value), zeroOf(currency)),
      weighted: atStage.reduce<Money>((total, deal) => total.add(dealWeightedValue(deal)), zeroOf(currency)),
    });
  }).filter((entry): entry is StageForecast => entry !== undefined);
}

function assertDeal(deal: PartnerDeal): void {
  if (deal.dealId.trim() === "") {
    throw new Error("A deal must carry a non-empty dealId; an unnameable deal cannot appear in a reconciliation");
  }
  if (deal.partnerId.trim() === "") {
    throw new Error(`Deal ${deal.dealId} names no partnerId; a pipeline of deals to nobody is not a pipeline`);
  }
  if (deal.organizationId.trim() === "") {
    throw new Error(`Deal ${deal.dealId} has a blank organizationId; tenancy scopes every read of this data (ADR-0011)`);
  }
  if (!(PARTNER_STAGES as readonly string[]).includes(deal.stage)) {
    throw new Error(
      `Deal ${deal.dealId} has unknown stage ${JSON.stringify(deal.stage)}; expected one of ${PARTNER_STAGES.join(", ")}. An off-vocabulary stage has no declared default probability, and defaulting one would be inventing a number.`,
    );
  }
  if (deal.probability < 0n) {
    throw new Error(`Deal ${deal.dealId} has a negative probability of ${deal.probability.toString()}`);
  }
  if (deal.probability > CERTAIN) {
    throw new Error(
      `Deal ${deal.dealId} has a probability of ${deal.probability.toString()} on a ${CERTAIN.toString()} scale, which is above 100%. A deal more certain than certain is a forecast that cannot be wrong.`,
    );
  }
  if (deal.value.minor < 0n) {
    throw new Error(`Deal ${deal.dealId} has a negative value of ${deal.value.toDecimal()}`);
  }
}

/**
 * `Money` has no public constructor that takes raw minor units — `money()` parses
 * a decimal string in **major** units. `minorToDecimal` is the repository's own
 * renderer for exactly this conversion, and passing the `bigint` straight to
 * `money()` would multiply every figure by 10^4, which is the sort of error that
 * looks like a plausible number.
 */
function fromMinor(minor: bigint, currency: string): Money {
  return toMoney(minorToDecimal(minor), currency);
}

function zeroOf(currency: Money): Money {
  return fromMinor(0n, currency.currency);
}