# 11 — DATABASE INVENTORY

**Audit.md section:** 16 (SECTION 13 — DATABASE INVENTORY)
**Engine:** PostgreSQL via Supabase (managed). **Schema:** `public`.
**Machine-readable extract:** `AUDIT/database/table-inventory.csv`, `AUDIT/database/rls-policy-register.csv`.

---

## 1. Table census

**32 tables** are created across 43 SQL files. **18 have RLS enabled. 14 do not.**

| # | Table | Purpose | RLS | Defined in | App reads it | App writes it |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `admin_config` | Global key/value configuration: `app_version`, `maintenance_mode`, `agreement_version_*`, `agreement_content_*`, `agreement_enforcement_enabled`, `default_public_webhook_id` | ❌ **NO RLS** | `scripts/00:12-16` | `app/api/admin/settings`, `app/api/admin/agreements` | same |
| 2 | `module_permissions` | `(role, module) → can_access` | ❌ **NO RLS** | `scripts/00:19-25` | **NOTHING** (dead) | nothing |
| 3 | `teams` | A competitive roster container: name, tier, coach, status | ✅ | `scripts/00:28-36`; `scripts/01` | `app/api/teams`, `teams/manage`, `teams/monthly`, `[id]/players`, many joins | `teams/manage` |
| 4 | `users` | **The person record.** Auth profile + 60+ columns incl. PII, BGMI telemetry, emergency contact | ✅ (**but policies self-referentially recurse**) | `scripts/00:39-92`; `scripts/01` | almost every route | `app/api/profile`, `profile/avatar`, `users` (RPC) |
| 5 | `profiles` | **Legacy duplicate of `users`** (bio, full_name, display_name, contact_number, experience, preferred_role, favorite_games, role, onboarding_completed) | ✅ | `scripts/00:95-114` | `lib/auth-flow-v2:309-317` (fallback only) | sync trigger only |
| 6 | `user_agreements` | Versioned legal acceptance per `(user_id, role)` with IP + UA | ✅ (3 competing policy sets) | `scripts/00:117-130`; `database/AGREEMENT_ENFORCEMENT_SETUP.sql` | `app/api/agreements` | `app/api/agreements` |
| 7 | `slots` | A purchased tournament slot: organizer, time_range, number_of_slots, slot_rate, match_count, date | ✅ | `scripts/00:137-150`; `scripts/04` | `app/api/slots` | `app/api/slots`, `app/debug*` |
| 8 | `performances` | One player's result in one match: kills, assists, damage, survival_time, placement, map, match_number, slot/slot_id | ✅ | `scripts/00:153-171`; `scripts/14` | `app/api/performances`, `analytics/performance`, `dashboard/overview` | `app/api/performances` |
| 9 | `slot_expenses` | Cost of a slot purchase: rate × number_of_slots | ✅ | `scripts/00:174-185`; `scripts/04` | `app/api/expenses` | trigger `create_slot_expense()` |
| 10 | `winnings` | Prize money won: position, amount_won | ✅ | `scripts/00:187-197`; `scripts/04` | `app/api/winnings` | manual |
| 11 | `prize_pools` | Total pool + JSON breakdown | ✅ | `scripts/00:199-207`; `scripts/04` | (no API route) | manual |
| 12 | `tier_defaults` | Rate card: tier → default_slot_rate | ✅ | `scripts/00:209-216`; `scripts/06`; `scripts/10` | `app/api/tier-defaults` | `app/api/tier-defaults` |
| 13 | `sessions` | Practice / tournament / meeting: subtype, date, start/end/cutoff, mandatory | ✅ | `scripts/00:222-240`; `database/session-attendance-schema.sql` | `app/api/sessions*` | `app/api/sessions` |
| 14 | `attendances` | One person's attendance at one session: date, session_time, status, marked_by, slot_id, session_id, source | ✅ | `scripts/00:242-260`; `scripts/11` | `app/api/attendances*` | `app/api/attendances`, triggers |
| 15 | `holidays` | Team holiday calendar (optional recurring weekday) | ✅ | `scripts/00:262-274`; `session-attendance-schema.sql` | (no API route) | (no API route) |
| 16 | `practice_session_config` | Recurring Morning/Evening/Night practice windows with cutoff | ❌ **NO RLS** | `scripts/00:276-290` | `app/api/sessions/practice-config*` | same |
| 17 | `discord_webhooks` | **Webhook URL = a Discord write credential**, stored in plaintext | ✅ (but see `13_RLS_SECURITY.md` F-RLS-02) | `scripts/00:296-309`; `complete-discord-portal-setup.sql` | `webhookService.ts`, `app/api/discord-portal/webhooks` | same |
| 18 | `communication_logs` | Every outbound Discord delivery attempt: payload, response, retry_count, triggered_by | ✅ (INSERT is `WITH CHECK (true)`) | `scripts/00:311-328`; `complete-discord-portal-setup.sql` | `app/api/discord-portal/logs` | `sendToDiscord.ts` |
| 19 | `communication_settings` | Per-team (or global) automation toggles | ✅ | `scripts/00:330-341`; `complete-discord-portal-setup.sql` | `app/api/discord-portal/settings` | same |
| 20 | `rosters` | Team membership + in_game_role, contact_number, device_info | ✅ | `scripts/00:347-358`; `scripts/04` | `app/api/rosters` | `app/api/rosters` |
| 21 | `discord_servers` | Discord guild ↔ team link: guild_id, owner_id, connected_team_id, features | ✅ | `scripts/00:365-376` | (no API route reads it) | (none) |
| 22 | `discord_users` | Discord account ↔ app user link | ✅ | `scripts/00:379-393` | `app/api/discord/tryout/{invite,evaluate,announce}` | same |
| 23 | `performance_records` | Bot-ingested performance: match_id, kills, damage, survival_time interval, map_name, game_mode, processed flag | ✅ | `scripts/00:396-418` | (no API route) | (none) |
| 24 | `bot_attendance` | Voice-channel attendance: attendance_type (voice_join/voice_leave/manual_mark), status, duration | ✅ | `scripts/00:421-436` | (no API route) | (none) |
| 25 | `tryouts` | A recruitment campaign: purpose, target_roles[], team_ids[], type, deadline, evaluation_method, status, guild_id, mode | ✅ | `SUPABASE_TRYOUTS_SETUP_FIXED.sql:11-32`; `scripts/00:583-600` | `app/api/tryouts`, `app/api/discord/tryout/*` | same |
| 26 | `tryout_applications` | A candidate's application: full_name, ign, discord_tag, availability[], highlights_links[], contact_email/phone, status, **phase**, ip, ua, application_source | ✅ | `SUPABASE_TRYOUTS_SETUP_FIXED.sql:35-60`; `scripts/00:602-624` | same | same |
| 27 | `tryout_invitations` | Shortlist invitation: message, temporary_access_granted, access_expires_at, temp_user_id, status | ✅ | `SUPABASE_TRYOUTS_SETUP_FIXED.sql:63-81` | `app/api/discord/tryout/invite,status` | same |
| 28 | `tryout_sessions` | An evaluation session for an invited candidate: session_type, goals, scheduled_date, attendance_status | ✅ | `SUPABASE_TRYOUTS_SETUP_FIXED.sql:84-106` | `app/api/discord/tryout/list,status` | (none) |
| 29 | `tryout_evaluations` | Scorer's assessment: objective stats + 4 subjective 1-10 scores + overall_score + recommendation + is_final | ✅ | `SUPABASE_TRYOUTS_SETUP_FIXED.sql:109-147` | `app/api/discord/tryout/{list,status,evaluate}` | same |
| 30 | `tryout_selections` | Outcome: selected/rejected/extended, assigned_team_id, player_type, rejection_reason, new_team_name/tier, notification flags | ✅ | `SUPABASE_TRYOUTS_SETUP_FIXED.sql:150-185` | `app/api/discord/tryout/list` | (none) |
| 31 | `team_monthly_stats` | Per-team per-month rollup | ✅ | `scripts/14-create-team-monthly-stats.sql` | `app/api/teams/monthly` | same |
| 32 | `attendance_debug_log` | **Debug artefact left in the schema** | ❌ **NO RLS** | `scripts/17-debug-attendance-with-logging.sql:17` | (none) | trigger |

