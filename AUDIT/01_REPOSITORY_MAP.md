# 01 — REPOSITORY MAP

**Audit.md section:** 4 (SECTION 01 — REPOSITORY DISCOVERY)
**Source of truth:** `E:\Raptor\_clone` @ `c9b6f8a` (branch `main`)

---

## 1. Repository-level facts

| Property | Value | Evidence |
| --- | --- | --- |
| Remote | `https://github.com/RaptorLaunchPage/Beta.git` | clone target |
| Branch audited | `main` | `git branch` → `* main` |
| HEAD | `c9b6f8a` "Merge pull request #16 … fix-discord-module-webhook-saving-and-display-e244" | `git log -1` |
| Total tracked files (excl. `.git`) | **326** | `Get-ChildItem -Recurse -File` |
| Total size (excl. `.git`) | **9.1 MB** | same |
| Dominant size contributor | `public/space-particles.mp4` — **6,399,270 bytes (6.1 MB, 67 % of repo)** | file listing |
| Commits on `main` | **63** | `git log --oneline \| Measure-Object` |
| Commit date range | **all 63 commits in 2025-08** | `git log --format=%ad --date=format:%Y-%m \| Group-Object` |
| Commit authors | `Cursor Agent` 77, `google-labs-jules[bot]` 19, `RaptorLaunchPage` 14, `Vercel` 1 | `git shortlog -sn --all` |
| AI-authored commit share | **~89 %** (96 of 108 author-commits across all refs) | derived |
| Remote branches | 20 (see §9) | `git branch -a` |
| Test files | **0** | no `*.test.*`, `*.spec.*`, `__tests__`, or Playwright config anywhere |
| CI/CD config | **0** | no `.github/` directory, no `.gitlab-ci.yml`, no Vercel config in repo |
| Infrastructure-as-code | **0** | no `terraform/`, `pulumi/`, `k8s/`, `dockerfile` |
| Migrations ledger | **0** | no `supabase/migrations/`, no `schema_migrations` table, no migration tool config |

**Finding — the repository has no source of truth for its own database schema.**
*Evidence:* 51 loose `.sql` files in three directories (`scripts/`, `database/`,
`automation-scripts/`) plus 8 loose `.sql` files at repository root, with duplicate
`CREATE TABLE`/`CREATE POLICY` statements and no version table, no ordering manifest, and no
idempotency guarantee. `scripts/15-fix-rls-policies.sql:7` does
`DROP POLICY IF EXISTS "Staff can insert performances"` for a policy that only exists in
`scripts/01-create-tables.sql`, and both files create a policy literally named
`"Users can view own profile"` on `public.users` — the second `CREATE POLICY` to run fails.
*Impact:* the deployed schema is unknowable from the repository; every runtime behaviour that
depends on a column, constraint or policy is unverifiable.
*Confidence:* **HIGH**
*Recommendation:* V2 must adopt a single, append-only, versioned migration ledger
(`supabase/migrations/`) with `IF NOT EXISTS`-safe DDL and a CI check that the schema
generated from migrations equals the schema generated from the type definitions.

**Finding — a 6.1 MB video is committed as a hero background on multiple pages.**
*Evidence:* `public/space-particles.mp4`; referenced by `components/video-background.tsx`
(682 bytes) which wraps `app/error.tsx`, `app/not-found.tsx` and the public pages.
*Impact:* ~67 % of repository weight is a decorative asset; it is served unoptimised on
mobile, inflating first paint and bandwidth.
*Confidence:* **HIGH**
*Recommendation:* move to a CDN/object storage with adaptive streaming; do not carry into V2.

---

## 2. Root directory map

