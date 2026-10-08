# 77 - EVENT ARCHITECTURE (conceptual - NOT implemented)
**Audit.md section:** 84 (SECTION 81)

## 1. Design rules learned directly from this audit
1. **A business fact and the intent to react to it must commit atomically.** The legacy system
   performs outbound HTTP inside a database transaction
   (`automation-scripts/03:131-221`) and logs deliveries in the same transaction, so a failure
   loses the notification and a rollback loses the log (`44_WORKFLOWS.md` F-WFL-02,
   `42_COMMUNICATIONS.md` F-COM-02).
2. **Every event is immutable and gets a monotonic `occurred_at` plus a record id.** No
   corrections; corrections are new events.
3. **Every consumer is idempotent and at-least-once.** Duplicates are expected.
4. **Every consumer is independently retryable** with backoff, jitter and a dead-letter queue.
5. **Events carry no PII beyond what the consumer needs**, and consumers are authorised at
   consumption time, not at publication time.
6. **Events are tenant-scoped** and the tenant id is part of the event, never inferred by the
   consumer.

## 2. Mechanism: transactional outbox
```
Business transaction
  ├─ writes the domain rows
  └─ writes `outbox_events(org_id, topic, payload, occurred_at, dedupe_key)`  [same transaction]
        |
        v
  Outbox relay (polling or LISTEN/NOTIFY)
        ├─ claims a batch (FOR UPDATE SKIP LOCKED)
        ├─ publishes to the transport (Postgres queue table, or a managed queue)
        └─ marks published
              |
              v
  Consumers (each independent, each with its own retry + DLQ)
        ├─ NotificationEngine  -> 78_NOTIFICATION_ARCHITECTURE.md
        ├─ Analytics projector -> warehouse / analytical schema
        ├─ WorkflowEngine     -> 44_WORKFLOWS.md
        ├─ IntegrationSync    -> 76_INTEGRATIONS.md
        ├─ Search indexer     -> 47_SEARCH.md
        └─ Read-model updaters (dashboards, counters)
```
The outbox is the **only** legitimate path from a domain fact to the outside world. Nothing
sends an email, a Discord message or a webhook from inside a request handler or a trigger.

## 3. Event catalogue
Topics are `domain.entity.action.vN`. The `Audit.md` examples are included and marked.

### Identity and Organization
| Topic | Triggered by | Consumers |
| --- | --- | --- |
| `identity.person.created.v1` | person provisioned | notifications, search |
| `identity.person.merged.v1` | duplicate merge | search, analytics |
| `org.organization.created.v1` | signup completes an org | provisioning workflows, billing |
| `org.member.invited.v1` | invite issued | email, notifications |
| `org.member.joined.v1` | invite accepted | notifications, audit |
| `org.member.suspended.v1` / `left.v1` | status change | notifications, access revocation |
| **`org.role.assigned.v1` / `revoked.v1`** | `MemberRole` change | notifications, **security log**, session invalidation |
| `org.settings.changed.v1` | configuration change | audit, caches |

### People and HR
`people.engagement.started.v1` · `people.engagement.ended.v1` · `people.engagement.changed.v1` ·
`hr.onboarding.step.completed.v1` · `hr.onboarding.completed.v1` ·
**`hr.offboarding.started.v1`** (drives asset recovery and access revocation) ·
`hr.leave.requested.v1` / `approved.v1` / `declined.v1` ·
`hr.review.completed.v1` · `hr.probation.decision.v1` ·
`hr.document.expiring.v1` (right-to-work, insurance, safeguarding training)

