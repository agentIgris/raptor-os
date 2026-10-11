/**
 * FX: a rate book of stored, dated, as-of-queried exchange rates.
 *
 * `../ledger` already does exact FX on a journal — it refuses an inexact
 * conversion and writes the rate onto the posted entry so the figure is
 * auditable years later. This module does not repeat that; the exact-rational
 * rate arithmetic was **extracted** to `../ledger/rate.ts` so both consume one
 * implementation, and the tests assert the two agree on a conversion, on an
 * inexact conversion, on a same-currency conversion and on a missing rate.
 *
 * Duplicating the arithmetic would be the worst outcome available here: two
 * layers disagreeing about FX is two layers disagreeing about money, and the
 * disagreement would only surface on the conversion where the answers differ.
 *
 * ## A rate is never invented
 *
 * An absent rate throws. It does not default to 1. A rate of 1 is the claim
 * "these currencies are interchangeable", which nobody made — and because
 * EUR/USD genuinely does trade near 1.0, a default of 1 would be *correct* for
 * the one pair nobody bothers to check. A wrong rate of 1 that hides inside the
 * pair where it happens to be right is the ADR-0019 failure with a currency on
 * it.
 *
 * ## Rates are as-of, never "the latest"
 *
 * Every lookup takes an `at` and admits only quotes observed at or before it.
 * Returning the newest rate regardless of when the conversion happened would let
 * a backdated conversion pick up a quote published after it — which is
 * ADR-0019's "filter on `created_at`, not the event date", in a currency costume.
 *
 * ## Inversion is exact, and composition has no rounding step
 *
 * A quoted pair answers for its inverse without a second row, because storing
 * both directions invites them to disagree. The reciprocal usually does not
 * terminate as a decimal (`1/0.012 = 1000/12`), so it is carried as a fraction;
 * truncating it would make a reversal approximate, and an approximate reversal
 * invents money.
 *
 * Pure: no clock, no I/O, no network.
 */

export {
  convertMoney,
  createRateBook,
  invertRate,
  rateFor,
  requireRateFor,
  unsupportedCurrencyPair,
} from "./rate-book.js";
export type {
  ConvertMoneyOptions,
  CreateRateBookInput,
  CurrencyPair,
  FxRate,
  RateBook,
  ResolvedRate,
} from "./rate-book.js";

export {
  applyRateExact,
  canonicalRateText,
  composeRates,
  greatestCommonDivisor,
  invertRate as invertExactRate,
  parseRate,
} from "../ledger/rate.js";
export type { ExactRate } from "../ledger/rate.js";
