/**
 * Replay from stored inputs — the "reproducible from stored inputs" criterion.
 *
 * An allocation is only reproducible if somebody can later prove it. That takes
 * two separate capabilities, and conflating them is the mistake this module
 * avoids:
 *
 * - **Verification** (`verifyAllocationSnapshot`) answers "were these rows
 *   tampered with?" *without re-deriving anything*. It recomputes the snapshot's
 *   hash from its own body, checks the rows against a digest recorded at compute
 *   time, confirms the rows cover exactly the frozen participant set, and
 *   confirms they still sum to the pool. This is cheap, runs in a scheduled job,
 *   and is the thing that actually detects tampering.
 *
 * - **Replay** (`replayAllocationFromSnapshot`) answers "would the engine produce
 *   these rows again?". It re-runs the allocation. This is expensive and it is
 *   *not* what verification does, because a verifier that re-derives its own
 *   answer cannot detect an error in the derivation it just repeated.
 *
 * ## Why the snapshot is sorted
 *
 * The snapshot canonicalises every set it stores — participants by id, rule
 * records by id. An input set has no order, so a snapshot whose hash moved when
 * a record happened to serialise in a different order would report a change
 * where none occurred, and a monitor that cries wolf gets switched off. Sorting
 * is what makes "the inputs changed" a meaningful signal.
 *
 * Amounts are stored as decimal **strings**, never as `number`, because the value
 * has to round-trip through `numeric(18,4)` in Postgres and back without losing
 * a digit on the way.
 *
 * ## What verification cannot catch
 *
 * Someone who can edit the snapshot *and* its stored hash, or the rows *and*
 * their digest, is beyond any check in this layer — the anchors live in the
 * database. What verification does guarantee is that unilateral tampering with
 * either side is detected, and that internally inconsistent stored data cannot
 * pass as a genuine computation.
 */

import { createHash } from "node:crypto";

import { money, type CurrencyCode } from "../money/index.js";
import {
  allocatePrizePool,
  type AllocatePrizePoolInput,
  type AllocationBasis,
  type ParticipantKind,
  type PrizeParticipant,
  type RemainderPolicy,
} from "../prize/allocation-engine.js";

/**
 * Bumped when the canonical shape changes.
 *
 * A snapshot written by an older build cannot be verified by a newer one unless
 * the schema tag is checked, so the tag is part of the hashed body rather than
 * documentation.
 */
export const SNAPSHOT_SCHEMA = "raptor/allocation-input/v1";

export interface SnapshotParticipant {
  readonly personId: string;
  readonly kind: ParticipantKind;
  /** `bigint` weights cannot survive JSON, so they are stored as decimal text. */
  readonly weight: string | null;
}

export interface SnapshotEntry {
  readonly personId: string;
  readonly value: string;
}

export interface SnapshotRule {
  readonly version: number;
  readonly basis: AllocationBasis;
  readonly percentages: readonly SnapshotEntry[];
  readonly fixedAmounts: readonly SnapshotEntry[];
  readonly poolPercentage: readonly SnapshotEntry[];
  readonly remainderPolicy: RemainderPolicy;
}

/** The record to persist. Everything needed to re-derive the allocation. */
export interface AllocationSnapshot {
  readonly schema: typeof SNAPSHOT_SCHEMA;
  readonly pool: { readonly decimal: string; readonly currency: CurrencyCode };
  readonly participants: readonly SnapshotParticipant[];
  readonly rule: SnapshotRule;
  readonly hash: string;
}

/**
 * The allocation row as persisted.
 *
 * Deliberately the minimum needed to audit an entitlement. `explanation` and
 * `computedAt` are not verified because they are narrative, not arithmetic.
 */
export interface StoredAllocationRow {
  readonly personId: string;
  readonly computedAmount: { readonly decimal: string; readonly currency: CurrencyCode };
  readonly ruleVersion: number;
}

/**
 * Build the canonical, order-stable input snapshot.
 *
 * `computedAt` and `computedBy` are excluded: they record *when* and *who*, not
 * what the rule was applied to, and including them would make the snapshot
 * differ between two runs that agree perfectly on the money.
 */
export function buildAllocationSnapshot(input: AllocatePrizePoolInput): AllocationSnapshot {
  const participants: SnapshotParticipant[] = [...input.participants]
    .map((p) => ({ personId: p.personId, kind: p.kind, weight: p.weight?.toString() ?? null }))
    .sort((a, b) => compareStrings(a.personId, b.personId));

  const body = {
    schema: SNAPSHOT_SCHEMA,
    pool: { decimal: input.netPrize.toDecimal(), currency: input.netPrize.currency },
    participants,
    rule: {
      version: input.rule.version,
      basis: input.rule.basis,
      percentages: toEntries(input.rule.percentages),
      fixedAmounts: toEntries(input.rule.fixedAmounts),
      poolPercentage: toEntries(input.rule.poolPercentage),
      remainderPolicy: input.rule.remainderPolicy,
    },
  } satisfies Omit<AllocationSnapshot, "hash">;

  return { ...body, hash: hashBody(body) };
}

