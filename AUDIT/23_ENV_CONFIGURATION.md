# 23 - ENVIRONMENT & CONFIGURATION AUDIT (supplementary)
**Audit.md section:** 23 (SECTION 23). Extends `19_SECRETS.md` (SECTION 22).

## 1. Environment variables declared
Source: `_clone/.env.example` (the only configuration document in the repository).

| Variable | Purpose | Classification | Status |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Public by design | Used in `lib/supabase.ts` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key | Public by design | Used; **the anon key's power is the problem** (F-RLS-01/02) |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS | **SECRET** | Used in 3 user-facing routes (F-API-12) |
| `DATABASE_URL` | Direct Postgres | **SECRET** | Documented, never used |
| `DISCORD_BOT_TOKEN` | Discord bot | **SECRET** | Referenced; not implemented |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord OAuth | `CLIENT_ID` public, `SECRET` | Documented, not implemented |
| `DISCORD_WEBHOOK_*` | Outbound notifications | **SECRET** | Replaced by a DB-stored webhook instead (F-SEC-02) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | Email | `PASSWORD` is a **SECRET** | Documented, never used |
| `ANALYTICS_API_KEY` | Analytics | **SECRET** | Documented, never used |
| `OPENAI_API_KEY` | AI | **SECRET** | Documented, never used |
| `VERCEL_URL` | Deployment URL | Public | Used as a placeholder-domain fallback (F-DEP-01) |
| `NODE_ENV` | Runtime | Public | Used to gate `removeConsole` |

**Finding ENV-01:** `.env.example` is the *only* configuration documentation, and it declares
**6 unused variables** across four integrations that were never built (email, OpenAI, analytics,
Discord OAuth). Confidence: HIGH.

**Finding ENV-02:** the file mixes secrets and public keys in one flat list with no distinction
between `NEXT_PUBLIC_*` (shipped to the browser) and server-only values. An operator copying this
file can place a service-role key behind a `NEXT_PUBLIC_` prefix and ship it to every client.
Confidence: HIGH. Severity: HIGH.

**Finding ENV-03:** 4 integration secrets are declared but unused, which means the security
question "is it rotated?" applies to credentials the platform has never used. Treat as
**unrotated and unused**; delete rather than rotate. Confidence: HIGH.

## 2. Configuration surfaces actually in use
| Surface | Location | Problem |
| --- | --- | --- |
| `admin_config` table | `scripts/00:270` | **Untyped key/value, world-writable, holds app-wide toggles** (F-SEC-01). Used for branding, tiers, features |
| `tier_defaults` table | `scripts/00:209` | A rate card, not configuration - belongs in finance |
| `practice_session_config` | `scripts/00:406` | Correctly typed; the right pattern, but no RLS and not per-tenant |
| `discord_webhooks` | `automation-scripts/06` | A **credential** in a database table (F-SEC-02) |
| `communication_settings` | `complete-discord-portal-setup.sql:59` | Typed, but `UNIQUE(team_id, setting_key)` does not constrain NULLs |
| Hardcoded constants | `app/api/public/stats:55-57`, `app/contact:24`, `app/join-us:21`, 4 files | Tier ladder, Discord invite, stats, placeholder domains - none are configuration |
| `next.config.mjs` | - | Production builds skip typecheck and lint |

**Finding ENV-04:** there is **no single configuration boundary**. Six different mechanisms hold
configuration, three of which are world-writable or hold credentials, and a significant amount of
configuration is compiled into the TypeScript. Confidence: HIGH. Severity: HIGH.
Remediation: `79_ORG_CONFIGURATION.md` (typed, per-tenant, versioned, audited).

## 3. Build and runtime configuration defects
| ID | Defect | Evidence | Severity |
| --- | --- | --- | --- |
| F-BUILD-01 | `typescript.ignoreBuildErrors: true` | `next.config.mjs` | HIGH |
| F-BUILD-02 | `eslint.ignoreDuringBuilds: true` | `next.config.mjs` | HIGH |
| F-BUILD-03 | `compiler.removeConsole: true` in production | `next.config.mjs` | HIGH - destroys observability and incident evidence (`52_OBSERVABILITY.md`) |
| F-DEP-01 | Hardcoded `https://raptor-esports.example` fallbacks in 4 files | `55_DEPLOYMENT.md` | MEDIUM |
| F-CONF-01 | `SUPABASE_JS_DB_MAX_CONNECTIONS = 8` in `.env.example` - a **per-instance** value that is wrong for serverless | `.env.example` | MEDIUM |
| F-CONF-02 | Two hardcoded `2000` ms timeouts in `lib/auth-flow-v2` | `09_AUTHENTICATION.md` | MEDIUM |
| F-CONF-03 | No `.env` schema validation at boot; a missing variable fails at first use, not at start | absence | MEDIUM |

## 4. Environment parity
| Environment | Exists | Evidence |
| --- | --- | --- |
| Local development | Partially - no documented setup, no seed data, no fixtures | `01_REPOSITORY_MAP.md` |
| Test | **No** - `tests/` exists and is empty; no `test` script in `package.json` | `53_TESTING.md` |
| Staging | **No** | `55_DEPLOYMENT.md` |
| Production | Vercel + Supabase, inferred | `55_DEPLOYMENT.md` |

**Finding ENV-05:** there is **one** environment. Every change is effectively a production
change, which is why a `ReferenceError` shipped. Confidence: HIGH. Severity: HIGH.

## 5. Recommendations
1. **Delete** the 4 unused secret declarations; do not rotate what was never used.
2. **Introduce a typed env schema** validated at boot (`t3-env` or equivalent), with public and
   server-only sets enforced by the build.
3. **Never** place a credential behind a `NEXT_PUBLIC_` prefix; add a CI check for it.
4. **Remove the 6 unused variables'** documentation-only status from any operator runbook.
5. **Replace all 4 hardcoded fallback domains** with a single validated `APP_URL`.
6. **Add `.env.example` guidance** for the staging and production values, and a per-environment
   inventory that the incident runbook can reference.
7. **Collapse 6 configuration surfaces** into `OrganizationConfiguration` (`79_ORG_CONFIGURATION.md`).
8. **Move `discord_webhooks` out of the database** into a managed secret store, one entry per
   tenant, never returned by any route.
