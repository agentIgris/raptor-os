# 02 — FILE INVENTORY

**Audit.md section:** 5 (SECTION 02 — FILE INVENTORY)
**Machine-readable companion:** `02_FILE_INVENTORY.csv` (326 rows, one per tracked file, with
`path,type,bytes,lines,imports,kind,db_ops`).

---

## 1. Corpus summary

| Metric | Value |
| --- | --- |
| Files inventoried | **326** |
| TypeScript + TSX files | 246 (53,207 lines) |
| SQL files | 43 (8,537 lines) |
| Markdown documents | 12 (+2 more counted as `.backup`/other) |
| JSON config | 6 |
| Files performing database operations (`.from(` / `.rpc(`) | **67** |
| Test files | **0** |
| Largest TSX file | `app/dashboard/page.tsx` — 60,575 bytes |
| Largest API route | `app/api/analytics/performance/route.ts` — 19,630 bytes |
| Largest SQL file | `scripts/00-complete-schema-setup.sql` — 31,110 bytes |
| Largest lib file | `lib/auth-flow-v2.ts` — 26,466 bytes |
| Mean API route size | ~7.3 KB (58 routes) |

Status legend used in this document and in the CSV analysis:

| Status | Meaning |
| --- | --- |
| `active` | Reachable from a route, layout, or another active module |
| `unused` | Exists but has no importer |
| `dead` | Imported only by other dead code, or superseded |
| `deprecated` | Superseded but retained (e.g. `page.tsx.backup`) |
| `duplicate` | Functionally overlapping another file |
| `experimental` | Debug/diagnostic surface |
| `unknown` | Cannot be classified statically |

---

## 2. Per-directory inventory

### 2.1 `app/api/**` — 58 route files (status: active, 3 critical, 1 broken)

