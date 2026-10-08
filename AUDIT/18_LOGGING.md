# 18 — LOGGING
**Audit.md section:** 24 (SECTION 21 — LOGGING)

## 1. Log sources

| Category | Present? | Mechanism | Evidence |
| --- | --- | --- | --- |
| Application logs | Yes, but **stripped in production** | `console.log/warn/error` only | `next.config.mjs:8-10` `compiler: { removeConsole: process.env.NODE_ENV === 'production' }` |
| Audit logs (who did what) | **NO** | — | no `*_audit` table, no `updated_by`, no actor on any mutation except `communication_logs.triggered_by` |
| Security logs | **NO** | — | no auth-failure log, no permission-denied log, no rate-limit log, no IP log |
| API request logs | **NO** | `lib/discord-bot-auth.ts:119-139` `logBotApiRequest` exists but is **never imported** | verified: only self-references |
| Error tracking | **NO** | `SENTRY_DSN` documented in `.env.example:18` but no Sentry SDK is a dependency and `rg "sentry\|Sentry"` → 0 | |
| Structured logging | **NO** | ad hoc `console.log` with emoji prefixes | e.g. `lib/auth-flow-v2.ts` (`🔐`, `✅`, `❌`, `⚠️`) |
| Log levels | **NO** | no level concept | |
| Log redaction | **NO** | PII is logged verbatim | `lib/auth-flow-v2.ts:290, 430`; `lib/secure-profile-creation.ts:15`; `lib/ocr-service.ts:61` |
| Log shipping / aggregation | **NO** | — | no service configured |
| Correlation ids | **NO** | — | no `x-request-id` propagation |
| Database-side logging | Partial | `attendance_debug_log` table (`scripts/17:17`) — a **debug artefact left in the schema** | |

## 2. The decisive finding

### F-LOG-01 — HIGH: `removeConsole` deletes 100 % of production logging
**Finding.** `compiler.removeConsole` is enabled for production builds, which strips every
`console.*` call from the emitted bundles.
**Evidence.** `next.config.mjs:8-10`
```js
compiler: { removeConsole: process.env.NODE_ENV === 'production' },
```
Every diagnostic in the codebase is a `console.*` call: `lib/auth-flow-v2.ts` (30+ calls
including sign-in outcomes, profile-load failures and agreement-check errors),
`lib/supabase.ts:15-19, 29` (misconfiguration), `lib/secure-profile-creation.ts` (creation
outcomes, including `23514`/`23503`/`23505` interpretation), every API route's `console.error`,
`modules/discord-portal/*`, `app/error.tsx:22`.
**Impact.**
* There is **no record of any kind** that a sign-in failed, a profile could not be created, a
  Discord delivery failed, or an unhandled exception occurred.
* The RLS breakage documented in `10_AUTHORIZATION.md` (nine endpoints using a session-less
  client) would be **invisible** in production — which is very likely why it survived.
* The `ReferenceError` in `DELETE /api/attendances` (F-ERR-02) is likewise invisible.
* Incident response, fraud detection and the future audit trail all have no substrate.
**Severity:** HIGH · **Confidence:** HIGH
**Recommended remediation:** remove `removeConsole`; adopt a structured logger with levels,
redaction and a correlation id; ship to a managed aggregator; add error tracking with
source-map upload; and treat "no telemetry" as a release blocker.

### F-LOG-02 — HIGH: no audit trail for any sensitive action
**Finding.** No sensitive mutation is recorded anywhere.
**Evidence (Audit.md §56 checklist, verified against the schema):**
| Action | Recorded? |
| --- | --- |
| Role change | **No** — and the endpoint is broken anyway (`app/api/users:140`) |
| Team/team_id change | **No** |
| Contract/agreement change | Only the acceptance event (`user_agreements`), no content hash, no author, and `admin_config` is world-writable |
| Roster change | **No** |
| Financial transaction (slot expense, winnings) | Only the row itself; no actor, no approval |
| Attendance override | `attendances.marked_by` exists, but no before/after value and no correction history |
| Deletion | **No** — and there is a purge that deletes everything with no record |
| Data export / bulk read | **No** |
| Permission change | **No** — the `module_permissions` table that would hold it is never read |
| Configuration change | `admin_config` has no `updated_by`, no `updated_at` |
| Authentication event | **No** — GoTrue's own logs are the only record, and they are not surfaced |
**Impact.** There is no way to answer "who changed this player's role, who marked them absent,
who deleted that slot, who exported the roster?" — which is the minimum requirement for an HR
dispute, a sponsor audit, or a data-breach investigation. In a multi-tenant SaaS this is a
blocker for enterprise sales.
**Severity:** HIGH · **Confidence:** HIGH
**Recommended remediation:** an append-only `audit_log(org_id, actor_id, actor_type, action,
resource_type, resource_id, before, after, correlation_id, ip, user_agent, occurred_at)`,
written by the application service inside the same transaction as the change, readable only by
a platform-audit role, with no UPDATE or DELETE grant.

