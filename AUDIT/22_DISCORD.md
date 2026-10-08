# 22 — DISCORD
**Audit.md section:** 29 (SECTION 26 — DISCORD INTEGRATION AUDIT)

## 1. Two distinct Discord integration surfaces

| Surface | Direction | Auth | Components |
| --- | --- | --- | --- |
| **A. Discord Portal (outbound)** | App → Discord | user session + role/team checks | `modules/discord-portal/*` (6 files), `app/api/discord-portal/**` (6 routes), `app/dashboard/discord-portal/**` (4 pages), `components/discord-portal/send-to-discord-button.tsx` |
| **B. RaptorBot (inbound)** | Discord bot → App | one static shared key | `app/api/discord/**` (12 routes), `lib/discord-bot-auth.ts` (dead), `app/join-us`, `app/apply/[tryoutId]`, `app/contact` |

**The Discord bot's own code is not in this repository.** Only its HTTP contract is. Bot-side
behaviour (slash-command registration, permission mapping in Discord, rate limiting at the bot)
could not be traced. Confidence on inbound findings is therefore limited to the server side.

## 2. Surface A — outbound

### 2.1 Data model
| Table | Purpose | RLS | Notes |
| --- | --- | --- | --- |
| `discord_webhooks` | `hook_url` (plaintext), `type ∈ {team, admin, global}`, `team_id` (NULL = org-wide), `active`, `channel_name`, `created_by` | ✅ but see `13_RLS_SECURITY.md` F-RLS-02 | `scripts/00:296-309` |
| `communication_logs` | every delivery attempt: `payload` jsonb, `response_code`, `error_message`, `retry_count`, `triggered_by`, `timestamp` | ✅ with `WITH CHECK (true)` INSERT | `scripts/00:311-328` |
| `communication_settings` | per-team/global automation toggles, `UNIQUE(team_id, setting_key)` | ✅ | `scripts/00:330-341` |

### 2.2 Message vocabulary (`modules/discord-portal/types.ts` + `embeds.ts`)
12 message types: `slot_create`, `slot_update`, `roster_update`, `performance_summary`,
`attendance_summary`, `daily_summary`, `weekly_digest`, `expense_summary`, `winnings_summary`,
`analytics_trend`, `system_alert`, `data_cleanup` — each with a dedicated `formatEmbed`
formatter. This is a clean, extensible design and one of the better-engineered parts of the
codebase.

Automation keys (9): `auto_slot_create`, `auto_roster_update`, `auto_daily_summary`,
`auto_weekly_digest`, `auto_performance_alerts`, `auto_attendance_alerts`, `auto_data_cleanup`,
`auto_system_alerts`, `auto_admin_notifications` — with a hardcoded allowlist in
`app/api/discord-portal/settings:147-157` and **no `CHECK` constraint** in the database.

### 2.3 Findings

| # | Finding | Evidence | Severity | Confidence |
| --- | --- | --- | --- | --- |
| D-1 | **CRITICAL — webhook credentials are world-readable and world-writable-in-practice** | `13_RLS_SECURITY.md` F-RLS-02; `modules/discord-portal/webhookService.ts:40, 62, 79, 102` returns `hook_url` via the anon client; `complete-discord-portal-setup.sql:187-213` `get_team_webhook()` is `SECURITY DEFINER` and returns the URL | CRITICAL | HIGH |
| D-2 | **HIGH — a coach can create an org-wide webhook** | `complete-discord-portal-setup.sql:112-123` `… OR discord_webhooks.team_id IS NULL` | HIGH | HIGH |
| D-3 | **HIGH — mass assignment on webhook update** (`team_id`, `type` mutable; no re-check of the type-elevation rule) | `app/api/discord-portal/webhooks:241, 283-285` | HIGH | HIGH |
| D-4 | **HIGH — the service layer has no user context** | `webhookService.ts:21-23`, `sendToDiscord.ts:21-23` create an anon client at module scope; every function runs as `anon` | HIGH | HIGH |
| D-5 | **MEDIUM — the delivery log is publicly forgeable** | `complete-discord-portal-setup.sql:146-148` | MEDIUM | HIGH |
| D-6 | **MEDIUM — no retry queue, no backoff, no DLQ**; a broken retry counter | `sendToDiscord.ts:266-333`, precedence bug at `:319-324` | MEDIUM | HIGH |
| D-7 | **MEDIUM — stored SSRF** because `POST /api/discord-portal/webhooks` does not validate the URL | `15_API_SECURITY.md` F-API-05 | MEDIUM | HIGH |
| D-8 | **MEDIUM — every embed's emoji are mojibake**, so all Discord output renders as garbage | `modules/discord-portal/embeds.ts` and all 5 `app/api/discord/tryout/*` routes use `dY"?'`, `dYZ%`, `�o.`, `dY"S` | MEDIUM | HIGH |
| D-9 | **MEDIUM — outbound HTTP from inside a Postgres transaction** | `automation-scripts/03:131-218` `trigger_slot_creation_notification()` / `trigger_roster_update_notification()` are `SECURITY DEFINER` triggers that POST to Discord | MEDIUM | HIGH |
| D-10 | **LOW — webhook URLs are rendered in the DOM and opened in a tab** | `app/dashboard/discord-portal/webhooks/page.tsx:490` | LOW | HIGH |
| D-11 | **LOW — `UNIQUE(team_id, setting_key)` is NULL-unsafe**, so global settings can duplicate and the `onConflict` upsert cannot match a NULL key | `complete-discord-portal-setup.sql:59`; `app/api/discord-portal/settings:211` | LOW | HIGH |
| D-12 | **LOW — `discord-portal` navigation is inconsistent**: `DASHBOARD_MODULES` allows only admin/manager, but `DashboardPermissions.getPermissions` allows coach and analyst to *view* | `lib/dashboard-permissions.ts:115` vs `:205` | LOW | HIGH |
| D-13 | **INFO — `lib/discord-bot-auth.ts` is entirely dead code** | verified: `RATE_LIMITS`, `logBotApiRequest`, `getClientIp`, `getUserAgent`, `BOT_API_ERRORS` have no importers | INFO | HIGH |

