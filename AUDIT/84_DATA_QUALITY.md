# 84 - LEGACY DATA QUALITY (assessment)
**Audit.md section:** 91 (SECTION 88)

## 1. Confidence statement
This assessment is derived from **schema and code analysis**, not from querying a live database.
Row counts, duplicate frequencies and null rates are therefore **UNKNOWN** and must be measured
by the Phase 0 assessment script in `83_DATA_MIGRATION.md` §3. What follows is a **defect
register with expected prevalence and severity**, each tied to evidence.

## 2. Defect register
| # | Defect class | Specific instance | Expected prevalence | Impact | Evidence | Confidence |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Duplicate people** | `users` vs `profiles` are two records of the same human; `users` itself has `name`, `display_name`, `full_name` | **HIGH** - the fallback read at `lib/auth-flow-v2:309-317` exists precisely because `users` rows are sometimes absent | Wrong person merged; wrong contract attached | `scripts/00:43-46, 66-67, 95-114` | HIGH |
| 2 | **Email case collisions** | `email text NOT NULL UNIQUE` is case-sensitive in Postgres; GoTrue is case-insensitive | LOW-MEDIUM | Two accounts, one human, or a failed signup | `scripts/00:41` | HIGH |
| 3 | **Duplicate team membership** | `users.team_id` **and** `rosters`; no `UNIQUE(team_id, user_id)` | **HIGH** | Wrong-team attendance and authorisation | `scripts/00:44, 347-358`; no unique index | HIGH |
| 4 | **Player on multiple rosters** | same | MEDIUM | Ambiguous scope everywhere | same | HIGH |
| 5 | **Duplicate attendance rows** | no unique constraint on `attendances`; four fix scripts de-duplicate | **HIGH** | Inflated rates; wrong payroll or disciplinary inputs | `scripts/16:55-96`, `scripts/17:145`, `scripts/18:147-157` | HIGH |
| 6 | **Duplicate performance rows** | no unique constraint; a script is named for it | **HIGH** | Inflated statistics; wrong prize or eligibility decisions | `scripts/18-fix-multiple-performances-per-slot.sql` | HIGH |
| 7 | **Orphan sessions** | `attendances.session_id` nullable, no FK enforcement required for inserts | MEDIUM | Attendance not linked to a session | `scripts/00:242-260` | HIGH |
| 8 | **Orphan performances** | `team_id` nullable, `slot` has no FK, `slot_id` added later | MEDIUM | Team-scoped authorisation silently excludes the row | `scripts/00:156, 166`; `scripts/14:11-24` | HIGH |
| 9 | **Orphan tryout records** | `tryouts.team_ids uuid[]` has no FK | MEDIUM | A tryout targeting a deleted team | `SUPABASE_TRYOUTS_SETUP_FIXED:16` | HIGH |
| 10 | **Orphan auth users** | a user authenticated in GoTrue with no `users` row, because sign-up profile creation has no INSERT policy | **HIGH** under RLS | Cannot use the product; retried on every page load | `09_AUTHENTICATION.md` F-AUTH-02 | MEDIUM-HIGH |
| 11 | **Missing timestamps** | no `updated_at` on `performances`, `attendances`, `rosters`, `winnings`, `slot_expenses`; `tryout_invitations.responded_at`, `tryout_sessions.attendance_status` optional | HIGH | Corrections indistinguishable from originals | `scripts/00` | HIGH |
| 12 | **Inconsistent `slot` vs `slot_id`** | both columns, four scripts, different resolutions | HIGH for any row where both are set | Cannot join to slots or winnings; `total_winnings` always 0 | `12_DATABASE_RELATIONSHIPS.md` F-REL-03; `automation-scripts/01:122` | HIGH |
| 13 | **`attendances.notes` does not exist** | the API writes it | HIGH if used | Write failures | `app/api/attendances:284`; no `ADD COLUMN notes` on `attendances` | HIGH |
| 14 | **Inconsistent time representations** | `survival_time double precision` vs `interval`; `attendances.session_time text` vs `sessions.start_time time` | HIGH | Attendance arithmetic and duration analytics unreliable | `scripts/00:163, 247`; `scripts/00:406` | HIGH |
| 15 | **`teams.tier` outside `tier_defaults`** | free text, no FK | MEDIUM | A slot priced at 0 | `scripts/00:32, 146, 209-216` | HIGH |
| 16 | **`bgmi_id` / `discord_id` not unique** | no UNIQUE | MEDIUM | Ambiguous person linkage; the applicant de-dup relies on `discord_id` | `scripts/00:60, 71` | HIGH |
| 17 | **Inconsistent status vocabularies** | `users.status` (4, capitalised) vs `teams.status` (3) vs tryout statuses | HIGH | Filtering and reporting across entities | `scripts/00:34, 56` | HIGH |
| 18 | **`overall_score` not generated** | computed in application code | MEDIUM | Can disagree with its components | `app/api/discord/tryout/evaluate:88-91` | HIGH |
| 19 | **`tryout_stats` view double-counts** | six-way join then `GROUP BY` | HIGH if the view is used | Every count inflated | `database/SUPABASE_TRYOUTS_SETUP_FIXED:561-579` | HIGH |
| 20 | **`communication_settings` NULL-sentinel uniqueness** | `UNIQUE(team_id, setting_key)` does not constrain NULLs | MEDIUM | Duplicate global settings; `onConflict` upsert cannot match | `complete-discord-portal-setup.sql:59` | HIGH |
| 21 | **`user_agreements` missing UNIQUE** | the API upserts on it | MEDIUM-HIGH | Acceptance fails; user trapped at `/agreement-review` | `scripts/00:117-130`; `app/api/agreements:116` | MEDIUM |
| 22 | **Deprecated / dead records** | `profiles` rows, `performance_records`, `bot_attendance`, `discord_servers`, `attendance_debug_log`, orphan `holidays` | HIGH | Noise; wasted storage; misleading aggregates | `scripts/00:95-114, 365-436`; `scripts/17:17` | HIGH |
| 23 | **Debug data in production** | `attendance_debug_log` rows | MEDIUM | Unbounded growth; PII in an unprotected table | `scripts/17:17` | MEDIUM |
| 24 | **Unverifiable provenance** | OCR-sourced and bot-sourced performances indistinguishable from manual | HIGH for performance data | Cannot defend a statistic in a dispute | no `source` column on `performances` | HIGH |
| 25 | **Unprovable agreements** | no content hash; content was world-writable | HIGH for legal records | Cannot prove what was accepted | `33_CONTRACTS.md` F-CON-01/02 | HIGH |
| 26 | **Financial data with no currency** | `integer`, no `currency` column, rupee assumed | HIGH | Cannot aggregate across periods or regions; no minor units | `scripts/00:176-207` | HIGH |
| 27 | **Fabricated metrics mixed with real data** | `baseMatches = 3240`, `baseWWCD = 1134`, `baseUnderdogPractice = 37800` | 1 record | Public claims are not measurements | `app/api/public/stats:55-57` | HIGH |
| 28 | **`tryout_stats` bypasses RLS** | view without `security_invoker` | HIGH if readable | Draft/private tryout funnel counts exposed | `database/SUPABASE_TRYOUTS_SETUP_FIXED:561` | HIGH |
| 29 | **No soft delete anywhere** | `archived_at`/`deleted_at` exist but are unused | HIGH | Deletions are unrecoverable; the only remedy is a full restore | `scripts/13:42, 45` | HIGH |
| 30 | **Audit-free** | no record of who changed anything | HIGH | No dispute can be resolved | `49_AUDIT_LOGGING.md` | HIGH |

