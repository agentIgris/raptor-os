# 00 — AUDIT README

**Audit subject:** `https://github.com/RaptorLaunchPage/Beta.git` (branch `main`, HEAD `c9b6f8a`)
**Local working copy used for this audit:** `E:\Raptor\_clone` (read-only; **zero production changes made**)
**Specification:** `/Audit.md` (100 sections)
**Audit phase:** AUDIT ONLY — no V2 design, no refactoring, no schema changes, no code edits.

---

## 1. What this directory is

This is the complete forensic audit of the legacy **Raptor Esports Hub**, produced as the
foundation for a **Raptor-independent, multi-tenant Esports Organization OS SaaS**.

The legacy repository is treated strictly as **Legacy Product Intelligence** — a source of
business rules, workflows, data concepts and esports domain knowledge — and **not** as the
architecture to be carried forward.

## 2. How to read this audit

| Document | Audit.md section(s) | Contents |
| --- | --- | --- |
| `00_AUDIT_README.md` | 0–3, 104–112 | This file. Method, evidence standard, severity/confidence models, navigation. |
| `01_REPOSITORY_MAP.md` | 4 (S01) | Full directory and file map with purpose/dependencies/consumers/status. |
| `02_FILE_INVENTORY.md` | 5 (S02) | Machine-readable per-file inventory, imports/exports/routes/DB access/auth requirements/status. |
| `03_TECH_STACK.md` | 6 (S03) | Exact framework/language/dependency versions; what is real vs declared. |
| `04_DEPENDENCY_AUDIT.md` | 7 (S04) | Every dependency: purpose, usage, security status, necessity, V2 recommendation. |
| `04_ARCHITECTURE.md` | 8 (S05) | Browser→Frontend→API→Services→DB→External map; coupling, transaction boundaries, anti-patterns. |
| `05_ROUTES.md` | 9 (S06) | Every page route and every API route with role, purpose, states, status. |
| `06_UI_COMPONENTS.md` | 10 (S07) | Component inventory, duplication, dead components. |
| `08_DESIGN_SYSTEM.md` | 11 (S08) | Tokens, typography, spacing, a11y; problems recorded for V2 (no redesign performed). |
| `07_UX_AUDIT.md` | 12 (S09) | Workflow-by-workflow UX evaluation: goal, steps, friction, gaps, dangerous actions. |
| `08_ROLES_PERMISSIONS.md` | 13 (S10) | Every role; **five divergent permission models** documented. |
| `09_AUTHENTICATION.md` | 14 (S11) | Registration→deletion, session handling, PKCE, token storage, MFA absence. |
| `10_AUTHORIZATION.md` | 15 (S12) | Who/can-do-what/which-resource/under-what-conditions; IDOR & escalation analysis. |
| `11_DATABASE.md` | 16 (S13) | Every table: columns, types, keys, indexes, constraints, triggers, policies. |
| `12_DATABASE_RELATIONSHIPS.md` | 17 (S14) | Full ERD, cardinality, orphans, circular/redundant relations. |
| `15_DATABASE_QUALITY.md` | 18 (S15) | Normalisation, nullability, uniqueness, cascade, race conditions. |
| `13_RLS_SECURITY.md` | 19 (S16) | **Every RLS policy analysed**: intended vs actual access, bypasses, tenant isolation. |
| `14_API.md` | 20 (S17) | Endpoint-by-endpoint inventory: method, path, auth, authz, validation, DB ops, external calls. |
| `15_API_SECURITY.md` | 21 (S18) | Missing auth, broken auth, IDOR, mass assignment, injection, SSRF, rate limiting. |
| `16_VALIDATION.md` | 22 (S19) | Validation at frontend/API/database layers; zod declared but unused. |
| `17_ERROR_HANDLING.md` | 23 (S20) | Error paths, silent failures, retries, fallbacks. |
| `18_LOGGING.md` | 24 (S21) | Application/audit/security/API logging; production log suppression. |
| `19_SECRETS.md` | 25 (S22) | Secret inventory **without reproducing any secret value**; rotation plan. |
| `23_ENV_CONFIGURATION.md` | 26 (S23) | All 21 env vars classified; documented-vs-actually-used drift. |
| `20_STORAGE.md` | 27 (S24) | Buckets, policies, MIME/size validation, malware, public/private, retention. |
| `21_OCR.md` | 28 (S25) | OCR pipeline; verdict on trusting OCR output automatically. |
| `22_DISCORD.md` | 29 (S26) | Bot API, webhooks, channels, embeds, secrets, current breakage. |
| `23_EMAIL.md` | 30 (S27) | **Finding: no email system exists.** Env vars documented but unused. |
| `24_NOTIFICATIONS.md` | 31 (S28) | In-app/Discord/email/push map; event sources. |
| `25_PERFORMANCE_DOMAIN.md` | 32 (S29) | Performance/metrics domain; hardcoded BGMI/PUBG-M assumptions. |
| `26_ATTENDANCE.md` | 33 (S30) | Attendance domain, automation triggers, calculation rules, breakage. |
| `27_TRAINING.md` | 34 (S31) | Sessions/training domain. |
| `28_TOURNAMENTS.md` | 35 (S32) | Slots/expenses/prize pools/winnings. |
| `29_TRYOUTS.md` | 36 (S33) | Full tryout state machine; missing transitions. |
| `30_TEAMS.md` | 37 (S34) | Teams, divisions, tiers, rosters, coaches. |
| `31_FINANCE.md` | 38 (S35) | What exists vs what a commercial org needs. |
| `32_COMPENSATION.md` | 39 (S36) | Salary/bonus/prize-share/commission support. |
| `33_CONTRACTS.md` | 40 (S37) | Agreements subsystem; what is missing (no real contracts domain). |
| `34_HR.md` | 41 (S38) | Employee/contractor/onboarding/offboarding/leave/review support. |
| `35_CREATORS.md` | 42 (S39) | Creator/streamer domain. |
| `36_CONTENT.md` | 43 (S40) | Content domain. |
| `37_SPONSORSHIPS.md` | 44 (S41) | Sponsorship domain. |
| `38_COMMERCIAL_INVENTORY.md` | 45 (S42) | Inventory/deliverables modelling. |
| `39_TRAVEL.md` | 46 (S43) | Travel domain. |
| `40_ASSETS.md` | 47 (S44) | Equipment/asset domain. |
| `41_FACILITIES.md` | 48 (S45) | Facilities domain. |
| `42_COMMUNICATIONS.md` | 49 (S46) | Discord/Slack/email/calendar; system-of-record vs communication data. |
| `43_TASKS.md` | 50 (S47) | Task functionality. |
| `44_WORKFLOWS.md` | 51 (S48) | Existing automation; Event→Condition→Action map. |
| `45_REPORTING.md` | 52 (S49) | Report inventory and classification. |
| `46_ANALYTICS.md` | 53 (S50) | Metrics, aggregation, dashboards, architecture limits. |
| `47_SEARCH.md` | 54 (S51) | Search capability and global-search requirements. |
| `48_IMPORT_EXPORT.md` | 55 (S52) | CSV/Excel/JSON/PDF/DB import-export; migration capability. |
| `49_AUDIT_LOGGING.md` | 56 (S53) | Sensitive-action recording. |
| `50_DATA_RETENTION.md` | 57 (S54) | Deletion/soft-delete/retention/legal hold. |
| `51_BACKUPS.md` | 58 (S55) | Backup/DR/RPO/RTO. |
| `52_OBSERVABILITY.md` | 59 (S56) | Monitoring/error tracking/logging. |
| `53_TESTING.md` | 60 (S57) | Test inventory; untested critical workflows. |
| `54_CICD.md` | 61 (S58) | CI/CD, quality gates, security scanning. |
| `55_DEPLOYMENT.md` | 62 (S59) | Hosting, environments, secrets, scaling. |
| `56_PERFORMANCE.md` | 63 (S60) | Query, bundle, rendering, caching problems. |
| `57_ACCESSIBILITY.md` | 64 (S61) | Keyboard, focus, labels, contrast, semantics. |
| `58_MOBILE.md` | 65 (S62) | Mobile usability of every major workflow. |
| `59_INTERNATIONALIZATION.md` | 66 (S63) | Language/currency/timezone/date/tax. |
| `60_MULTITENANCY.md` | 67 (S64) | **Tenant readiness analysis and exactly what must change.** |
| `61_ORGANIZATION_MODEL.md` | 68 (S65) | Conceptual future organization model. |
| `62_PEOPLE_MODEL.md` | 69 (S66) | Universal `Person` entity evaluation. |
| `63_ROLE_MODEL.md` | 70 (S67) | Role+Permission+Resource+Action+Scope model. |
| `64_FUTURE_HR.md` | 71 (S68) | Future HRIS requirements. |
| `65_FUTURE_PAYROLL.md` | 72 (S69) | Future payroll requirements and outsourcing boundary. |
| `66_FUTURE_FINANCE.md` | 73 (S70) | Future finance requirements. |
| `67_FUTURE_CREATORS.md` | 74 (S71) | Future creator management. |
| `68_FUTURE_CONTENT.md` | 75 (S72) | Future content management. |
| `69_FUTURE_PARTNERSHIPS.md` | 76 (S73) | Future partnerships CRM. |
| `70_FUTURE_SPONSORSHIP.md` | 77 (S74) | Future sponsor deliverables/obligations. |
| `71_FUTURE_TRAVEL.md` | 78 (S75) | Future travel management. |
| `72_FUTURE_ASSETS.md` | 79 (S76) | Future asset management. |
| `73_FUTURE_DOCUMENTS.md` | 80 (S77) | Future document management. |
| `74_FUTURE_AI.md` | 81 (S78) | AI opportunity assessment (with explicit "do not use AI here" list). |
| `75_AI_SECURITY.md` | 82 (S79) | AI safety requirements. |
| `76_INTEGRATIONS.md` | 83 (S80) | Current + future integration architecture. |
| `77_EVENT_ARCHITECTURE.md` | 84 (S81) | Event catalogue. |
| `78_NOTIFICATION_ARCHITECTURE.md` | 85 (S82) | Conceptual notification model. |
| `79_ORG_CONFIGURATION.md` | 86 (S83) | Per-tenant configuration matrix. |
| `80_WHITE_LABEL.md` | 87 (S84) | White-label requirements. |
| `81_PUBLIC_WEBSITE.md` | 88 (S85) | Public-site-as-a-service. |
| `82_SAAS_BILLING.md` | 89 (S86) | Plans/trials/seats/usage/invoicing. |
| `83_DATA_MIGRATION.md` | 90 (S87) | Tenant data migration into V2. |
| `84_DATA_QUALITY.md` | 91 (S88) | Legacy data quality assessment. |
| `85_FEATURE_MATRIX.md` | 92 (S89) | Exists / Complete / Secure / Valuable / V2 verdict per feature. |
| `90_BUSINESS_GAP_ANALYSIS.md` | 93 (S90) | Current Raptor vs modern Esports Org OS. |
| `86_MARKET_GAP.md` | 94 (S91) | Competitor/market landscape and white space. |
| `87_PERSONAS.md` | 95 (S92) | 17 target personas. |
| `88_JOBS_TO_BE_DONE.md` | 96 (S93) | JTBD per persona. |
| `89_INFORMATION_ARCHITECTURE.md` | 97 (S94) | Conceptual V2 navigation with reasoning. |
| `90_DOMAIN_ARCHITECTURE.md` | 98 (S95) | Conceptual V2 domain boundaries. |
| `91_SECURITY_ARCHITECTURE.md` | 99 (S96) | Future security requirements. |
| `92_COMPLIANCE.md` | 100 (S97) | Compliance considerations; items needing legal review. |
| `93_SCALE.md` | 101 (S98) | Scale dimensions and architectural implications. |
| `94_REBUILD_STRATEGY.md` | 102 (S99) | MIGRATE/REBUILD/REPLACE/MERGE/ARCHIVE/REMOVE per capability. |
| `100_FINAL_RECOMMENDATION.md` | 103 (S100) | Sections A–M final conclusion. |
| `MASTER_AUDIT_REPORT.md` | 110 | The 33-section consolidated final deliverable. |
| `diagrams/` | — | Mermaid/ASCII ERD, architecture, tenant model, event flow. |
| `database/` | — | Consolidated table & policy inventory extracts. |
| `evidence/` | 105 | Raw evidence: route matrix, RLS policy index, secrets scan, SQL/policy registers. |