/**
 * Recompute a snapshot's hash from its body.
 *
 * Independent of the `hash` field by construction, so passing a snapshot whose
 * hash was edited still returns the honest hash of what the snapshot *says*.
 * That asymmetry is the entire detection mechanism.
 */
export function allocationSnapshotHash(snapshot: AllocationSnapshot): string {
  return hashBody({
    schema: snapshot.schema,
    pool: snapshot.pool,
    participants: snapshot.participants,
    rule: snapshot.rule,
  });
}

/** Content hash over stored rows, sorted so row order cannot mask an edit. */
export function digestAllocationRows(rows: readonly StoredAllocationRow[]): string {
  const canonical = [...rows]
    .sort((a, b) => compareStrings(a.personId, b.personId))
    .map((r) => ({
      personId: r.personId,
      decimal: r.computedAmount.decimal,
      currency: r.computedAmount.currency,
      ruleVersion: r.ruleVersion,
    }));

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface VerifyAllocationInput {
  readonly snapshot: AllocationSnapshot;
  readonly rows: readonly StoredAllocationRow[];
  /** Digest recorded at compute time. Checked when present. */
  readonly rowsDigest?: string;
  /** Undistributed remainder recorded at compute time. */
  readonly unallocated?: { readonly decimal: string; readonly currency: CurrencyCode };
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly findings: readonly string[];
}

/**
 * Verify stored rows against a stored snapshot, without re-running anything.
 *
 * See the module comment for why this deliberately does not re-derive.
 */
export function verifyAllocationSnapshot(input: VerifyAllocationInput): VerificationResult {
  const { snapshot, rows } = input;
  const findings: string[] = [];

  if (snapshot.schema !== SNAPSHOT_SCHEMA) {
    // The declared type makes this comparison unreachable to the compiler, but
    // a snapshot read back from JSON is whatever the database stored, not
    // whatever this build declares. `String` keeps the runtime check honest
    // without pretending the compiler can see the row.
    findings.push(
      `Snapshot schema ${String(snapshot.schema)} is not ${String(SNAPSHOT_SCHEMA)}: it cannot be verified by this build.`,
    );
  }

  if (allocationSnapshotHash(snapshot) !== snapshot.hash) {
    findings.push(`Snapshot hash does not match its own contents: the snapshot was edited after it was written.`);
  }

  if (input.rowsDigest !== undefined && input.rowsDigest !== digestAllocationRows(rows)) {
    findings.push(`Row digest ${input.rowsDigest} does not match the stored rows: at least one row was edited.`);
  }

  const expectedPeople = snapshot.participants.map((p) => p.personId);
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.personId)) {
      findings.push(`Duplicate allocation row for ${row.personId}: one entitlement stored more than once.`);
      continue;
    }
    seen.add(row.personId);

    if (!expectedPeople.includes(row.personId)) {
      findings.push(`Row for ${row.personId} is not in the snapshot's frozen participant set: it was never entitled to anything.`);
    }
    if (row.ruleVersion !== snapshot.rule.version) {
      findings.push(`Row for ${row.personId} is stamped rule version ${row.ruleVersion}, but the snapshot's rule is version ${snapshot.rule.version}.`);
    }
    if (row.computedAmount.currency !== snapshot.pool.currency) {
      findings.push(`Row for ${row.personId} is in ${row.computedAmount.currency} but the pool was denominated in ${snapshot.pool.currency}.`);
    }
  }

  for (const personId of expectedPeople) {
    if (!seen.has(personId)) {
      findings.push(`No allocation row for ${personId}, who was in the frozen participant set.`);
    }
  }

  findings.push(...checkTotal(snapshot, rows, input.unallocated));

  return { ok: findings.length === 0, findings };
}

/**
 * The stored rows must still add up to the pool.
 *
 * This is the check that catches a coordinated edit of the amounts and the
 * digest, and it is the reason verification can detect tampering with rows even
 * when no digest was ever recorded.
 */
