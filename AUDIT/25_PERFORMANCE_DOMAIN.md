# 25 — PERFORMANCE DOMAIN
**Audit.md section:** 32 (SECTION 29 — PERFORMANCE DOMAIN)

## 1. What exists
| Concept | Implementation | Evidence |
| --- | --- | --- |
| Performance record | `performances`: one player's result in one match | `scripts/00:153-171` |
| Metrics | `kills`, `assists`, `damage`, `survival_time`, `placement`, `map`, `match_number` | same |
| Entry | 5 competing client forms + 1 API with legacy/new field support | `components/performance/*`; `app/api/performances/route.ts:175-206` |
| OCR entry | browser-side Tesseract + regex parser | `21_OCR.md` |
| Analytics | `/api/analytics/performance` with 3 modes (`player`, `comparison`, `trends`) | `app/api/analytics/performance/route.ts` (19,630 B) |
| Aggregation | SQL functions `get_team_performance_summary(uuid)`, `get_player_stats(uuid)` | `automation-scripts/01:109-149` |
| Reporting | PDF export via jsPDF + autoTable + html2canvas | `lib/pdf-export.ts` |
| Dashboards | `/dashboard/performance`, `/dashboard/performance-report`, `/dashboard/analytics` | |
| Bot ingestion | `performance_records` table (created, **never used**) | `scripts/00:396-418` |

## 2. Hardcoded game-specific assumptions (Audit.md §29 asks specifically)

| Assumption | Where | Consequence for multi-title / multi-tenant |
| --- | --- | --- |
| **The metric set is BGMI/PUBG-Mobile-shaped**: `kills`, `assists`, `damage`, `survival_time`, `placement`, `map` | `scripts/00:157-163`; the whole OCR parser's 4-number grouping (`lib/ocr-service.ts:69`) | A CS2/Dota/Valorant/League record has different or additional metrics (ADR, KAST, ACS, GPM, CS differential, per-round impact). **No `game` entity exists**, so a different title cannot be represented at all. |
| `map text NOT NULL` with **no reference table and no CHECK** | `scripts/00:159` | "Erangel"/"erangel"/"ERANGEL" are three values; a CS2 map and a BGMI map share one free-text column with no discriminator. |
| `placement integer` implies a single-elimination finish rank | `scripts/00:160` | Correct for BGMI; meaningless for a best-of-3 CS2 series or a 12-team event. |
| `survival_time double precision` (seconds) | `scripts/00:163` | BGMI-flavoured; CS uses round-time, LoL uses game-time in minutes:seconds. |
| **BGMI tier ladder as the rating model**: `bgmi_tier CHECK IN ('Bronze','Silver','Gold','Platinum','Diamond','Crown','Ace','Conqueror')`, `bgmi_points` | `scripts/00:72-73`; `lib/profile-utils.ts:7-16` | The **only** competitive rating in the system is a single game's ranked tier, hardcoded as a CHECK constraint. Adding a title requires a migration. |
| BGMI control layouts: `2-finger … 6-finger` | `scripts/00:75`; `lib/profile-utils.ts:21-27` | Mobile-only input model. |
| BGMI sensitivity presets (camera/ADS/gyroscope × 8 scope multipliers) | `lib/profile-utils.ts:336-368` | Hardcoded defaults for one game. |
| `teams.tier` free text with the seeded rate card `God, T1, T2, T3, T4` | `scripts/00:209-216, 544-550` | A *tier* in esports normally means a competition division, not a price band. The two concepts are conflated. |
| `WWCD` used as a headline public metric, computed as `COUNT(placement = 1)` | `app/api/public/stats:28, 50, 61` | WWCD is "wins / wins / close denies" — a three-part BGMI stat. The code substitutes a win count, so the published number is not the metric it is labelled as. |
| Currency is implicitly INR: `₹` hardcoded in the UI, `integer` money columns with no currency | `README.md:168`; `scripts/00:176-197` | A global SaaS cannot assume one currency. |

## 3. Structural gaps in the performance domain

1. **No `match` entity.** `match_number integer` is a bare counter. There is no opponent, no
   event, no round, no series, no map-by-map result, no win/loss, no scoreline. Therefore there
   is no way to compute a win rate, a series record, a head-to-head, or a tournament standing.
2. **No `game` / `competition` / `event` entity.** `slots.organizer` is a free-text string.
3. **No metric extensibility.** Adding a metric requires a migration and a code change in the
   form, the API, the OCR parser and the analytics.
4. **No data provenance.** A row can come from a player, a coach, the Discord bot, or OCR —
   `added_by` records a user id, but there is no `source` discriminator on `performances`
   (unlike `attendances.source`), and no confidence or confirmation record.
5. **No correction history.** `performances` has `created_at` but no `updated_at`, so a
   corrected value is indistinguishable from an original — which matters when prize money or
   eligibility depends on the number.
6. **No validation of cross-row consistency.** Nothing verifies that all players in a match were
   entered, or that a team's placements form a valid ranking, or that `slot_id` matches `team_id`.
7. **Reading is over-shared.** `GET /api/performances` grants a player their **whole team's**
   performances (`app/api/performances/route.ts:101-106`) while the RLS policy grants only their
   own row (`scripts/00:508-509`) and the documentation says "own data"
   (`README.md:196-200`). Three different answers.

## 4. Analytics quality

`app/api/analytics/performance/route.ts` is 19,630 bytes in a single handler with three response
shapes, and the "AI insights" are deterministic threshold rules presented as AI
(`24_NOTIFICATIONS.md` F-NOT-06). `components/analytics/analytics-sections.tsx` is 27,939 bytes
of client-side aggregation. Charts are hand-rolled in `advanced-charts.tsx` because the
shadcn `chart.tsx` wrapper is dead code. All aggregation happens in the browser after fetching
rows, with `limit` defaulting to unbounded.

## 5. Verdict

| Asset | Verdict |
| --- | --- |
| The metric **vocabulary** (kills/assists/damage/survival/placement) | **MIGRATE as an example**, not as a schema — it must become game-agnostic metric definitions |
| The OCR-assisted entry **workflow** (screenshot → suggestion → human confirmation) | **KEEP the interaction, REPLACE the engine** |
| `performance_records` (bot ingestion) | **ARCHIVE** — never used |
| The analytics "insights" | **REPLACE** with a real metrics layer |
| `performances` table | **REBUILD** around `games` → `competitions` → `matches` → `match_maps` → `player_match_stats` with extensible metric keys |
| Tier-based pricing | **MOVE to the commercial domain** — a tier is a price band, not a competitive rating |
| BGMI tier / control-layout / sensitivity constants | **ARCHIVE as tenant-configurable reference data**, not schema |

`46_ANALYTICS.md` covers the analytics architecture; `25_PERFORMANCE_DOMAIN.md` is the
authoritative source for the domain verdict.
