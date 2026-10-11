import { describe, expect, it } from "vitest";

import { money } from "../money/index.js";
import { postJournal } from "../ledger/index.js";
import type { FxConversion, JournalLine } from "../ledger/index.js";
import {
  convertMoney,
  createRateBook,
  invertRate,
  rateFor,
  requireRateFor,
  unsupportedCurrencyPair,
} from "./index.js";
import type { FxRate } from "./index.js";

/**
 * A rate book is an as-of snapshot, not a live feed.
 *
 * The dates matter: ADR-0003 requires the rate to be STORED so a figure can be
 * audited years later. Every rate therefore carries the instant it was observed,
 * and the book is queried as of one. A book that returned "the latest rate"
 * regardless of when the conversion happened would let a backdated conversion
 * pick up a rate published after it — the ADR-0019 "created_at instead of event
 * date" defect, in a currency costume.
 */
const QUOTED_AT = new Date("2026-01-05T09:00:00.000Z");
const LATER_QUOTE = new Date("2026-06-01T09:00:00.000Z");
const BEFORE_ANY_QUOTE = new Date("2025-12-31T00:00:00.000Z");

const ORG = "org_1";

/** 1 INR = 0.012 USD, stated exactly. */
const INR_USD = "0.012";

function rate(overrides: Partial<FxRate> = {}): FxRate {
  return Object.freeze({
    rateId: "rate_1",
    organizationId: ORG,
    from: "INR",
    to: "USD",
    rate: INR_USD,
    observedAt: QUOTED_AT,
    source: "ecb_reference",
    ...overrides,
  });
}

function book(rates: readonly FxRate[] = [rate()]) {
  return createRateBook({ organizationId: ORG, rates });
}

describe("a rate book", () => {
  it("resolves a rate that was quoted at or before the as-of instant", () => {
    const found = rateFor(book(), "INR", "USD", QUOTED_AT);

    expect(found.rate).toBe(INR_USD);
    expect(found.rateId).toBe("rate_1");
  });

  it("resolves a rate quoted EXACTLY at the as-of instant", () => {
    // Half-open `[quotedAt, …)`, the same convention `../tasks` and
    // `../minors` use for effective windows. Using `<` here would mean a quote
    // made at 09:00 does not apply to a conversion at 09:00, which is a gap
    // nobody would notice until a rate was missing at exactly its own timestamp.
    expect(rateFor(book(), "INR", "USD", QUOTED_AT).rateId).toBe("rate_1");
  });

  it("prefers the LATEST quote at or before the as-of instant, never a later one", () => {
    const withLater = book([
      rate({ rateId: "rate_old", rate: "0.011", observedAt: QUOTED_AT }),
      rate({ rateId: "rate_new", rate: "0.013", observedAt: LATER_QUOTE }),
    ]);

    // As of January, only the January quote exists. Returning the June quote
    // would be a backdated conversion using a future rate.
    expect(rateFor(withLater, "INR", "USD", QUOTED_AT).rateId).toBe("rate_old");
    expect(rateFor(withLater, "INR", "USD", LATER_QUOTE).rateId).toBe("rate_new");
  });

  it("finds a rate through a chain of two hops", () => {
    // Two-hop resolution is what a real book looks like: not every pair is
    // quoted directly. The chain is explicit in the result, so an auditor can
    // see it was indirect.
    const chained = book([
      rate({ rateId: "rate_inr_usd", from: "INR", to: "USD", rate: "0.012" }),
      rate({ rateId: "rate_usd_eur", from: "USD", to: "EUR", rate: "0.9" }),
    ]);

    const found = rateFor(chained, "INR", "EUR", QUOTED_AT);

    expect(found.rateId).toBe("rate_inr_usd");
    expect(found.via).toEqual(["USD"]);
    // 0.012 * 0.9 = 0.0108, carried as an exact rational so no float is
    // involved in composing two rates.
    expect(found.rate).toBe("0.0108");
  });

  it("finds the inverse of a quoted pair without a rate being stored for it", () => {
    // A book that only quotes INR→USD must still answer USD→INR, because the
    // figure is the same trade read backwards. Storing both directions invites
    // the two to disagree, which is the failure a single stored rate prevents.
    const found = rateFor(book(), "USD", "INR", QUOTED_AT);

    expect(found.rateId).toBe("rate_1");
    // 1/0.012 is 250/3 — reduced to lowest terms, because `0.012` is `12/1000`
    // and `1000/12` and `250/3` are the same rate with two spellings. One rate
    // must have one canonical form or two systems will compare them as different.
    expect(found.rate).toBe("250/3");
  });

  it("refuses to invent a rate, and says so", () => {
    // THE property this deliverable asks for. An absent rate is an error, not a
    // default of 1: a rate of 1 means "these two currencies are interchangeable",
    // which is a claim nobody made and which would silently produce a wrong
    // figure on screen.
    expect(() => rateFor(book(), "INR", "JPY", QUOTED_AT)).toThrow(/INR.*JPY|JPY.*INR/);
    expect(() => requireRateFor(book(), "INR", "JPY", QUOTED_AT)).toThrow(/No exchange rate is available/);
  });

  it("refuses a rate that had not been quoted YET at the as-of instant", () => {
    // Same refusal, different cause: the rate exists, just not on that date. The
    // distinction is reported because "we have no rate" and "we had not quoted
    // one yet" are different data problems with different fixes.
    expect(() => rateFor(book(), "INR", "USD", BEFORE_ANY_QUOTE)).toThrow(/No exchange rate is available/);
  });

  it("refuses to convert a currency to itself", () => {
    // Same rule the ledger applies: a conversion that converts nothing while
    // claiming to move something is a mistake, not a no-op.
    expect(() => rateFor(book(), "USD", "USD", QUOTED_AT)).toThrow(/same currency/i);
  });

  it("reports which pairs a book cannot serve, rather than failing at conversion time", () => {
    // A book that cannot quote a pair should be able to SAY so up front, so an
    // integration check does not have to run a conversion to find out.
    const gaps = unsupportedCurrencyPair(book(), [
      ["INR", "USD"],
      ["INR", "JPY"],
      ["GBP", "EUR"],
    ]);

    expect(gaps).toEqual([
      { from: "GBP", to: "EUR" },
      { from: "INR", to: "JPY" },
    ]);
  });
});

