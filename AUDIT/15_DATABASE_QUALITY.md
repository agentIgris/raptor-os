# 15 — DATABASE QUALITY

**Audit.md section:** 18 (SECTION 15 — DATABASE QUALITY)

---

## 1. Normalisation

| Area | Verdict | Evidence |
| --- | --- | --- |
| Person data | **Violation (1NF/2NF across tables).** The same person is split across `users` (62 cols), `profiles` (13 overlapping cols), and `rosters` (3 more), and a single person has **three name columns** (`name`, `display_name`, `full_name`) in `users` plus two more in `profiles`. | `scripts/00:43-46, 66-67, 100-102`; `scripts/00:95-114`; `scripts/00:347-358` |
| Team membership | **Violation.** `users.team_id` and `rosters` both encode membership. | `scripts/00:44`; `:347-358` |
| Coach assignment | **Violation.** `teams.coach_id` + `users.role='coach'` + `users.team_id` express overlapping facts. | `scripts/00:33, 43-44` |
| Money | **Acceptable denormalisation, wrong types.** `slot_expenses.total` is stored *and* derivable (`rate × number_of_slots`); `prize_pools.breakdown jsonb` duplicates `winnings`; all money is `integer` with no currency. | `scripts/00:174-207`; trigger `automation-scripts/04:16-28` |
| Performance metrics | **Acceptable** — flat fact table, no duplication. | `scripts/00:153-171` |
| Tryout model | **Well normalised** for the parts that use tables; the arrays (`team_ids`, `target_roles`, `availability`, `highlights_links`) are the exception. | `database/SUPABASE_TRYOUTS_SETUP_FIXED.sql:15-16, 43-44` |
| Configuration | **Anti-pattern.** `admin_config` is an untyped key/value bag holding app version, feature flags, version counters, **full legal document bodies**, and a foreign reference (`default_public_webhook_id`). | `scripts/00:12-16, 552-559`; `app/api/admin/agreements:29-33, 118-124` |
| Permissions | **Anti-pattern.** `module_permissions` is a hand-rolled table that the application never reads, alongside four code-based permission models. | `scripts/00:19-25`; `08_ROLES_PERMISSIONS.md` §2 |

---

## 2. Naming

| Issue | Evidence | Severity |
| --- | --- | --- |
| **Singular/plural inconsistency** | `teams`, `users`, `performances`, `sessions`, `rosters`, `slots` are plural; `tryouts`, `holidays`, `tier_defaults`, `admin_config` are singular-ish; `winnings` is an uncountable plural. | LOW |
| **Inconsistent FK column naming** | `team_id` everywhere except `discord_servers.connected_team_id` and `tryout_sessions.session_id` (which points at `sessions.id`, not a session-*team* relation). | LOW |
| **Unqualified vs qualified table names** | `scripts/01` uses `ON users`; `scripts/00` uses `ON public.users`. | MEDIUM (see `13_RLS_SECURITY.md` F-RLS-14) |
| **Column name drift** | `discord_id` on `users`, on `tryout_applications` and on `discord_users` means three different things (the person's linked account vs. the applicant's account vs. the row key). | MEDIUM |
| **`status` overloaded** | `users.status ∈ {Active, Benched, On Leave, Discontinued}` (membership state) vs `teams.status ∈ {active, inactive, suspended}` (lifecycle) vs `tryout_applications.status` vs `tryout_selections.selection_status` — four different vocabularies behind one column name, with inconsistent casing (capitalised for users, lowercase elsewhere). | MEDIUM |
| **Boolean-as-enum** | `status` on `users` encodes four states in a text column with a CHECK; a player "On Leave" is not "inactive", so lifecycle and availability are conflated. | MEDIUM |
| **Emoji-mojibake in identifiers** | `module_permissions` seed data, agreement keys, and several `console` labels contain `dY"`-style corruption, showing that non-ASCII text passed through an unsafe toolchain. | MEDIUM |

---

## 3. Nullability

