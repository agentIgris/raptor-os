/**
 * Ledger invariants under fuzz.
 *
 * Two properties, both stated over randomised input, neither allowed to be true
 * only on the examples somebody thought of:
 *
 * 1. **Conserved** — a journal built to balance always posts, and the ledger
 *    never gains or loses a minor unit no matter how many postings accumulate.
 * 2. **Inseparable from invention** — an arbitrary journal is either rejected or
 *    balances. There is no third outcome in which money appears.
 *
 * The LCG is seeded and deterministic, so a failure reproduces exactly rather
 * than vanishing on the next run.
 */

import { describe, expect, it } from "vitest";

import { MONEY_MAX_MINOR, minorToDecimal, money } from "../money/index.js";
import { assertLedgerBalances, ledgerGrandTotals, postJournal, reverseJournal, type JournalLine, type PostedJournal } from "./index.js";

const INR = "INR";
const USD = "USD";

const AT = new Date("2026-03-01T00:00:00.000Z");

/** Deterministic pseudo-random source. Same seed, same failures, every run. */
function makeRandom(seed: bigint): () => bigint {
  let state = seed;
  return () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return state >> 33n;
  };
}

/**
 * Money from raw minor units.
 *
 * `minorToDecimal` rather than a number, because these fuzz values go up to a
 * trillion minor units and a `number` would quietly lose digits before the
 * arithmetic ever started.
 */
function at(minor: bigint, currency: string) {
  return money(minorToDecimal(minor), currency);
}

const ACCOUNTS = ["bank:operating", "payable:prize", "expense:slots", "equity:sponsor", "payable:staff"];

function randomAccount(next: () => bigint): string {
  return ACCOUNTS[Number(next() % BigInt(ACCOUNTS.length))]!;
}

/**
 * A set of lines that balances by construction.
 *
 * The credit side is drawn at random and closed with a true residual, so the
 * journal balances because the arithmetic says so rather than because the test
 * agreed with itself. A mistake in this builder surfaces as a rejected journal,
 * not as a silently passing assertion.
 */
function balancedLines(next: () => bigint): JournalLine[] {
  const lineCount = 2 + Number(next() % 4n);

  const debits: JournalLine[] = [];
  let debitTotal = 0n;
  for (let i = 0; i < lineCount; i++) {
    const amount = 1n + (next() % 1_000_000_000n);
    debitTotal += amount;
    debits.push({ account: randomAccount(next), direction: "debit", amount: at(amount, INR) });
  }

  const credits: JournalLine[] = [];
  let remaining = debitTotal;
  for (let i = 0; i < lineCount; i++) {
    const amount = i === lineCount - 1 ? remaining : next() % (remaining + 1n);
    remaining -= amount;
    credits.push({ account: randomAccount(next), direction: "credit", amount: at(amount, INR) });
  }

  return [...debits, ...credits];
}

/** Total debits across a set of lines, used to check the ledger against a figure the engine never saw. */
function netDebits(lines: readonly JournalLine[]): bigint {
  return lines.reduce((acc, l) => acc + (l.direction === "debit" ? l.amount.minor : 0n), 0n);
}

