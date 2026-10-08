# 04 — APPLICATION ARCHITECTURE

**Audit.md section:** 8 (SECTION 05 — APPLICATION ARCHITECTURE)

---

## 1. Actual runtime topology

```
┌──────────────────────────────────────────────────────────────────────────┐
│ BROWSER (the only real client — every dashboard page is "use client")    │
│                                                                          │
│  app/layout.tsx (server shell)                                           │
│   └─ ThemeProvider(forced dark)                                          │
│       └─ GlobalLoadingProvider                                           │
│           └─ AuthProviderV2  ──► AuthFlowV2Manager (singleton)           │
│               └─ RouteGuardV2  ◄── CLIENT-SIDE ONLY, no role checks      │
│                   └─ {children}                                          │
│           └─ <Toaster/> <GlobalLoading/> <OrganizationJsonLd/>            │
│                                                                          │
│  Supabase browser client (lib/supabase.ts)                               │
│   • persistSession: true, storage: window.localStorage                   │
│   • storageKey: "raptor-auth-token"   ← full session incl. refresh token│
│   • flowType: pkce, detectSessionInUrl: true                            │
│   • global header: x-application: raptor-esports-crm                     │
│                                                                          │
│  lib/session-storage.ts (parallel "secure" store)                        │
│   • access token: MODULE MEMORY ONLY                                     │
│   • localStorage: user, lastActive, agreementAccepted, tokenExpiry, uid  │
│   ⚠ the two stores disagree; Supabase's is authoritative                 │
│                                                                          │
│  Authenticated fetch:  Authorization: Bearer <access_token>              │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │ HTTPS
┌────────────────────────────────▼─────────────────────────────────────────┐
│ VERCEL (implied) — Next.js 14 App Router, Node runtime                    │
│                                                                          │
│  middleware.ts                                                            │
│   • 6 security headers (NO CSP)                                          │
│   • CORS block for /api/*  ◄── DEAD: matcher excludes api/               │
│   • NO authentication, NO authorization, NO rate limiting                │
│                                                                          │
│  app/api/**  (58 route handlers)                                          │
│   ┌── Pattern A: lib/api-utils.authenticateRequest()  ── user-bound      │
│   │     client (anon key + Bearer header → RLS sees auth.uid())          │
│   │     users, teams, performances, attendances, sessions, slots,         │
│   │     rosters, analytics, dashboard, expenses, winnings, tryouts,        │
│   │     tier-defaults, teams/*, admin/settings                           │
│   │                                                                       │
│   ├── Pattern B: local getUserClient(request)  ── user-bound client      │
│   │     agreements, discord-portal/{webhooks,settings,logs,send},          │
│   │     discord-portal/settings/default-webhook, profile/{route,avatar}   │
│   │                                                                       │
│   ├── Pattern C: static shared secret (RAPTOR_BOT_API_KEY)               │
│   │     discord/** (12 endpoints)                                         │
│   │                                                                       │
│   ├── Pattern D: NO AUTH  ⚠                                               │
│   │     media/upload, media/delete, public/upload/contact-file,          │
│   │     discord-portal/webhooks/validate, public/stats,                  │
│   │     public/submit/{application,contact}                              │
│   │                                                                       │
│   ├── Pattern E: getUser() for auth + MODULE-LEVEL ANON CLIENT for data  │
│   │     ⚠ auth.uid() = NULL at the database                              │
│   │     admin/agreements, profile/search, profile/avatar (users write),   │
│   │     discord/tryout/* (all 5)                                          │
│   │                                                                       │
│   └── Pattern F: SERVICE ROLE  ⚠ RLS fully bypassed                       │
│         admin/settings, public/submit/contact (fallback),                │
│         media/upload, media/delete, public/upload/contact-file,          │
│         discord-portal/settings/default-webhook, profile/avatar (storage) │
│                                                                          │
│  lib/*  — business logic, no service boundary                             │
│   role-system.ts · dashboard-permissions.ts · profile-utils.ts (3 RBAC)  │
│   auth-flow-v2.ts · session-storage.ts · api-utils.ts · ocr-service.ts    │
│   pdf-export.ts · cache-manager.ts · optimized-data-service.ts            │
│                                                                          │
│  modules/discord-portal/*  — the ONLY "service layer"                    │
│   ⚠ module-level anon client, persistSession default (true), no session  │
│   webhookService.ts · sendToDiscord.ts · embeds.ts · permissions.ts      │
│                                                                          │
│  Outbound HTTP (server-side fetch):                                       │
│   → Discord webhook API  (validateWebhookUrl GET, sendWebhookMessage POST)│
│   → Discord webhook API  (public/submit/* relay, env-supplied URL)       │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │ PostgREST (HTTPS) + Storage API
┌────────────────────────────────▼─────────────────────────────────────────┐
│ SUPABASE (managed Postgres)                                              │
│                                                                          │
│  32 tables · 18 with RLS enabled · 14 with RLS NOT enabled  ⚠            │
│  ~25 SECURITY DEFINER functions, granted to `authenticated`,             │
│  NEVER revoked from `anon`  ⚠                                            │
│  1 view (tryout_stats) created WITHOUT security_invoker  ⚠               │
│  4 storage buckets: avatars(public), media(public),                       │
│                     contact_files(private), ocr_uploads(private)          │
│  storage.objects policies grant SELECT/INSERT/DELETE TO `public` on      │
│  contact_files  ⚠                                                        │
│  pg_cron: 6 scheduled jobs (requires extension)                           │
│                                                                          │
│  SUPABASE AUTH (GoTrue)                                                  │
│  email+password only · no OAuth provider configured · no MFA ·           │
│  no custom SMTP (default Supabase SMTP, heavily rate-limited)            │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ DISCORD                 │
                    │ • incoming webhooks     │
                    │   (hook_url in DB,      │
                    │    plaintext)           │
                    │ • RaptorBot (external,  │
                    │   code NOT in repo)     │
                    │   → calls /api/discord/*│
                    │   with RAPTOR_BOT_API_KEY│
                    └─────────────────────────┘
```

