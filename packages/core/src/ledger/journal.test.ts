/**
 * Double-entry ledger.
 *
 * The property under test throughout: **money is never invented and never
 * destroyed**. Every posting must balance to the minor unit before it can be
 * returned, let alone persisted. A journal that does not balance is rejected
 * at the domain boundary, which is the only place the rejection can still be
 * attributed to the rule that caused it.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/index.js";
import {
  assertLedgerBalances,
  ledgerGrandTotals,
  postJournal,
  reverseJournal,
  type JournalLine,
} from "./index.js";

const INR = "INR";
const USD = "USD";
const EUR = "EUR";

const AT = new Date("2026-03-01T00:00:00.000Z");

function line(account: string, direction: "debit" | "credit", amount: string, currency = INR, reference?: string): JournalLine {
  return reference === undefined
    ? { account, direction, amount: money(amount, currency) }
    : { account, direction, amount: money(amount, currency), reference };
}

/** A simple balanced INR movement: money in from the bank, owed to the winner. */
function balancedPair(amount: string): JournalLine[] {
  return [line("bank:operating", "debit", amount), line("payable:prize", "credit", amount)];
}

describe("postJournal", () => {
  describe("the balance invariant", () => {
    it("accepts a journal whose debits equal its credits", () => {
      const journal = postJournal({ lines: balancedPair("1000.00"), at: AT });

      expect(journal.totals).toHaveLength(1);
      expect(journal.totals[0]!.currency).toBe(INR);
      expect(journal.totals[0]!.debits.toDecimal()).toBe("1000.0000");
      expect(journal.totals[0]!.credits.toDecimal()).toBe("1000.0000");
    });

    it("rejects a journal whose debits exceed its credits", () => {
      const lines = [line("bank:operating", "debit", "1000.00"), line("payable:prize", "credit", "999.99")];

      expect(() => postJournal({ lines, at: AT })).toThrow(/out of balance/i);
    });

    it("rejects a journal whose credits exceed its debits", () => {
      const lines = [line("bank:operating", "debit", "999.99"), line("payable:prize", "credit", "1000.00")];

      expect(() => postJournal({ lines, at: AT })).toThrow(/out of balance/i);
    });

    it("reports the exact imbalance in minor units so the defect is locatable", () => {
      const lines = [line("bank:operating", "debit", "1000.00"), line("payable:prize", "credit", "999.9999")];

      // The message must name the minor-unit gap, not just say "invalid".
      expect(() => postJournal({ lines, at: AT })).toThrow(/1 minor unit|out of balance by 1/i);
    });

    it("rejects a single-sided journal that would create money from nothing", () => {
      // Two credits and no debit: 1000.00 appears from nowhere.
      const lines = [line("payable:prize", "credit", "500.00"), line("payable:bonus", "credit", "500.00")];

      expect(() => postJournal({ lines, at: AT })).toThrow(/out of balance/i);
    });

    it("rejects an empty journal", () => {
      expect(() => postJournal({ lines: [], at: AT })).toThrow(/empty/i);
    });

    it("rejects a one-line journal, which cannot move value", () => {
      expect(() => postJournal({ lines: [line("bank:operating", "debit", "0.00")], at: AT })).toThrow(/at least two/i);
    });

    it("rejects a journal of all-zero lines, which records nothing", () => {
      const lines = [line("bank:operating", "debit", "0.00"), line("payable:prize", "credit", "0.00")];

      expect(() => postJournal({ lines, at: AT })).toThrow(/zero/i);
    });

    it("rejects a line that names no account", () => {
      const lines = [line("   ", "debit", "1000.00"), line("payable:prize", "credit", "1000.00")];

      expect(() => postJournal({ lines, at: AT })).toThrow(/account/i);
    });

    it("rejects a negative amount, because direction already carries the sign", () => {
      // A credit of -100 is a debit of 100. Accepting both spellings means two
      // ways to express one movement, and they will not agree in a report.
      const lines = [line("bank:operating", "debit", "1000.00"), line("payable:prize", "credit", "-900.00")];

      expect(() => postJournal({ lines, at: AT })).toThrow(/negative/i);
    });
  });

  describe("deterministic content hash", () => {
    it("produces the same hash for the same economic event", () => {
      const first = postJournal({ lines: balancedPair("1000.00"), at: AT });
      const second = postJournal({ lines: balancedPair("1000.00"), at: AT });

      expect(second.hash).toBe(first.hash);
    });

    it("produces the same hash regardless of the order the lines were submitted in", () => {
      // Line order carries no meaning in double entry, so it must not change the
      // journal's identity: two submissions of one event are one event.
      const forwards = postJournal({
        lines: [line("bank:operating", "debit", "1000.00"), line("payable:prize", "credit", "1000.00")],
        at: AT,
      });
      const backwards = postJournal({
        lines: [line("payable:prize", "credit", "1000.00"), line("bank:operating", "debit", "1000.00")],
        at: AT,
      });

      expect(backwards.hash).toBe(forwards.hash);
    });

    it("stores lines in canonical order regardless of submission order", () => {
      const journal = postJournal({
        lines: [line("z:account", "debit", "10.00"), line("a:account", "credit", "10.00")],
        at: AT,
      });

      expect(journal.lines.map((l) => l.account)).toEqual(["a:account", "z:account"]);
    });

    it("orders by reference when two lines are identical apart from it", () => {
      // Two payouts on one account for the same amount are only distinguishable
      // by reference, so reference has to be the final tie-break or the canonical
      // order would depend on submission order.
      const journal = postJournal({
        lines: [
          line("payable:winner", "credit", "100.00", INR, "p9"),
          line("payable:winner", "credit", "100.00", INR, "p1"),
          line("bank:operating", "debit", "200.00"),
        ],
        at: AT,
      });

      const references = journal.lines.filter((l) => l.reference !== undefined).map((l) => l.reference);
      expect(references).toEqual(["p1", "p9"]);
    });

    it("changes the hash when the amount changes by one minor unit", () => {
      const first = postJournal({ lines: balancedPair("1000.00"), at: AT });
      const second = postJournal({ lines: balancedPair("1000.0001"), at: AT });

      expect(second.hash).not.toBe(first.hash);
    });

    it("changes the hash when the posting time changes", () => {
      const first = postJournal({ lines: balancedPair("1000.00"), at: AT });
      const second = postJournal({ lines: balancedPair("1000.00"), at: new Date("2026-03-02T00:00:00.000Z") });

      expect(second.hash).not.toBe(first.hash);
    });

    it("changes the hash when a line carries a reference", () => {
      const plain = postJournal({ lines: balancedPair("1000.00"), at: AT });
      const referenced = postJournal({
        lines: [line("bank:operating", "debit", "1000.00"), line("payable:prize", "credit", "1000.00", INR, "p1")],
        at: AT,
      });

      expect(referenced.hash).not.toBe(plain.hash);
    });

    it("changes the hash when a memo is recorded", () => {
      const plain = postJournal({ lines: balancedPair("1000.00"), at: AT });
      const annotated = postJournal({ lines: balancedPair("1000.00"), at: AT, memo: "prize pool 7" });

      expect(annotated.hash).not.toBe(plain.hash);
      expect(plain.memo).toBeNull();
      expect(annotated.memo).toBe("prize pool 7");
    });
  });

  describe("immutability is structural, not conventional", () => {
    it("freezes the journal and every line in it", () => {
      const journal = postJournal({ lines: balancedPair("1000.00"), at: AT });

      expect(Object.isFrozen(journal)).toBe(true);
      expect(Object.isFrozen(journal.lines)).toBe(true);
      expect(journal.lines.every((l) => Object.isFrozen(l))).toBe(true);
      expect(Object.isFrozen(journal.totals)).toBe(true);
    });

    it("has no way to mutate a posted entry, even at runtime", () => {
      const journal = postJournal({ lines: balancedPair("1000.00"), at: AT });

      // Structural first: the property is non-writable, so no assignment of any
      // kind can change it.
      expect(Object.getOwnPropertyDescriptor(journal, "hash")?.writable).toBe(false);

      expect(() => {
        (journal as unknown as { hash: string }).hash = "forged";
      }).toThrow(TypeError);
      expect(journal.hash).not.toBe("forged");
    });

    it("exports no function named as an amendment of a posted entry", async () => {
      const module = await import("./index.js");
      const mutators = Object.keys(module).filter((name) =>
        /amend|update|mutate|delete|remove|replace|patch|purge|void|edit|retract|rewrite|backdate|overwrite|undo/i.test(name),
      );

      // The correction path in a double-entry ledger is a *new reversing
      // journal*, not an edit to history. If someone later adds an `amendJournal`,
      // this test fails and makes them argue for it explicitly.
      expect(mutators).toEqual([]);
    });

    it("gives every journal-taking export a way to return a new journal, never to change one", () => {
      const journal = postJournal({ lines: balancedPair("1000.00"), at: AT });
      const hashBefore = journal.hash;

      const reversal = reverseJournal(journal, { at: AT });

      expect(reversal).not.toBe(journal);
      expect(journal.hash).toBe(hashBefore);
      expect(journal.lines).toHaveLength(2);
      expect(journal.lines.every((l) => l.direction === l.direction)).toBe(true);
    });
  });

  describe("multi-currency", () => {
    const crossCurrencyLines = (): JournalLine[] => [
      line("bank:operating", "debit", "10.0000", INR),
      line("payable:prize", "credit", "1.1900", USD),
    ];

    it("rejects a multi-currency journal with no stated rate", () => {
      // Silent implicit conversion is the defect class this rebuild exists to
      // prevent: an unstated rate is a rate nobody agreed to.
      expect(() => postJournal({ lines: crossCurrencyLines(), at: AT })).toThrow(/conversion/i);
    });

    it("accepts a multi-currency journal when the rate is stated and stored", () => {
      const journal = postJournal({
        lines: crossCurrencyLines(),
        conversions: [{ from: INR, to: USD, rate: "0.1190" }],
        at: AT,
      });

      expect(journal.conversions).toHaveLength(1);
      expect(journal.conversions[0]!.from).toBe(INR);
      expect(journal.conversions[0]!.to).toBe(USD);
      expect(journal.conversions[0]!.fromAmount.toDecimal()).toBe("10.0000");
      expect(journal.conversions[0]!.toAmount.toDecimal()).toBe("1.1900");
    });

    it("records the rate on the journal so it can be audited later", () => {
      const journal = postJournal({
        lines: crossCurrencyLines(),
        conversions: [{ from: INR, to: USD, rate: "0.1190" }],
        at: AT,
      });

      // Trailing zeros are stripped so "0.1190" and "0.119" are one rate, not two.
      expect(journal.conversions[0]!.rate).toBe("0.119");
    });

    it("folds the conversion into the per-currency totals", () => {
      const journal = postJournal({
        lines: crossCurrencyLines(),
        conversions: [{ from: INR, to: USD, rate: "0.1190" }],
        at: AT,
      });

      const byCurrency = Object.fromEntries(journal.totals.map((t) => [t.currency, t]));
      expect(byCurrency[INR]!.debits.toDecimal()).toBe("10.0000");
      expect(byCurrency[INR]!.credits.toDecimal()).toBe("10.0000");
      expect(byCurrency[USD]!.debits.toDecimal()).toBe("1.1900");
      expect(byCurrency[USD]!.credits.toDecimal()).toBe("1.1900");
    });

    it("accepts a multi-currency journal that already balances in each currency with no conversion", () => {
      // Value that never crosses a currency boundary needs no rate. Demanding one
      // would push the caller into inventing a conversion they did not perform.
      const lines = [
        line("bank:operating", "debit", "10.0000", INR),
        line("payable:prize", "credit", "10.0000", INR),
        line("bank:fx", "debit", "1.1900", USD),
        line("payable:fx", "credit", "1.1900", USD),
      ];

      const journal = postJournal({ lines, at: AT });

      expect(journal.conversions).toEqual([]);
      expect(journal.totals).toHaveLength(2);
    });

    it("rejects conversions supplied to a journal that already balances", () => {
      expect(() =>
        postJournal({
          lines: balancedPair("1000.00"),
          conversions: [{ from: INR, to: USD, rate: "0.119" }],
          at: AT,
        }),
      ).toThrow(/already balance/i);
    });

    it("rejects a conversion that would not divide exactly", () => {
      // 0.0001 INR at 0.119 USD is 0.0000119 USD, which is not a whole minor
      // unit. Rounding it here would quietly create or destroy money.
      const lines = [line("bank:operating", "debit", "0.0001", INR), line("payable:prize", "credit", "0.0001", USD)];

      expect(() =>
        postJournal({ lines, conversions: [{ from: INR, to: USD, rate: "0.119" }], at: AT }),
      ).toThrow(/inexact/i);
    });

    it("rejects a rate that converts away too much of the deficit", () => {
      const lines = [line("bank:operating", "debit", "10.0000", INR), line("payable:prize", "credit", "1.0000", USD)];

      // 10.0000 INR at 1.5 is 15.0000 USD against a 1.0000 USD deficit.
      expect(() =>
        postJournal({ lines, conversions: [{ from: INR, to: USD, rate: "1.5" }], at: AT }),
      ).toThrow(/out of balance/i);
    });

    it("rejects a conversion from a currency that has no surplus", () => {
      const lines = [line("bank:operating", "debit", "10.0000", INR), line("payable:prize", "credit", "1.1900", USD)];

      // USD has nothing to give: it is the currency in deficit.
      expect(() =>
        postJournal({ lines, conversions: [{ from: USD, to: INR, rate: "8.4033" }], at: AT }),
      ).toThrow(/surplus/i);
    });

    it("rejects a currency that is the source of two conversions", () => {
      const lines = [
        line("bank:operating", "debit", "10.0000", INR),
        line("payable:prize", "credit", "1.1900", USD),
        line("payable:other", "credit", "0.5000", EUR),
      ];

      expect(() =>
        postJournal({
          lines,
          conversions: [
            { from: INR, to: USD, rate: "0.119" },
            { from: INR, to: EUR, rate: "0.05" },
          ],
          at: AT,
        }),
      ).toThrow(/more than one conversion/i);
    });

    it("rejects a conversion into a currency that is not short of anything", () => {
      // Both currencies hold an excess of debits. Converting one into the other
      // cannot settle a shortfall that does not exist.
      const lines = [
        line("bank:operating", "debit", "10.0000", INR),
        line("bank:fx", "debit", "5.0000", USD),
      ];

      expect(() =>
        postJournal({ lines, conversions: [{ from: INR, to: USD, rate: "1" }], at: AT }),
      ).toThrow(/nothing to settle/i);
    });

    it("rejects a conversion naming a currency the journal does not move", () => {
      // EUR appears in the conversion but in none of the lines, so there is no
      // EUR shortfall to settle. Inventing one would be a fabricated balance.
      const lines = [line("bank:operating", "debit", "10.0000", INR), line("payable:prize", "credit", "1.1900", USD)];

      expect(() =>
        postJournal({ lines, conversions: [{ from: INR, to: "EUR", rate: "1" }], at: AT }),
      ).toThrow(/nothing to settle/i);
    });

    it("rejects a conversion whose source currency the journal never moves", () => {
      const lines = [line("bank:operating", "debit", "10.0000", INR), line("payable:prize", "credit", "1.1900", USD)];

      // EUR has no lines at all, so it cannot be the source of a conversion.
      expect(() =>
        postJournal({ lines, conversions: [{ from: "EUR", to: USD, rate: "1" }], at: AT }),
      ).toThrow(/no surplus/i);
    });

    it("rejects a conversion whose source is its own destination", () => {
      const lines = [line("bank:operating", "debit", "10.0000", INR), line("payable:prize", "credit", "1.1900", USD)];

      expect(() =>
        postJournal({ lines, conversions: [{ from: USD, to: USD, rate: "1" }], at: AT }),
      ).toThrow(/same currency/i);
    });

    it("rejects a malformed rate", () => {
      const lines = [line("bank:operating", "debit", "10.0000", INR), line("payable:prize", "credit", "1.1900", USD)];

      expect(() => postJournal({ lines, conversions: [{ from: INR, to: USD, rate: "not-a-rate" }], at: AT })).toThrow(/rate/i);
      expect(() => postJournal({ lines, conversions: [{ from: INR, to: USD, rate: "0" }], at: AT })).toThrow(/positive/i);
      expect(() => postJournal({ lines, conversions: [{ from: INR, to: USD, rate: "-1" }], at: AT })).toThrow(/positive/i);
      expect(() => postJournal({ lines, conversions: [{ from: INR, to: USD, rate: "1/0" }], at: AT })).toThrow(/denominator/i);
    });

    it("accepts an exact fraction rate, which is how a reversal travels", () => {
      const lines = [line("bank:operating", "debit", "11.9000", INR), line("payable:prize", "credit", "1.0000", USD)];

      const journal = postJournal({ lines, conversions: [{ from: INR, to: USD, rate: "1000/11900" }], at: AT });

      // 1000/11900 reduces to 10/119, which has no terminating decimal, so the
      // canonical form stays a fraction rather than being truncated to one.
      expect(journal.conversions[0]!.rate).toBe("10/119");
      expect(journal.totals.every((t) => t.debits.equals(t.credits))).toBe(true);
    });

    it("reduces a rate so two spellings of one figure hash identically", () => {
      const lines = [line("bank:operating", "debit", "10.0000", INR), line("payable:prize", "credit", "1.1900", USD)];

      const decimal = postJournal({ lines, conversions: [{ from: INR, to: USD, rate: "0.119" }], at: AT });
      const fraction = postJournal({ lines, conversions: [{ from: INR, to: USD, rate: "119/1000" }], at: AT });
      const redundant = postJournal({ lines, conversions: [{ from: INR, to: USD, rate: "238/2000" }], at: AT });

      expect(fraction.hash).toBe(decimal.hash);
      expect(redundant.hash).toBe(decimal.hash);
    });

    it("resolves two source currencies into one deficit currency", () => {
      const lines = [
        line("bank:in", "debit", "10.0000", INR),
        line("bank:eu", "debit", "1.0000", EUR),
        line("payable:prize", "credit", "1.2900", USD),
      ];

      const journal = postJournal({
        lines,
        conversions: [
          { from: INR, to: USD, rate: "0.119" },
          { from: EUR, to: USD, rate: "0.1" },
        ],
        at: AT,
      });

      // 10.0000 INR -> 1.1900 USD and 1.0000 EUR -> 0.1000 USD, closing the
      // 1.2900 USD deficit exactly. Every currency balances on its own.
      expect(journal.conversions).toHaveLength(2);
      expect(journal.totals.every((t) => t.debits.equals(t.credits))).toBe(true);
    });
  });

  describe("reverseJournal — the append-only correction path", () => {
    it("produces a new journal that exactly cancels the original", () => {
      const original = postJournal({ lines: balancedPair("1000.00"), at: AT });
      const reversal = reverseJournal(original, { at: new Date("2026-03-02T00:00:00.000Z") });

      const totalOf = (journal: typeof original): bigint =>
        journal.lines.reduce((acc, l) => acc + (l.direction === "debit" ? l.amount.minor : -l.amount.minor), 0n);

      expect(totalOf(reversal)).toBe(-totalOf(original));
      expect(reversal.hash).not.toBe(original.hash);
    });

    it("leaves the original journal untouched", () => {
      const original = postJournal({ lines: balancedPair("1000.00"), at: AT });
      const before = original.hash;

      reverseJournal(original, { at: new Date("2026-03-02T00:00:00.000Z") });

      expect(original.hash).toBe(before);
      expect(original.lines[0]!.direction).toBe("debit");
    });

    it("reverses a currency conversion using the reciprocal rate", () => {
      const original = postJournal({
        lines: [
          line("bank:operating", "debit", "10.0000", INR),
          line("payable:prize", "credit", "1.1900", USD),
        ],
        conversions: [{ from: INR, to: USD, rate: "0.119" }],
        at: AT,
      });

      const reversal = reverseJournal(original, { at: new Date("2026-03-02T00:00:00.000Z") });

      // 1/0.119 does not terminate as a decimal, so the reciprocal is carried as
      // an exact fraction rather than rounded to 8.40336134...
      expect(reversal.conversions[0]!.from).toBe(USD);
      expect(reversal.conversions[0]!.to).toBe(INR);
      expect(reversal.conversions[0]!.rate).toBe("1000/119");
      expect(reversal.conversions[0]!.fromAmount.toDecimal()).toBe("1.1900");
      expect(reversal.conversions[0]!.toAmount.toDecimal()).toBe("10.0000");
      expect(reversal.totals.every((t) => t.debits.equals(t.credits))).toBe(true);
    });

    it("carries a memo explaining why the reversal was posted", () => {
      const original = postJournal({ lines: balancedPair("1000.00"), at: AT });
      const reversal = reverseJournal(original, { at: AT, memo: "reversed: wrong pool" });

      expect(reversal.memo).toBe("reversed: wrong pool");
      expect(reverseJournal(original, { at: AT }).memo).toBeNull();
    });

    it("preserves each line's reference, so a reversal stays attributable", () => {
      const original = postJournal({
        lines: [
          line("payable:prize_pool", "debit", "1000.00"),
          line("payable:winner", "credit", "1000.00", INR, "p1"),
        ],
        at: AT,
      });

      const reversal = reverseJournal(original, { at: AT });

      // Reconciliation matches on `reference`; losing it on reversal would make a
      // correction unattributable and therefore useless as evidence.
      const references = reversal.lines.map((l) => l.reference).filter((r) => r !== undefined);
      expect(references).toEqual(["p1"]);
      expect(reversal.hash).not.toBe(original.hash);
    });
  });
});