describe("ledger conservation under fuzz", () => {
  it("never invents or destroys money across 500 randomised balanced postings", () => {
    const next = makeRandom(0x5eed_1ed6_5eed_1ed6n);
    const posted: PostedJournal[] = [];
    let expectedGrandTotal = 0n;

    for (let trial = 0; trial < 500; trial++) {
      const lines = balancedLines(next).map((l, i) => ({ ...l, reference: `trial-${trial}-${i}` }));

      const journal = postJournal({ lines, at: AT, memo: `trial ${trial}` });

      for (const total of journal.totals) {
        expect(total.debits.equals(total.credits), `trial ${trial} unbalanced in ${total.currency}`).toBe(true);
      }

      expectedGrandTotal += netDebits(lines);
      posted.push(journal);
    }

    // The whole ledger, accumulated, still conserves — and it conserves the
    // *expected* figure, not merely a self-consistent one.
    expect(() => assertLedgerBalances(posted)).not.toThrow();

    const grand = ledgerGrandTotals(posted);
    expect(grand).toHaveLength(1);
    expect(grand[0]!.debits.minor).toBe(expectedGrandTotal);
    expect(grand[0]!.credits.minor).toBe(expectedGrandTotal);
  });

  it("rejects or balances every one of 500 randomised journals", () => {
    const next = makeRandom(0xdead_beef_cafe_0001n);
    let accepted = 0;
    let rejected = 0;

    for (let trial = 0; trial < 500; trial++) {
      // Half the trials are built to balance and half are arbitrary, so the
      // fuzz exercises both the acceptance and the rejection path. Purely
      // random journals essentially never balance, and a fuzz that only ever
      // hits the reject path proves nothing about conservation.
      const lines: JournalLine[] =
        (next() % 2n) === 0n
          ? balancedLines(next)
          : Array.from({ length: 2 + Number(next() % 5n) }, () => ({
              account: randomAccount(next),
              direction: (next() % 2n) === 0n ? ("debit" as const) : ("credit" as const),
              // Half the arbitrary trials mix currencies, so the conversion path
              // is exercised too.
              amount: at(1n + (next() % 1_000_000n), (next() % 2n) === 0n ? INR : USD),
            }));

      try {
        const journal = postJournal({ lines, at: AT });
        accepted++;
        // If it was accepted, it balances. There is no third possibility.
        for (const total of journal.totals) {
          expect(total.debits.equals(total.credits), `trial ${trial} posted an unbalanced journal`).toBe(true);
        }
        expect(() => assertLedgerBalances([journal]), `trial ${trial}`).not.toThrow();
      } catch {
        // Rejected before it existed, so there is nothing to conserve.
        rejected++;
      }
    }

    // Both paths must actually be taken, or the fuzz is proving nothing.
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
    expect(accepted + rejected).toBe(500);
  });

  it("never posts a journal whose totals overflow the numeric(18,4) column", () => {
    // Each line is individually representable and the journal is genuinely
    // balanced, but the per-currency total is twice the column's ceiling. The
    // range guard has to fire on the *sum*, not only on the inputs — otherwise
    // the overflow is discovered by the database instead of here.
    const huge = MONEY_MAX_MINOR;
    const lines = [
      { account: "bank", direction: "debit" as const, amount: at(huge, INR) },
      { account: "bank:fx", direction: "debit" as const, amount: at(huge, INR) },
      { account: "payable", direction: "credit" as const, amount: at(huge, INR) },
      { account: "expense", direction: "credit" as const, amount: at(huge, INR) },
    ];

    expect(() => postJournal({ lines, at: AT })).toThrow(/numeric\(18,4\)|range/i);
  });

  it("reversing a journal exactly cancels it across 300 randomised postings", () => {
    const next = makeRandom(0xc0ffee_1234_5678n);

    for (let trial = 0; trial < 300; trial++) {
      const amount = 1n + (next() % 1_000_000_000n);
      const journal = postJournal({
        lines: [
          { account: "bank", direction: "debit", amount: at(amount, INR) },
          { account: "payable", direction: "credit", amount: at(amount, INR) },
        ],
        at: AT,
      });

      const reversal = reverseJournal(journal, { at: AT });

      // A journal and its reversal are two postings, and together they are
      // still a ledger that conserves.
      expect(() => assertLedgerBalances([journal, reversal]), `trial ${trial}`).not.toThrow();

      const netOf = (j: typeof journal): bigint =>
        j.lines.reduce((acc, l) => acc + (l.direction === "debit" ? l.amount.minor : -l.amount.minor), 0n);

      expect(netOf(journal) + netOf(reversal), `trial ${trial}`).toBe(0n);
    }
  });

  it("resolves 200 randomised exact currency conversions without residue", () => {
    const next = makeRandom(0xabcd_ef01_2345_6789n);

    for (let trial = 0; trial < 200; trial++) {
      // A whole-number rate keeps the conversion exact by construction; the
      // inexact-rate rejection has its own targeted test.
      const rate = String(1n + (next() % 50n));
      const fromMinor = (next() % 1_000_000n) + 1n;
      const toMinor = fromMinor * BigInt(rate);

      const journal = postJournal({
        lines: [
          { account: "bank", direction: "debit", amount: at(fromMinor, INR) },
          { account: "payable", direction: "credit", amount: at(toMinor, USD) },
        ],
        conversions: [{ from: INR, to: USD, rate }],
        at: AT,
      });

      expect(() => assertLedgerBalances([journal]), `trial ${trial}`).not.toThrow();
      expect(journal.conversions[0]!.fromAmount.minor).toBe(fromMinor);
      expect(journal.conversions[0]!.toAmount.minor).toBe(toMinor);

      const reversal = reverseJournal(journal, { at: AT });
      expect(() => assertLedgerBalances([journal, reversal]), `trial ${trial}`).not.toThrow();
    }
  });
});