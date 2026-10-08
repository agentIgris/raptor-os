# 42 - COMMUNICATIONS
**Audit.md section:** 49 (SECTION 46 - COMMUNICATIONS)

## 1. Integration inventory
| Channel | Direction | Implemented | Auth | Secrets held |
| --- | --- | --- | --- | --- |
| **Discord (outbound)** | App to Discord | Yes | user session + role | webhook URLs, plaintext, returned by APIs |
| **Discord (inbound)** | Bot to App | Partially, mostly broken | one static shared key | RAPTOR_BOT_API_KEY |
| **Slack** | - | **No** | - | - |
| **Email** | - | **No** | - | SMTP_* documented but unused |
| **Google Calendar / Microsoft Calendar** | - | **No** | - | - |
| **WhatsApp / SMS** | - | **No** | - | - |
| **Generic outbound webhooks to tenants** | - | **No** | - | - |

## 2. System-of-record data vs communication data
This distinction is the core question Audit.md section 46 asks, and the legacy system answers it
incorrectly:

**Correct classification (as implemented):**
| Data | Where it should live | Where it actually lives |
| --- | --- | --- |
| Which webhook / channel to notify | Integration configuration | `discord_webhooks` - correct, but **unencrypted and world-readable** |
| Whether a notification was attempted | Delivery/audit log | `communication_logs` - correct intent, but **publicly forgeable** and `triggered_by` is always NULL for bot actions |
| Whether the notification was delivered | Delivery status | only in the Discord response code |
| The authoritative business fact (a roster change, a selection, a payment) | The transactional database | correct in principle (the trigger fires from the DB) |
| Whether a human **read** the notification | Read receipt | **absent** |
| A conversation or a thread | Communication platform | correctly **not** in the app |

**Incorrectly treated as communication data (should be system of record):**
* **Attendance decisions.** The "notification" *is* the record. `auto_mark_absent_after_cutoff()`
  writes `attendances.status` from a database trigger, and the Discord message is only a
  notification of it. If the Discord send fails, the absence still stands - correctly - but there
  is no acknowledgement loop, so a player who disputes it has no channel other than Discord
  itself.
* **Tryout stage transitions.** `tryout_applications.phase` and `tryout_selections` are the
  record; `notification_sent` / `discord_notified` are flags that **nothing ever writes**
  (`database/SUPABASE_TRYOUTS_SETUP_FIXED.sql:173-174`). A candidate can be selected and never
  told.

**Incorrectly treated as system-of-record data (should be communication data):**
* `communication_settings.setting_key` / `setting_value` encodes notification policy in the
  transactional database, with no tenant scoping and no `CHECK` constraint. Notification policy
  belongs in a rules engine, not a boolean column.
* `admin_config.default_public_webhook_id` is a *communication* concern stored in a
  world-writable configuration table.

## 3. Findings

### F-COM-01 - HIGH: one channel, no delivery guarantees, no read state
Covered in `24_NOTIFICATIONS.md` F-NOT-01, F-NOT-04. Communication is a single, opt-in,
per-team, Discord-webhook hack with a forgeable log and no acknowledgement loop.

### F-COM-02 - HIGH: the authoritative facts are correct, but nothing tells anyone
**Evidence.** the DB triggers (`trigger_slot_creation_notification`,
`trigger_roster_update_notification`) fire from inside a transaction and make an **outbound HTTP
call to Discord** (`automation-scripts/03:131-218`). If the call fails, the transaction has
already committed the business change and the notification is simply lost - and the failure is
recorded only in a log row that is publicly forgeable and has no `triggered_by`.
**Impact:** the organisation's records and its communications can diverge silently and
permanently. For a roster change or a selection, "we thought we told them" is not a defensible
position.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** a transactional outbox (`77_EVENT_ARCHITECTURE.md`) so the business change and
the intent to notify commit atomically, and delivery happens asynchronously with retry, DLQ and
alerting.

### F-COM-03 - MEDIUM: no calendar integration, so scheduling is invisible outside the product
**Evidence.** absence. `sessions` (training) and `holidays` exist in the app only.
**Impact:** players and staff must check the product for the schedule; a session created in the
product never appears in a player's calendar, and a meeting booked in a calendar never appears in
the product. This is the most requested integration in team software.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-COM-04 - MEDIUM: no Slack, and no generic outbound webhook
**Evidence.** absence.
**Impact:** organisations that run on Slack cannot receive notifications; and there is no way for
a tenant to push events into their own systems (BI, ERP, data warehouse) - which materially
limits enterprise adoption.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-COM-05 - MEDIUM: the communication channel is chosen by the organisation, not the recipient
**Evidence.** `communication_settings` is keyed on `team_id` + one of 9 booleans
(`app/api/discord-portal/settings:147-164`); there is no per-user channel preference, no
per-user quiet hours, and no per-recipient address.
**Impact:** "this player does not use Discord, notify them by email" is inexpressible. Delivery
success is therefore unmeasurable per person.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** `78_NOTIFICATION_ARCHITECTURE.md`.

## 4. Verdict
**REPLACE the mechanism, KEEP the intent.** The observation that business facts must commit
atomically and notifications must be delivered asynchronously is correct and worth preserving. The
implementation - a boolean per team and a plaintext webhook URL - must be replaced by an
event/outbox pipeline, a per-tenant notification-rule engine, and per-recipient channel
preferences across in-app, email, Discord and (later) push.