```
/
├── app/                     110 files  — Next.js App Router (pages + 58 API routes)
├── components/               98 files  — React components (55 shadcn/ui + 43 feature)
├── lib/                      26 files  — business logic, Supabase clients, role systems
├── hooks/                     6 files  — React hooks (auth, session, oauth, mobile, toast)
├── modules/                   6 files  — `discord-portal` feature module (the only "module")
├── scripts/                  25 files  — numbered SQL "migrations" + 2 JS/MD helpers
├── automation-scripts/        9 files  — numbered SQL automation/functions/triggers/cron
├── database/                  8 files  — domain SQL (tryouts, discord, agreements, profile)
├── public/                    6 files  — placeholders + RLogo.ico + 6.1 MB mp4
├── styles/                    1 file   — `globals.css` (duplicate/legacy; app/globals.css is live)
├── cache/                     1 file   — committed `config.json` (build artifact)
├── AUDIT/                     —        — this audit (not part of the legacy repo)
├── 14 root *.md files                    — documentation (heavily drifted, see §8)
├── 8  root *.sql files                   — ad-hoc debug/fix SQL committed at root
├── middleware.ts                        — security headers + (dead) CORS block
├── next.config.mjs                      — Next config (type/lint checks disabled)
├── tailwind.config.ts                   — design tokens (shadcn CSS-variable theme)
├── postcss.config.mjs, components.json, tsconfig.json
├── .eslintrc.json + eslint.config.js    — two ESLint configs
├── .env.example, .gitignore
├── package.json, package-lock.json, pnpm-lock.yaml, build.out
└── next-env.d.ts, RLogo.ico
```

---

## 3. `app/` — 110 files

### 3.1 Purpose
Next.js 14 App Router root. Contains every user-facing page and every HTTP API endpoint.
There is **no `pages/` directory** — 100 % App Router. There is **no `src/` directory**;
`@/*` maps to the repository root (`tsconfig.json:22`).

### 3.2 Page routes (32 page files)
| Group | Files |
| --- | --- |
| Public marketing | `page.tsx` (→ re-exports `public/page.tsx`), `public/page.tsx`, `about/`, `faq/` (24 KB), `gallery/`, `highlight/` (811 B), `incentives/`, `join-us/`, `contact/`, `tier-structure/` |
| Auth | `auth/login/`, `auth/signup/`, `auth/confirm/` (13.7 KB), `auth/forgot/` |
| Onboarding/agreements | `onboarding/` (15.6 KB), `agreement-review/` (15.4 KB) |
| Tryout (public) | `apply/[tryoutId]/` **plus** `apply/[tryoutId]/page.tsx.backup` (10.6 KB, committed backup) |
| Dashboard | `dashboard/page.tsx` (**60.6 KB — largest file in the repo**), `dashboard/layout.tsx` (413 B) |
| Dashboard modules | `analytics/` (27.9 KB), `attendance/` (18.2 KB), `performance/` (34.5 KB), `performance-report/` (23.7 KB), `finance/` (**50.4 KB**), `media/`, `profile/`, `user-management/` (22.9 KB) |
| Team management | `team-management/layout.tsx`, `team-management/page.tsx` (701 B), `teams/`, `roster/`, `slots/` (28.4 KB), `tiers/` (31.6 KB) |
| Tryouts (auth) | `tryouts/`, `tryouts/create/`, `tryouts/[id]/` |
| Discord portal | `discord-portal/`, `discord-portal/logs/`, `discord-portal/settings/`, `discord-portal/webhooks/` (23.3 KB) |
| Admin | `admin/settings/`, `admin/agreements/` |
| **Debug (shipped)** | `debug/page.tsx` (**22.3 KB**), `debug-simple/page.tsx` (9.3 KB) |
| Framework | `layout.tsx`, `error.tsx`, `global-error.tsx`, `not-found.tsx`, `globals.css`, `robots.txt`, `sitemap.xml/route.ts` |

### 3.3 API routes — 58 `route.ts` files
Grouped by domain; see `14_API.md` for the full matrix and `evidence/routes/api-matrix.md`.

