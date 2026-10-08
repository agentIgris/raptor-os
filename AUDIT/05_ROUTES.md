# 05 — ROUTE AUDIT

**Audit.md section:** 9 (SECTION 06 — ROUTE AUDIT)
Machine-readable matrices: `evidence/routes/page-routes.md`, `evidence/routes/api-matrix.md`.

---

## 1. Page routes (32 files, 30 addressable routes)

Legend — **Status**: `OK` reachable and coherent · `BROKEN` reachable but non-functional ·
`DEAD` no consumer/removed from nav · `EXPERIMENTAL` must not ship · `RISK` reachable by the
wrong audience.

| # | URL | File | Auth (client guard) | Role gate | Data source | Mutations | Loading | Error | Empty | Responsive | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `/` | `app/page.tsx` → `app/public/page.tsx` | public | — | `/api/public/stats` | none | none | local | n/a | yes | OK |
| 2 | `/public` | `app/public/page.tsx` | public | — | `/api/public/stats` | none | none | local | n/a | yes | OK (duplicate of `/`) |
| 3 | `/about` | `app/about/page.tsx` | public | — | static | none | none | local | n/a | yes | OK |
| 4 | `/faq` | `app/faq/page.tsx` (24.5 KB) | public | — | static + JSON-LD | none | none | local | n/a | yes | OK |
| 5 | `/gallery` | `app/gallery/page.tsx` | **not in `PUBLIC_ROUTES`** | none | static | none | local | local | n/a | yes | **RISK** — auth-gated but public content; removed from nav/sitemap/robots by commit `fa34734`, page left in place |
| 6 | `/highlight` | `app/highlight/page.tsx` (811 B) | **not in `PUBLIC_ROUTES`** | none | static | none | none | none | n/a | minimal | **DEAD** — 811-byte stub, no nav link, no sitemap entry |
| 7 | `/incentives` | `app/incentives/page.tsx` | public | — | static | none | none | local | n/a | yes | OK |
| 8 | `/join-us` | `app/join-us/page.tsx` | public | — | `/api/public/submit/application` | **POST (public)** | local | local | yes | yes | OK (abuse vector — see §4) |
| 9 | `/contact` | `app/contact/page.tsx` | public | — | `/api/public/submit/contact`, `/api/public/upload/contact-file` | **POST ×2 (public)** | local | local | yes | yes | OK (abuse + PII vector) |
| 10 | `/tier-structure` | `app/tier-structure/page.tsx` | public | — | static | none | none | local | n/a | yes | OK |
| 11 | `/auth/login` | `app/auth/login/page.tsx` | public | — | Supabase Auth | sign-in | yes | yes | n/a | yes | OK |
| 12 | `/auth/signup` | `app/auth/signup/page.tsx` | public | — | Supabase Auth | sign-up | yes | yes | n/a | yes | OK |
| 13 | `/auth/confirm` | `app/auth/confirm/page.tsx` (13.7 KB) | public | — | Supabase Auth OTP | verify OTP | yes | yes | n/a | partial | OK (over-large for its function) |
| 14 | `/auth/forgot` | `app/auth/forgot/page.tsx` | public | — | Supabase Auth | reset request | yes | yes | n/a | yes | OK |
| 15 | `/onboarding` | `app/onboarding/page.tsx` | protected | none (any role) | `/api/profile` | profile update | yes | yes | n/a | yes | RISK — no role gate; reachable by `admin` too |
| 16 | `/agreement-review` | `app/agreement-review/page.tsx` | protected | none (any role) | `/api/agreements`, `/api/agreements/content` | agreement accept | yes | yes | n/a | yes | RISK — endpoint integrity issues, see `33_CONTRACTS.md` |
| 17 | `/apply/[tryoutId]` | `app/apply/[tryoutId]/page.tsx` | public | — | `/api/public/submit/application` | **POST (public)** | yes | yes | yes | yes | OK |
| 17b | — | `app/apply/[tryoutId]/page.tsx.backup` | — | — | — | — | — | — | — | — | **DEPRECATED** — committed backup of a route file |
| 18 | `/dashboard` | `app/dashboard/page.tsx` (**60.6 KB**) | protected | role-aware shell | `/api/dashboard/overview`, `/api/performances`, `/api/slots`, `/api/teams`, `/api/sessions` | mixed | yes | yes | yes | yes | **RISK** — monolith; mixes overview + several modules |
| 19 | `/dashboard/analytics` | `app/dashboard/analytics/page.tsx` (27.9 KB) | protected | all roles per `DASHBOARD_MODULES` | `/api/analytics/performance`, `/api/performances` | none | yes | yes | yes | yes | OK |
| 20 | `/dashboard/attendance` | `app/dashboard/attendance/page.tsx` | protected | all roles | `/api/attendances*`, `/api/sessions*` | mark/verify attendance | yes | yes | yes | yes | RISK — 12 overlapping components |
| 21 | `/dashboard/performance` | `app/dashboard/performance/page.tsx` (34.5 KB) | protected | admin/manager/coach/player/analyst | `/api/performances`, `/api/slots` | create performance | yes | yes | yes | yes | RISK — 5 parallel forms |
| 22 | `/dashboard/performance-report` | `app/dashboard/performance-report/page.tsx` | protected | admin/manager/coach/player/analyst | `/api/performances` | PDF export | yes | yes | yes | yes | OK |
| 23 | `/dashboard/finance` | `app/dashboard/finance/page.tsx` (**50.4 KB**) | protected | admin/manager (nav) | `/api/expenses`, `/api/winnings`, `/api/slots`, `/api/tier-defaults` | read-only | yes | yes | yes | yes | **RISK** — monolith; players may see team finance via RLS |
| 24 | `/dashboard/media` | `app/dashboard/media/page.tsx` | protected | admin/manager/coach/analyst | `/api/media/upload`, `/api/media/delete` | **upload/delete** | yes | yes | yes | partial | **RISK** — uses the two unauthenticated service-role endpoints |
| 25 | `/dashboard/profile` | `app/dashboard/profile/page.tsx` | protected | self | `/api/profile`, `/api/profile/avatar` | update profile/avatar | yes | yes | n/a | yes | OK |
| 26 | `/dashboard/user-management` | `app/dashboard/user-management/page.tsx` | protected | admin/manager (nav only) | `/api/users` (GET/PUT), RPC `get_all_users_admin` (**undefined**) | **role assignment** | yes | yes | yes | yes | **BROKEN** — `PUT /api/users` calls undefined RPC `bulletproof_user_update`; list calls undefined `get_all_users_admin` |
| 27 | `/dashboard/team-management` | `app/dashboard/team-management/page.tsx` (701 B) | protected | coach+ (nav) | — | redirect stub | none | none | n/a | n/a | OK (stub) |
| 28 | `/dashboard/team-management/teams` | `…/teams/page.tsx` | protected | admin/manager/coach | `/api/teams`, `/api/teams/manage` | create/update/delete team | yes | yes | yes | yes | OK |
| 29 | `/dashboard/team-management/roster` | `…/roster/page.tsx` | protected | admin/manager/coach | `/api/rosters`, `/api/teams/[id]/players` | roster CRUD | yes | yes | yes | yes | OK |
| 30 | `/dashboard/team-management/slots` | `…/slots/page.tsx` (28.4 KB) | protected | admin/manager/coach | `/api/slots` | slot CRUD | yes | yes | yes | yes | OK |
| 31 | `/dashboard/team-management/tiers` | `…/tiers/page.tsx` (31.6 KB) | protected | admin/manager | `/api/tier-defaults`, `/api/teams/monthly` | tier rate CRUD | yes | yes | yes | yes | OK |
| 32 | `/dashboard/tryouts` | `app/dashboard/tryouts/page.tsx` | protected | admin/manager/coach | `/api/tryouts` | list | yes | yes | yes | yes | OK |
| 33 | `/dashboard/tryouts/create` | `…/create/page.tsx` | protected | admin/manager/coach | `/api/tryouts` | create tryout | yes | yes | n/a | yes | OK |
| 34 | `/dashboard/tryouts/[id]` | `…/[id]/page.tsx` | protected | admin/manager/coach | `/api/tryouts` | stage transitions | yes | yes | yes | yes | OK (state machine — see `29_TRYOUTS.md`) |
| 35 | `/dashboard/discord-portal` | `…/page.tsx` | protected | admin/manager (nav) | `/api/discord-portal/send`, `/api/discord-portal/logs` | **send Discord message** | yes | yes | yes | yes | OK |
| 36 | `/dashboard/discord-portal/logs` | `…/logs/page.tsx` | protected | admin/manager | `/api/discord-portal/logs` | retry failed | yes | yes | yes | yes | OK |
| 37 | `/dashboard/discord-portal/settings` | `…/settings/page.tsx` | protected | admin/manager | `/api/discord-portal/settings` | automation toggles | yes | yes | n/a | yes | OK — best-protected module |
| 38 | `/dashboard/discord-portal/webhooks` | `…/webhooks/page.tsx` (23.3 KB) | protected | admin/manager | `/api/discord-portal/webhooks` | webhook CRUD | yes | yes | yes | yes | **RISK** — exposes `hook_url` in the DOM and `window.open`s it (line 490); PUT mass-assigns |
| 39 | `/dashboard/admin/settings` | `…/settings/page.tsx` | protected | admin (nav only) | `/api/admin/settings` | **save config, purge data** | yes | yes | n/a | yes | **CRITICAL RISK** — hosts the purge control |
| 40 | `/dashboard/admin/agreements` | `…/agreements/page.tsx` | protected | admin (nav only) | `/api/admin/agreements` | edit legal text | yes | yes | n/a | yes | **BROKEN** — endpoint returns 403 always |
| 41 | `/debug` | `app/debug/page.tsx` (22.3 KB) | protected | **NONE** | 8 API endpoints | **creates slots** | n/a | n/a | n/a | partial | **EXPERIMENTAL — remove** |
| 42 | `/debug-simple` | `app/debug-simple/page.tsx` | protected | **NONE** | 5 API endpoints | **creates slots** | n/a | n/a | n/a | partial | **EXPERIMENTAL — remove** |
| 43 | `/robots.txt` | `app/robots.txt` | public | — | static | — | — | — | — | — | OK |
| 44 | `/sitemap.xml` | `app/sitemap.xml/route.ts` | public | — | static + `NEXT_PUBLIC_SITE_URL` | — | — | — | — | — | OK (falls back to `https://raptor-esports.example`) |
| — | `/auth/reset-password` | **referenced** in `route-guard-v2.tsx:26` and `auth-flow-v2.ts:471` | public | — | — | — | — | — | — | — | **MISSING ROUTE** — allowlisted and referenced but no `app/auth/reset-password/page.tsx` exists → password-reset completion link 404s |