describe("a rate is validated before it is believed", () => {
  it("refuses a malformed rate rather than storing it for later", () => {
    for (const bad of ["", "abc", "0", "-1", "1.2.3", "1/0"]) {
      expect(() => book([rate({ rate: bad })])).toThrow(/rate/i);
    }
  });

  it("refuses a lookup naming currencies that are not ISO 4217 alphabetic", () => {
    // The stored rates are validated at construction, so the only way to reach
    // this is a caller passing a bad code into the lookup itself.
    expect(() => rateFor(book(), "rupees", "USD", QUOTED_AT)).toThrow(/ISO 4217|currenc/i);
    expect(() => rateFor(book(), "INR", "US", QUOTED_AT)).toThrow(/ISO 4217|currenc/i);
    expect(() => rateFor(book(), "", "USD", QUOTED_AT)).toThrow(/ISO 4217|currenc/i);
  });

  it("refuses a rate that is not a positive number", () => {
    // A zero or negative rate is not a market observation. Accepting one would
    // let a conversion invert the direction of the money.
    expect(() => book([rate({ rate: "0" })])).toThrow(/positive/i);
    expect(() => book([rate({ rate: "-0.5" })])).toThrow(/rate/i);
  });

  it("refuses a rate whose currencies are not ISO 4217 alphabetic", () => {
    expect(() => book([rate({ to: "usd" })])).toThrow(/currenc|code/i);
    expect(() => book([rate({ from: "RUPEE" })])).toThrow(/currenc|code/i);
  });

  it("refuses a rate naming the same currency on both sides", () => {
    expect(() => book([rate({ from: "INR", to: "INR" })])).toThrow(/against itself/);
  });

  it("refuses a rate with no observation instant, a blank id or no source", () => {
    // ADR-0019's provenance rule, applied to FX: a rate with no observation time
    // cannot be placed in history, and a rate with no source cannot be checked.
    expect(() => book([rate({ observedAt: new Date(Number.NaN) })])).toThrow(/observed/i);
    expect(() => book([rate({ rateId: " " })])).toThrow(/rate id/i);
    expect(() => book([rate({ source: "  " })])).toThrow(/source/i);
  });

  it("refuses two quotes of the same pair observed at the same instant", () => {
    // "Which rate was in force at 09:00" must have exactly one answer. Two rows
    // saying different things about the same moment is the ambiguity a stored
    // rate is supposed to remove.
    expect(() =>
      book([rate({ rateId: "rate_a", rate: "0.012" }), rate({ rateId: "rate_b", rate: "0.099" })]),
    ).toThrow(/ambiguous|same instant|two/i);
  });

  it("refuses a rate belonging to another organisation", () => {
    expect(() =>
      createRateBook({ organizationId: ORG, rates: [rate({ organizationId: "org_2" })] }),
    ).toThrow(/org_2/);
  });

  it("refuses a book with no organisation at all", () => {
    expect(() => createRateBook({ organizationId: " ", rates: [] })).toThrow(/organization/i);
  });
});

