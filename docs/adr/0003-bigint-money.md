# ADR-0003 — Money is bigint minor units, never floating point

**Status:** Accepted
**Date:** 2026-10-09

## Context

The prize allocation engine distributes real money. Every figure must be exact,
reproducible, and auditable — a pool that loses a cent is a pool nobody trusts, and
one that gains a cent is a defect.

The legacy system used PostgreSQL `integer` money columns with no currency at all,
and `README.md` hardcoded the `₹` symbol. Its `total_winnings` metric was permanently
zero because of a UUID-to-integer join. None of that is acceptable in a product
whose differentiator is money.

## Decision

`Money` is a frozen object holding a `bigint` of **minor units at a fixed scale of 4
decimal places**, paired with an ISO 4217 `currency` code. Floating point is never
used for a monetary value anywhere in the codebase.

```ts
interface Money {
  readonly minor: bigint;      // 1 major unit = 10^4 minor units
  readonly currency: string;   // ISO 4217 alphabetic
  add(other: Money): Money;
  toDecimal(): string;         // always 4 dp, e.g. "1234.5600"
}
```

Every monetary database column is `numeric(18,4)` with a `currency` column beside it.

## Rules enforced by the type

1. **Currency mixing throws.** `money("1.00","INR").add(money("1.00","USD"))` raises.
   There is no implicit conversion and no global currency.
2. **Excess precision throws rather than rounds.** `money("0.00001")` is rejected. A
   silent rounding at the boundary surfaces later as an unexplained variance.
3. **Values are frozen.** A `Money` cannot be mutated after construction.
4. **Percentages parse into integer space.** `parsePercent("30")` → `300000n`,
   eliminating floating-point share arithmetic entirely.

## Consequences

**Positive**
- Exact. `money("0.1").add(money("0.2"))` equals `money("0.3")` exactly; binary floats
  cannot represent any of the three.
- Deterministic and reproducible — no platform-dependent rounding to worry about.
- Matches PostgreSQL `numeric(18,4)` with no conversion loss in either direction.
- Verifiable by test: the suite asserts `sum(allocations) + unallocated == net` across
  500 seeded-random pools, which would fail intermittently under floats.

**Negative**
- No native arithmetic operators (`+`, `*`); methods must be used. This is deliberate —
  it makes currency checking impossible to bypass.
- Callers pass decimal **strings** rather than numbers. `money(0.1)` is accepted but
  discouraged, because the string form is unambiguous about intent.
- Bigint literals require the `n` suffix, which is a papercut the type tests catch.

## Alternatives rejected

- **`decimal.js` / `big.js`** — capable libraries, but a money type this central is
  worth owning outright: ~200 lines, fully tested, zero supply-chain surface, and no
  behaviour we do not control.
- **Integer minor units with 2 dp (cents)** — insufficient for currency with more
  precision, and would force rounding decisions now that cannot be revisited later.
- **Postgres `numeric` only, letting the database do the math** — business rules must
  be testable as pure functions with no database. See ADR-0010.