| Group | Count | Endpoints |
| --- | --- | --- |
| `api/admin/` | 2 | `settings`, `agreements` |
| `api/agreements/` | 2 | `route`, `content` |
| `api/analytics/` | 1 | `performance` (19.6 KB — largest API file) |
| `api/attendances/` | 3 | `route`, `summary`, `verification` |
| `api/auth/` | 1 | `session` |
| `api/dashboard/` | 1 | `overview` |
| `api/discord/` | 12 | `attendance/mark`, `attendance-summary`, `digest`, `performance/upload`, `sessions`, `team-attendance-summary`, `team-performance`, `tryout/{apply,announce,evaluate,invite,list,status}`, `webhooks` |
| `api/discord-portal/` | 6 | `logs`, `send`, `settings`, `settings/default-webhook`, `webhooks`, `webhooks/validate` |
| `api/expenses/` | 1 | `route` |
| `api/media/` | 2 | `upload`, `delete` |
| `api/performances/` | 1 | `route` |
| `api/profile/` | 3 | `route`, `avatar`, `search` |
| `api/public/` | 4 | `stats`, `submit/application`, `submit/contact`, `upload/contact-file` |
| `api/rosters/` | 1 | `route` |
| `api/sessions/` | 6 | `route`, `attendance-heatmap`, `daily-practice`, `generate-daily`, `mark-attendance`, `practice-config`, `practice-config/reset` |
| `api/slots/` | 1 | `route` (11.6 KB) |
| `api/teams/` | 4 | `route`, `manage`, `monthly`, `[id]/players` |
| `api/tier-defaults/` | 1 | `route` |
| `api/tryouts/` | 1 | `route` |
| `api/users/` | 1 | `route` |
| `api/winnings/` | 1 | `route` |

**Notable absence:** there is **no `api/organizations/`, no `api/tenants/`, no `api/departments/`,
no `api/contracts/`, no `api/sponsors/`, no `api/creators/`, no `api/content/`, no `api/travel/`,
no `api/assets/`, no `api/payroll/`, no `api/billing/`** — the entire commercial/HR/creator half
of the target product is absent from the legacy system.

### 3.4 Dependencies / consumers / status
* **Depends on:** `lib/*`, `hooks/use-auth-v2`, `modules/discord-portal`, `@/components/*`.
* **Consumed by:** browser only. **Every dashboard page is a `'use client'` component** that
  fetches from these API routes with a Bearer token held in JavaScript memory
  (`lib/session-storage.ts:112`).
* **Status:** mixed. 32 page routes + 58 API routes; 2 debug pages and 1 `.backup` file should
  not exist in a production tree.

---

## 4. `components/` — 98 files

### 4.1 Purpose
All React presentation. Split into `ui/` (shadcn/ui primitives), 8 feature folders, and 3
cross-cutting files.

### 4.2 Sub-folders
| Folder | Files | Purpose | Status |
| --- | --- | --- | --- |
| `components/ui/` | **55** | shadcn/ui generated primitives | **29 of 55 are never imported anywhere (dead code)** — see `06_UI_COMPONENTS.md` |
| `components/attendance/` | 12 | attendance marking, heatmaps, verification, session config | Largest feature folder; heavy internal duplication (see §4.3) |
| `components/profile/` | 5 | `profile-sections.tsx` is **32.5 KB**, `bgmi-gaming-section.tsx` 15.8 KB, `profile-search.tsx` 13 KB | Single-org, single-game |
| `components/performance/` | 9 | performance entry, OCR extract, slot selector, dashboards | 5 overlapping submit forms |
| `components/dashboard/` | 3 | `new-dashboard-layout.tsx` (13.6 KB), `role-based-dashboard.tsx` (19.5 KB), `dashboard-content-wrapper.tsx` (310 B) | Layout + role shell |
| `components/analytics/` | 2 | `analytics-sections.tsx` (27.9 KB), `advanced-charts.tsx` | Only consumer of `recharts` |
| `components/discord-portal/` | 1 | `send-to-discord-button.tsx` (19.2 KB) | |
| `components/public/` | 4 | `PublicNavigation`, `PublicHeader`, `PublicFooter`, `public-theme` | |
| `components/session/` | 2 | `idle-timer.tsx`, `token-refresher.tsx` | |
| `components/seo/` | 1 | `OrganizationJsonLd.tsx` | |
| Cross-cutting | 4 | `route-guard-v2.tsx`, `error-boundary.tsx`, `loading-error-boundary.tsx`, `theme-provider.tsx`, `video-background.tsx` | |

