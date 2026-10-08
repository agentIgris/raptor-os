# 46 - ANALYTICS
**Audit.md section:** 53 (SECTION 50 - ANALYTICS)

## 1. Architecture as implemented
```
Browser
  -> /api/performances          returns ROWS (default UNBOUNDED)
  -> /api/analytics/performance 3 modes, 19,630 B in one handler
  -> /api/dashboard/overview     5 aggregate queries
  -> /api/teams/monthly          derived table
  -> RPC get_team_performance_summary / get_player_stats   (SQL aggregates)
  -> /api/public/stats           anon, hardcoded + aggregates
       |
       v
  Client-side aggregation and charting
  (components/analytics/analytics-sections.tsx 27,939 B
   components/analytics/advanced-charts.tsx      8,844 B  - only recharts consumer)
       |
       v
  "AI insights" - deterministic threshold rules in analytics-sections.tsx
  (commits 7edd1ce, ff9d767: "AI-style heuristic insights", "enrich AI insights")
```

## 2. Metric inventory and quality
| Metric | Defined where | Quality problem |
| --- | --- | --- |
| `total_kills`, `total_assists`, `total_damage`, `avg_placement`, `best_placement`, `total_survival_time` | `get_player_stats` `automation-scripts/01:130-149` | sound |
| `total_matches`, `total_kills`, `total_damage`, `avg_placement`, `total_winnings` | `get_team_performance_summary` `automation-scripts/01:109-127` | **`total_winnings` always 0** (joins `winnings.slot_id` to the legacy `performances.slot`) |
| `liveMatches`, `liveWWCD`, `activeTeams`, `activePlayers`, `costCovered` | `app/api/public/stats:20-70` | **three of five are hardcoded constants**; `WWCD` is mislabelled |
| `activePlayers`, `activeTeams`, matches today/this week, `avgPlacement` | `app/api/dashboard/overview` | different filters from the drill-down |
| attendance rate, heatmap | `app/api/sessions/attendance-heatmap`, `app/api/attendances/summary` | computed per request, no cache |
| application funnel counts, conversion rate | `app/api/discord/tryout/list` | **always zero** (RLS denies the anon client) |
| `successRate`, `messageTypeStats` | `getWebhookStats` `webhookService.ts:406-443` | pulls 30 days of `communication_logs` rows and aggregates in JS; log is forgeable |
| `team_monthly_stats` | `scripts/14` | derived table with no consistency guarantee |

## 3. Findings

### F-ANL-01 - HIGH: no semantic layer, so the same metric has different definitions
**Evidence.** at least four independent definitions of "matches played", "win rate" and "spend"
across `app/api/public/stats`, `app/api/dashboard/overview`, `get_team_performance_summary` and
the client-side aggregation in `components/analytics/analytics-sections.tsx`. `WWCD` is labelled
as a three-part BGMI stat and computed as `COUNT(placement = 1)`.
**Impact:** two screens can show different numbers for the same metric; sponsor-facing and
board-facing figures are not reconcilable; and there is no single place to fix a definition.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** a versioned metrics layer - one definition per metric, with a test per
definition, consumed by every report and API.

### F-ANL-02 - HIGH: two of the headline figures are fabricated
**Evidence.** `app/api/public/stats:55-57` hardcodes `baseUnderdogPractice = 37800`,
`baseMatches = 3240`, `baseWWCD = 1134`, and publishes the sums.
**Impact:** the organisation's public performance claims are not measurements. In a SaaS
context these constants would be attributed to whichever tenant loaded the page.
**Severity:** HIGH | **Confidence:** HIGH

### F-ANL-03 - HIGH: aggregation is client-side over unbounded result sets
**Evidence.** `app/api/performances:62-63` `limit = limitParam > 0 ? Math.min(limitParam, 1000) : 0`
- **`0` means no limit**; and `components/analytics/analytics-sections.tsx` aggregates the
returned rows.
**Impact:** response size and browser memory scale with history; the dashboard degrades as data
accumulates; and an unauthenticated or low-privilege caller can request up to 1000 rows per call
repeatedly.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** aggregate in Postgres; paginate everywhere; never ship raw rows for charts.

