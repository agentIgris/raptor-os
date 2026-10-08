# 12 — DATABASE RELATIONSHIP MAP

**Audit.md section:** 17 (SECTION 14 — DATABASE RELATIONSHIP MAP)
Diagram: `AUDIT/diagrams/erd.mmd` (Mermaid) and `AUDIT/diagrams/erd.txt` (ASCII).

---

## 1. Entity-relationship diagram

```
                        ┌──────────────────────┐
                        │      auth.users      │  (GoTrue / Supabase Auth)
                        └──────────┬───────────┘
                                   │ 1:1  ON DELETE CASCADE
                        ┌──────────▼───────────┐        ┌──────────────────────┐
                        │       users          │◄───────┤      profiles       │  LEGACY DUPLICATE
                        │  (62 columns, PII,   │  1:1   │  (bio, full_name,    │  of users
                        │   BGMI telemetry)    │        │   display_name, …)   │
                        └──┬────┬────┬────┬────┘        └──────────────────────┘
             1:N          │    │    │    │            1:1 via user_id
        ┌──────────────────┘    │    │    └──────────────────┐
        │                       │    │                       │
        │ 1:N                   │ 1:N│ 1:N                   │ 1:N
 ┌──────▼───────┐        ┌───────▼┐ ┌▼─────────┐   ┌─────────▼────────┐
 │    teams     │        │rosters │ │  slots   │   │ user_agreements  │
 │ name, tier,  │        │(member)│ │(purchase)│   │(user_id, role,   │
 │ coach_id ────┼───►users│ +PII   │ └────┬────┘   │ version, ip, ua) │
 │ status       │        └───┬────┘      │         └──────────────────┘
 └──┬──┬──┬────┘            │           │ 1:N
    │  │  │                 │           ├──────────────┐
    │  │  │ 1:N (teams.team_id)          │ 1:N          │ 1:1
    │  │  ├──────────────┐   ┌──────────▼──────────┐  ┌▼──────────────────┐
    │  │  │              │   │    slot_expenses    │  │    prize_pools    │
    │  │  │  ┌───────────▼┐  │ rate × n_slots      │  │ total, breakdown  │
    │  │  │  │performance│  └─────────────────────┘  └───────────────────┘
    │  │  │  │  s         │        ┌──────────────┐
    │  │  │  └─────┬─────┘        │   winnings   │
    │  │  │        │              │ position,    │
    │  │  │        │ players      │ amount_won   │
    │  │  │  ┌─────▼──────┐       └──────────────┘
    │  │  │  │  sessions  │◄── created_by(user)
    │  │  │  │ type,date, │       ┌──────────────┐
    │  │  │  │ start/end/ │◄──────│  attendances │
    │  │  │  │ cutoff     │  1:N  │ player_id,   │
    │  │  │  └─────┬──────┘       │ team_id,date,│
    │  │  │        │ 1:N          │ session_time,│
    │  │  │  ┌─────▼──────────┐   │ status,      │
    │  │  │  │practice_session│   │ marked_by,   │
    │  │  │  │_config (NO RLS)│   │ slot_id,     │
    │  │  │  │ Morning/Eve/   │   │ session_id,  │
    │  │  │  │ Night +cutoff │   │ source       │
    │  │  │  └────────────────┘   └──────────────┘
    │  │  │
    │  │  └──────────► team_monthly_stats (rollup, RLS on)
    │  │
    │  └────────────► holidays (team_id nullable)
    │
    ├──► tier_defaults          (global rate card: God/T1..T4 → slot_rate)
    ├──► discord_webhooks       (team_id NULLABLE = org-wide; hook_url = CREDENTIAL)
    │        │ 1:N
    │        ▼
    │   communication_logs      (webhook_id, team_id, payload, status, triggered_by)
    │
    ├──► communication_settings (team_id NULLABLE = global; UNIQUE(team_id,setting_key))
    │
    └──► tryouts.team_ids uuid[] ──(ARRAY, no FK, no join table)──► teams
                │
                │ 1:N
      ┌─────────▼──────────────┐
      │      tryouts           │ purpose, target_roles uuid[]/text[],
      │ name, purpose, mode,   │ type, deadline, evaluation_method,
      │ type, status, guild_id │ open_to_public, launched_at, closed_at
      └─────────┬──────────────┘
                │ 1:N (all ON DELETE CASCADE)
   ┌────────────┼─────────────┬──────────────────┐
   ▼            ▼             ▼                  ▼
┌──────────────────┐ ┌──────────────────┐ ┌────────────────────┐
│tryout_           │ │tryout_invitations│ │tryout_sessions     │
│applications      │◄┤ application_id   │ │ invitation_id,     │
│ full_name, ign,  │ │ status, temp     │ │ session_id,        │
│ discord_tag,     │ │ access, expires  │ │ session_type,      │
│ availability[],  │ └────────┬─────────┘ │ goals, attendance  │
│ highlights[],    │          │ 1:N       └─────────┬──────────┘
│ contact_email,   │          │                     │ 1:N
│ contact_phone,   │          │                     ▼
│ status, PHASE,   │          │           ┌────────────────────┐
│ ip, ua, source   │          └──────────►│tryout_evaluations   │
└────────┬─────────┘                      │ kills/assists/dmg, │
         │                                │ 4× score CHECK 1-10│
         │ 1:N                            │ overall_score,     │
         └───────────────────────────────►│ recommendation     │
                                          │ CHECK(5), is_final │
                                          └────────────────────┘
                                                   │
                                                   │ (no FK — logical only)
                                                   ▼
                                          ┌────────────────────┐
                                          │ tryout_selections  │
                                          │ selected/rejected, │
                                          │ assigned_team_id ──┼──► teams
                                          │ new_team_name/tier,│
                                          │ notification flags │
                                          └────────────────────┘

  ORPHANED / UNUSED (created, RLS-enabled, never read or written by the app):
  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────────┐  ┌──────────────────┐
  │ discord_servers  │  │  discord_users   │  │performance_records│  │ bot_attendance   │
  │ guild_id ↔       │  │ discord_id ↔     │  │ match_id, map_name │  │ voice_join/leave │
  │ connected_team_id│  │ user_id ↔        │  │ game_mode,        │  │ duration         │
  │ features jsonb   │  │ guild_id         │  │ processed bool    │  │                  │
  └──────────────────┘  └──────────────────┘  └────────────────────┘  └──────────────────┘

  NO RLS (created, used by the app, unprotected):
  ┌──────────────────┐  ┌──────────────────────┐  ┌──────────────────────────┐
  │  admin_config    │  │ practice_session_cfg  │  │ module_permissions (dead)│
  │ key → value      │  │ (see above)           │  │ role × module            │
  │ legal text,      │  │                       │  │                          │
  │ webhook id       │  │                       │  │                          │
  └──────────────────┘  └──────────────────────┘  └──────────────────────────┘
```