Plus: **`storage.buckets`** (4 rows) and **`storage.objects`** policies; **`auth.users`** (GoTrue, referenced by FK); and the view **`tryout_stats`**.

---

## 2. Column-level inventory for the load-bearing tables

### 2.1 `users` — 62 columns (`scripts/00:39-92`)
| Group | Columns | Notes |
| --- | --- | --- |
| Identity | `id uuid PK → auth.users(id) ON DELETE CASCADE`, `email text UNIQUE NOT NULL`, `name`, `display_name`, `full_name` | **Three name columns for one human.** `profiles` duplicates them again. |
| Role & scope | `role text CHECK(7 values) DEFAULT 'pending_player'`, `role_level int DEFAULT 10`, `team_id uuid → teams(id)`, `status text CHECK('Active','Benched','On Leave','Discontinued') DEFAULT 'Active'` | `role_level` is **denormalised** from `ROLE_CONFIG` and written by application code, not a constraint. |
| Contact / PII | `contact_number`, `emergency_contact_name`, `emergency_contact_number`, `date_of_birth date`, `address text` | Returned by `GET /api/users` to players. |
| Device telemetry | `device_info`, `device_model`, `ram`, `fps`, `storage`, `gyroscope_enabled bool` | Precise hardware telemetry for a player base. |
| Game profile | `in_game_role`, `favorite_game`, `favorite_games`, `gaming_experience`, `experience`, `preferred_role`, `bgmi_id`, `bgmi_tier CHECK(8 values)`, `bgmi_points int`, `control_layout CHECK(5 values)`, `hud_layout_code`, `sensitivity_settings jsonb`, `game_stats jsonb`, `achievements jsonb` | **BGMI-specific.** `bgmi_tier` is an 8-value CHECK — adding a game requires a migration. |
| Social | `instagram_handle`, `discord_id`, `social_links jsonb`, `bio` | `discord_id` is a platform identifier with no uniqueness constraint. |
| Lifecycle | `onboarding_completed bool DEFAULT false`, `auto_sync_tryout_data bool DEFAULT true`, `last_login`, `last_profile_update`, `provider` | `onboarding_completed` is the gate for the whole onboarding funnel. |
| Preferences | `preferred_language text DEFAULT 'English'`, `timezone text DEFAULT 'Asia/Kolkata'`, `profile_visibility text CHECK('public','team','private') DEFAULT 'team'` | **The only localisation fields in the entire schema — and nothing consumes them.** |
| Timestamps | `created_at`, `updated_at DEFAULT now()`, `last_login`, `last_profile_update` | `updated_at` is set by application code; a trigger `update_updated_at_column` also exists. |
| Soft delete | **none** | No `deleted_at` anywhere in the schema. |
| Audit | **none** | No `updated_by`, no change history. |

