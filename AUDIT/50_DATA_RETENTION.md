# 50 - DATA RETENTION
**Audit.md section:** 57 (SECTION 54 - DATA RETENTION)

## 1. Inventory
| Mechanism | Present? | Evidence |
| --- | --- | --- |
| Soft delete | **Effectively none** | `teams.archived_at` and `teams.deleted_at` are added by `scripts/13:42, 45` but **never written or filtered** by any code (`rg "archived_at\|deleted_at"` → no application usage) |
| `deleted_at` on any other table | **NO** | absence |
| Cascading hard delete | **Yes, extensively** | `ON DELETE CASCADE` from `users` to `performances`, `attendances`, `rosters`, `user_agreements`; from `teams` to seven tables; from `auth.users` to `users` (`scripts/00:91`) |
| Retention policy / TTL | **NO** | no TTL, no partition expiry, no scheduled purge |
| Archival | **NO** | no archive table, no cold storage |
| Legal hold | **NO** | no hold flag, no exception handling in any delete path |
| Backups | See `51_BACKUPS.md` | no application-level backup, export, or restore facility |
| Anonymisation / pseudonymisation | **NO** | absence |
| Right-to-erasure implementation | **NO** | and impossible for applicants (no identity record) |
| Data-subject access (export) | **NO** | see `48_IMPORT_EXPORT.md` |
| Consent records | **NO** | see `92_COMPLIANCE.md` |

## 2. Findings

### F-RET-01 - CRITICAL: hard delete cascades destroy competitive and legal records
**Evidence.** `scripts/00` cascade graph (see `12_DATABASE_RELATIONSHIPS.md` §2);
`DELETE /api/teams/manage` hard-deletes a team.
**Impact:** deleting a team, a user or a slot irreversibly removes match results, attendance
records, legal acceptances and financial records. In an esports organisation:
* **Competitive integrity:** a result that is later disputed cannot be produced.
* **Employment/contract evidence:** `user_agreements` is `ON DELETE CASCADE` from `users`, so
  deleting a user erases the proof that they accepted terms.
* **Financial records:** `slot_expenses` and `winnings` disappear with the team.
**Severity:** CRITICAL | **Confidence:** HIGH
**Recommendation:** people and competitive records are **never hard-deleted**; archive instead;
retention and legal hold govern any eventual purge.

### F-RET-02 - CRITICAL: the purge endpoint bypasses every retention consideration
**Evidence.** `app/api/admin/settings:103-130`.
**Impact:** an admin can destroy the entire operational dataset in one unaudited, unconfirmed
request, with no export, no dry-run and no error checking.
**Severity:** CRITICAL | **Confidence:** HIGH

### F-RET-03 - HIGH: soft delete was designed and then never implemented
**Evidence.** `scripts/13-comprehensive-database-fixes.sql:37-48` adds `archived_at` and
`deleted_at` to `teams`; no application code references either.
**Impact:** the intent existed; the implementation was abandoned. Any team deletion is
unrecoverable.
**Severity:** HIGH | **Confidence:** HIGH

### F-RET-04 - HIGH: no data-subject rights can be honoured
**Evidence.** no export facility (`48_IMPORT_EXPORT.md`); no erasure facility; applicants have
no identity record at all (`29_TRYOUTS.md` F-TRY-06), so an applicant's data can only be found by
free-text search across `contact_email` and `discord_id`.
**Impact:** GDPR/CCPA access and erasure requests cannot be fulfilled reliably, and a
demonstrable failure to satisfy an erasure request is itself a breach.
**Severity:** HIGH | **Confidence:** HIGH

### F-RET-05 - HIGH: no retention policy for the highest-risk data
**Evidence.** `users` stores `date_of_birth`, `address`, `emergency_contact_name`,
`emergency_contact_number`, `contact_number`, precise `device_model`/`ram`/`fps`/`storage`,
`hud_layout_code`, `sensitivity_settings`, `instagram_handle`, `discord_id`, `bio` — with no
retention, no purpose limitation and no consent record (`scripts/00:41-91`).
**Impact:** this is special-category-adjacent personal data about a population that includes
minors, retained indefinitely, with no lawful basis recorded. In the EU this is a fundamental
data-protection failure; in India the DPDPA Act imposes a similar requirement; several US states
add their own.
**Severity:** HIGH | **Confidence:** HIGH

### F-RET-06 - MEDIUM: orphaned files accumulate with no lifecycle
**Evidence.** avatar uploads are timestamped with `upsert: true` and the previous object is never
deleted on update (`app/api/profile/avatar:98, 114`); `media` objects are never reconciled;
`contact_files` has a non-functional URL so nothing can be cleaned up
(`20_STORAGE.md` F-STO-05).
**Impact:** unbounded growth of publicly reachable objects that the organisation no longer knows
about, making erasure impossible.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-RET-07 - MEDIUM: the one cleanup function is publicly callable
**Evidence.** `cleanup_old_discord_logs(days_to_keep integer DEFAULT 30)` is
`SECURITY DEFINER` (`automation-scripts/03:113-124`) with **no `REVOKE` from `anon`**.
**Impact:** an unauthenticated caller can truncate the outbound-communication log at will.
**Severity:** MEDIUM | **Confidence:** MEDIUM

## 3. V2 retention requirements (proposed defaults; legal review required)
| Class | Retention | Deletion behaviour |
| --- | --- | --- |
| People (identity, contact) | life of relationship + 6 years | archive, then anonymise |
| Employment records, contracts, acceptances | **7 years after end of relationship** (many jurisdictions) | archive; **never hard-delete while a legal hold applies** |
| Payroll and compensation | 7-10 years by jurisdiction | archive to cold storage |
| Financial transactions, invoices | 7-10 years by jurisdiction | immutable, archive only |
| Competitive results and match records | life of organisation + 3 years | **immutable; corrections are new rows** |
| Attendance and training records | 3-5 years | archive |
| Applications (recruitment) | 12 months unless the candidate consents to longer | hard-delete, then anonymise |
| Avatars and profile media | 2 years after last use | hard-delete |
| Uploaded media | 1 year | hard-delete |
| Enquiry / contact attachments | 90 days | hard-delete |
| OCR working files | 7 days | hard-delete |
| Audit log | 7 years | archive to cold storage, never modified |
| Security logs | 1-2 years | archive |
| Notification deliveries | 2 years | archive |
| Analytics events | 25 months (then aggregate) | delete raw |

Mechanisms: `deleted_at` + `archived_at` on every tenant table; an `anonymised_at` for
irreversible pseudonymisation; a `legal_holds` table checked by every purge path; partitioned
event tables with automatic expiry; an `assets` index with per-class TTL; and a scheduled,
audited, idempotent purge job.

## 4. Verdict
**BUILD NEW.** Retention is not a feature to add later in a product that holds employment
contracts, minors' data and money. It must be designed in from the first migration.
