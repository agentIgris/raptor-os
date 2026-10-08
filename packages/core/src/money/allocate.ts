/**
 * Integer-space allocation.
 *
 * All of these operate on `bigint` minor units. Nothing here uses floating
 * point, and nothing here reads a clock or a random source — the same inputs
 * always produce the same output, which is what makes a prize allocation
 * reproducible months later.
 */

export interface ShareNumerator {
  /** Stable identifier — the participant id. Also the tie-break key. */
  readonly key: string;
  /** Non-negative weight. */
  readonly numerator: bigint;
}

/**
 * Distribute `total` across `shares` proportionally, exactly.
 *
 * Uses the **largest remainder method**: every participant first receives the
 * floor of their exact share, then the indivisible residual units are handed
 * out one at a time, largest fractional remainder first. Ties break on `key`
 * ascending so the outcome does not depend on input order.
 *
 * Guarantees `sum(result) === total` exactly. This is the property that makes
 * the reconciliation invariant satisfiable.
 */
export function allocateByShareNumerators(total: bigint, shares: readonly ShareNumerator[]): Map<string, bigint> {
  if (shares.length === 0) {
    throw new Error("Cannot allocate across an empty share set");
  }

  for (const share of shares) {
    if (share.numerator < 0n) {
      throw new Error(`Share numerator for ${share.key} must not be negative`);
    }
  }

  const totalShares = shares.reduce((acc, share) => acc + share.numerator, 0n);
  if (totalShares <= 0n) {
    throw new Error("Share numerators must sum to a positive value");
  }

  const exact: { key: string; floor: bigint; remainder: bigint }[] = shares.map((share) => {
    const scaled = total * share.numerator;
    return { key: share.key, floor: scaled / totalShares, remainder: scaled % totalShares };
  });

  const distributed = exact.reduce((acc, entry) => acc + entry.floor, 0n);
  let residual = total - distributed;

  if (residual > 0n) {
    const byRemainder = [...exact].sort((a, b) => {
      if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    for (const entry of byRemainder) {
      if (residual === 0n) break;
      entry.floor += 1n;
      residual -= 1n;
    }
  }

  return new Map(exact.map((entry) => [entry.key, entry.floor]));
}

/** Split `total` into `count` equal parts, exactly. */
export function allocateByLargestRemainder(total: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`Participant count must be a positive integer, received ${count}`);
  }
  const shares: ShareNumerator[] = Array.from({ length: count }, (_, index) => ({
    key: String(index).padStart(12, "0"),
    numerator: 1n,
  }));
  const allocated = allocateByShareNumerators(total, shares);
  return shares.map((share) => allocated.get(share.key) ?? 0n);
}