describe("inverting a rate", () => {
  it("inverts exactly, and keeps the result exact when the reciprocal does not terminate", () => {
    // 1/0.012 is 83.333…, which has no finite decimal expansion.
    // Truncating it to "83.33333333" would make the reversal approximate, and an
    // approximate reversal invents money — the reason `../ledger` accepts an
    // exact fraction as well as a decimal. It is also REDUCED: `0.012` is
    // `12/1000`, so the reciprocal is `250/3`, not the unreduced `1000/12`.
    expect(invertRate("0.012")).toBe("250/3");
    expect(invertRate("1")).toBe("1");
    expect(invertRate("2.5")).toBe("0.4");
  });

  it("round-trips an inversion", () => {
    // Inverting twice returns the original rate in canonical form. A rate that
    // did not survive this could not be reversed and re-reversed by two systems
    // that disagree about which spelling is canonical.
    for (const rate of ["0.012", "83.333333333333333", "1", "0.0001"]) {
      expect(invertRate(invertRate(rate))).toBe(rate);
    }
  });
});

describe("converting money", () => {
  it("converts exactly, or refuses", () => {
    // 1000.0000 INR is 10,000,000 minor units. At 0.012 (exactly 3/250) that is
    // 120,000 minor units of USD = 12.0000 USD. Exact, so it converts.
    const converted = convertMoney(money("1000.0000", "INR"), book(), { at: QUOTED_AT, to: "USD" });

    expect(converted.minor).toBe(120_000n);
    expect(converted.currency).toBe("USD");
    // Asserted against `money()` rather than against a literal: a factor-of-
    // 10,000 scaling slip (handing `money()` a raw bigint, which it reads as
    // major units) would produce 12000.0000 USD and still type-check.
    expect(converted.equals(money("12.0000", "USD"))).toBe(true);
  });

  it("refuses an INEXACT conversion rather than rounding", () => {
    // 0.0001 INR is ONE minor unit. At 3/250 that is 3/250 of a minor unit of
    // USD, which is not a whole number. Rounding here would create or destroy a
    // fraction of the smallest stored unit at the exact moment value changes
    // hands, and a one-unit FX difference nobody notices for a year is precisely
    // the defect `../ledger` documents.
    expect(() => convertMoney(money("0.0001", "INR"), book(), { at: QUOTED_AT, to: "USD" })).toThrow(
      /inexact/i,
    );
  });

  it("refuses to convert without a rate rather than assuming parity", () => {
    // THE property, at the conversion layer as well as the lookup layer. A rate
    // of 1 would be indistinguishable from a real 1:1 peg, and a peg that
    // happens to hold for a fortnight would hide the bug for a fortnight.
    expect(() => convertMoney(money("1000.0000", "INR"), book(), { at: QUOTED_AT, to: "JPY" })).toThrow(
      /No exchange rate is available/,
    );
  });

  it("refuses to convert a currency into itself", () => {
    expect(() => convertMoney(money("1000.0000", "INR"), book(), { at: QUOTED_AT, to: "INR" })).toThrow(
      /same currency/i,
    );
  });

  it("refuses a source amount whose currency the book cannot serve", () => {
    expect(() => convertMoney(money("1000.0000", "GBP"), book(), { at: QUOTED_AT, to: "USD" })).toThrow(
      /No exchange rate is available/,
    );
  });

  it("refuses an unusable as-of instant", () => {
    expect(() => convertMoney(money("1000.0000", "INR"), book(), { at: new Date(Number.NaN), to: "USD" })).toThrow(
      /at/i,
    );
  });

  it("gives the same answer for 1 + 999 as it does for 1000", () => {
    // A conversion that is not additive across amounts is one whose rate is
    // being re-derived per call rather than applied per conversion. Both halves
    // are exactly convertible here: 1.0000 INR -> 120 minor USD, 999.0000 INR ->
    // 119,880 minor USD, and those sum to the whole.
    const parts = convertMoney(money("1.0000", "INR"), book(), { at: QUOTED_AT, to: "USD" }).add(
      convertMoney(money("999.0000", "INR"), book(), { at: QUOTED_AT, to: "USD" }),
    );
    const whole = convertMoney(money("1000.0000", "INR"), book(), { at: QUOTED_AT, to: "USD" });

    expect(parts.minor).toBe(whole.minor);
    expect(parts.minor).toBe(120_000n);
  });
});

