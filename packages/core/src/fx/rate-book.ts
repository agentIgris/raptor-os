/**
 * A rate book: stored, dated, as-of-queried exchange rates.
 *
 * ## What this extends rather than duplicates
 *
 * `../ledger/journal.ts` has always done exact FX with explicit rates: it
 * refuses an inexact conversion, writes the rate onto the posted journal so the
 * figure is auditable years later, and refuses a same-currency "conversion".
 * A rate *book* needs the same arithmetic — inversion, composition, an
 * exactness check — and that arithmetic was extracted to `../ledger/rate.ts` so
 * there is **one** implementation of "what is an exact rate".
 *
 * Duplicating it would be the worst possible outcome here: two layers disagreeing
 * about FX is two layers disagreeing about money, and the disagreement would only
 * surface on the conversion where the two answers differ.
 *
 * The tests assert the consistency directly: a conversion this module produces
 * is accepted verbatim by `postJournal` and resolves to the identical amount,
 * and both layers reject the same inexact conversion, the same same-currency
 * conversion and the same missing rate.
 *
 * ## The rate is never invented
 *
 * This is the property the whole module turns on, and it is a *refusal* rather
 * than a default. An absent rate throws; it does not fall back to 1.
 *
 * The reason is not pedantry. A rate of 1 is the claim "these two currencies are
 * interchangeable", and nobody made that claim. But EUR/USD genuinely does trade
 * near 1.0, so a default of 1 would be *correct* for that pair for a while, and
 * the bug would hide inside the one pair where nobody checks. A rate of 1 that is
 * wrong is indistinguishable from a rate of 1 that is right, which is exactly
 * what makes it dangerous.
 *
 * ## Rates are as-of, never "the latest"
 *
 * Every rate carries the instant it was observed, and every lookup takes an
 * `at`. Returning the newest rate regardless of when the conversion happened
 * would let a backdated conversion pick up a quote published after it — which is
 * ADR-0019's "filter on `created_at`, not the event date" defect wearing a
 * currency costume. The test pins it: a January conversion must resolve to the
 * January quote even when a June quote exists.
 *
 * ## Inversion is exact
 *
 * A quoted pair answers for its inverse without a second row being stored.
 * Storing both directions invites them to disagree, and two rates that disagree
 * about the same trade is a question with two answers.
 *
 * The reciprocal usually does not terminate as a decimal (`1/0.012 = 1000/12`),
 * so it is carried as an exact fraction. Truncating it would make a reversal
 * approximate, and an approximate reversal invents money.
 *
 * Pure: no clock, no I/O. Every query is as-of an instant the caller supplies.
 */

import { minorToDecimal, money } from "../money/index.js";
import type { CurrencyCode, Money } from "../money/index.js";
import { applyRateExact, composeRates, invertRate, parseRate } from "../ledger/rate.js";

export { invertRate };

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * One stored rate observation.
 *
 * `observedAt` is an INSTANT and `source` is mandatory because of ADR-0019's
 * provenance rule applied to FX: a rate with no observation time cannot be
 * placed in history, and a rate with no source cannot be checked by anybody. The
 * legacy system had no provenance on anything, and a fabricated constant wearing
 * a measurement's clothes is what that produced.
 */
export interface FxRate {
  readonly rateId: string;
  readonly organizationId: string;
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  /**
   * Minor units of `to` per minor unit of `from`, as an exact decimal or
   * fraction. A string, never a `number`: `0.119` is not representable in
   * binary, and a rate that arrived as `0.11899999999999999` has already lost
   * the figure it was quoting.
   */
  readonly rate: string;
  /** WHEN this rate was observed — not when the row was written. */
  readonly observedAt: Date;
  readonly source: string;
}

/** A frozen, as-of-queried set of rates for one organisation. */
export interface RateBook {
  readonly organizationId: string;
  readonly rates: readonly FxRate[];
  /** Every pair the book holds a direct quote for, sorted. */
  readonly pairs: readonly CurrencyPair[];
}

export interface CurrencyPair {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
}