### 4.3 Duplication finding — five parallel performance-submission forms
*Evidence:* `components/performance/` contains `add-performance.tsx` (9.3 KB),
`player-performance-submit.tsx` (9.8 KB), `streamlined-performance-submit.tsx` (17.2 KB),
`enhanced-player-performance-submit.tsx` (22.4 KB) and `smart-slot-selector.tsx` (21.6 KB).
`PERFORMANCE_PAGE_CONSOLIDATION.md` (6.1 KB, repository root) documents an *attempted*
consolidation, i.e. the duplication is known and unfinished.
*Impact:* five divergent validation paths for the same write; `app/api/performances` POST
must therefore accept both a "new" and a "legacy" field set (`app/api/performances/route.ts:175-206`).
*Confidence:* **HIGH**
*Recommendation:* classify **REMOVE** (keep none), **REBUILD** the capability once with a
single schema-driven form.

### 4.4 Duplication finding — 12 attendance components
*Evidence:* `mark-attendance.tsx` (15.2 KB) vs `enhanced-mark-attendance.tsx` (18.1 KB);
`session-attendance.tsx` (23.8 KB) vs `training-session-attendance.tsx` (16.3 KB) vs
`scrim-attendance.tsx` (11.6 KB) vs `daily-practice-attendance.tsx` (15.2 KB);
`attendance-stats.tsx` (13.4 KB) vs `attendance-logs.tsx` (9.9 KB) vs `manager-verification.tsx` (14 KB).
*Impact:* six overlapping attendance UIs; the attendance bugs catalogued in
`APPLY_ATTENDANCE_FIX.md`, `DEBUG_ATTENDANCE_ISSUE.md` and `comprehensive_attendance_debug.sql`
are consistent with a component/contract mismatch across these.
*Confidence:* **HIGH**
*Recommendation:* **REBUILD** as a single attendance surface with a session-type discriminator.

---

## 5. `lib/` — 26 files

### 5.1 Purpose
All non-UI business logic. This is where the reusable domain knowledge lives, and where the
authorization model is (five times over).

| File | Size | Purpose | Status |
| --- | --- | --- | --- |
| `supabase.ts` | 21.6 KB | Browser Supabase client + hand-written `Database` type (14 tables) | Active. **No `organization_id` anywhere.** Exports `SUPABASE_ANON_DEBUG` (first 8 chars of anon key) |
| `supabase-admin.ts` | 691 B | Service-role client factory | Active; used by 4 routes |
| `api-utils.ts` | 6.7 KB | `authenticateRequest`, response helpers, `checkRoleAccess`, `checkTeamAccess`, `corsHeaders` (`ACAO: *`) | Active; the de-facto API contract |
| `auth-utils.ts` | 1.4 KB | `getUser(request)` helper | Active |
| `auth-flow-v2.ts` | 26.5 KB | Singleton auth state machine (init/signin/signout/agreement/redirect) | Active, very large |
| `role-system.ts` | 15.5 KB | `ROLE_CONFIG` (8–9 roles × 24 permission flags), `RoleAccess`, `routeAccess` | Active — **permission model #1** |
| `dashboard-permissions.ts` | 9 KB | `DASHBOARD_MODULES` + `DashboardPermissions` | Active — **model #2** |
| `profile-utils.ts` | 9.3 KB | `PROFILE_PERMISSIONS`, `canViewProfile`, `canEditProfile` | Active — **model #3** |
| `session-storage.ts` | 6.3 KB | Session/token wrapper ("secure" claims) | Active — **undermined by `supabase.ts` localStorage persistence** |
| `session-config.ts` | 1.9 KB | Session duration/idle/refresh constants | Active |
| `secure-profile-creation.ts` | 10.2 KB | `createProfile`, `updateUserRole`, **`createAdminProfile`**, `createBatchProfiles` | Active; contains a privilege-escalation-shaped function (§12) |
| `agreement-versions.ts` | 1.6 KB | `CURRENT_AGREEMENT_VERSIONS` (player 2, coach/manager/analyst 1) | Active |
| `profile/` helpers | `profile-utils.ts` | BGMI tiers, sensitivity presets, completion scoring | Active |
| `team-logic.ts` | 5.5 KB | Team/tier helpers | Active |
| `user-management.ts` | 6.6 KB | User admin helpers | Active |
| `ocr-service.ts` | 5 KB | Tesseract.js wrapper + regex parser | Active (client-side) |
| `pdf-export.ts` | 10.7 KB | jsPDF/autoTable/html2canvas report export | Active |
| `cache-manager.ts` | 10.7 KB | Custom in-memory/localStorage cache | Active |
| `optimized-data-service.ts` | 12.2 KB | Data-fetch orchestration layer | Active |
| `performance-optimizer.ts` | 3 KB | Query/aggregation shaping | Active |
| `dashboard-data.ts` | 8.6 KB | Dashboard aggregation | Active |
| `client-utils.ts` | 1.4 KB | `useSafeRedirect` (open-redirect guard) | Active |
| `global-loading-manager.tsx` | 7.9 KB | Global loading overlay singleton | Active |
| `global-theme.ts` | 7.7 KB | `getButtonStyle()` hardcoded class strings | Active |
| `discord-bot-auth.ts` | 3.7 KB | `validateBotApiKey`, `RATE_LIMITS`, `logBotApiRequest` | **100 % DEAD CODE** — see §5.2 |
| `force-logout.ts` | 2.1 KB | Emergency logout, builds DOM via `innerHTML` | Active |
| `utils.ts` | 172 B | `cn()` | Active |

