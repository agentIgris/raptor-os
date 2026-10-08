# 49 - AUDIT LOGGING
**Audit.md section:** 56 (SECTION 53 - AUDIT LOGGING)

## 1. Direct answer for each action the Audit.md lists
| Sensitive action | Recorded? | Evidence | Severity |
| --- | --- | --- | --- |
| **Salary change** | **NO** | no salary exists (`32_COMPENSATION.md`) | CRITICAL (capability) |
| **Contract change** | **Partially** | `user_agreements` records an acceptance (role, version, IP, UA, timestamp) but **not the content, not a hash, not the author**; the content lives in a world-writable `admin_config` row | HIGH |
| **Roster change** | **NO** | `rosters` has `created_at` only; no actor, no before/after | HIGH |
| **Permission change** | **NO** | `PUT /api/users` records nothing and is **broken** (`app/api/users:140`, undefined RPC); `module_permissions` is never read or written | HIGH |
| **Financial transaction** | **NO** | `slot_expenses`, `winnings`, `tier_defaults` have **no actor column at all** | HIGH |
| **Deletion** | **NO** | no `deleted_at` in use, no actor, no record. A single `DELETE /api/teams/manage` cascades away seven tables' worth of history with no trace | CRITICAL |
| **Data export** | **NO** | the only export produces a client-side PDF; nothing is logged | HIGH |
| **Attendance change** | **Partial** | `attendances.marked_by` exists (a user id) but there is **no `updated_at`, no before/after, and no correction history**; `marked_by` has no `ON DELETE`, so the audit link breaks on user deletion | MEDIUM |
| **Agreement acceptance** | **Yes** | `user_agreements` row with `accepted_at`, `ip_address`, `user_agent`, `status` | — |
| **Discord message sent** | **Partial** | `communication_logs` records the attempt, the payload, the response code and `triggered_by` — but `triggered_by` is **always NULL for bot and trigger-driven flows**, and the table is **publicly insertable** (`13_RLS_SECURITY.md` F-RLS-03) | MEDIUM |
| **Sign-in / sign-out** | **NO** in the app | only Supabase GoTrue's own logs, which are not surfaced; app-side logging is stripped in production | HIGH |
| **Permission denied** | **NO** | 403 responses are not logged | MEDIUM |
| **Admin config change** | **NO** | `admin_config` has no `updated_by`, no `updated_at` | HIGH |
| **Automation execution** | **Partial** | `communication_logs` only; `pg_cron` jobs have no run history | MEDIUM |
| **Tryout decision** | **Partial** | `tryout_selections` has `selected_by` and `selection_date`; `notification_sent` / `discord_notified` are never written | MEDIUM |

**Score: 0 of 15 sensitive action classes is properly audit-logged.**

## 2. Findings

### F-AUD-01 - CRITICAL: there is no audit log
**Evidence.** no `*_audit`, `activity_log`, `change_log` or `event_log` table in any of the 43
SQL files; no `updated_by` column on any table; no application code writes an audit record.
**Impact:** the organisation cannot answer "who changed this, when, and what did it look like
before?" for **any** record. Consequences:
* **Employment disputes** — cannot prove when a player's terms changed or when they were
  auto-marked absent.
* **Financial disputes** — cannot prove who approved a spend or changed a rate.
* **Incident response** — cannot determine what an attacker changed. With no RLS on
  `admin_config` and an unauthenticated purge endpoint, this is a live gap.
* **SaaS enterprise sales** — a security questionnaire asking "do you log administrative actions"
  gets a "no".
* **Compliance** — several regimes require demonstrable controls over access to personal data.
**Severity:** CRITICAL | **Confidence:** HIGH

### F-AUD-02 - HIGH: the one audit-like table is forgeable and unattributed
**Evidence.** `communication_logs` with `FOR INSERT WITH CHECK (true)` granted to `public`
(`database/complete-discord-portal-setup.sql:146-148`); `triggered_by` is `NULL` for all
trigger- and bot-driven flows.
**Impact:** the only record of outbound organisational communication has no evidentiary value:
anyone can write rows, and the real actor is never recorded.
**Severity:** HIGH | **Confidence:** HIGH

### F-AUD-03 - HIGH: production logging is compiled out, so even the accidental audit trail is gone
**Evidence.** `next.config.mjs:8-10` `compiler: { removeConsole: NODE_ENV === 'production' }`.
**Impact:** the `console.log` calls in `lib/secure-profile-creation.ts`, `lib/auth-flow-v2.ts` and
every API route - which between them form a partial record of failures - are removed from
production bundles.
**Severity:** HIGH | **Confidence:** HIGH

### F-AUD-04 - HIGH: the bulk purge leaves no trace
**Evidence.** `app/api/admin/settings:103-130` deletes seven tables and all non-admin users with
the service role, no transaction, no per-statement error check, no audit record, and no
confirmation (`15_API_SECURITY.md` F-API-06).
**Impact:** the most destructive operation in the system is invisible before, during and after.
**Severity:** CRITICAL | **Confidence:** HIGH

### F-AUD-05 - MEDIUM: audit-relevant foreign keys have no `ON DELETE`, so history breaks silently
**Evidence.** `performances.added_by` (`scripts/00:169`), `attendances.marked_by` (`:258`),
`sessions.created_by` (`:238`), `holidays.created_by` (`:273`),
`discord_webhooks.created_by` (`:307`), `communication_settings.updated_by` (`:339`),
`tryout_applications.screened_by` (`SUPABASE_TRYOUTS_SETUP_FIXED:59`),
`tryout_evaluations.evaluator_id` (`:146`), `tryout_selections.selected_by` (`:183`).
**Impact:** deleting a user **fails** on these tables (default `NO ACTION`), so user deletion
cannot complete - and if someone "fixes" it by setting `CASCADE`, the audit links are destroyed
instead. Either way there is no correct option, because the actor reference is a bare FK rather
than an immutable identifier.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** denormalise the actor into the audit record (`actor_id`, `actor_name`,
`actor_role` captured at write time) so history survives the person.

### F-AUD-06 - MEDIUM: no read-access logging either
**Evidence.** no logging of who read what. `GET /api/users` returns every user's PII to coaches
and players (`15_API_SECURITY.md` F-API-07) and nothing records it.
**Impact:** a data subject cannot see who accessed their data (an increasingly common
requirement), and a bulk-read abuse pattern would be invisible.

## 3. V2 requirements
1. **`audit_log`** — append-only: `(id, org_id, occurred_at, actor_type[user|system|integration],
   actor_id, actor_name_snapshot, actor_role_snapshot, action, resource_type, resource_id,
   scope, before, after, reason, correlation_id, ip, user_agent)`. No UPDATE or DELETE grant for
   any application role; retention 7 years for employment-related classes.
2. **Written in the same transaction as the change** — via an application service, or a
   `SECURITY DEFINER` trigger that captures the actor from `auth.uid()`.
3. **Covered classes:** authentication events, authorisation denials, all reads of sensitive
   tables, all writes, all exports, all permission changes, all configuration changes, all
   automation executions, all administrative actions, and all data-subject requests.
4. **Separate security log** for authentication failures, rate-limit hits, privilege escalation
   attempts and anomaly detection, with alerting.
5. **Actor denormalised** so history survives deletion of the person.
6. **Queryable by the organisation's own admins** for their own tenant, and by the platform
   operator only via a separate, audited path.
7. **Tested**: a CI test that asserts every mutating endpoint writes an audit record.

## 4. Verdict
**BUILD NEW as a platform primitive.** Without it, the product cannot pass an enterprise security
review, cannot support employment or financial disputes, and cannot be operated safely.