| Path | Methods | Auth mechanism | Role check | Service role | CORS | Validation | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `admin/agreements/route.ts` | GET, POST | `getUser` (lib/auth-utils) | admin — but role read via **anon** client | no | no | manual | **broken** (role read fails ⇒ always 403) |
| `admin/settings/route.ts` | GET, POST | `authenticateRequest` | `role === 'admin'` | **YES** | yes | none | active; contains destructive purge |
| `agreements/route.ts` | GET, POST | `getUser` + user-bound client | self-scoped | no | no | manual | active; client-controlled `role` |
| `agreements/content/route.ts` | GET | none | none | no | no | none | active (public content) |
| `analytics/performance/route.ts` | GET | `authenticateRequest` | role-scoped | no | yes | manual | active |
| `attendances/route.ts` | GET, POST, PUT, **DELETE** | `authenticateRequest` | role + ownership | no | yes | UUID + required | **DELETE broken** (`getUserFromRequest` undefined) |
| `attendances/summary/route.ts` | GET | `authenticateRequest` | role-scoped | no | no | none | active |
| `attendances/verification/route.ts` | GET, PUT | `authenticateRequest` | role-scoped | no | no | none | active |
| `auth/session/route.ts` | GET | none (echoes caller token) | none | no | no | none | active, low value |
| `dashboard/overview/route.ts` | GET | `authenticateRequest` | role-scoped | no | yes | none | active |
| `discord/attendance/mark/route.ts` | POST | bot API key | **none** | no | no | manual | active; anon DB client |
| `discord/attendance-summary/route.ts` | GET | bot API key | **none** | no | no | none | active; anon DB client |
| `discord/digest/route.ts` | GET | bot API key | **none** | no | no | none | active; anon DB client |
| `discord/performance/upload/route.ts` | POST | bot API key | **none** | no | no | manual | active; anon DB client |
| `discord/sessions/route.ts` | GET | bot API key | **none** | no | no | none | active; anon DB client |
| `discord/team-attendance-summary/route.ts` | GET | bot API key | **none** | no | no | none | active; anon DB client |
| `discord/team-performance/route.ts` | GET | bot API key | **none** | no | no | none | active; anon DB client |
| `discord/tryout/apply/route.ts` | POST | bot API key | **none** | no | no | manual | active |
| `discord/tryout/announce/route.ts` | POST | bot API key | **none** | no | no | manual | **broken** (anon insert vs staff-only policy); dead apply URL |
| `discord/tryout/evaluate/route.ts` | POST | bot API key | **none** | no | no | manual | **broken** (anon insert vs evaluator policy) |
| `discord/tryout/invite/route.ts` | POST | bot API key | **none** | no | no | manual | **broken** (anon insert vs staff-only policy) |
| `discord/tryout/list/route.ts` | GET | bot API key | **none** | no | no | none | partially working (public tryouts only; stats always empty) |
| `discord/tryout/status/route.ts` | GET | bot API key | **none** | no | no | none | **broken** (no anon SELECT policy on applications) |
| `discord/webhooks/route.ts` | GET, POST | bot API key | **none** | no | no | none | active |
| `discord-portal/logs/route.ts` | GET, POST | user-bound client | role-scoped | no | no | none | active |
| `discord-portal/send/route.ts` | GET, POST | user-bound client | role-scoped | no | no | manual | active |
| `discord-portal/settings/route.ts` | GET, PUT | user-bound client | role + team | no | no | key allowlist | active — **best authz pattern in repo** |
| `discord-portal/settings/default-webhook/route.ts` | GET, PUT | user-bound client | admin | **YES** | no | none | active |
| `discord-portal/webhooks/route.ts` | GET, POST, PUT, DELETE | user-bound client | role + team | no | no | URL regex on PUT only | active; **mass assignment in PUT** |
| `discord-portal/webhooks/validate/route.ts` | POST | **NONE** | **none** | no | no | URL regex | **unauthenticated SSRF-capable endpoint** |
| `expenses/route.ts` | GET | `authenticateRequest` | role-scoped | no | no | none | active |
| `media/delete/route.ts` | DELETE | **NONE** | **none** | **YES** | no | none | **CRITICAL — unauthenticated delete** |
| `media/upload/route.ts` | POST | **NONE** | **none** | **YES** | no | MIME allowlist + 20 MB | **CRITICAL — unauthenticated upload** |
| `performances/route.ts` | GET, POST | `authenticateRequest` | role + team + self | no | yes | required + numeric | active |
| `profile/avatar/route.ts` | POST, DELETE | `getUser` | self or admin/manager | **YES** (storage) | no | MIME + 5 MB | active |
| `profile/route.ts` | GET, PUT | `authenticateRequest` | `canViewProfile`/`canEditProfile` | no | yes | field allowlist | active |
| `profile/search/route.ts` | GET | `getUser` (role) + **anon** client (query) | admin/manager | no | no | none; **PostgREST `.or()` interpolation** | **broken + injectable** |
| `public/stats/route.ts` | GET | **NONE** | **none** | no | no | none | active; **fabricated public metrics** |
| `public/submit/application/route.ts` | POST | **NONE** | **none** | no | no | none | active; unauthenticated Discord relay |
| `public/submit/contact/route.ts` | POST | **NONE** | **none** | **YES** (admin fallback) | no | none | active; unauthenticated Discord relay |
| `public/upload/contact-file/route.ts` | POST | **NONE** | **none** | **YES** | no | MIME + 10 MB | **CRITICAL — unauth upload; broken public URL** |
| `rosters/route.ts` | GET, POST, PUT, DELETE | `authenticateRequest` | role-scoped | no | no | none | active |
| `sessions/route.ts` | GET, POST, PUT, DELETE | `authenticateRequest` | role + team | no | yes | required + UUID | active |
| `sessions/attendance-heatmap/route.ts` | GET | `authenticateRequest` | role-scoped | no | no | none | active |
| `sessions/daily-practice/route.ts` | GET | `authenticateRequest` | role-scoped | no | no | none | active |
| `sessions/generate-daily/route.ts` | GET, POST | `authenticateRequest` | role | no | no | none | active; calls RPC |
| `sessions/mark-attendance/route.ts` | POST | `authenticateRequest` | role + team | no | no | manual | active |
| `sessions/practice-config/route.ts` | GET, POST, PUT, DELETE | `authenticateRequest` | role + team | no | no | manual | active |
| `sessions/practice-config/reset/route.ts` | POST | `authenticateRequest` | role | no | no | none | active |
| `slots/route.ts` | GET, POST, DELETE | `authenticateRequest` | role + team | no | yes | manual | active |
| `teams/route.ts` | GET | `authenticateRequest` | role-scoped | no | yes | none | active |
| `teams/manage/route.ts` | POST, PUT, DELETE | `authenticateRequest` | role | no | yes | manual | active |
| `teams/monthly/route.ts` | GET, POST | `authenticateRequest` | role | no | no | none | active |
| `teams/[id]/players/route.ts` | GET, POST, DELETE | `authenticateRequest` | role + team | no | yes | manual | active |
| `tier-defaults/route.ts` | GET, PUT | `authenticateRequest` | role | no | no | none | active |
| `tryouts/route.ts` | GET, POST | `authenticateRequest` | role | no | yes | manual | active |
| `users/route.ts` | GET, PUT | `authenticateRequest` | role (PUT: admin only) | no | yes | role allowlist | active; **`select('*')` over-exposure**; PUT calls an RPC that is not defined anywhere in the repo |
| `winnings/route.ts` | GET | `authenticateRequest` | role-scoped | no | no | none | active |

