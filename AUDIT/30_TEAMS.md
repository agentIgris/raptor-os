# 30 — TEAMS
**Audit.md section:** 37 (SECTION 34 — TEAM DOMAIN)

## 1. What exists
| Concept | Implementation | Evidence |
| --- | --- | --- |
| Team | `teams(id, name, tier, coach_id, status ∈ {active, inactive, suspended}, created_at)` | `scripts/00:28-36` |
| Roster | `rosters(team_id, user_id, in_game_role, contact_number, device_info, created_at)` | `scripts/00:347-358` |
| Coach | `teams.coach_id → users.id ON DELETE SET NULL`, with a trigger enforcing that the assignee has `role='coach'` | `scripts/00:443-444`; `automation-scripts/01:57-73` |
| Division / tier | `teams.tier text` (free text) + `tier_defaults(tier UNIQUE, default_slot_rate)` | `scripts/00:32, 209-216` |
| Game | **MISSING** | no `games` table; `scripts/13:18` adds an ad-hoc `game text` column to `teams` |
| Region | **MISSING** | ad-hoc `region` column (`scripts/13:19`) |
| Branding | **MISSING** | ad-hoc `logo_url`, `banner_url` (`scripts/13:20-21`) |
| Player history | **MISSING** | `rosters` has `created_at` only; no `ended_at`, no `valid_from/valid_to` |
| Multi-coach staff | **MISSING** | one `coach_id` per team; a manager/analyst/head-of-esports cannot be modelled |
| Team monthly stats | `team_monthly_stats` (derived rollup) | `scripts/14-create-team-monthly-stats.sql` |

## 2. Findings

### F-TEAM-01 — HIGH: there is no organisation, so a "team" is the top of the hierarchy
**Evidence.** no `organizations` table in any of the 43 SQL files; no `organization_id` column
on any table; `lib/supabase.ts`'s `Database` type has none.
**Impact.** The system can represent exactly one esports organisation forever. There is no
`Organization → Division → Team` chain, which is the foundational structure of the target
product (`61_ORGANIZATION_MODEL.md`). This is the single most consequential structural gap.
**Severity:** CRITICAL (for the SaaS goal) · **Confidence:** HIGH

### F-TEAM-02 — HIGH: team membership is stored twice with no constraint
**Evidence.** `users.team_id` (`scripts/00:44`) **and** `rosters` (`:347-358`); no trigger, no
constraint, no `UNIQUE(team_id, user_id)`.
**Impact.** A user can be on two rosters or on none while `users.team_id` disagrees; team-scoped
authorisation silently changes meaning depending on which table a given code path reads
(`app/api/performances:102-108` vs `app/api/rosters`). This is a direct cause of
"player appears in the wrong team's attendance" class bugs.
**Severity:** HIGH · **Confidence:** HIGH
**Recommendation:** one effective-dated `team_memberships` table; `UNIQUE(person_id, team_id, valid_from)`.

### F-TEAM-03 — HIGH: hard-deleting a team destroys the competitive record
**Evidence.** `DELETE /api/teams/manage`; `ON DELETE CASCADE` from `teams` to `performances`,
`attendances`, `rosters`, `sessions`, `slots`, `slot_expenses`, `winnings` (transitively
`prize_pools`) and to `users` via `user_agreements`. Soft-delete columns exist
(`scripts/13:42, 45` `archived_at`, `deleted_at`) but are **never written or filtered**
(`rg "archived_at|deleted_at"` → no application usage).
**Impact:** one deletion irreversibly removes results, attendance and financial history. No
confirmation dialog (`alert-dialog.tsx` is dead code), no audit record, no backup guarantee.
**Severity:** HIGH · **Confidence:** HIGH

### F-TEAM-04 — HIGH: no roster history
**Evidence.** `rosters.created_at` only; `users.status ∈ {Active, Benched, On Leave,
Discontinued}` is a single current value with no dates.
**Impact.** "Who was on Team A on 12 March?" is unanswerable. This blocks: tournament
eligibility verification, prize-money allocation by period, contract-period alignment,
"player history" as a competitive-integrity record, and any HR dispute about when a player's
employment started. For an esports organisation this is a fundamental gap.
**Severity:** HIGH · **Confidence:** HIGH

### F-TEAM-05 — MEDIUM: `tier` is an unconstrained free-text string with a rate-card side effect
**Evidence.** `teams.tier text DEFAULT 'T4'` with no CHECK; `tier_defaults.tier` is a 5-value
`UNIQUE` set seeded with God/T1–T4.
**Impact.** A team can hold a tier with no rate card, in which case the slot default rate is `0`
(`scripts/00:146`) and slot purchases are recorded as free. A competitive division and a price
band are conflated in one field.
**Severity:** MEDIUM · **Confidence:** HIGH

### F-TEAM-06 — MEDIUM: only one coach per team, and the role model cannot express a staff structure
**Evidence.** `teams.coach_id` (single column); `users.role` is a single enum with no
`manager_of`, `reports_to` or department concept.
**Impact.** A head of esports, an assistant coach, a team manager, an analyst and a
performance coach cannot all be attached to a team. This is the core of `62_PEOPLE_MODEL.md`.
**Severity:** MEDIUM · **Confidence:** HIGH

### F-TEAM-07 — MEDIUM: RLS allows players to read their whole team's roster, including PII
**Evidence.** two competing policy sets — `scripts/04:136-139` (own entry only) and
`scripts/13:203-212` (whole team), OR-combined; `rosters` carries `contact_number` and
`device_info` (`scripts/00:351, 353`).
**Impact:** every player can read every teammate's phone number and device details.
**Severity:** MEDIUM · **Confidence:** HIGH

### F-TEAM-08 — MEDIUM: no team creation workflow
**Evidence.** `app/api/teams/manage` POST creates a team, but there is no onboarding flow: no
default staff assignment, no default `practice_session_config` row, no default
`communication_settings` rows (which `initializeTeamAutomationSettings`
(`automation-scripts/04:371-401`) would create but is **never called**), no default
`discord_webhooks` scope, no roster slots.
**Impact:** a newly created team is inert and its configuration is inconsistent with every other
team, which is a support burden and a source of subtle bugs.
**Severity:** MEDIUM · **Confidence:** HIGH

### F-TEAM-09 — LOW: `team_monthly_stats` is a hand-maintained rollup table
**Evidence.** `scripts/14-create-team-monthly-stats.sql` with two RLS policies; written by
`app/api/teams/monthly`.
**Impact:** a derived fact stored as a table, with no guarantee it matches its source. Should be
a view or a materialised view.
**Severity:** LOW · **Confidence:** MEDIUM

## 3. Verdict
| Asset | Verdict |
| --- | --- |
| `teams` rows (name, status, created_at) | **MIGRATE** as `Team` under a new `Organization` |
| `teams.tier` | **REPLACE** with an explicit `division_id` referencing a competition division |
| `coach_id` | **REPLACE** with a proper `team_staff_assignments` (many staff, many roles, effective-dated) |
| `rosters` + `users.team_id` | **MERGE** into one effective-dated `team_memberships` |
| Team CRUD UI/API | **REBUILD** with a real team-creation workflow |
| `team_monthly_stats` | **REPLACE with a view** |
| `archived_at` / `deleted_at` | **ACTIVATE** as the default mutation path |
