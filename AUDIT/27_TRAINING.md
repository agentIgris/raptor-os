# 27 — TRAINING
**Audit.md section:** 34 (SECTION 31 — TRAINING DOMAIN)

## 1. What exists

| Concept | State | Evidence |
| --- | --- | --- |
| Training session | **Implemented** as `sessions` with `session_type='practice'` and `session_subtype` free text | `scripts/00:222-240` |
| Recurring schedule | **Implemented** as `practice_session_config` per team with Morning/Evening/Night windows + cutoff | `scripts/00:276-290` |
| Scrim | **NOT IMPLEMENTED as an entity.** "Scrim" exists only as (a) a `session_type`-adjacent value in the tryout enums (`tryout_sessions.session_type CHECK IN ('scrim','tournament','practice','meeting','custom')`, `SUPABASE_TRYOUTS_SETUP_FIXED:89`) and (b) a Discord message type `slot_create`. There is no `scrims` table, no opponent, no result. | `rg "scrim" -g "*.sql"` → only the enum and comment text |
| Training outcome / drill | **MISSING** | no entity |
| Training plan / block | **MISSING** | no entity |
| Practice config UI | **Implemented** but duplicated: `components/attendance/practice-session-config.tsx` (22,382 B) + `app/api/sessions/practice-config` + `reset` | |
| Daily session manager | **Implemented**: `components/attendance/daily-session-manager.tsx` (24,894 B) + `/api/sessions/generate-daily` | |
| Attendance from training | **Implemented** (defect-dense — see `26_ATTENDANCE.md`) | |
| Session generation scheduling | `pg_cron` job calling `generate_daily_practice_sessions(date)` | `automation-scripts/06-scheduled-jobs-setup.sql`; `database-schema-updates.sql:238` grants EXECUTE to `authenticated` |
| Non-attendance check-ins | **MISSING** | no check-in entity, no `bot_attendance` usage (table exists, unused) |

## 2. Findings

### F-TRN-01 — HIGH: "training" and "sessions" are the same thing, and the type enum is too coarse
**Evidence.** `sessions.session_type CHECK IN ('practice','tournament','meeting')` with a
free-text `session_subtype` (`scripts/00:225-226`). Everything a training programme needs —
a plan, a block, a drill, a scrim block, a review session, a team meeting — is squeezed into one
row with a free-text subtype.
**Impact:** no way to build a weekly training plan; no way to report "hours by drill type"; no
scrim opponent or result; no load management across sessions; a coach cannot see a schedule
that spans sessions.
**Severity:** HIGH · **Confidence:** HIGH

### F-TRN-02 — HIGH: `generate_daily_practice_sessions` is not idempotent
**Evidence.** `automation-scripts/02:38-86`; exposed via
`app/api/sessions/generate-daily/route.ts` with both `GET` and `POST`; **no unique constraint**
on `sessions` to prevent duplicates, and no existence check.
**Impact:** a `pg_cron` retry, a double-click, or a manual re-run creates duplicate sessions for
the same team and date — which then multiply attendance rows through the auto-attendance trigger.
**Severity:** HIGH · **Confidence:** MEDIUM-HIGH
**Recommendation:** `UNIQUE (team_id, date, session_subtype)` where a recurring window applies;
`INSERT … ON CONFLICT DO NOTHING`; the manual endpoint should return what it created.

### F-TRN-03 — MEDIUM: the training window is configuration, not policy
**Evidence.** `practice_session_config` has a single row set per `session_subtype` per team with
one `start_time`, `end_time`, `cutoff_time` and `is_active` (`scripts/00:277-289`). The API also
has a `reset` endpoint (`app/api/sessions/practice-config/reset`).
**Impact:* there is no per-weekday variation (weekend schedules are impossible), no per-player
exclusion, no per-role schedule, no overtime/extra-session concept, and no public/private
distinction. The `cutoff_time` is the mechanism that auto-marks absences, so this row is
HR-relevant configuration with **no RLS** (F-ATT-05) and no audit trail.
**Severity:** MEDIUM · **Confidence:** HIGH

### F-TRN-04 — MEDIUM: no training-load or availability modelling
**Evidence.** absence.
**Impact:** no way to answer "is this player over-training", "how many hours did the team train
this week", "does this schedule respect the player's declared availability"
(`tryout_applications.availability text[]` shows availability is a *recruitment* concept only, not
an employment one).
**Severity:** MEDIUM · **Confidence:** HIGH

### F-TRN-05 — MEDIUM: the calendar is a client-side aggregation of rows
**Evidence.** `app/dashboard/attendance/page.tsx` (18,154 B) +
`components/attendance/daily-session-manager.tsx` (24,894 B) + `daily-practice-attendance.tsx`
(15,172 B) + `session-attendance.tsx` (23,843 B) + `scrim-attendance.tsx` (11,613 B) +
`training-session-attendance.tsx` (16,250 B), all fetching from `/api/sessions*` and
`/api/attendances*`; `app/api/sessions/attendance-heatmap.ts` computes a heatmap server-side.
**Impact:** no shared calendar model; inconsistent rendering of the same data; no
real-time updates (no Supabase Realtime subscription anywhere), so two coaches looking at the
same screen see different states.
**Severity:** MEDIUM · **Confidence:** HIGH

## 3. Verdict
**REBUILD the schema; MIGRATE the rules.** V2 needs: `training_blocks` (a plan for a period),
`sessions` (an occurrence of a block or an ad-hoc event) with a proper `kind` discriminator,
`scrims` and `matches` as real competitive entities (see `28_TOURNAMENTS.md`),
`session_participants`, per-weekday recurrence, per-player availability and exceptions,
check-in/check-out, and a workload rollup. Keep the cutoff-based auto-absent rule and the
holiday calendar.