**Indexes** (`scripts/00:451-453`): `(team_id, role)`, `(role, status)`, `(email)`.
**Missing indexes:** `discord_id`, `bgmi_id`, `onboarding_completed`, `profile_visibility`, `lower(email)` for case-insensitive lookup.
**Missing constraints:** `UNIQUE(discord_id)`, `UNIQUE(bgmi_id)`, any CHECK tying `role_level` to `role`.

### 2.2 `performances`
`id PK`, `team_id → teams(id) ON DELETE CASCADE`, `player_id → users(id) ON DELETE CASCADE`, `match_number int NOT NULL`, `map text NOT NULL`, `placement int`, `kills int DEFAULT 0`, `assists int DEFAULT 0`, `damage double precision DEFAULT 0`, `survival_time double precision DEFAULT 0`, `added_by → users(id)` (**no ON DELETE** → RESTRICT/NO ACTION), `slot uuid` (**no FK**), `slot_id uuid → slots(id)` (added later by `scripts/14:12`), `created_at`.

**Findings:**
* **Two slot columns coexist** — `slot` (no FK, described as a "legacy integer field" in `scripts/19:50-54`) and `slot_id` (FK). The API writes `slot_id` and nulls `slot` (`app/api/performances:278-279`). `scripts/00` alone produces a schema the API cannot use.
* `map text NOT NULL` — **no CHECK, no reference table.** Map names are free text, so "Erangel", "erangel", "ERANGEL" are three values. There is no `games` or `maps` table at all.
* `added_by` FK has **no `ON DELETE`** clause, so deleting a user who recorded a performance will fail or orphan.
* `placement` has no CHECK (`> 0`), `kills`/`assists` no CHECK (`>= 0`).
* `survival_time` is `double precision` here but `interval` in `performance_records:406` — **inconsistent time representation** across two performance tables.
* No uniqueness constraint preventing duplicate submissions for the same `(player_id, match_number, slot_id)`; the repo has a script named `18-fix-multiple-performances-per-slot.sql`, which is direct evidence of duplicate rows.
* **No `updated_at`** — performance records are immutable-by-accident, not by design; there is no way to tell a correction from an original.