**Aggregate API findings**

| Finding | Evidence | Impact | Confidence |
| --- | --- | --- | --- |
| 4 endpoints have **no authentication at all** and 2 of those use the **service-role key** | `media/upload`, `media/delete`, `public/upload/contact-file`, `discord-portal/webhooks/validate`, plus intentionally-public `public/*` | Anonymous arbitrary file write/delete in a public bucket | HIGH |
| 5 endpoints authenticate with a **shared static secret** and no per-request signature, nonce, timestamp or replay protection | `app/api/discord/**` (12 files), each with a local `validateBotApiKey` | Full replay; single key compromise exposes the entire bot surface | HIGH |
| 9 endpoints use the **module-level anon Supabase client** for data access after authenticating by other means | `admin/agreements`, `profile/search`, `profile/avatar`, all `discord/tryout/*` | `auth.uid()` is NULL at the database → policy denials (broken) or, if RLS is off, silent authorization bypass | HIGH |
| `Access-Control-Allow-Origin: *` exported for API routes | `lib/api-utils.ts:240-244` (`corsHeaders`), used by 12 routes | Any origin may read API responses; combined with a token in JS this widens XSS impact | MEDIUM |
| No rate limiting on any endpoint | `lib/discord-bot-auth.ts` `RATE_LIMITS` never imported | Abuse, cost exhaustion, Discord webhook flooding | HIGH |

---

### 2.2 `app/**` page files — 32 files

