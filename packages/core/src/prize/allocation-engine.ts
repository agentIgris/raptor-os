/**
 * Prize allocation engine.
 *
 * The product's differentiator: given a prize pool and the roster as it stood
 * **at the moment of the event**, compute who is owed what, in a way that can be
 * reproduced and explained to a player who disputes it.
 *
 * Design constraints, all from the design spec:
 *
 * - **Deterministic** — same inputs, same output, always. No clock, no random,
 *   no dictionary ordering. All arithmetic is integer `bigint`.
 * - **Reproducible** — the rule version and a frozen participant set are stamped
 *   on every allocation, so a later roster correction cannot silently rewrite
 *   history.
 * - **Explainable** — the derivation is computed once and persisted. It is never
 *   re-derived from the rule at read time, because that would drift.
 * - **Immutable** — corrections are new `Adjustment` rows. Allocations are never
 *   updated.
 *
 * This module is pure: no database, no clock unless the caller supplies one, no
 * network. That is deliberate — it is the only way these rules can be exhaustively
 * tested.
 */

import { createHash } from "node:crypto";

import {
  allocateByShareNumerators,
  minorToDecimal,
  money,
  parsePercent,
  zero,
  type CurrencyCode,
  type Money,
} from "../money/index.js";

export type AllocationBasis =
  | "percentage"
  | "per_head"
  | "fixed_plus_percentage"
  | "weighted_by_participation";

export type ParticipantKind = "roster" | "staff";

export interface PrizeParticipant {
  readonly personId: string;
  readonly kind: ParticipantKind;
  /** Required only for `weighted_by_participation`. */
  readonly weight?: bigint;
}

/**
 * How indivisible units are distributed.
 *
 * There is deliberately exactly one policy. A configurable remainder policy would
 * make historical allocations non-reproducible across policy changes.
 */
export type RemainderPolicy = "largest_remainder_stable_sort";

export interface AllocationRule {
  /** Immutable version stamp. Persisted on every allocation. */
  readonly version: number;
  readonly basis: AllocationBasis;
  /** Required for `percentage`: personId -> percent. May sum to less than 100. */
  readonly percentages?: Readonly<Record<string, string>>;
  /** Required for `fixed_plus_percentage`: personId -> amount. */
  readonly fixedAmounts?: Readonly<Record<string, string>>;
  /** Required for `fixed_plus_percentage`: personId -> percent of the remainder. */
  readonly poolPercentage?: Readonly<Record<string, string>>;
  readonly remainderPolicy: RemainderPolicy;
}

export interface Allocation {
  readonly personId: string;
  readonly participantKind: ParticipantKind;
  /** The pool this draw was made against, before this participant's share. */
  readonly basisAmount: Money;
  /** The entitlement awarded. */
  readonly computedAmount: Money;
  readonly ruleVersion: number;
  readonly computedAt: Date;
  readonly computedBy: string;
  /** Persisted human-readable derivation, for disputes. */
  readonly explanation: string;
}

export interface Reconciliation {
  readonly netPrize: Money;
  readonly allocatedTotal: Money;
  /** Money the rule did not assign to anyone (e.g. percentages summing below 100). */
  readonly unallocated: Money;
  /** allocatedTotal + unallocated - netPrize. Zero when the books balance. */
  readonly variance: Money;
  readonly isBalanced: boolean;
  readonly explanation: string;
}

export interface AllocationResult {
  readonly allocations: readonly Allocation[];
  readonly reconciliation: Reconciliation;
  readonly unallocated: Money;
  /** Content hash of every input, so a divergent re-run can be rejected. */
  readonly inputHash: string;
}

export interface AllocatePrizePoolInput {
  readonly netPrize: Money;
  readonly participants: readonly PrizeParticipant[];
  readonly rule: AllocationRule;
  readonly computedAt?: Date;
  readonly computedBy?: string;
}

const DEFAULT_COMPUTED_BY = "svc:allocation-engine";

