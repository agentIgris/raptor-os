/**
 * Reconciliation — the check that the books tell one story.
 *
 * Two questions are answered here, and they are different questions:
 *
 * 1. **Did the allocation consume the pool?** `Σ allocations + unallocated`
 *    must equal the distributable pool exactly, and the unallocated remainder
 *    must be zero for the money to have been fully assigned. A residue is not a
 *    rounding curiosity: it is money that exists in the ledger and belongs to
 *    nobody, which is precisely how an org ends up unable to answer "where did
 *    the 0.0001 go".
 *
 * 2. **Were those allocations actually paid?** Every allocation must correspond
 *    to posted ledger entries — matched by `reference`, and equal to the minor
 *    unit. An allocation row that balances against the pool but was never
 *    disbursed describes money that was promised and never moved, which is a
 *    very different defect from a rounding error and must not be filed as one.
 *
 * ## It reports, it does not throw
 *
 * `reconcile` returns a {@link ReconciliationReport} for every imbalance. A
 * reconciliation run that dies on the first bad row reports one defect instead
 * of all of them, and an operator debugging a quarter-end close needs the whole
 * picture. Callers that want a gate use {@link assertReconciled}.
 *
 * The exception is a currency mismatch between the pool and its rows: that is a
 * programming error rather than a finding, and it throws exactly as `Money.add`
 * does, because inventing a rate nobody agreed to is the thing this domain
 * exists to prevent.
 *
 * Pure: no clock, no database, no network.
 */

import type { CurrencyCode, Money } from "../money/index.js";
import { minorToDecimal, money, zero } from "../money/index.js";
import type { PostedJournal } from "../ledger/index.js";
import type { Allocation } from "../prize/allocation-engine.js";

export type ReconciliationStatus =
  | "reconciled"
  | "residue"
  | "over_allocated"
  | "under_allocated"
  | "ledger_mismatch";

export interface ReconcileInput {
  /** The distributable pool the rule was applied to. */
  readonly pool: Money;
  /** Rows produced by the allocation engine, as stored. */
  readonly allocations: readonly Allocation[];
  /** Money the rule left unassigned. Defaults to zero. */
  readonly unallocated?: Money;
  /**
   * The posted disbursement, when one exists.
   *
   * Optional because a pool is routinely reconciled before it is paid out. The
   * report says `null` in that case — "not checked" is a different answer from
   * "checked and passed", and must not be rendered as a tick.
   */
  readonly journal?: PostedJournal;
}

export interface ReconciliationReport {
  readonly status: ReconciliationStatus;
  readonly pool: Money;
  readonly allocatedTotal: Money;
  readonly unallocated: Money;
  /** `allocatedTotal + unallocated − pool`. Zero when the books balance. */
  readonly variance: Money;
  /** The variance is zero. */
  readonly isBalanced: boolean;
  /** No residue: the whole distributable pool was assigned to somebody. */
  readonly isFullyDistributed: boolean;
  /** The rows alone exceed the pool. */
  readonly overDistributed: boolean;
  /** `null` when no journal was supplied. */
  readonly ledgerMatched: boolean | null;
  /** One line per defect, in words an operator can act on. */
  readonly findings: readonly string[];
  readonly explanation: string;
}

export function reconcile(input: ReconcileInput): ReconciliationReport {
  const { pool, allocations } = input;
  const unallocated = input.unallocated ?? zero(pool.currency);
  const journal = input.journal;

  const findings: string[] = [];
  const duplicates = findDuplicatePersonIds(allocations);
  for (const personId of duplicates) {
    findings.push(`Duplicate allocation row for ${personId}: the same entitlement is counted more than once.`);
  }

  const allocatedTotal = allocations.reduce<Money>((acc, allocation) => acc.add(allocation.computedAmount), zero(pool.currency));
  const variance = allocatedTotal.add(unallocated).subtract(pool);

  const isBalanced = variance.isZero();
  const overDistributed = allocatedTotal.compare(pool) > 0;
  const isFullyDistributed = isBalanced && unallocated.isZero();

  if (!isBalanced) {
    findings.push(
      `Allocated ${allocatedTotal.toDecimal()} plus unallocated ${unallocated.toDecimal()} does not equal the pool ${pool.toDecimal()}; variance ${variance.toDecimal()}.`,
    );
  } else if (!isFullyDistributed) {
    findings.push(`Residue of ${unallocated.toDecimal()} was never assigned to anyone.`);
  }

  const ledgerMatched = journal === undefined ? null : matchLedger(allocations, journal, findings);

  const status: ReconciliationStatus = !isBalanced
    ? overDistributed
      ? "over_allocated"
      : "under_allocated"
    : ledgerMatched === false
      ? "ledger_mismatch"
      : isFullyDistributed
        ? "reconciled"
        : "residue";

  return {
    status,
    pool,
    allocatedTotal,
    unallocated,
    variance,
    isBalanced,
    isFullyDistributed,
    overDistributed,
    ledgerMatched,
    findings,
    explanation: buildExplanation({ status, pool, allocatedTotal, unallocated, variance, ledgerMatched }),
  };
}