/** A rate found in the book, with its provenance intact. */
export interface ResolvedRate {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  /** The exact rate to apply, composed if the answer took more than one hop. */
  readonly rate: string;
  /** The stored quote the answer came from. */
  readonly rateId: string;
  readonly observedAt: Date;
  readonly source: string;
  /**
   * Intermediate currencies on the way, sorted. Empty for a direct or inverted
   * lookup, one entry for a two-hop resolution.
   *
   * Carried rather than hidden so an auditor can see the answer was indirect.
   * A composed rate presented as though it were directly quoted is a claim the
   * data does not support.
   */
  readonly via: readonly CurrencyCode[];
}

export interface CreateRateBookInput {
  readonly organizationId: string;
  readonly rates: readonly FxRate[];
}

/**
 * Validate and freeze a rate book.
 *
 * Four rules, each removing a way for a stored rate to be wrong:
 *
 * 1. **A rate is positive and well-formed.** A zero or negative rate would let a
 *    conversion invert the direction of the money.
 * 2. **Both currencies are ISO 4217 alphabetic**, and they differ.
 * 3. **One quote per pair per instant.** "Which rate was in force at 09:00" must
 *    have exactly one answer; two rows disagreeing about the same moment is the
 *    ambiguity a stored rate exists to remove.
 * 4. **Every rate belongs to this organisation.** ADR-0011: a rate is tenant
 *    data, and one org's rate informing another's figure is a cross-tenant read.
 */
export function createRateBook(input: CreateRateBookInput): RateBook {
  if (input.organizationId.trim() === "") {
    throw new Error("A rate book must name an organization; rates from every tenant merged is not a rate book");
  }

  const seenIds = new Set<string>();
  const seenQuotes = new Map<string, string>();

  const rates = input.rates.map((candidate) => {
    assertRate(candidate, input.organizationId);

    if (seenIds.has(candidate.rateId)) {
      throw new Error(`Rate book for ${input.organizationId} contains rate id ${candidate.rateId} twice`);
    }
    seenIds.add(candidate.rateId);

    const quoteKey = `${candidate.from}->${candidate.to}@${candidate.observedAt.toISOString()}`;
    const existing = seenQuotes.get(quoteKey);
    if (existing !== undefined) {
      throw new Error(
        `Rate book for ${input.organizationId} holds two quotes for ${candidate.from}->${candidate.to} at ${candidate.observedAt.toISOString()} ` +
          `(${existing} and ${candidate.rateId}). "Which rate was in force at that instant" must have exactly one answer.`,
      );
    }
    seenQuotes.set(quoteKey, candidate.rateId);

    return Object.freeze({ ...candidate });
  });

  // Sorted so the frozen book is a value: two books built from the same rows in
  // different orders must compare equal, or a caller caching one against a hash
  // of the other gets a spurious miss.
  const sorted = Object.freeze([...rates].sort((a, b) => compareQuotes(a, b)));

  const pairs: CurrencyPair[] = [];
  for (const entry of sorted) {
    if (!pairs.some((pair) => pair.from === entry.from && pair.to === entry.to)) {
      pairs.push({ from: entry.from, to: entry.to });
    }
  }

  return Object.freeze({
    organizationId: input.organizationId,
    rates: sorted,
    pairs: Object.freeze(pairs.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to))),
  });
}

/**
 * The rate for `from → to` as at `at`, or throw.
 *
 * Resolution order, and why each step is there:
 *
 * 1. **A direct quote at or before `at`.** The common case, and the only one
 *    that needs no reasoning about whether a composition is trustworthy.
 * 2. **The inverse of a direct quote** for `to → from`. One stored trade read
 *    backwards; storing both directions invites them to disagree.
 * 3. **A two-hop composition** through a currency quoted against both.
 *
 * Every quote considered is filtered on `observedAt <= at`. A quote published
 * after the conversion is not evidence about the conversion.
 *
 * Throws rather than returning `null`: a caller that wants to know "is this
 * serviceable?" asks {@link unsupportedCurrencyPair}, and a caller about to
 * convert must not be handed a `null` it might treat as "no conversion needed".
 */
