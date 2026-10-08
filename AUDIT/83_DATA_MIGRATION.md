# 83 - TENANT DATA MIGRATION (requirements - NOT implemented)
**Audit.md section:** 90 (SECTION 87)

## 1. The hard constraint discovered by this audit
**There is no export facility in the legacy system** (`48_IMPORT_EXPORT.md` F-IMP-03). The only
export is a client-side PDF of the performance report. Therefore the **only** realistic migration
source is a **direct Postgres dump** of the customer's Supabase project - which means the V2
importer must be built to consume a database extract, not a CSV that the customer cannot
produce.

This has to be stated plainly to any prospective customer: **historical data must be extracted
from the database by an engineer, not exported by the customer.**

## 2. What exists to migrate, and its quality
| Legacy data | Volume (est.) | Quality | Migratable? |
| --- | --- | --- | --- |
| `users` (+ `profiles`) | tens-hundreds | **Poor** - three name columns, duplicate table, no employment data, PII with no consent record | **Yes**, with a de-duplication and field-mapping report |
| `teams` | a handful | Fair - but `tier` is a price band, not a division | Yes |
| `rosters` | tens | Poor - duplicates `users.team_id`, no dates, no role beyond `in_game_role` | Yes, after conflict resolution |
| `teams.coach_id` | a handful | Fair | Yes -> `TeamStaff` |
| `performances` | thousands-millions | **Mixed** - `slot` vs `slot_id` ambiguity, no `match` entity, OCR-sourced rows indistinguishable from manual | Yes, with a provenance flag |
| `slots` / `slot_expenses` / `winnings` / `prize_pools` | hundreds-thousands | Fair - money is `integer`, no currency | Yes, as historical finance records |
| `tier_defaults` | 5 | Fine | Yes, as pricing configuration |
| `sessions` / `practice_session_config` / `holidays` | thousands | Poor - `session_time text`, duplicates, no idempotency | Yes, after normalisation |
| `attendances` | tens of thousands | **Poor** - duplicates likely, `notes` column may not exist | Yes, after de-duplication |
| `tryouts` + 5 child tables | hundreds | **Good** - the best-modelled data in the system | Yes |
| `user_agreements` | tens | **Unprovable** - no content hash, content was world-writable | Archive only; **re-consent required** |
| `discord_webhooks` | a few | **Credentials - do not migrate; rotate** | **No** |
| `communication_logs` | thousands | **Forgeable** | Archive only, marked `provenance_unverified` |
| `admin_config` | 1 | **Untrustworthy** - world-writable | Migrate as configuration with `provenance_unverified` |
| `profiles`, `performance_records`, `bot_attendance`, `discord_servers`, `attendance_debug_log` | - | Unused | **Archive; do not migrate** |

## 3. Migration process
### Phase 0 — assessment (no commitment)
* A read-only script that reports per table: row counts, distinct people, duplicate detection,
  orphan detection, date ranges, null rates, distinct-value cardinality, and the
  **money-versus-no-currency** problem.
* Output: a **data quality report** the customer signs off, listing what will be dropped,
  merged, or kept unverified. **Never migrate silently.**

### Phase 1 — extract
* A pinned, versioned extraction script run against a **read-only replica or a customer-approved
  snapshot**, producing a normalised, typed export (NDJSON per table) plus a manifest with
  per-table row counts and SHA-256 checksums.
* PII is encrypted in transit and at rest; the extract is deleted on a defined schedule.

### Phase 2 — transform
* De-duplicate `users` vs `profiles`; pick a canonical display name; record every merge in a
  `merge_report` so the customer can review.
* Resolve `users.team_id` vs `rosters` conflicts: `rosters` wins where present, and every
  divergence is logged for review.
* Normalise `attendances.session_time` text to a real time; de-duplicate on
  `(player, date, session_time)` keeping the earliest, logging every removal.
* Resolve `performances.slot` vs `slot_id`; rows that cannot be resolved are kept with
  `slot_id = NULL` and flagged.
* Create `Organization` rows - one per importing organisation, or a single one for a
  single-tenant migration.
* Create `Person` + `Identity` + `PersonProfile` from `users`.
* Create `Engagement` rows from `users.role` (primary) and derive initial `RoleAssignment` rows
  from the legacy role. **Every derived role is reported to the customer for confirmation.**
* Create `Team` and `TeamMembership` (effective-dated from `created_at`), plus `TeamStaff` from
  `coach_id`.
* Create `Competition`/`Entry`/`EntryCost`/`PrizeIncome` from `slots`/`slot_expenses`/`winnings`.
* Create `Session` and `AttendanceRecord` from `sessions`/`attendances`.
* Create `Tryout` and its children from the `tryout_*` tables - the cleanest part.
* Create archived `Document` records for `user_agreements`, each flagged
  `provenance_unverified`, and **schedule a re-consent campaign**.
* **Do not migrate webhook URLs.** Rotate them.

### Phase 3 — validate
* Automated checks: referential integrity, no cross-tenant rows, no orphan references, row counts
  matching the manifest, checksum verification, and every person resolvable to an `OrgMembership`.
* A **side-by-side report** the customer signs: counts and totals per entity, per team, per month.
* A sampled manual review of 50-100 records chosen across entity types.

### Phase 4 — cut over
* A rehearsed, timed runbook with a rollback (restore the previous snapshot).
* **A dry run is mandatory** and must be completed at least twice.
* Post-cutover: a 30-day hypercare window, a support channel, and a documented reconciliation
  report.

## 4. Import facility (V2, for future migrations and bulk onboarding)
Requirements per `48_IMPORT_EXPORT.md` §4: CSV/XLSX with column mapping, full validation, a
**dry-run report** of exactly what would be created/updated/rejected and why, idempotent re-runs
via natural keys, a job record in the audit log, and a per-tenant rate limit. Plus a
**database-level importer** for large tenants, with the same validation and reporting.

## 5. Known, disclosable gaps
1. **No compensation or contract history exists** (`32_COMPENSATION.md`, `33_CONTRACTS.md`) - it
   must be reconstructed from contracts.
2. **Prize allocations were never recorded** (`31_FINANCE.md` F-FIN-01) - historical prize income
   can be imported as a team-level record with **no allocation**, and this must be disclosed
   because it is a financial and legal gap in the customer's own records.
3. **Roster history does not exist** (`30_TEAMS.md` F-TEAM-04) - membership dates before the
   migration are unknown, so eligibility questions about past events cannot be answered.
4. **Agreement provenance is unprovable** (`33_CONTRACTS.md` F-CON-02) - a re-consent campaign is
   required.
5. **No export means the customer cannot do this themselves** - an engineer is required, which
   affects commercial terms and pricing.
6. **Bot-sourced and OCR-sourced data cannot be distinguished** from manually entered data
   (`25_PERFORMANCE_DOMAIN.md` §3), so historical performance data has uncertain provenance.

## 6. Verdict / status
**REQUIREMENTS ONLY.** Migration is feasible and worth doing, but it is a **data project per
customer**, not a self-serve import - and that must be reflected in pricing and in the sales
conversation.