### 5.2 Dead-code finding — the only rate limiter and bot-auth library is never used
*Evidence:* `lib/discord-bot-auth.ts` exports `validateBotApiKey` (line 8), `getClientIp`
(32), `getUserAgent` (44), `RATE_LIMITS` (51), `BOT_API_ERRORS` (80), `logBotApiRequest` (119).
A repository-wide symbol search returns **only the definition file** — zero importers.
Every `app/api/discord/**` route instead declares its own local copy of
`validateBotApiKey` (e.g. `app/api/discord/tryout/apply/route.ts:5-13`).
*Impact:* **there is no rate limiting anywhere in the application**, and no request logging for
the bot surface, despite a rate-limit policy having been written.
*Confidence:* **HIGH**
*Recommendation:* V2 needs a real, centrally enforced rate limiter (per-identity and per-IP)
applied at the edge, plus structured request logging.

### 5.3 Structural finding — no service layer
*Evidence:* business rules live in three places simultaneously: (a) API route handlers
(`app/api/performances/route.ts:240-265` role checks), (b) `lib/*` helpers, and (c) SQL
`SECURITY DEFINER` functions/triggers (e.g. `automation-scripts/04-business-logic-automation.sql:12-32`).
There is no `services/` directory and no repository/service abstraction anywhere.
*Impact:* no single place to review or test a business rule; rules drift (e.g. attendance
`slot` vs `slot_id` is implemented 6 different ways across 6 SQL scripts).
*Confidence:* **HIGH**
*Recommendation:* V2 requires an explicit application-service layer with the database
enforcing only invariants, not duplicating business rules.

---

## 6. `hooks/` — 6 files

| File | Size | Purpose | Status |
| --- | --- | --- | --- |
| `use-auth-v2.tsx` | 19.5 KB | `AuthProviderV2`, `useAuth`, `useSafeRedirect`, Supabase auth event wiring, intended-route persistence | Active, largest hook |
| `use-session.ts` | 4.7 KB | Session helpers | Active |
| `use-oauth-session-detector.tsx` | 1.9 KB | Detects OAuth callback sessions | Active — **but no OAuth provider is configured anywhere in code** |
| `use-post-auth-redirect.tsx` | 5.3 KB | Post-auth redirect | Active |
| `use-mobile.tsx` | 584 B | `useIsMobile()` | Active |
| `use-toast.ts` | 4.1 KB | shadcn toast store | Active |

