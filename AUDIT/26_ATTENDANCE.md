# 26 — ATTENDANCE
**Audit.md section:** 33 (SECTION 30 — ATTENDANCE DOMAIN)

## 1. Domain model (this part is genuinely good)
| Entity | Purpose | Evidence |
| --- | --- | --- |
| `sessions` | a scheduled practice / tournament / meeting: `session_type ∈ {practice, tournament, meeting}`, `session_subtype`, `date`, `start_time`, `end_time`, `cutoff_time`, `is_mandatory`, `title`, `description`, `created_by` | `scripts/00:222-240` |
| `practice_session_config` | recurring windows per team: `session_subtype ∈ {Morning, Evening, Night}`, `start_time`, `end_time`, `cutoff_time`, `is_active` | `scripts/00:276-290` — **no RLS** |
| `holidays` | team (or global) non-working days; optional `recurring_day` 0-6 | `scripts/00:262-274` |
| `attendances` | one person × one session: `date`, `session_time`, `status ∈ {present, late, absent, auto}`, `marked_by`, `slot_id`, `session_id`, `source ∈ {manual, auto, system}` | `scripts/00:242-260` |

## 2. Business rules (the valuable part)
| Rule | Implementation | Evidence |
| --- | --- | --- |
| Recurring daily sessions are generated from the team's practice config | `generate_daily_practice_sessions(target_date date)` | `automation-scripts/02:38-86` |
| A player who has not checked in by `cutoff_time` is auto-marked | `auto_mark_absent_after_cutoff()` | `automation-scripts/02:88-140` |
| Holidays are excluded from session generation | `is_holiday(date, team_id)` | `automation-scripts/02:12-36` |
| Submitting a performance implies match attendance | `create_auto_attendance()` / `_v2` / `_fixed` / `create_match_attendance_from_performance()` | `automation-scripts/02:146-223`; `database/session-attendance-schema.sql:263-336` |
| Managers verify training participation | `attendances.verified_by`, `verified_at`, `manager_notes` added by `database/session-attendance-schema.sql:48-65` and `database-schema-updates.sql:45-46` | |
| Duplicate suppression by `player_id` (+ `slot_id` in later versions) | `scripts/16-fix-auto-attendance-null-date.sql:55-96` | |

**These rules are the single most reusable domain asset in the repository** and should be
preserved semantically in V2 (as an organisation-configurable attendance policy), while the
implementation is discarded.

## 3. Findings

### F-ATT-01 — CRITICAL: the delete handler is a `ReferenceError` and always returns 500
**Evidence.** `app/api/attendances/route.ts:310` calls `getUserFromRequest(request)`, which is
neither imported (the file imports only `authenticateRequest, createErrorResponse,
createSuccessResponse, checkRoleAccess, validateRequiredFields, isValidUuid, handleCors`) nor
defined in the file.
**Impact:** attendance deletion is entirely unavailable. Survived because
`typescript.ignoreBuildErrors: true` (`next.config.mjs:19-21`) and there are no tests.
**Severity:** HIGH · **Confidence:** HIGH

### F-ATT-02 — HIGH: `session_time` is `text`, which makes attendance arithmetic unreliable
**Evidence.** `scripts/00:247` `session_time text NOT NULL`; `attendances.date date` (so the
time-of-day is in a text column while the day is a real date). Contrast `sessions.start_time
time without time zone` (`:229`).
**Impact.** `'19:00'`, `'7:00 PM'`, `'19:00:00'` and `'7pm'` are all storable. The cutoff
comparison in `auto_mark_absent_after_cutoff()` depends on a consistent representation. This is
the most likely root cause of the long attendance bug backlog
(`APPLY_ATTENDANCE_FIX.md`, `DEBUG_ATTENDANCE_ISSUE.md`, `comprehensive_attendance_debug.sql`,
`debug_attendance_trigger.sql`, `investigate_existing_attendance.sql`,
`test_attendance_function.sql`).
**Severity:** HIGH · **Confidence:** MEDIUM-HIGH
**Recommendation:** `session_time time without time zone` (or better, an FK to `sessions.id` with
`start_time`/`cutoff_time` derived rather than copied).

### F-ATT-03 — HIGH: no uniqueness constraint — duplicate attendance is structurally allowed
**Evidence.** No `UNIQUE` on `attendances`. The fix scripts explicitly de-duplicate:
`scripts/16-fix-auto-attendance-null-date.sql:55-96` (comment: *"Check for duplicates based on
slot_id when available"*); `scripts/18-fix-multiple-performances-per-slot.sql` (title:
*"multiple performances per slot"*); `scripts/17-debug-attendance-with-logging.sql:145`.
**Impact:** the trigger and the API can both insert; counts are inflated; percentages are wrong.
**Severity:** HIGH · **Confidence:** HIGH
**Recommendation:** `UNIQUE (player_id, session_id)` (or `(player_id, date, session_time)` where
`session_id` is null), plus an idempotent upsert in the trigger.

