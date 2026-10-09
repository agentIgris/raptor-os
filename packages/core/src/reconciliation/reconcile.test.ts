/**
 * Reconciliation.
 *
 * The phase criterion is one sentence: *the reconciliation invariant must hold
 * under fuzz*. This file pins the targeted cases that a fuzz would only hit by
 * luck; `fuzz.test.ts` runs the randomised sweep.
 *
 * Reconciliation never throws on imbalance. It **reports**, because a
 * reconciliation job that dies on the first bad row reports one defect instead
 * of all of them, and an operator needs the whole picture. `assertReconciled`
 * is the gate for callers that would rather fail loudly.
 */

import { describe, expect, it } from "vitest";

import { MONEY_MAX_MINOR, minorToDecimal, money } from "../money/index.js";
import { postJournal, type JournalLine } from "../ledger/index.js";
import { allocatePrizePool, type Allocation, type PrizeParticipant } from "../prize/allocation-engine.js";
import { assertReconciled, reconcile, type ReconciliationReport } from "./index.js";

const INR = "INR";
const USD = "USD";

const AT = new Date("2026-03-01T00:00:00.000Z");

const RULE = { version: 1, remainderPolicy: "largest_remainder_stable_sort" } as const;

function participants(...ids: string[]): PrizeParticipant[] {
  return ids.map((personId) => ({ personId, kind: "roster" as const }));
}

function allocate(
  pool: string,
  people: PrizeParticipant[],
  overrides: Partial<Parameters<typeof allocatePrizePool>[0]["rule"]> = {},
): { allocations: Allocation[]; unallocated: ReturnType<typeof money> } {
  const result = allocatePrizePool({
    netPrize: money(pool, INR),
    participants: people,
    rule: { ...RULE, basis: "per_head", ...overrides },
    computedAt: AT,
  });
  return { allocations: [...result.allocations], unallocated: result.unallocated };
}

/** A disbursement journal paying each allocation, balanced against the pool. */
function disbursement(allocations: readonly Allocation[]): JournalLine[] {
  const total = allocations.reduce((acc, a) => acc.add(a.computedAmount), money("0", INR));
  const lines: JournalLine[] = [
    { account: "payable:prize_pool", direction: "debit", amount: total },
  ];
  for (const allocation of allocations) {
    lines.push({
      account: "payable:winner",
      direction: "credit",
      amount: allocation.computedAmount,
      reference: allocation.personId,
    });
  }
  return lines;
}