export function allocatePrizePool(input: AllocatePrizePoolInput): AllocationResult {
  const { netPrize, participants, rule } = input;
  const computedAt = input.computedAt ?? new Date();
  const computedBy = input.computedBy ?? DEFAULT_COMPUTED_BY;

  assertParticipants(participants);

  if (netPrize.isNegative()) {
    throw new Error(`Refusing to allocate a negative net prize: ${formatMoney(netPrize)}`);
  }

  const inputHash = hashInputs(netPrize, participants, rule);

  const amounts = computeAmounts(netPrize, participants, rule);

  const allocations: Allocation[] = participants
    .map((participant) => {
      const basisAmount = amounts.basis.get(participant.personId) ?? zero(netPrize.currency);
      const shareMinor = amounts.shares.get(participant.personId) ?? 0n;
      const computedAmount = money(formatMinor(shareMinor), netPrize.currency);

      return {
        personId: participant.personId,
        participantKind: participant.kind,
        basisAmount,
        computedAmount,
        ruleVersion: rule.version,
        computedAt,
        computedBy,
        explanation: explainAllocation({
          personId: participant.personId,
          basis: rule.basis,
          netPrize,
          basisAmount,
          computedAmount,
          participantCount: participants.length,
          fixed: amounts.fixed.get(participant.personId) ?? zero(netPrize.currency),
        }),
      };
    })
    // Stable output order regardless of input order.
    .sort((a, b) => (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0));

  const allocatedTotal = allocations.reduce<Money>((acc, allocation) => acc.add(allocation.computedAmount), zero(netPrize.currency));
  const unallocated = amounts.unallocated;
  const variance = allocatedTotal.add(unallocated).subtract(netPrize);

  return {
    allocations,
    unallocated,
    inputHash,
    reconciliation: buildReconciliation(netPrize, allocatedTotal, unallocated, variance),
  };
}

interface ComputedAmounts {
  /** Final award per participant, in minor units. */
  readonly shares: Map<string, bigint>;
  /** The pool figure this participant's share was drawn against. */
  readonly basis: Map<string, Money>;
  /** Any fixed component taken off the pool before percentage allocation. */
  readonly fixed: Map<string, Money>;
  readonly unallocated: Money;
}

function computeAmounts(netPrize: Money, participants: readonly PrizeParticipant[], rule: AllocationRule): ComputedAmounts {
  switch (rule.basis) {
    case "per_head":
      return computePerHead(netPrize, participants);
    case "percentage":
      return computePercentage(netPrize, participants, rule);
    case "fixed_plus_percentage":
      return computeFixedPlusPercentage(netPrize, participants, rule);
    case "weighted_by_participation":
      return computeWeighted(netPrize, participants);
  }
}

function computePerHead(netPrize: Money, participants: readonly PrizeParticipant[]): ComputedAmounts {
  const shares = allocateByShareNumerators(
    netPrize.minor,
    participants.map((p) => ({ key: p.personId, numerator: 1n })),
  );

  return {
    shares,
    basis: new Map(participants.map((p) => [p.personId, netPrize])),
    fixed: new Map(participants.map((p) => [p.personId, zero(netPrize.currency)])),
    unallocated: zero(netPrize.currency),
  };
}

function computePercentage(netPrize: Money, participants: readonly PrizeParticipant[], rule: AllocationRule): ComputedAmounts {
  const percentages = rule.percentages ?? {};
  const parsed = new Map<string, bigint>();

  for (const participant of participants) {
    const raw = percentages[participant.personId];
    if (raw === undefined) {
      throw new Error(`No percentage defined for participant ${participant.personId}`);
    }
    parsed.set(participant.personId, parsePercent(raw, `percentage for ${participant.personId}`));
  }

  assertPercentagesWithinBounds(parsed, rule.basis);

  const shares = new Map<string, bigint>();
  for (const [personId, percent] of parsed) {
    shares.set(personId, (netPrize.minor * percent) / 1_000_000n);
  }

  const allocated = [...shares.values()].reduce((acc, value) => acc + value, 0n);

  return {
    shares,
    basis: new Map(participants.map((p) => [p.personId, netPrize])),
    fixed: new Map(participants.map((p) => [p.personId, zero(netPrize.currency)])),
    unallocated: money(formatMinor(netPrize.minor - allocated), netPrize.currency),
  };
}