### F-ANL-04 - MEDIUM: "AI insights" are threshold rules presented as AI
**Evidence.** commits `7edd1ce` ("add AI-style heuristic insights for player, team comparison, and
trends") and `ff9d767` ("enrich AI insights with detailed, actionable recommendations"); the logic
lives in `components/analytics/analytics-sections.tsx`.
**Impact:** users may believe a model analysed their performance. This becomes a serious
truth-in-labelling problem if the wording implies competitive, contractual or eligibility
conclusions - and no model, prompt or confidence exists.
**Severity:** MEDIUM | **Confidence:** MEDIUM (wording not exhaustively verified)
**Recommendation:** label as deterministic rules; apply `74_FUTURE_AI.md` / `75_AI_SECURITY.md` to
any genuine model output.

### F-ANL-05 - MEDIUM: no caching, no incremental aggregation
**Evidence.** `lib/cache-manager.ts` (10,717 B) and `lib/optimized-data-service.ts` (12,200 B)
implement bespoke caching, but there is no documented invalidation contract and no integration
with the write paths. `getWebhookStats` pulls 30 days of rows per call. No cache headers, no ETag,
no `stale-while-revalidate`.
**Impact:** identical expensive queries run per user per page load; a manager and five coaches
each re-aggregate the same data.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** materialised views refreshed on a schedule or by trigger, plus an explicit
cache-invalidation contract on every write.

### F-ANL-06 - MEDIUM: no event/analytics pipeline for product usage
**Evidence.** `.env.example:16-18` documents `ANALYTICS_API_KEY`; **no variable is referenced in
code and no analytics SDK is a dependency** (`rg "Sentry|sentry|analytics|posthog|mixpanel|segment|plausible"` → 0).
**Impact:** the organisation has no idea which features are used, so prioritisation is guesswork;
and the vendor has no product telemetry for a SaaS.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** consent-aware, tenant-scoped product analytics; see `82_SAAS_BILLING.md`
(usage metering needs this).

### F-ANL-07 - MEDIUM: analytics inherit the authorisation defects
**Evidence.** a player's `GET /api/performances` returns the whole team (`:101-106`); the dashboard
and the drill-down apply different role filters; team monthly stats are a separate table with
its own RLS.
**Impact:** aggregate figures can include data the viewer should not see, and two views of the
same data disagree.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** a single tenant- and role-scoped metrics service that every consumer calls.

## 4. Analytics architecture limitations (Audit.md asks explicitly)
1. **No event pipeline.** Business facts are read from transactional tables on every request; there
   is no immutable event history, so historical reporting is bounded by current row retention and
   by any correction or hard delete.
2. **No dimensional model.** No `games`, `competitions`, `events`, `sponsors`, `creators`,
   `departments` or `periods` dimensions, so cross-domain analysis is impossible.
3. **No metric governance.** No owner, no definition registry, no versioning, no backfill policy.
4. **No per-tenant isolation of computation.** Aggregates are computed per request with no
   partitioning, which will not survive many tenants.
5. **No lineage or provenance.** A number cannot be traced to the rows that produced it - fatal
   for sponsor reporting and for any dispute.
6. **Correctness is unverified.** A broken join silently returns 0 and nothing alerts.

## 5. Verdict
**REPLACE.** Build: an immutable domain event stream -> a warehouse or Postgres-derived
analytical schema with a semantic/metrics layer -> role-scoped, tenant-scoped, cached query APIs
-> a reporting and dashboard layer that consumes only those APIs. Preserve the handful of sound
SQL aggregates (`get_player_stats`) as reference definitions, and fix or retire the rest.