describe("reconcile — pool invariant", () => {
  it("reports a clean reconciliation when the allocations consume the pool exactly", () => {
    const { allocations, unallocated } = allocate("1000.00", participants("p1", "p2", "p3"));
    const report = reconcile({ pool: money("1000.00", INR), allocations, unallocated });

    expect(report.status).toBe("reconciled");
    expect(report.isBalanced).toBe(true);
    expect(report.isFullyDistributed).toBe(true);
    expect(report.variance.toDecimal()).toBe("0.0000");
    expect(report.allocatedTotal.toDecimal()).toBe("1000.0000");
    expect(report.findings).toEqual([]);
  });

  it("reports residue when the rule left money unassigned", () => {
    const { allocations, unallocated } = allocate("1000.00", participants("p1", "p2"), {
      basis: "percentage",
      percentages: { p1: "30", p2: "30" },
    });
    const report = reconcile({ pool: money("1000.00", INR), allocations, unallocated });

    // The books still balance, but 400.00 was never assigned to anyone.
    expect(report.isBalanced).toBe(true);
    expect(report.isFullyDistributed).toBe(false);
    expect(report.status).toBe("residue");
    expect(report.unallocated.toDecimal()).toBe("400.0000");
    expect(report.explanation).toContain("residue");
  });

  it("reports over-allocation when the rows exceed the pool", () => {
    const { allocations } = allocate("1000.00", participants("p1", "p2"));
    const inflated = allocations.map((a) => ({ ...a, computedAmount: money("600.00", INR) }));
    const report = reconcile({ pool: money("1000.00", INR), allocations: inflated });

    expect(report.overDistributed).toBe(true);
    expect(report.status).toBe("over_allocated");
    expect(report.variance.toDecimal()).toBe("200.0000");
    expect(report.findings.join(" ")).toContain("1200.0000");
  });

  it("reports under-allocation when the rows fall short of the pool", () => {
    const { allocations } = allocate("1000.00", participants("p1", "p2"));
    const trimmed = allocations.map((a) => ({ ...a, computedAmount: money("400.00", INR) }));
    const report = reconcile({ pool: money("1000.00", INR), allocations: trimmed });

    expect(report.status).toBe("under_allocated");
    expect(report.variance.toDecimal()).toBe("-200.0000");
  });

  it("refuses to reconcile rows in a different currency from the pool", () => {
    const { allocations } = allocate("1000.00", participants("p1", "p2"));

    // Currency mixing throws rather than guessing, exactly as `Money.add` does.
    expect(() => reconcile({ pool: money("1000.00", USD), allocations })).toThrow(/currency/i);
  });

  it("reconciles a pool that fully distributed to a negative allocation", () => {
    // A clawback makes one allocation negative. That is legitimate as long as the
    // total still equals the pool — a residual, not a shortfall.
    const allocations: Allocation[] = [
      {
        personId: "p1",
        participantKind: "roster",
        basisAmount: money("1000.0000", INR),
        computedAmount: money("1100.00", INR),
        ruleVersion: 1,
        computedAt: AT,
        computedBy: "test",
        explanation: "adjusted up",
      },
      {
        personId: "p2",
        participantKind: "roster",
        basisAmount: money("1000.0000", INR),
        computedAmount: money("-100.00", INR),
        ruleVersion: 1,
        computedAt: AT,
        computedBy: "test",
        explanation: "clawback",
      },
    ];

    const report = reconcile({ pool: money("1000.00", INR), allocations });

    expect(report.status).toBe("reconciled");
    expect(report.isBalanced).toBe(true);
  });

  it("flags duplicate rows, which would double-count an entitlement", () => {
    const { allocations } = allocate("1000.00", participants("p1", "p2"));
    const report = reconcile({
      pool: money("1000.00", INR),
      allocations: [...allocations, { ...allocations[0]! }],
    });

    expect(report.status).toBe("over_allocated");
    expect(report.findings.join(" ")).toMatch(/duplicate/i);
  });
});

describe("reconcile — ledger correspondence", () => {
  it("confirms allocations correspond to posted entries", () => {
    const { allocations, unallocated } = allocate("1000.00", participants("p1", "p2", "p3"));
    const journal = postJournal({ lines: disbursement(allocations), at: AT });

    const report = reconcile({ pool: money("1000.00", INR), allocations, unallocated, journal });

    expect(report.ledgerMatched).toBe(true);
    expect(report.status).toBe("reconciled");
    expect(report.findings).toEqual([]);
  });

  it("flags an allocation with no posted entry", () => {
    const { allocations, unallocated } = allocate("1000.00", participants("p1", "p2", "p3"));
    const journal = postJournal({ lines: disbursement(allocations.slice(0, 2)), at: AT });

    const report = reconcile({ pool: money("1000.00", INR), allocations, unallocated, journal });

    expect(report.ledgerMatched).toBe(false);
    expect(report.status).toBe("ledger_mismatch");
    expect(report.findings.join(" ")).toContain("p3");
  });

  it("flags a ledger entry whose amount disagrees with the allocation", () => {
    const { allocations, unallocated } = allocate("1000.00", participants("p1", "p2"));

    // The ledger is balanced, the rows still sum to the pool — only the payment
    // disagrees with the entitlement. That is a ledger correspondence failure,
    // not a pool failure, and must not be filed as one.
    const journal = postJournal({
      lines: [
        { account: "payable:prize_pool", direction: "debit", amount: money("1000.00", INR) },
        { account: "payable:winner", direction: "credit", amount: allocations[0]!.computedAmount, reference: "p1" },
        { account: "payable:winner", direction: "credit", amount: money("499.99", INR), reference: "p2" },
        { account: "payable:fee", direction: "credit", amount: money("0.01", INR) },
      ],
      at: AT,
    });

    const report = reconcile({ pool: money("1000.00", INR), allocations, unallocated, journal });

    expect(report.isBalanced).toBe(true);
    expect(report.ledgerMatched).toBe(false);
    expect(report.status).toBe("ledger_mismatch");
    expect(report.findings.join(" ")).toContain("p2");
  });

  it("flags a journal whose lines carry no reference to attribute them", () => {
    const { allocations, unallocated } = allocate("1000.00", participants("p1", "p2"));
    const total = money("1000.00", INR);
    const journal = postJournal({
      lines: [
        { account: "payable:prize_pool", direction: "debit", amount: total },
        { account: "payable:winner", direction: "credit", amount: total },
      ],
      at: AT,
    });

    const report = reconcile({ pool: money("1000.00", INR), allocations, unallocated, journal });

    // The journal balances, but nothing in it can be attributed to p1 or p2, so
    // correspondence is unproven rather than proven.
    expect(report.ledgerMatched).toBe(false);
    expect(report.status).toBe("ledger_mismatch");
  });

  it("settles a player who was over-paid and then clawed back", () => {
    const { allocations, unallocated } = allocate("1000.00", participants("p1", "p2"));

    // p1 is credited 550 and debited 50, netting to the 500 owed. A player can
    // legitimately receive more than one movement, in either direction.
    const journal = postJournal({
      lines: [
        { account: "payable:prize_pool", direction: "debit", amount: money("1000.00", INR) },
        { account: "payable:winner", direction: "credit", amount: money("550.00", INR), reference: "p1" },
        { account: "payable:clawback", direction: "debit", amount: money("50.00", INR), reference: "p1" },
        { account: "payable:winner", direction: "credit", amount: money("500.00", INR), reference: "p2" },
      ],
      at: AT,
    });

    const report = reconcile({ pool: money("1000.00", INR), allocations, unallocated, journal });

    expect(report.ledgerMatched).toBe(true);
    expect(report.status).toBe("reconciled");
  });

  it("reports a null ledger verdict when no journal is supplied", () => {
    const { allocations, unallocated } = allocate("1000.00", participants("p1", "p2"));
    const report = reconcile({ pool: money("1000.00", INR), allocations, unallocated });

    // A pool can be reconciled before it is paid out. "Not checked" is a
    // different answer from "checked and passed", and must not look like it.
    expect(report.ledgerMatched).toBeNull();
    expect(report.status).toBe("reconciled");
  });
});

