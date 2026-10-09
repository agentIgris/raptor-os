/**
 * Replay from stored inputs.
 *
 * The phase criterion — *allocation reproducible from stored inputs* — is only
 * half a claim. The other half is: **how would anyone know?** An allocation that
 * can be re-derived is worth nothing if the re-derivation is never checked
 * against what was actually stored, because a tampered row and a correct row
 * look identical from inside the system.
 *
 * So this module produces two things:
 *
 * - {@link buildAllocationSnapshot} — the canonical, order-stable record of the
 *   inputs, safe to store. Its hash is stable across key order and participant
 *   order, because an input *set* has no order and a snapshot whose hash moved
 *   when a record was serialised in a different order would be useless for
 *   detecting a real change.
 * - {@link verifyAllocationSnapshot} — a check that runs **without re-deriving
 *   anything**. It confirms the snapshot was not edited, the rows were not
 *   edited, the rows cover exactly the frozen participant set, and the rows
 *   still sum to the pool. That last group of checks is what makes tampering
 *   detectable rather than merely improbable.
 *
 * {@link replayAllocationFromSnapshot} is the separate, expensive check: it
 * re-runs the engine. It is deliberately not what verification does.
 */

import { describe, expect, it } from "vitest";

import { allocatePrizePool, type AllocatePrizePoolInput } from "../prize/allocation-engine.js";
import { money } from "../money/index.js";
import {
  allocationSnapshotHash,
  buildAllocationSnapshot,
  digestAllocationRows,
  replayAllocationFromSnapshot,
  verifyAllocationSnapshot,
  type StoredAllocationRow,
} from "./index.js";

const INR = "INR";
const AT = new Date("2026-03-01T00:00:00.000Z");

function baseInput(): AllocatePrizePoolInput {
  return {
    netPrize: money("1000.00", INR),
    participants: [
      { personId: "p1", kind: "roster" },
      { personId: "p2", kind: "roster" },
      { personId: "p3", kind: "roster" },
    ],
    rule: {
      version: 4,
      basis: "percentage",
      percentages: { p1: "40", p2: "35", p3: "25" },
      remainderPolicy: "largest_remainder_stable_sort",
    },
    computedAt: AT,
    computedBy: "svc:test",
  };
}

/** The rows a database would persist for a given input. */
function storedRowsFor(input: AllocatePrizePoolInput): StoredAllocationRow[] {
  return allocatePrizePool(input).allocations.map((a) => ({
    personId: a.personId,
    computedAmount: { decimal: a.computedAmount.toDecimal(), currency: a.computedAmount.currency },
    ruleVersion: a.ruleVersion,
  }));
}