**Finding — OAuth support is documented in code but not configured.**
*Evidence:* `hooks/use-oauth-session-detector.tsx` exists and `lib/auth-flow-v2.ts:321,428`
reads `user.app_metadata?.provider`, but `package.json` has no OAuth SDK, and there is no
`signInWithOAuth` call and no provider configuration anywhere in the repository
(`rg "signInWithOAuth"` → 0 hits). `README.md` documents only email/password.
*Impact:* the only implemented auth path is email+password with Supabase's default settings.
*Confidence:* **HIGH**
*Recommendation:* V2 must decide explicitly whether Google/MS SSO is in scope; the current
code is a half-built hook with no configuration surface.

---

## 7. `modules/` — 6 files (`modules/discord-portal/`)

| File | Size | Purpose | Status |
| --- | --- | --- | --- |
| `index.ts` | 4.1 KB | Barrel export | Active |
| `types.ts` | 4.5 KB | `DiscordWebhook`, `MessageType`, `AutomationKey`, `WebhookType` | Active |
| `embeds.ts` | 11.4 KB | `formatEmbed(messageType, data)` for 12 message types | Active — **contains corrupted emoji literals** |
| `permissions.ts` | 7.5 KB | Discord-specific permission helpers | Active |
| `sendToDiscord.ts` | 10.7 KB | `sendToDiscord`, `sendWebhookMessage`, `retryFailedMessage`, `getDiscordLogs` | Active but **uses a session-less anon client** |
| `webhookService.ts` | 12 KB | `getTeamWebhooks`, `createWebhook`, `updateWebhook`, `deleteWebhook`, `validateWebhookUrl`, automation settings CRUD | Active but **uses a session-less anon client** |

**This is the only feature module in the repository.** It is also the clearest example of the
architecture's central flaw: a "service layer" that creates its own Supabase client with the
**anon key and no user session**, so every one of its functions executes as `anon` and is
subject to RLS with `auth.uid() = NULL` (see `13_RLS_SECURITY.md`).

---

## 8. `scripts/`, `automation-scripts/`, `database/` — the schema problem

### 8.1 `scripts/` (25 files)
Numbered `00`–`21` plus two duplicates of the same numbers (`14-` twice, `15-` twice,
`16-` twice, `17-` twice, `18-` twice) and three root-level debug files.
Examples: `00-complete-schema-setup.sql` (31 KB), `01-create-tables.sql`,
`04-create-team-management-tables.sql`, `05-seed-team-management-data.sql`,
`11-create-attendance-table.sql`, `13-comprehensive-database-fixes.sql`,
`14-fix-critical-schema-mismatches.sql`, `15-fix-rls-policies.sql`,
`17-fix-performance-slot-mapping.sql`, `19-fix-slot-field-constraint.sql`,
`21-fix-attendance-session-time-constraint.sql`, plus `migrate-to-auth-v2.md` and
`update-auth-imports.js`.

### 8.2 `automation-scripts/` (9 files)
`01-core-automation-functions.sql` … `08-storage-bucket-setup.sql` + `README.md`.
Creates 22 functions, 9 triggers, 6 `pg_cron` jobs, 4 storage buckets and 16 storage policies.

### 8.3 `database/` (8 files)
`SUPABASE_TRYOUTS_SETUP_FIXED.sql` (22.4 KB), `complete-discord-portal-setup.sql` (16.4 KB),
`session-attendance-schema.sql`, `AGREEMENT_ENFORCEMENT_SETUP.sql`,
`EMERGENCY_AGREEMENT_FIX.sql`, `profile-enhancement.sql`,
`discord-webhook-channel-update.sql`, `README.md`.

### 8.4 Root-level ad-hoc SQL (8 files) — should never have been committed
`comprehensive_attendance_debug.sql`, `debug_attendance_trigger.sql`,
`investigate_existing_attendance.sql`, `test_attendance_function.sql`,
`database-schema-updates.sql` (12.5 KB — a *fourth* schema-change location).

