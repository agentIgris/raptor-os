# 76 - INTEGRATION ARCHITECTURE (current state + future requirements)
**Audit.md section:** 83 (SECTION 80)

## 1. Current integrations, exhaustively
| Category | Integration | Direction | Implementation | Security posture |
| --- | --- | --- | --- | --- |
| **Backend** | Supabase Auth | both | GoTrue, email/password, PKCE | session in `localStorage`; no MFA; no SSO; default SMTP |
| **Backend** | Supabase Postgres / PostgREST | both | 51 hand-written SQL files; ~25 `SECURITY DEFINER` functions | RLS posture unvalidated; 14 tables unprotected; `anon` not revoked |
| **Backend** | Supabase Storage | both | 4 buckets, 16 policies | 3 unauthenticated endpoints; `contact_files` world-readable; policies inert or bypassed |
| **Backend** | `pg_cron` | internal | 6 scheduled jobs | not versioned; not idempotent; no run history |
| **Communication** | **Discord (outbound)** | out | 12 message types, webhook POST | webhook URLs plaintext, world-readable, bundled to the client |
| **Communication** | **Discord (inbound, RaptorBot)** | in | 13 endpoints, 12 route files | one static shared key; 12 duplicated validators; fail-open; no replay protection; no rate limit; **5 endpoints provably broken** |
| **Social / data** | **None** | - | - | no YouTube, Twitch, TikTok, Instagram, X, Kick |
| **Competitive data** | **None** | - | `performance_records` was designed for it and is unused | no Riot/Steam/FACEIT/tournament API |
| **Finance / billing** | **None** | - | `DATABASE_URL` documented, unused | no Stripe, no accounting, no banking, no payroll provider |
| **Identity (SSO)** | **None** | - | `hooks/use-oauth-session-detector.tsx` exists with no provider configured | half-built |
| **Productivity** | **None** | - | - | no Google/Microsoft Calendar |
| **Email** | **None** | - | `SMTP_*` documented, unused | - |
| **AI / OCR** | Tesseract.js (client-side) | local | loads WASM + model from a CDN | unpinned dependency; no integrity control |
| **Monitoring** | **None** | - | `SENTRY_DSN` documented, unused | - |

**Total: 1 platform integration, 1 third-party integration (Discord), and a lot of dead
configuration.**

## 2. What a SaaS needs, by category

### 2.1 Identity
* **Google** and **Microsoft** (OIDC) SSO, per tenant, with domain-restricted claiming.
* SCIM 2.0 provisioning for enterprise customers (join/leave automation) - a common enterprise
  requirement.
* The auth provider stays Supabase Auth; OAuth is configured **per tenant** with the tenant's
  client id/secret in a secret store, and `autoLinkUsers` scoped by verified email domain.

### 2.2 Communication
* **Discord** - a **bot per tenant** (never a webhook URL in the client), channels explicitly
  mapped, identity derived from the Discord session (`76` §Discord below).
* **Slack** - a bot per tenant, same pattern.
* **Email** - a transactional provider with per-tenant sending domain, DKIM and DMARC
  (`23_EMAIL.md`).
* **WhatsApp / SMS** - optional, for time-critical operational alerts only (session reminders,
  travel changes), never for contractual notices.

### 2.3 Social (creator analytics)
YouTube Data API, Twitch Helix, TikTok (business approval), Instagram Graph (business accounts),
X (read-only), Kick (limited; manual fallback). Per Audit.md and `67_FUTURE_CREATORS.md`.
Design rule: **metrics are snapshots with a source and a timestamp**, never live reads at render
time, because platform APIs change and rate limits are tight.

### 2.4 Competitive data
* **Game publisher APIs** where a title offers them (Riot, Valve/Steamworks, FACEIT, GameSquare/
  Battlefy, ESL FACEIT Group) - results, standings, player identity resolution.
* **Tournament API providers** for community tournaments.
* **OCR / manual entry** remains necessary for titles with no API - and per
  `25_PERFORMANCE_DOMAIN.md` OCR is input assistance, never authoritative.
* Design rule: ingested data is **raw and immutable**; derived statistics are computed and
  versioned. Never overwrite an ingested result.

### 2.5 Finance and billing
* **Stripe Billing** (or equivalent) for SaaS subscription billing, with the webhook as the
  source of truth for subscription state (`82_SAAS_BILLING.md`).
