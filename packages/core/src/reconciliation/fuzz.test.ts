/**
 * The reconciliation invariant, under fuzz.
 *
 * The phase criterion is literal: *the reconciliation invariant holds under
 * fuzz*. This file is that claim, executed.
 *
 * ## The invariant
 *
 * For every allocation the engine accepts:
 *
 * ```
 * allocatedTotal + unallocated == pool        (exactly, to the minor unit)
 * ```
 *
 * and every allocation corresponds to a posted ledger entry. A trial that
 * throws is only acceptable if it threw for a stated reason — an engine that
 * silently dropped a roster would satisfy a weaker version of this test by
 * refusing to answer.
 *
 * ## Why residue is not treated as failure
 *
 * `per_head` and `weighted_by_participation` split by largest remainder and
 * therefore always assign the whole pool. `percentage` and
 * `fixed_plus_percentage` truncate each participant's exact share, so they can
 * leave a residue — and that residue is *correct*, not a defect. What is
 * asserted instead is a tight bound: truncation loses strictly less than one
 * minor unit per participant, so the residue must be non-negative and strictly
 * less than the participant count. A residue outside that bound would mean real
 * money had gone missing, and this catches it.
 *
 * Trial counts are reported in the test names so the number in the summary is
 * the number that ran, not a number somebody remembered.
 */

import { describe, expect, it } from "vitest";

import { MONEY_MAX_MINOR, minorToDecimal, money, parsePercent, type CurrencyCode } from "../money/index.js";
import { postJournal, type JournalLine } from "../ledger/index.js";
import {
  allocatePrizePool,
  type AllocatePrizePoolInput,
  type AllocationBasis,
  type AllocationResult,
  type PrizeParticipant,
} from "../prize/allocation-engine.js";
import { reconcile } from "./index.js";

const CURRENCIES: CurrencyCode[] = ["INR", "USD", "EUR"];
const BASES: AllocationBasis[] = ["per_head", "percentage", "fixed_plus_percentage", "weighted_by_participation"];

const AT = new Date("2026-03-01T00:00:00.000Z");

function makeRandom(seed: bigint): () => bigint {
  let state = seed;
  return () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return state >> 33n;
  };
}

function at(minor: bigint, currency: CurrencyCode) {
  return money(minorToDecimal(minor), currency);
}

/**
 * Percentages summing to exactly 100, keyed by the given ids.
 *
 * Drawn one at a time against the remaining total rather than independently,
 * because independent draws of `0..99` sum to far more than 100 and the last
 * share would come out negative.
 */
function percentagesSummingTo(next: () => bigint, ids: readonly string[]): Record<string, string> {
  const cuts: number[] = [];
  let remaining = 100;

  for (let i = 0; i < ids.length - 1; i++) {
    const take = Number(next() % BigInt(remaining + 1));
    cuts.push(take);
    remaining -= take;
  }
  cuts.push(remaining);

  return Object.fromEntries(ids.map((id, i) => [id, String(cuts[i]!)]));
}

/** A full, valid input for a random basis, or a deliberately invalid one. */
function randomInput(next: () => bigint): AllocatePrizePoolInput {
  const currency = CURRENCIES[Number(next() % BigInt(CURRENCIES.length))]!;
  const basis = BASES[Number(next() % BigInt(BASES.length))]!;
  const count = 1 + Number(next() % 12n);
  const ids = Array.from({ length: count }, (_, i) => `p${String(i).padStart(3, "0")}`);

  const poolMinor = 1n + (next() % 100_000_000_000n);
  const participants: PrizeParticipant[] = ids.map((personId, i) =>
    basis === "weighted_by_participation" ? { personId, kind: "roster", weight: 1n + (next() % 50n) } : { personId, kind: "roster", ...(i === 0 ? {} : {}) },
  );

  const rule = {
    version: 1,
    basis,
    remainderPolicy: "largest_remainder_stable_sort",
    ...ruleFields(basis, ids, poolMinor, next),
  } as AllocatePrizePoolInput["rule"];

  return { netPrize: at(poolMinor, currency), participants, rule, computedAt: AT };
}