### 2.3 `attendances`
`id PK`, `player_id → users(id) ON DELETE CASCADE`, `team_id → teams(id) ON DELETE CASCADE`, `date date NOT NULL`, `session_time text NOT NULL`, `status text CHECK('present','late','absent','auto')`, `marked_by → users(id)` (**no ON DELETE**), `slot_id → slots(id)` (FK flipped between `NO ACTION`, `SET NULL` and `CASCADE` across `scripts/11:17`, `scripts/17:100-105`, `scripts/16:11-17`), `session_id → sessions(id)` (**no ON DELETE**), `source text CHECK('manual','auto','system') DEFAULT 'manual'`, `created_at`. Added later: `manager_notes text` (`database-schema-updates.sql:46`), `verified_by`, `verified_at` (`session-attendance-schema.sql:48-65`).

**Findings:**
* **`session_time text`** — a time-of-day stored as free text, not `time`. `'19:00'`, `'7:00 PM'` and `'19:00:00'` are all storable, which makes attendance arithmetic and the cutoff comparison unreliable. This is almost certainly the root cause of the attendance bug backlog.
* **No unique constraint** on `(player_id, date, session_time)` or `(player_id, session_id)` ⇒ duplicate attendance rows are structurally allowed. `scripts/16-fix-auto-attendance-null-date.sql:55-96` and `scripts/18-fix-multiple-performances-per-slot.sql` are evidence of duplicates occurring in production.
* `status` includes `'auto'`, which conflates "no human decision" with a real attendance outcome.
* The API writes a `notes` column that **no script creates**.
* `marked_by` has no `ON DELETE`, so audit attribution breaks if a user is removed.
* **No soft delete, no audit trail, no correction history.**

### 2.4 `teams`
`id PK`, `name text NOT NULL`, `tier text DEFAULT 'T4'` (**free text, no CHECK**), `coach_id uuid → users(id) ON DELETE SET NULL` (added by `scripts/00:443-444`), `status text CHECK('active','inactive','suspended') DEFAULT 'active'`, `created_at`. Added by `scripts/13:17-47`: `description`, `game`, `region`, `logo_url`, `banner_url`, `founded_date`, `is_active`, `updated_at`, `archived_at`, `deleted_at` — **a partial soft-delete scheme that no code uses** (`rg "archived_at|deleted_at"` → no application usage).

**Findings:**
* `tier` is free text while `tier_defaults.tier` is `UNIQUE` with a 5-value seed set. A team can therefore hold a tier with no rate card, and `POST /api/slots` would fall back to a default of 0 (`scripts/00:146` `slot_rate integer DEFAULT 0`).
* **No `game` entity.** "Division", "game", "region" exist only as ad-hoc columns added by a fix script. Multi-title organisations cannot be modelled.
* `deleted_at`/`archived_at` exist but are never set or filtered, so "delete team" (`DELETE /api/teams/manage`) is a **hard delete that cascades to `performances`, `attendances`, `rosters`, `sessions`, `slots`, `slot_expenses`, `winnings`** — an unrecoverable data-loss path with no confirmation and no audit.