### Dead / inaccessible routes
* **`/auth/reset-password` — MISSING.** `PUBLIC_ROUTES` (`components/route-guard-v2.tsx:26`)
  and the redirect-from list (`lib/auth-flow-v2.ts:471`) both include it, and Supabase's
  default recovery email links to it, but the page was never created. Confidence **HIGH**.
* **`/highlight` — orphaned stub.** 811 bytes, not in nav, not in sitemap, auth-gated by
  accident. Confidence **HIGH**.
* **`/gallery` — intentionally removed from navigation/sitemap/robots** (commit `fa34734`)
  but the page and its assets remain, and the route guard still auth-gates it.
* **`/dashboard/team-management/page.tsx` — 701-byte redirect stub** whose only purpose is
  to forward to a sub-page; the parent `layout.tsx` (2,305 bytes) also exists for a route
  family with 5 children.

---

## 2. API routes (58 files, 96 exported handlers)

Full per-handler detail: `14_API.md` and `evidence/routes/api-matrix.md`. Route-level facts:

| Group | Files | Handlers | Auth pattern | Verdict |
| --- | --- | --- | --- | --- |
| `api/discord/**` | 12 | 13 | static shared secret | 3 of 5 tryout endpoints provably fail against the repo's own RLS |
| `api/discord-portal/**` | 6 | 10 | user-bound client + role | best-implemented group; 1 unauthenticated endpoint, 1 mass assignment |
| `api/sessions/**` | 7 | 12 | `authenticateRequest` | coherent |
| `api/teams/**` | 4 | 7 | `authenticateRequest` | coherent |
| `api/attendances/**` | 3 | 6 | `authenticateRequest` | 1 handler is a `ReferenceError` |
| `api/media/**` | 2 | 2 | **none** + service role | **CRITICAL** |
| `api/public/**` | 4 | 4 | **none** (1 uses service role as fallback) | unauthenticated by design for forms, but unauthenticated **storage write** is not |
| `api/admin/**` | 2 | 4 | `authenticateRequest` / `getUser` | contains the destructive purge; agreements endpoint always 403 |
| `api/profile/**` | 3 | 4 | `getUser` (data via anon client) | search is injectable and non-functional; avatar partially broken |
| `api/agreements/**` | 2 | 3 | `getUser` | client-controlled `role` on POST |
| others (`users`, `performances`, `rosters`, `slots`, `tryouts`, `tier-defaults`, `expenses`, `winnings`, `analytics/performance`, `dashboard/overview`, `auth/session`) | 13 | 22 | `authenticateRequest` | coherent; `users` over-exposes and calls an undefined RPC |

