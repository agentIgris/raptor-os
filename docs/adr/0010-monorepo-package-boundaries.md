# ADR-0010 — Monorepo with the domain logic isolated as pure functions

**Status:** Accepted · **Date:** 2026-10-09

## Context

The audit's most costly defect was not any single bug. It was that the business rules —
attendance cutoffs, slot arithmetic, prize allocation — existed **only** as SQL triggers and
`useEffect` code. They could not be unit-tested, so they were never verified, and the audit
notes the domain knowledge is at risk of loss while its original author is still available
(risk #9, rated High/High).

## Decision

A pnpm-workspaces monorepo, with the load-bearing business logic in a package that has
**no database, no network, and no clock** unless one is passed in.

```
apps/web                 the only deployable app
packages/core            pure domain logic — allocation, attendance, pricing, ranking
packages/db              schema, migrations, RLS, tenant registry
packages/auth            Better Auth configuration and session handling
packages/observability   structured logger, correlation ids, telemetry
packages/ui              design system
```

## Consequences

**Positive**
- Business rules are exhaustively testable in milliseconds with no fixtures — the
  allocation engine's 500-case fuzz suite runs in under a second.
- Rules are portable: the same function can run in an API route, a background job, a
  migration, or a test.
- Schema, policy and UI can change independently of the rules.
- A failing rule test names the rule, not a stack trace through a framework.

**Negative**
- Requires discipline at the boundary: anything reaching for a database inside
  `packages/core` is a violation, and is the thing a code reviewer must catch.
- More packages than a single app; overhead is real but small at this size.

**Enforced by** an import-boundary lint rule: `packages/core` may not import from
`packages/db`, `next`, or anything Node-specific beyond `node:crypto`.

## Alternatives rejected

- **Single application package** — faster to start, but it is precisely the shape that let
  business logic fuse to SQL triggers and become untestable.
- **Microservices** — no operational benefit at this scale, and it would make cross-domain
  transactions (allocation → ledger → payout) materially harder, not easier.