## 3. Method actually used

1. Cloned `main` at `c9b6f8a` into an isolated read-only directory. No writes to the repository.
2. Enumerated **all 326 tracked files** (9.1 MB) with sizes and paths.
3. Read every configuration file, every `lib/`, `hooks/`, `modules/` file, every one of the
   **58 API route files**, the root layout, dashboard layout, route guard, error boundaries,
   and the security-critical components.
4. Extracted and cross-indexed **all 51 SQL files** for `CREATE TABLE`, `ALTER TABLE … ENABLE
   ROW LEVEL SECURITY`, `CREATE POLICY`, `CREATE FUNCTION`, `SECURITY DEFINER`, `GRANT`, `REVOKE`.
5. Read all Markdown documentation and compared every claim against source.
6. Ran static pattern sweeps for: unauthenticated routes, service-role usage, mass assignment,
   raw SQL interpolation, `dangerouslySetInnerHTML`, `NEXT_PUBLIC_*` secret usage, unused
   dependencies, dead components, and encoding corruption.
7. Classified every finding by severity and confidence, with file:line evidence.

**No live system was accessed.** No Supabase project, no Vercel deployment and no Discord guild
were contacted. Findings that depend on the *deployed* state of the Supabase project (for
example whether `anon` retains default `EXECUTE` grants on functions) are explicitly marked
with the confidence level required by Audit.md §107.