---

## 3. Route-state audit (loading / error / empty)

| Concern | Finding | Evidence |
| --- | --- | --- |
| Loading | A bespoke global overlay (`lib/global-loading-manager.tsx`, 7,935 B) plus per-page `isLoading` state plus a `GlobalLoading` component mounted in the root layout. Three overlapping mechanisms. | `app/layout.tsx:61`; `app/dashboard/layout.tsx:10` comment *"Remove duplicate loading logic - let NewDashboardLayout handle it"* |
| Error | Four layers: `app/error.tsx`, `app/global-error.tsx`, `components/error-boundary.tsx`, `components/loading-error-boundary.tsx`. `app/error.tsx:58` renders `error.message` directly to the user. | `app/error.tsx:56-65` |
| Empty | Present on list pages (`/dashboard/tryouts`, `/dashboard/media`, `/dashboard/team-management/*`) but **absent** on `/dashboard` overview and `/dashboard/finance`, which render metric cards that silently show 0. | `app/dashboard/page.tsx`; `app/dashboard/finance/page.tsx` |
| Suspense/streaming | Not used anywhere. | `rg "Suspense\|use cache\|unstable_cache"` → 0 |
| Route-level error boundaries | Only at the app root; no `error.tsx` inside `app/dashboard/**`, so any dashboard render error escalates to the root boundary — which renders the **public** navigation and footer. | `app/error.tsx:28,116` |