describe("buildAllocationSnapshot", () => {
  it("captures the pool, the frozen participant set and the rule", () => {
    const snapshot = buildAllocationSnapshot(baseInput());

    expect(snapshot.schema).toBe("raptor/allocation-input/v1");
    expect(snapshot.pool).toEqual({ decimal: "1000.0000", currency: INR });
    expect(snapshot.participants.map((p) => p.personId)).toEqual(["p1", "p2", "p3"]);
    expect(snapshot.rule.version).toBe(4);
    expect(snapshot.rule.basis).toBe("percentage");
    expect(snapshot.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sorts participants so input order does not change the hash", () => {
    const forwards = buildAllocationSnapshot(baseInput());
    const shuffled = buildAllocationSnapshot({
      ...baseInput(),
      participants: [...baseInput().participants].reverse(),
    });

    expect(shuffled.hash).toBe(forwards.hash);
    expect(shuffled.participants.map((p) => p.personId)).toEqual(["p1", "p2", "p3"]);
  });

  it("sorts percentage keys so record serialisation order does not change the hash", () => {
    const a = buildAllocationSnapshot(baseInput());
    const b = buildAllocationSnapshot({
      ...baseInput(),
      rule: {
        ...baseInput().rule,
        percentages: { p3: "25", p1: "40", p2: "35" },
      },
    });

    expect(b.hash).toBe(a.hash);
    expect(b.rule.percentages.map((p) => p.personId)).toEqual(["p1", "p2", "p3"]);
  });

  it("excludes the clock and the actor, which are not inputs to the rule", () => {
    const first = buildAllocationSnapshot(baseInput());
    const second = buildAllocationSnapshot({ ...baseInput(), computedAt: new Date(0), computedBy: "someone:else" });

    expect(second.hash).toBe(first.hash);
  });

  it("changes the hash when any input changes", () => {
    const base = buildAllocationSnapshot(baseInput());
    const biggerPool = buildAllocationSnapshot({ ...baseInput(), netPrize: money("1000.01", INR) });
    const newVersion = buildAllocationSnapshot({ ...baseInput(), rule: { ...baseInput().rule, version: 5 } });
    const fewerPeople = buildAllocationSnapshot({ ...baseInput(), participants: baseInput().participants.slice(0, 2) });

    expect(biggerPool.hash).not.toBe(base.hash);
    expect(newVersion.hash).not.toBe(base.hash);
    expect(fewerPeople.hash).not.toBe(base.hash);
  });

  it("records weights and fixed amounts for the bases that use them", () => {
    const snapshot = buildAllocationSnapshot({
      netPrize: money("10000.00", INR),
      participants: [
        { personId: "p1", kind: "staff", weight: 3n },
        { personId: "p2", kind: "roster", weight: 1n },
      ],
      rule: {
        version: 2,
        basis: "fixed_plus_percentage",
        fixedAmounts: { p2: "500.00", p1: "0.00" },
        poolPercentage: { p1: "25", p2: "75" },
        remainderPolicy: "largest_remainder_stable_sort",
      },
      computedAt: AT,
    });

    expect(snapshot.participants).toEqual([
      { personId: "p1", kind: "staff", weight: "3" },
      { personId: "p2", kind: "roster", weight: "1" },
    ]);
    expect(snapshot.rule.fixedAmounts).toEqual([
      { personId: "p1", value: "0.00" },
      { personId: "p2", value: "500.00" },
    ]);
    expect(snapshot.rule.poolPercentage.map((p) => p.personId)).toEqual(["p1", "p2"]);
  });
});

describe("allocationSnapshotHash", () => {
  it("reproduces the hash a snapshot carries", () => {
    const snapshot = buildAllocationSnapshot(baseInput());

    expect(allocationSnapshotHash(snapshot)).toBe(snapshot.hash);
  });

  it("does not change when the snapshot hash itself is replaced", () => {
    // The hash is computed over the body only, so the function is a genuine
    // independent check rather than a restatement of the field.
    const snapshot = buildAllocationSnapshot(baseInput());

    expect(allocationSnapshotHash({ ...snapshot, hash: "forged" })).toBe(snapshot.hash);
  });
});

describe("digestAllocationRows", () => {
  it("is stable regardless of row order", () => {
    const rows = storedRowsFor(baseInput());

    expect(digestAllocationRows([...rows].reverse())).toBe(digestAllocationRows(rows));
  });

  it("changes when any amount changes by one minor unit", () => {
    const rows = storedRowsFor(baseInput());
    const bumped = rows.map((r, i) =>
      i === 0 ? { ...r, computedAmount: { decimal: "400.0001", currency: r.computedAmount.currency } } : r,
    );

    expect(digestAllocationRows(bumped)).not.toBe(digestAllocationRows(rows));
  });

  it("digests duplicate rows without ambiguity", () => {
    const rows = storedRowsFor(baseInput());

    expect(digestAllocationRows([...rows, rows[0]!])).not.toBe(digestAllocationRows(rows));
  });
});

describe("verifyAllocationSnapshot — without re-running the engine", () => {
  it("confirms an untouched snapshot and untouched rows", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);
    const rows = storedRowsFor(input);

    const result = verifyAllocationSnapshot({ snapshot, rows, rowsDigest: digestAllocationRows(rows) });

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("works without a stored digest, for rows written before one existed", () => {
    const input = baseInput();
    const result = verifyAllocationSnapshot({ snapshot: buildAllocationSnapshot(input), rows: storedRowsFor(input) });

    expect(result.ok).toBe(true);
  });

  it("refuses to verify a snapshot written under a different schema", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);

    const result = verifyAllocationSnapshot({
      snapshot: { ...snapshot, schema: "raptor/allocation-input/v0" as typeof snapshot.schema },
      rows: storedRowsFor(input),
    });

    expect(result.ok).toBe(false);
    expect(result.findings.join(" ")).toMatch(/schema/i);
  });

  it("detects an edited snapshot", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);
    const tampered = { ...snapshot, pool: { decimal: "9999.0000", currency: INR } };

    const result = verifyAllocationSnapshot({ snapshot: tampered, rows: storedRowsFor(input) });

    expect(result.ok).toBe(false);
    expect(result.findings.join(" ")).toMatch(/snapshot hash/i);
  });

  it("detects an edited row via the stored digest", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);
    const rows = storedRowsFor(input);
    const tampered = rows.map((r) =>
      r.personId === "p1" ? { ...r, computedAmount: { decimal: "900.0000", currency: INR } } : r,
    );

    const result = verifyAllocationSnapshot({ snapshot, rows: tampered, rowsDigest: digestAllocationRows(rows) });

    expect(result.ok).toBe(false);
    expect(result.findings.join(" ")).toMatch(/digest/i);
  });

  it("detects a row for somebody who was not in the frozen participant set", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);
    const rows = [
      ...storedRowsFor(input),
      { personId: "intruder", computedAmount: { decimal: "0.0000", currency: INR }, ruleVersion: 4 },
    ];

    const result = verifyAllocationSnapshot({ snapshot, rows });

    expect(result.ok).toBe(false);
    expect(result.findings.join(" ")).toContain("intruder");
  });

  it("detects a missing row for a frozen participant", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);
    const rows = storedRowsFor(input).filter((r) => r.personId !== "p2");

    const result = verifyAllocationSnapshot({ snapshot, rows });

    expect(result.ok).toBe(false);
    expect(result.findings.join(" ")).toContain("p2");
  });

  it("detects a duplicated row", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);
    const rows = storedRowsFor(input);
    const result = verifyAllocationSnapshot({ snapshot, rows: [...rows, rows[0]!] });

    expect(result.ok).toBe(false);
    expect(result.findings.join(" ")).toMatch(/duplicate/i);
  });

  it("detects a row stamped with a different rule version", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);
    const rows = storedRowsFor(input).map((r) => (r.personId === "p1" ? { ...r, ruleVersion: 99 } : r));

    const result = verifyAllocationSnapshot({ snapshot, rows });

    expect(result.ok).toBe(false);
    expect(result.findings.join(" ")).toMatch(/rule version 99/i);
  });

  it("detects a row in a currency the pool was never denominated in", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);
    const rows = storedRowsFor(input).map((r) =>
      r.personId === "p1" ? { ...r, computedAmount: { decimal: r.computedAmount.decimal, currency: "USD" } } : r,
    );

    const result = verifyAllocationSnapshot({ snapshot, rows });

    expect(result.ok).toBe(false);
    expect(result.findings.join(" ")).toMatch(/USD/);
  });

  it("detects rows that no longer sum to the pool", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);
    const rows = storedRowsFor(input).map((r) =>
      r.personId === "p1" ? { ...r, computedAmount: { decimal: "399.9999", currency: INR } } : r,
    );

    const result = verifyAllocationSnapshot({ snapshot, rows });

    expect(result.ok).toBe(false);
    expect(result.findings.join(" ")).toMatch(/pool/i);
  });

  it("accounts for a recorded unallocated remainder when checking the total", () => {
    const input: AllocatePrizePoolInput = {
      netPrize: money("1000.00", INR),
      participants: [
        { personId: "p1", kind: "roster" },
        { personId: "p2", kind: "roster" },
      ],
      rule: {
        version: 9,
        basis: "percentage",
        percentages: { p1: "30", p2: "30" },
        remainderPolicy: "largest_remainder_stable_sort",
      },
      computedAt: AT,
    };
    const snapshot = buildAllocationSnapshot(input);
    const rows = storedRowsFor(input);

    const withoutRemainder = verifyAllocationSnapshot({ snapshot, rows });
    expect(withoutRemainder.ok).toBe(false);

    const withRemainder = verifyAllocationSnapshot({
      snapshot,
      rows,
      unallocated: { decimal: "400.0000", currency: INR },
    });
    expect(withRemainder.ok).toBe(true);
  });

  it("detects an unallocated remainder in the wrong currency", () => {
    const input = baseInput();
    const result = verifyAllocationSnapshot({
      snapshot: buildAllocationSnapshot(input),
      rows: storedRowsFor(input),
      unallocated: { decimal: "0.0000", currency: "USD" },
    });

    expect(result.ok).toBe(false);
    expect(result.findings.join(" ")).toMatch(/USD/);
  });

  it("detects a negative unallocated remainder", () => {
    const result = verifyAllocationSnapshot({
      snapshot: buildAllocationSnapshot(baseInput()),
      rows: storedRowsFor(baseInput()),
      unallocated: { decimal: "-1.0000", currency: INR },
    });

    expect(result.ok).toBe(false);
    expect(result.findings.join(" ")).toMatch(/negative/i);
  });
});