---

## 2. Cardinality catalogue

| Relationship | Cardinality | FK behaviour | Assessment |
| --- | --- | --- | --- |
| `auth.users` → `users` | 1:1 | `ON DELETE CASCADE` | correct |
| `users` → `profiles` | 1:1 | `profiles.user_id → auth.users(id) ON DELETE CASCADE` | **Redundant duplicate** of `users`; `lib/auth-flow-v2:309-317` reads it only as a fallback |
| `users.team_id` → `teams` | N:1 | `ON DELETE` unspecified (`scripts/00:90`) ⇒ NO ACTION | **Deleting a team with members fails or orphans** |
| `teams.coach_id` → `users` | N:1 | `ON DELETE SET NULL` (`scripts/00:443-444`) | correct; trigger `validate_coach_assignment` enforces the role |
| `users` → `rosters` | 1:N | `ON DELETE CASCADE` | **Duplicates `users.team_id`** — the same fact stored twice with no consistency constraint |
| `rosters` → `teams` | N:1 | `ON DELETE CASCADE` | |
| `users` → `performances` (as player) | 1:N | `ON DELETE CASCADE` | **Destroys performance history when a player is deleted** — unacceptable for a record-keeping system |
| `users` → `performances` (as `added_by`) | 1:N | **no ON DELETE** ⇒ NO ACTION | **Blocks user deletion** |
| `slots` → `teams` | N:1 | `ON DELETE CASCADE` | |
| `slots` → `slot_expenses` | 1:N | `ON DELETE CASCADE` | |
| `slots` → `winnings` | 1:N | `ON DELETE CASCADE` | |
| `slots` → `prize_pools` | 1:N | `ON DELETE CASCADE` | |
| `slots` → `performances` (via `slot_id`) | 1:N | added by `scripts/14:22-24`; later flipped to `SET NULL` (`scripts/17:88-91`) | **Flipped between scripts**; the two `slot`/`slot_id` columns make the real relationship ambiguous |
| `slots` → `attendances` (via `slot_id`) | 1:N | flipped `NO ACTION` → `SET NULL` → `CASCADE` across `scripts/11:17`, `scripts/16:11-17`, `scripts/17:100-105` | **Non-deterministic** |
| `sessions` → `attendances` | 1:N | **no ON DELETE** ⇒ NO ACTION | |
| `users` → `attendances` (as `marked_by`) | 1:N | **no ON DELETE** ⇒ NO ACTION | audit attribution blocks deletion |
| `users` → `sessions` (as `created_by`) | 1:N | **no ON DELETE** ⇒ NO ACTION | |
| `users` → `holidays` (as `created_by`) | 1:N | **no ON DELETE** ⇒ NO ACTION | |
| `users` → `discord_webhooks` (as `created_by`) | 1:N | **no ON DELETE** ⇒ NO ACTION | |
| `users` → `communication_logs` (as `triggered_by`) | 1:N | `ON DELETE SET NULL` | correct |
| `users` → `communication_settings` (as `updated_by`) | 1:N | **no ON DELETE** ⇒ NO ACTION | |
| `users` → `user_agreements` | 1:N | `ON DELETE CASCADE` | destroys legal acceptance evidence |
| `discord_webhooks` → `communication_logs` | 1:N | `ON DELETE SET NULL` (in `complete-discord-portal-setup.sql:44`) vs **no ON DELETE** (in `scripts/00:325`) | **Two definitions conflict** |
| `tryouts` → `tryout_applications` | 1:N | `ON DELETE CASCADE` | correct |
| `tryout_applications` → `tryout_invitations` | 1:1 | `ON DELETE CASCADE` | no UNIQUE ⇒ duplicates possible |
| `tryout_invitations` → `tryout_sessions` | 1:N | `ON DELETE CASCADE` | |
| `tryout_sessions` → `tryout_evaluations` | 1:N | **no ON DELETE** | |
| `tryout_evaluations` → `users` (evaluator) | N:1 | **no ON DELETE** | |
| `tryout_selections.assigned_team_id` → `teams` | N:1 | **no ON DELETE** | |
| `discord_servers.guild_id` ← `discord_users.guild_id`, `performance_records.guild_id`, `bot_attendance.guild_id` | 1:N | FK to a **non-PK unique column** (`discord_servers.guild_id text UNIQUE`) | Legal but fragile; requires the referenced column to stay unique |
| `sessions` ← `tryout_sessions.session_id` | 1:1 | **no ON DELETE** | A tryout evaluation session reuses a training session row — **entity conflation** (see finding below) |
| `tryouts.team_ids uuid[]` | N:M via array | **no FK** | Dangling team ids possible; no referential integrity; cannot be joined or indexed efficiently |