### F-LOG-03 — HIGH: PII is written to logs
**Evidence.** `lib/auth-flow-v2.ts:290` `console.log(\`🔍 Loading profile for user: ${user.email}\`)`;
`:304` logs the full `userProfile` object (which includes `emergency_contact_number`,
`date_of_birth`, `address`); `:430` logs the email again; `lib/secure-profile-creation.ts:15`
logs email **and** user id; `lib/ocr-service.ts:61` `console.log("Raw OCR text:", text)` — the
full OCR output of a player's screenshot, which can contain in-game identifiers and therefore
personal data; `:144` logs the parsed rows.
**Impact.** In development these land in the browser console of a shared machine and in Vercel's
build/runtime logs; the OCR text is player-submitted content. In production they are stripped —
so the exposure is currently development-only, but the moment logging is fixed (as it must be),
this becomes a live PII-in-logs problem.
**Severity:** HIGH · **Confidence:** HIGH
**Recommended remediation:** a redaction-by-default logger with an allowlist of loggable fields;
never log whole user objects; never log OCR raw text (log only the confidence and the field
count); add a CI lint rule against `console.log` in application code.

### F-LOG-04 — MEDIUM: `communication_logs` is the only audit-like table, and it is forgeable
**Evidence.** `scripts/00:311-328`; the RLS policy
`"System can insert logs" FOR INSERT WITH CHECK (true)` (`database/complete-discord-portal-setup.sql:146-148`)
grants insert to `public`.
**Impact.** The one table that records who communicated what, when, and through which channel can
be written by anyone, including anonymously. `triggered_by` is `NULL` for all bot actions
anyway (the Discord routes have no user identity), so attribution is already impossible.
**Severity:** MEDIUM (HIGH as evidence) · **Confidence:** HIGH

### F-LOG-05 — MEDIUM: a debug table was shipped in the schema
**Evidence.** `scripts/17-debug-attendance-with-logging.sql:17` creates
`attendance_debug_log`; `:198` a `SECURITY DEFINER` function; `:208`
`GRANT INSERT, SELECT ON public.attendance_debug_log TO authenticated`. The table has **no RLS**.
**Impact:** an internal diagnostic artefact is part of the production schema with no access
control, and it will accumulate rows indefinitely (no retention).
**Severity:** MEDIUM · **Confidence:** HIGH

### F-LOG-06 — MEDIUM: no log of failed authentication or authorisation
**Evidence.** `app/api/*` returns 401/403 with no logging. `lib/auth-flow-v2.ts:592` logs
sign-in failure — to the console, which is stripped in production.
**Impact:** credential stuffing, IDOR probing and privilege-escalation attempts are invisible.
There is no signal to alert on.
**Severity:** MEDIUM · **Confidence:** HIGH

### F-LOG-07 — MEDIUM: no request correlation
**Evidence.** no `x-request-id`, no trace id, no `correlation_id` in any response or log.
**Impact:** a user reports "it failed at 14:32" and there is no way to find the request, the
error, or the user.
**Severity:** MEDIUM · **Confidence:** HIGH

## 3. What to build in V2

1. **Structured logging** with levels, a correlation id generated at the edge and propagated
   through every log line, event and audit record, and a redaction allowlist.
2. **Append-only audit log** written in the same transaction as the change, with before/after
   values, actor, scope and IP.
3. **Security event log** for authentication failures, authorisation denials, rate-limit hits,
   privilege changes, export events and admin actions, with alerting thresholds.
4. **Error tracking** with source maps and release tagging.
5. **No `removeConsole`**; a CI lint rule instead.
6. **Retention** per log class: security events 1 year+, audit log 7 years (employment
   evidence), debug logs 7 days, application logs 30 days.