export function rateFor(
  book: RateBook,
  from: CurrencyCode,
  to: CurrencyCode,
  at: Date,
): ResolvedRate {
  assertLookup(book, from, to, at);

  const direct = latestQuote(book, from, to, at);
  if (direct !== null) {
    return resolved(from, to, direct, []);
  }

  const inverse = latestQuote(book, to, from, at);
  if (inverse !== null) {
    return resolved(from, to, inverse, [], true);
  }

  for (const hop of sortedStrings(sharedCurrencies(book, from, to, at))) {
    // `sharedCurrencies` already filtered to hops whose BOTH legs resolve at
    // `at`, so neither lookup here can miss. The two `null` branches that used to
    // guard these were unreachable, and unreachable guards in the resolution
    // path are worse than none: they read as a real case and hide the fact that
    // the filter is what guarantees it.
    const first = latestQuote(book, from, hop, at) as FxRate;
    const second = latestQuote(book, hop, to, at) as FxRate;

    return {
      from,
      to,
      rate: composeRates(first.rate, second.rate),
      rateId: first.rateId,
      observedAt: latestInstant(first, second),
      source: `${first.source} via ${hop} ${second.source}`,
      via: Object.freeze([hop]),
    };
  }

  throw new Error(
    `No exchange rate is available for ${from} -> ${to} as at ${at.toISOString()} in rate book for ${book.organizationId}. ` +
      `A missing rate is an error and never a default of 1: a rate of 1 claims the two currencies are interchangeable, which nobody agreed to, and it would be silently correct for EUR/USD — the one pair nobody checks.`,
  );
}

/**
 * {@link rateFor} as a throw-only lookup, for callers that want the "cannot be
 * serviced" question without catching.
 *
 * Named differently on purpose: a boolean and a guarantee are not the same
 * thing, and a `false` a caller ignores proves nothing.
 */
export function requireRateFor(
  book: RateBook,
  from: CurrencyCode,
  to: CurrencyCode,
  at: Date,
): ResolvedRate {
  return rateFor(book, from, to, at);
}

/**
 * Which of `pairs` this book cannot serve.
 *
 * Up front, so an integration check does not have to run a conversion to find
 * out. "Can serve" means *at some quote in the book*, not "at an instant the
 * caller supplies" — a gap in a rate feed is a data problem worth knowing about
 * before a payment is attempted, and asking about availability should not need
 * an instant.
 *
 * Sorted, so two runs over the same inputs report the same gaps.
 */
export function unsupportedCurrencyPair(
  book: RateBook,
  pairs: readonly (readonly [CurrencyCode, CurrencyCode])[],
): readonly CurrencyPair[] {
  const gaps: CurrencyPair[] = [];

  for (const [from, to] of pairs) {
    if (!canServe(book, from, to)) {
      gaps.push({ from, to });
    }
  }

  return Object.freeze(gaps.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to)));
}

export interface ConvertMoneyOptions {
  /** Injected clock. Required, never defaulted. */
  readonly at: Date;
  /**
   * The currency to convert into. Required, never inferred.
   *
   * Inferring it from "the only pair this book quotes" would be the exact
   * mistake this module exists to prevent: the moment a second quote is added, a
   * caller's money would start converting somewhere else with no change to the
   * call site. Requiring it means adding a rate to the book can never change what
   * an existing conversion does.
   */
  readonly to: CurrencyCode;
}

/**
 * Convert an amount at the rate in force at `at`, exactly or not at all.
 *
 * ## Why inexactness throws rather than rounds
 *
 * Rounding at the moment value changes hands either invents or destroys a
 * fraction of the smallest stored unit, and the difference is invisible in every
 * total — it only shows up when two organisations reconcile. The ledger refuses
 * the same conversion for the same reason, and the two refusals are asserted
 * against each other in the test file.
 *
 * The practical consequence is real and worth stating: many ordinary amounts are
 * not convertible at all. `1 INR at 0.012` is `0.012 USD`, which is not a whole
 * number of minor units. A rate book that rounded would "work"; this one refuses,
 * because a working conversion that quietly moves money is worse than one that
 * declines.
 */
