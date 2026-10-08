# 24 — NOTIFICATIONS
**Audit.md section:** 31 (SECTION 28 — NOTIFICATION SYSTEM)

## 1. Channel inventory

| Channel | Implemented? | Mechanism | Evidence |
| --- | --- | --- | --- |
| **Discord (outbound)** | **Yes** | `sendToDiscord()` → Discord webhook; 12 message types; per-team/global automation toggles | `modules/discord-portal/*`; `app/api/discord-portal/send` |
| **Discord (inbound commands)** | **Partially** | RaptorBot → 13 HTTP endpoints | `app/api/discord/**` (5 of 13 provably broken) |
| **In-app notifications** | **NO** | — | no notifications table, no bell, no inbox component; `components/ui/sonner.tsx` is **dead code** and `sonner` is an unused dependency |
| **Toast messages** | Yes, but ephemeral | shadcn `useToast` | `hooks/use-toast.ts`; used for local action feedback only |
| **Email** | **NO** | — | `23_EMAIL.md` |
| **Push / mobile** | **NO** | — | no service worker, no web-push, no `manifest.json`, no `next-pwa`; `public/` has no PWA assets |
| **SMS / WhatsApp** | **NO** | — | — |
| **Webhooks (outbound to tenants)** | **NO** | — | no outbound webhook subscription model |
| **Calendar invites** | **NO** | — | no iCal/Google Calendar integration |

## 2. Event sources (what can currently trigger a notification)

| Trigger | Path | Implemented? | Notes |
| --- | --- | --- | --- |
| Slot created | DB trigger `trigger_slot_creation_notification` → `auto_slot_create` | **Yes** | outbound HTTP from inside a Postgres transaction |
| Roster updated | DB trigger `trigger_roster_update_notification` → `auto_roster_update` | **Yes** | same |
| Performance summary | `performance_summary` message type | **Partial** | manual send from `/dashboard/discord-portal`; no automatic trigger |
| Attendance summary | `attendance_summary` | **Partial** | manual |
| Daily summary | `auto_daily_summary` | **Partial** | `pg_cron` job exists (`automation-scripts/06`); the toggle defaults to `false` |
| Weekly digest | `auto_weekly_digest` | **Partial** | same |
| Expense / winnings summary | `expense_summary`, `winnings_summary` | **Manual only** | explicitly `null` in the automation map (`sendToDiscord.ts:253-255`) |
| Analytics trend | `analytics_trend` | **Manual only** | same |
| System alert | `auto_system_alerts` | **Partial** | global toggle only |
| Data cleanup | `auto_data_cleanup` | **Partial** | global toggle only |
| Tryout application received | `app/api/discord/tryout/apply` returns `embed_data` for the **bot** to post | **Yes (bot-side)** | the app does not itself deliver |
| Tryout invited / evaluated / announced | bot endpoints return `embed_data` | **Partial** | bot-side rendering; embeds are mojibake |
| **Agreement status change** | — | **NO** | |
| **Contract / roster / role change** | — | **NO** | |
| **Payment / prize money** | — | **NO** | |
| **Session scheduled / changed** | — | **NO** | |
| **Selection or rejection** | `tryout_selections.notification_sent` / `discord_notified` flags exist | **Flag only** | **no notification is ever sent** — the flags are set by nothing |

## 3. Findings

### F-NOT-01 — HIGH: notification is a single-channel, opt-in, organisation-wide hack
**Finding.** Notifications exist only as Discord webhook posts, gated by per-team boolean
toggles that default to `false` (`automation-scripts/04:375-400`
`initializeTeamAutomationSettings` inserts every key with `setting_value: false`).
**Evidence.** `modules/discord-portal/sendToDiscord.ts:56-68` — if `isAutomatic && teamId`, the
automation key must be enabled or the send is refused.
**Impact.**
* Out of the box, **nothing is ever sent automatically**; an administrator must enable each
  toggle per team.
* A user who is not on Discord receives nothing at all.
* There is no per-user preference, no per-event channel selection, no digest/batching, no
  quiet hours, no urgency, and no read/unread state.
