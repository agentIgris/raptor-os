# 44 - WORKFLOWS
**Audit.md section:** 51 (SECTION 48 - WORKFLOW ENGINE)

## 1. Existing automation, reconstructed as Event -> Condition -> Action

| # | Event | Condition | Action | Where | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | `slots` INSERT | none | INSERT into `slot_expenses` with `total = rate x number_of_slots` | trigger `create_slot_expense()` `automation-scripts/04:12-32` | working |
| 2 | `slots` INSERT | `communication_settings.auto_slot_create` enabled for the team | build a Discord embed and POST it | trigger `trigger_slot_creation_notification()` `automation-scripts/03:131-176` | working, but performs outbound HTTP **inside a transaction** |
| 3 | `rosters` UPDATE | `auto_roster_update` enabled | build a Discord embed and POST it | trigger `trigger_roster_update_notification()` `automation-scripts/03:177-221` | same |
| 4 | `performances` INSERT | `NEW.slot_id IS NOT NULL` | INSERT into `attendances` (dedup by `player_id` + `slot_id` in later versions) | triggers `create_auto_attendance*` / `create_match_attendance_from_performance` | **4 to 6 competing definitions** (`15_DATABASE_QUALITY.md` §3) |
| 5 | `pg_cron` daily | team has a `practice_session_config` row; not a holiday | INSERT `sessions` for each recurring window | `generate_daily_practice_sessions(date)` `automation-scripts/02:38-86` | **not idempotent** — no unique constraint |
| 6 | `pg_cron` periodic | a session's `cutoff_time` has passed and the player has not checked in | UPDATE `attendances.status = absent` | `auto_mark_absent_after_cutoff()` `automation-scripts/02:88-140` | working; **but the cutoff time lives in a table with no RLS** |
| 7 | `pg_cron` periodic | `communication_logs.timestamp` older than N days | DELETE those log rows | `cleanup_old_discord_logs(days)` `automation-scripts/03:113-124` | working; **callable by `anon`** |
| 8 | `pg_cron` monthly | none | roll up `team_monthly_stats` | `automation-scripts/06` | derived table, no guarantee of consistency |
| 9 | `users` UPDATE | profile fields changed | mirror into `profiles` | trigger `sync_user_profile_data()` `automation-scripts/01:21-41` | working; `profiles` is a redundant table |
| 10 | `users` UPDATE | `coach_id` is not a user with `role='coach'` | `RAISE EXCEPTION` | trigger `validate_coach_assignment()` `automation-scripts/01:57-73` | working — a genuine integrity rule |
| 11 | `performances` INSERT | `slot_id` does not exist | `RAISE EXCEPTION` | trigger `validate_performance_entry()` (4 versions) | working but redefined 4 times |
| 12 | `tryout_applications` INSERT | none | `UPDATE users … WHERE id = NEW.id` | trigger `sync_tryout_to_profile()` `automation-scripts/04:39-53` | **no-op** — `NEW.id` is the application id, not a user id |
| 13 | `users` UPDATE | none | set `updated_at` | trigger `update_updated_at_column()` `automation-scripts/01:12-18` | working |
| 14 | Any authenticated request | Discord portal `send` pressed | POST a message; log the attempt; allow manual retry | `app/api/discord-portal/send` -> `sendToDiscord()` | working |
| 15 | Authentication | role requires an agreement and none is current | redirect to `/agreement-review` | `lib/auth-flow-v2.ts:366-372` | working, but **fails open** |
| 16 | New sign-up | no `users` row exists | INSERT a `users` row with `pending_player` | `SecureProfileCreation.createProfile()` | **likely broken** (no INSERT policy) |

## 2. Assessment against the Audit.md question

### F-WFL-01 - HIGH: automation is hard-coded trigger logic, not a workflow engine
**Evidence.** all 16 flows above are code or trigger definitions. There is no
`workflow_definitions`, `workflow_steps`, `conditions`, `actions` or `executions` table; no
tenant scoping; no enable/disable beyond 9 booleans; no versioning; no dry-run.
**Impact:** a SaaS customer cannot define or change a workflow. Every new automation is a code
change and a migration. This is the single biggest structural obstacle to serving many
organisations with different processes.
**Severity:** HIGH | **Confidence:** HIGH

### F-WFL-02 - HIGH: automation runs inside database transactions and calls external services
**Evidence.** `trigger_slot_creation_notification()` and `trigger_roster_update_notification()` are
`SECURITY DEFINER` triggers that `INSERT` a `communication_logs` row **and** the notification
path posts to Discord. `plpgsql` has no HTTP client, so these functions necessarily either rely
on `pg_net`/`http` extensions or delegate; either way the business transaction now depends on an
external service.
**Impact:** a Discord outage can slow or fail slot creation and roster updates. There is no
outbox, so a failed notification is unrecoverable. The log row is written inside the same
transaction, so if the transaction rolls back the log disappears too - and if it commits while
the send failed, the log claims a delivery that never happened.
**Severity:** HIGH | **Confidence:** MEDIUM-HIGH

### F-WFL-03 - HIGH: no execution log, no idempotency, no observability
**Evidence.** `communication_logs` is the only execution record, it is publicly forgeable
(F-RLS-03), and `triggered_by` is NULL for all trigger-driven flows. `pg_cron` jobs have no run
history. `generate_daily_practice_sessions` has no unique constraint so a retry duplicates rows.
**Impact:** an operator cannot answer "did the automation run, what did it do, and will it run
again?". Re-running is unsafe.
**Severity:** HIGH | **Confidence:** HIGH

### F-WFL-04 - MEDIUM: workflows are not tenant-scoped
**Evidence.** every function takes a bare `team_id` or `date`; there is no `org_id`. The
`communication_settings` scope is `team_id` with `NULL` meaning global.
**Impact:** in a multi-tenant system every automation must be re-expressed per tenant, and
`NULL`-as-global will collide across organisations.
**Severity:** MEDIUM | **Confidence:** HIGH

## 3. Can the architecture eventually support a generic workflow engine?
**Yes, but not from this foundation — the current code must be discarded, not extended.**

What is worth keeping: the *identification* of which business events matter (slot booked, roster
changed, attendance overdue, tryout applied, contract version bumped, invoice paid) and the
*shape* of the actions (notify, create a record, compute, schedule).

What must be replaced: the execution substrate. The target design (`90_DOMAIN_ARCHITECTURE.md`,
Workflow domain) is:

```
Event (from the transactional outbox)
  -> NotificationRule match   (event_type, scope, conditions)
      -> Channel (in_app | email | discord | push | webhook)
          -> Recipient resolution (person, role, team, membership, subscription)
              -> Delivery (idempotent, retryable, DLQ, read receipt)

WorkflowDefinition (versioned, tenant-owned)
  -> trigger: event_type + filter (JSONLogic)
  -> steps: [] of { condition, action }
  -> Action types: create_record | update_field | notify | assign_work_item |
                   request_approval | call_integration | schedule | http_webhook
  -> WorkflowExecution (per run: inputs, step results, timings, errors, DLQ)
  -> idempotency key, concurrency limit, circuit breaker
```

Design rules learned from this audit's failures: no side effect inside a business transaction;
every execution recorded; every action idempotent; every workflow tenant-scoped and versioned;
every action individually permission-checked; and no workflow able to bypass the permission
engine.

## 4. Verdict
**ARCHIVE the trigger-based automation; BUILD a workflow domain.** Keep the event catalogue
(`77_EVENT_ARCHITECTURE.md`) and the three genuinely valuable rules (slot-expense calculation,
cutoff-based auto-absent, coach-role validation) as the first built-in workflows.