## 4. Evidence standard used (Audit.md §105)

Every non-trivial finding is written as:

```
Finding
Evidence      (file:line, quoted code or command output)
Impact
Confidence    (HIGH / MEDIUM / LOW / UNKNOWN)
Recommendation
```

Security findings additionally carry `Exploitability`, `Impact`, `Affected scope`,
`Recommended remediation` (Audit.md §106).

**Secret values are never reproduced.** Where a secret was found, the audit records only the
file, the variable/field name, the type and the severity, plus a rotation instruction
(Audit.md Rule 7, §22).

## 5. Severity and confidence models

**Severity:** `CRITICAL` → `HIGH` → `MEDIUM` → `LOW` → `INFO`.

**Confidence:**
- `HIGH` — directly observable in committed source or reproducible by a static command.
- `MEDIUM` — strongly implied by source plus documented platform behaviour, but the deployed
  database/config was not inspected.
- `LOW` — plausible inference; depends on runtime data or environment not in the repository.
- `UNKNOWN` — cannot be determined from the repository alone.

## 6. Headline conclusions (full detail in `MASTER_AUDIT_REPORT.md`)

1. **The system is a single-tenant, single-game (PUBG Mobile / BGMI) esports team-operations
   app**, not a SaaS and not an "esports organization OS". There is **no organization entity**
   anywhere in the schema or code.