### 2.5 `tryouts` family — the best-modelled domain
| Table | Key columns | Integrity |
| --- | --- | --- |
| `tryouts` | `purpose CHECK(3)`, `target_roles text[]`, `team_ids uuid[]` (**array, not a join table**), `type CHECK(4)`, `open_to_public bool`, `application_deadline timestamptz`, `evaluation_method CHECK(3)`, `status CHECK(5)`, `created_by`, `launched_at`, `closed_at`; later `mode CHECK('player','team')`, `guild_id`, `discord_channel_id` | FK `created_by → users(id)`; **no FK on the `team_ids` array** ⇒ dangling team references are possible |
| `tryout_applications` | `full_name`, `ign`, `discord_tag`, `role_applied_for`, `game_id`, `availability text[]`, `highlights_links text[]`, `contact_email`, `contact_phone`, `status CHECK(5)`, `screening_notes`, `screened_by`, `screened_at`, `application_source`, `ip_address inet`, `user_agent`; later `team_name`, `manager_name`, `vod_link`, `discord_id`, `phase CHECK(6) DEFAULT 'applied'` | FK `tryout_id → tryouts(id) ON DELETE CASCADE`; FK `screened_by → users(id)` (**no ON DELETE**) |
| `tryout_invitations` | `status CHECK(4)`, `invitation_message`, `temporary_access_granted`, `access_expires_at`, `temp_user_id`, `invited_at`, `responded_at`, `notes` | FKs to `tryouts`, `tryout_applications`, `users` (×2), all `ON DELETE CASCADE` for the tryout/applications |
| `tryout_sessions` | `session_type CHECK(5)`, `session_title`, `scheduled_date`, `start_time`, `end_time`, `evaluation_goals`, `status CHECK(5)`, `attendance_status CHECK(4)` | FKs to `tryouts`, `tryout_invitations` (CASCADE), `sessions`, `users` |
| `tryout_evaluations` | objective: `kills, assists, damage, survival_time, placement`; subjective: `game_sense_score, utility_score, rotations_score, communication_score` each `CHECK(1..10)`; `overall_score double precision`; `recommendation CHECK(5)`; `is_final bool`; `evaluation_date` | FKs to `tryouts`, `tryout_invitations` (CASCADE), `tryout_sessions`, `evaluator_id → users(id)`. **No UNIQUE on `(invitation_id, evaluator_id)`** ⇒ duplicate evaluations possible even though the API checks for one first (a TOCTOU race). |
| `tryout_selections` | `selection_status CHECK(4)`, `assigned_team_id`, `assigned_role`, `player_type CHECK(3)`, `rejection_reason`, `feedback_message`, `new_team_name`, `new_team_tier`, `selection_date`, `notification_sent`, `discord_notified` | FKs to tryout/invitation/application (CASCADE), `selected_by`, `assigned_team_id → teams(id)` |

**Cross-cutting strengths:** every FK is declared, cascades are consistent for the tryout tree, enums are explicit CHECK constraints, and two independent intake channels (public web + Discord bot) are supported.
**Cross-cutting weaknesses:** `team_ids uuid[]` and `target_roles text[]` are arrays rather than join/reference tables; `tryout_evaluations.overall_score` is computed in application code (`app/api/discord/tryout/evaluate:88-91`) rather than generated, so it can disagree with its components; there is **no offer, contract or consent entity**, so the workflow stops at "selected" with no legal or onboarding bridge.

### 2.6 Discord tables
`discord_webhooks` stores `hook_url text NOT NULL` in **plaintext** with an `active bool` and `type CHECK(3)`. There is no encryption, no secret vault reference, and no rotation metadata. `communication_logs.payload jsonb NOT NULL` stores the full embed. `communication_settings` has `UNIQUE (team_id, setting_key)` — note that in Postgres a `UNIQUE` on a nullable column does **not** prevent duplicate global (`team_id IS NULL`) rows, so global settings can be duplicated, which will make the API's `upsert(..., { onConflict: 'team_id,setting_key' })` fail with "ON CONFLICT DO UPDATE command cannot affect row a second time" or silently create duplicates.