---

## 2. Coupling analysis

### 2.1 Circular dependency: `auth-flow-v2` ↔ `session-storage` ↔ `session-config`
*Evidence:* `lib/session-storage.ts:221` performs `require('./session-config').default`
**inside a function body** with the comment `// Import here to avoid circular dependencies`.
*Impact:* a CommonJS `require` inside an ESM/TypeScript module; bundlers handle this
inconsistently, and the circularity it is avoiding is a design smell (session config should be
a leaf constant module).
*Severity:* **LOW** · *Confidence:* **HIGH*
*Recommendation:* make `session-config.ts` a dependency-free leaf; import it normally.

### 2.2 Layering violation: the "service layer" holds no user context
*Evidence:* `modules/discord-portal/webhookService.ts:21-23` and `sendToDiscord.ts:21-23`
create a module-level Supabase client with the **anon key and no session**:
```ts
const supabase = supabaseUrl && supabaseAnonKey
  ? createClient<Database>(supabaseUrl, supabaseAnonKey)
  : null
```
Every function in these files — `getTeamWebhooks`, `getAdminWebhooks`, `getAllWebhooks`,
`getWebhookById`, `createWebhook`, `updateWebhook`, `deleteWebhook`,
`getTeamAutomationSettings`, `getGlobalAutomationSettings`, `updateAutomationSetting`,
`initializeTeamAutomationSettings`, `getWebhookStats`, `sendToDiscord`,
`retryFailedMessage`, `getDiscordLogs` — therefore executes as the `anon` database role.
*Impact:* these are *authorization decisions made without an identity*. Whether they fail
closed (RLS denies) or fail open (RLS off, as `database/README.md` documents for development)
determines whether the Discord portal works at all or is wide open. It currently depends on
which posture the deployed project is in.
*Severity:* **CRITICAL** (architectural) · *Confidence:* **HIGH**
*Recommendation:* V2 must never construct a data client outside a request scope. Pass a
request-scoped, user-bound client (or an explicit system/actor context) into every service
function. Make "no ambient database client" an architectural test.

### 2.3 Business logic duplicated across three layers with no single owner
| Rule | Route layer | `lib/` layer | Database layer |
| --- | --- | --- | --- |
| Player may only read own performance | `app/api/performances/route.ts:101-106` (but ORs in `team_id`, so team-wide) | `lib/role-system.ts:199-201` | `scripts/00:508-509` `USING (player_id = auth.uid())`; `scripts/15:10-24` INSERT policy |
| Coach limited to own team | `app/api/performances/route.ts:107-108`; `app/api/sessions/route.ts:170-176`; `app/api/attendances/route.ts:152-159` | `lib/role-system.ts:106-110` | 6 separate policies across `scripts/00,01,04,11,13,15` |
| Slot expense = rate × slots | — | `app/api/slots/route.ts` (writes `slot_expenses`) | `automation-scripts/04:12-32` trigger `create_slot_expense()` |
| Attendance auto-absent after cutoff | `app/api/sessions/mark-attendance/route.ts` | `lib/session-config.ts` | `automation-scripts/02:88` `auto_mark_absent_after_cutoff()`; `database-schema-updates.sql:241` |
| Profile visibility | `app/api/profile/route.ts:71-86` via `lib/profile-utils.ts` | `lib/profile-utils.ts:103-166` | `automation-scripts/04:60-140` `can_view_profile` / `can_edit_profile` (**parameterised identity — not `auth.uid()`**) |

