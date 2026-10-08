# 48 - IMPORT / EXPORT
**Audit.md section:** 55 (SECTION 52 - IMPORT / EXPORT)

## 1. Capability inventory
| Format | Import | Export | Where | Status |
| --- | --- | --- | --- | --- |
| CSV | **No** | **No** | - | absent |
| Excel / XLSX | **No** | **No** | - | absent |
| JSON | **No** | **No** | — | only ad hoc `JSON.stringify` into `admin_config` |
| PDF | No | **Yes** | `lib/pdf-export.ts` (10,674 B) | working; **one report only** (performance report) |
| Images / video | Yes | Yes | `public/` static assets; `media` bucket via 2 unauthenticated endpoints | working but **unmanaged and unprotected** |
| Public API (programmatic) | **No** | **No** | — | no API keys, no tokens, no scopes, no webhooks, no OpenAPI |
| Database-level | — | — | `scripts/05-seed-team-management-data.sql` | **seed data**, not an import facility |
| Attempt/application intake | **Yes (as a form)** | — | `/join-us`, `/apply/[tryoutId]`, `/contact` → `tryout_applications` | working for its narrow purpose |

## 2. Findings

### F-IMP-01 - HIGH: no bulk import, so onboarding a real organisation is impractical
**Evidence.** absence of any import facility. New people are created one at a time through
`/dashboard/user-management`, which is **broken** (`app/api/users:140` calls the undefined RPC
`bulletproof_user_update`).
**Impact:** a SaaS customer with 200 staff, 60 players and 30 creators has no way to get them
into the platform except 290 manual, individually-failing operations. This is a **launch
blocker** for the target product and a direct obstacle to migration
(`83_DATA_MIGRATION.md`).
**Severity:** HIGH | **Confidence:** HIGH

### F-IMP-03 - HIGH: no bulk export, so a customer cannot leave and cannot get their data
**Evidence.** only the performance report can be exported, as a client-side PDF.
**Impact:**
* **Portability / GDPR:** a data subject cannot obtain a copy of their data, and a customer
  cannot extract their own records to migrate elsewhere. Both are legal requirements in most
  target markets.
* **Commercial:** organisations cannot load their data into a BI tool.
* **SaaS trust:** an organisation that cannot export everything it entered will not put its
  contracts and payroll data into the product.
**Severity:** HIGH | **Confidence:** HIGH

### F-IMP-02 - MEDIUM: the only export is a client-side rasterised PDF
**Evidence.** `lib/pdf-export.ts` uses jsPDF + jspdf-autotable + **html2canvas**, which clones the
DOM and rasterises it.
**Impact:** slow, large files, image-based (so the text is not selectable, not searchable and not
accessible to a screen reader), dependent on the current CSS, and impossible to schedule or
automate.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-IMP-04 - MEDIUM: no data validation or dry-run on any intake path
**Evidence.** the public application form validates field presence only
(`app/api/discord/tryout/apply:47-112`); no schema, no domain checks, no duplicate detection
across channels, no de-duplication review.
**Impact:** intake data is unvalidated at the boundary and must be cleaned manually.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-IMP-05 - MEDIUM: no import/export audit trail
**Evidence.** absence of any audit logging.
**Impact:** a bulk import of 500 people or an export of the full employee register is exactly the
kind of event that must be recorded with actor, scope, time and row count. Without it, a data
breach investigation cannot determine what left the system.
**Severity:** MEDIUM | **Confidence:** HIGH

## 3. Migration-relevant capability (Audit.md asks what this enables)
| Capability needed for migration | Available? |
| --- | --- |
| Export users/people | **No** (would require direct DB access) |
| Export teams and rosters | **No** |
| Export performances | Partially, via the performance report PDF (not machine-readable) |
| Export attendance and sessions | **No** |
| Export finance | **No** |
| Export tryouts | **No** |
| Import into V2 | **No** |
| Direct database dump | Possible operationally (Supabase export) — this is the **only** realistic migration path, which means V2's importer must be built to consume a Postgres dump, not a CSV |

## 4. Verdict
**BUILD NEW, and treat it as a first-class requirement.** V2 needs:
* **Import:** CSV/XLSX upload with a column-mapping step, a schema, per-row and whole-batch
  validation, a **dry-run report** of exactly what would be created / updated / rejected and why,
  idempotent re-runs via a natural key, and an import job record in the audit log.
* **Export:** per-entity CSV/XLSX, a full-tenant export (machine-readable, asynchronous, delivered
  to a signed URL), and scheduled report delivery. Every export is permission-scoped and audited.
* **API:** scoped API keys or OAuth client-credentials for programmatic read and write, with
  per-tenant rate limits - required both for integration and for migration.
* Server-side, accessible PDF generation for reports.
* Migration tooling that reads a legacy Postgres dump directly
  (`83_DATA_MIGRATION.md`).
