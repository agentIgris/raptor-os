/**
 * Double-entry ledger.
 *
 * A journal is a set of lines, each naming an account, a direction and a
 * {@link Money} amount. The one rule that makes it double entry — rather than a
 * list of expenses — is that **the debits must equal the credits**. Not
 * approximately. Not within a tolerance. Exactly, to the minor unit.
 *
 * ## Why the balance check lives here
 *
 * `postJournal` is the last point at which an unbalanced posting can still be
 * attributed to the rule that produced it. Downstream — in the database, in a
 * report, in a reconciliation run weeks later — the same defect is just a number
 * that does not add up, and reconstructing which of five hundred rules caused it
 * is guesswork. Rejecting here costs one throw; rejecting late costs an
 * investigation.
 *
 * The alternative — a `CHECK (debits = credits)` constraint in the schema — is
 * not available for a multi-line posting at all, because a constraint sees one
 * row at a time. The invariant is about a *set*, so it has to be enforced by
 * whoever assembles the set.
 *
 * ## Money is conserved, and that is checked rather than assumed
 *
 * Every posting balances individually, so the ledger as a whole cannot create
 * or destroy a minor unit. That is a theorem about {@link postJournal}, not a
 * hope about the call sites — but it is only worth something if something
 * verifies it, which is what {@link assertLedgerBalances} does. It recomputes
 * the totals from the lines rather than trusting the totals carried on the
 * journal, so a row that was tampered with, half-migrated or hand-edited in a
 * console is still caught.
 *
 * ## Immutability is structural
 *
 * A posted journal is deep-frozen and there is deliberately **no function
 * anywhere in this module that amends, deletes or reverses one in place**. The
 * correction path is {@link reverseJournal}, which returns a *new* journal with
 * the directions flipped: history is corrected by appending, never by editing.
 * A test enumerates this module's exports and fails if a mutator ever appears,
 * so the guarantee cannot rot quietly as the module grows.
 *
 * ## Multi-currency: explicit conversion or rejection, never implicit
 *
 * ADR-0003 forbids *implicit* currency mixing. This module draws the line at
 * the word implicit:
 *
 * - A journal whose lines span two currencies is **rejected** unless the caller
 *   supplies conversions that carry an explicit, stored rate.
 * - A conversion states `from`, `to` and the rate, and the rate is written onto
 *   the posted journal so the figure can be audited years later.
 * - A conversion must resolve **exactly**. If the rate does not divide the
 *   amount into a whole number of minor units, the journal is rejected. Rounding
 *   there would either invent or destroy money at the moment of conversion, and
 *   a one-minor-unit FX rounding difference is precisely the sort of thing that
 *   goes unnoticed for a year.
 * - A journal that already balances within each currency needs **no**
 *   conversion at all. Value that never crossed a currency boundary does not
 *   have an exchange rate, and demanding one would push the caller into
 *   inventing a trade they did not make.
 *
 * This module is pure: no database, no network, and no clock — `at` is always
 * supplied by the caller.
 */

import { createHash } from "node:crypto";

import type { CurrencyCode, Money } from "../money/index.js";
import { minorToDecimal, money, zero } from "../money/index.js";
import { invertRate, parseRate } from "./rate.js";

/** Which side of the double entry a line sits on. */
export type Direction = "debit" | "credit";

export interface JournalLine {
  /** Chart-of-accounts code, e.g. `payable:prize`. */
  readonly account: string;
  readonly direction: Direction;
  /**
   * Non-negative magnitude. The sign comes from {@link direction}, so an
   * amount is never negative: "credit of -100" and "debit of 100" are the same
   * movement spelled two ways, and two spellings will eventually disagree.
   */
  readonly amount: Money;
  /**
   * What this movement is for — an allocation row id, a person id, a pool id.
   *
   * Reconciliation matches on this. It is optional because a movement can be
   * genuine without being attributable to a single allocation (an FX
   * settlement, a bank charge), but an allocation's disbursement must carry it.
   */
  readonly reference?: string;
}