| Path | Bytes | Client/Server | Auth (client guard) | Role gate | Loading | Error | Empty | Responsive | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `app/page.tsx` | 132 | client | public | — | none | none | n/a | n/a | active (re-export) |
| `app/public/page.tsx` | 4,839 | client | public | — | none | local | n/a | yes | active |
| `app/about/page.tsx` | 7,502 | client | public | — | none | local | n/a | yes | active |
| `app/faq/page.tsx` | 24,554 | client | public | — | none | local | n/a | yes | active; JSON-LD |
| `app/gallery/page.tsx` | 7,601 | client | **not in `PUBLIC_ROUTES`** | none | local | local | n/a | yes | **inaccessible-but-public**; removed from nav per commit `fa34734` |
| `app/highlight/page.tsx` | 811 | client | **not in `PUBLIC_ROUTES`** | none | none | none | n/a | minimal | **dead-ish** |
| `app/incentives/page.tsx` | 8,025 | client | public | — | none | local | n/a | yes | active |
| `app/join-us/page.tsx` | 17,872 | client | public | — | local | local | yes | yes | active |
| `app/contact/page.tsx` | 17,967 | client | public | — | local | local | yes | yes | active |
| `app/tier-structure/page.tsx` | 8,654 | client | public | — | none | local | n/a | yes | active |
| `app/auth/login/page.tsx` | 13,319 | client | public | — | yes | yes | n/a | yes | active |
| `app/auth/signup/page.tsx` | 14,445 | client | public | — | yes | yes | n/a | yes | active |
| `app/auth/confirm/page.tsx` | 13,731 | client | public | — | yes | yes | n/a | partial | active; 13.7 KB for an OTP confirm screen |
| `app/auth/forgot/page.tsx` | 4,231 | client | public | — | yes | yes | n/a | yes | active |
| `app/onboarding/page.tsx` | 15,613 | client | protected | none | yes | yes | n/a | yes | active |
| `app/agreement-review/page.tsx` | 15,361 | client | protected | none | yes | yes | n/a | yes | active |
| `app/apply/[tryoutId]/page.tsx` | 12,382 | client | public | — | yes | yes | yes | yes | active |
| `app/apply/[tryoutId]/page.tsx.backup` | 10,653 | — | — | — | — | — | — | — | **DEPRECATED — committed backup of a route file** |
| `app/dashboard/layout.tsx` | 413 | client | delegates to `NewDashboardLayout` | via `DASHBOARD_MODULES` | yes | boundary | n/a | yes | active |
| `app/dashboard/page.tsx` | 60,575 | client | protected | role-aware | yes | yes | yes | yes | active; **monolith** |
| `app/dashboard/analytics/page.tsx` | 27,886 | client | protected | role | yes | yes | yes | yes | active |
| `app/dashboard/attendance/page.tsx` | 18,154 | client | protected | role | yes | yes | yes | yes | active |
| `app/dashboard/performance/page.tsx` | 34,503 | client | protected | role | yes | yes | yes | yes | active; 5 forms |
| `app/dashboard/performance-report/page.tsx` | 23,695 | client | protected | role | yes | yes | yes | yes | active; PDF export |
| `app/dashboard/finance/page.tsx` | 50,355 | client | protected | admin/manager | yes | yes | yes | yes | active; **monolith** |
| `app/dashboard/media/page.tsx` | 6,110 | client | protected | role | yes | yes | yes | partial | active |
| `app/dashboard/profile/page.tsx` | 9,488 | client | protected | self | yes | yes | n/a | yes | active |
| `app/dashboard/user-management/page.tsx` | 22,949 | client | protected | admin/manager (nav) | yes | yes | yes | yes | active; calls undefined RPC |
| `app/dashboard/team-management/**` (5) | 2,305 / 701 / 16,849 / 28,407 / 15,451 / 31,630 | client | protected | role | mixed | mixed | mixed | yes | active |
| `app/dashboard/tryouts/**` (3) | 11,625 / 3,288 / 14,539 | client | protected | role | yes | yes | yes | yes | active |
| `app/dashboard/discord-portal/**` (4) | 14,963 / 14,693 / 11,748 / 23,253 | client | protected | admin/manager (nav) | yes | yes | yes | yes | active |
| `app/dashboard/admin/settings/page.tsx` | 11,250 | client | protected | admin (nav) | yes | yes | n/a | yes | active; **exposes purge control** |
| `app/dashboard/admin/agreements/page.tsx` | 15,487 | client | protected | admin (nav) | yes | yes | n/a | yes | active; endpoint always 403 |
| `app/debug/page.tsx` | 22,337 | client | protected | **NONE** | n/a | n/a | n/a | partial | **EXPERIMENTAL — ships to prod, can CREATE slots** |
| `app/debug-simple/page.tsx` | 9,310 | client | protected | **NONE** | n/a | n/a | n/a | partial | **EXPERIMENTAL — ships to prod, can CREATE slots** |
| `app/error.tsx` | 5,032 | client | — | — | — | shows raw `error.message` | n/a | yes | active; **info disclosure** |
| `app/global-error.tsx` | 5,503 | client | — | — | — | — | n/a | yes | active |
| `app/not-found.tsx` | 1,707 | client | — | — | — | — | n/a | yes | active |
| `app/layout.tsx` | 2,341 | server shell | mounts `RouteGuardV2` | client-only | — | boundaries | n/a | — | active; references missing `/og-image.jpg` |
| `app/globals.css` | 13,853 | CSS | — | — | — | — | n/a | tokens | active |
| `app/robots.txt` | 258 | static | — | — | — | — | — | — | active |
| `app/sitemap.xml/route.ts` | 735 | route | public | — | — | — | — | — | active |

**Route-guard finding — client-side-only protection, and two debug pages with write access are reachable by any authenticated role.**
*Evidence:* `components/route-guard-v2.tsx:13-32` `PUBLIC_ROUTES` does not contain `/debug`,
`/debug-simple`, `/highlight` or `/gallery`; the guard's only enforcement is
`if (!authState.isAuthenticated && !isPublicRoute(pathname)) safeRedirect('/')` (line 114-118)
— it **never checks roles** and never blocks rendering for authenticated-but-unauthorized users.
`app/debug/page.tsx:153` performs `fetch('/api/slots', { method: … })` and
`app/debug-simple/page.tsx:48` does the same.
*Impact:* a `pending_player` or `tryout` account can navigate to `/debug` and **create slot
records**; `DASHBOARD_MODULES` hides the link but the URL is not protected. Debug pages also
surface raw API/database error text to the browser.
*Severity:* **HIGH** · *Confidence:* **HIGH**
*Recommendation:* delete both debug pages; enforce authorization server-side per route
(Next.js middleware + per-handler checks); never rely on a client guard.

---

### 2.3 `components/**` — 98 files

