# 52 - OBSERVABILITY
**Audit.md section:** 59 (SECTION 56 - OBSERVABILITY)

## 1. Inventory
| Capability | Present? | Evidence |
| --- | --- | --- |
| Structured logging | **NO** | ad hoc `console.log` with emoji prefixes |
| Log shipping / aggregation | **NO** | no service configured |
| Error tracking (Sentry etc.) | **NO** | `SENTRY_DSN` documented at `.env.example:18`; **no SDK dependency**; `rg "sentry\|Sentry"` → 0 |
| Metrics (APM, RED/USE) | **NO** | — |
| Distributed tracing | **NO** | — |
| Health / readiness endpoint | **NO** | no `/api/health`, no `healthz` |
| Uptime monitoring | **NO** | nothing in the repository |
| Alerting | **NO** | — |
| Incident runbook | **NO** | — |
| On-call | **NO** | — |
| SLOs | **NO** | — |
| Audit log | **NO** | `49_AUDIT_LOGGING.md` |
| Security event log | **NO** | `18_LOGGING.md` F-LOG-06 |
| Dashboard / debug pages | **Yes, but experimental** | `app/debug/page.tsx` (22,337 B), `app/debug-simple/page.tsx` (9,310 B) — auth-only, no role gate, can **create slots**, render raw API/DB error text |
| DB-side diagnostics | **Partially** | `attendance_debug_log` table (`scripts/17:17`) — a debug artefact left in the schema with no RLS |

## 2. The decisive finding

### F-OBS-01 - CRITICAL: production logging is compiled out
**Evidence.** `next.config.mjs:8-10`
```js
compiler: { removeConsole: process.env.NODE_ENV === 'production' },
```
Every diagnostic in the codebase is a `console.*` call. In a production build they are
**removed from the emitted JavaScript**, on both the server and the client.
**Impact.**
* There is **zero** record of: failed sign-ins, profile-creation failures, agreement-check
  failures, database errors, RLS denials, Discord delivery failures, or unhandled exceptions.
* The `ReferenceError` in `DELETE /api/attendances` (`17_ERROR_HANDLING.md` F-ERR-02) is
  invisible in production — which is very likely why it survived.
* The RLS breakage affecting nine endpoints (`10_AUTHORIZATION.md`) is invisible in production —
  which is very likely why it survived.
* There is no way to detect an outage, a spike in 500s, credential abuse, or a data exfiltration.
**Severity:** CRITICAL (for operating a commercial SaaS) | **Confidence:** HIGH
**Recommended remediation:** remove `removeConsole`; adopt a structured logger with levels,
correlation ids and redaction; add error tracking with source maps; add a CI lint rule that fails
on bare `console.*` in application code so the discipline is enforced rather than stripped.

### F-OBS-02 - HIGH: no health endpoint and no dependency checks
**Evidence.** absence. `app/api/auth/session` is the closest thing and it is useless for
health-checking (it echoes the caller's token, `15_API_SECURITY.md` F-API-17).
**Impact:** nothing can detect that the database, storage or an integration is down; no
platform can perform a dependency health check; no readiness probe exists for a rolling deploy.
**Severity:** HIGH | **Confidence:** HIGH

### F-OBS-03 - HIGH: the debug pages are the de-facto observability tool, and they are unsafe
**Evidence.** `app/debug/page.tsx` probes `/api/auth/session`, `/api/public/stats`, `/api/slots`,
`/api/performances`, `/api/teams`, `/api/users`, `/api/sessions`, `/api/attendances` and
**creates a slot** (`:153`); `app/debug-simple/page.tsx` does the same (`:48`). Neither is in
`PUBLIC_ROUTES` so they require authentication, but `RouteGuardV2` performs **no role check**, so
any authenticated role including `pending_player` can reach them.
**Impact:** (a) an operational tool shipped in the product with no access control; (b) it
displays raw database error text in the browser; (c) it exposes a write capability to the lowest
privilege role. In a multi-tenant product this is a cross-tenant risk.
**Severity:** HIGH | **Confidence:** HIGH
**Recommended remediation:** delete both pages; if diagnostics are needed, build a
role-gated, audited, server-side diagnostics surface with synthetic checks and no write capability.

### F-OBS-04 - MEDIUM: no metrics, so no capacity or cost management
**Evidence.** absence. `lib/performance-optimizer.ts` (2,975 B) and
`lib/optimized-data-service.ts` (12,200 B) optimise client behaviour but emit no telemetry.
**Impact:** no way to know which endpoints are slow or expensive, no way to forecast Supabase
usage or cost, and no way to demonstrate the value of optimisations. For a SaaS this directly
blocks credible unit economics (`82_SAAS_BILLING.md`).
**Severity:** MEDIUM | **Confidence:** HIGH

### F-OBS-05 - MEDIUM: no alerting, no SLOs, no on-call
**Evidence.** absence.
**Impact:** an outage is discovered by users. There is no error budget, no burn-rate alerting, and
no defined response. Combined with F-OBS-01, the mean time to detect is unbounded.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-OBS-06 - MEDIUM: a debug table is part of the production schema
**Evidence.** `scripts/17-debug-attendance-with-logging.sql:17` creates `attendance_debug_log`
with **no RLS**, plus a `SECURITY DEFINER` function and a `GRANT INSERT, SELECT ... TO authenticated`.
**Impact:** an unbounded, unprotected internal artefact accumulating in production; it will also
appear in any dump or export.
**Severity:** MEDIUM | **Confidence:** HIGH

## 3. V2 requirements
1. **Observability pipeline:** OpenTelemetry traces + structured logs + metrics, shipped to a
   managed backend; `x-request-id` (or W3C traceparent) generated at the edge and propagated
   through every log line, event, notification and audit record.
2. **Error tracking** with source-map upload, release tagging, and alerting on new-issue
   detection and error-rate thresholds.
3. **RED metrics** (rate, errors, duration) per route, plus business metrics (attendance capture
   rate, notification delivery rate, sync lag) and cost metrics (DB rows, storage bytes, egress,
   AI tokens).
4. **Health endpoints:** `/healthz` (liveness, no dependencies) and `/readyz` (dependency checks),
   used by the platform for deploy gates.
5. **Alerting:** error-budget burn rate, p95 latency, dependency failure, queue depth, DLQ depth,
   backup failure, cost anomaly, and security events.
6. **SLOs** per tenant tier, published internally and (for enterprise) to customers.
7. **Runbooks and on-call** for every alert; post-incident review with a blameless template.
8. **Product analytics**, tenant-scoped and consent-aware, to drive prioritisation and usage-based
   billing.
9. **Delete the debug pages and the debug table**; provide a role-gated, audited diagnostics
   surface instead.

## 4. Verdict
**BUILD NEW.** The gap is total rather than partial: there is effectively no observability, and
the one configuration intended to help (`removeConsole`) actively destroys what little exists.
This is the highest-leverage non-functional gap to close after `13_RLS_SECURITY.md` and
`19_SECRETS.md`, because it is what allowed every other finding to survive.
