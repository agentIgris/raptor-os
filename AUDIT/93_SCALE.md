# 93 - SCALE & PERFORMANCE ARCHITECTURE
**Audit.md section:** 101 (SECTION 98)

## 1. The scaling reality of the legacy system
The current architecture is not slow because of scale - it is slow because of **unbounded work per
request**:
* `/api/teams` returns **all** players with all PII, uncounted and unpaginated
  (`14_API.md` F-API-08).
* Reports and the leaderboard download the whole dataset and aggregate in the browser
  (`46_ANALYTICS.md`).
* `/team` ships 60 KB and `AttendanceModule` 50 KB of client logic (`56_PERFORMANCE.md`).
* Two `PerformanceModule` instances (56 KB / 60 KB), a `PerformanceInitializer` that fetches
  again, and context updates that refetch the entire team (`25_PERFORMANCE_DOMAIN.md`).
* The 6.1 MB hero video on the marketing page (`57_ACCESSIBILITY.md`).
* Critical indexes exist only as **README text** - `idx_performances_team_slot`,
  `idx_attendances_session_player` are documented but not created (`12_DATABASE_RELATIONSHIPS.md`).

## 2. Target architecture by tier
| Tier | Component | Approach |
| --- | --- | --- |
| **Edge** | CDN | Static assets + cached public pages; long TTL with purge on publish |
| **Edge** | WAF / rate limiting | Per-IP and per-tenant limits on auth, upload, public endpoints |
| **Application** | Next.js | Server components by default; route handlers thin; no business logic in the client |
| **Application** | Background workers | Queues for anything slow: OCR, reports, allocation, imports, notifications, webhooks |
| **Application** | Search | Postgres full-text + trigram to start; an external index only when measured |
| **Data** | Postgres (RLS, tenant-scoped indexes) | The system of record; read replicas for reporting |
| **Data** | Warehouse | A copy for analytics; **never** queried by the transactional path |
| **Data** | Object storage | Media, exports, imports, backups |
| **Cache** | Redis (or equivalent) | Sessions, hot reads, rate-limit counters, job locks |
| **Async** | Queue + DLQ | Every external call (Discord, email, OCR, payment webhooks, social APIs) |

## 3. Performance requirements (target SLOs)
| Metric | Target | Notes |
| --- | --- | --- |
| LCP | < 2.5s p75 | Mobile-first; the 6.1 MB video is removed |
| INP | < 200ms p75 | No client-side aggregation over full datasets |
| TTFB | < 400ms p75 | Server rendering, cached reads |
| API p95 (list endpoints) | < 300ms | Paginated, indexed, tenant-scoped |
| API p95 (writes) | < 500ms | Writes are cheap; side effects are queued |
| Attendance marking (100 players) | < 2s | Bulk endpoint, one transaction |
| Allocation recompute for a season | < 30s, asynchronous | Queued, idempotent, with a progress state |
| Report generation | Asynchronous, < 60s for a season | Never in the request path |
| Import of 100k rows | Asynchronous, progress visible | Chunked, resumable |
| Search | < 500ms p95 | Indexed, tenant-scoped |

## 4. Database scaling rules
1. **Every list endpoint is paginated** (cursor-based), with a hard `limit` ceiling. No
   `select('*')`, no unbounded selects - ever (`14_API.md`).
2. **Every query is tenant-scoped in the index.** Composite indexes lead with `organization_id`
   and include the filter columns; a missing composite index is a review blocker.
3. **The 27 documented indexes are actually created** (`12_DATABASE_RELATIONSHIPS.md` §7), plus
   the tenant-scoped variants.
4. **Read replicas** for reporting and exports, with the replica lag exposed in the UI.
5. **Partitioning** only where measured: `AttendanceRecord` and `PerformanceEntry` by month once
   they exceed a few million rows. Not before.
6. **No cross-tenant query** in the transactional path. Analytics goes to the warehouse.
7. **Connection pooling** in every serverless path, with a hard cap; the legacy 8-connection
   setting in `.env.example` is a per-instance value and will not survive serverless
   (`09_AUTHENTICATION.md`).

## 5. Client performance rules
* **No business logic in the client.** No aggregation, no filtering over a full dataset, no
  calculation that decides anything. The two current "AI" features that compute in the browser
  (`app/api/discord/tryout/evaluate`, `app/api/team/ai-insights`) move server-side
  (`46_ANALYTICS.md`).
* **Server components by default**; client components only for genuine interactivity.
* **Target bundle budget**: route-level JS < 150 KB gzipped. Current offenders: `/team` 60 KB,
  `/upload` 56 KB, `AttendanceModule` 50 KB, `SidebarContent` 43 KB.
* **Virtualise** long tables (attendance, rosters, leaderboards).
* **Images and video** served responsively, with modern formats and a hard size budget.

## 6. Reliability and scale of failure
| Failure | Behaviour in V2 |
| --- | --- |
| A slow third party (Discord, OCR, social) | Queued with a timeout and a retry; the request never blocks on it |
| A queue backlog | Visible in a health dashboard; a dead-letter queue with alerting |
| A failing migration | Expand/contract; no destructive change in the same deploy |
| A bad deploy | Automated rollback on error-rate breach (`94_REBUILD_STRATEGY.md`) |
| A tenant hammering one endpoint | Per-tenant rate limits and quotas |
| A reporting query over 50M rows | Warehouse, not the transactional database |
| A failed allocation recompute | Idempotent job, safe to re-run, last-known-good published |

## 7. What "scale" means for this product
The honest answer: the legacy system would handle a large multiple of its current load on
architecture alone, because it is small. The constraint is **not** throughput - it is
correctness (RLS, indexes, pagination) and the cost of unbounded reads. V2's scale work is
therefore mostly about **making every query bounded, indexed and tenant-scoped**, and moving
slow work off the request path. Capacity planning should be driven by measurement, not by guesswork.

## 8. Verdict
No re-platform is required for scale. A well-indexed, paginated, tenant-scoped Postgres with a
read replica, a queue and a CDN will carry this product well beyond any credible customer base.
The work is discipline, not architecture.