---

## 3. Structural findings

### F-REL-01 — HIGH: team membership is stored twice with no consistency constraint
*Evidence:* `users.team_id uuid → teams(id)` (`scripts/00:44, 90`) **and**
`rosters(team_id uuid, user_id uuid)` (`scripts/00:347-358`).
There is no trigger, no constraint, and no unique index reconciling them. `rosters` also has
**no `UNIQUE(team_id, user_id)`**, so the same member can be inserted into a roster repeatedly.
*Evidence of divergence in the app:* `app/api/rosters/route.ts` manages `rosters`, while
`app/api/performances/route.ts:102-108`, `app/api/sessions/route.ts:71-75` and
`app/api/attendances/route.ts:60-64` all scope by `user.team_id`. A user moved via one path is
invisible to the other.
*Impact:* a player can appear on two rosters, or on none while `users.team_id` says otherwise;
team-scoped authorisation silently changes meaning. This is the kind of defect that produces
"the player shows up in the wrong team's attendance" bugs.
*Severity:* **HIGH** · *Confidence:* **HIGH*
*Recommendation:* one membership entity (`team_memberships`) with `UNIQUE(person_id, team_id,
valid_from)`, effective-dated, and every scope check reads from it.

### F-REL-02 — HIGH: a hard team delete cascades away performance and attendance history
*Evidence:* `DELETE /api/teams/manage` deletes the `teams` row; `ON DELETE CASCADE` from
`teams` applies to `performances.team_id`, `attendances.team_id`, `rosters.team_id`,
`sessions.team_id`, `slots.team_id`, `slot_expenses.team_id`, `winnings.team_id`,
`user_agreements` (via users), and transitively `prize_pools` via `slots`.
*Evidence of intent to soft-delete:* `scripts/13-comprehensive-database-fixes.sql:37-48` adds
`teams.archived_at` and `teams.deleted_at` — **but no application code ever sets or filters on
them** (`rg "archived_at|deleted_at"` → no application usage).
*Impact:* one accidental or malicious team deletion irreversibly destroys competitive results,
attendance records and financial records, with no confirmation dialog, no audit record and no
backup guarantee.
*Severity:* **HIGH** · *Confidence:* **HIGH*
*Recommendation:* implement the soft delete that was already designed, make archive the default
mutation, and require an explicit, audited, two-person "hard delete" that produces a
tamper-evident export first.

