# ADR-0005 — `fixed_plus_percentage` deducts fixed amounts before splitting

**Status:** Accepted
**Date:** 2026-10-09

## Context

Some esports contracts pay a player a guaranteed fixed amount *plus* a percentage of the
prize pool — e.g. a coach taking ₹500 flat plus 25% of the pool. This is the only
allocation basis that can, under a naive reading, allocate more money than exists.

The audit specified the basis but not the arithmetic, and explicitly left the
over-allocation question open. Choosing carelessly here makes the reconciliation
invariant unsatisfiable.

## Decision

**Fixed amounts are deducted from the pool first; the percentages then split what
remains.**

```
netPrize
  −  Σ fixed amounts            (rejected if this exceeds netPrize)
  =  remainder
  remainder × pct_i / 100  →  + fixed_i  =  allocation_i
```

Worked example, verified by test:

```
net 10,000.00 · fixed p1 = 500.00, p2 = 0.00 · percentages 25 / 75
  fixed total 500 taken off the top → remainder 9,500.00
  p1 = 500.00 + 25% × 9,500.00 = 2,875.00
  p2 =   0.00 + 75% × 9,500.00 = 7,125.00
  total = 10,000.00   ✓ balanced
```

## Why not the additive reading

The additive reading (fixed *plus* a percentage of the full pool) was the first design
tried, and it is incoherent:

- With `fixed = 500` and `25/75`, it allocates 10,500 against a 10,000 pool — a 5% overrun.
- With `fixed = 900 + 900` and `50/50`, it allocates 2,800 against a 1,000 pool — a 180% overrun.

Rejecting those requires a tolerance threshold somewhere between 105% and 180%. **That
threshold is arbitrary**, and a rule that depends on an arbitrary threshold is a rule that
will be misapplied.

Deduct-first needs no threshold at all. The pool always balances by construction, and the
over-allocation guard is exact and unambiguous: *fixed amounts cannot exceed the pool.*

## Consequences

**Positive**
- The basis always reconciles.
- The over-allocation condition is precise and testable.
- Matches how such deals are actually written.

**Negative**
- Percentages are applied to a reduced base, so a contract drafted assuming the additive
  reading would compute differently. The rule version and the persisted explanation make
  this visible and auditable rather than silent.
- Business users must be told the base is net-of-fixed. Documented in the domain model.

**Rejected alternative:** capping over-allocation at 100% silently redistributing the
surplus. It hides a contract error rather than surfacing it.