*Impact:* the same rule is enforced (differently) in up to three places, so a change in one
place silently diverges. This is the direct cause of the long chain of
`scripts/14-…21-fix-*.sql` patches.
*Severity:* **HIGH** · *Confidence:* **HIGH*
*Recommendation:* one owner per rule. In V2: application service = decision logic;
database = invariants only (FK, CHECK, UNIQUE, tenant scoping); RLS = tenant/row scope only.

### 2.4 Transaction boundaries: essentially none
*Evidence:* every mutating route performs multiple independent PostgREST calls with no
transaction wrapper. Example `app/api/attendances/route.ts:282-296` — a single `update`;
but `app/api/sessions/practice-config/route.ts` and `app/api/slots/route.ts` perform
read-then-write sequences; `app/api/discord/tryout/invite/route.ts:114-139` inserts an
invitation and then updates the application phase in two separate calls; and
`app/api/admin/settings/route.ts:116-119` loops `DELETE` over **7 tables plus `users`**
with no transaction and **no per-table error check** (Supabase errors do not throw, so the
`try/catch` at line 121 can never fire for a failed delete).
*Impact:* partial-failure states are possible and undetectable. A failed delete mid-loop
leaves the database in a half-purged state and still returns `{ success: true }`.
*Severity:* **HIGH** · *Confidence:* **HIGH**
*Recommendation:* V2 mutations that span rows must be single RPC (`SECURITY DEFINER`
function with an exception block) or use a proper transaction; the bulk-purge pattern must
not exist at all in a multi-tenant system.

### 2.5 N+1 and unbounded query patterns
*Evidence:*
* `app/api/analytics/performance/route.ts` (19.6 KB) builds player/team/trend series with
  multiple sequential queries per section.
* `app/api/dashboard/overview/route.ts` issues 5 aggregate queries in `Promise.all`.
* `app/api/public/stats/route.ts:30` selects **every row** of `slot_expenses` (`select('total')`
  with no limit) and reduces in JavaScript.
* `app/api/performances/route.ts:63` allows `limit` up to **1000** rows, and `limit=0`
  (the default) means **unbounded**.
* `app/api/profile/search/route.ts:24` `limit` is `parseInt` with **no upper bound**.
* `lib/cache-manager.ts` and `lib/optimized-data-service.ts` implement bespoke caching
  (in-memory + `localStorage`) rather than using a cache layer with invalidation.
*Impact:* unbounded reads, client-side aggregation, and a bespoke cache whose invalidation
rules are not documented. This will not survive multi-tenancy.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommendation:* server-side aggregation via views/materialised views, mandatory pagination
with a hard cap, and a documented cache-invalidation contract.

---

## 3. Data-access pattern summary

| Pattern | Where | Assessment |
| --- | --- | --- |
| Direct table select with `select('*')` | `app/api/users/route.ts:43`; `app/api/profile/route.ts:55`; `app/api/attendances/route.ts:52` | **Excessive data exposure.** `users` includes `emergency_contact_number`, `date_of_birth`, `address`, `device_info`, `discord_id`, `instagram_handle`, `sensitivity_settings` |
| Nested relation selects | `app/api/performances/route.ts:55` (`users:player_id(id,name,email)`) | Emails of other players returned to any permitted caller |
| PostgREST `.or()` string interpolation | `app/api/profile/search/route.ts:52-57`; `app/api/performances/route.ts:103` | **Filter-injection surface**; `user.id` is interpolated unescaped at `performances:103` |
| RPC for privileged operations | `app/api/users/route.ts:140` `bulletproof_user_update` (**undefined**); `app/api/agreements/route.ts:48` `check_user_agreement_status` (defined, `SECURITY DEFINER`) | Mixed: good pattern where defined, broken where not |
| Service-role access | 6 routes | **Bypasses RLS entirely**; used for storage, admin config, and public form webhooks |
| `head: true, count: 'exact'` | `app/api/public/stats/route.ts:22-30` | Count semantics still subject to RLS → counts are 0 for `anon`; the endpoint compensates with hardcoded numbers |
| No pagination on most list endpoints | `app/api/attendances`, `app/api/sessions`, `app/api/rosters` | Unbounded result sets |
| No `select` allowlist on writes | `app/api/discord-portal/webhooks/route.ts:241,285` (`{ id, ...updates }` spread into `.update()`) | **Mass assignment** |

---

## 4. External-service coupling