function computeFixedPlusPercentage(
  netPrize: Money,
  participants: readonly PrizeParticipant[],
  rule: AllocationRule,
): ComputedAmounts {
  const fixedAmounts = rule.fixedAmounts ?? {};
  const poolPercentage = rule.poolPercentage ?? {};

  const fixed = new Map<string, bigint>();
  const fixedMoney = new Map<string, Money>();
  for (const participant of participants) {
    const raw = fixedAmounts[participant.personId] ?? "0";
    const value = money(raw, netPrize.currency);
    fixed.set(participant.personId, value.minor);
    fixedMoney.set(participant.personId, value);
  }

  const fixedTotal = [...fixed.values()].reduce((acc, value) => acc + value, 0n);
  if (fixedTotal > netPrize.minor) {
    throw new Error(
      `Rule ${rule.version} over-allocates: fixed amounts total ${formatMinor(fixedTotal)} but the pool is only ${formatMoney(netPrize)}`,
    );
  }

  const percentages = new Map<string, bigint>();
  for (const participant of participants) {
    const raw = poolPercentage[participant.personId];
    if (raw === undefined) {
      throw new Error(`No pool percentage defined for participant ${participant.personId}`);
    }
    percentages.set(participant.personId, parsePercent(raw, `pool percentage for ${participant.personId}`));
  }

  assertPercentagesWithinBounds(percentages, rule.basis);

  const remainder = netPrize.minor - fixedTotal;

  const shares = new Map<string, bigint>();
  const basis = new Map<string, Money>();
  for (const participant of participants) {
    const percent = percentages.get(participant.personId) ?? 0n;
    const fromPool = (remainder * percent) / 1_000_000n;
    basis.set(participant.personId, money(formatMinor(fromPool), netPrize.currency));
    shares.set(participant.personId, (fixed.get(participant.personId) ?? 0n) + fromPool);
  }

  const allocated = [...shares.values()].reduce((acc, value) => acc + value, 0n);

  return {
    shares,
    basis,
    fixed: fixedMoney,
    unallocated: money(formatMinor(netPrize.minor - allocated), netPrize.currency),
  };
}

function computeWeighted(netPrize: Money, participants: readonly PrizeParticipant[]): ComputedAmounts {
  const weights: { key: string; numerator: bigint }[] = [];

  for (const participant of participants) {
    if (participant.weight === undefined) {
      throw new Error(`Participant ${participant.personId} has no weight for weighted_by_participation`);
    }
    weights.push({ key: participant.personId, numerator: participant.weight });
  }

  if (weights.every((entry) => entry.numerator === 0n)) {
    throw new Error("weighted_by_participation requires at least one positive weight");
  }

  const shares = allocateByShareNumerators(netPrize.minor, weights);

  return {
    shares,
    basis: new Map(participants.map((p) => [p.personId, netPrize])),
    fixed: new Map(participants.map((p) => [p.personId, zero(netPrize.currency)])),
    unallocated: zero(netPrize.currency),
  };
}

export interface Adjustment {
  readonly personId: string;
  readonly amount: Money;
  readonly reason: string;
}

export interface ApplyAdjustmentInput {
  readonly previous: AllocationResult;
  readonly adjustments: readonly Adjustment[];
  readonly computedAt?: Date;
  readonly computedBy?: string;
}

/**
 * Re-apply a set of adjustments on top of a previous allocation.
 *
 * The previous allocations are treated as immutable: new `Allocation` rows are
 * produced and the originals are never mutated. Reconciliation is recomputed, so
 * an adjustment that pushes the pool out of balance is visible rather than
 * silently absorbed.
 */
export function applyAdjustment(input: ApplyAdjustmentInput): AllocationResult {
  const { previous, adjustments } = input;
  const computedAt = input.computedAt ?? new Date();
  const computedBy = input.computedBy ?? DEFAULT_COMPUTED_BY;

  const known = new Set(previous.allocations.map((a) => a.personId));
  const currency: CurrencyCode = previous.reconciliation.netPrize.currency;

  const delta = new Map<string, Money>();
  for (const adjustment of adjustments) {
    if (!known.has(adjustment.personId)) {
      throw new Error(`Adjustment targets unknown participant ${adjustment.personId}`);
    }
    const existing = delta.get(adjustment.personId) ?? zero(currency);
    delta.set(adjustment.personId, existing.add(adjustment.amount));
  }

  const allocations: Allocation[] = previous.allocations.map((allocation) => {
    const change = delta.get(allocation.personId);
    if (change === undefined) return allocation;

    const computedAmount = allocation.computedAmount.add(change);

    return {
      ...allocation,
      computedAmount,
      computedAt,
      computedBy,
      explanation: `${allocation.explanation}\nAdjustment: ${formatMoney(change)} applied.`,
    };
  });

  const allocatedTotal = allocations.reduce<Money>((acc, a) => acc.add(a.computedAmount), zero(currency));
  const variance = allocatedTotal.add(previous.unallocated).subtract(previous.reconciliation.netPrize);

  return {
    allocations,
    unallocated: previous.unallocated,
    inputHash: previous.inputHash,
    reconciliation: buildReconciliation(previous.reconciliation.netPrize, allocatedTotal, previous.unallocated, variance),
  };
}