---

## 3. Triggers, functions and views

### 3.1 `SECURITY DEFINER` functions (~25) — all bypass RLS
| Function | Kind | Reads/writes | Identity source | Revoked from `anon`? |
| --- | --- | --- | --- | --- |
| `update_updated_at_column()` | trigger | all tables | n/a | **NO `REVOKE` anywhere in the repo** |
| `sync_user_profile_data()` | trigger | `users` ↔ `profiles` | n/a | **NO** |
| `update_last_login()` | trigger | `users` | n/a | **NO** |
| `validate_coach_assignment()` | trigger | `teams`, `users` — raises if `coach_id` is not a coach | n/a | **NO** |
| `validate_performance_entry()` | trigger | `performances`, `slots` — 4 competing versions | n/a | **NO** |
| `create_slot_expense()` | trigger | inserts `slot_expenses` on slot insert | n/a | **NO** |
| `sync_tryout_to_profile()` | trigger | **`UPDATE users … WHERE id = NEW.id` where `NEW.id` is the *application* id — always 0 rows** | n/a | **NO** |
| `create_auto_attendance()` / `_v2` / `_fixed` | trigger | inserts `attendances` from `performances` | n/a | **NO** |
| `create_match_attendance_from_performance()` | trigger | inserts `attendances` from `performances` | n/a | **NO** |
| `generate_daily_practice_sessions(date)` | function | inserts `sessions` | none | **NO** |
| `auto_mark_absent_after_cutoff()` | function | updates `attendances` | none | **NO** |
| `is_holiday(date, uuid)` | function | reads `holidays` | none | **NO** |
| `get_team_webhook(uuid)` | function | **returns `hook_url`** | none | **NO** |
| `get_team_setting(uuid, text)` | function | reads `communication_settings` | none | **NO** |
| `log_discord_message(...)` | function | inserts `communication_logs` | none | **NO** |
| `cleanup_old_discord_logs(int)` | function | **DELETES logs** | none | **NO** |
| `trigger_slot_creation_notification()` / `trigger_roster_update_notification()` | trigger | reads webhooks, posts to Discord | none | **NO** |
| `can_view_profile(uuid, uuid)` | function | **identity as a parameter** | caller-supplied | **NO** |
| `can_edit_profile(uuid, uuid)` | function | **identity as a parameter** | caller-supplied | **NO** |
| `check_user_agreement_status(uuid, text, int)` | function | reads `admin_config` + `user_agreements` | caller-supplied `p_user_id` | **NO** |
| `get_team_performance_summary(uuid)` | function | aggregates `performances` + `winnings` | none | **NO** |
| `get_player_stats(uuid)` | function | aggregates `performances` | none | **NO** |
| `test_attendance_creation(...)` | test helper | **left in `test_attendance_function.sql`** | none | **NO** |

Evidence: 40 `SECURITY DEFINER` occurrences across the SQL estate; 30 `GRANT EXECUTE … TO authenticated`
statements; **0 `REVOKE` statements in the entire repository** (verified:
`rg "REVOKE" -g "*.sql"` → no matches).

### 3.2 Triggers (9 declared in `automation-scripts/README.md`)
`update_updated_at` on several tables · `sync_user_profile_data` on `users` ·
`validate_coach_assignment` on `teams` · `validate_performance_entry` on `performances` ·
`create_slot_expense` on `slots` · `sync_tryout_to_profile` on `tryout_applications` ·
`create_auto_attendance*` on `performances` · `trigger_slot_creation_notification` /
`trigger_roster_update_notification` on `slots` / `rosters`.
Two trigger **notification** functions call Discord from inside the database, which means an
external HTTP call occurs in a Postgres transaction — slow, non-retryable, and a reliability
hazard.

