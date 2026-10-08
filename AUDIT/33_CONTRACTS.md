# 33 - CONTRACTS
**Audit.md section:** 40 (SECTION 37 - CONTRACT DOMAIN)

## 1. What exists: the user_agreements table
| Column | Type | Notes | Evidence |
| --- | --- | --- | --- |
| id | uuid PK | | scripts/00:118 |
| user_id | uuid to users(id) ON DELETE CASCADE | | scripts/00:129 |
| role | text CHECK(7 values) | the role the agreement was for | scripts/00:120 |
| agreement_version | integer NOT NULL | | scripts/00:121 |
| accepted_at | timestamptz | | scripts/00:122 |
| ip_address | inet | from a spoofable header | scripts/00:123; app/api/agreements:96-99 |
| user_agent | text | | scripts/00:124 |
| status | text CHECK(accepted/pending/declined) | | scripts/00:125 |
| created_at, updated_at | timestamptz | | scripts/00:126-127 |

**There is no other contract, agreement, document or signature entity in the repository.**

## 2. How it works
1. lib/agreement-versions.ts:6-13 declares the required version per role: player 2, coach 1,
   manager 1, analyst 1. admin, pending_player and tryout are EXEMPT.
2. lib/auth-flow-v2.ts:493-568 checkAgreementStatus() calls the RPC
   check_user_agreement_status(user_id, role, required_version).
3. If an agreement is required the user is redirected to /agreement-review
   (lib/auth-flow-v2.ts:366-372).
4. authFlowV2.acceptAgreement() POSTs role, version and status accepted to /api/agreements
   (lib/auth-flow-v2.ts:684-732).
5. The server validates only that version equals getRequiredAgreementVersion(role)
   (app/api/agreements:86-93) and upserts (app/api/agreements:105-120).
6. The CONTENT shown to the user lives in admin_config under agreement_content_{role} as a JSON
   string (app/api/admin/agreements:29-33, 118-124).

## 3. Inventory against the Audit.md checklist
| Item | Present | Note |
| --- | --- | --- |
| Agreements | Partially | versioned acceptance record only |
| Documents | NO | content is a JSON blob in a key/value table; no file, no history, no hash |
| Expiration | NO | no expires_at; terms are perpetual once accepted |
| Renewal | NO | re-acceptance happens only because a TypeScript constant was bumped |
| Signatures | NO | a status=accepted row plus an IP and a UA is not a signature - no artefact, no document hash, no consent-text snapshot |
| Amendments | NO | no amendment chain, no diff, no re-consent record |
| Parties | NO | one side only; the organisation is not a party record |
| Term / scope | NO | no effective dates, no territory, no scope beyond a free-text role |
| Governing law | NO | - |
| Termination | NO | - |
| Obligations / deliverables | NO | - |
| Counter-signature | NO | - |
| Template management | Partially | admin_config plus /dashboard/admin/agreements - which is permanently broken |

## 4. Findings

### F-CON-01 - CRITICAL: the agreement content is world-readable and world-writable
**Evidence.** admin_config has NO RLS (omitted from scripts/00:474-481; no other script adds it).
It holds agreement_content_player|coach|manager|analyst, agreement_version_*,
agreement_enforcement_enabled, agreement_dev_override, maintenance_mode and
default_public_webhook_id (scripts/00:552-559; automation-scripts/04:157-166).
**Impact:** with the public anon key an UNAUTHENTICATED caller can rewrite the legal text that
every player, coach, manager and analyst is shown and asked to accept, and can set
agreement_enforcement_enabled to disable the gate entirely.
**Severity:** CRITICAL | **Confidence:** HIGH

### F-CON-02 - HIGH: no content snapshot, so acceptance is unprovable
**Evidence.** user_agreements records agreement_version (an integer) but not the document, its
hash, its author or its publication date. The content lives in a mutable admin_config row.
**Impact:** the organisation cannot prove WHAT TEXT a person accepted on a given date. If content
is edited without bumping the version, previously accepted users are deemed to have accepted text
they never saw.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** versioned, immutable documents rows with a content hash; record the hash on
the acceptance.