* Notification is bound to a **team**, not to a **person** — so "notify the player who was
  selected" is not expressible.
**Severity:** HIGH · **Confidence:** HIGH

### F-NOT-02 — HIGH: no notification for any of the events that matter commercially or legally
**Finding.** Contract changes, roster changes, role changes, selection/rejection, prize-money
payment, payroll, invoice events, document expiry — none produce a notification.
**Evidence.** absence; the only adjacent artefact is the unused
`tryout_selections.notification_sent` / `discord_notified` boolean pair
(`database/SUPABASE_TRYOUTS_SETUP_FIXED.sql:173-174`), which no code writes.
**Impact:** in an esports organisation, the failure to notify a player of a contract change or a
prize-money payment is a direct legal and relationship risk. In a SaaS context, silent state
changes destroy user trust and drive support load.
**Severity:** HIGH · **Confidence:** HIGH

### F-NOT-03 — MEDIUM: `communication_settings` cannot express per-recipient or per-event rules
**Evidence.** `communication_settings(team_id, setting_key, setting_value boolean)`
(`scripts/00:330-341`). The key is one of 9 fixed values
(`app/api/discord-portal/settings:147-157`); there is no `TO` clause for events and no
recipient column.
**Impact:** the model is "team X has daily summaries on/off". It cannot express "notify the
coach of their team", "notify players on a roster change but not staff", "escalate to a manager
if unacknowledged within 24 h", or "digest at 09:00 local time in the recipient's timezone".
**Severity:** MEDIUM · **Confidence:** HIGH

### F-NOT-04 — MEDIUM: no delivery guarantee, no read state, no escalation
**Evidence.** `sendToDiscord.ts:150-158` inserts a log row after the attempt;
`:160-171` returns success if **at least one** webhook succeeded — partial failure is invisible
to the caller. `retryFailedMessage` is manual only.
**Impact:** no guarantee that a notification reached anyone; no acknowledgement loop; no
escalation; no dead-letter alerting. For anything legally significant this is insufficient.
**Severity:** MEDIUM · **Confidence:** HIGH

### F-NOT-05 — MEDIUM: notification content is unescaped and unlimited
**Evidence.** `modules/discord-portal/embeds.ts` builds embeds from caller-supplied `data` with
no length clamping beyond the ad-hoc `.substring(0, 200)` / `.substring(0, 1024)` in
`app/api/discord/tryout/{evaluate,list,status}` and `public/submit/*`. Discord enforces
description ≤ 2560 and field value ≤ 1024; exceeding it silently drops the embed.
**Impact:** a long player note or evaluation breaks the notification; a crafted value could be
used for mention-spam via `@everyone` injection (Discord suppresses `@everyone` in webhooks
without `allowed_mentions`, which is not set anywhere — `sendToDiscord.ts:98-103`).
**Severity:** MEDIUM · **Confidence:** MEDIUM

### F-NOT-06 — MEDIUM: the "AI insights" in analytics are heuristics presented as intelligence
**Evidence.** commit `ff9d767` "Analytics: enrich AI insights with detailed, actionable
recommendations"; `7edd1ce` "add AI-style heuristic insights". The insights are computed in
`components/analytics/analytics-sections.tsx` (27,939 B) from simple thresholds.
**Impact:** users may believe a model analysed their performance. This is a
truth-in-labelling problem, and it becomes a serious one if the wording implies competitive or
contractual conclusions.
**Severity:** MEDIUM · **Confidence:** MEDIUM (wording not exhaustively verified)
**Recommendation:** label clearly as a deterministic rule; reserve the word "AI" for genuine
model output, and apply `74_FUTURE_AI.md` / `75_AI_SECURITY.md` when it is.

## 4. Verdict

**REPLACE.** Notifications must become a first-class domain driven by an event stream, with per-
tenant and per-recipient rules, multiple channels, delivery guarantees and acknowledgement. See
`77_EVENT_ARCHITECTURE.md` and `78_NOTIFICATION_ARCHITECTURE.md` for the target design.
