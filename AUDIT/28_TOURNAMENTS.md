# 28 — TOURNAMENTS
**Audit.md section:** 35 (SECTION 32 — TOURNAMENT DOMAIN)

## 1. Honest statement of scope
**There is no tournament domain in this system.** The word "tournament" appears as:
* a `session_type` enum value (`scripts/00:225`),
* a `tryout_sessions.session_type` enum value
  (`database/SUPABASE_TRYOUTS_SETUP_FIXED.sql:89`),
* free text in `slots.organizer` (`scripts/00:138`),
* a Discord message type (`slot_create`),
* marketing copy on the public website.

There is **no** tournament, event, competition, match, bracket, round, opponent, result,
standing, schedule, seeding, qualification, registration or check-in entity anywhere in the
43 SQL files or the 58 API routes.

## 2. What actually exists: a slot-purchase ledger

| Table | Purpose | Evidence |
| --- | --- | --- |
| `slots` | a **purchased slot** in someone else's event: `organizer` (free text), `time_range` (free text), `number_of_slots`, `slot_rate`, `match_count`, `date`, `notes` | `scripts/00:137-150` |
| `slot_expenses` | the cost of that purchase, auto-created by trigger as `slot_rate × number_of_slots` | `scripts/00:174-185`; trigger `automation-scripts/04:12-32` |
| `prize_pools` | `total_amount` + `breakdown jsonb` | `scripts/00:199-207` |
| `winnings` | `position` (CHECK > 0) + `amount_won` per slot | `scripts/00:187-197` |
| `tier_defaults` | the rate card: `tier → default_slot_rate` (God 1000, T1 800, T2 600, T3 400, T4 200) | `scripts/00:209-216, 544-550` |
| `team_monthly_stats` | a per-team per-month rollup | `scripts/14-create-team-monthly-stats.sql` |

So the model is: *"we bought N slots in an event at rate R, we paid N×R, we finished at position
P and won W."* That is a **cost and prize ledger for opportunistic BGMI custom-room entries**,
which is a real and legitimate business activity — but it is not tournament management.

## 3. Findings

### F-TOR-01 — HIGH: the `slot` model cannot represent a competition
**Missing entirely:** event/competition (name, game, format, prize pool, rules, dates,
registration deadline, eligibility), division/tier as a *competitive* concept, team
registration/entry, bracket or standings, rounds, matches, match results, opponents, maps played,
MVP, check-in, disqualification, prize distribution per placement, tax withholding on prizes,
and payment of prizes to players.
**Impact:** the organisation cannot answer "how did we do at event X", "who is in the final",
"how much did we win in tournament Y", "which players are eligible for Z", or "who received
their prize share". This blocks the entire competitive-operations and prize-money domains
(`31_FINANCE.md`, `32_COMPENSATION.md`).
**Severity:** HIGH · **Confidence:** HIGH

### F-TOR-02 — HIGH: slots are oversellable
**Evidence.** `slots.number_of_slots` is a number on the slot row; there is no booking entity
and no atomic decrement anywhere in the API (`app/api/slots/route.ts`) or in SQL.
**Impact:** the same slot position can be recorded as sold N times; `slot_expenses` and
`winnings` will not reconcile.
**Severity:** HIGH · **Confidence:** HIGH

### F-TOR-03 — HIGH: prize money is recorded at team level and never reaches a person
**Evidence.** `winnings(team_id, slot_id, position, amount_won)` (`scripts/00:187-197`). There is
no `player_id`, no split, no payment record, no payout status.
**Impact:** **the single most important financial flow in esports — prize money distribution to
players — is entirely absent.** A prize won is visible only as a team-level number.
**Severity:** HIGH · **Confidence:** HIGH
**Recommendation:* this is the highest-value missing capability in the entire system; see
`65_FUTURE_PAYROLL.md` and `66_FUTURE_FINANCE.md`.

### F-TOR-04 — MEDIUM: `organizer` and `time_range` are free text
**Evidence.** `scripts/00:138-139` `organizer text NOT NULL`, `time_range text NOT NULL`.
**Impact:** no grouping, no filtering, no reconciliation with an external event, no reporting
by organiser; `time_range` as text cannot be compared with a session time.
**Severity:** MEDIUM · **Confidence:** HIGH

### F-TOR-05 — MEDIUM: `teams.tier` conflates competitive division with price band
**Evidence.** `teams.tier text DEFAULT 'T4'` (free text, no CHECK) and
`tier_defaults(tier UNIQUE, default_slot_rate)` seeded with God/T1–T4
(`scripts/00:32, 209-216, 544-550`).
**Impact:** a team's competitive standing and its budget band are the same field. A team can
hold a tier with no rate card (no FK), so the default rate silently becomes `0`
(`scripts/00:146`), producing free slots.
**Severity:** MEDIUM · **Confidence:** HIGH

### F-TOR-06 — MEDIUM: `get_team_performance_summary` joins a UUID column to a legacy integer column
**Evidence.** `automation-scripts/01:122`
`LEFT JOIN public.winnings w ON w.slot_id = p.slot AND w.team_id = p.team_id` where
`performances.slot` is the legacy integer/no-FK column and `winnings.slot_id` is a UUID.
**Impact:** the join can never match, so the `total_winnings` figure in the team summary is
always 0. A financial metric is silently wrong.
**Severity:** MEDIUM · **Confidence:** HIGH

### F-TOR-07 — MEDIUM: no external data source
**Evidence.** absence — no Riot/Steam/FACEIT/tournament-API integration, no match-import
capability. `performance_records` (with `match_id`, `game_mode`, `metadata`) was designed for
this and **is never used** (`scripts/00:396-418`).
**Impact:** every result is keyed by hand, so the data is slow, incomplete and error-prone; and
it cannot be reconciled against an authoritative source for eligibility or prize purposes.
**Severity:** MEDIUM · **Confidence:** HIGH
**Recommendation:* see `76_INTEGRATIONS.md` for the competitive-data integration plan.

## 4. Verdict
| Asset | Verdict |
| --- | --- |
| Slot purchase cost ledger | **MIGRATE as historical data**, rebuild as a proper `entries` + `entry_costs` model |
| Tier rate card | **MOVE to the commercial/pricing domain**, decoupled from competitive standing |
| `performance_records` schema | **REUSE the shape** for real match ingestion, then process into a proper match model |
| `team_monthly_stats` | **REPLACE with a view/materialised rollup** over the new match model |
| Everything else needed for competition | **BUILD NEW** (`61_ORGANIZATION_MODEL.md` §Competitive, `76_INTEGRATIONS.md`) |