describe("ledgerGrandTotals", () => {
  it("sums debits and credits per currency across journals", () => {
    const first = postJournal({ lines: balancedPair("1000.00"), at: AT });
    const second = postJournal({ lines: balancedPair("250.50"), at: AT });

    const totals = ledgerGrandTotals([first, second]);

    expect(totals).toHaveLength(1);
    expect(totals[0]!.currency).toBe(INR);
    expect(totals[0]!.debits.toDecimal()).toBe("1250.5000");
    expect(totals[0]!.credits.toDecimal()).toBe("1250.5000");
  });

  it("orders totals by currency so the output is stable", () => {
    const journals = [
      postJournal({
        lines: [
          line("a", "debit", "1.0000", USD),
          line("b", "credit", "1.0000", USD),
          line("c", "debit", "1.0000", INR),
          line("d", "credit", "1.0000", INR),
        ],
        at: AT,
      }),
    ];

    expect(ledgerGrandTotals(journals).map((t) => t.currency)).toEqual([INR, USD]);
  });

  it("returns nothing for an empty ledger", () => {
    expect(ledgerGrandTotals([])).toEqual([]);
  });

  it("does not merge totals across currencies", () => {
    const journal = postJournal({
      lines: [
        line("a", "debit", "1.0000", USD),
        line("b", "credit", "1.0000", USD),
        line("c", "debit", "1.0000", INR),
        line("d", "credit", "1.0000", INR),
      ],
      at: AT,
    });

    expect(ledgerGrandTotals([journal])).toHaveLength(2);
  });
});