function assertParticipants(participants: readonly PrizeParticipant[]): void {
  if (participants.length === 0) {
    throw new Error("Cannot allocate a prize pool with no participants");
  }

  const seen = new Set<string>();
  for (const participant of participants) {
    if (seen.has(participant.personId)) {
      throw new Error(`Duplicate participant ${participant.personId} in the allocation set`);
    }
    seen.add(participant.personId);
  }
}

function assertPercentagesWithinBounds(percentages: ReadonlyMap<string, bigint>, basis: AllocationBasis): void {
  const total = [...percentages.values()].reduce((acc, value) => acc + value, 0n);
  if (total > 1_000_000n) {
    throw new Error(
      `Rule using ${basis} over-allocates: percentages sum to ${total / 10_000n}% which exceeds 100%`,
    );
  }
}

function buildReconciliation(netPrize: Money, allocatedTotal: Money, unallocated: Money, variance: Money): Reconciliation {
  const isBalanced = variance.isZero();

  return {
    netPrize,
    allocatedTotal,
    unallocated,
    variance,
    isBalanced,
    explanation: isBalanced
      ? `Reconciled: allocated ${formatMoney(allocatedTotal)} + unallocated ${formatMoney(unallocated)} = net ${formatMoney(netPrize)}.`
      : `Reconciliation variance of ${formatMoney(variance)}: allocated ${formatMoney(allocatedTotal)} + unallocated ${formatMoney(unallocated)} does not equal net ${formatMoney(netPrize)}.`,
  };
}

interface ExplainArgs {
  readonly personId: string;
  readonly basis: AllocationBasis;
  readonly netPrize: Money;
  readonly basisAmount: Money;
  readonly computedAmount: Money;
  readonly participantCount: number;
  readonly fixed: Money;
}

function explainAllocation(args: ExplainArgs): string {
  const { personId, basis, netPrize, basisAmount, computedAmount, participantCount, fixed } = args;

  if (basis === "per_head") {
    return (
      `${personId}: basis ${basis}; the net prize ${formatMoney(netPrize)} was divided equally ` +
      `between ${participantCount} participants, giving ${formatMoney(computedAmount)}.`
    );
  }

  if (basis === "weighted_by_participation") {
    return (
      `${personId}: basis ${basis}; the net prize ${formatMoney(netPrize)} was divided in proportion to ` +
      `recorded participation weight, giving ${formatMoney(computedAmount)}.`
    );
  }

  if (basis === "percentage") {
    return (
      `${personId}: basis ${basis}; ${formatMoney(basisAmount)} of the net prize ${formatMoney(netPrize)} ` +
      `was the participant's stated percentage, giving ${formatMoney(computedAmount)}.`
    );
  }

  return (
    `${personId}: basis ${basis}; a fixed amount of ${formatMoney(fixed)} was taken from the pool, then ` +
    `${formatMoney(basisAmount)} was allocated from the remainder of ${formatMoney(netPrize)}, ` +
    `giving ${formatMoney(computedAmount)}.`
  );
}

function hashInputs(netPrize: Money, participants: readonly PrizeParticipant[], rule: AllocationRule): string {
  const canonical = {
    netPrize: netPrize.toDecimal(),
    currency: netPrize.currency,
    participants: [...participants]
      .map((p) => ({ personId: p.personId, kind: p.kind, weight: p.weight?.toString() ?? null }))
      .sort((a, b) => (a.personId < b.personId ? -1 : 1)),
    rule: {
      version: rule.version,
      basis: rule.basis,
      percentages: sortRecord(rule.percentages),
      fixedAmounts: sortRecord(rule.fixedAmounts),
      poolPercentage: sortRecord(rule.poolPercentage),
      remainderPolicy: rule.remainderPolicy,
    },
  };

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function sortRecord(record: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function formatMoney(value: Money): string {
  return value.toDecimal();
}

/**
 * Render a raw minor-unit bigint as a decimal string.
 *
 * Delegates to the canonical renderer in `money/`: this module, the surplus
 * split and `Money.toDecimal` all need this, and a private copy here was the
 * reason a negative amount could render two different ways in two modules.
 */
function formatMinor(minor: bigint): string {
  return minorToDecimal(minor);
}

export type { CurrencyCode };