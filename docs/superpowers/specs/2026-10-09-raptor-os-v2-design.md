# Raptor OS — V2 Design Spec

**Status:** approved for build (authorised by project owner)
**Date:** 2026-10-09
**Supersedes:** legacy `RaptorLaunchPage/Beta` (archived, reference only)

---

## 1. Product

A **multi-tenant Esports Organisation OS**. One system of record for a competitive esports
organisation: competitive operations, people and contracts, money, sponsorships, content,
travel and assets.

- **Buyer:** the organisation owner / operations manager.
- **Primary user:** the coach.
- **The wedge:** **money and obligations.** Prize allocation and sponsor deliverables — the two
  capabilities no incumbent product models.
- **Retention:** competitive operations.
- **Acquisition:** the per-tenant public site.

Explicitly **not** a fork of the legacy app. The legacy repository is a source of *domain
knowledge* only: the tryout state machine, attendance cutoff rules, slot-expense arithmetic, the
tier ladder, and the Discord message vocabulary.

---

## 2. Non-negotiable architectural constraints

Derived from the audit's critical findings. Each maps to an enforcement mechanism.

| # | Constraint | Enforcement |
|---|---|---|
| 1 | `org_id` on **every** tenant-owned row | Drizzle schema + a test that fails the build if a tenant table omits it |
| 2 | Every FK includes `org_id` | Composite FKs — makes cross-tenant references structurally impossible |
| 3 | Composite index **leads** with `org_id` | Lint rule over the generated schema |
| 4 | RLS forced on every table | Postgres `FORCE ROW LEVEL SECURITY`; a test enumerates `pg_class.relrowsecurity` |
| 5 | Tenant resolved from the **session**, never a request parameter | `current_org_id()` reads a signed claim |
| 6 | No `SECURITY DEFINER` without explicit `SET search_path` and `REVOKE … FROM PUBLIC` | Migration lint |
| 7 | Money is `numeric(18,4)` + ISO 4217 `currency` on **every** monetary column | Drizzle type + DB check |
| 8 | Effective dating on every legal/financial/competitive relationship | `valid_from` / `valid_to`; never a destructive update |
| 9 | No hard delete of `Person`, `Contract`, `Match`, or any financial row | Archive instead; FKs `RESTRICT` |
| 10 | Audit row written for all 15 sensitive action classes | Service-layer decorator + DB trigger backstop |
| 11 | No outbound HTTP from inside a business transaction | Transactional outbox + relay worker |
| 12 | `ignoreBuildErrors` / `ignoreDuringBuilds` must be **false** | CI blocks on it |

---

## 3. Stack

Latest stable, pinned exactly, verified audit-clean. Zero known vulnerabilities at the time of
install.

| Layer | Choice | Version |
|---|---|---|
| Runtime | Node | 22 LTS |
| Language | TypeScript | pinned |
| Framework | Next.js (App Router) | 16.4.x |
| UI | React / React DOM | 19.3.x |
| Database | **PostgreSQL (local install)** | 18.6 |
| Data access | Drizzle ORM + `pg` | latest |
| Migrations | Drizzle Kit + a custom ledger table | latest |
| Auth | **Better Auth** (self-hosted), Drizzle adapter | latest |
| Validation | Zod (v4) — one schema shared by API + forms + types | 4.6.x |
| Styling | Tailwind CSS v4 (CSS-first config) | 4.3.x |
| Components | shadcn/ui on Radix | latest |
| Charts | Recharts | 3.10.x |
| Test | Vitest + Playwright + Testing Library + axe-core | latest |
| Lint | ESLint 10 + eslint-config-next (matched pair) | 16.4.x |
| Errors | Sentry (Next.js / React / Node SDKs) | latest |
| Telemetry | OpenTelemetry | latest |
| Queue | Postgres-backed (`pg-boss`) | latest |
| Email | Nodemailer → local SMTP sink (Mailpit-compatible) | latest |
| Storage | Local disk behind a signed-URL asset service | — |
| PDF | jsPDF + autoTable | 4.2.x |
| OCR | Server-side Tesseract, human-confirmed, never auto-committed | 7.x |

**No Docker, no cloud services, no external credentials.** Everything runs locally. The only
secrets that will ever be needed are for the eventual deploy target.

### Deliberately excluded
Legacy/obsolete code, unused dependencies, and any cloud SDK. No Supabase, no AWS, no
Kubernetes. The audit's `SUPABASE_*` variables are not inherited.

---

## 4. Repository shape

Monorepo, pnpm workspaces + Turborepo. Every package independently testable and publishable.