### 3.3 Views
* `tryout_stats` (`database/SUPABASE_TRYOUTS_SETUP_FIXED.sql:561-579`) — created **without
  `security_invoker = true`**, so it executes with the view owner's privileges and **bypasses
  RLS** on `tryouts`, `tryout_applications`, `tryout_invitations`, `tryout_sessions`,
  `tryout_evaluations` and `tryout_selections`. It exposes counts (including
  `shortlisted_applications`, `total_selections`) for **every** tryout, including `draft` and
  `open_to_public = false` ones. It is also written as a 6-way `LEFT JOIN` + `GROUP BY`, which
  is a **join-multiplication bug**: with 3 applications and 2 invitations on one tryout the
  join produces 6 rows, so every `COUNT` is inflated.

### 3.4 Scheduled jobs (`pg_cron`, 6)
`generate_daily_practice_sessions` daily · `auto_mark_absent_after_cutoff` periodically ·
`cleanup_old_discord_logs` · monthly stats aggregation · attendance debug logging ·
`update_last_login` sweep. All require the `pg_cron` extension; none are defined in a
version-controlled migration with an idempotency guard; the daily-session job will
double-insert sessions on a retry.

---

## 4. Timestamps, soft delete and audit behaviour (summary)

| Concern | State | Evidence |
| --- | --- | --- |
| `created_at` | Present on 24 of 32 tables | `scripts/00` |
| `updated_at` | Present on ~10 tables; maintained by a trigger **and** by application writes in some routes ⇒ possible double-write divergence | `automation-scripts/01:12-18`; `app/api/discord-portal/webhooks:285` |
| Soft delete | **Effectively none.** `teams.archived_at`/`deleted_at` exist but are never written or filtered. `tryouts.status='archived'` is the only soft-delete-like state. | `scripts/13:37-48`; `rg "archived_at\|deleted_at"` → no app usage |
| Audit trail | **None.** No `*_audit` table, no `updated_by`, no change log. `communication_logs` records outbound Discord only, and is publicly insertable. | `13_RLS_SECURITY.md` F-RLS-03 |
| Referential actions | Inconsistent: some `ON DELETE CASCADE`, some `SET NULL`, several (`performances.added_by`, `attendances.marked_by`, `attendances.session_id`, `tryout_applications.screened_by`, `tryout_evaluations.evaluator_id`) have **none**, so they default to `NO ACTION` and will block user deletion | column tables above |
| Currency | **None.** All money columns are `integer` (rupees assumed, zero minor units). `damage` and `survival_time` are `double precision`. | `scripts/00:176-197` |
| Timezone | `sessions.date` is `date`, `start_time` is `time without time zone`, `attendances.session_time` is **`text`**, `attendances.date` is `date`. A user's `timezone` column exists and is unused. | `scripts/00:242-260` |

---

## 5. Database verdict

| Verdict | Tables |
| --- | --- |
| **MIGRATE the model** | `tryouts`, `tryout_applications`, `tryout_invitations`, `tryout_sessions`, `tryout_evaluations`, `tryout_selections` — the recruitment state machine is genuinely well designed |
| **MIGRATE data, REBUILD schema** | `users` (as the seed of a `Person` entity), `teams`, `performances`, `attendances`, `sessions`, `user_agreements` |
| **REBUILD** | `slots`, `slot_expenses`, `winnings`, `prize_pools`, `tier_defaults` → a real competitive-operations and finance domain |
| **ARCHIVE** | `profiles` (legacy duplicate), `performance_records` (unused), `bot_attendance` (unused), `discord_servers` (unused), `attendance_debug_log` (debug artefact), `team_monthly_stats` (materialised rollup — rebuild as a view) |
| **REPLACE** | `discord_webhooks` (secret storage), `communication_logs` (an audit/outbox table), `communication_settings` (a notification-rule table), `module_permissions` (a real permission model), `admin_config` (a typed per-tenant configuration table) |
| **ADD (absent entirely)** | organizations, departments, positions, employment, contracts, invoices, bills, budgets, ledger accounts, sponsors, campaigns, deliverables, inventory, assets, facilities, travel, documents, tasks, notifications, events, integrations, billing |
