# 20 — STORAGE
**Audit.md section:** 27 (SECTION 24 — STORAGE AUDIT)

## 1. Buckets

| Bucket | Public | Size limit | Allowed MIMEs | Created by | App write path | App read path |
| --- | --- | --- | --- | --- | --- | --- |
| `avatars` | **true** | 5 MB | jpeg, jpg, png, webp | `automation-scripts/08:12-19`; also lazily by `app/api/profile/avatar:110-115` | `POST /api/profile/avatar` (**service role**) | `getPublicUrl` (`avatar:127-129`) |
| `media` | **true** | 20 MB | jpeg, jpg, png, webp, gif, mp4, webm, pdf, **text/plain** | `automation-scripts/08:26-33`; lazily by `app/api/media/upload:58-64` | `POST /api/media/upload` (**service role, no auth**) | `getPublicUrl` (`upload:87`) |
| `contact_files` | false | 10 MB | jpeg, jpg, png, webp, pdf | `automation-scripts/08:40-47`; lazily by `app/api/public/upload/contact-file:55-61` | `POST /api/public/upload/contact-file` (**service role, no auth**) | `getPublicUrl` on a **private** bucket (`contact-file:87`) — **non-functional** |
| `ocr_uploads` | false | 10 MB | jpeg, png, jpg, webp | `automation-scripts/08:54-61` | **never written by the app** | never read |

## 2. Findings

### F-STO-01 — CRITICAL: two unauthenticated endpoints perform arbitrary upload and arbitrary deletion with the service-role key
Covered in full in `15_API_SECURITY.md` F-API-01 and F-API-02. Storage-specific consequences:
* Unbounded unauthenticated writes into a **public** bucket.
* Unbounded unauthenticated **destruction** of that bucket's contents.
* `createBucket` executed on every request (a service-role DDL attempt per upload).
* Object keys are attacker-chosen via the unsanitised `folder` field.

### F-STO-02 — CRITICAL: `contact_files` is effectively public
Covered in `15_API_SECURITY.md` F-API-03. Storage-specific: the `TO public` `SELECT` policy
enables **object listing**, so confidentiality and integrity are both lost, and the
`application/pdf` allowance means contract-grade documents are exposed.

### F-STO-03 — HIGH: MIME validation trusts the client and there is no content inspection
**Evidence.**
* `app/api/media/upload:44-53` — allowlist checked against `file.type` only.
* `app/api/public/upload/contact-file:42-50` — same.
* `app/api/profile/avatar:69-75` — same.
* `contentType` written to storage is `file.type || 'application/octet-stream'`
  (`upload:76`, `contact-file:76`, `avatar:113`) — i.e. the **attacker-declared** type becomes
  the **served** content type.
* No magic-byte sniffing, no image re-encode, no antivirus scan anywhere.

**Impact.** Two distinct risks:
1. **Content-type confusion** — an attacker declares `image/png` and uploads arbitrary bytes.
   Because the served type is also `image/png`, direct browser HTML/script execution is limited,
   but non-browser consumers (document scanners, link previewers, PDF viewers) can be attacked.
   `text/plain` is on the allowlist, so arbitrary text is storable under the organisation's
   domain.
2. **Malware / phishing hosting** — the returned URL is a permanent, publicly reachable,
   organisation-branded Supabase link. `application/pdf` is permitted in two buckets, enabling
   weaponised documents.

**Severity:** HIGH · **Confidence:** HIGH
**Recommendation:** sniff the real content type server-side; reject on mismatch; re-encode
images; scan PDFs and archives; store in a **private** bucket; serve through short-lived signed
URLs with `Content-Disposition: attachment` and a locked-down `Content-Type`.

### F-STO-04 — HIGH: file extension is taken from the user-supplied filename
**Evidence.** `app/api/profile/avatar:97` `const fileExt = file.name.split('.').pop()` →
`avatars/{targetUserId}-{Date.now()}.{fileExt}`; `app/api/media/upload:66`
`const ext = file.name.split('.').pop() || 'bin'`.
**Impact.** The stored object's extension is fully attacker-controlled while its content type is
attacker-controlled separately. This maximises the chance of a content-type/extension mismatch
being exploited by a downstream consumer, and it permits storing `*.html`, `*.svgz`, `*.js`
names. Note that `image/svg+xml` is correctly **absent** from the allowlists, which is a good
decision.
**Severity:** MEDIUM · **Confidence:** HIGH
**Recommendation:** derive the extension from the sniffed content type; ignore the client
filename except as a display label.

### F-STO-05 — MEDIUM: unbounded object accumulation and orphaning
**Evidence.**
* Avatar uploads use a **timestamped** filename with `upsert: true`
  (`app/api/profile/avatar:98, 114`) and the previous object is **never deleted** on update —
  only on explicit DELETE (`:243-259`). Every avatar change leaves an orphan.
* `app/api/media/upload:67` uses a UUID filename with `upsert: false` and **no** delete-on-replace
  path at all.
* `app/api/public/upload/contact-file:64-67` uses `contact-{Date.now()}-{uuid}.{ext}` and the
  returned URL is non-functional, so there is no way to clean these up.
* There is **no retention policy, no lifecycle rule, no cleanup job** for any bucket
  (`automation-scripts/06-scheduled-jobs-setup.sql` cleans up Discord *logs*, not storage).