```
apps/
  web/                    Next.js 16 App Router — the only deployable app
packages/
  db/                     Drizzle schema, migrations, RLS, seed, tenant-registry test
  auth/                   Better Auth config, session handling, MFA, PKCE
  core/                   Pure domain logic. No I/O. 100% unit-tested.
  ui/                     shadcn/ui components, design tokens, typography
  observability/          Structured logger, OTel, error reporting, correlation ids
  notifications/          Notification model + channel adapters (in-app, email, webhook)
  workflows/              Durable workflow engine over pg-boss
  integrations/           Outbound adapters (Discord, calendar, storage)
  config/                 Shared ESLint / TS / Vitest config
```

`packages/core` holds the load-bearing business rules as **pure functions**: prize allocation,
attendance evaluation, slot pricing, ranking. No database, no network. This is what makes them
testable and portable — the audit's biggest loss was that these rules existed only as SQL
triggers and `useEffect` code.

---

## 5. Tenancy

Shared schema, `org_id` discriminator, RLS forced. One database.

Tenant context lives in the **session**, never a request parameter. Every request resolves exactly
one organisation or is rejected.

Escalation path if a customer contract demands physical isolation: region pinning at organisation
creation, then schema-per-tenant, then database-per-tenant. The composite-FK invariant holds in
all three.

---

## 6. Domain model

Thirteen bounded contexts. `PLATFORM` is the only one not tenant-scoped — it is scoped by operator
role.

| Context | Root aggregates |
|---|---|
| IDENTITY | `Person`, `Identity`, `PersonProfile`, `ConsentRecord` |
| ORGANISATION | `Organization`, `OrgMembership`, `Department`, `Role`, `RoleAssignment` |
| PEOPLE | `Engagement`, `Contract`, `ContractVersion`, `AgreementAcceptance`, `CompensationAgreement` |
| COMPETITIVE | `Title`, `Game`, `Season`, `Division`, `Competition`, `Team`, `TeamMembership`, `Entry`, `Result` |
| TRAINING | `Session`, `SessionTemplate`, `AttendanceRecord`, `AttendancePolicy` |
| PERFORMANCE | `MetricDefinition`, `PerformanceEntry`, `MetricValue`, `OCRExtraction` |
| FINANCE | `LedgerAccount`, `JournalEntry`, `JournalLine`, `PrizePool`, `PrizeAllocation`, `Budget`, `Invoice`, `Payment` |
| COMMERCIAL | `Partner`, `Deal`, `InventoryItem`, `ContractObligation`, `ObligationEvidence` |
| CONTENT | `CreatorProfile`, `PlatformAccount`, `ContentItem`, `Publication` |
| OPERATIONS | `Event`, `TravelPlan`, `AssetItem`, `AssetAssignment`, `Location` |
| WORK | `Task`, `WorkflowTemplate`, `WorkflowRun`, `Approval` |
| PLATFORM | `Tenant`, `Plan`, `Subscription`, `FeatureFlag`, `AuditLog`, `Notification`, `OutboxEvent` |

### Load-bearing decisions

1. **`Person` ≠ `Identity` ≠ `OrgMembership` ≠ `Profile` ≠ `TeamMembership`.** A human is not a
   login, not a role, not a team slot. One person may hold several engagements and several roles
   across organisations.
2. **Effective dating everywhere it matters.** `TeamMembership.valid_from/valid_to/share_percent`
   is what makes "who was on the roster when the prize was won" answerable — which is the entire
   basis of the allocation engine.
3. **A slot is a purchase, an entry is a participation, a result is an outcome.** The legacy schema
   conflated all three, which is why overselling was possible and no result could ever be recorded.
4. **Money is a ledger, never a column.**
5. **Configuration is typed, per-tenant, versioned and audited** — not a key/value bag.

---

## 7. The prize allocation engine

The product's differentiator. Pure function, no I/O, fully deterministic.

```
PrizeIncome    (event, placement, gross_amount, currency, source, received_at)
PrizePool      (event_id, gross, deductions, net, tax_withheld)
AllocationRule (resolved from the CompensationAgreement **as at the event date**;
                basis: percentage | per_head | fixed_plus_percentage | weighted_by_participation)
Allocation     (one row per participant: basis_amount, computed_amount, currency,
                rule_version, computed_at, computed_by, explanation)
Adjustment     (post-allocation corrections — always new rows, never updates)
Payout         (provider-owned: status, reference, paid_at)
Reconciliation (sum(allocations) + sum(adjustments) == net, with variance + explanation)
```

Four properties, non-negotiable:

| Property | Meaning | Schema consequence |
|---|---|---|
| **Deterministic** | Same inputs → same output, always | `numeric` arithmetic only. No clock, no random, no dict ordering. Stable sort key before remainder distribution. |
| **Reproducible** | Re-derivable from stored inputs | `rule_version` NOT NULL, pointing at an **immutable** rule snapshot. The participant set is **frozen** onto the allocation at compute time — an as-of join against mutable `TeamMembership` is *not* reproducibility. |
| **Explainable** | A human-readable derivation for disputes | The derivation is **persisted at compute time**. Never re-rendered from the rule later. |
| **Immutable** | Corrections are new rows | `Allocation` and `PrizePool` append-only. No `UPDATE`, no `DELETE`. |

**Rounding / remainder policy** is specified and versioned *inside* the rule, not in application
code — otherwise `sum(allocations) == net` is unsatisfiable. Largest-remainder method, with
residuals assigned by stable sort on participant id. This is a decision the audit left open and it
blocks the reconciliation invariant, so it is pinned here.

`Reconciliation` is a persisted first-class row, not a view. Re-running with identical inputs is a
no-op (idempotent); a re-run that would produce different output is rejected via an input-content
hash.

---

## 8. Delivery phases

Each phase ends green: typecheck, lint, and the full test suite pass. No phase advances with a
failing gate.

| Phase | Contents | Done when |
|---|---|---|
| **0 — Foundation** | Repo, toolchain, local Postgres, migrations ledger, typecheck/lint/test gates **on**, structured logging, correlation ids, error tracking, health/readiness, CI, typed config | `pnpm verify` green from a clean clone |
| **1 — Tenancy spine** | Auth (Better Auth, MFA, httpOnly sessions, PKCE), org/person/engagement/role schema, composite-FK + RLS enforcement, policy engine, audit log, outbox | Tenant-isolation test suite green; cross-tenant access provably impossible |
| **2 — Competitive ops** | Titles/games/seasons/divisions/competitions, teams + effective-dated membership, entries, results, sessions, attendance rules, performance + metrics | Attendance and roster history queries answerable by date |
| **3 — Money** | Ledger, prize pool, **allocation engine**, reconciliation, budgets, expenses | Allocation reproducible from stored inputs; reconciliation invariant holds under fuzz |
| **4 — People** | Contracts + immutable versions + provable acceptance, compensation agreements, HR lifecycle, documents + expiry, minors/consent | Acceptance provable by content hash; expiry reminders fire |
| **5 — Commercial + content** | Inventory, obligations, evidence, partner pipeline, creators, content pipeline, invoicing, public site | Obligation fulfilment provable end to end |
| **6 — Operations + hardening** | Tasks, workflows, travel, assets, facilities, i18n, multi-currency, import/export, analytics, observability hardening, accessibility, mobile, security review | Full test suite + security review + audit clean |

---

## 9. Testing strategy

| Layer | Tool | Coverage intent |
|---|---|---|
| Unit | Vitest | `packages/core` — every business rule, exhaustively, including boundary and fuzz cases |
| Integration | Vitest + real local Postgres | Schema, RLS policies, migrations up/down, tenant isolation |
| Contract | Vitest | API request/response schemas; one schema shared by API and forms |
| E2E | Playwright | Every primary workflow, against the running app |
| Accessibility | axe-core via Playwright | WCAG 2.2 AA on every route |
| Security | Vitest + targeted suites | Tenant isolation, authz matrix conformance, mass-assignment, injection, SSRF, secret leakage |

The audit's most damning finding was that a live `ReferenceError` shipped because nothing ran.
The test harness is therefore Phase 0 work, not a later concern.

**Cross-tenant isolation is a release gate**, not a test that runs sometimes.

---

## 10. Security posture

- Tenant-scoped RLS on every table, forced.
- Provable agreement acceptance via immutable version + content hash.
- Sensitive PII in a separately permissioned, encrypted store. Never in a public projection.
- Audited money. Guardian consent for minors; under-13 blocked.
- Documented retention, erasure, and legal hold.
- Audit log covering all 15 sensitive action classes.
- No service-role key in any request path. No secrets in client bundles.
- Dependency scanning + secret scanning in CI; CI blocks on any critical/high advisory.

---

## 11. Explicitly out of scope

Statutory tax calculation, statutory payroll execution, banking, KYC/AML, currency conversion
execution, video transcoding, live-stream hosting, and any physical-infrastructure provisioning.
These are external providers' responsibilities; the platform owns entitlements and facts, and syncs.

---

## 12. Anti-recurrence rules

Drawn directly from how the legacy system failed:

1. No `console.*` in application code — structured logger only, enforced by lint.
2. No bare `select *` on tables containing PII.
3. No `any` in domain code.
4. No outbound HTTP inside a transaction.
5. No unpinned dependency. One lockfile. `--frozen-lockfile` in CI.
6. No migration applied outside the migration ledger.
7. Every destructive action is typed-confirmed, authorised, transactional, and audited.