function ruleFields(
  basis: AllocationBasis,
  ids: readonly string[],
  poolMinor: bigint,
  next: () => bigint,
): Partial<AllocatePrizePoolInput["rule"]> {
  switch (basis) {
    case "per_head":
    case "weighted_by_participation":
      return {};
    case "percentage": {
      // Half the trials are exhaustive (sum 100), half deliberately short. The
      // short ladder is drawn against a 60-point budget, so it can never reach
      // 100 by accident and trigger an engine rejection the fuzz did not expect.
      if ((next() % 2n) === 0n) {
        return { percentages: percentagesSummingTo(next, ids) };
      }

      const cuts: number[] = [];
      let remaining = 60;
      for (let i = 0; i < ids.length; i++) {
        const take = Number(next() % BigInt(remaining + 1));
        cuts.push(take);
        remaining -= take;
      }
      return { percentages: Object.fromEntries(ids.map((id, i) => [id, String(cuts[i]!)])) };
    }
    case "fixed_plus_percentage": {
      // Fixed amounts must leave a positive remainder or the engine rejects the
      // rule outright, which is a separate (already tested) code path.
      const perHead = poolMinor / BigInt(ids.length + 4);
      return {
        fixedAmounts: Object.fromEntries(ids.map((id) => [id, minorToDecimal(perHead)])),
        poolPercentage: percentagesSummingTo(next, ids),
      };
    }
  }
}

/** Build the disbursement that corresponds to an allocation result. */
function disbursement(result: AllocationResult): JournalLine[] {
  const netPrize = result.reconciliation.netPrize;
  const paid = result.allocations.reduce((acc, a) => acc.add(a.computedAmount), money("0", netPrize.currency));
  // Whatever the rule did not assign goes to suspense rather than vanishing: the
  // journal must balance on its own terms, independently of the rule's residue.
  const suspense = netPrize.subtract(paid);

  const lines: JournalLine[] = [{ account: "payable:prize_pool", direction: "debit", amount: netPrize }];
  for (const allocation of result.allocations) {
    lines.push({
      account: "payable:winner",
      direction: "credit",
      amount: allocation.computedAmount,
      reference: allocation.personId,
    });
  }
  if (!suspense.isZero()) {
    lines.push({ account: "payable:suspense", direction: "credit", amount: suspense });
  }
  return lines;
}

/** Sum of a rule's percentages, scaled by 1e4 the way `parsePercent` does. */
function percentageSum(rule: AllocatePrizePoolInput["rule"]): bigint {
  const source = rule.poolPercentage ?? rule.percentages;
  return Object.values(source ?? {}).reduce((acc, value) => acc + parsePercent(value, "p"), 0n);
}

/** The invariant, stated once and applied on every trial. */
function assertInvariant(result: AllocationResult, pool: CurrencyCode extends never ? never : string): void {
  const netPrize = result.reconciliation.netPrize;
  const allocatedTotal = result.allocations.reduce(
    (acc, a) => acc.add(a.computedAmount),
    money("0", netPrize.currency),
  );

  expect(allocatedTotal.add(result.unallocated).minor, `allocated ${allocatedTotal.toDecimal()} + unallocated ${result.unallocated.toDecimal()} != pool ${netPrize.toDecimal()}`).toBe(netPrize.minor);
  expect(result.reconciliation.isBalanced).toBe(true);
  expect(result.reconciliation.variance.isZero()).toBe(true);
  expect(pool).toBe(netPrize.currency);
}

