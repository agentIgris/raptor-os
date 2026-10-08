# 19 — SECRETS AUDIT

**Audit.md section:** 25 (SECTION 22 — SECRETS AUDIT)
**Audit.md Rule 7 applied:** *never expose or reproduce secrets found in the repository.*
**No secret value is reproduced in this document.** Machine-readable (redacted) scan output:
`AUDIT/evidence/secrets-scan/scan-results.csv`.

---

## 1. Scan performed

15 detection rules were run across all 326 tracked files (values redacted in the output):
private-key markers · JWT-shaped strings · AWS/Google/Slack/GitHub/Stripe/npm token shapes ·
connection strings with inline credentials · `password|secret|api_key|token` assignments ·
committed environment values · real-looking Supabase project references · full Discord webhook
URLs · Supabase host overrides.

**Result: no live production secret is committed to the repository.** The `.gitignore` correctly
excludes `.env`, `.env.local` and `.env.*.local` while explicitly allowing `.env.example`
(lines 19-23). This is genuinely good practice and is recorded as such.

---

## 2. Findings — secrets *disclosure by design*, not by commit

The critical secrets problem in this repository is not a leaked key. It is that **secrets are
deliberately exposed to the browser, returned by APIs, and rendered into the DOM.**

### F-SEC-01 — CRITICAL: three Discord webhook credentials are configured through `NEXT_PUBLIC_*` variables, which are compiled into the client bundle