/**
 * A journal line that has passed the balance invariant and been posted.
 *
 * Structurally identical to {@link JournalLine} — TypeScript has no nominal
 * types here — but named separately because the distinction matters when
 * reading a signature: a `PostedLine` is one the ledger has already accepted,
 * and there is no function that turns a `JournalLine` into a `PostedLine`
 * except `postJournal`, which is the whole point.
 */
export type PostedLine = JournalLine;

/**
 * A stated exchange rate between two currencies.
 *
 * `rate` is minor units of `to` per minor unit of `from`, as a decimal string.
 * A string, not a float: `0.119` is not representable in binary, and an FX rate
 * that arrives as `0.11899999999999999` has already lost the figure it was
 * quoting.
 */
export interface FxConversion {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  readonly rate: string;
}

/** A conversion that was applied, with the amounts it actually produced. */
export interface AppliedConversion extends FxConversion {
  /** Amount that left `from`, in `from` currency. */
  readonly fromAmount: Money;
  /** Amount that arrived in `to`, in `to` currency. */
  readonly toAmount: Money;
}

export interface CurrencyTotals {
  readonly currency: CurrencyCode;
  readonly debits: Money;
  readonly credits: Money;
}

export interface PostedJournal {
  /** Canonically ordered. Line order carries no meaning in double entry. */
  readonly lines: readonly PostedLine[];
  readonly conversions: readonly AppliedConversion[];
  /** Per-currency totals including the effect of any conversions. */
  readonly totals: readonly CurrencyTotals[];
  readonly postedAt: Date;
  readonly memo: string | null;
  /** Content hash of every field above. Two submissions of one event match. */
  readonly hash: string;
}

export interface PostJournalInput {
  readonly lines: readonly JournalLine[];
  /** Injected clock. Required, never defaulted — see the module comment. */
  readonly at: Date;
  /** Required when the journal spans currencies. */
  readonly conversions?: readonly FxConversion[];
  readonly memo?: string;
}

/**
 * Validate, balance and freeze a journal.
 *
 * Throws unless the journal balances exactly in every currency. The returned
 * journal is deep-frozen; there is no in-place edit path, by construction.
 */
export function postJournal(input: PostJournalInput): PostedJournal {
  const { lines, at, conversions = [], memo = null } = input;

  assertUsableLines(lines);

  const balances = computeBalances(lines);

  if (balancesAreAllZero(balances)) {
    return freezeJournal(lines, rejectUnusedConversions(conversions), at, memo);
  }

  // A single currency cannot be rescued by a conversion: converting a currency
  // to itself moves nothing. Saying so plainly beats a generic "unbalanced".
  if (balances.size === 1) {
    throwUnbalanced(balances);
  }

  return freezeJournal(lines, applyConversions(balances, conversions), at, memo);
}

export interface ReverseJournalOptions {
  readonly at: Date;
  readonly memo?: string;
}

/**
 * Post the exact opposite of an existing journal.
 *
 * This is the correction path, and it is append-only by construction: the
 * original journal is untouched and the reversal is a separate entry with its own
 * hash and timestamp. It cannot be "applied" without leaving a trace, which is
 * the property an audit depends on.
 *
 * A conversion reverses by swapping `from` and `to` and stating the
 * **reciprocal** rate, because the rate means "minor units of `to` per minor
 * unit of `from`" and the direction of travel has changed. If `A` units left
 * `from` at rate `n/d` and `A·n/d` arrived in `to`, then returning them needs
 * `A·n/d · d/n = A` — the original amount, exactly, with no rounding.
 *
 * The reciprocal frequently does not terminate as a decimal (`1/0.119` is
 * `1000/119`), which is precisely why {@link parseRate} accepts an exact
 * fraction. Recomputing a decimal reciprocal there would round, and rounding a
 * reversal invents money.
 */