/**
 * The gate form of {@link reconcile}.
 *
 * Returns the report unchanged so it can be chained, and throws otherwise. Used
 * where a caller would rather stop than publish an unreconciled result.
 */
export function assertReconciled(report: ReconciliationReport): ReconciliationReport {
  if (report.status !== "reconciled") {
    // A non-reconciled report always carries at least one finding, so the
    // message is never empty: the operator gets the reason, not just the status.
    throw new Error(`Reconciliation failed with status ${report.status}: ${report.findings.join(" ")}`);
  }
  return report;
}

function findDuplicatePersonIds(allocations: readonly Allocation[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const allocation of allocations) {
    if (seen.has(allocation.personId)) {
      duplicates.add(allocation.personId);
    }
    seen.add(allocation.personId);
  }
  return [...duplicates].sort();
}

/**
 * Correspondence between allocations and posted entries.
 *
 * ## Which direction counts as "paid"
 *
 * Settling what is owed to a player **credits their payable**, so the settled
 * figure is `credits − debits` against that person's reference. The comparison
 * is signed, not absolute: a reversing entry nets out and therefore does *not*
 * match an allocation, which is the whole point — otherwise a correction posted
 * to fix a payment would be read as evidence that the payment happened.
 *
 * Net rather than gross across lines, because paying a player in two lines is
 * one payment, and an org that splits a transfer into principal and fee must not
 * fail reconciliation for its own bookkeeping.
 */
function matchLedger(allocations: readonly Allocation[], journal: PostedJournal, findings: string[]): boolean {
  // Currency travels with the figure, so the two can never drift apart.
  const settled = new Map<string, { minor: bigint; currency: CurrencyCode }>();

  for (const line of journal.lines) {
    if (line.reference === undefined) {
      continue;
    }
    const delta = line.direction === "credit" ? line.amount.minor : -line.amount.minor;
    const current = settled.get(line.reference) ?? { minor: 0n, currency: line.amount.currency };
    settled.set(line.reference, { minor: current.minor + delta, currency: current.currency });
  }

  let matched = true;

  for (const allocation of allocations) {
    const posted = settled.get(allocation.personId);
    if (posted === undefined) {
      findings.push(`Allocation for ${allocation.personId} has no posted ledger entry referencing them.`);
      matched = false;
      continue;
    }

    if (posted.minor !== allocation.computedAmount.minor) {
      findings.push(
        `Allocation for ${allocation.personId} is ${allocation.computedAmount.toDecimal()} but the ledger settled ${money(minorToDecimal(posted.minor), posted.currency).toDecimal()}.`,
      );
      matched = false;
    }
  }

  return matched;
}

function buildExplanation(args: {
  readonly status: ReconciliationStatus;
  readonly pool: Money;
  readonly allocatedTotal: Money;
  readonly unallocated: Money;
  readonly variance: Money;
  readonly ledgerMatched: boolean | null;
}): string {
  const { status, pool, allocatedTotal, unallocated, variance, ledgerMatched } = args;

  const ledger =
    ledgerMatched === null
      ? "No ledger journal was supplied, so disbursement was not checked."
      : ledgerMatched
        ? "Every allocation corresponds to a posted ledger entry."
        : "At least one allocation does not correspond to a posted ledger entry.";

  if (status === "reconciled") {
    return `Reconciled: allocated ${allocatedTotal.toDecimal()} of pool ${pool.toDecimal()} with no variance (${variance.toDecimal()}). ${ledger}`;
  }

  return `Not reconciled (${status}): allocated ${allocatedTotal.toDecimal()} plus unallocated ${unallocated.toDecimal()} against pool ${pool.toDecimal()}, variance ${variance.toDecimal()}. ${ledger}`;
}