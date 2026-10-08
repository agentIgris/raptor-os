# ADR-0012 — Build-time lint and typecheck gates stay enabled

**Status:** Accepted · **Date:** 2026-10-09

## Context

The legacy `next.config.mjs` set both:

```js
eslint:  { ignoreDuringBuilds: true },
typescript: { ignoreBuildErrors: true },
```

with the comment *"Relax build-time checks to prevent non-critical warnings from failing CI
builds."*

The result was not a noisy build. It was a live `ReferenceError: getUserFromRequest is not
defined` shipping in the attendance DELETE handler — an undefined function that a single
`tsc` run would have caught — plus undefined RPCs, and lint configured against a mismatched
ESLint/plugin version pair that made the whole check decorative.

With zero tests and zero CI, nothing ran at all. The audit's assessment: **the testing
control is the control that would have prevented most of its findings.**

## Decision

Both gates stay enabled and are release blockers. Concretely:

1. `ignoreBuildErrors` and `ignoreDuringBuilds` are **false** and a CI check fails the build
   if either becomes true.
2. Every phase ends green: lint, typecheck, and the full test suite. **No phase advances
   with a failing gate.**
3. Coverage thresholds are enforced, not reported. `packages/core` currently requires
   95% lines/functions/statements and 90% branches.
4. `pnpm audit --prod` must report zero critical/high before merge.
5. Bare `console.*` is a lint error in application code.

## Consequences

**Positive** — the two cheapest, highest-yield controls in the entire project. Both
defects named above are compile-time failures that this makes impossible to ship.

**Negative** — a red build on a trivial type error is friction. Deliberately accepted:
the alternative is a green build that lies, which is far more expensive.

## How this decision was already validated

During the first build of the allocation engine, `tsc` surfaced **nine** real type errors
in code that Vitest had reported as fully passing — a `bigint`/`Money` mismatch leaking
through three call sites, a stale re-export, and a wrongly-typed test fixture. Tests alone
did not catch them; the gate did. This is precisely the class of defect that shipped in the
legacy system.

## Related rules

- No `any` in domain code.
- No `select *` on tables containing PII.
- No outbound HTTP inside a business transaction (transactional outbox instead).
- No migration applied outside the migration ledger.
- One lockfile; `--frozen-lockfile` in CI.