### F-REL-03 — HIGH: the `slot` / `slot_id` duality makes the performances↔slots relationship ambiguous
*Evidence:* `performances.slot uuid` with **no FK** (`scripts/00:166`); `performances.slot_id
uuid → slots(id)` added later (`scripts/14:11-12`); `scripts/19-fix-slot-field-constraint.sql:50-54`
then declares `slot` to be a *legacy integer* field and makes it nullable; `scripts/17:50-71`
migrates values; `automation-scripts/01:122` joins `winnings w ON w.slot_id = p.slot` — i.e. it
joins a **UUID slot_id column against a legacy integer column**. The application writes
`slot_id: finalSlotId, slot: null` (`app/api/performances:278-279`).
*Impact:* the join in `get_team_performance_summary` can never match; the analytics that
attribute winnings to performances are silently empty; four different scripts disagree about
which column is authoritative.
*Severity:* **HIGH** · *Confidence:* **HIGH**
*Recommendation:* exactly one `slot_id` FK, no legacy column, plus a data migration that
resolves or discards legacy values.

### F-REL-04 — MEDIUM: `sessions` is overloaded — training sessions and tryout evaluation sessions are the same entity
*Evidence:* `tryout_sessions.session_id uuid → sessions(id)` (`database/SUPABASE_TRYOUTS_SETUP_FIXED.sql:104`),
while `tryout_sessions` **also** carries its own `session_type`, `session_title`,
`session_description`, `scheduled_date`, `start_time`, `end_time` (`:89-95`).
*Impact:* a tryout evaluation session can exist either as a `tryout_sessions` row alone or as a
pair (`tryout_sessions` + `sessions`) with **duplicated scheduling fields that can disagree**.
`app/api/discord/tryout/list` and `status` read only the `tryout_sessions` copy, while
attendance and the daily-practice generator read only `sessions`. A candidate marked present
against one row will not appear against the other.
*Severity:* **MEDIUM** · *Confidence:* **HIGH*
*Recommendation:* one `sessions` entity with a `kind` discriminator (`training | scrim |
tournament | meeting | tryout_evaluation`) and a nullable `parent_session_id` for the
parent/child relationship.