2. **The security posture is fundamentally unvalidated.** `database/README.md` explicitly
   documents that *"RLS is disabled for development … should be enabled for production."*
   The application was therefore developed and tested against a database with **no row-level
   enforcement**, which is why numerous code paths that use the anonymous Supabase client
   (Discord bot routes, admin agreements, profile search, avatar writes, the whole
   `modules/discord-portal` service layer) appear to work but will fail or become wide open
   once RLS is switched on.
3. **Three unauthenticated, service-role-backed endpoints** (`/api/media/upload`,
   `/api/media/delete`, `/api/public/upload/contact-file`) allow anonymous arbitrary file
   upload and anonymous arbitrary file deletion.
4. **The `anon` key is shipped to every browser and 10 database tables have no RLS at all**,
   including `admin_config` (which stores legal agreement text and a `maintenance_mode` flag)
   and `discord_webhooks` (which stores Discord webhook credentials in plaintext).
5. **~25 `SECURITY DEFINER` functions are granted to `authenticated` and never revoked from
   `anon`**, so PostgREST RPC is an RLS-bypassing, potentially unauthenticated surface.
6. **No test suite of any kind exists.** `package.json` has no `test` script and no test
   framework is installed.
7. **Both lint and TypeScript errors are explicitly ignored at build time**
   (`eslint.ignoreDuringBuilds: true`, `typescript.ignoreBuildErrors: true`), and a real
   `ReferenceError` (`getUserFromRequest` in `app/api/attendances/route.ts:310`) is shipping.
8. **89 % of the 63 commits were authored by AI agents**, all within a single month
   (2025-08). This explains the systematic duplication, dead code, encoding corruption and
   documentation drift, and is itself a critical piece of legacy intelligence.
9. **Fabricated public metrics**: `/api/public/stats` returns hardcoded figures
   (`baseMatches = 3240`, `baseWWCD = 1134`, `baseUnderdogPractice = 37800`) presented on the
   public website as organisational track record.
10. **The valuable legacy assets are narrow but real**: the tryout state machine, the
    slot-expense automation rule, the attendance cutoff/auto-absent rules, tier-based slot
    pricing, the role-level hierarchy, and the Discord embed formatting vocabulary.

## 7. Explicit non-goals of this phase

Per Audit.md §109, this audit does **not** authorise and does **not** perform:
redesigning the frontend, rewriting APIs, redesigning the database, migrating data,
deleting code, changing authentication, changing permissions, or changing production
infrastructure. No such change was made.

## 8. Known limitations of this audit

- The Supabase project's live schema, live RLS state, live grants, live storage-bucket
  configuration and row counts were **not** inspected. Several findings are therefore stated as
  "the repository defines X; if deployed as written, Y follows" with MEDIUM confidence.
- No Discord bot service code exists in this repository (only its HTTP contract), so bot-side
  behaviour could not be traced end to end.
- No automated type-check or test run was performed (no test harness exists; installing the
  full dependency tree was out of scope for an audit-only phase). Compile-level findings are
  based on source reading and symbol-resolution greps.
- Marketplace/competitor research in `86_MARKET_GAP.md` reflects publicly documented product
  positioning as of the audit date and should be re-verified before commercial decisions.
