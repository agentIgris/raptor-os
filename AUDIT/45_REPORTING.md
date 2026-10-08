# 45 - REPORTING
**Audit.md section:** 52 (SECTION 49 - REPORTING)

## 1. Complete report inventory
| Report | Where | Classification (Audit.md §52) | Format | Data source | Status |
| --- | --- | --- | --- | --- | --- |
| Dashboard overview | `/dashboard` + `/api/dashboard/overview` | operational + executive | on-screen | 5 aggregate queries | working, but 60.6 KB monolith and zero-vs-error ambiguity |
| Analytics (player / team comparison / trends) | `/dashboard/analytics` + `/api/analytics/performance` | competitive | on-screen | client-side aggregation of `performances` | working; "AI insights" are deterministic rules |
| Performance report | `/dashboard/performance-report` | competitive | on-screen + **PDF** | `performances` | working |
| PDF export (any report) | `lib/pdf-export.ts` (10,674 B) | all | **PDF (client-side)** | jsPDF + autoTable + html2canvas | working; heavy client-side DOM capture |
| Attendance report | `/dashboard/attendance`, `components/attendance/attendance-stats.tsx`, `attendance-logs.tsx` | operational | on-screen | `attendances` | working, but `DELETE` is broken and 12 overlapping components |
| Attendance heatmap | `/api/sessions/attendance-heatmap` | operational | on-screen | server-side aggregate | working |
| Attendance verification | `/api/attendances/verification` | operational | on-screen | `attendances` | working |
| Team monthly stats | `/api/teams/monthly`, `team_monthly_stats` | operational + financial | on-screen | derived table | working; should be a view |
| Finance: slot expenses | `/dashboard/finance`, `/api/expenses` | financial | on-screen | `slot_expenses` | working; **readable by players at the DB level** |
| Finance: winnings | `/dashboard/finance`, `/api/winnings` | financial | on-screen | `winnings` | working; same |
| Public statistics | `/api/public/stats` | executive / marketing | public JSON + website | hardcoded + aggregates | **returns fabricated numbers** |
| Discord delivery log | `/dashboard/discord-portal/logs` | operational | on-screen | `communication_logs` | working; **publicly forgeable** |
| Tryout funnel statistics | `/api/discord/tryout/list?include_stats=true` | operational | JSON (bot) | `tryout_*` | **always empty** (no anon SELECT policies); the underlying `tryout_stats` view also double-counts |
| Team performance summary | `get_team_performance_summary(uuid)` | competitive + financial | none (RPC only) | SQL aggregate | **`total_winnings` always 0** (broken join) |
| Player stats | `get_player_stats(uuid)` | competitive | none (RPC only) | SQL aggregate | working; **callable by `anon`** |
| Tier / rate report | `/dashboard/team-management/tiers` | financial | on-screen | `tier_defaults` | working |
| Organisation JSON-LD | `components/seo/OrganizationJsonLd.tsx` | marketing | page source | static | hardcoded single organisation |
| Sitemap / robots | `app/sitemap.xml/route.ts`, `app/robots.txt` | marketing | — | static list | working |

## 2. Classification coverage against the Audit.md list
| Category | Reports present |
| --- | --- |
| Operational | attendance (4 variants), team monthly stats, Discord log, practice config |
| Competitive | analytics, performance report, team/player summary |
| Financial | slot expenses, winnings, tier rates — **expense-only; no revenue, no budget, no P&L** |
| HR | **NONE** |
| Commercial | **NONE** |
| Creator | **NONE** |
| Executive | dashboard overview, public statistics — **2 of the 7 categories Audit.md asks for are entirely absent, and the one that is public contains fabrications** |

## 3. Findings

### F-RPT-01 - HIGH: no financial reporting
**Evidence.** expenses and winnings only; no revenue, no budget, no P&L, no cash flow, no
accrual. And `get_team_performance_summary` reports `total_winnings` as 0 because of a broken join
(`31_FINANCE.md` F-FIN-05).
**Impact:** a board or sponsor cannot be given a credible financial statement. For a
multi-tenant SaaS this also means no usage or revenue reporting for the vendor's own business.
**Severity:** HIGH | **Confidence:** HIGH

### F-RPT-02 - HIGH: the public report contains fabricated figures
**Evidence.** `app/api/public/stats:55-61` hardcodes `baseUnderdogPractice = 37800`,
`baseMatches = 3240`, `baseWWCD = 1134`, and publishes them as organisational track record.
**Impact:** the organisation's public claims are not measurements. This is a
marketing-claims/truth-in-advertising problem and it is trivially detectable by anyone.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** delete the constants; publish only measured figures with an "as of" date.

### F-RPT-03 - MEDIUM: aggregation happens in the browser
**Evidence.** `app/api/performances` returns rows (default **unbounded**, `limit=0` at `:62-63`)
and `components/analytics/analytics-sections.tsx` (27,939 B) aggregates them client-side;
`app/api/public/stats:30` fetches every `slot_expenses` row and sums in JavaScript.
**Impact:** no server-side aggregation, so response size and browser memory grow with history;
results will be wrong once the data volume is real.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** aggregate in Postgres (views / materialised views) with a documented
invalidation strategy.

### F-RPT-04 - MEDIUM: no report is exportable except one, and the export path is heavy
**Evidence.** `lib/pdf-export.ts` uses jsPDF + autoTable + **html2canvas** (which clones the DOM
and rasterises it). Only the performance report uses it.
**Impact:** exports are slow, produce large files, are not accessible (image-based PDF text), and
are unavailable for every other domain.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** server-side PDF generation from a template, producing tagged, accessible PDFs
and XLSX/CSV.

### F-RPT-05 - MEDIUM: no scheduled or distributable reports
**Evidence.** absence. `communication_settings.auto_weekly_digest` exists but drives Discord,
not a report.
**Impact:** a CFO, a head of esports or a sponsor has to remember to log in. Scheduled,
emailed, role-scoped digests are a standard expectation.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:* `78_NOTIFICATION_ARCHITECTURE.md` with a "scheduled report" channel.

### F-RPT-06 - MEDIUM: reports have no consistent metric definitions
**Evidence.** `WWCD` is labelled as wins/wins/close-denies in the UI but computed as
`COUNT(placement = 1)` (`app/api/public/stats:28, 50`); "cost covered" mixes a constant with real
spend; "active players" counts `role='player' AND status='Active'` while
`get_player_stats` counts rows in `performances`; the dashboard and the drill-down apply
different role filters (`app/api/dashboard/overview` vs `app/api/performances:100-111`).
**Impact:** two people looking at two screens get two different numbers, and neither is
authoritative. In a sponsor-facing context this is a commercial risk.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** a single semantic/metrics layer (`46_ANALYTICS.md`) with one definition per
metric, versioned and tested.

## 4. Verdict
**REBUILD** the reporting layer on a metrics/semantic layer, add the missing categories (HR,
commercial, creator, executive), make everything scheduled and distributable, and export
server-side. `46_ANALYTICS.md` and `85_FEATURE_MATRIX.md` carry the recommendations.