export function convertMoney(amount: Money, book: RateBook, options: ConvertMoneyOptions): Money {
  assertInstant(options.at, "at");

  const to = options.to;

  if (amount.currency === to) {
    throw new Error(
      `Cannot convert ${amount.currency} into ${to}: that is the same currency. A conversion that converts nothing while claiming to move something is a mistake, not a no-op.`,
    );
  }

  const resolved = rateFor(book, amount.currency, to, options.at);
  const converted = applyRateExact(amount.minor, resolved.rate);

  if (converted === null) {
    throw new Error(
      `Converting ${amount.toString()} to ${to} at ${resolved.rate} (quoted ${resolved.observedAt.toISOString()}) is inexact: ` +
        `it does not land on a whole number of minor units. Rounding here would invent or destroy money at the moment value changes hands.`,
    );
  }

  // `minorToDecimal` FIRST, because `money()` reads a bare `bigint` as a
  // MAJOR-unit amount: `money(120000n, "USD")` is 12000.0000 USD, not 12.0000.
  // Passing the raw bigint would be a factor-of-10,000 error that type-checks
  // perfectly and is invisible on any amount small enough to look plausible.
  return money(minorToDecimal(converted), to);
}

// --- internals --------------------------------------------------------------

function assertRate(candidate: FxRate, organizationId: string): void {
  if (typeof candidate.rateId !== "string" || candidate.rateId.trim() === "") {
    throw new Error(`A rate for ${organizationId} has no rate id`);
  }
  if (candidate.organizationId !== organizationId) {
    throw new Error(
      `Rate ${candidate.rateId} belongs to ${candidate.organizationId} but was placed in the rate book for ${organizationId}. A rate is tenant data, and one organisation's rate informing another's figure is a cross-tenant read.`,
    );
  }
  if (!isCurrency(candidate.from) || !isCurrency(candidate.to)) {
    throw new Error(
      `Rate ${candidate.rateId} has currencies ${JSON.stringify(candidate.from)} -> ${JSON.stringify(candidate.to)}; expected ISO 4217 alphabetic codes`,
    );
  }
  if (candidate.from === candidate.to) {
    throw new Error(`Rate ${candidate.rateId} quotes ${candidate.from} against itself`);
  }
  if (typeof candidate.source !== "string" || candidate.source.trim() === "") {
    throw new Error(
      `Rate ${candidate.rateId} names no source. ADR-0019's provenance rule applies to FX: a rate nobody can trace is a rate that cannot be checked.`,
    );
  }
  assertInstant(candidate.observedAt, `observedAt of rate ${candidate.rateId}`);
  // The message comes from the shared parser, so a malformed rate reads the same
  // whether it reached through the ledger or through here.
  parseRate(candidate.rate);
}

function assertLookup(book: RateBook, from: CurrencyCode, to: CurrencyCode, at: Date): void {
  assertInstant(at, "at");
  if (!isCurrency(from) || !isCurrency(to)) {
    throw new Error(`Cannot look up ${JSON.stringify(from)} -> ${JSON.stringify(to)}; expected ISO 4217 alphabetic codes`);
  }
  if (from === to) {
    throw new Error(
      `Cannot look up a rate from ${from} to ${to}: that is the same currency, and a same-currency conversion would move nothing while claiming to move something.`,
    );
  }
}

function assertInstant(date: Date, field: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`An unusable ${field} was supplied; an FX lookup is always as of a real instant`);
  }
}

function isCurrency(value: string): boolean {
  return typeof value === "string" && CURRENCY_PATTERN.test(value);
}

/**
 * The newest quote for a pair at or before `at`, or `null`.
 *
 * `book.rates` is frozen in `compareQuotes` order, which sorts by pair and then
 * by `observedAt` ASCENDING. The last match in that order is therefore the
 * newest one, so the scan takes the final qualifying row rather than comparing
 * timestamps on each step — a property of the frozen order, asserted by the
 * test that feeds quotes newest-first.
 */