describe("consistency with the ledger's own FX handling", () => {
  /**
   * The ledger already does exact FX with explicit rates (`../ledger/journal.ts`
   * rejects inexact conversions and writes the rate onto the posted journal). This
   * module must not be a second, disagreeing implementation of the same thing.
   */
  const LINES: readonly JournalLine[] = [
    { account: "cash:inr", direction: "debit", amount: money("1000.0000", "INR") },
    { account: "cash:usd", direction: "credit", amount: money("12.0000", "USD") },
  ];

  it("produces a conversion the ledger accepts, resolving to the identical amount", () => {
    const book_ = book();
    const converted = convertMoney(money("1000.0000", "INR"), book_, { at: QUOTED_AT, to: "USD" });

    // The ledger's `FxConversion` is the SAME shape the rate book produces, and
    // it resolves to the same figure. If these ever diverged, an amount checked
    // against the book and an amount checked against the ledger would disagree.
    const asLedgerConversion: FxConversion = {
      from: "INR",
      to: "USD",
      rate: rateFor(book_, "INR", "USD", QUOTED_AT).rate,
    };

    const posted = postJournal({ lines: LINES, conversions: [asLedgerConversion], at: QUOTED_AT });
    const applied = posted.conversions[0]!;

    expect(applied.fromAmount.minor).toBe(money("1000.0000", "INR").minor);
    expect(applied.toAmount.minor).toBe(converted.minor);
    expect(applied.rate).toBe(asLedgerConversion.rate);
  });

  it("rejects the same inexact conversion the ledger rejects", () => {
    // Both layers must refuse, and for the same reason. If only this module
    // refused, a caller could route around it through the ledger; if only the
    // ledger refused, the book would be advertising conversions it cannot make.
    //
    // One minor unit of INR against 3/250 does not land on a whole unit of USD.
    // The USD side is short by one minor unit, so the ledger REACHES the
    // conversion and then finds it inexact — which is the refusal being compared.
    // (A USD credit of zero would be rejected earlier, for having nothing to
    // settle, and would prove nothing about inexactness.)
    const inexact: readonly JournalLine[] = [
      { account: "cash:inr", direction: "debit", amount: money("0.0001", "INR") },
      { account: "cash:usd", direction: "credit", amount: money("0.0001", "USD") },
    ];

    expect(() =>
      postJournal({ lines: inexact, conversions: [{ from: "INR", to: "USD", rate: INR_USD }], at: QUOTED_AT }),
    ).toThrow(/inexact/i);

    expect(() => convertMoney(money("0.0001", "INR"), book(), { at: QUOTED_AT, to: "USD" })).toThrow(/inexact/i);
  });

  it("agrees with the ledger about a conversion needing no rate at all", () => {
    // A journal in one currency balances with no conversion, and the ledger
    // REJECTS a conversion that converts nothing. A rate book asked for a
    // same-currency pair must refuse the same way, or a caller could "convert"
    // INR to INR and get a figure that looks converted.
    const single = [
      { account: "cash:inr", direction: "debit", amount: money("100.0000", "INR") },
      { account: "revenue", direction: "credit", amount: money("100.0000", "INR") },
    ] as const;

    // The ledger's refusal here is `rejectUnusedConversions`: a journal that
    // already balances plus a conversion is a mistake, not a no-op.
    expect(() =>
      postJournal({ lines: single, conversions: [{ from: "INR", to: "INR", rate: "1" }], at: QUOTED_AT }),
    ).toThrow(/converts nothing/i);

    expect(() => convertMoney(money("100.0000", "INR"), book(), { at: QUOTED_AT, to: "INR" })).toThrow(
      /same currency/i,
    );
  });

  it("agrees with the ledger about a missing rate being an error, not a default", () => {
    const lines: readonly JournalLine[] = [
      { account: "cash:inr", direction: "debit", amount: money("1000.0000", "INR") },
      { account: "cash:jpy", direction: "credit", amount: money("1000.0000", "JPY") },
    ];

    // The ledger's own words when no conversion is supplied. This module must
    // refuse the same transaction, for the same reason, and say so in the same
    // spirit — an implicit rate is a rate nobody agreed to.
    expect(() => postJournal({ lines, at: QUOTED_AT })).toThrow(/no conversion was supplied/i);
    expect(() => convertMoney(money("1000.0000", "INR"), book(), { at: QUOTED_AT, to: "JPY" })).toThrow();
  });
});