export function reverseJournal(journal: PostedJournal, options: ReverseJournalOptions): PostedJournal {
  const reversed: PostedLine[] = journal.lines.map((l) =>
    Object.freeze({
      account: l.account,
      direction: l.direction === "debit" ? "credit" : "debit",
      amount: l.amount,
      ...(l.reference === undefined ? {} : { reference: l.reference }),
    }),
  );

  const reversedConversions: FxConversion[] = journal.conversions.map((c) => ({
    from: c.to,
    to: c.from,
    rate: invertRate(c.rate),
  }));

  return postJournal({
    lines: reversed,
    conversions: reversedConversions,
    at: options.at,
    ...(options.memo === undefined ? {} : { memo: options.memo }),
  });
}

/**
 * Grand totals per currency across a set of journals.
 *
 * Currencies are never merged: `1.00 USD + 1.00 INR` is not `2.00` of anything.
 */
export function ledgerGrandTotals(journals: readonly PostedJournal[]): readonly CurrencyTotals[] {
  const totals = new Map<string, { debits: bigint; credits: bigint }>();

  for (const journal of journals) {
    for (const total of journal.totals) {
      const current = totals.get(total.currency) ?? { debits: 0n, credits: 0n };
      totals.set(total.currency, {
        debits: current.debits + total.debits.minor,
        credits: current.credits + total.credits.minor,
      });
    }
  }

  return sortedEntries(totals).map(([currency, total]) => ({
    currency,
    debits: fromMinor(total.debits, currency),
    credits: fromMinor(total.credits, currency),
  }));
}

/**
 * The conservation invariant, checked rather than assumed.
 *
 * Two things are verified, because they can fail independently:
 *
 * 1. **The recorded totals agree with the lines.** Totals are recomputed from
 *    the lines and every journal's own `totals` are compared against them. This
 *    catches a row whose cached figures were edited — by a migration, by a
 *    console, or by hand — which is invisible to a check that only sums the
 *    lines and only meaningful because the lines are the primary record.
 * 2. **The ledger balances in every currency.** Debits equal credits exactly.
 *
 * Throws on the first failure, naming the currency and the exact gap.
 */
export function assertLedgerBalances(journals: readonly PostedJournal[]): void {
  const totals = new Map<string, { debits: bigint; credits: bigint }>();
  const accumulate = (currency: string, debit: bigint, credit: bigint): void => {
    const current = totals.get(currency) ?? { debits: 0n, credits: 0n };
    totals.set(currency, { debits: current.debits + debit, credits: current.credits + credit });
  };

  for (const journal of journals) {
    assertTotalsAgreeWithLines(journal);
    for (const total of journal.totals) {
      accumulate(total.currency, total.debits.minor, total.credits.minor);
    }
  }

  for (const [currency, total] of sortedEntries(totals)) {
    if (total.debits !== total.credits) {
      throw new Error(
        `Ledger does not balance in ${currency}: debits ${total.debits} minor units against credits ${total.credits}, out of balance by ${absolute(total.credits - total.debits)} minor unit(s). Money was invented or destroyed.`,
      );
    }
  }
}

/**
 * A journal's recorded totals must be exactly what its lines imply.
 *
 * Without this, a journal whose `totals` were edited would sail through a
 * check that only sums the lines — the check would be blind to precisely the
 * field an editor is most likely to hand-correct.
 */
function assertTotalsAgreeWithLines(journal: PostedJournal): void {
  const recomputed = computeTotals(journal.lines, journal.conversions);
  const recorded = new Map(journal.totals.map((t) => [t.currency, t]));

  for (const expected of recomputed) {
    const actual = recorded.get(expected.currency);
    if (actual === undefined) {
      throw new Error(
        `Ledger does not balance: journal ${journal.hash} moves ${expected.currency} but records no totals for it`,
      );
    }
    if (actual.debits.minor !== expected.debits.minor || actual.credits.minor !== expected.credits.minor) {
      throw new Error(
        `Ledger does not balance: journal ${journal.hash} records ${expected.currency} as debits ${actual.debits.toDecimal()} / credits ${actual.credits.toDecimal()}, but its lines total debits ${expected.debits.toDecimal()} / credits ${expected.credits.toDecimal()}`,
      );
    }
  }

  for (const currency of recorded.keys()) {
    if (!recomputed.some((expected) => expected.currency === currency)) {
      throw new Error(`Ledger does not balance: journal ${journal.hash} records totals for ${currency} but moves no ${currency}`);
    }
  }
}