function latestQuote(book: RateBook, from: CurrencyCode, to: CurrencyCode, at: Date): FxRate | null {
  let best: FxRate | null = null;

  for (const candidate of book.rates) {
    if (candidate.from !== from || candidate.to !== to) continue;
    // The as-of filter is the whole reason this takes an instant. A quote
    // published after the conversion is not evidence about it.
    if (candidate.observedAt.getTime() > at.getTime()) continue;
    best = candidate;
  }

  return best;
}

/** Build a {@link ResolvedRate} from the quote that answered, inverting if asked. */
function resolved(
  from: CurrencyCode,
  to: CurrencyCode,
  quote: FxRate,
  via: readonly CurrencyCode[],
  inverted = false,
): ResolvedRate {
  return Object.freeze({
    from,
    to,
    rate: inverted ? invertRate(quote.rate) : quote.rate,
    rateId: quote.rateId,
    observedAt: quote.observedAt,
    source: quote.source,
    via: Object.freeze([...via]),
  });
}

/** Currencies quoted against BOTH ends of a pair, i.e. possible intermediate hops. */
function sharedCurrencies(book: RateBook, from: CurrencyCode, to: CurrencyCode, at: Date): readonly CurrencyCode[] {
  const hops = new Set<string>();
  for (const candidate of book.rates) {
    if (candidate.observedAt.getTime() > at.getTime()) continue;
    if (candidate.from === from && candidate.to !== to) hops.add(candidate.to);
    if (candidate.to === from && candidate.from !== to) hops.add(candidate.from);
  }
  // A hop is only usable if BOTH legs resolve at `at`. Checking one leg and
  // composing anyway would produce a rate built half from the past and half from
  // the present, which is a rate nobody quoted.
  return Object.freeze(
    [...hops].filter((hop) => hop !== from && hop !== to && bothLegsResolvable(book, from, hop, to, at)),
  );
}

/** Whether `from → hop` and `hop → to` both resolve at `at`. */
function bothLegsResolvable(
  book: RateBook,
  from: CurrencyCode,
  hop: string,
  to: CurrencyCode,
  at: Date,
): boolean {
  try {
    rateFor(book, from, hop, at);
    rateFor(book, hop, to, at);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the book can reach `to` from `from` at all.
 *
 * Resolved against a sentinel instant past every quote in the book, so the answer
 * is "can this book EVER do this" rather than "can it do this on that day".
 * That is the right reading for an availability check: a gap in a rate feed is
 * worth reporting before a payment is attempted, not on the day it is.
 */
function canServe(book: RateBook, from: CurrencyCode, to: CurrencyCode): boolean {
  if (from === to) return true;
  // `shareCurrencies` takes `at` too, so the sentinel has to be a real Date.
  const horizon = new Date(
    book.rates.reduce((max, candidate) => Math.max(max, candidate.observedAt.getTime()), 0) + 1,
  );
  try {
    rateFor(book, from, to, horizon);
    return true;
  } catch {
    return false;
  }
}

function latestInstant(a: FxRate, b: FxRate): Date {
  return a.observedAt.getTime() >= b.observedAt.getTime() ? a.observedAt : b.observedAt;
}

/**
 * Quote order: pair, then observation instant ascending.
 *
 * Deliberately NOT tie-broken on `rateId`. A tie would be two quotes of one pair
 * observed at the same instant, and `createRateBook` refuses that case before
 * this runs. The ordering therefore has no ambiguity to break, and
 * `latestQuote` may take the last match as the newest without re-comparing
 * timestamps — which is what keeps the as-of lookup a single pass.
 */
function compareQuotes(a: FxRate, b: FxRate): number {
  return (
    compareStrings(a.from, b.from) ||
    compareStrings(a.to, b.to) ||
    a.observedAt.getTime() - b.observedAt.getTime()
  );
}

function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareStrings);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