* **Accounting** - Xero / QuickBooks / NetSuite (`66_FUTURE_FINANCE.md`).
* **Payroll / payouts** - Deel / Remote / Airwallex (`65_FUTURE_PAYROLL.md`).
* **Banking** - open banking feed for reconciliation.
* Design rule: **webhooks are the source of truth**, verified by signature, idempotent, and
  replayed safely.

### 2.6 Productivity
* **Google Calendar** and **Microsoft Calendar** two-way sync for sessions, evaluation sessions,
  travel, and content publishing dates. This is the single most-requested integration in team
  software and is entirely absent.

### 2.7 Customer-facing extensibility
* **Outbound webhooks** per tenant, with a subscription (event types), a signed payload, a
  delivery log, retries and a dead-letter queue, and a replay tool.
* A public **REST API** with scoped API keys or OAuth client credentials.

## 3. Cross-cutting requirements (these matter more than the individual integrations)
1. **Per-tenant configuration and credentials**, in a secret store, never `NEXT_PUBLIC_*`
   (`19_SECRETS.md` F-SEC-01).
2. **The integration layer is a domain with an interface** - provider, credential reference,
   connection test, sync state, error log, rate budget, and health. Not code scattered in routes.
3. **Inbound webhooks**: signature verification with a per-tenant secret, timestamp and nonce
   replay protection, constant-time comparison, idempotency key, and a bounded body size
   (replacing the single replayable `RAPTOR_BOT_API_KEY`).
4. **Outbound calls**: host allowlists for stored URLs, timeouts, circuit breakers, exponential
   backoff with jitter, a dead-letter queue, and **no outbound HTTP inside a database
   transaction** (`44_WORKFLOWS.md` F-WFL-02).
5. **Idempotency everywhere** - every inbound and every retried outbound operation.
6. **Rate budgeting per tenant per integration**, with backpressure and alerting, because a
   shared API key across tenants means one tenant can exhaust the quota for everyone.
7. **A durable outbox** so that a business fact and the intent to notify/integrate commit
   atomically (`77_EVENT_ARCHITECTURE.md`).
8. **Degradation is designed**: what the product does when an integration is down, and when its
   API changes. The legacy system has none of this, which is why a Discord outage would degrade
   slot creation.
9. **Audit**: every integration configuration change and every credential use is audit-logged.
10. **Data minimisation**: only the fields each integration needs leave the tenant.

## 4. Discord in the SaaS architecture (Audit.md asks specifically)
* **Bot per tenant.** A scoped bot token in a secret store; the bot requests only the permissions
  it needs (`Send Messages`, `Embed Links`); it posts only to channels the tenant has explicitly
  mapped.
* **Guild-to-org mapping**: a guild maps to exactly one organisation. Every command is authorised
  against the mapped organisation using the **same policy dataset** as the UI and the API
  (`63_ROLE_MODEL.md`) - never a Discord-side permission check alone.
* **Identity is derived, never asserted.** The bot resolves the Discord user to a `Person` via
  `SocialAccount(platform=discord)` or an explicit link flow. The `discord_id` in a request body
  is never trusted (the legacy system trusts it at
  `app/api/discord/tryout/apply:26` and `status:23`).
* **Commands map to application commands**, not to raw API writes: `/attendance mark`,
  `/tryout announce` etc. each resolve to a permission-checked service call.
* **Events out, notifications in.** Automated messages are triggered by the event stream, not by
  ad-hoc calls from route handlers.
* **Never expose a webhook URL.** If webhooks remain available, they are encrypted, per-channel,
  with replace-not-reveal semantics (`22_DISCORD.md` §4).

## 5. Migration from the legacy system
There is nothing to migrate: one platform (Supabase) and one integration (Discord). Everything
else in this document is new build. The **Discord migration** is: rotate every webhook URL, move to
a bot, and re-map channels per tenant.

## 6. Build order
1. Email (needed for invitations, password reset, and every notification) - blocking.
2. Google/Microsoft SSO - blocking for enterprise.
3. Stripe Billing - blocking for the business model.
4. Discord bot (replacing the webhook hack) and Slack.
5. Google/Microsoft Calendar.
6. Competitive data providers, per title.
7. Social platform analytics, per creator.
8. Accounting, payroll, banking.
9. Outbound webhooks and the public API.