// --- validation -------------------------------------------------------------

function assertUsableLines(lines: readonly JournalLine[]): void {
  if (lines.length === 0) {
    throw new Error("Cannot post an empty journal: a journal must record at least one movement");
  }

  if (lines.length < 2) {
    throw new Error("Cannot post a journal with fewer than two lines: a single line cannot move value, so at least two are required");
  }

  for (const l of lines) {
    if (l.account.trim().length === 0) {
      throw new Error("Every journal line must name an account");
    }
    if (l.amount.minor < 0n) {
      throw new Error(
        `Journal line on ${l.account} has a negative amount (${l.amount.toDecimal()}): direction already carries the sign, so a negative amount is ambiguous`,
      );
    }
  }

  if (lines.every((l) => l.amount.isZero())) {
    throw new Error("Cannot post a journal of all-zero lines: it records no movement at all");
  }
}

/**
 * Debits, credits and net movement per currency.
 *
 * Positive net means excess debits (value that must leave the currency);
 * negative net means excess credits (value owed in it).
 */
interface CurrencyBalance {
  readonly debits: bigint;
  readonly credits: bigint;
  readonly net: bigint;
}

function computeBalances(lines: readonly JournalLine[]): Map<string, CurrencyBalance> {
  const balances = new Map<string, CurrencyBalance>();
  for (const l of lines) {
    const current = balances.get(l.amount.currency) ?? { debits: 0n, credits: 0n, net: 0n };
    const delta = l.direction === "debit" ? l.amount.minor : -l.amount.minor;
    balances.set(l.amount.currency, {
      debits: current.debits + (l.direction === "debit" ? l.amount.minor : 0n),
      credits: current.credits + (l.direction === "credit" ? l.amount.minor : 0n),
      net: current.net + delta,
    });
  }
  return balances;
}

function balancesAreAllZero(balances: ReadonlyMap<string, CurrencyBalance>): boolean {
  return [...balances.values()].every((balance) => balance.net === 0n);
}

/**
 * Report a single-currency imbalance.
 *
 * The message names the currency and the gap in **minor units**, because a
 * reconciliation failure reported only as "does not balance" is a number
 * somebody has to go and reproduce by hand.
 *
 * Returns normally when every currency balances, so this is only ever called on
 * a journal already known to be out of balance in exactly one currency.
 */
function throwUnbalanced(balances: ReadonlyMap<string, CurrencyBalance>): void {
  for (const [currency, balance] of sortedEntries(balances)) {
    if (balance.net !== 0n) {
      throw new Error(
        `Journal is out of balance in ${currency}: debits ${balance.debits} minor units against credits ${balance.credits} minor units, out of balance by ${absolute(balance.net)} minor unit(s). Debits and credits must be equal exactly.`,
      );
    }
  }
}

function rejectUnusedConversions(conversions: readonly FxConversion[]): readonly AppliedConversion[] {
  if (conversions.length > 0) {
    throw new Error(
      "Conversions were supplied but every currency in this journal already balances; a conversion that converts nothing is a mistake, not a no-op",
    );
  }
  return [];
}

/**
 * Resolve every currency out of balance using the stated conversions.
 *
 * A conversion moves value out of a currency holding an **excess debit** into a
 * currency holding an **excess credit**. It consumes the surplus exactly, which
 * is why the result is order-independent: a currency can only ever be a source
 * (surplus) or a destination (deficit), never both, so no two conversions can
 * ever contend for the same balance.
 */