describe("the book is frozen and reports itself honestly", () => {
  it("freezes its rates so a quoted figure cannot be rewritten at runtime", () => {
    const frozen = book();

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.rates)).toBe(true);
    for (const entry of frozen.rates) expect(Object.isFrozen(entry)).toBe(true);
  });

  it("refuses a duplicate rate id", () => {
    expect(() =>
      book([rate({ rateId: "dup" }), rate({ rateId: "dup", from: "GBP", to: "EUR" })]),
    ).toThrow(/rate id|duplicate/i);
  });

  it("treats a same-currency pair as serviceable, because nothing needs converting", () => {
    // `unsupportedCurrencyPair` answers "does this book need a rate for this
    // pair". For INR→INR the honest answer is no — there is nothing to look up,
    // and a caller asking is not asking for a conversion.
    const gaps = unsupportedCurrencyPair(book(), [
      ["INR", "INR"],
      ["INR", "USD"],
    ]);

    expect(gaps).toEqual([]);
  });

  it("answers an availability question against an EMPTY book without throwing", () => {
    // A book with no rates is a real state — the feed has not run yet — and
    // asking it what it can do must report "nothing", not raise.
    const empty = createRateBook({ organizationId: ORG, rates: [] });

    expect(unsupportedCurrencyPair(empty, [["INR", "USD"]])).toEqual([{ from: "INR", to: "USD" }]);
    expect(empty.rates).toEqual([]);
  });

  it("picks the newer quote when two exist for one pair, whatever order they arrived in", () => {
    // `latestQuote` relies on the book being frozen in `compareQuotes` order,
    // which sorts by pair then `observedAt` ASCENDING — so the LAST match is the
    // newest. This test feeds them newest-FIRST to prove the selection depends on
    // the frozen order and not on arrival order, and asserts that order.
    const twoQuotes = book([
      rate({ rateId: "rate_new", rate: "0.013", observedAt: LATER_QUOTE }),
      rate({ rateId: "rate_old", rate: "0.011", observedAt: QUOTED_AT }),
    ]);

    expect(twoQuotes.rates.map((r) => r.rateId)).toEqual(["rate_old", "rate_new"]);
    expect(rateFor(twoQuotes, "INR", "USD", LATER_QUOTE).rateId).toBe("rate_new");
    expect(rateFor(twoQuotes, "INR", "USD", QUOTED_AT).rateId).toBe("rate_old");
  });

  it("reports the LATER of two hop quotes as the composed rate's observation time", () => {
    // A composed rate is only as current as its stalest leg. Reporting the first
    // leg's instant would date a June figure to January, which is precisely the
    // misdating ADR-0019 records for `created_at` filtering.
    const staggered = book([
      rate({ rateId: "rate_inr_usd", from: "INR", to: "USD", rate: "0.012", observedAt: QUOTED_AT }),
      rate({ rateId: "rate_usd_eur", from: "USD", to: "EUR", rate: "0.9", observedAt: LATER_QUOTE }),
    ]);

    const found = rateFor(staggered, "INR", "EUR", LATER_QUOTE);

    expect(found.observedAt).toEqual(LATER_QUOTE);
    expect(found.source).toContain("via USD");
  });

  it("refuses a same-currency lookup before consulting the book at all", () => {
    // Refused at the edge, so an empty book and a full one give the same answer
    // and the caller gets the same message either way.
    expect(() => rateFor(createRateBook({ organizationId: ORG, rates: [] }), "INR", "INR", QUOTED_AT)).toThrow(
      /same currency/i,
    );
  });

  it("lists the pairs it CAN serve, for an integration pre-flight", () => {
    const pairs = book([
      rate({ rateId: "a", from: "INR", to: "USD" }),
      rate({ rateId: "b", from: "USD", to: "EUR" }),
    ]).pairs;

    expect(pairs).toContainEqual({ from: "INR", to: "USD" });
    expect(pairs).toContainEqual({ from: "USD", to: "EUR" });
  });
});