| Column | Nullable | Assessment |
| --- | --- | --- |
| `users.name` | yes | but `users.full_name` and `users.display_name` are also nullable, and `auth.users` requires an email — so a person can exist with no name at all. The UI uses `name \|\| display_name \|\| email.split('@')[0]` (`lib/auth-flow-v2:454`) which means **"user@domain.com" can become a person's display name**. |
| `users.team_id` | yes | correct for applicants/pending, but it is also the sole team-scope key for authorisation, so a `null` team silently widens or narrows visibility depending on which code path reads it. |
| `performances.team_id` | yes | **A performance with no team cannot be team-scoped**, so it is invisible to a coach and visible to an admin — an authorisation-relevant ambiguity. |
| `performances.player_id` | yes in `scripts/00:156`; **`NOT NULL` in the TypeScript type** (`lib/supabase.ts:239`) | **Type/schema mismatch** — the TS type claims NOT NULL. |
| `performances.added_by` | yes | cannot distinguish "system" from "unknown". |
| `attendances.session_id` | yes | so attendance can exist with no session, and vice versa. |
| `winnings.position` | NOT NULL, `CHECK (position > 0)` | correct. |
| `slot_expenses.rate`/`total` | NOT NULL | correct, but no `CHECK (rate >= 0)` / `CHECK (total >= 0)`. |
| `communication_settings.team_id` | yes (means "global") | **`NULL` used as a sentinel**, which interacts badly with `UNIQUE(team_id, setting_key)` (Postgres `UNIQUE` treats NULLs as distinct) and with `upsert(onConflict:)` (which cannot match a NULL key). See `13_RLS_SECURITY.md` F-RLS-12. |
| `discord_webhooks.team_id` | yes (means "org-wide") | same sentinel problem, plus it is the mechanism for the F-RLS-02 privilege escalation. |
| `holidays.team_id` | yes | mixes global and team holidays in one table with no discriminator. |

**Finding — a NOT NULL divergence between the schema and the hand-written TypeScript types.**
*Evidence:* `scripts/00-complete-schema-setup.sql:156` declares `player_id uuid` (nullable);
`lib/supabase.ts:239` declares `player_id: string` in `Row` and `player_id: string` in `Insert`.
*Impact:* the type layer will let application code compile against an assumption the database
does not guarantee, and there is no generated-type check to catch it. Every one of the 14 tables
missing from the `Database` type compounds this.
*Severity:* **MEDIUM** · *Confidence:* **HIGH*
*Recommendation:* generate types from the migration ledger; add a CI check that
`supabase gen types` output matches the committed types.

---

## 4. Uniqueness

| Missing constraint | Consequence | Evidence |
| --- | --- | --- |
| `users.discord_id` | duplicate linkage; the tryout workflow's applicant de-duplication (`app/api/discord/tryout/apply:82-87`) uses it | `scripts/00:60` |
| `users.bgmi_id` | duplicate game identities across accounts — an integrity problem in a competitive context | `scripts/00:71` |
| `users(lower(email))` | `email` is `UNIQUE` but Postgres `UNIQUE` is case-sensitive, so `A@x.com` and `a@x.com` can both exist while GoTrue treats emails case-insensitively | `scripts/00:41` |
| `teams.name` | duplicate team names | `scripts/00:30` |
| `rosters(team_id, user_id)` | the same member can be rostered repeatedly | `scripts/00:347-358` |
| `attendances(player_id, date, session_time)` or `(player_id, session_id)` | **duplicate attendance rows are structurally allowed** — the direct cause of the fix-script backlog (`scripts/16-fix-auto-attendance-null-date.sql:55-96`, `scripts/18-fix-multiple-performances-per-slot.sql`) | `scripts/00:242-260` |
| `performances(player_id, match_number, slot_id)` | duplicate performance submissions — the direct cause of `scripts/18-fix-multiple-performances-per-slot.sql` | `scripts/00:153-171` |
| `tryout_invitations(tryout_id, application_id)` | the API checks for an existing invitation (`app/api/discord/tryout/invite:83-88`) but nothing prevents a race from creating two | `SUPABASE_TRYOUTS_SETUP_FIXED:63-81` |
| `tryout_evaluations(invitation_id, evaluator_id)` | duplicate evaluations from the same scorer | `SUPABASE_TRYOUTS_SETUP_FIXED:109-147` |
| `tryout_applications` per applicant | no stable applicant identity at all (F-REL-08) | `SUPABASE_TRYOUTS_SETUP_FIXED:35-60` |
| `tryout_selections(tryout_id, application_id)` | duplicate outcomes | `SUPABASE_TRYOUTS_SETUP_FIXED:150-185` |
| `discord_servers.guild_id` | ✅ `UNIQUE` (the only correct uniqueness constraint in the schema) | `scripts/00:367` |
| `discord_users.discord_id` | ✅ `UNIQUE` | `scripts/00:381` |
| `tier_defaults.tier` | ✅ `UNIQUE` | `scripts/00:211` |
| `user_agreements(user_id, role)` | **no UNIQUE**, yet the API upserts with `onConflict: 'user_id,role'` (`app/api/agreements:116-118`) — **the upsert will fail** unless the constraint was added out-of-band | `scripts/00:117-130` |
| `profiles.user_id` | ✅ `UNIQUE` | `scripts/00:97` |
| `users.email` | ✅ `UNIQUE` | `scripts/00:41` |
| `communication_settings(team_id, setting_key)` | ⚠ `UNIQUE` present but NULL-unsafe | `complete-discord-portal-setup.sql:59` |