**Finding — the schema is defined in four separate locations with overlapping and conflicting definitions.**
*Evidence:* 51 `.sql` files. Example conflict chain for `performances`:
`00-complete-schema-setup.sql:153-171` creates `performances` with a `slot uuid` column and **no
`slot_id`**; `14-fix-critical-schema-mismatches.sql:11-24` *adds* `slot_id`;
`17-fix-performance-slot-mapping.sql:50-71` migrates `slot` → `slot_id`;
`19-fix-slot-field-constraint.sql:50-54` then declares `slot` to be a *legacy integer field*
and makes it nullable. The API (`app/api/performances/route.ts:278-279`) writes
`slot_id: finalSlotId, slot: null`. Same pattern for `attendances` (`session_id`,
`manager_notes`, `notes`) across `database/session-attendance-schema.sql:48-65`,
`database-schema-updates.sql:19-113` and `scripts/14-…:33-51`.
*Impact:* the correct deployment order is undocumented and order-sensitive; two of the 21
scripts conflict on policy names; at least one API field (`attendances.notes`) has **no
column in any SQL file**.
*Confidence:* **HIGH**
*Recommendation:* treat the entire SQL estate as an untrusted archaeological record. Extract
*semantics* (see `94_REBUILD_STRATEGY.md`) and **ARCHIVE** the scripts; do not attempt to
replay them.

---

## 9. Documentation (`*.md`) — 14 files, heavily drifted

| File | Claims | Verified status |
| --- | --- | --- |
| `README.md` (8.8 KB) | "Row Level Security (RLS) on all database tables"; "API route protection with middleware"; "Secure authentication via Supabase Auth" | **All three false.** RLS enabled on only 18 of 32 tables; `middleware.ts` performs **no auth** and is excluded from `/api/*` by its own matcher; security rests on RLS + ad-hoc per-route checks |
| `API_DOCUMENTATION.md` (9 KB) | Endpoint list + role matrix | Role matrix contradicts code (see §10) |
| `DATABASE.md` (11.8 KB) | Full schema reference, "Security & RLS" section | Describes tables that exist, but omits `discord_servers`, `discord_users`, `performance_records`, `bot_attendance`, `practice_session_config`, `team_monthly_stats`, `attendance_debug_log`; and documents an `attendances.notes` column that no SQL creates |
| `DEPLOYMENT.md` (10.4 KB) | Vercel + Supabase deployment | Contains the only backup/DR discussion found |
| `database/README.md` (3 KB) | "For development, RLS is disabled… **Re-enable RLS for production**"; "RLS is currently disabled for development" | **The single most important sentence in the repository** — see §10 |
| `automation-scripts/README.md` | Run order 1→8, 22 functions, 9 triggers, 6 cron jobs | Order-dependent and partially contradicted by `scripts/` |
| `APPLY_ATTENDANCE_FIX.md`, `DEBUG_ATTENDANCE_ISSUE.md` | Known attendance bugs | Confirms attendance is the most defect-dense area |
| `PERFORMANCE_PAGE_CONSOLIDATION.md` | Attempted performance-form consolidation | Unfinished |
| `ENHANCED_PERFORMANCE_FORM.md` | Enhanced form spec | Unfinished |
| `CHANGELOG.md` (4.7 KB) | Single entry dated `[2024-01-20]` describing auth fixes and "deleted 20+ outdated markdown documentation files" | **Date is wrong** (all commits are 2025-08); claims "All TypeScript types validated" while a `ReferenceError` ships |
| `scripts/migrate-to-auth-v2.md` | Auth v2 migration plan | Partially executed |

### 9.1 Encoding corruption across the documentation and code
*Evidence:* `README.md:12` "🚀"; `DATABASE.md:5` "## 📊"; `CHANGELOG.md` "### dY"
Authentication Issues Fixed"; `app/layout.tsx:22` `description: "Raptor Esports �? official hub…"`;
`lib/session-config.ts:31` `console.warn('�s��,? Session duration…')`;
`app/error.tsx:102-104` `�?� Try refreshing the page…`; `modules/discord-portal/embeds.ts`
and all 5 `app/api/discord/tryout/*` routes use `dY"?'`, `dYZ%`, `�o.` in place of emoji.
*Impact:* user-visible copy and **all Discord embed decorations render as mojibake**. The
Discord bot's entire visual output layer is corrupted.
*Confidence:* **HIGH**
*Recommendation:* treat all string literals in the legacy tree as untrusted content; re-author
copy in V2. Add a CI check for U+FFFD replacement characters.