**Finding — root error boundary leaks internals and shows public chrome to authenticated users.**
*Evidence:* `app/error.tsx:58` `{error.message || 'An unexpected error occurred'}` rendered
inside a styled card; `app/error.tsx:22` `console.error('Global error:', error)`;
`app/error.tsx:28` and `:116` mount `PublicNavigation` and `PublicFooter`.
*Impact:* internal messages (which frequently include Supabase/PostgREST text, see
`app/api/performances/route.ts:294` returning `details: insertError.message`) are shown to end
users; the boundary also strips the dashboard shell, so a single failed widget collapses the
whole authenticated UI into a public-looking page.
*Severity:* **MEDIUM** · *Confidence:* **HIGH*
*Recommendation:* production-safe error copy, an error digest + correlation id, real error
tracking, and boundary files at every route-group level.

---

## 4. Route abuse surface (unauthenticated, write-capable)

| Route | Method | What an anonymous caller can do | Rate limited | Severity |
| --- | --- | --- | --- | --- |
| `/api/media/upload` | POST | Upload any image/video/PDF/text ≤20 MB into the **public** `media` bucket, at any `folder` path | No | **CRITICAL** |
| `/api/media/delete` | DELETE | Delete **any** object in the `media` bucket by path | No | **CRITICAL** |
| `/api/public/upload/contact-file` | POST | Upload ≤10 MB into `contact_files`; the returned `downloadUrl` is generated with `getPublicUrl()` on a **private** bucket and is therefore non-functional | No | **CRITICAL** |
| `/api/public/submit/contact` | POST | Relay arbitrary field content to the org's Discord webhook, sourced from a `NEXT_PUBLIC_*` env var that is **also shipped to the browser** | No | **HIGH** |
| `/api/public/submit/application` | POST | Same, for applications | No | **HIGH** |
| `/api/public/stats` | GET | Read aggregate counts and (subject to RLS) the sum of `slot_expenses.total`; response mixes real data with hardcoded fabrications | No | **MEDIUM** |
| `/api/discord-portal/webhooks/validate` | POST | Make the server issue a GET to an attacker-supplied URL (regex-restricted to `discord.com`/`discordapp.com`) | No | **MEDIUM** |
| `/api/discord/**` (12) | mixed | With the static bot key: read tryouts, create applications, create invitations, submit evaluations, read attendance/performance summaries, **create attendance records** | No | **HIGH** |

*Recommendation for V2:* every write endpoint requires an authenticated actor with an explicit
permission; public form endpoints are isolated in a separate rate-limited tier with a CAPTCHA
or proof-of-work, write to a server-side queue (not straight to a webhook), and never expose
integration credentials through `NEXT_PUBLIC_*`.

---

## 5. Route verdict

| Classification | Count | Routes |
| --- | --- | --- |
| Coherent and usable | 26 pages / 34 API handlers | — |
| Reachable but role-gate missing (client-only guard) | 6 pages | `/onboarding`, `/agreement-review`, `/dashboard/performance*`, `/debug`, `/debug-simple`, `/gallery` |
| Broken (non-functional) | 4 | `/dashboard/user-management`, `/dashboard/admin/agreements`, `DELETE /api/attendances`, `GET /api/profile/search` |
| Missing | 1 | `/auth/reset-password` |
| Deprecated / must not ship | 3 | `app/apply/[tryoutId]/page.tsx.backup`, `/debug`, `/debug-simple` |
| Orphaned stub | 1 | `/highlight` |
| Unauthenticated write | 7 | `media/*`, `public/upload/*`, `public/submit/*`, `discord-portal/webhooks/validate` |
| Monolithic files needing decomposition | 4 | `dashboard/page.tsx` (60.6 KB), `dashboard/finance/page.tsx` (50.4 KB), `dashboard/performance/page.tsx` (34.5 KB), `team-management/tiers/page.tsx` (31.6 KB) |
