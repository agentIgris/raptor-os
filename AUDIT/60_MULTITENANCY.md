# 60 - MULTI-TENANCY READINESS
**Audit.md section:** 67 (SECTION 64).
**Audit.md calls this "one of the most important sections".**

## 1. The finding that answers the section
**There is no organisation anywhere in the system.** No `organizations` table in any of the 43
SQL files. No `organization_id`, `org_id`, `tenant_id`, `workspace_id` or `account_id` column on
any of the 32 tables. No tenant concept in `lib/supabase.ts`'s `Database` type. No tenant in the
auth model, the route guard, the permission models, the storage buckets, the Discord
integration, or the API surface.

`teams` is the top of the hierarchy (`scripts/00:28-36`), so the model is
`Team -> People`, i.e. **one organisation, many teams**. The target product is
`Organization -> Divisions -> Teams` with the Organization as the tenant root.

## 2. Audit.md's five questions, answered
| Question | Answer | Evidence |
| --- | --- | --- |
| **Are organizations first-class entities?** | **No.** Not as a table, not as a type, not as a concept. The only organisation-shaped data is a hardcoded Discord invite URL on three public pages and hardcoded brand strings in `app/layout.tsx:16-44`. | exhaustive absence |
| **Tenant identifiers?** | **None.** | — |
| **Tenant isolation?** | **Not applicable** — with one organisation there is nothing to isolate. The *mechanisms* that would be reused (RLS, `users.team_id` scoping, the permission models) are all modelled on **team** scope, not tenant scope. | `13_RLS_SECURITY.md` |
| **Cross-tenant risks?** | **Every row in every table would be shared.** There is no mechanism, at any layer, that would prevent customer A from seeing customer B's data. | — |
| **Organization membership?** | **Not modelled.** The closest analogue is `users.team_id` (one team) and `rosters` (many teams, no role, no dates). A user can belong to exactly one organisation with no way to express membership in an organisation, an employment, or a subscription. | `scripts/00:44, 347-358` |
| **Organization-level configuration?** | **A single global key/value bag**: `admin_config` (app version, maintenance mode, agreement versions and content, default public webhook) plus 9 global `communication_settings` rows where `team_id IS NULL` means "global". | `scripts/00:12-16, 330-341` |

## 3. Why the absence is structural rather than a missing feature
Ten design decisions in the legacy system are incompatible with multi-tenancy, and each would
have to be un-built:

| # | Legacy decision | Why it blocks tenancy | Evidence |
| --- | --- | --- | --- |
| 1 | No tenant key on any table | every query is unscopeable | `11_DATABASE.md` |
| 2 | `users.team_id` is the sole scope key for authorisation | team scope != tenant scope; a manager is org-wide while a coach is team-wide, and neither is tenant-aware | `08_ROLES_PERMISSIONS.md` |
| 3 | The role enum is global and hardcoded (7 DB values, 9 in code) | roles must be per-tenant assignable, and the *set* of roles must be configurable | `scripts/00:43`; `lib/role-system.ts:7-362` |
| 4 | `admin_config` is a global singleton table | must become a per-tenant configuration entity | `scripts/00:12-16` |
| 5 | `tier_defaults` is a global rate card seeded with BGMI tiers | must be per-tenant, per-game | `scripts/00:209-216` |
| 6 | `practice_session_config`, `holidays`, `module_permissions`, `attendance_debug_log` have **no RLS** | per-tenant rows in a table with no RLS are world-readable | `13_RLS_SECURITY.md` F-RLS-05 |
| 7 | Storage buckets are global and partly public (`media`, `contact_files` world-readable) | object keys must be tenant-prefixed and policies tenant-scoped | `automation-scripts/08` |
| 8 | Discord webhooks are global and credential-bearing | a webhook belongs to one tenant's channel | `13_RLS_SECURITY.md` F-RLS-02 |
| 9 | The Supabase anon key is a single project-wide key | workable, but all policies must key on `org_id` resolved from the session |
| 10 | `SUPABASE_SERVICE_ROLE_KEY` is used in 6 request handlers, 4 unauthenticated | a service role is inherently cross-tenant; it must never be reachable from a tenant request | `15_API_SECURITY.md` F-SEC-03 |

Plus three that are merely *absent* rather than blocking: no subscription/billing entity, no
tenant-level onboarding state, no per-tenant feature flags, and no per-tenant branding
(`80_WHITE_LABEL.md`).

## 4. What must change, exactly

### 4.1 Data model
1. **`organizations`** — the tenant root: `id`, `slug`, `legal_name`, `display_name`,
   `legal_entity_id`, `default_currency`, `default_timezone`, `default_locale`,
   `fiscal_year_start`, `data_region`, `status`, `plan_id`, `created_at`.
2. **`organization_members`** — `(organization_id, person_id, status, invited_by, invited_at,
   joined_at)` with `UNIQUE (organization_id, person_id)`. A person may belong to several
   organisations.