*Finding:* the application reads its Discord webhook credentials from environment variables
whose names begin with `NEXT_PUBLIC_`.
*Evidence (variable names only — no values):*
| Variable | Read at | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_CONTACT_WEBHOOK_URL` | `app/api/public/submit/contact/route.ts:45` | relay contact-form submissions to Discord |
| `NEXT_PUBLIC_APPLICATION_WEBHOOK_URL` | `app/api/public/submit/application/route.ts:33` | relay applications to Discord |
| `NEXT_PUBLIC_PUBLIC_WEBHOOK_URL` | both of the above (`:45`, `:33`) | shared fallback |

*Why this is critical:* Next.js **inlines every `NEXT_PUBLIC_*` variable into the JavaScript
bundle at build time**. Any `NEXT_PUBLIC_*` name referenced anywhere in client-reachable code —
including a *server* route file, because the substitution is a build-time textual replacement
across the whole compilation — has its **value** embedded in the emitted assets. A visitor can
read the production webhook URL from `/_next/static/**.js` without any authentication.

*A Discord webhook URL is a write credential for that channel.* Disclosure allows an anonymous
third party to post arbitrary messages, with an attacker-chosen `username` and `avatar_url`, into
the organisation's operational Discord channel.

*Compounding factors:*
1. Both consuming routes are **unauthenticated** (`app/api/public/submit/contact`,
   `app/api/public/submit/application`), so the credential is not merely disclosed but
   **weaponised**: anyone can make the server relay arbitrary attacker-supplied content to the
   channel, with no rate limiting.
2. On Discord error, both routes return the upstream response text to the caller
   (`contact:79`, `application:47`), which can leak webhook metadata.
3. The fallback in `app/api/public/submit/contact:46-64` resolves
   `admin_config.default_public_webhook_id` → `hook_url` **using the service-role key**, so even
   if the env vars are removed, an unauthenticated request still reaches a webhook URL.

*Exploitability:* trivial — view source, search the bundle for `discord.com/api/webhooks`.
*Impact:* public exposure of an organisational communication credential; unlimited abuse of the
intake channel; reputational and phishing risk; Discord rate-limit exhaustion.
*Affected scope:* every Discord channel used for public intake.
*Severity:* **CRITICAL** · *Confidence:* **HIGH**

*Recommended remediation (no value is reproduced here):*
1. **Immediately rotate** every Discord webhook URL used for public intake, in the Discord
   server settings, and treat the previously configured values as compromised.
2. Rename the variables to non-`NEXT_PUBLIC_` names (`DISCORD_CONTACT_WEBHOOK_URL`,
   `DISCORD_APPLICATION_WEBHOOK_URL`) so they are server-only.
3. Better: stop using raw webhooks for intake. Write submissions to a server-side queue
   (`intake_submissions` table) and deliver via a **Discord bot** using a server-held bot token
   with scoped channel permissions, so the credential is a bot token rather than a
   publicly-postable webhook URL.
4. Add rate limiting and a bot challenge to both endpoints.
5. Add a CI secret scanner (gitleaks/trufflehog) and a build-time assertion that fails if any
   `NEXT_PUBLIC_*` name matches a secret pattern.

### F-SEC-02 — CRITICAL: Discord webhook URLs are stored in plaintext, returned by APIs, and opened in the browser

*Evidence:*
* Column: `discord_webhooks.hook_url text NOT NULL` — `scripts/00-complete-schema-setup.sql:299`.
* Returned by `GET /api/discord-portal/webhooks` with `.select('*, teams:team_id(name)')` —
  `app/api/discord-portal/webhooks/route.ts:78, 86, 104, 114`.
* Returned by `GET /api/discord-portal/webhooks` in the service layer —
  `modules/discord-portal/webhookService.ts:40, 62, 79-84, 102`.
* Returned to unauthenticated callers by the RLS policy `team_id IS NULL` branch —
  `database/complete-discord-portal-setup.sql:92-100`.
* Returned by the `SECURITY DEFINER` function `get_team_webhook(team_id)` —
  `database/complete-discord-portal-setup.sql:187-213`.
* **Rendered into the DOM and opened in a new tab by the UI:**
  `app/dashboard/discord-portal/webhooks/page.tsx:490`
  `window.open(webhook.hook_url, '_blank')`.

*Impact:* every `admin`/`global` webhook credential is obtainable by an anonymous caller, and
every team webhook credential is obtainable by any manager and by any authenticated team member
whose RLS branch matches. The UI treats the credential as displayable, which institutionalises
the exposure.
*Severity:* **CRITICAL** · *Confidence:* **HIGH**
*Recommended remediation:* store webhook URLs **encrypted at rest** (Supabase Vault or an
application-level envelope encryption with a KMS-managed key) and hold only an opaque
identifier client-side; never return the URL from any endpoint; rotate all existing values;
show only a masked hint (`https://discord.com/api/webhooks/1234…/••••`) in the UI.

### F-SEC-03 — HIGH: the service-role key is used in six routes, four of them unauthenticated

*Evidence:* `SUPABASE_SERVICE_ROLE_KEY` is read in
`lib/supabase-admin.ts:9`, `app/api/admin/settings/route.ts` (via `getSupabaseAdmin`),
`app/api/discord-portal/settings/default-webhook/route.ts:46, 64`,
`app/api/public/submit/contact/route.ts:48, 56`,
`app/api/profile/avatar/route.ts:9, 19` (a **second, local copy** of the factory),
`app/api/media/upload/route.ts:5`, `app/api/media/delete/route.ts:5`,
`app/api/public/upload/contact-file/route.ts:5`.

*Correctness note:* the key is only ever referenced through non-`NEXT_PUBLIC_` names, so it is
**not** bundled into the client. That part is right. The problems are (a) it is used on
unauthenticated request paths, and (b) two of those routes **fall back to the anon key** when
it is absent (`media/upload:5`, `media/delete:5`, `public/upload/contact-file:5`:
`process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY`), which
turns a fail-closed misconfiguration into a silently degraded one.
*Impact:* the service role bypasses RLS entirely; on an unauthenticated path it converts
"unauthenticated" into "unrestricted".
*Severity:* **HIGH** · *Confidence:* **HIGH*
*Recommended remediation:* the service role must never be constructed in a request handler that
a browser can reach without an authenticated, authorised actor. Use narrow
`SECURITY DEFINER` functions for the few privileged operations, each with
`REVOKE … FROM PUBLIC, anon` and an internal authorisation check. Remove the anon-key fallback.

### F-SEC-04 — MEDIUM: the Supabase anon key's prefix is exported to the client, and the project URL is embedded in the build config

*Evidence:*
* `lib/supabase.ts:683` `export const SUPABASE_URL_DEBUG = supabaseUrl || 'not-set'`
* `lib/supabase.ts:684` `export const SUPABASE_ANON_DEBUG = (supabaseAnonKey || 'not-set').slice(0, 8) + "…"`
* `next.config.mjs:5` `domains: ['localhost', 'qjdlvbwmfwbxgwowqhyz.supabase.co']` — a real
  20-character Supabase project reference committed to the repository.
* `lib/supabase.ts:21-22, 31` — a hardcoded dummy URL and a hardcoded dummy JWT-shaped key used
  when env vars are missing, which ships a syntactically valid-looking JWT into the bundle.

*Assessment:* the anon key is **designed** to be public, so its presence is not a leak. But:
(a) truncating and exporting it is pure noise that trains reviewers to ignore key material in
source; (b) the hardcoded project reference in `next.config.mjs` unnecessarily identifies the
production Supabase project to anyone reading the repository, which materially assists targeting
(coupled with F-RLS-02, an attacker needs only the anon key, and the project ref confirms which
project to hit); (c) the dummy JWT fallback means a misconfigured deployment fails with
cryptographic-looking errors rather than a clear configuration error, and it puts a
JWT-shaped literal into the repository, which is exactly the pattern secret scanners flag.
*Severity:* **MEDIUM** (for the key) / **LOW** (for the project ref) · *Confidence:* **HIGH**
*Recommended remediation:* delete `SUPABASE_URL_DEBUG` and `SUPABASE_ANON_DEBUG`; replace the
`images.domains` entry with a runtime-configured remote pattern; fail loudly at startup when
required configuration is absent rather than substituting dummies.

### F-SEC-05 — MEDIUM: `RAPTOR_BOT_API_KEY` is a single static shared secret guarding 12 endpoints, compared non-constant-time

*Evidence:* the variable name appears in 12 route files, each with its own local validator, e.g.
`app/api/discord/tryout/apply/route.ts:5-13`:
```ts
const expectedKey = `Bearer ${process.env.RAPTOR_BOT_API_KEY}`
if (!apiKey || apiKey !== expectedKey) { return false }
```
*Problems:*
1. **Single point of compromise** — one key authorises tryout announcement, invitation,
   evaluation, performance upload, attendance marking, and read access to team performance and
   attendance summaries.
2. **No request signing, nonce, timestamp or replay window** — a captured header is valid
   forever.
3. **`!==` string comparison** is not constant-time, permitting a timing side channel.
4. **No per-identity attribution** — every bot action lands in `communication_logs.triggered_by`
   as `NULL`, so there is no non-repudiation.
5. If the variable is unset, `expectedKey` becomes the literal string `"Bearer undefined"`, so
   **any request sending `Authorization: Bearer undefined` is authenticated**. This is a real
   fail-open: `lib/discord-bot-auth.ts:13-17` explicitly guards against it
   (`if (!process.env.RAPTOR_BOT_API_KEY) return false`), but **none of the 12 local copies
   replicate that guard**.
*Severity:* **HIGH** for the fail-open, **MEDIUM** for replay/single-point-of-compromise ·
*Confidence:* **HIGH** (the `"Bearer undefined"` behaviour is deterministic JS semantics)
*Recommended remediation:* validate the key's presence before comparing; use
`crypto.timingSafeEqual`; replace the shared key with per-integration credentials and signed
requests (timestamp + nonce + HMAC); attribute every call to a service identity.

### F-SEC-06 — MEDIUM: sensitive values are written to the browser console

*Evidence:*
* `lib/auth-flow-v2.ts:290` `console.log(\`🔍 Loading profile for user: ${user.email}\`)`
* `lib/auth-flow-v2.ts:304` `console.log('✅ User profile loaded successfully:', userProfile.role)`
* `lib/auth-flow-v2.ts:430` `console.log(\`🔐 Processing ${provider} session for user:\`, user.email)`
* `lib/secure-profile-creation.ts:15` `console.log(\`🔧 Creating profile for user: ${email} (ID: ${userId})\`)`
* `lib/ocr-service.ts:61` `console.log("Raw OCR text:", text)` — the **full raw OCR output of a
  player screenshot**, which can contain in-game identifiers, and therefore personal data, is
  logged to the console.
* `app/api/public/submit/contact/route.ts` and others return raw upstream error text to callers.
*Mitigating factor:* `next.config.mjs:8-10` sets `removeConsole` in production, so these are
stripped from production bundles. That is an accidental mitigation — and it simultaneously
destroys all production observability (see `18_LOGGING.md`).
*Severity:* **MEDIUM** (in development and any non-production build) · *Confidence:* **HIGH*
*Recommended remediation:* remove PII from log statements; adopt a structured logger with
redaction; do not rely on `removeConsole` as a privacy control.

### F-SEC-07 — MEDIUM: `.env.example` documents five variables that do not exist in the code, and omits fourteen that do

*Evidence:*
*Documented but **never referenced**: `DATABASE_URL` (`:14`), `ANALYTICS_API_KEY` (`:17`),
`SENTRY_DSN` (`:18`), `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` (`:21-24`).
*Actually referenced in code but **not documented*:**
`NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_VERCEL_URL`, `NEXT_PUBLIC_BASE_URL`,
`NEXT_PUBLIC_DISCORD_INVITE`, `NEXT_PUBLIC_RAPTOR_LOGO_URL`,
`NEXT_PUBLIC_CONTACT_WEBHOOK_URL`, `NEXT_PUBLIC_APPLICATION_WEBHOOK_URL`,
`NEXT_PUBLIC_PUBLIC_WEBHOOK_URL`, `NEXT_PUBLIC_DISABLE_AGREEMENT_ENFORCEMENT`,
`NEXT_PUBLIC_SESSION_DURATION`, `NEXT_PUBLIC_INACTIVITY_TIMEOUT`,
`NEXT_PUBLIC_REFRESH_INTERVAL`, `NEXT_PUBLIC_WARNING_BEFORE_LOGOUT`,
`NEXT_PUBLIC_ENABLE_IDLE_TIMER`, `NEXT_PUBLIC_ENABLE_TOKEN_REFRESH`,
`NEXT_PUBLIC_ENABLE_SESSION_STORAGE`, `NEXT_PUBLIC_DEBUG_SESSION`.
*Impact:* a new engineer configuring the system from `.env.example` will set four SMTP
variables that do nothing and will **miss the ones that matter**, including the three webhook
credentials and the session-timeout controls. The undocumented `NEXT_PUBLIC_*` session
variables mean session policy is effectively set by whoever happened to create the deployment.
*Severity:* **MEDIUM** · *Confidence:* **HIGH** (verified: `rg "process.env.[A-Z_0-9]+"` enumerated
all 21 referenced variables)
*Recommended remediation:* generate `.env.example` from a typed, validated configuration module
(Zod-validated `env`), fail startup on missing required variables, and forbid
secret-shaped names in the `NEXT_PUBLIC_` namespace via a CI check.

---

## 3. Secret inventory (values never reproduced)

| # | Secret | Where it lives | Classification | In git? | In client bundle? | Severity |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `.env.example:3` | public-by-design | template only | **Yes, by design** | LOW (but see F-SEC-04) |
| 2 | `SUPABASE_SERVICE_ROLE_KEY` | `.env.example:4`; read in 8 files | **server-only, full bypass** | template only | No | **HIGH** (F-SEC-03) |
| 3 | `RAPTOR_BOT_API_KEY` | `.env.example:11`; read in 12 files | **server-only, shared secret** | template only | No | **HIGH** (F-SEC-05) |
| 4 | `NEXT_PUBLIC_CONTACT_WEBHOOK_URL` | `.env.example` (absent); read in 1 route | **server-only credential misfiled as public** | no | **Yes — CRITICAL** | **CRITICAL** |
| 5 | `NEXT_PUBLIC_APPLICATION_WEBHOOK_URL` | read in 1 route | same | no | **Yes — CRITICAL** | **CRITICAL** |
| 6 | `NEXT_PUBLIC_PUBLIC_WEBHOOK_URL` | read in 2 routes | same | no | **Yes — CRITICAL** | **CRITICAL** |
| 7 | `discord_webhooks.hook_url` (all rows) | Postgres, plaintext | **server-only, per-channel credential** | n/a | **Yes — returned by 4 code paths and rendered in the DOM** | **CRITICAL** |
| 8 | `admin_config.default_public_webhook_id` | Postgres, **no RLS** | pointer to #7 | n/a | value readable by anyone with the anon key | **HIGH** |
| 9 | Dummy JWT-shaped fallback key | `lib/supabase.ts:22` | non-secret, but JWT-shaped | yes | yes | LOW |
| 10 | Supabase project reference | `next.config.mjs:5` | infrastructure identifier | yes | yes | LOW |
| 11 | `SMTP_PASS` | `.env.example:24` | server-only | template only | No (unused) | INFO |
| 12 | `SENTRY_DSN` | `.env.example:18` | server-only | template only | No (unused) | INFO |
| 13 | `DATABASE_URL` (with inline credentials format) | `.env.example:14` | server-only | template only | No (unused) | INFO |
| 14 | `analytics_debug_log` table | `scripts/17:17` | may contain query text/PII | n/a | n/a | LOW — **drop the table** |

---

## 4. Rotation checklist (execute before any further deployment)

1. Rotate **every** Discord webhook URL in every Discord server the organisation uses
   (public intake, team notifications, admin/global channels). Treat all as compromised.
2. Rotate `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API) and update the
   deployment. Review the Supabase **auth log** and **PostgREST logs** for unauthorised use
   before and after rotation.
3. Rotate `RAPTOR_BOT_API_KEY`; issue per-integration credentials instead.
4. Audit `auth.users` for accounts that should not exist (open self-service signup plus
   unauthenticated PostgREST write paths make this non-trivial).
5. Audit `admin_config` for values that do not match what was intended — the table has been
   world-writable.
6. Remove the three `NEXT_PUBLIC_*WEBHOOK_URL` variables from every environment immediately,
   even before rotation completes, to stop re-exposing new values on the next build.
7. Enable Supabase **advisory alerts** and Vercel deployment protection.
8. Add `gitleaks`/`trufflehog` to CI and to pre-commit; add a build-time guard that fails when
   any `NEXT_PUBLIC_*` name matches a secret pattern.

---

## 5. Secrets verdict

| Question | Answer |
| --- | --- |
| Are secrets leaked in git? | **No.** `.gitignore` is correct and no live value is committed. |
| Are secrets exposed at runtime? | **Yes, critically.** Three Discord webhook credentials are compiled into the client bundle by naming convention; all stored webhook URLs are returned by APIs and rendered into the DOM; ~25 `SECURITY DEFINER` functions are callable by `anon`. |
| Is there a secrets-management story? | **None.** No vault, no envelope encryption, no rotation metadata, no key version, no per-integration scoping. |
| Is there detection? | **None.** No secret scanner, no CI check, no anomaly detection. |
| Overall | Treat every credential in the current deployment as compromised and rotate before any further use. |