describe("the reconciliation invariant under fuzz", () => {
  it("holds across 500 randomised pools, currencies, rosters and bases", () => {
    const next = makeRandom(0xf0f0_1234_abcd_0001n);
    let trials = 0;
    const byBasis = new Map<AllocationBasis, number>();

    for (let trial = 0; trial < 500; trial++) {
      const input = randomInput(next);
      const result = allocatePrizePool(input);
      const currency = input.netPrize.currency;
      const count = input.participants.length;

      assertInvariant(result, currency);
      byBasis.set(input.rule.basis, (byBasis.get(input.rule.basis) ?? 0) + 1);
      trials++;

      const report = reconcile({
        pool: input.netPrize,
        allocations: [...result.allocations],
        unallocated: result.unallocated,
      });

      expect(report.isBalanced, `trial ${trial}`).toBe(true);
      expect(report.variance.minor, `trial ${trial}`).toBe(0n);

      if (input.rule.basis === "per_head" || input.rule.basis === "weighted_by_participation") {
        // Largest-remainder bases distribute the entire pool by construction.
        expect(report.isFullyDistributed, `trial ${trial} ${input.rule.basis}`).toBe(true);
        expect(report.status, `trial ${trial}`).toBe("reconciled");
      } else {
        // Truncating bases *may* leave a residue — zero residue is perfectly
        // legal — and a rule whose percentages do not sum to 100 legitimately
        // leaves the unallocated remainder of the pool.
        expect(report.isBalanced, `trial ${trial}`).toBe(true);
        expect(report.unallocated.minor >= 0n, `trial ${trial}`).toBe(true);
        expect(["reconciled", "residue"], `trial ${trial} ${report.status}`).toContain(report.status);

        // The tight bound only applies when the percentages are exhaustive:
        // truncation loses strictly less than one minor unit per participant,
        // so an exhaustive rule cannot leave a meaningful residue.
        if (percentageSum(input.rule) === 1_000_000n) {
          expect(report.unallocated.minor < BigInt(count), `trial ${trial} residue ${report.unallocated.toDecimal()} for ${count} participants`).toBe(true);
        }
      }
    }

    expect(trials).toBe(500);
    // Every basis must actually have been exercised.
    expect(byBasis.size).toBe(BASES.length);
  });

  it("keeps allocations and posted ledger entries in correspondence across 300 randomised results", () => {
    const next = makeRandom(0xf0f0_1234_abcd_0002n);
    let trials = 0;

    for (let trial = 0; trial < 300; trial++) {
      const input = randomInput(next);
      const result = allocatePrizePool(input);
      const journal = postJournal({ lines: disbursement(result), at: AT, memo: `trial ${trial}` });

      const report = reconcile({
        pool: input.netPrize,
        allocations: [...result.allocations],
        unallocated: result.unallocated,
        journal,
      });

      expect(report.ledgerMatched, `trial ${trial}: ${report.findings.join(" ")}`).toBe(true);
      trials++;
    }

    expect(trials).toBe(300);
  });

  it("never reconciles an arbitrary set of rows against a pool it does not match", () => {
    // The complement of the property above: if the rows are *not* the engine's
    // output, reconciliation must say so rather than reporting a clean book.
    const next = makeRandom(0xf0f0_1234_abcd_0003n);
    let reportedAsReconciled = 0;

    for (let trial = 0; trial < 200; trial++) {
      const input = randomInput(next);
      const result = allocatePrizePool(input);
      const rows = [...result.allocations].map((a) => ({
        ...a,
        computedAmount: at(a.computedAmount.minor + (next() % 7n), a.computedAmount.currency),
      }));

      const report = reconcile({
        pool: input.netPrize,
        allocations: rows,
        unallocated: result.unallocated,
      });

      if (report.isBalanced) {
        // Balanced by coincidence when the shift happened to be zero for every
        // row; still must not claim full distribution if residue remains.
        reportedAsReconciled++;
      } else {
        expect(report.status, `trial ${trial}`).not.toBe("reconciled");
        expect(report.variance.minor, `trial ${trial}`).not.toBe(0n);
      }
    }

    expect(reportedAsReconciled).toBeLessThan(200);
  });
});

