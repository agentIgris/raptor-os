# ADR-0004 — Largest-remainder allocation with stable-sort tie-break

**Status:** Accepted
**Date:** 2026-10-09

## Context

A prize pool rarely divides evenly. 10,000.00 INR across three players cannot be split
into exact four-decimal amounts: 3333.3333 × 3 = 9999.9999, leaving 0.0001 unassigned.

If the residual is dropped, `sum(allocations) != net` and the books never balance. If it
is assigned arbitrarily, the same inputs on a re-run can produce a different answer,
which destroys reproducibility.

## Decision

Use the **largest remainder method**, with a deterministic tie-break.

1. Every participant receives `floor(exact_share)`.
2. The residual units — `total − Σ floor` — are distributed **one minor unit at a time**,
   largest fractional remainder first.
3. Where fractional remainders tie, the participant with the **lexicographically smaller
   stable id** wins.
4. The participant set is sorted by id before distribution, so **input order is
   irrelevant**.

There is exactly **one** remainder policy. It is not configurable.

## Verification

The invariant `Σ allocations + unallocated == net` holds exactly, proven by:

- Targeted test: `1000.00` across 3 participants, input supplied as `p3, p1, p2` →
  `p1` receives `333.3334`, `p2` and `p3` receive `333.3333`. The residual goes to the
  smallest id, **not** the first in the input list.
- Fuzz: 500 seeded-random pools × random rosters (1–9 people, random 4-decimal
  amounts) and 300 random weighted splits. No trial loses or invents a single minor unit.
- Order independence: re-running with the participant list reversed yields identical
  output.

## Consequences

**Positive**
- The books always balance. This is the property that makes `Reconciliation` satisfiable
  at all.
- Fully deterministic and reproducible — a re-run years later returns the same answer.
- No configuration surface that could change historically between runs.

**Negative — accepted**
- Residuals are assigned by participant id, which is arbitrary from a business point of
  view. A sponsor or player may prefer a specific person to absorb the sub-cent. That is
  handled by an explicit `Adjustment` row with a reason, not by making the core algorithm
  configurable — configurability here would break reproducibility.
- Requires a stable, immutable participant id. The engine freezes the participant set
  onto each allocation for exactly this reason.