| Service | Direction | Coupling | Risk |
| --- | --- | --- | --- |
| Supabase Auth | both | GoTrue, PKCE, localStorage session | No MFA, no SSO, no custom SMTP |
| Supabase Postgres/PostgREST | both | RLS is the primary authorisation boundary | RLS posture unverified; 14 tables unprotected |
| Supabase Storage | both | 4 buckets; public avatars + media; service-role writes | Unauthenticated upload/delete; public read on `contact_files` |
| Discord Webhooks | outbound | Plain `fetch` POST with embeds; URLs stored in plaintext | Credential disclosure; no signing; no retry queue; embeds corrupted by mojibake |
| RaptorBot (Discord bot) | inbound | 12 HTTP endpoints guarded by one static key | Replayable; no per-identity auth; no rate limiting; no request signing |
| pg_cron | internal | 6 jobs | Requires Supabase-supported extension; not versioned |
| Vercel | hosting | Implied only | No IaC, no preview env config, no documented rollback |

---

## 5. Architectural problems, ranked

| # | Problem | Severity | Confidence |
| --- | --- | --- | --- |
| A1 | **No organisation/tenant entity anywhere.** The system assumes exactly one esports org exists forever. | CRITICAL | HIGH |
| A2 | **Ambient, session-less database clients in the service layer** (`modules/discord-portal/*`) — authorization without identity. | CRITICAL | HIGH |
| A3 | **Six routes use the service-role key**, four of them with no authentication, so authorisation is decided by which key a handler happens to use. | CRITICAL | HIGH |
| A4 | **No service layer / no domain boundary.** Logic is smeared across route handlers, `lib/` helpers and SQL functions. | HIGH | HIGH |
| A5 | **No transaction boundaries** on multi-row mutations; bulk purge has no error checking. | HIGH | HIGH |
| A6 | **Every dashboard page is client-rendered**; there is no server-side data loading, so all authorisation is client-observable and all data is fetched after paint. | HIGH | HIGH |
| A7 | **All state in globals/singletons** (`AuthFlowV2Manager`, `GlobalLoadingManager`, module-level clients, `cacheManager`) — untestable, un-isolated, and shared across SSR requests if ever moved server-side. | HIGH | HIGH |
| A8 | **Four parallel authorisation models** (see `08_ROLES_PERMISSIONS.md`) that disagree with each other and with the database CHECK constraint on `users.role`. | HIGH | HIGH |
| A9 | **No event layer.** Discord notifications are invoked imperatively from route handlers; there is no durable outbox, so a failed notification is lost. | HIGH | HIGH |
| A10 | **Schema is defined in 51 loose SQL files with no migration ledger**; the deployed schema is unknowable from the repository. | HIGH | HIGH |
| A11 | **Quality gates are disabled** (`ignoreDuringBuilds`, `ignoreBuildErrors`) and a `ReferenceError` ships in a live route. | HIGH | HIGH |
| A12 | **No CSP, no rate limiting, no error tracking, no tests** — the four controls that would have caught most other findings. | HIGH | HIGH |

---

## 6. Target architecture direction (conceptual only — nothing implemented)

```
Browser (thin SPA shell)
   │  httpOnly cookie session  (no tokens in JS)
   ▼
Edge / BFF  ── CSP, rate limit, request-id, authN
   │
   ▼
Application API (per-domain modules, explicit service layer)
   │  ├── Authorization engine (Role+Permission+Resource+Action+Scope)
   │  ├── Validation (zod, one schema per resource, shared with UI)
   │  ├── Domain services (single owner per business rule)
   │  └── Event outbox (durable, at-least-once)
   │            │
   ▼            ▼
Postgres (RLS tenant-scoped, org_id on every table)   Workers (events, integrations, OCR, AI)
   │                                                     │
   ▼                                                     ▼
Storage (private buckets, signed URLs)              External: Discord, Stripe, OCR, LLM
```

Design rules that follow directly from A1–A12:
1. **`org_id` on every tenant-owned table**, `NOT NULL`, with a composite index leading on it.
2. **No ambient clients.** Client construction is request-scoped and takes an explicit actor.
3. **Service role is never used in a request path.** Privileged operations are narrow,
   parameterised `SECURITY DEFINER` functions with `REVOKE … FROM anon` and internal auth checks.
4. **One rule, one owner.** Application service decides; database enforces invariants and
   tenant scope; RLS enforces scope.
5. **Every mutation that spans rows is one transaction.**
6. **Server-side data loading by default**; the client never decides what it may see.
7. **Events, not direct calls**, for anything leaving the system (Discord, email, webhooks).
8. **Policy as code**: the permission matrix is data, versioned, testable.
