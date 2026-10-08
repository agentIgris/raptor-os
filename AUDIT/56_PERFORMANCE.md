# 60 - PERFORMANCE
**Audit.md section:** 63 (SECTION 60 - PERFORMANCE)

## 1. Findings

### F-PRF-01 - HIGH: unbounded reads are the default
**Evidence.**
* `app/api/performances/route.ts:62-63` `const limit = limitParam > 0 ? Math.min(limitParam, 1000) : 0`
  then `:114-116` applies `.limit()` only `if (limit > 0)` — so **the default is no limit**.
* `GET /api/attendances`, `/api/sessions`, `/api/rosters`, `/api/slots`, `/api/teams` return
  unbounded sets.
* `app/api/profile/search/route.ts:24` `parseInt(... || '20')` with **no upper bound**.
* `app/api/public/stats:30` `supabase.from('slot_expenses').select('total')` with no limit.
* `lib/api-utils.ts:227-237` `getPaginationParams` (which caps at 100) is **never imported**.
**Impact:** response size and browser memory scale with total history. The dashboard and analytics
degrade over time. A caller can request 1000 rows repeatedly.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** mandatory cursor pagination with a hard server-side cap on every list endpoint.

### F-PRF-02 - HIGH: aggregation is client-side
**Evidence.** `components/analytics/analytics-sections.tsx` (27,939 B) and
`advanced-charts.tsx` (8,844 B) aggregate the returned rows; `app/dashboard/page.tsx` (60,575 B)
and `app/dashboard/finance/page.tsx` (50,355 B) fetch and compute in the browser.
**Impact:** no server-side aggregation means no index can help, no cache can help, and every user
re-does the same work.
**Severity:** HIGH | **Confidence:** HIGH

### F-PRF-03 - HIGH: the critical indexes exist only as README instructions
**Evidence.** `README.md:134-157` instructs an operator to create
`idx_performances_created_at`, `idx_performances_team_id_created`,
`idx_performances_player_id_created`, `idx_attendances_team_id_created`,
`idx_attendances_created_at`, `idx_slot_expenses_team_id_created`,
`idx_winnings_team_id_created`, `idx_teams_status`, `idx_users_role` **manually in the Supabase
SQL editor**. **No SQL file in the repository creates any of them.**
**Impact:** the indexes the application's own hot paths depend on may not exist in any environment.
A new environment built from the repository's SQL will be missing them, so performance claims
cannot be reproduced.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** indexes belong in migrations, reviewed with `EXPLAIN`, against a realistic
data volume.

### F-PRF-04 - MEDIUM: the client bundle carries avoidable weight
**Evidence.**
* `public/space-particles.mp4` — **6,399,270 bytes**, 67 % of the repository, served unthrottled
  on public pages and on the root error/not-found boundaries.
* 27 unused `components/ui/*` files plus ~20 unused Radix packages (bundlers tree-shake
  unreferenced modules, so the *runtime* cost is limited — but the maintenance and audit cost is
  real).
* `html2canvas` (used only in `lib/pdf-export.ts`) is a large dependency pulled into the
  performance-report bundle.
* `tesseract.js` (19,547 B component + the library) is loaded for OCR — the WASM core and the
  language model are fetched at runtime (`21_OCR.md` F-OCR-04).
* 6.1 MB of video plus Inter plus Recharts plus jsPDF plus Tesseract in a single application.
**Impact:** slow first paint on mobile — the dominant access pattern for a player base.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-PRF-05 - MEDIUM: two custom webpack overrides and a custom chunking strategy
**Evidence.** `next.config.mjs:23-52` — `serverComponentsExternalPackages: []`,
`serverActions.allowedOrigins`, and a hand-written `config.optimization.splitChunks` with
`chunks: 'all'` plus `cacheGroups` for `vendors` and `common`.
**Impact:** `splitChunks: { chunks: 'all' }` with a `vendors` cache group at priority 10 is a
common cause of oversized vendor chunks and poor caching, and it overrides Next's own tuned
defaults. Combined with a 6.1 MB static asset, there is no evidence of any measurement behind
this. `serverActions.allowedOrigins: ["*.vercel.app"]` is also a wildcard on an origin allowlist.
**Severity:** MEDIUM | **Confidence:** MEDIUM
**Recommendation:** remove the custom chunking; measure with a bundle analyser; enforce a budget in
CI.

### F-PRF-06 - MEDIUM: no caching anywhere
**Evidence.** no `Cache-Control`, no `ETag`, no `stale-while-revalidate`, no CDN caching
configuration. `lib/cache-manager.ts` (10,717 B) and `lib/optimized-data-service.ts` (12,200 B)
implement a bespoke client-side cache with no documented invalidation contract and no integration
with the write paths. `next.config.mjs:13` sets `generateEtags: false`, which **removes**
conditional-request support.
**Impact:** identical expensive queries run per user per page load; a manager and five coaches each
re-aggregate the same data.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-PRF-07 - MEDIUM: N+1 patterns in the largest handlers
**Evidence.** `app/api/analytics/performance/route.ts` (19,630 B) builds player, team-comparison
and trend series with multiple sequential queries; `app/api/dashboard/overview/route.ts` issues 5
aggregate queries per request; `app/api/teams/[id]/players/route.ts` fetches players and then
related rows.
**Impact:** latency scales with the number of series; a leaderboard-style page is O(n) queries.
**Severity:** MEDIUM | **Confidence:** MEDIUM

### F-PRF-08 - MEDIUM: outbound HTTP inside database transactions
**Evidence.** `trigger_slot_creation_notification()` and `trigger_roster_update_notification()`
are `SECURITY DEFINER` triggers that post to Discord (`automation-scripts/03:131-221`).
**Impact:** a slot creation or roster update now waits on a third-party HTTP call; a Discord
outage degrades or fails a core write path.
**Severity:** MEDIUM | **Confidence:** MEDIUM-HIGH

### F-PRF-09 - LOW: `next/image` optimisation disabled
**Evidence.** `next.config.mjs:3-4` `images: { unoptimized: true }` while the remote allowlist
includes exactly one Supabase host (`:5`).
**Impact:** avatars are served at source resolution; no `srcset`, no modern formats, no lazy
boundary control.
**Severity:** LOW | **Confidence:** HIGH

### F-PRF-10 - LOW: 2-second and 3-second client timeouts on session restore
**Evidence.** `lib/auth-flow-v2.ts:177-182, 200-245, 248-261`.
**Impact:** a slow connection produces a spurious sign-out, which is a performance problem
manifesting as a correctness problem (`09_AUTHENTICATION.md` F-AUTH-07).
**Severity:** LOW | **Confidence:** HIGH

## 2. Summary
| Problem | Severity |
| --- | --- |
| Unbounded reads by default | HIGH |
| Client-side aggregation | HIGH |
| Critical indexes exist only as README text | HIGH |
| No caching / ETags disabled | MEDIUM |
| 6.1 MB static video in the bundle | MEDIUM |
| Hand-written webpack chunking overriding tuned defaults | MEDIUM |
| N+1 in the largest handlers | MEDIUM |
| Outbound HTTP inside transactions | MEDIUM |
| `next/image` disabled | LOW |
| Spurious client timeouts | LOW |

**There is no measurement anywhere** — no Lighthouse budget, no bundle analyser configuration, no
load test, no query-cost regression check, no APM. Every performance statement in this document is
derived from reading the code, not from a measurement, which is itself the finding.
