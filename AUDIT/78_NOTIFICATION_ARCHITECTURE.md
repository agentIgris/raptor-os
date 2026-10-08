# 78 - NOTIFICATION ARCHITECTURE (conceptual - NOT implemented)
**Audit.md section:** 85 (SECTION 82)
Target model, per Audit.md: `Event -> Notification Rule -> Channel -> Recipient`.

## 1. Where the legacy system is, and why it must be replaced
Notifications are a single per-team boolean per event class, delivered only to Discord, with a
forgeable log and no read state (`24_NOTIFICATIONS.md`). The target separates four concerns the
legacy conflates:
**what happened** (event) · **who should know** (rule) · **how** (channel) · **who, exactly**
(recipient).

## 2. The model
```
Event (77_EVENT_ARCHITECTURE.md)
  |
  v
NotificationRule                 (org-scoped, versioned, tenant-configurable)
  id, org_id, name, event_topics[], scope_type, scope_id,
  recipient_strategy, channel_policy, urgency, digest_mode, quiet_hours,
  template_key, enabled, priority, valid_from, valid_to
  |
  +-- RecipientStrategy         (how the audience is resolved)
  |     explicit_people | role | team_members | team_staff | department |
  |     engagement_type | document_parties | obligation_owner | reporter |
  |     custom_expression (bounded, audited)
  |
  +-- ChannelPolicy             (per-recipient, so a person can be on different channels)
  |     in_app (always on) | email | discord | push | sms (critical only) | webhook
  |     each with: enabled, min_urgency, digest_mode (immediate | hourly | daily | weekly),
  |     template_key, locale
  |
  v
Notification (one per recipient x channel)
  id, org_id, event_id, rule_id, recipient_person_id, channel,
  template_key, locale, urgency, status, scheduled_at, sent_at, read_at,
  attempts, last_error, dedupe_key, correlation_id
  |
  +-- Channel adapters: InApp | Email | Discord | Push | Sms | Webhook
```

## 3. Recipients
* Resolution is **permission-aware**: a rule may only resolve recipients the creating actor could
  already notify. A rule must never become a data-leak vector by resolving a broader audience than
  the creator can see.
* `NotificationPreference` per person per channel per event class, with quiet hours in the
  person's own timezone, a digest mode, and a mandatory floor: **a person can always receive
  anything concerning them personally** (their contract, their pay, their roster change, their
  attendance dispute) regardless of their preferences.
* Unsubscribe applies only to non-transactional classes; transactional notices cannot be
  unsubscribed (and must not be, for legal reasons).

## 4. Channels
| Channel | Requirement |
| --- | --- |
| **In-app** | always available; a notification centre with unread state, filters, and per-item deep links; the only channel that can be guaranteed to reach a logged-in user |
| **Email** | per-tenant sending domain with DKIM/DMARC; templated, versioned, with the rendered content and hash stored; bounce and complaint handling with automatic suppression (`23_EMAIL.md`) |
| **Discord** | bot per tenant, explicit channel mapping, derived identity, no webhook URLs in the client (`76_INTEGRATIONS.md` §4) |
| **Push** | web push with VAPID, opt-in, quiet hours; requires a service worker (`58_MOBILE.md` F-MOB-06) |
| **SMS** | time-critical operational alerts only; never contractual notices |
| **Webhook** | per-tenant subscriptions with a signed payload, a delivery log, retries and a DLQ |

## 5. Delivery guarantees
* **At-least-once** with an idempotent adapter; a `dedupe_key` per (event, recipient, channel).
* Retries with exponential backoff and jitter; a dead-letter queue after N attempts; alerting on
  DLQ depth.
* **No notification is sent from inside a business transaction** - the outbox is the only path
  (`44_WORKFLOWS.md` F-WFL-02).
* Every attempt is written to `notification_deliveries` with the adapter response, and is
  **immutable** (no update or delete grant) so it has evidentiary value for a sponsor or a legal
  dispute.
* `read_at` is recorded for in-app and, where the provider supports it, for email.

## 6. Templating
* `NotificationTemplate` per (event topic, channel, locale), versioned, with variables validated
  against a schema at publish time.
* **No free-form user input in a template without escaping**, and length limits per channel
  (Discord: description 2560, field 1024) - the legacy system truncates ad hoc and omits limits
  elsewhere (`24_NOTIFICATIONS.md` F-NOT-05).
* `allowed_mentions` explicitly configured on Discord sends.
* The rendered content is stored with the notification, so "what exactly were they told" is
  answerable forever.

## 7. Default rules seeded per tenant
| Event | Default audience | Channel | Urgency |
| --- | --- | --- | --- |
| `agreement.reconsent.required` | the person | in-app + email | high |
| `document.expiring` (contract) | contract parties + Legal | in-app + email | high |
| `hr.offboarding.started` | HR + the manager | in-app | normal |
| `roster.changed` | affected people + team staff | in-app; Discord if enabled | high |
| `attendance.auto_marked` (absent) | the person | in-app | normal |
| `attendance.disputed` | team manager | in-app + email | high |
| `tryout.application.received` | assigned staff | in-app | normal |
| `tryout.decision.made` | the applicant (via the appropriate channel) | in-app + email | high |
| `sponsor.deliverable.due` (with lead time) | obligation owner + Partnerships | in-app + email | high |
| `sponsor.deliverable.rejected` | obligation owner | in-app + email | high |
| `invoice.overdue` | Finance + the partner contact | in-app + email | high |
| `prize.payout.paid` | each recipient | in-app + email | high |
| `travel.document.expiring` | the traveller + Travel coordinator | in-app + email | critical |
| `work_item.overdue` | assignee + owner | in-app | normal |
| `security.authorization.denied` (repeated) | the security log only | - | - |

## 8. Preference and volume management
* Per-person digest mode with a tenant-configurable send window in the **recipient's** timezone.
* Mandatory classes cannot be digested away.
* A hard per-tenant daily send budget with a queue, so a noisy rule cannot exhaust the provider or
  annoy a whole organisation.
* A global "quiet hours" default plus a per-person override.

## 9. Migration from the legacy system
* The 9 `communication_settings` booleans become the seed for a small set of default rules, with
  the semantics corrected (`team-scoped, opt-out` -> `person-resolved, opt-in` with mandatory
  floors).
* Discord moves from webhook to bot; all webhook URLs are rotated.
* `communication_logs` becomes `notification_deliveries` - and because the legacy log is publicly
  forgeable (`13_RLS_SECURITY.md` F-RLS-03), **historic rows must be marked
  `provenance_unverified`** rather than migrated as trusted evidence.

## 10. Verdict / status
**CONCEPTUAL.** This is the design that replaces the single-channel hack, and it is a
prerequisite for almost every other domain, because almost every domain needs to tell somebody
something.