### F-REL-05 — MEDIUM: many-to-many relationships modelled as arrays
*Evidence:* `tryouts.team_ids uuid[]` (`SUPABASE_TRYOUTS_SETUP_FIXED.sql:16`),
`tryouts.target_roles text[]` (`:15`),
`tryout_applications.availability text[]` (`:43`),
`tryout_applications.highlights_links text[]` (`:44`),
`tryouts.additional_links jsonb` (`:21`),
`users.sensitivity_settings jsonb`, `users.game_stats jsonb`, `users.achievements jsonb`,
`users.social_links jsonb`, `prize_pools.breakdown jsonb`,
`discord_servers.features jsonb`, `performance_records.metadata jsonb`,
`bot_attendance.metadata jsonb`.
*Impact:* array columns cannot be constrained, cannot be joined, cannot be foreign-keyed, and
cannot be indexed without a GIN index or an expression index — none of which exist. `team_ids`
in particular has **no referential integrity**, so deleting a team leaves dangling ids inside a
tryout row, and there is no way to ask "which tryouts target this team?" efficiently.
*Severity:* **MEDIUM** · *Confidence:* **HIGH*
*Recommendation:* join tables for relationships (`tryout_teams`), reference tables for
controlled vocabularies (`game_roles`, `maps`, `games`), and JSONB only for genuinely open
structures — with a documented schema and a `CHECK (jsonb_typeof(...) = 'object')`.

### F-REL-06 — MEDIUM: circular and redundant reference paths make "who is this person's manager?" unanswerable
*Evidence:* coach linkage exists in **three** places: `teams.coach_id` (a coach per team),
`users.team_id` (a single team per user), and `users.role` (a user has exactly one role).
There is no reporting-line entity, so a person who coaches Team A and manages Team B cannot be
represented, and a head of esports who coaches nobody cannot be represented either.
*Impact:* the model cannot express the organisational structures the target product requires
(managers of managers, a Head of Esports, a department). This is the single biggest structural
gap between the legacy schema and an "esports organization OS".
*Severity:* **MEDIUM** (design) / **HIGH** (for the SaaS goal) · *Confidence:* **HIGH*
*Recommendation:* separate identity, employment and role-assignment (see `62_PEOPLE_MODEL.md`
and `63_ROLE_MODEL.md`).

### F-REL-07 — MEDIUM: `ON DELETE` behaviour is undefined on 12 foreign keys
*Evidence:* columns with an FK but no `ON DELETE` clause:
`users.team_id` (`scripts/00:90`), `performances.added_by` (`:169`),
`sessions.created_by` (`:238`), `attendances.marked_by` (`:258`), `attendances.session_id`
(`:259`), `holidays.created_by` (`:273`), `holidays.team_id` (`:272`),
`discord_webhooks.created_by` (`:307`), `discord_webhooks.team_id` (`:308`),
`communication_settings.updated_by` (`:339`),
`tryout_applications.screened_by` (`SUPABASE_TRYOUTS_SETUP_FIXED:59`),
`tryout_sessions.session_id` (`:104`), `tryout_sessions.created_by` (`:105`),
`tryout_evaluations.session_id` (`:145`), `tryout_evaluations.evaluator_id` (`:146`),
`tryout_selections.selected_by` (`:183`), `tryout_selections.assigned_team_id` (`:184`).
*Impact:* the default is `NO ACTION`, so **deleting a user who has ever been referenced will
fail** with an FK violation — or, worse, succeed for some tables and fail for others,
producing unpredictable partial deletions. There is no user-deletion feature at all, so this is
latent, but it means "delete a user" cannot be implemented safely without a data-retention
policy.
*Severity:* **MEDIUM** · *Confidence:* **HIGH*
*Recommendation:* every FK gets an explicit `ON DELETE`; people are never hard-deleted (see
`50_DATA_RETENTION.md`).

### F-REL-08 — LOW/MEDIUM: `tryout_applications` has no stable applicant identity
*Evidence:* applications are keyed on `tryout_id` + a free-text `discord_id` / `contact_email`.
There is no `person_id`, no applicant account, and no unique constraint beyond the application
code's own `.single()` check (`app/api/discord/tryout/apply:82-87`).
*Impact:* the same human can apply many times with different Discord accounts or email
addresses; de-duplication is manual; and GDPR erasure of an applicant requires searching free
text across two columns. In V2 an applicant must be a first-class (pseudonymous) identity.
*Severity:* **MEDIUM** · *Confidence:* **HIGH*