### F-ATT-04 — HIGH: four competing definitions of the auto-attendance trigger
**Evidence.** `create_auto_attendance` (`scripts/11:102`, `database-schema-updates.sql:313`),
`create_auto_attendance_v2` (`scripts/15:11`), `create_auto_attendance_fixed`
(`scripts/16:16`, `scripts/17:17`, `scripts/18:10`) — plus
`create_match_attendance_from_performance` (`database/session-attendance-schema.sql:263`,
`scripts/14:84`, `scripts/17:187`, `scripts/19:160`, `scripts/20:60`, `scripts/21:60`), which is
the same function under a second name with **six** definitions.
**Impact:** which trigger is attached is unknowable from the repository; behaviour differs
depending on script order; `slot` vs `slot_id` is resolved differently in each.
**Severity:** HIGH · **Confidence:** HIGH

### F-ATT-05 — HIGH: `practice_session_config` has no RLS
**Evidence.** created `scripts/00:276-290`; not in any `ENABLE ROW LEVEL SECURITY` list.
**Impact:** anyone with the public anon key can read every team's internal schedule and
**modify the cutoff time**, which directly changes who is auto-marked absent. This is a write
path into the attendance record.
**Severity:** HIGH · **Confidence:** HIGH

### F-ATT-06 — MEDIUM: `status` conflates "no human decision" with a real outcome
**Evidence.** `CHECK (status = ANY(ARRAY['present','late','absent','auto']))` — `'auto'` sits
alongside genuine outcomes.
**Impact:** reporting must special-case `'auto'`; it is ambiguous whether `'auto'` means
"auto-marked present" or "not yet decided". `auto_mark_absent_after_cutoff` implies absent, but
the enum does not distinguish provenance.
**Severity:** MEDIUM · **Confidence:** HIGH
**Recommendation:** `status ∈ {present, late, absent, excused}` plus a separate
`marked_by_kind ∈ {person, system, import}` and `marked_at`.

### F-ATT-07 — MEDIUM: no correction history and no soft delete
**Evidence.** `attendances` has `created_at` only; no `updated_at`, no `notes` column in the
schema (the API writes one), no `deleted_at`.
**Impact.** An attendance correction is indistinguishable from the original; a disputed absence
cannot be shown to have been reviewed. There is no `UNIQUE`d audit trail for a
performance-related HR action.
**Severity:** MEDIUM · **Confidence:** HIGH

### F-ATT-08 — MEDIUM: `attendances.team_id` is derivable but stored, and is not verified
**Evidence.** `team_id NOT NULL` with an FK, plus `player_id`; `scripts/20:43-46` adds the comment
*"Team ID - can be derived from player_id or slot_id if null"* while the column is `NOT NULL`.
The API never checks that `player_id` is a member of `team_id` (`app/api/attendances:168-180`).
**Impact:** the same player can have attendance rows against multiple teams; team-scoped
authorisation and reporting are both wrong.
**Severity:** MEDIUM · **Confidence:** HIGH

### F-ATT-09 — MEDIUM: 12 overlapping attendance components
**Evidence.** `components/attendance/` — 12 files, 172 KB; `mark-attendance` vs
`enhanced-mark-attendance`; `session-attendance` vs `training-session-attendance` vs
`scrim-attendance` vs `daily-practice-attendance`; `attendance-stats` vs `attendance-logs` vs
`manager-verification`.
**Impact:** six different notions of "a session" in the UI, which is a plausible contributor to the
defect backlog. Users see different fields depending on which surface they enter from.
**Severity:** MEDIUM · **Confidence:** HIGH

### F-ATT-10 — LOW: `holidays` mixes global and team holidays with no discriminator
**Evidence.** `scripts/00:263` `team_id uuid` (nullable) with no scope column; policy
`"Everyone can view holidays"` (`database/session-attendance-schema.sql:128-130`).
**Severity:** LOW · **Confidence:** HIGH

## 4. Verdict

| Asset | Verdict |
| --- | --- |
| The attendance **rules** (recurring windows, cutoff-based auto-absent, holiday exclusion, performance-implies-attendance, manager verification) | **MIGRATE** as organisation-configurable policy |
| The `attendances` / `sessions` / `practice_session_config` / `holidays` **schema** | **REBUILD** (`time` not `text`, uniqueness, provenance, correction history, RLS) |
| `attendances_debug_log` | **REMOVE** |
| The 12 components | **REBUILD** as one surface with a session-type discriminator |
| The auto-attendance triggers | **REPLACE** with a single idempotent, `SECURITY DEFINER` function |