Full per-component detail in `06_UI_COMPONENTS.md`. Status roll-up:

| Status | Count | Examples |
| --- | --- | --- |
| active | 43 feature + 26 `ui/` | `card`, `button`, `select`, `table`, `dialog`, `alert`, `input`, `label`, `badge`, `textarea`, `switch`, `tabs`, `checkbox`, `popover`, `progress`, `avatar`, `calendar`, `separator`, `radio-group`, `toast`, `toaster`, `accordion`, `sheet`, `global-loading`, `count-up`, `tooltip`, `fade-in-on-scroll`, `enhanced-tabs` |
| **dead (never imported)** | **29** | `form`, `chart`, `sidebar`, `sonner`, `dropdown-menu`, `context-menu`, `command`, `breadcrumb`, `carousel`, `collapsible`, `drawer`, `menubar`, `navigation-menu`, `pagination`, `resizable`, `scroll-area`, `hover-card`, `input-otp`, `aspect-ratio`, `alert-dialog`, `toggle`, `toggle-group`, `slider`, `skeleton`, `responsive-filters`, `responsive-grid`, `responsive-tabs`, `count-up`(1 use) |
| duplicate | 5 performance forms + 12 attendance components | see `01_REPOSITORY_MAP.md` §4.3–4.4 |
| experimental | `components/error-boundary.tsx` + `loading-error-boundary.tsx` (both used) | — |

---

### 2.4 `lib/**` — 26 files

See `01_REPOSITORY_MAP.md` §5 for the annotated table. Status roll-up:
24 active, 1 dead (`discord-bot-auth.ts`), 1 near-dead (`supabase-admin.ts` used by only 4
routes), plus `SUPABASE_URL_DEBUG`/`SUPABASE_ANON_DEBUG` exports at `lib/supabase.ts:683-684`
that leak the Supabase URL and the first 8 characters of the anon key to the client bundle.

---

### 2.5 `modules/discord-portal/**` — 6 files

All active. Architectural status: **functionally coupled to a session-less anon Supabase
client** (`webhookService.ts:21-23`, `sendToDiscord.ts:21-23`), which means every function
executes with `auth.uid() = NULL`.

---

### 2.6 `scripts/**`, `automation-scripts/**`, `database/**`, root `*.sql` — 51 SQL files

Status: **untrustworthy**. Duplicate `CREATE TABLE`, duplicate `CREATE POLICY` names,
`DROP POLICY IF EXISTS` for policies defined in other files, four different definitions of
`create_auto_attendance*`, and columns referenced by the API that no script creates.

| SQL concept | Competing definitions | Files |
| --- | --- | --- |
| `create_auto_attendance` | 4 (`create_auto_attendance`, `_v2`, `_fixed` ×3) | `scripts/11`, `scripts/15`, `scripts/16`, `scripts/17`, `scripts/18`, `database-schema-updates.sql` |
| `performances` table | 3 | `scripts/00`, `scripts/01`, `scripts/04` (via FK), + `scripts/14` ALTER |
| RLS enable | 3 overlapping sets | `scripts/00`, `scripts/01`, `scripts/04`, `scripts/11`, `scripts/13`, `scripts/14` |
| `check_user_agreement_status` | 3 | `automation-scripts/04`, `database/AGREEMENT_ENFORCEMENT_SETUP`, `database/EMERGENCY_AGREEMENT_FIX` |
| `discord_webhooks`/`communication_*` | 2 full schemas | `scripts/00`, `database/complete-discord-portal-setup.sql`, `automation-scripts/03` |

---

### 2.7 `public/**`, `styles/**`, `cache/**`

| Path | Status | Note |
| --- | --- | --- |
| `public/space-particles.mp4` | active | 6.1 MB decorative video |
| `public/placeholder.jpg/.svg`, `placeholder-logo.png/.svg`, `placeholder-user.jpg` | active | generic placeholders shipped as brand assets |
| `public/og-image.jpg` | **MISSING** | referenced by `app/layout.tsx:37,42` OpenGraph/Twitter metadata → broken social cards |
| `RLogo.ico` | active | favicon; referenced from `app/layout.tsx:31` (repo root, not `/public` — served by Next from root, works) |
| `styles/globals.css` | **DEAD** | duplicate of `app/globals.css`; nothing imports it |
| `cache/config.json` | **DEAD** | committed build artifact (`telemetry.notifiedAt`) |
| `build.out` | **DEAD** | committed Corepack prompt output |