describe("assertReconciled", () => {
  it("passes a clean report", () => {
    const { allocations, unallocated } = allocate("1000.00", participants("p1", "p2"));
    const report = reconcile({ pool: money("1000.00", INR), allocations, unallocated });

    expect(() => assertReconciled(report)).not.toThrow();
  });

  it("throws on residue, naming the status", () => {
    const { allocations, unallocated } = allocate("1000.00", participants("p1", "p2"), {
      basis: "percentage",
      percentages: { p1: "30", p2: "30" },
    });
    const report = reconcile({ pool: money("1000.00", INR), allocations, unallocated });

    expect(() => assertReconciled(report)).toThrow(/residue/);
  });

  it("throws on an over-allocation and includes the findings", () => {
    const { allocations } = allocate("1000.00", participants("p1", "p2"));
    const report = reconcile({
      pool: money("1000.00", INR),
      allocations: allocations.map((a) => ({ ...a, computedAmount: money("900.00", INR) })),
    });

    expect(() => assertReconciled(report)).toThrow(/over_allocated/);
  });

  it("returns the report so it can be chained", () => {
    const { allocations, unallocated } = allocate("1000.00", participants("p1"));
    const report = reconcile({ pool: money("1000.00", INR), allocations, unallocated });

    expect(assertReconciled(report)).toBe(report);
  });
});

describe("reconcile — explanation", () => {
  it("states the figures a human can check by hand", () => {
    const { allocations, unallocated } = allocate("1000.00", participants("p1", "p2", "p3"));
    const report: ReconciliationReport = reconcile({ pool: money("1000.00", INR), allocations, unallocated });

    expect(report.explanation).toContain("1000.0000");
    expect(report.explanation).toContain("0.0000");
    expect(report.explanation).toMatch(/allocated/);
  });
});

describe("the maximum representable amount", () => {
  it("reconciles the largest amount numeric(18,4) can hold", () => {
    const max = money(minorToDecimal(MONEY_MAX_MINOR), INR);
    const result = allocatePrizePool({
      netPrize: max,
      participants: participants("p1", "p2", "p3"),
      rule: { ...RULE, basis: "per_head" },
      computedAt: AT,
    });

    const report = reconcile({ pool: max, allocations: [...result.allocations], unallocated: result.unallocated });

    expect(report.status).toBe("reconciled");
    expect(report.allocatedTotal.minor).toBe(MONEY_MAX_MINOR);
  });
});