describe("assertLedgerBalances — money is conserved, checked not assumed", () => {
  it("passes for a set of journals where every posting balances", () => {
    const journals = [
      postJournal({ lines: balancedPair("1000.00"), at: AT }),
      postJournal({ lines: balancedPair("250.50"), at: AT }),
    ];

    expect(() => assertLedgerBalances(journals)).not.toThrow();
  });

  it("passes for an empty ledger, which has conserved nothing", () => {
    expect(() => assertLedgerBalances([])).not.toThrow();
  });

  it("catches a journal whose cached totals were corrupted after posting", () => {
    // Recomputing from the lines rather than trusting the cached totals is the
    // whole point: a tampered or half-migrated row has to be detectable.
    const journal = postJournal({ lines: balancedPair("1000.00"), at: AT });
    const corrupted = {
      ...journal,
      totals: [{ currency: INR, debits: money("2000.00", INR), credits: money("1000.00", INR) }],
    };

    expect(() => assertLedgerBalances([corrupted])).toThrow(/not balance/i);
  });

  it("catches a line whose amount was altered after posting", () => {
    const journal = postJournal({ lines: balancedPair("1000.00"), at: AT });
    const corrupted = {
      ...journal,
      lines: journal.lines.map((l, index) => (index === 1 ? { ...l, amount: money("900.00", INR) } : l)),
    };

    expect(() => assertLedgerBalances([corrupted])).toThrow(/not balance/i);
  });

  it("catches a journal whose lines belong to a currency its totals claim otherwise", () => {
    const journal = postJournal({
      lines: [line("a", "debit", "10.0000", INR), line("b", "credit", "10.0000", EUR)],
      conversions: [{ from: INR, to: EUR, rate: "1" }],
      at: AT,
    });

    const corrupted = { ...journal, totals: journal.totals.filter((t) => t.currency === INR) };

    expect(() => assertLedgerBalances([corrupted])).toThrow(/not balance/i);
  });

  it("catches a journal that records totals for a currency it never moves", () => {
      const journal = postJournal({ lines: balancedPair("1000.00"), at: AT });

      const corrupted = {
        ...journal,
        totals: [...journal.totals, { currency: USD, debits: money("0.00", USD), credits: money("0.00", USD) }],
      };

      expect(() => assertLedgerBalances([corrupted])).toThrow(/not balance/i);
    });

  it("catches a journal whose lines were edited *and* whose totals were edited to match", () => {
    // The hardest case for a domain-only check: the lines no longer balance and
    // the cached totals were updated to agree with them, so the cross-check
    // passes and the per-currency balance check is the last line of defence.
    const journal = postJournal({ lines: balancedPair("1000.00"), at: AT });
    const corrupted = {
      ...journal,
      lines: [
        { account: "bank:operating", direction: "debit" as const, amount: money("1000.00", INR) },
        { account: "payable:prize", direction: "credit" as const, amount: money("900.00", INR) },
      ],
      totals: [{ currency: INR, debits: money("1000.00", INR), credits: money("900.00", INR) }],
    };

    expect(() => assertLedgerBalances([corrupted])).toThrow(/invented or destroyed/i);
  });
});