---

### 2.8 Configuration files

| Path | Purpose | Status / risk |
| --- | --- | --- |
| `package.json` | deps + 4 scripts | **no `test` script**; `lint` = `next lint`; `packageManager: pnpm@10.14.0` |
| `pnpm-lock.yaml` (260 KB) + `package-lock.json` (368 KB) | **two lockfiles for two package managers** | non-reproducible installs; must pick one |
| `next.config.mjs` | Next config | `eslint.ignoreDuringBuilds: true`, `typescript.ignoreBuildErrors: true`, `compiler.removeConsole` in production, hardcoded Supabase host in `images.domains`, custom `splitChunks` |
| `tsconfig.json` | TS config | `strict: true` (good) but `allowJs: true`, `skipLibCheck: true`, `target: ES6` |
| `tailwind.config.ts` | design tokens | shadcn CSS-variable theme; **no custom font scale, no container config, no safelist** |
| `components.json` | shadcn config | `style: "default"`, `baseColor: neutral`, `iconLibrary: lucide` |
| `.eslintrc.json` + `eslint.config.js` | **two ESLint configs** | conflicting; `eslint.config.js` is flat config while `.eslintrc.json` is legacy |
| `.env.example` | 12 vars documented | **5 of 12 are unused in code**; **14 vars used in code are undocumented** |
| `.gitignore` | ignores | correct for `.env*`; `next-env.d.tscore` on line 30 is a corrupted line (should be `next-env.d.ts`), and `next-env.d.ts` is committed anyway |
| `middleware.ts` | security headers + CORS | **performs no authentication**; CORS block is dead code (matcher excludes `/api/`) |

---

## 3. Cross-file symbol resolution results (static evidence)

| Symbol | Referenced from | Defined in | Verdict |
| --- | --- | --- | --- |
| `getUserFromRequest` | `app/api/attendances/route.ts:310` | **nowhere in that file, and not exported by `@/lib/api-utils`** | **ReferenceError → DELETE /api/attendances always 500** |
| `bulletproof_user_update` (RPC) | `app/api/users/route.ts:140` | **no `CREATE FUNCTION` anywhere in the repository** | Role assignment via API is non-functional |
| `get_all_users_admin` (RPC) | `app/dashboard/user-management/page.tsx:131` | **no `CREATE FUNCTION` anywhere** | Admin user list falls back / breaks |
| `RATE_LIMITS`, `logBotApiRequest`, `BOT_API_ERRORS`, `getClientIp`, `getUserAgent` | — | `lib/discord-bot-auth.ts` | **Dead code** — no rate limiting exists |
| `zod` | — | `package.json:70` | **Dependency declared, never imported** |
| `@hookform/resolvers` | — | `package.json:12` | **Unused** |
| `react-error-boundary` | — | `package.json:60` | **Unused** (repo has its own class-based `components/error-boundary.tsx`) |
| `sonner`, `cmdk`, `vaul`, `embla-carousel-react`, `react-resizable-panels`, `input-otp` | only their own `components/ui/*.tsx` wrapper | `package.json` | **Effectively unused** |
| `module_permissions` table | only the `Database` type at `lib/supabase.ts:499` | `scripts/00:19-25` | **Table is dead** — never queried |
| `SUPABASE_URL_DEBUG`, `SUPABASE_ANON_DEBUG` | — | `lib/supabase.ts:683-684` | Unnecessary client-side disclosure |
| `attendances.notes` | `app/api/attendances/route.ts:284` | **no `ADD COLUMN notes` on `attendances` anywhere** | Write will fail against a schema built from the repo's SQL |
| `performances.slot_id` | `app/api/performances/route.ts:278` | `scripts/14-fix-critical-schema-mismatches.sql:12` only | Requires a late migration; absent from `scripts/00` |
| `signInWithOAuth` | — | — | **No OAuth flow implemented** despite `hooks/use-oauth-session-detector.tsx` |
| `NEXT_PUBLIC_BASE_URL` | `app/api/discord/tryout/announce/route.ts:98` | `.env.example:7` | Used to build a URL that is then wrong (`/tryout/{id}/apply` vs real `/apply/{tryoutId}`) |
| `NEXT_PUBLIC_SITE_URL` | 5 files | `.env.example` **does not list it** (lists `NEXT_PUBLIC_BASE_URL` instead) | Undocumented; falls back to `https://raptor-esports.example` |