## 3. Aggregate assessment
| Dimension | Assessment |
| --- | --- |
| Referential integrity | **Weak** - 12+ FKs have no `ON DELETE`; two columns conflict; two key arrays have no FK |
| Uniqueness | **Very weak** - 15 missing constraints, at least three of which have caused real bugs |
| Temporal integrity | **Very weak** - no `updated_at` on most tables, no effective dating anywhere, `text` time columns |
| Provenance | **Absent** - no `source`, no actor, no audit |
| Referential scope | **Not applicable** - no tenant, no organisation |
| Personal-data hygiene | **Poor** - PII without consent, purpose limitation or retention |
| Financial hygiene | **Poor** - no currency, no ledger, no actor, one broken metric |
| Best-quality area | **The tryout family** - six well-modelled tables |

## 4. What must be measured before quoting a migration
The Phase 0 script in `83_DATA_MIGRATION.md` §3 must produce, at minimum: per-table row counts;
distinct people; duplicate detection for people, membership, attendance and performances; orphan
counts for every FK; null rates for every column; date ranges for every temporal column; the
distinct-value cardinality of every enum-like column; the count of rows with both `slot` and
`slot_id` set; the count of rows with neither; the count of `attendances` rows with a
`session_time` that is not parseable; and the total monetary value per currency assumption.

**Until that is run, no statement in this document about volume or frequency is anything other
than an expectation.** That is stated deliberately, per Audit.md Rule 1.

## 5. Verdict
The data is **migratable but must be cleaned**, and roughly a third of it (dead tables,
unverifiable legal records, credentials, debug logs, fabricated metrics) should be **archived
rather than migrated**. The tryout family can be migrated with confidence. Everything else
requires a per-customer data project.