function checkTotal(
  snapshot: AllocationSnapshot,
  rows: readonly StoredAllocationRow[],
  unallocated: { decimal: string; currency: CurrencyCode } | undefined,
): string[] {
  const findings: string[] = [];
  const poolCurrency = snapshot.pool.currency;

  if (unallocated !== undefined && unallocated.currency !== poolCurrency) {
    findings.push(`Unallocated remainder is in ${unallocated.currency} but the pool was denominated in ${poolCurrency}.`);
    return findings;
  }

  const remainder = money(unallocated?.decimal ?? "0", poolCurrency);
  if (remainder.isNegative()) {
    findings.push(`Unallocated remainder ${remainder.toDecimal()} is negative: the pool would have been over-distributed.`);
    return findings;
  }

  let allocated = money("0", poolCurrency);
  for (const row of rows) {
    if (row.computedAmount.currency !== poolCurrency) {
      // Already reported; summing it would throw on the currency mismatch.
      continue;
    }
    allocated = allocated.add(money(row.computedAmount.decimal, poolCurrency));
  }

  const pool = money(snapshot.pool.decimal, poolCurrency);
  if (!allocated.add(remainder).equals(pool)) {
    findings.push(
      `Stored rows total ${allocated.toDecimal()} plus unallocated ${remainder.toDecimal()}, which does not equal the pool ${pool.toDecimal()}.`,
    );
  }

  return findings;
}

export interface ReplayOptions {
  readonly computedAt: Date;
  readonly computedBy?: string;
  /** Rows as stored, to be compared against the fresh computation. */
  readonly storedRows?: readonly StoredAllocationRow[];
}

export interface ReplayResult {
  readonly ok: boolean;
  readonly findings: readonly string[];
  readonly result: ReturnType<typeof allocatePrizePool>;
  readonly rows: readonly StoredAllocationRow[];
}

/**
 * Re-derive the allocation from the snapshot and compare it to the stored rows.
 *
 * The expensive check, and the one that proves *reproducibility* rather than
 * merely integrity. A snapshot is trusted input: if the snapshot itself was
 * edited, replay faithfully reproduces the edited inputs, which is exactly why
 * {@link verifyAllocationSnapshot} exists alongside it.
 */
export function replayAllocationFromSnapshot(snapshot: AllocationSnapshot, options: ReplayOptions): ReplayResult {
  const input = allocatePrizePool(toAllocateInput(snapshot, options));

  const rows: StoredAllocationRow[] = input.allocations.map((a) => ({
    personId: a.personId,
    computedAmount: { decimal: a.computedAmount.toDecimal(), currency: a.computedAmount.currency },
    ruleVersion: a.ruleVersion,
  }));

  const findings: string[] = [];

  if (options.storedRows !== undefined) {
    const byPerson = new Map(options.storedRows.map((r) => [r.personId, r]));
    for (const row of rows) {
      const stored = byPerson.get(row.personId);
      if (stored === undefined) {
        findings.push(`Replay produced a row for ${row.personId}, which was not stored.`);
        continue;
      }
      if (stored.computedAmount.decimal !== row.computedAmount.decimal) {
        findings.push(
          `Replay of ${row.personId} gives ${row.computedAmount.decimal} but ${stored.computedAmount.decimal} was stored.`,
        );
      }
      if (stored.ruleVersion !== row.ruleVersion) {
        findings.push(`Replay of ${row.personId} is rule version ${row.ruleVersion} but ${stored.ruleVersion} was stored.`);
      }
    }
    for (const stored of options.storedRows) {
      if (!rows.some((r) => r.personId === stored.personId)) {
        findings.push(`Stored row for ${stored.personId} has no counterpart in the replay.`);
      }
    }
  }

  return { ok: findings.length === 0, findings, result: input, rows };
}

// --- canonical helpers ------------------------------------------------------

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** Records become sorted arrays; `undefined` becomes an empty list. */
function toEntries(record: Readonly<Record<string, string>> | undefined): SnapshotEntry[] {
  return Object.entries(record ?? {})
    .map(([personId, value]) => ({ personId, value }))
    .sort((a, b) => compareStrings(a.personId, b.personId));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toAllocateInput(snapshot: AllocationSnapshot, options: ReplayOptions): AllocatePrizePoolInput {
  const participants: PrizeParticipant[] = snapshot.participants.map((p) => ({
    personId: p.personId,
    kind: p.kind,
    ...(p.weight === null ? {} : { weight: BigInt(p.weight) }),
  }));

  return {
    netPrize: money(snapshot.pool.decimal, snapshot.pool.currency),
    participants,
    rule: {
      version: snapshot.rule.version,
      basis: snapshot.rule.basis,
      percentages: toRecord(snapshot.rule.percentages),
      fixedAmounts: toRecord(snapshot.rule.fixedAmounts),
      poolPercentage: toRecord(snapshot.rule.poolPercentage),
      remainderPolicy: snapshot.rule.remainderPolicy,
    },
    computedAt: options.computedAt,
    ...(options.computedBy === undefined ? {} : { computedBy: options.computedBy }),
  };
}

function toRecord(entries: readonly SnapshotEntry[]): Record<string, string> {
  return Object.fromEntries(entries.map((e) => [e.personId, e.value]));
}