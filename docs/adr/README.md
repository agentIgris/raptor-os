# Architecture Decision Records

Every consequential decision in Raptor OS v2 is recorded here. A decision that is
not written down is a decision nobody can review six months later.

**Format:** immutable once accepted (ADR-0001 …). Superseding a decision means
adding a new ADR that supersedes the old one — records are never edited or deleted.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-rebuild-from-scratch.md) | Rebuild from scratch; legacy is reference only | Accepted |
| ~~[0002](0002-local-postgres-via-pglite.md)~~ | Local PostgreSQL via PGlite | **Superseded by 0014** |
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
| [0013](0013-typescript-pinned-to-6.md) | TypeScript pinned to 6.0.3 (linter ceiling) | Accepted |
| ~~[0014](0014-native-postgres-supersedes-pglite.md)~~ | Native PostgreSQL 18.6 local | **Superseded by 0015** |
| [0015](0015-pglite-restored-after-native-postgres-retest.md) | PGlite restored as local DB; supersedes 0014 | Accepted |
| [0016](0016-domain-rules-recovered-from-legacy-source.md) | Domain rules recovered from source; withdraws the OCK/SSF/WWF ladder | Accepted |
| [0017](0017-session-is-identity-not-tenant-scoped.md) | session is identity, not tenant-scoped; removes a policy that blocked sign-in | Accepted |
| [0018](0018-person-is-identity-root.md) | `person` is the identity root; links to Better Auth's `user` | Accepted |
| [0019](0019-performance-metrics-designed-not-recovered.md) | Performance metrics designed, not recovered; completes Phase 2 | Accepted |

## Status vocabulary

- **Proposed** — written, awaiting a decision.
- **Accepted** — in force.
- **Superseded by ADR-NNNN** — replaced; the record stays for history.

## Related

The design spec lives at [`docs/superpowers/specs/2026-10-09-raptor-os-v2-design.md`](../../docs/superpowers/specs/2026-10-09-raptor-os-v2-design.md).