**Finding — the agreement upsert depends on a constraint that the schema does not define.**
*Evidence:* `app/api/agreements/route.ts:105-120` performs
`.upsert({…}, { onConflict: 'user_id,role' })` on `user_agreements`; `scripts/00:117-130` defines
no `UNIQUE(user_id, role)`. `database/AGREEMENT_ENFORCEMENT_SETUP.sql:54-58` contains an
`ALTER TABLE public.user_agreements` statement that may add it, but this cannot be confirmed
without the deployed schema.
*Impact:* `POST /api/agreements` returns `500 Failed to save agreement`, which means
`authFlowV2.acceptAgreement()` returns `false` and the user is trapped in a redirect loop at
`/agreement-review`.
*Severity:* **HIGH** (if the constraint is absent) · *Confidence:* **MEDIUM**
*Recommendation:* define the constraint in the migration ledger and cover it with a test.

---

## 5. Indexes

| Table | Indexes present | Assessment |
| --- | --- | --- |
| `users` | `(team_id, role)`, `(role, status)`, `(email)` | reasonable; missing `discord_id`, `onboarding_completed`, `lower(email)` |
| `teams` | `coach_id`, `status` | adequate; missing `UNIQUE(name)` |
| `performances` | `(team_id, created_at)`, `(player_id, match_number)`, `slot_id` (`scripts/17:269`) | good; **missing `(player_id, created_at DESC)`** and `(map)` — both used by `GET /api/performances` filters |
| `attendances` | `slot_id` (`scripts/11:27`, `scripts/17:271`) | **critically incomplete** — no index on `(team_id, created_at)` or `(player_id, date)`, which are the filters used by `GET /api/attendances` (`app/api/attendances:50-71`) |
| `sessions` | `(team_id, date)` | good; missing `(date)` for the "today's sessions" query at `app/api/sessions:66` |
| `slots` | `team_id`, plus per-script additions | adequate |
| `slot_expenses` | `slot_id`, `team_id` | adequate |
| `winnings` | `slot_id`, `team_id` | adequate |
| `rosters` | `team_id`, `user_id` (implicit via FK? no — FKs do **not** create indexes in Postgres) | **missing** explicit indexes; only `scripts/00:463-464` indexes `profiles.user_id` |
| `tier_defaults` | `tier UNIQUE` | fine |
| `discord_webhooks` | `team_id`, `type`, `active`, `channel_name` | good |
| `communication_logs` | `team_id`, `message_type`, `status`, `timestamp`, `webhook_id` | good |
| `communication_settings` | `team_id`, `setting_key` | good |
| `tryouts` | `status`, `created_by` | missing `guild_id`, `application_deadline` |
| `tryout_applications` | `tryout_id`, `status` | **missing `discord_id`** — the exact column the Discord status endpoint filters on (`app/api/discord/tryout/status:40`) |
| `tryout_invitations` / `tryout_sessions` / `tryout_evaluations` / `tryout_selections` | `tryout_id` only | missing `application_id`, `invitation_id` (used by `app/api/discord/tryout/invite:86-87`, `evaluate:97-99`) |
| `discord_servers` | `guild_id`, `connected_team_id` | good |
| `discord_users` | `discord_id`, `user_id`, `guild_id` | good |
| `performance_records` | `discord_id`, `team_id`, `created_at` | good |
| `bot_attendance` | `discord_id`, `session_id` | good |