function applyConversions(
  balances: Map<string, CurrencyBalance>,
  conversions: readonly FxConversion[],
): readonly AppliedConversion[] {
  if (conversions.length === 0) {
    throw new Error(
      `Journal is out of balance across ${balances.size} currencies but no conversion was supplied. Cross-currency movements must state an explicit rate; an implicit rate is a rate nobody agreed to.`,
    );
  }

  const sources = new Set<string>();
  const validated = conversions.map((conversion) => {
    if (conversion.from === conversion.to) {
      throw new Error(
        `Conversion ${conversion.from} -> ${conversion.to} is in the same currency: it would move nothing while claiming to move something`,
      );
    }
    if (sources.has(conversion.from)) {
      throw new Error(`Currency ${conversion.from} is the source of more than one conversion: its surplus would be counted twice`);
    }
    sources.add(conversion.from);
    return { conversion, rate: parseRate(conversion.rate) };
  });

  const applied: AppliedConversion[] = [];

  // Working on a plain net map keeps the arithmetic free of non-null
  // assertions: a currency absent from the journal simply nets to zero, and is
  // rejected below for having no surplus rather than exploding on a lookup.
  const nets = new Map<string, bigint>();
  for (const [currency, balance] of balances) {
    nets.set(currency, balance.net);
  }

  for (const { conversion, rate } of validated) {
    const fromNet = nets.get(conversion.from) ?? 0n;
    const toNet = nets.get(conversion.to) ?? 0n;

    if (fromNet <= 0n) {
      throw new Error(
        `Conversion ${conversion.from} -> ${conversion.to} has no surplus to convert: ${conversion.from} stands at ${fromNet} minor units, which is not an excess of debits`,
      );
    }
    if (toNet >= 0n) {
      throw new Error(
        `Conversion ${conversion.from} -> ${conversion.to} has nothing to settle: ${conversion.to} stands at ${toNet} minor units, which is not a shortfall`,
      );
    }

    const scaled = fromNet * rate.numerator;
    if (scaled % rate.denominator !== 0n) {
      throw new Error(
        `Conversion ${conversion.from} -> ${conversion.to} at ${rate.text} is inexact: ${fromNet} minor units do not convert to a whole number of minor units. Rounding here would invent or destroy money.`,
      );
    }

    const converted = scaled / rate.denominator;
    nets.set(conversion.from, 0n);
    nets.set(conversion.to, toNet + converted);

    applied.push({
      from: conversion.from,
      to: conversion.to,
      rate: rate.text,
      fromAmount: fromMinor(fromNet, conversion.from),
      toAmount: fromMinor(converted, conversion.to),
    });
  }

  assertResolved(nets);

  // Duplicate sources were rejected above, so every `from` is distinct and
  // ordering by it alone is already a total order.
  return applied.sort((a, b) => compareStrings(a.from, b.from));
}

function assertResolved(nets: ReadonlyMap<string, bigint>): void {
  for (const [currency, net] of sortedEntries(nets)) {
    if (net !== 0n) {
      throw new Error(
        `Journal is out of balance: ${currency} still stands at ${net} minor units after the supplied conversions. Debits and credits must be equal.`,
      );
    }
  }
}

// --- rate parsing -----------------------------------------------------------

/*
 * The exact-rational rate arithmetic now lives in `./rate.ts`, extracted rather
 * than reimplemented. `../fx/rate-book.ts` needs the same inversion and
 * composition this module always needed, and a second copy of "what is an exact
 * rate" is how two layers come to disagree about FX — which is to say, about
 * money. The three functions below are the module's own code, unchanged.
 */


// --- assembly ---------------------------------------------------------------

/**
 * Canonical line order: account, then direction, then amount, then reference.
 *
 * Line order carries no meaning in double entry, so it must not affect the
 * journal's identity. Canonicalising here is what makes re-posting the same
 * event idempotent at the domain level, before the database is ever consulted.
 */