describe("replayAllocationFromSnapshot", () => {
  it("reproduces stored rows exactly from a stored snapshot", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);
    const rows = storedRowsFor(input);

    const replay = replayAllocationFromSnapshot(snapshot, { computedAt: AT, computedBy: "svc:replay" });

    expect(replay.ok).toBe(true);
    expect(replay.findings).toEqual([]);
    expect(replay.rows.map((r) => [r.personId, r.computedAmount.decimal])).toEqual(
      rows.map((r) => [r.personId, r.computedAmount.decimal]),
    );
  });

  it("reproduces a result identical to the original computation", () => {
    const input = baseInput();
    const original = allocatePrizePool(input);
    const replay = replayAllocationFromSnapshot(buildAllocationSnapshot(input), { computedAt: AT });

    expect(replay.result.inputHash).toBe(original.inputHash);
    expect(replay.result.allocations.map((a) => a.computedAmount.toDecimal())).toEqual(
      original.allocations.map((a) => a.computedAmount.toDecimal()),
    );
  });

  it("reports the rows that a replay contradicts", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);
    const stored = storedRowsFor(input).map((r) =>
      r.personId === "p2" ? { ...r, computedAmount: { decimal: "1.0000", currency: INR } } : r,
    );

    const replay = replayAllocationFromSnapshot(snapshot, { computedAt: AT, storedRows: stored });

    expect(replay.ok).toBe(false);
    expect(replay.findings.join(" ")).toContain("p2");
  });

  it("reports a participant the replay produces a row for but storage does not have", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);
    const stored = storedRowsFor(input).filter((r) => r.personId !== "p3");

    const replay = replayAllocationFromSnapshot(snapshot, { computedAt: AT, storedRows: stored });

    expect(replay.ok).toBe(false);
    expect(replay.findings.join(" ")).toContain("p3");
  });

  it("reports a stored row the replay does not produce", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);
    const stored = [
      ...storedRowsFor(input),
      { personId: "p4", computedAmount: { decimal: "0.0000", currency: INR }, ruleVersion: 4 },
    ];

    const replay = replayAllocationFromSnapshot(snapshot, { computedAt: AT, storedRows: stored });

    expect(replay.ok).toBe(false);
    expect(replay.findings.join(" ")).toContain("p4");
  });

  it("reports a stored row carrying the wrong rule version", () => {
    const input = baseInput();
    const snapshot = buildAllocationSnapshot(input);
    const stored = storedRowsFor(input).map((r) => (r.personId === "p1" ? { ...r, ruleVersion: 77 } : r));

    const replay = replayAllocationFromSnapshot(snapshot, { computedAt: AT, storedRows: stored });

    expect(replay.ok).toBe(false);
    expect(replay.findings.join(" ")).toMatch(/rule version 4 but 77/i);
  });

  it("replays from a weighted snapshot with weights restored from text", () => {
    const input: AllocatePrizePoolInput = {
      netPrize: money("900.00", INR),
      participants: [
        { personId: "p1", kind: "roster", weight: 3n },
        { personId: "p2", kind: "roster", weight: 1n },
      ],
      rule: { version: 2, basis: "weighted_by_participation", remainderPolicy: "largest_remainder_stable_sort" },
      computedAt: AT,
    };

    const replay = replayAllocationFromSnapshot(buildAllocationSnapshot(input), {
      computedAt: AT,
      storedRows: storedRowsFor(input),
    });

    // `bigint` weights survive JSON only as text; if they were dropped the replay
    // would throw or produce a different split.
    expect(replay.ok).toBe(true);
    expect(replay.rows.map((r) => r.computedAmount.decimal)).toEqual(["675.0000", "225.0000"]);
  });

  it("replays a fixed_plus_percentage snapshot end to end", () => {
    const input: AllocatePrizePoolInput = {
      netPrize: money("10000.00", INR),
      participants: [
        { personId: "p1", kind: "staff" },
        { personId: "p2", kind: "roster" },
      ],
      rule: {
        version: 3,
        basis: "fixed_plus_percentage",
        fixedAmounts: { p1: "500.00", p2: "0.00" },
        poolPercentage: { p1: "25", p2: "75" },
        remainderPolicy: "largest_remainder_stable_sort",
      },
      computedAt: AT,
    };

    const replay = replayAllocationFromSnapshot(buildAllocationSnapshot(input), {
      computedAt: AT,
      storedRows: storedRowsFor(input),
    });

    expect(replay.ok).toBe(true);
    expect(replay.rows.map((r) => r.computedAmount.decimal)).toEqual(["2875.0000", "7125.0000"]);
  });
});