---

## 10. Two sentences that define the whole audit

1. `database/README.md:41-46`
   > "For development, RLS is disabled. To disable RLS on users table:
   > `ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;`
   > **Note: Re-enable RLS for production with proper policies.**"
   `database/README.md:73-75` repeats it: "**Currently disabled for development** — Should be
   enabled for production."

2. `next.config.mjs:15-21`
   > `// Relax build-time checks to prevent non-critical warnings from failing CI builds`
   > `eslint: { ignoreDuringBuilds: true }`, `typescript: { ignoreBuildErrors: true }`

Together these explain why a codebase with 3 unauthenticated service-role endpoints,
10 RLS-less tables, a purge-everything admin action, and a `ReferenceError` in a live route
could be described in its own README as having "Row Level Security (RLS) on all database
tables" and "API route protection with middleware".

---

## 11. Remote branch inventory (20 branches)

`main`, `Original-deployed-site`, `vercel/react-server-components-cve-vu-nkppb8`,
`feature/cc-application-integration-*`, and 16 `cursor/*` branches.

**Finding — an unmerged Vercel React Server Components CVE branch exists.**
*Evidence:* branch `vercel/react-server-components-cve-vu-nkppb8`. The project pins
`next: ^14.2.30` (`package.json:55`).
*Impact:* the caret range `^14.2.30` will resolve to the latest 14.x on install, so a
production `pnpm install` may or may not pick up the RSC advisory fix depending on lockfile
state; the presence of a dedicated unmerged branch indicates the team identified it and did
not close it. This must be verified against the current Next.js advisory database.
*Impact/severity:* **HIGH** (supply chain / framework CVE handling)
*Confidence:* **MEDIUM** (branch name is evidence of awareness; the actual patch state cannot
be determined without installing and auditing the lockfile)
*Recommendation:* pin Next.js to an exact, currently-supported version; add
`npm audit`/`osv-scanner` to CI; delete stale remote branches.

---

## 12. Directory status summary

| Directory | Files | Purpose | Consumers | Status |
| --- | --- | --- | --- | --- |
| `app/` | 110 | Pages + 58 API routes | Browser | Active; contains debug + backup files that must not ship |
| `app/api/` | 58 | HTTP surface | Browser, Discord bot | Active; 3 unauthenticated service-role routes, 1 broken handler |
| `components/` | 98 | UI | `app/` | Active; 29/55 `ui/` files dead, heavy duplication |
| `lib/` | 26 | Logic | `app/`, `hooks/`, `modules/` | Active; no service boundary, 1 fully dead file |
| `hooks/` | 6 | React hooks | `app/`, `components/` | Active; 1 half-implemented (OAuth) |
| `modules/` | 6 | Discord portal | `app/api/discord-portal/**` | Active but architecturally unsound (anon client) |
| `scripts/` | 25 | SQL "migrations" | Manual operator | **Untrustworthy; conflicts and duplicates** |
| `automation-scripts/` | 9 | SQL functions/triggers/cron/buckets | Manual operator | Valuable semantics, unsafe grants |
| `database/` | 8 | Domain SQL | Manual operator | Tryouts model is the most valuable artefact in the repo |
| `public/` | 6 | Static assets | Browser | 6.1 MB decorative video; no `og-image.jpg` despite metadata referencing it |
| `styles/` | 1 | `globals.css` | Nothing | **Dead** — `app/globals.css` is the live stylesheet |
| `cache/` | 1 | `config.json` | Nothing | **Committed build artifact — dead** |
| root `*.md` | 14 | Documentation | Humans | Drifted; contradicts source |
| root `*.sql` | 8 | Debug SQL | Humans | **Should never be committed** |
