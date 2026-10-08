# 55 - DEPLOYMENT
**Audit.md section:** 62 (SECTION 59 - DEPLOYMENT)

## 1. As deployed / as documented
| Aspect | State | Evidence | Confidence |
| --- | --- | --- | --- |
| Hosting | **Vercel** (inferred) | `.gitignore:25-26` ignores `.vercel`; a `vercel/*` branch exists; one commit authored by `Vercel`; `next.config.mjs:26` `serverActions.allowedOrigins: ["localhost:3000", "*.vercel.app"]`; `hooks/use-auth-v2.tsx:36` falls back to `process.env.NEXT_PUBLIC_VERCEL_URL` | MEDIUM-HIGH |
| Runtime | Next.js Node runtime | no `export const runtime` anywhere (`rg "export const runtime"` → 0) | HIGH |
| Regions | **Single region** (Vercel default) | no multi-region configuration | MEDIUM |
| Database | **Supabase managed Postgres** | `.env.example:2-3`; all access via PostgREST | HIGH |
| Auth | Supabase Auth (GoTrue) | `lib/supabase.ts` | HIGH |
| Storage | Supabase Storage, 4 buckets | `automation-scripts/08` | HIGH |
| CDN | Vercel edge network | inferred | MEDIUM |
| Domain | **UNKNOWN** | `NEXT_PUBLIC_SITE_URL` falls back to `https://raptor-esports.example` in 4 files, which is a placeholder; the real domain is not in the repository | LOW |
| Environments | **dev / (implied) prod** | no staging configuration anywhere; `DEPLOYMENT.md` covers Vercel + Supabase only | MEDIUM |
| Secrets management | **Vercel environment variables** (assumed) | no vault, no rotation, no audit | LOW-MEDIUM |
| Migrations in the deploy pipeline | **NONE** | 51 manual SQL files | HIGH |
| Build command | `pnpm build` -> `next build` | `package.json:6` | HIGH |
| Scaling | **Not addressed** | no caching layer, no queue, no worker, no connection strategy | HIGH |
| Health checks | **NONE** | no `/healthz`, no `/readyz` | HIGH |
| Rollback | **Not documented** | Vercel provides instant rollback; nothing in the repo uses or documents it | MEDIUM |
| Monitoring | **NONE** | `52_OBSERVABILITY.md` | HIGH |
| Backups | Platform-managed, unconfigured, untested | `51_BACKUPS.md` | MEDIUM |
| Incident response | **NONE** | no runbook, no on-call | HIGH |
| Infrastructure as code | **NONE** | no Terraform, no Pulumi, no CDK | HIGH |
| SSL/TLS | HSTS set by middleware | `middleware.ts:12` `max-age=31536000; includeSubDomains` (no `preload`) | HIGH |
| Image optimisation | **Disabled** | `next.config.mjs:3-4` `unoptimized: true` | HIGH |

## 2. Findings

### F-DEP-01 - HIGH: the domain of record is not in the repository and the code falls back to a placeholder
**Evidence.** `app/layout.tsx:17`, `app/sitemap.xml/route.ts:16`, `app/faq/page.tsx:432`,
`components/seo/OrganizationJsonLd.tsx:4` all use
`process.env.NEXT_PUBLIC_SITE_URL || 'https://raptor-esports.example'`;
`hooks/use-auth-v2.tsx:36` uses `NEXT_PUBLIC_SITE_URL || NEXT_PUBLIC_VERCEL_URL || 'http://localhost:3000'`.
`NEXT_PUBLIC_SITE_URL` is **not documented in `.env.example`** (which lists
`NEXT_PUBLIC_BASE_URL` instead — a different name, used only in
`app/api/discord/tryout/announce/route.ts:98`).
**Impact:** if the variable is unset, the application serves placeholder canonical URLs, a
placeholder sitemap and placeholder OpenGraph metadata — silently, with no error. Auth redirects
can point at `localhost:3000`. Password-reset and email-verification links built from the site
URL would be broken. This is exactly the class of defect that only appears in production.
**Severity:** HIGH | **Confidence:** HIGH
**Recommended remediation:** a typed, validated configuration module that **fails startup** on a
missing required variable; no placeholder fallbacks; one canonical `APP_URL`.

