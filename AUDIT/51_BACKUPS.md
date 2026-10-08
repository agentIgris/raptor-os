# 51 - BACKUPS
**Audit.md section:** 58 (SECTION 55 - BACKUPS)

## 1. What exists
| Capability | Present? | Evidence | Confidence |
| --- | --- | --- | --- |
| Database backup | **Presumed via the platform** | Supabase provides managed daily backups and point-in-time recovery on paid plans. **Nothing in the repository configures, documents, tests or monitors them.** | MEDIUM |
| File (Storage) backup | **Unknown** | Supabase Storage has no independent backup guarantee that the repository relies on; no replication, no versioning, no export. | LOW |
| Backup policy / schedule | **NO** | absence | HIGH |
| Restore procedure | **NO** | absence | HIGH |
| Restore test | **NO** | absence | HIGH |
| RPO definition | **NO** | absence | HIGH |
| RTO definition | **NO** | absence | HIGH |
| Disaster-recovery plan | **NO** | absence | HIGH |
| Multi-region / failover | **NO** | absence | HIGH |
| Export / offsite copy | **NO** | no export facility at all (`48_IMPORT_EXPORT.md`) | HIGH |
| Encryption of backups | Platform-managed | presumed | LOW |
| Backup monitoring / alerting | **NO** | no observability at all (`52_OBSERVABILITY.md`) | HIGH |
| Application-level versioning | **NO** | no `updated_at` on most tables, no revision history, no soft delete | HIGH |

**The only relevant documentation** is `DEPLOYMENT.md` (10,400 B), which discusses the Vercel +
Supabase deployment; it does not specify RPO, RTO, backup cadence, restore procedure or testing.

## 2. Findings

### F-BAK-01 - HIGH: the schema destroys history, so a restore is the only recovery path
**Evidence.** no soft delete in use; `ON DELETE CASCADE` from `users` and `teams` across seven
tables; no `updated_at` on `performances`; no revision history anywhere
(`50_DATA_RETENTION.md` F-RET-01).
**Impact:** in a single-tenant system with no audit log, **a restore from backup is the only way to
undo an erroneous deletion or corruption** - and restoring also undoes every legitimate change
made since. Point-in-time recovery therefore has a recovery-point granularity of "the last backup",
with all work since lost.
**Severity:** HIGH | **Confidence:** HIGH

### F-BAK-02 - HIGH: no RPO or RTO is defined anywhere
**Evidence.** absence of any statement in the repository.
**Impact:** nobody can say whether losing a day of attendance, contracts or prize records is
acceptable, so nobody can choose a backup cadence, and no customer commitment can be made. For a
commercial SaaS this is a contractual prerequisite.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** target RPO 5 minutes (PITR) and RTO 1 hour for the transactional store;
state them in the contract.

### F-BAK-03 - HIGH: no restore has ever been tested
**Evidence.** absence. There are no tests at all (53_TESTING.md), and no restore runbook.
**Impact:** an untested backup is not a backup. Given F-BAK-01, an untested restore is the
difference between an incident and a catastrophe.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** a scheduled, automated restore drill into a scratch environment with automated
verification of row counts, checksums and referential integrity.

### F-BAK-04 - MEDIUM: the purge endpoint makes a restore the *only* recovery path, with no point-in-time escape
**Evidence.** `app/api/admin/settings:103-130` is a single, near-instant, non-transactional
destructive operation.
**Impact:** if an admin triggers it, the only remedy is restoring the entire database to a point
in time, discarding everything since. There is no undo, no confirmation, no dry run, no audit.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-BAK-05 - MEDIUM: no backup or export of storage objects
**Evidence.** no versioning configuration on any bucket; no replication; no export
(`automation-scripts/08`).
**Impact:** a deleted or overwritten avatar, media file or contract attachment is unrecoverable.
**Severity:** MEDIUM | **Confidence:** MEDIUM

### F-BAK-06 - MEDIUM: no multi-tenancy-aware recovery design
**Evidence.** n/a today (single tenant), but the target is multi-tenant.
**Impact:** a naive full-database restore to recover one tenant would destroy the others. Recovery
must be per-tenant (logical export/import) as well as platform-wide.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** per-tenant logical backup and restore as a first-class platform capability -
which also becomes the customer-facing "export your organisation" feature
(`83_DATA_MIGRATION.md`).

## 3. V2 requirements
1. **Platform-wide:** managed PITR (RPO 5 min), a documented RTO of 1 hour for the
   transactional store, an isolated analytics store with a longer RPO, and quarterly restore
   drills with automated verification.
2. **Storage:** bucket versioning, a documented lifecycle, and a per-tenant logical export that
   includes asset references.
3. **Per-tenant:** a logical backup (schema + rows + assets manifest) that can be restored into an
   isolated instance - used for both disaster recovery and customer export.
4. **Encryption** of backups at rest and in transit, with keys managed outside the application.
5. **Monitoring and alerting** on backup success/failure, restore-drill results, and storage
   replication lag.
6. **No single-operator dependency:** the restore runbook is tested and the credentials are in a
   break-glass vault.

## 4. Verdict
**BUILD NEW (platform capability) and document.** Nothing in the repository can be relied upon;
the mitigation for the destructive operations in `15_API_SECURITY.md` F-API-02 and F-API-06 must
not be "we have backups" until a restore has actually been demonstrated.
