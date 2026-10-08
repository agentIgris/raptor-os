# Architecture Decision Records

Every consequential decision in Raptor OS v2 is recorded here. A decision that is
not written down is a decision nobody can review six months later.

**Format:** immutable once accepted (ADR-0001 …). Superseding a decision means
adding a new ADR that supersedes the old one — records are never edited or deleted.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-rebuild-from-scratch.md) | Rebuild from scratch; legacy is reference only | Accepted |
| [0002](0002-local-postgres-via-pglite.md) | Local PostgreSQL via PGlite, not a Postgres server | Accepted |
| [0003](0003-bigint-money.md) | Money is bigint minor units, never floating point | Accepted |
| [0004](0004-largest-remainder-allocation.md) | Largest-remainder allocation with stable-sort tie-break | Accepted |
| [0005](0005-fixed-plus-percentage-deduct-first.md) | `fixed_plus_percentage` deducts fixed amounts before splitting | Accepted |
| [0006](0006-non-superuser-application-role.md) | App connects as a non-superuser so RLS actually applies | Accepted |
| [0007](0007-self-hosted-better-auth.md) | Better Auth, self-hosted, no external IdP | Accepted |
| [0008](0008-node-native-infrastructure-substitutes.md) | Node-native substitutes; no Docker, no cloud | Accepted |
| [0009](0009-pinned-latest-stable-stack.md) | Latest stable, exactly pinned, audit-clean | Accepted |
| [0010](0010-monorepo-package-boundaries.md) | pnpm workspaces monorepo; pure domain logic isolated | Accepted |
| [0011](0011-composite-foreign-keys-for-tenancy.md) | Every tenant FK includes `org_id` | Accepted |
| [0012](0012-quality-gates-must-stay-enabled.md) | Build-time lint and typecheck gates stay enabled | Accepted |

## Status vocabulary

- **Proposed** — written, awaiting a decision.
- **Accepted** — in force.
- **Superseded by ADR-NNNN** — replaced; the record stays for history.

## Related

The design spec lives at [`docs/superpowers/specs/2026-10-09-raptor-os-v2-design.md`](../../docs/superpowers/specs/2026-10-09-raptor-os-v2-design.md).