### F-CON-03 - HIGH: the admin agreement editor is permanently broken
**Evidence.** app/api/admin/agreements:18-26 authenticates with getUser but then reads the
caller role with the MODULE-LEVEL ANON supabase client (import at line 3). With auth.uid() equal
to NULL the users SELECT policy (auth.uid() = id) denies, so userData is null and the check
userData.role !== admin is true, producing 403 for every caller including real admins.
**Impact:** the organisation cannot edit its own legal documents through the product.
**Severity:** HIGH | **Confidence:** MEDIUM-HIGH

### F-CON-04 - HIGH: the acceptance upsert depends on a constraint the schema does not define
**Evidence.** app/api/agreements:105-120 uses an upsert with onConflict user_id,role;
scripts/00:117-130 declares NO UNIQUE(user_id, role).
**Impact:** if the constraint is absent, POST /api/agreements returns 500, acceptAgreement()
returns false (lib/auth-flow-v2.ts:728-730), and the user is trapped in a redirect loop at
/agreement-review - unable to enter the product at all.
**Severity:** HIGH | **Confidence:** MEDIUM

### F-CON-05 - HIGH: enforcement fails open on any error
**Evidence.** lib/auth-flow-v2.ts:514-521 and 560-567 return requiresAgreement false, status
bypassed on any RPC error or exception; automation-scripts/04:166-172 returns bypassed unless
admin_config.agreement_enforcement_enabled is the literal string true.
**Impact:** a transient database error silently disables a legal gate; combined with F-CON-01 the
gate is also remotely disableable.
**Severity:** HIGH | **Confidence:** HIGH

### F-CON-06 - MEDIUM: the recorded role is client-supplied
**Evidence.** app/api/agreements:79-93 takes role from the body and validates only the version.
**Impact:** a user can pre-record acceptance of a role they do not hold, which then satisfies the
gate when they are later promoted into it.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-CON-07 - MEDIUM: three sources of truth for the current version
lib/agreement-versions.ts:6-13 (TypeScript constant); admin_config.agreement_version_* rows
(scripts/00:556-558); and the RPC parameter p_required_version, supplied by the CALLER
(app/api/agreements:51). The check is therefore "does the stored version equal what the caller
asked for?" rather than "is the contract current?".
**Severity:** MEDIUM | **Confidence:** HIGH

### F-CON-08 - MEDIUM: ON DELETE CASCADE destroys legal evidence
**Evidence.** scripts/00:129 user_agreements_user_id_fkey ON DELETE CASCADE; users is itself
ON DELETE CASCADE from auth.users (scripts/00:91).
**Impact:** deleting a user erases the record that they accepted terms - the opposite of what
evidence retention requires.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-CON-09 - MEDIUM: the recorded IP comes from a spoofable header
**Evidence.** app/api/agreements:96-99 reads x-forwarded-for then x-real-ip then unknown.
**Impact:** the recorded IP is not trustworthy evidence unless the platform strips the header
first, which is not documented anywhere.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-CON-10 - LOW (today) / HIGH (multi-tenant): agreement text is rendered as Markdown
**Evidence.** /agreement-review/page.tsx (15,361 B) uses react-markdown with no sanitiser.
**Impact:** today the source is admin_config, which F-CON-01 shows is attacker-writable - so this
is a live stored-content-injection path in a high-privilege surface. It becomes a clear stored XSS
the moment tenants can author their own agreement text.
**Severity:** LOW today, HIGH once tenant-authored content exists | **Confidence:** MEDIUM

## 5. Verdict
| Asset | Verdict |
| --- | --- |
| The CONCEPT of versioned agreements with re-acceptance on change | KEEP - it is the right idea |
| user_agreements schema | REBUILD as agreements plus immutable document_versions plus acceptances (with a content hash) |
| admin_config-based content storage | REPLACE with a real document store |
| The agreement-review UX | REBUILD with a diff view, explicit consent and a downloadable PDF |
| Signature | REPLACE with a proper e-signature integration producing a verifiable artefact |
| Contract lifecycle (draft, review, sign, active, expiring, terminated) | BUILD NEW (73_FUTURE_DOCUMENTS.md) |
| Compensation-linked contract terms | BUILD NEW (32_COMPENSATION.md, 65_FUTURE_PAYROLL.md) |