* Orphaned media is only collected by `cleanup_old_discord_logs` — a different resource.
**Impact.** Unbounded storage cost; a growing population of publicly reachable objects that the
organisation no longer knows about; GDPR erasure is impossible because there is no index of
what exists.
**Severity:** MEDIUM · **Confidence:** HIGH
**Recommendation:** an `assets` table as the single index of every object (owner, org, key,
content type, size, checksum, scan status, created/expires); deterministic keys so replacement
overwrites; a scheduled reconciliation job; a retention policy per class.

### F-STO-06 — MEDIUM: the storage RLS policies are inert or bypassed
**Evidence.** `automation-scripts/08:83, 89, 111, 117, 155, 161` all key ownership on
`auth.uid()::text = (storage.foldername(name))[1]`, i.e. the **first path segment must equal the
uid**. The application writes `avatars/{targetUserId}-{timestamp}.{ext}`
(`app/api/profile/avatar:98-99`), so the first segment is `{uid}-{timestamp}` and **never
equals** the uid. The policies therefore never match. Meanwhile the application performs the
upload with the **service-role key**, which bypasses `storage.objects` RLS entirely.
**Impact.** The storage policies provide no protection whatsoever; the only real control is the
API's own check, and that check allows `admin`/`manager` to write any user's avatar. The
apparent defence in depth is illusory and would mislead a reviewer.
**Severity:** MEDIUM · **Confidence:** HIGH
**Recommendation:** use keys of the form `{org_id}/{owner_id}/{uuid}.{ext}` so the policy
predicate is meaningful; use a user-scoped client for user-initiated uploads so RLS actually
applies; keep the service role only for genuinely privileged operations.

### F-STO-07 — MEDIUM: `ocr_uploads` bucket exists with policies but is never used
**Evidence.** Created at `automation-scripts/08:54-61` with 3 policies
(`:147-161`), plus a duplicate set in `scripts/13-comprehensive-database-fixes.sql:279-289`. No
application code references the bucket — OCR is performed entirely in the browser
(`21_OCR.md`).
**Impact:** dead infrastructure; two competing policy sets; an unused private bucket that will
still be present in any environment where script 8 was run.
**Severity:** LOW · **Confidence:** HIGH

### F-STO-08 — MEDIUM: `getPublicUrl` is used on a private bucket
**Evidence.** `app/api/public/upload/contact-file:86-101`
```ts
const { data: urlData } = supabase.storage.from('contact_files').getPublicUrl(filePath)
…
return NextResponse.json({ success: true, downloadUrl: urlData.publicUrl, … })
```
`contact_files` is `public: false` (`automation-scripts/08:44`), so the returned URL resolves to
nothing.
**Impact.** The contact form's attachment feature is **broken end to end** while appearing to
succeed. The uploaded file sits in a world-readable bucket, so the organisation believes it has
a working private attachment flow when it has neither privacy nor function.
**Severity:** MEDIUM (product) / **CRITICAL** (privacy, via F-API-03) · **Confidence:** HIGH
**Recommendation:** `createSignedUrl(path, expiresIn)` issued server-side to an authenticated
staff member, never a public URL.

### F-STO-09 — MEDIUM: the 6.1 MB hero video is an unmanaged "asset"
**Evidence.** `public/space-particles.mp4` (6,399,270 bytes) is committed to git and autoplayed
by `components/video-background.tsx` on the public pages and on the root error/not-found
boundaries. `next.config.mjs:3-4` sets `images.unoptimized: true`.
**Impact:** ~67 % of repository weight; unthrottled download on mobile; no poster image, so a
visible blank frame before playback; and it plays regardless of `prefers-reduced-motion`.
**Severity:** MEDIUM · **Confidence:** HIGH
**Recommendation:** CDN-hosted, adaptive (HLS) video with a poster frame, `prefers-reduced-motion`
handling, and a mobile-specific lighter asset.

## 3. Storage capability summary

| Capability (Audit.md §24) | State |
| --- | --- |
| Access control | **BROKEN** — two endpoints unauthenticated; `contact_files` world-readable; policies inert |
| File validation | **Partial** — client-declared MIME only |
| MIME validation | **Client-supplied, spoofable** |
| Size limits | **Present and correct** (5/10/20 MB) — genuinely implemented |
| Malware concerns | **No scanning, no re-encoding** |
| Public/private buckets | **Misconfigured** — `avatars`/`media` public; `contact_files` private but publicly readable |
| Signed URLs | **Never used** |
| Retention | **None** — no lifecycle rules, no cleanup, no index |
| Key strategy | **UUID/timestamp, attacker-influenced, not owned** |
| Asset index | **None** — no table records what exists |
| Quota / limits | **None per identity or tenant** |

## 4. Verdict for V2
**REPLACE entirely.** A single `assets` domain: an `assets` table as the authoritative index
(`org_id`, `owner_id`, `kind`, `storage_key`, `content_type` sniffed server-side, `size`,
`checksum`, `scan_status`, `visibility`, `created_at`, `expires_at`); **private buckets only**;
uploads via short-lived signed URLs issued after an authorisation check; reads via short-lived
signed URLs; server-side content sniffing and scanning; deterministic keys; per-tenant quotas;
a scheduled reconciliation and expiry job; and explicit retention classes
(avatars 2 years after last use, media 1 year, contact/enquiry attachments 90 days,
OCR working files 7 days).