**Finding — `README.md:134-157` tells operators to create indexes by hand in the Supabase SQL
editor, which means the indexes are not in any migration and will be lost on environment
rebuild.** The README's own index list (`idx_performances_created_at`,
`idx_performances_team_id_created`, `idx_performances_player_id_created`,
`idx_attendances_team_id_created`, `idx_attendances_created_at`, `idx_slot_expenses_team_id_created`,
`idx_winnings_team_id_created`, `idx_teams_status`, `idx_users_role`) is **not** created by any
SQL file in the repository.
*Severity:* **MEDIUM** · *Confidence:* **HIGH*
*Recommendation:* indexes belong in migrations, reviewed by `EXPLAIN`, with a slow-query budget.

---

## 6. Foreign keys and cascading — summary

* **34 foreign keys** are declared across the schema.
* **12+ have no `ON DELETE` clause** (see `12_DATABASE_RELATIONSHIPS.md` F-REL-07) ⇒ `NO ACTION`
  ⇒ user/team deletion will fail unpredictably.
* **Two FK definitions conflict for the same column**: `attendances.slot_id` is `NO ACTION`
  (`scripts/11:17`), `SET NULL` (`scripts/11:17` in another revision) and `CASCADE`
  (`scripts/16:11-17`, `scripts/17:100-105`); `communication_logs.webhook_id` is
  `ON DELETE SET NULL` in `complete-discord-portal-setup.sql:44` and unset in `scripts/00:325`.
* **`ON DELETE CASCADE` from `users` to `performances`, `attendances`, `rosters`,
  `user_agreements`** means deleting a person destroys competitive and legal history. For an
  esports organisation this is unacceptable: results and contract acceptances are records that
  must survive.
* **No `DEFERRABLE` constraints and no `EXCLUDE` constraints** — so overlapping team membership
  periods and double-booked tournament slots cannot be prevented at the database level.

---

## 7. Data integrity gaps

| Gap | Consequence | Severity |
| --- | --- | --- |
| `map` is free text with no reference table | analytics group by string; "Erangel" ≠ "erangel" | MEDIUM |
| `performances.match_number` is a bare integer with no `match` entity | there is no opponent, no result, no bracket, no series; "match 3" is meaningless across teams | **HIGH** |
| `slot_rate` has no currency | the org's currency is implicit; the UI hardcodes ₹ | MEDIUM |
| All money is `integer` | no minor units, no decimals, no negative amounts | MEDIUM |
| `prize_pools.breakdown jsonb` duplicates `winnings` | two sources of truth for prize allocation | MEDIUM |
| `users.sensitivity_settings/game_stats/achievements/social_links jsonb` with no `CHECK (jsonb_typeof(...))` | malformed JSON shapes accepted; no schema for a player's game profile | MEDIUM |
| `user_agreements.agreement_version` has no FK to a version registry | the "current" version lives in TypeScript (`lib/agreement-versions.ts`) and in `admin_config` — **three** sources of truth | MEDIUM |
| `discord_webhooks.hook_url` has no validation CHECK | a malformed URL is storable; the regex is only applied in one code path (`app/api/discord-portal/webhooks:276-281`) | MEDIUM |
| No `CHECK` on `kills >= 0`, `assists >= 0`, `damage >= 0`, `placement > 0` in `performances` | the API validates non-negativity in application code only; a direct PostgREST write (which the anon key permits wherever RLS is missing) can insert nonsense | MEDIUM |
| `bot_attendance.duration interval` vs `performances.survival_time double precision` vs `attendances.session_time text` | three incompatible time representations | MEDIUM |
| `is_final` on `tryout_evaluations` with no constraint that only one final evaluation exists per invitation | multiple "final" evaluations are possible | LOW |
| `tryout_evaluations.overall_score` computed in application code (`app/api/discord/tryout/evaluate:88-91`) rather than generated | can disagree with its four components; a direct DB write can set any value | MEDIUM |