function canonicalLines(lines: readonly JournalLine[]): readonly PostedLine[] {
  return [...lines]
    .sort(
      (a, b) =>
        compareStrings(a.account, b.account) ||
        compareStrings(a.direction, b.direction) ||
        compareStrings(a.amount.toDecimal(), b.amount.toDecimal()) ||
        compareStrings(a.reference ?? "", b.reference ?? ""),
    )
    .map((l) =>
      Object.freeze({
        account: l.account,
        direction: l.direction,
        amount: l.amount,
        ...(l.reference === undefined ? {} : { reference: l.reference }),
      }),
    );
}

function freezeJournal(
  lines: readonly JournalLine[],
  conversions: readonly AppliedConversion[],
  at: Date,
  memo: string | null,
): PostedJournal {
  const canonical = canonicalLines(lines);
  const totals = computeTotals(canonical, conversions);

  return Object.freeze({
    lines: Object.freeze(canonical),
    conversions: Object.freeze(conversions.map((c) => Object.freeze(c))),
    totals: Object.freeze(totals.map((t) => Object.freeze(t))),
    postedAt: at,
    memo,
    hash: hashJournal(canonical, conversions, totals, at, memo),
  });
}

/**
 * Totals including conversion legs.
 *
 * A conversion is a real movement: value **leaves** `from` (a credit there) and
 * **arrives** in `to` (a debit there). Counting it as an equal debit and credit
 * on both sides would double-count the movement and leave every multi-currency
 * journal looking unbalanced by exactly its own FX amount — which is a neat way
 * to make the invariant unreadable and therefore ignored.
 */
function computeTotals(
  lines: readonly PostedLine[],
  conversions: readonly AppliedConversion[],
): readonly CurrencyTotals[] {
  const totals = new Map<string, { debits: bigint; credits: bigint }>();
  const add = (currency: string, debit: bigint, credit: bigint): void => {
    const current = totals.get(currency) ?? { debits: 0n, credits: 0n };
    totals.set(currency, { debits: current.debits + debit, credits: current.credits + credit });
  };

  for (const l of lines) {
    add(l.amount.currency, l.direction === "debit" ? l.amount.minor : 0n, l.direction === "credit" ? l.amount.minor : 0n);
  }
  for (const conversion of conversions) {
    add(conversion.from, 0n, conversion.fromAmount.minor);
    add(conversion.to, conversion.toAmount.minor, 0n);
  }

  return sortedEntries(totals).map(([currency, total]) => ({
    currency,
    debits: fromMinor(total.debits, currency),
    credits: fromMinor(total.credits, currency),
  }));
}

function hashJournal(
  lines: readonly PostedLine[],
  conversions: readonly AppliedConversion[],
  totals: readonly CurrencyTotals[],
  at: Date,
  memo: string | null,
): string {
  const canonical = {
    lines: lines.map((l) => ({
      account: l.account,
      direction: l.direction,
      amount: l.amount.toDecimal(),
      currency: l.amount.currency,
      reference: l.reference ?? null,
    })),
    conversions: conversions.map((c) => ({
      from: c.from,
      to: c.to,
      rate: c.rate,
      fromAmount: c.fromAmount.toDecimal(),
      toAmount: c.toAmount.toDecimal(),
    })),
    totals: totals.map((t) => ({
      currency: t.currency,
      debits: t.debits.toDecimal(),
      credits: t.credits.toDecimal(),
    })),
    postedAt: at.toISOString(),
    memo,
  };

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function fromMinor(minor: bigint, currency: CurrencyCode): Money {
  return minor === 0n ? zero(currency) : money(minorToDecimal(minor), currency);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Map entries in currency order, so every derived report is stable. */
function sortedEntries<V>(map: ReadonlyMap<string, V>): [string, V][] {
  return [...map.entries()].sort(([a], [b]) => compareStrings(a, b));
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}