### F-REL-09 — MEDIUM: a tryout can target teams the organisation no longer has, and a team's roster has no temporal record
*Evidence:* `rosters` has only `created_at` — **no `ended_at`, no `valid_from`/`valid_to`**;
`users.team_id` is a single current value; `users.status` has `'Benched' | 'On Leave' |
'Discontinued'` but nothing links a status change to a date.
*Impact:* "who was on Team A on 12 March?" is unanswerable. Player history, contract periods,
eligibility for a tournament at a past date, and prize-money allocation by period are all
impossible. This is a **fundamental** gap for an esports organisation, where roster history is
a competitive-integrity record.
*Severity:* **HIGH** (for the SaaS goal) · *Confidence:* **HIGH*
*Recommendation: ** effective-dated `team_memberships(person_id, team_id, role_in_team,
valid_from, valid_to, ended_reason)`; never overwrite a current-state column where history
matters.

---

## 4. Orphanable and circular records

| Record | Orphan risk | Cause |
| --- | --- | --- |
| `users.team_id` | points to a deleted team | no `ON DELETE`, no soft delete |
| `performances.slot_id` | dangling after a slot delete | FK added then flipped to `SET NULL` |
| `performances.added_by` | dangling if a user is removed | no `ON DELETE` |
| `attendances.session_id` / `marked_by` | dangling | no `ON DELETE` |
| `tryout_applications.tryout_id` | none (CASCADE) | |
| `tryout_selections.assigned_team_id` | dangling | no `ON DELETE` |
| `discord_users.guild_id` | dangling if a guild row is removed | FK to a UNIQUE non-PK column |
| `users` in general | an auth user with no `users` row | **happens whenever sign-up profile creation fails** (see `09_AUTHENTICATION.md` F-AUTH-02) — a real, reachable orphan |
| `holidays` | `team_id` nullable ⇒ global holidays mixed with team holidays in one table, with no discriminator | `scripts/00:263` |
| Circular: `users` ↔ `teams` | `users.team_id → teams.id` **and** `teams.coach_id → users.id` | Inserting a team requires an existing coach; inserting a coach with a `team_id` requires an existing team. A bootstrap/seed procedure is required and none is documented. |

---

## 5. Migration-relevant data assets

| Asset | Migration verdict | Notes |
| --- | --- | --- |
| `users` identity + contact + status + team | **MIGRATE** (as a seed `Person` + `Employment`) | Requires de-duplication of `users` ↔ `profiles`, resolution of triple name fields, and a decision on `users.team_id` vs `rosters` |
| `teams` | **MIGRATE** (as `Organization > Division > Team`) | `tier` is org-specific vocabulary, not a V2 concept |
| `performances` | **MIGRATE** (historical) | Requires `slot`/`slot_id` resolution and a `match`/`game`/`map` model that does not exist yet |
| `attendances` + `sessions` + `holidays` + `practice_session_config` | **MIGRATE** (historical) | `session_time text` must be normalised; duplicates must be reconciled |
| `slots` / `slot_expenses` / `winnings` / `prize_pools` | **MIGRATE (historical), REBUILD (schema)** | Becomes `Competition` + `Entry` + `Registration` + `PrizePayout` |
| `tier_defaults` | **ARCHIVE** | BGMI-tier-specific rate card |
| `tryouts` family (6 tables) | **MIGRATE (model + data)** | Best asset in the schema |
| `user_agreements` | **MIGRATE as evidence**, re-consent in V2 | Cannot be carried as a live compliance record across a new legal basis |
| `discord_webhooks` | **DO NOT MIGRATE the URLs** — rotate | Credentials must be assumed exposed |
| `communication_logs` | **ARCHIVE** | Forgeable (F-RLS-03), so low evidentiary value |
| `admin_config.agreement_content_*` | **MIGRATE as documents, re-publish under V2's legal basis** | Currently world-writable (F-RLS-04) |
| `profiles` | **ARCHIVE** | Duplicate of `users` |
| `performance_records`, `bot_attendance`, `discord_servers` | **ARCHIVE** | Unused |
| `module_permissions`, `team_monthly_stats`, `attendance_debug_log` | **ARCHIVE / REBUILD** | Dead, derived, and debug |