---

## 8. Race conditions and concurrency

| Race | Where | Consequence | Severity |
| --- | --- | --- | --- |
| Check-then-insert on tryout application | `app/api/discord/tryout/apply:82-97` — `.single()` on existing application, then `.insert()`. No unique constraint backs it. | duplicate applications | MEDIUM |
| Check-then-insert on tryout invitation | `app/api/discord/tryout/invite:83-114` | duplicate invitations | MEDIUM |
| Check-then-insert on tryout evaluation | `app/api/discord/tryout/evaluate:94-158` | duplicate evaluations; last write wins | MEDIUM |
| Concurrent attendance marking | `POST /api/attendances` with no unique constraint | duplicate/conflicting attendance rows; the trigger and the API can both insert | **HIGH** |
| Concurrent performance submission | `POST /api/performances` with no unique constraint | duplicate rows; the repo has a script literally named for this | **HIGH** |
| Concurrent team-membership edit | `users.team_id` and `rosters` written independently | divergence between the two sources of truth | **HIGH** |
| Slot oversell | `slots.number_of_slots` is not decremented atomically anywhere; there is no booking entity | the same slot can be "sold" N times | **HIGH** |
| Expense recalculation | `slot_expenses.total` is stored and recomputed by a trigger with no locking | drift under concurrent slot updates | MEDIUM |
| Bulk purge | `app/api/admin/settings:116-119` — seven sequential `DELETE`s with no transaction | a partial purge leaves the database inconsistent **and reports success** | **HIGH** |
| `overall_score` derived | `app/api/discord/tryout/evaluate:88-91` — computed in the client of the RPC | not atomic with the insert | LOW |
| No optimistic concurrency anywhere | no `version`, `updated_at` comparison, or `WHERE … updated_at = ?` on any update | last-write-wins on all edits, including role changes and agreement acceptance | **HIGH** |

**Finding — there is no optimistic concurrency control anywhere in the system.**
*Evidence:* no `version` column, no `If-Match`/ETag handling, no `updated_at` predicate in any
`.update()` call. `lib/cache-manager.ts` (10,717 B) and `lib/optimized-data-service.ts` (12,200 B)
implement caching but no invalidation-on-write contract is documented or tested.
*Impact:* two staff editing the same session, the same slot rate, or the same player's profile
silently overwrite each other. Combined with `createSuccessResponse` returning the updated row,
the second writer believes their change stuck.
*Severity:* **HIGH** · *Confidence:* **HIGH*
*Recommendation:* `version int` on every mutable table; all updates carry `WHERE id = ? AND
version = ?`; conflicts return `409` with a diff.

---

## 9. Database quality verdict

| Dimension | Score (out of 5) | Note |
| --- | --- | --- |
| Normalisation | 1.5 | person data split three ways; membership stored twice |
| Naming | 3 | consistent FK naming, but `status` and `discord_id` are overloaded |
| Nullability | 2.5 | `NULL` used as a scope sentinel; no NOT NULL on integrity-critical columns |
| Uniqueness | 1.5 | 15 missing constraints, several of which have caused real bugs |
| Indexes | 2 | half the hot-path indexes exist only as README instructions |
| Foreign keys | 2.5 | 34 declared, 12+ with undefined `ON DELETE`, 2 conflicting |
| Data integrity | 2 | no CHECKs on numeric ranges, no reference tables for `map`/`tier` |
| Concurrency | 1 | no unique constraints to prevent duplicates, no optimistic locking, no transactions |
| Auditability | 1 | no `updated_by`, no change history, no soft delete in use |
| Migrations | 1 | 51 loose SQL files, no ledger, duplicate names, order-dependent |
| **Overall** | **~1.8** | The schema is a **requirements trace**, not an engineered data model. |

**Recommendation for V2:** do not repair this schema. Extract the *semantics* listed in
`11_DATABASE.md` §5 and `12_DATABASE_RELATIONSHIPS.md` §5, then design a new schema with
`organizations` as the tenant root, effective-dated relationships, generated types, a
migration ledger, explicit `ON DELETE` everywhere, and no hard deletes of people or
competitive records.