### F-DEP-02 - HIGH: no staging environment is defined
**Evidence.** absence. `DEPLOYMENT.md` describes only Vercel + Supabase production.
**Impact:** with a schema defined by 51 manual SQL files and RLS that was never exercised, there
is no way to validate a change without touching production. This is very likely why the
attendance defect backlog grew through ~8 sequential fix scripts applied directly to production.
**Severity:** HIGH | **Confidence:** HIGH

### F-DEP-03 - HIGH: no health checks or deployment gates
**Evidence.** absence of `/healthz` and `/readyz`; the only session-ish endpoint
(`/api/auth/session`) is useless as a probe and echoes the caller's token.
**Impact:** a deploy that succeeds at the platform level but has a broken database or a failed
migration is not detected or rolled back.
**Severity:** HIGH | **Confidence:** HIGH

### F-DEP-04 - MEDIUM: configuration is build-time inlined, so builds are not reproducible
**Evidence.** three `NEXT_PUBLIC_*WEBHOOK_URL` variables are inlined into the client bundle at
build time (`19_SECRETS.md` F-SEC-01); `next.config.mjs` reads `NODE_ENV`; `build.out` shows a
build that stalled on an interactive Corepack download.
**Impact:** the same commit produces different artefacts depending on when and where it is built.
A secret rotated in the environment does not take effect until a rebuild. This is both a security
problem and a deployment-reliability problem.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** no secrets in the client bundle; runtime configuration for anything sensitive.

### F-DEP-05 - MEDIUM: no infrastructure as code
**Evidence.** absence.
**Impact:** the production environment is defined by out-of-band dashboard clicks. It cannot be
reviewed, reproduced, or rebuilt. Combined with the manual SQL scripts, the entire production
state is undocumented.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-DEP-06 - MEDIUM: no scaling strategy, and the architecture will not scale to many tenants
**Evidence.** no cache layer, no background worker, no queue, no read replica, no connection
pooling strategy; all queries go through PostgREST from serverless functions; `getWebhookStats`
pulls 30 days of rows; `GET /api/performances` defaults to unbounded; `api/*/practice-config/reset`
and `sessions/generate-daily` are unbounded work.
**Impact:** a single tenant already strains this; many tenants will not work. Serverless
functions with no queue also mean long-running work (report generation, bulk import, OCR,
notifications) has nowhere to run.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** see `93_SCALE.md`.

### F-DEP-07 - LOW: HSTS without `preload`, and image optimisation disabled
**Evidence.** `middleware.ts:12` `Strict-Transport-Security: max-age=31536000; includeSubDomains`
(no `preload`); `next.config.mjs:3-4` `images.unoptimized: true`.
**Impact:** minor security and performance gaps.
**Severity:** LOW | **Confidence:** HIGH

## 3. V2 deployment requirements
1. **Environments:** local, preview (per PR, with a Supabase branch and seeded data), staging,
   production. All four built by the same pipeline from the same migrations.
2. **Configuration:** a typed, Zod-validated env module; **fail fast** on missing required values;
   no placeholder fallbacks; secrets only in a managed secret store, never `NEXT_PUBLIC_*`.
3. **Migrations in the pipeline**, forward-only, applied before the new version serves traffic,
   with a documented rollback-forward procedure.
4. **Health and readiness endpoints**, used as deployment gates with automatic rollback.
5. **Infrastructure as code** for everything outside the managed platform.
6. **Observability wired in from day one** (`52_OBSERVABILITY.md`).
7. **Documented, tested backup and restore** with published RPO/RTO.
8. **Multi-region readiness:** a single write region with read replicas, and a documented
   degradation plan.
9. **Rate limiting and WAF at the edge**, before the application.
10. **Release discipline:** signed releases, an auto-generated changelog, and a rollback runbook.

## 4. Verdict
**REBUILD the deployment process.** The platform choice (Vercel + Supabase) is reasonable for a
multi-tenant SaaS and can be retained; everything around it must be built.