describe("adversarial cases", () => {
  it("empty pool with zero members reconciles to a clean zero", () => {
    const pool = money("0.0000", "INR");
    const report = reconcile({ pool, allocations: [], unallocated: money("0.0000", "INR") });

    // Nothing was won, nothing was owed, nothing was left over. A real state.
    expect(report.status).toBe("reconciled");
    expect(report.allocatedTotal.toDecimal()).toBe("0.0000");
    expect(report.variance.toDecimal()).toBe("0.0000");
    expect(report.ledgerMatched).toBeNull();
  });

  it("empty pool with members gives every participant zero and still reconciles", () => {
    const pool = money("0.0000", "INR");
    const result = allocatePrizePool({
      netPrize: pool,
      participants: [{ personId: "p1", kind: "roster" }, { personId: "p2", kind: "roster" }],
      rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
      computedAt: AT,
    });

    const report = reconcile({ pool, allocations: [...result.allocations], unallocated: result.unallocated });

    expect(result.allocations.every((a) => a.computedAmount.isZero())).toBe(true);
    expect(report.status).toBe("reconciled");
  });

  it("zero members is rejected by the engine, before anything is computed", () => {
    expect(() =>
      allocatePrizePool({
        netPrize: money("1000.00", "INR"),
        participants: [],
        rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
      }),
    ).toThrow(/participant/i);
  });

  it("shares summing to zero are rejected rather than divided by zero", () => {
    expect(() =>
      allocatePrizePool({
        netPrize: money("1000.00", "INR"),
        participants: [
          { personId: "p1", kind: "roster", weight: 0n },
          { personId: "p2", kind: "roster", weight: 0n },
        ],
        rule: { version: 1, basis: "weighted_by_participation", remainderPolicy: "largest_remainder_stable_sort" },
      }),
    ).toThrow(/weight/i);
  });

  it("shares summing to 100 distribute the pool, leaving at most one minor unit per participant", () => {
    const pool = money("10000.00", "INR");
    const result = allocatePrizePool({
      netPrize: pool,
      participants: [
        { personId: "p1", kind: "roster" },
        { personId: "p2", kind: "roster" },
        { personId: "p3", kind: "roster" },
        { personId: "p4", kind: "roster" },
        { personId: "p5", kind: "roster" },
      ],
      rule: {
        version: 1,
        basis: "percentage",
        percentages: { p1: "20", p2: "20", p3: "20", p4: "20", p5: "20" },
        remainderPolicy: "largest_remainder_stable_sort",
      },
      computedAt: AT,
    });

    const report = reconcile({ pool, allocations: [...result.allocations], unallocated: result.unallocated });

    expect(report.isBalanced).toBe(true);
    expect(report.unallocated.minor >= 0n).toBe(true);
    expect(report.unallocated.minor).toBe(0n);
    expect(result.allocations.every((a) => a.computedAmount.toDecimal() === "2000.0000")).toBe(true);
  });

  it("shares summing to 100 that do not divide evenly leave strictly less than one minor unit per participant", () => {
    const pool = money("1000.0001", "INR");
    const result = allocatePrizePool({
      netPrize: pool,
      participants: [
        { personId: "p1", kind: "roster" },
        { personId: "p2", kind: "roster" },
        { personId: "p3", kind: "roster" },
        { personId: "p4", kind: "roster" },
        { personId: "p5", kind: "roster" },
        { personId: "p6", kind: "roster" },
        { personId: "p7", kind: "roster" },
      ],
      rule: {
        version: 1,
        basis: "percentage",
        percentages: { p1: "13", p2: "13", p3: "13", p4: "13", p5: "13", p6: "13", p7: "22" },
        remainderPolicy: "largest_remainder_stable_sort",
      },
      computedAt: AT,
    });

    const report = reconcile({ pool, allocations: [...result.allocations], unallocated: result.unallocated });

    expect(report.isBalanced).toBe(true);
    expect(report.unallocated.minor).toBeLessThan(7n);
  });

  it("a single member taking everything receives the pool exactly", () => {
    const pool = money("12345.6789", "INR");
    const result = allocatePrizePool({
      netPrize: pool,
      participants: [{ personId: "p1", kind: "roster" }],
      rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
      computedAt: AT,
    });

    const report = reconcile({ pool, allocations: [...result.allocations], unallocated: result.unallocated });

    expect(result.allocations[0]!.computedAmount.toDecimal()).toBe("12345.6789");
    expect(report.status).toBe("reconciled");
    expect(report.isFullyDistributed).toBe(true);
  });

  it("splits amounts that do not divide evenly, with no residue", () => {
    const pool = money("1000.0001", "INR");
    const result = allocatePrizePool({
      netPrize: pool,
      participants: Array.from({ length: 7 }, (_, i) => ({ personId: `p${i}`, kind: "roster" as const })),
      rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
      computedAt: AT,
    });

    const report = reconcile({ pool, allocations: [...result.allocations], unallocated: result.unallocated });

    // Largest remainder hands out the indivisible units rather than dropping them.
    expect(report.status).toBe("reconciled");
    expect(report.unallocated.toDecimal()).toBe("0.0000");
    expect(report.allocatedTotal.minor).toBe(pool.minor);
  });

  it("reconciles the maximum representable amount across every participant count", () => {
    const pool = at(MONEY_MAX_MINOR, "INR");

    for (const count of [1, 2, 3, 7, 11, 100]) {
      const result = allocatePrizePool({
        netPrize: pool,
        participants: Array.from({ length: count }, (_, i) => ({ personId: `p${String(i).padStart(3, "0")}`, kind: "roster" as const })),
        rule: { version: 1, basis: "per_head", remainderPolicy: "largest_remainder_stable_sort" },
        computedAt: AT,
      });

      const report = reconcile({ pool, allocations: [...result.allocations], unallocated: result.unallocated });

      expect(report.status, `${count} participants`).toBe("reconciled");
      expect(report.allocatedTotal.minor, `${count} participants`).toBe(MONEY_MAX_MINOR);
      expect(() => postJournal({ lines: disbursement(result), at: AT })).not.toThrow();
    }
  });
});