### Contracts and documents
`document.version.published.v1` · **`document.expiring.v1`** (Audit.md's `ContractExpiring`) ·
`document.expired.v1` · `document.approved.v1` · `document.reconsent.required.v1` (a new version
was published) · `document.signed.v1` / `signature.requested.v1` / `signature.declined.v1` ·
**`agreement.accepted.v1`** (carries `document_version_id` **and `content_sha256`**) ·
`agreement.declined.v1`

### Competitive
`team.created.v1` / `updated.v1` / `archived.v1` ·
**`roster.changed.v1`** (Audit.md's `RosterChanged`; carries added/removed/role-change details) ·
`team_staff.changed.v1` · `competition.created.v1` / `registered.v1` /
`entry.purchased.v1` (the migrated legacy slot rule) · `match.scheduled.v1` ·
**`match.completed.v1`** (Audit.md's `MatchCompleted`; carries the result) ·
`match.result_ingested.v1` (from a provider or OCR) · `match.result_amended.v1` ·
`result.entry_submitted.v1` / `rejected.v1` (duplicate or validation failure) ·
`standings.recalculated.v1`

### Training and attendance
`session.scheduled.v1` / `updated.v1` / `cancelled.v1` · `session.started.v1` / `completed.v1` ·
`attendance.marked.v1` · **`attendance.auto_marked.v1`** (the cutoff rule) ·
`attendance.amended.v1` (a correction, with before/after) · `attendance.disputed.v1` ·
`attendance.verified.v1` · `schedule.conflict.v1` (a player double-booked)

### Recruitment
`tryout.created.v1` / `launched.v1` / `closed.v1` · `tryout.application.received.v1` ·
`tryout.application.screened.v1` · `tryout.invitation.sent.v1` / `accepted.v1` / `declined.v1` /
`expired.v1` · `tryout.session.scheduled.v1` / `completed.v1` ·
`tryout.evaluation.submitted.v1` · **`tryout.decision.made.v1`** ·
`tryout.offer.sent.v1` / `accepted.v1` / `declined.v1` / `expired.v1` ·
`tryout.candidate.hired.v1` (creates the Employment) · `applicant.data.erase_requested.v1`

### Commercial
`partner.created.v1` · `lead.created.v1` / `qualified.v1` / `lost.v1` ·
`deal.stage_changed.v1` · `deal.won.v1` / `lost.v1` · `proposal.sent.v1` / `accepted.v1` /
`declined.v1` · `contract.signed.v1` ·
**`sponsor.deliverable.created.v1`** (an obligation from a signed contract) ·
**`sponsor.deliverable.due.v1`** (Audit.md's `SponsorDeliverableDue`, with a lead time) ·
`sponsor.deliverable.submitted.v1` / `approved.v1` / `rejected.v1` / `waived.v1` ·
**`sponsor.deliverable.published.v1`** (the proof event) ·
`sponsor.report.generated.v1` · `inventory.sold.v1` / `released.v1` · `exclusivity.conflict.v1`

### Finance
`invoice.issued.v1` · **`invoice.paid.v1`** (Audit.md's `InvoicePaid`) / `overdue.v1` /
`voided.v1` · `payment.received.v1` / `failed.v1` · `expense.submitted.v1` / `approved.v1` /
`rejected.v1` / `reimbursed.v1` · **`prize.income.recorded.v1`** (triggers the allocation engine) ·
`prize.allocated.v1` · `prize.payout.initiated.v1` / `paid.v1` / `failed.v1` ·
`budget.approved.v1` / `variance.threshold_exceeded.v1` · `period.closed.v1` ·
`payroll.period_locked.v1` / `approved.v1` / `paid.v1`

### Creators and content
**`creator.metric_updated.v1`** (Audit.md's `CreatorMetricUpdated`, a `MetricSnapshot`) ·
`creator.linked.v1` / `unlinked.v1` · `creator.ratecard.changed.v1` ·
`content.idea.created.v1` / `briefed.v1` / `submitted.v1` / `review_requested.v1` /
**`approved.v1`** / `rejected.v1` / `scheduled.v1` · **`content.published.v1`** ·
`content.metric_updated.v1` · `content.disclosure_recorded.v1`

### HR / people lifecycle (Audit.md's `EmployeeOnboarded`)
**`employee.onboarded.v1`** (emitted by the onboarding checklist when complete) ·
`employee.role_changed.v1` · `employee.terminated.v1`

### Operations
`asset.created.v1` / `assigned.v1` / `returned.v1` / `reported_lost.v1` / `retired.v1` ·
`maintenance.completed.v1` · `space.booked.v1` / `cancelled.v1` ·
`travel.plan.created.v1` · **`travel.document.expiring.v1`** (visa, passport, insurance) ·
`travel.traveller.checked_in.v1` · `travel.expense.submitted.v1` ·
`work_item.created.v1` / `assigned.v1` / `due_soon.v1` / `overdue.v1` / `completed.v1` /
**`approval.requested.v1`** / `approved.v1` / `rejected.v1`

### Platform
`user.signed_in.v1` / `signed_out.v1` / `failed.v1` / `mfa_enrolled.v1` ·
`user.password_reset_requested.v1` / `completed.v1` · `authorization.denied.v1` (security log) ·
`rate_limit.exceeded.v1` · `data.export_requested.v1` / `completed.v1` ·
**`data.erasure_requested.v1` / `completed.v1`** ·
`integration.failed.v1` / `reconnected.v1` · `notification.delivered.v1` / `failed.v1` /
`read.v1` · `workflow.execution.started.v1` / `completed.v1` / `failed.v1` · `dlq.item.v1`

## 4. Event schema (normative)
```
{
  id:                uuid,            -- stable; the idempotency key for consumers
  org_id:            uuid,            -- REQUIRED, never inferred
  topic:             text,            -- 'domain.entity.action.v1'
  occurred_at:       timestamptz,     -- UTC, set by the database
  recorded_at:       timestamptz,     -- UTC
  actor_type:        'user' | 'system' | 'integration',
  actor_id:          uuid | null,
  correlation_id:    uuid,            -- ties the event to the request and the audit log
  causation_id:      uuid | null,     -- the event that caused this one
  dedupe_key:        text,            -- UNIQUE per org; makes retries safe
  payload:           jsonb,           -- minimal; no PII beyond consumer need
  schema_version:    int
}
```
Rules: `payload` carries **identifiers, not documents**; consumers fetch what they need under
their own permissions; `payload` never carries money totals, contract terms or personal data
that the consumer may not read.

## 5. Ordering, retention and replay
* **Ordering:** per-aggregate ordering is guaranteed by `(org_id, aggregate_id, sequence)`; global
  ordering is not, and consumers must be order-independent.
* **Retention:** the outbox is truncated after a confirmed window (e.g. 30 days); the
  `event_log` (immutable, append-only) retains events for the analytics/audit horizon
  (e.g. 25 months) and is the source for replay.
* **Replay:** a replay tool per tenant, with a date range and a topic filter, is an **audited
  admin action**.

## 6. Migration from the legacy system
There is no event layer. The 16 existing automations (`44_WORKFLOWS.md` §1) should be re-expressed
as event consumers:
* `create_slot_expense` becomes a consumer of `competition.entry.purchased.v1`.
* `create_auto_attendance` becomes a consumer of `match.completed.v1`.
* `auto_mark_absent_after_cutoff` becomes a scheduled query that emits
  `attendance.auto_marked.v1`.
* `trigger_*_notification` become notification consumers.
* `validate_coach_assignment` and `validate_performance_entry` become **domain invariants enforced
  in the service and at the database**, not automations.
* `sync_tryout_to_profile` is **deleted** (`29_TRYOUTS.md` F-TRY-05).