3. **`org_id` on every tenant-owned table**, `NOT NULL`, with a composite index leading on it
   (`(org_id, …)`) so every scoped query is index-covered. A composite foreign key convention
   (every FK includes `org_id`) makes cross-tenant references **structurally impossible** rather
   than merely checked — this is the single most important design decision in the V2 schema.
4. **A tenant registry** listing every table that carries `org_id`, validated by a test that fails
   the build if a new tenant-owned table omits it.
5. **Migration of the legacy data** into a single `organizations` row (or one per importing
   organisation) with `org_id` backfilled, then `NOT NULL` enforced
   (`83_DATA_MIGRATION.md`).

### 4.2 Identity and session
6. The **tenant context must be part of the session**, not a request parameter — otherwise a
   caller chooses which tenant they are acting in. Options: one session per tenant (a tenant
   switcher re-issues the session), or a server-side `active_org_id` claim set by an explicit
   switch action. Either way the claim must be **server-signed and non-forgeable**, and every
   request resolves exactly one organisation.
7. All 25 `SECURITY DEFINER` functions must take `org_id` from the session, never from a
   parameter, and must `REVOKE … FROM PUBLIC, anon`.

### 4.3 Authorisation
8. Every policy becomes `org_id = current_org_id() AND <existing predicate>`, where
   `current_org_id()` is a stable, `SECURITY DEFINER`, `SET search_path = ''` function reading a
   signed claim. The role lookup must stop referencing the protected table inside its own policy
   (`13_RLS_SECURITY.md` F-RLS-01).
9. The permission model becomes per-tenant: `roles`, `permissions`, `role_permissions`,
   `member_roles`, all keyed on `org_id`, with system roles seeded per tenant
   (`63_ROLE_MODEL.md`).
10. `checkTeamAccess` is replaced by a scope resolver: `org` / `team` / `self` / `assigned`, derived
    from the member's roles.

### 4.4 Application
11. **No ambient clients** (`04_ARCHITECTURE.md` A2). A request-scoped context object carries
    `{ org_id, person_id, roles, supabase_user_client, supabase_admin_client? }`.
12. The service-role key is **removed from all request paths**. Privileged operations become narrow
    `SECURITY DEFINER` functions.
13. Every API route requires an explicit tenant context and returns 404 (not 403) for
    cross-tenant resource access, to avoid confirming the existence of another tenant's records.
14. **Storage**: buckets are private; object keys are `{org_id}/{...}`; policies key on
    `org_id = current_org_id()`; signed URLs are short-lived and issued after an authorisation
    check.
15. **Background jobs** (notifications, imports, reports, OCR) must carry `org_id` explicitly and
    be safe to run concurrently across tenants.
16. **Caching** keys must include `org_id`.
17. **Rate limits and quotas** are per tenant and per plan (`82_SAAS_BILLING.md`).
18. **Audit log** carries `org_id` and is queryable only within the tenant.

### 4.5 Cross-cutting
19. **No global unique constraints** across tenants unless they are genuinely global
    (`users.email` is currently `UNIQUE` — in a SaaS, email uniqueness must be per tenant or
    per verified identity, not global, or one organisation's admin address would block another's).
20. **Idempotency, webhooks and integrations** all key on `org_id`.
21. **Onboarding**: signup creates a *person*; joining or creating an *organisation* is a separate,
    explicit, auditable act with a plan and a trial.
22. **Testing**: a tenant-isolation test suite is a release gate — two seeded tenants, and every
    scoped query asserted to return only the caller's rows (`53_TESTING.md` §3 items 4-5).

## 5. Isolation models considered
| Model | Assessment |
| --- | --- |
| **Shared schema, `org_id` discriminator + RLS** | **Recommended.** Cheapest to operate, simplest to query, and the model this team already knows. Requires the composite-FK discipline and the isolation test suite to be safe. |
| Schema per tenant | Strong isolation; operationally expensive (migrations x N, connection pools x N); only justified for contractual or regulatory isolation. |
| Database per tenant | Strongest isolation; disproportionate cost at small scale; complicates platform-level analytics. |

**Recommendation: shared schema with `org_id` + RLS + composite foreign keys + a mandatory
tenant-isolation test suite.** Revisit only where a customer contract demands it.

## 6. Effort implication
Multi-tenancy is not a feature to add to a single-tenant system; it is a **re-platforming of the
data model, the authorisation layer and the request context**. Combined with
`15_API_SECURITY.md` (four unauthenticated endpoints, mass assignment, no rate limiting) and
`13_RLS_SECURITY.md` (14 unprotected tables, 118 unreconciled policies, ~25 anonymously callable
functions), the conclusion is unambiguous: **the existing schema, RLS estate, API layer and
permission models should be ARCHIVED, not extended.** The reusable assets are the business rules
(`94_REBUILD_STRATEGY.md`).

## 7. Verdict
**NOT READY. Requires re-platforming.** There is no partial credit available here: without
`organizations` there is no product.