## 3. Surface B — inbound (RaptorBot)

### 3.1 Contract
| Endpoint | Purpose | Works? |
| --- | --- | --- |
| `POST /api/discord/tryout/apply` | candidate applies | **YES** — the only tryout write that works, because `tryout_applications` has a public INSERT policy |
| `POST /api/discord/tryout/announce` | create a tryout from Discord | **NO** — INSERT into `tryouts` requires staff; the anon client yields `auth.uid() = NULL`. Also emits a wrong apply URL (`:98` builds `/tryout/{id}/apply`; the route is `/apply/[tryoutId]`) |
| `POST /api/discord/tryout/invite` | invite a shortlisted candidate | **NO** — INSERT into `tryout_invitations` requires staff |
| `POST /api/discord/tryout/evaluate` | submit an evaluation | **NO** — INSERT requires `evaluator_id = auth.uid()` or admin/manager |
| `GET /api/discord/tryout/list` | list tryouts + stats | **PARTIAL** — only `status='active' AND open_to_public=true`; all child-table stats are empty (no anon SELECT policy) |
| `GET /api/discord/tryout/status` | applicant's status | **NO** — no anon SELECT policy on `tryout_applications` |
| `POST /api/discord/attendance/mark` | bot marks attendance | **UNVERIFIED** — `attendances` has policies requiring `auth.uid()`; likely fails |
| `POST /api/discord/performance/upload` | bot submits a performance | **UNVERIFIED** — same reasoning |
| `GET /api/discord/{sessions,attendance-summary,team-attendance-summary,team-performance,digest}` | read aggregates | **UNVERIFIED** — same |
| `GET/POST /api/discord/webhooks` | list/register webhooks | **UNVERIFIED**; registers arbitrary URLs |

**Root cause for all of the above:** every inbound handler imports the **module-level `supabase`
client from `@/lib/supabase`** (`app/api/discord/tryout/*.ts:2`), which is created with the anon
key and **no user session**. The RLS policies that these operations need all require
`auth.uid()` to resolve to a staff member. Because the request only carries a static API key —
not a user JWT — `auth.uid()` is `NULL` and every staff-scoped policy evaluates false.

This is the same architectural defect as `13_RLS_SECURITY.md` / `10_AUTHORIZATION.md`: the
authorisation model was developed and tested against a database with **RLS disabled**
(`database/README.md:41-46`), where the anon client could read and write everything. The moment
RLS is enabled, the entire inbound integration breaks.

### 3.2 Inbound security findings
* **F-API-09** — one replayable static key, 12 duplicated validators, fail-open when the env var
  is unset, non-constant-time comparison, no rate limiting, no identity attribution.
* **No per-guild authorisation.** `guild_id` is supplied by the caller and only used as a filter;
  nothing verifies that the caller is actually an administrator of that Discord guild. A leaked
  key therefore grants access to **every** guild's tryouts, not just the intended one.
* **`discord_id` is caller-asserted.** `app/api/discord/tryout/apply:26` and `status:23` take
  `discord_id` from the request body/query. The bot is trusted to supply the real identity; there
  is no signature over it and no cross-check against `discord_users`. A caller with the key can
  read or submit on behalf of **any** Discord account, and the duplicate-application guard
  (`:82-87`) is based on that same unverified value.
* **`evaluated` phase is set from the `is_final` flag by a client-supplied body field**
  (`evaluate:170-175`), so an evaluation can be marked final without any approval.

## 4. How Discord should fit the SaaS architecture (conceptual — not implemented)

1. **Discord is a channel, not a system of record.** In V2 the source of truth is the
   organization's own event stream; Discord is one delivery target.
2. **Replace webhooks with a bot per tenant.** Store a **bot token encrypted at rest** per
   organization, with the channel IDs the bot may post to. Never expose a token or a webhook URL
   to any client. Webhooks remain available as an optional, explicitly-scoped, encrypted
   per-channel secret with a "replace" (never "reveal") interaction.
3. **Events → notification rules → channels → recipients** (`78_NOTIFICATION_ARCHITECTURE.md`).
   Discord becomes a channel alongside in-app and email, configured per tenant, per team, per
   event type, with quiet hours and digest modes.
4. **Inbound commands are commands, not API calls.** A tenant-scoped bot command maps to a
   permission-checked application command; identity is derived from the Discord session, never
   from a request parameter; the application's authorisation engine decides what the command may
   do, using the same policy dataset as the UI and the API.
5. **Delivery through a durable outbox** with retry, backoff, DLQ and per-tenant rate budgeting
   (Discord enforces a global rate limit that must be respected per tenant).
6. **Guild-level isolation** becomes org-level: a Discord guild is mapped to exactly one
   organization, and every command is authorised against the mapped organization.
7. **No embed text may be constructed from untrusted input without escaping and length limits**
   (Discord enforces a 2560-character description and 1024-character field limit; the code
   truncates `message`/`results` to 1024 at `public/submit/*` but not elsewhere).
8. **Attachment scanning and retention** for any file delivered to or from Discord.
