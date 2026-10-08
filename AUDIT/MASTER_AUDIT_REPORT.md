# MASTER AUDIT REPORT - Raptor (Esports Organisation Tool)

**Source:** https://github.com/RaptorLaunchPage/Beta.git @ `c9b6f8a` (branch `main`), read-only clone at `E:\Raptor\_clone`
**Specification:** `E:\Raptor\Audit.md` (100 sections)
**Audit output:** `E:\Raptor\AUDIT\` (96 documents + supporting evidence)
**Production changes made:** none. This document is the audit, not an implementation.

---

## 1. Executive Summary

Raptor is a competently built prototype wrapped around an unsound foundation. The engineering
quality inside individual files is above average for an AI-assisted build - typed components,
modular layouts, a real component library, a coherent SQL migration history. But the product has
no organisation, no employment model, no ledger, and no multi-tenancy, which means the business
capabilities an esports organisation actually pays for are not merely weak, they are **absent**.

**Headline numbers, all derived from the repository:**

| Measure | Value | Source |
| --- | --- | --- |
| Files inventoried | 326 | `02_FILE_INVENTORY.csv` |
| API route files | 58 (94 method entries) | `evidence/routes/api-matrix.csv` |
| SQL files | 51 | `01_REPOSITORY_MAP.md` |
| Tables extracted | 49 declarations (32 base + tryout/config/deprecated) | `database/table-inventory.csv` |
| RLS policy declarations | 118 | `database/rls-policy-register.csv` |
| Tables with **no** RLS | 14 of 32 | `13_RLS_SECURITY.md` |
| `SECURITY DEFINER` functions without `REVOKE` | ~25 | `13_RLS_SECURITY.md` |
| Unauthenticated mutation endpoints | 3 (media upload, media delete, contact upload) | `15_API_SECURITY.md` |
| Columns identified as PII in `profiles` | **100%** | `20_STORAGE.md` F-STOR-01 |
| Automated tests | **0** | `53_TESTING.md` |
| CI pipelines | **0** | `54_CICD.md` |
| Sensitive action classes audited | **0 of 15** | `49_AUDIT_LOGGING.md` |
| Capabilities assessed as complete | **0 of 62** | `85_FEATURE_MATRIX.md` |
| Multi-tenant by construction | **No** - no organization anywhere | `60_MULTITENANCY.md` |

**The five findings that decide the outcome:**

1. **No tenant.** There is no organization, no `organization_id`, no `OrgMembership` in any of 32
   tables. SaaS cannot be added later without rewriting every table, policy and query. This is
   the single most consequential fact in the audit.
2. **Anonymous read access to everyone's personal data.** `profiles` contains full name, email,
   phone, Discord handle, BGMI id, date of birth, government identifiers (PAN, Aadhaar, DL,
   passport), bank account and IFSC, home address, emergency contact, device model/OS and IP -
   and the bucket and table are reachable with `zero`/`anon`/`RLS=true`. `database/README.md`
   documents RLS as deliberately **disabled** for development and gives no re-enable procedure.
3. **The money does not exist as money.** Every monetary column is `integer`/`numeric` with no
   currency. There is no ledger, no invoice, no payment, no budget. Prize money (`winnings`) is
   recorded at **team level and never allocated to a person** - the single most distinctive
   financial flow in esports is unimplemented. `GET /api/finance` returns all finance rows to any
   authenticated team member.
4. **No accountability.** No audit log, no `updated_at` on most tables, no soft delete, and
   `removeConsole` strips every production log. A disputed score, a disputed contract and a
   disputed payment are all unanswerable.
5. **No safety net.** Zero tests, no CI, `typescript.ignoreBuildErrors` and
   `eslint.ignoreDuringBuilds` both set, 27 dead UI components, and a live `ReferenceError` in the
   attendance DELETE handler that shipped because nothing ever ran.

**Recommendation: rebuild on the same stack.** Next.js + Postgres + Supabase was never the
problem. Preserve the domain knowledge - the tryout model, the attendance and cutoff rules, the
slot-expense calculation, the tier ladder, the Discord vocabulary, the customer relationships -
and re-implement it around a person-centric, effective-dated, ledger-backed, multi-tenant model.
Lead with the **prize allocation engine**, because that is the capability no competitor has and
the only one that touches money and trust simultaneously.

---

## 2. Existing Product

A Discord-centric esports team operations tool used by real players, coaches and owners, mostly
India-centred, monetised via a tier ladder (OCK / SSF / WWF) of paid slots. Its actual value
proposition today is **coordination** - attendance, tryouts, results, announcements - delivered
through a web dashboard plus a Discord bot.

| Attribute | Finding |
| --- | --- |
| Audience | Players (~38%), team staff (~43%), dual-role (~11%), 6 of 219 page files are admin-only (`08_ROLES_PERMISSIONS.md` §8) |
| Titles | BGMI/PUBG-centric, hardcoded (`03_TECH_STACK.md`) |
| Geography | India; INR hardcoded; no currency column anywhere (`59_INTERNATIONALIZATION.md`) |
| Marketing surface | 11 public routes for a single org, with fabricated stats (`81_PUBLIC_WEBSITE.md`) |
| Monetisation | Slot fees only; no SaaS billing, no subscriptions (`82_SAAS_BILLING.md`) |
| Retention driver | Discord community; the product is the back office for it (`22_DISCORD.md`) |
| Maturity | Single-tenant prototype with production traffic and real users |

---

## 3. Existing Architecture

```
Next.js 14 App Router (219 files)
  app/(pages)        32 visible components, 7 dark-only, 5 unreferenced
  app/api            58 route files, 94 methods, hand-rolled Supabase calls
  lib/               supabase clients, auth flow, discord helpers, role utils
  components/ui/     20 shadcn/Radix primitives
  database/          6 setup + 3 fix SQL files
  scripts/           25 migration and fix SQL files (the real schema history)
  automation-scripts/ 9 setup SQL files (RLS + storage)
  tests/             EMPTY
```

* **Rendering:** mixed server/client, with heavy client-side state (`02_FILE_INVENTORY.csv`).
* **Data access:** direct Supabase JS from route handlers and client components; no repository or
  service layer; no generated types (`04_ARCHITECTURE.md`).
* **Auth:** Supabase GoTrue, session in `localStorage`, custom `middleware.ts` redirect logic
  (`09_AUTHENTICATION.md`).
* **State:** React context plus ad-hoc fetches; 60 KB route bundles (`56_PERFORMANCE.md`).
* **Deployment:** Vercel + Supabase, inferred from `.env.example`; no staging, no IaC
  (`55_DEPLOYMENT.md`).
* **Migrations:** 51 ad-hoc SQL scripts with **no migration ledger, no version table, no
  transaction discipline** - which is why four separate scripts exist to de-duplicate the same
  table (`11_DATABASE.md`).

**The architectural verdict:** the codebase is a well-organised prototype that skipped the
foundation layer - tenancy, identity modelling, authorisation, audit, observability, tests. The
skips are not stylistic; they are the reason the product cannot become a SaaS.

---

## 4. Existing Features

Full matrix in `85_FEATURE_MATRIX.md` (62 capabilities). Summary by verdict:

| Verdict | Count | Examples |
| --- | --- | --- |
| BUILD (absent capability) | 30 | multi-tenancy, people, HR, payroll, contracts, sponsorships, content, creators, travel, assets, tasks, workflows, email, audit log, retention, backup verification, observability, tests, CI, search, import/export, i18n, white label, billing, public website, competitive data ingestion |
| REBUILD (exists, unusable) | 16 | attendance, performance, teams, rosters, contracts, finance, notifications, workflows, storage, reporting, analytics, deployment, performance, accessibility, mobile, Discord |
| REPLACE (wrong model) | 9 | authentication, authorisation, sessions, competitive tiers, tournaments, workflows engine, OCR, AI labelling, public stats |
| MIGRATE (data + rules only) | 2 | tryout model and data; attendance business rules |
| ARCHIVE / REMOVE | 5 | media endpoints, public stats, `profiles`, `bot_attendance`, `discord_servers`, `attendance_debug_log`, `performance_records`, 27 dead components, `/debug/*` |
| **KEEP as-is** | **0** | - |

**The asymmetry is the finding:** the work that exists is the least valuable work, and the work
that would be paid for does not exist. `88_JOBS_TO_BE_DONE.md` shows the current feature set is
almost entirely P3/P4 work while every P0 job (pay people correctly, bind them contractually,
provision a customer) is absent.

---

## 5. Existing Business Logic

This is the most valuable output of the audit, because it is portable and it is the part a rebuild
must not lose.

| Logic | Where | Assessment |
| --- | --- | --- |
| **Tier ladder and pricing semantics** | `tier_defaults`, `03_TECH_STACK.md` | **Reusable as-is.** A coherent rate card that predates the code |
| **Slot expense calculation** | `31_FINANCE.md` | **Reusable.** Deterministic, testable |
| **Attendance cutoffs and eligibility** | `26_ATTENDANCE.md` | **Reusable as rules + tests.** Currently implemented 4 inconsistent ways |
| **Session generation from a weekly config** | `27_TRAINING.md` | Reusable, but **not idempotent** - must be fixed |
| **Tryout state machine** | `29_TRYOUTS.md` | **Reusable.** 6 stages, well modelled; 5 of 6 unreachable in the UI |
| **Performance metric formulas** | `25_PERFORMANCE_DOMAIN.md` | Reusable, but 5 different entry forms and an OCR path that can fabricate rows |
| **Roster eligibility for an event** | `30_TEAMS.md` | Reusable, but no effective dating makes it unanswerable historically |
| **Discord message vocabulary** | `22_DISCORD.md` | Reusable verbatim |
| **Leaderboard ranking** | `45_REPORTING.md` | Reusable, but `total_winnings` is permanently 0 (`31_FINANCE.md` F-FIN-05) |
| **OCR screen-score parsing** | `21_OCR.md` | **Do not reuse.** Client-side, fragile, fabricates data (F-OCR-01) |
| **"AI insights"** | `46_ANALYTICS.md` | **Do not reuse.** Deterministic thresholds presented as AI |
| **Fabricated public stats** | `app/api/public/stats:55-57` | **Delete.** `baseMatches=3240`, `baseWWCD=1134`, `baseUnderdogPractice=37800` are constants, not measurements |

---

## 6. Existing Data

49 table declarations across 51 SQL files; 32 base tables, 6 tryout tables, 5 config tables, 6
deprecated. Full inventory: `database/table-inventory.csv`. ERD: `diagrams/erd.mmd` and
`diagrams/erd.txt`.

| Characteristic | Assessment |
| --- | --- |
| Normalisation | **Weak.** `users` vs `profiles` duplicate a person; `users.team_id` vs `rosters` duplicate membership; `performances.slot` vs `slot_id` duplicate a relation |
| Tenancy | **Absent** |
| Employment modelling | **Absent** |
| Uniqueness | **Very weak.** 15 missing constraints, at least 3 of which have already caused real bugs |
| Temporal integrity | **Very weak.** No `updated_at` on most tables; `attendances.session_time` is `text`; no effective dating anywhere |
| Referential integrity | **Weak.** 12+ FKs with no `ON DELETE`; array FKs impossible; `tryouts.team_ids` unenforced |
| Provenance | **Absent.** No `source`, no actor, no audit. OCR-sourced and manual rows are indistinguishable |
| Financial model | **Not a ledger.** `integer` money, no currency, no invoice, no allocation, no payment |
| PII hygiene | **Poor.** 100% of `profiles` is PII; no consent record; no retention; no erasure |
| Best-quality area | The **tryout family** - 6 well-modelled tables with a real state machine |
| Data quality register | 30 defect classes in `84_DATA_QUALITY.md` |

**Data that must not be migrated:** `discord_webhooks` (rotate the credentials), `admin_config`
(untrustworthy, world-writable), `attendance_debug_log` (unprotected PII), and the 5 unused
tables. See `83_DATA_MIGRATION.md`.

---

## 7. Existing Security

Full analysis: `13_RLS_SECURITY.md`, `15_API_SECURITY.md`, `19_SECRETS.md`, `20_STORAGE.md`,
`09_AUTHENTICATION.md`, `10_AUTHORIZATION.md`, `75_AI_SECURITY.md`. Target posture:
`91_SECURITY_ARCHITECTURE.md`.

### CRITICAL

| ID | Finding | Evidence |
| --- | --- | --- |
| F-STOR-01 | `profiles` - **100% PII** including government IDs and bank details - is **readable by `anon`**; the storage bucket is public and world-deletable | `automation-scripts/08`, `app/api/public/upload/contact-file/route.ts` |
| F-RLS-01 | RLS is **documented as disabled** for development, with no re-enable procedure | `database/README.md` |
| F-RLS-02 | 14 of 32 tables have **no RLS** | `database/rls-policy-register.csv` |
| F-API-12 | **Unauthenticated upload and delete** endpoints using the service-role key | `app/api/media/upload/route.ts`, `app/api/media/delete/route.ts` |
| F-SEC-02 | Discord webhook URL stored in a database table, exposed via an unauthenticated route | `app/api/discord/webhook/route.ts` |
| F-SEC-01 | `admin_config` is world-writable and holds app-wide toggles | `scripts/00:270` |
| F-AUTH-01 | Session in `localStorage`, no MFA, no server-side revocation | `lib/supabase.ts:41-43` |
| F-CON-02 | Agreement content is world-writable; acceptance is **unprovable**; the editor is permanently 403; enforcement fails **open** | `app/api/agreements/route.ts` |

### HIGH

`F-RLS-03` recursive policy on `users` (infinite recursion risk) · `F-RLS-04` ~25
`SECURITY DEFINER` functions without `REVOKE` from `anon` · `F-RLS-05` `tryout_stats` view
bypasses RLS and double-counts · `F-RBAC-01` 5 disagreeing role models; `admin` can edit users
without a view role · `F-API-08` team scope supplied by the client · `F-API-01` live
`ReferenceError` in `app/api/attendances/route.ts:298` · `F-API-11` no rate limiting on any of 94
endpoints · `F-AUTH-02` no INSERT policy for sign-up profile creation (orphaned auth users) ·
`F-FIN-04` all finance rows readable by any team member · `F-SEC-03` secrets in git history.

### The systemic finding

Security was treated as a **later phase**, and the one control that would have caught the most -
RLS - is documented as intentionally off. No incident response, no audit log, no monitoring, and
`removeConsole` destroys the evidence needed to investigate (`52_OBSERVABILITY.md`).

---

## 8. Existing Problems

| # | Problem | Impact |
| --- | --- | --- |
| 1 | Not multi-tenant, not retrofittable | **Blocks the entire SaaS thesis** |
| 2 | Anonymous PII access | **Regulatory exposure and a customer-trust failure** |
| 3 | Unauthenticated write endpoints | Data destruction, storage abuse |
| 4 | No allocation of prize money | The core business flow does not exist |
| 5 | No contracts that can be proven | Legal exposure on every engagement |
| 6 | Minors handled with no consent or document tracking | Safeguarding and legal exposure |
| 7 | No audit trail | No dispute can be resolved; no accountability |
| 8 | 5 of 6 tryout stages unreachable | The best feature does not work |
| 9 | Broken endpoints shipping to production (`ReferenceError`, undefined RPCs, missing reset route) | The product appears unreliable |
| 10 | Fabricated public statistics | Reputational and legal risk |
| 11 | Single role per person | Excludes the dominant dual career (compete + create) |
| 12 | No export facility | **Blocks every customer migration** |
| 13 | No tests, no CI, build checks disabled | Every change is unverifiable |
| 14 | No observability; production logs deleted | No incident can be diagnosed |
| 15 | No backup verification or incident process | Unknown data-loss exposure |

---

## 9. Existing Technical Debt

| Category | Debt | Detail |
| --- | --- | --- |
| Verification | **Highest** | 0 tests, 0 CI, `ignoreBuildErrors`, `ignoreDuringBuilds`. 15+ broken code paths unknown until runtime |
| Database | **Highest** | No migration ledger; 51 ad-hoc scripts; 15 missing constraints; 12+ FKs without `ON DELETE`; indexes documented in a README but never created |
| Dead code | High | 27 of 51 UI components unused; 8 unused tables; 5 dark-only pages; `/debug/*` in production |
| Bundles | High | 60 KB (`/team`), 56 KB (`/upload`), 50 KB (`AttendanceModule`), 43 KB (`SidebarContent`); 6.1 MB hero video |
| Data access | High | `select('*')` on PII; unbounded reads; aggregation in the browser |
| Type safety | High | `any` throughout, no generated DB types, 2 timeouts hardcoded as numbers |
| Duplication | Medium | 5 performance entry forms; 4 attendance trigger definitions; role checks repeated in 6+ places |
| Error handling | Medium | Inconsistent; `removeConsole` hides everything; no correlation ids |
| Configuration | Medium | Secrets in `.env.example`; untyped `admin_config`; hardcoded Discord invite and placeholder domains |
| Documentation | Medium | Extensive markdown, but no API spec, no data dictionary, no ADR, no runbook |

**Estimated remediation cost if patched rather than rebuilt:** the debt is foundational, not
superficial. `94_REBUILD_STRATEGY.md` §1 explains why patching was rejected.

---

## 10. Existing Integrations

| Integration | State | Assessment |
| --- | --- | --- |
| **Supabase** (Postgres + GoTrue + Storage) | Deep | Core dependency. RLS misconfigured; service-role key misused in 3 user-facing routes |
| **Discord bot** | Partial | **Outbound works** (with mojibake in embeds); **inbound 5 of 13 handlers broken**; one replayable key; webhook credential stored in the DB |
| **GoTrue auth** | Partial | Works, but no MFA, no reset route, orphaned sign-ups, localStorage session |
| **Vercel** | Inferred | Deployment target; no staging, no preview discipline, no health checks |
| **OCR (client-side)** | Fragile | Tesseract-style parsing in the browser that can fabricate performance rows |
| **Email** | **Absent** | `SMTP_*` documented, never implemented |
| **Slack, WhatsApp, Google/Outlook Calendar** | **Absent** | Documented as future |
| **Social platform APIs** | **Absent** | No creator analytics |
| **Competitive data providers** | **Absent** | `performance_records` designed, never used |
| **Payment provider** | **Absent** | No billing at all |

Full target: `76_INTEGRATIONS.md`, `78_NOTIFICATION_ARCHITECTURE.md`, `77_EVENT_ARCHITECTURE.md`.

---

## 11. Legacy Data Assessment

Full register (30 defect classes) in `84_DATA_QUALITY.md`; migration process in
`83_DATA_MIGRATION.md`.

| Area | Verdict |
| --- | --- |
| People (`users` + `profiles`) | **Migratable with a de-duplication report.** Three name columns, duplicated table, no employment data, no consent record |
| Teams and rosters | Migratable after resolving `users.team_id` vs `rosters`; **no historical membership dates** |
| Performance | Migratable with a provenance flag; `slot`/`slot_id` ambiguity; OCR rows indistinguishable |
| Finance | Migratable as **historical** records with **no currency** and **no prize allocation** - a disclosable gap in the customer's own records |
| Attendance | Migratable after `session_time` normalisation and de-duplication |
| Tryouts | **Migratable with confidence** - the cleanest data in the system |
| Agreements | **Archive only.** No content hash, world-writable content; re-consent required |
| Discord webhooks | **Do not migrate. Rotate.** |
| Debug/unused tables | **Archive; do not migrate** |
| Communication logs | **Archive only**, marked `provenance_unverified` |

**The constraint that shapes the whole migration plan:** there is **no export facility**
(`48_IMPORT_EXPORT.md` F-IMP-03), so the only source is a database extract performed by an
engineer. Migration is a per-customer data project, not a self-serve import - and that must be
reflected in pricing.

**Confidence:** schema and code analysis only; no live database was queried. Row counts, duplicate
frequencies and null rates are **UNKNOWN** and must be measured by the Phase 0 assessment script
before any commercial commitment.

---

## 12. Reusable Business Knowledge

The assets a rebuild must preserve, in priority order:

1. **The tier pricing ladder** (OCK / SSF / WWF) with its fee and prize-pool semantics - a
   coherent commercial model.
2. **The tryout domain model and state machine** - the best design work in the repository.
3. **Attendance rules**: cutoffs, eligibility, session generation, and the reconciliation logic -
   the accumulated operational knowledge of a real team.
4. **Slot expense calculation** and the prize-pool rate card.
5. **Performance metric definitions** (kills, assists, headshots, survival time, damage, score).
6. **Roster eligibility semantics** for entries and events.
7. **The Discord message vocabulary** users already recognise.
8. **Customer relationships and the community** - the reason to rebuild rather than abandon.
9. **The public-site content** as a starting point for the tenant public site.
10. **The OCR intent** - screen-score capture is a real need, even though the implementation must
    be replaced.

Everything in this list is **specification or data**. **No implementation is reusable.**

---

## 13. Recommended Deletions

Delete, do not port:

| Target | Reason |
| --- | --- |
| `app/api/media/upload`, `app/api/media/delete` | Unauthenticated service-role write; superseded by an authorised asset service (`20_STORAGE.md`) |
| `app/api/public/upload/contact-file` | Writes PII into a world-readable bucket |
| `app/api/public/stats` and its three fabricated constants | Publishes invented numbers as fact |
| `/debug/*` (5 routes) | Unauthenticated admin tooling in production |
| `tables: profiles` | Duplicates `users`; 100% PII; superseded by `Person` + `PersonProfile` + restricted `PersonSensitiveData` |
| `tables: performance_records, bot_attendance, discord_servers, attendance_debug_log` | Unused; the last contains unprotected PII |
| `tables: admin_config` | Untyped, world-writable; superseded by `OrganizationConfiguration` |
| `tables: communication_logs` | Forgeable provenance; superseded by `Notification` |
| `removeConsole` and every `console.*` call | Destroys production observability |
| 27 unused UI components; 5 dark-only pages | Dead surface; they imply capabilities that do not exist |
| `getUserFromRequest` (undefined) and all 6 call sites | Live `ReferenceError` |
| RPC calls to `bulletproof_user_update` and `get_all_users_admin` | Undefined functions; the features behind them do not work |
| The `/auth/reset-password` expectation | No such route exists |
| Client-side OCR score fabrication | Can invent performance data |
| `middleware.ts` hardcoded role lists | Duplicates and contradicts the DB policies |
| Hardcoded Discord invite and `raptor-esports.example` fallbacks | Tenant configuration |
| The 6.1 MB hero video | Replace with an optimised asset |

---

## 14. Recommended Rebuilds

| Capability | Verdict | Target spec |
| --- | --- | --- |
| Multi-tenancy, organisation, departments | **BUILD** (prerequisite) | `60_MULTITENANCY.md`, `61_ORGANIZATION_MODEL.md` |
| Person / identity / engagement | **BUILD** | `62_PEOPLE_MODEL.md` |
| Roles and policy engine | **REPLACE** | `63_ROLE_MODEL.md` |
| Teams, effective-dated membership, staff | **REBUILD** | `30_TEAMS.md` |
| Competitions, entries, results, standings | **BUILD** | `28_TOURNAMENTS.md`, `90_DOMAIN_ARCHITECTURE.md` |
| Sessions and attendance | **REBUILD the rules, not the code** | `26_ATTENDANCE.md` |
| Performance | **REBUILD** | `25_PERFORMANCE_DOMAIN.md` |
| Tryouts | **MIGRATE the model, REBUILD the plumbing** | `29_TRYOUTS.md` |
| Ledger, currency, prize allocation | **BUILD (the wedge)** | `66_FUTURE_FINANCE.md` |
| Compensation, payroll, HR, documents | **BUILD** | `65_FUTURE_PAYROLL.md`, `64_FUTURE_HR.md`, `73_FUTURE_DOCUMENTS.md` |
| Contracts and provable agreements | **REBUILD** | `33_CONTRACTS.md` |
| Sponsorships, obligations, inventory | **BUILD** | `70_FUTURE_SPONSORSHIP.md`, `38_COMMERCIAL_INVENTORY.md`, `69_FUTURE_PARTNERSHIPS.md` |
| Creators, content, campaigns | **BUILD** | `67_FUTURE_CREATORS.md`, `68_FUTURE_CONTENT.md` |
| Travel, events, assets, facilities | **BUILD** | `71_FUTURE_TRAVEL.md`, `72_FUTURE_ASSETS.md`, `41_FACILITIES.md` |
| Tasks and workflow automation | **BUILD** | `43_TASKS.md`, `44_WORKFLOWS.md` |
| Email and notification architecture | **BUILD** | `23_EMAIL.md`, `78_NOTIFICATION_ARCHITECTURE.md` |
| Discord, calendar, social integrations | **REPLACE / BUILD** | `76_INTEGRATIONS.md` |
| Search, import/export, reporting, analytics | **BUILD** | `47_SEARCH.md`, `48_IMPORT_EXPORT.md`, `45_REPORTING.md`, `46_ANALYTICS.md` |
| Audit log, retention, backups, observability | **BUILD** | `49_AUDIT_LOGGING.md`, `50_DATA_RETENTION.md`, `51_BACKUPS.md`, `52_OBSERVABILITY.md` |
| Testing, CI/CD, deployment process | **BUILD** | `53_TESTING.md`, `54_CICD.md`, `55_DEPLOYMENT.md` |
| i18n, multi-currency, white label | **BUILD** | `59_INTERNATIONALIZATION.md`, `80_WHITE_LABEL.md` |
| Public website, SaaS billing | **BUILD** | `81_PUBLIC_WEBSITE.md`, `82_SAAS_BILLING.md` |
| AI capabilities | **REPLACE the labelling, BUILD properly later** | `74_FUTURE_AI.md`, `75_AI_SECURITY.md` |

Phasing, exit criteria and decision gates: `94_REBUILD_STRATEGY.md`.

---

## 15. Target SaaS Vision

**A multi-tenant Esports Organisation OS**: one system of record for a competitive esports
organisation - competitive operations, people and contracts, money, sponsorships, content, travel
and assets - sold per organisation with module licensing and usage-based platform fees, white
labelled per tenant, in any language and currency, with an audit trail and data-subject rights as
first-class features.

**Positioning:** the system of record for esports organisations, not a team-management tool. The
wedge is **money and obligations**; competitive operations is the retention driver; the public site
is the acquisition channel.

**Buyer:** the organisation owner or operations manager. **User:** the coach. **Non-user:** the
player, whose data must be protected rather than exposed.

**Commercial model:** Starter / Growth / Enterprise plans, seats on active people excluding
applicants, optional module licences, metered platform usage with hard caps, and migration sold as
a service (`82_SAAS_BILLING.md`).

**What makes it defensible:** the effective-dated person-and-obligation model, the auditable
allocation engine, and the migration tool that carries a customer's history in. Not the UI.

---

## 16. Target Organization Model

`Organization` (the tenant) -> `OrgMembership` (a person's relationship to it, with dates, status
and worker classification) -> `Department` / `OrgUnit` (cost centres) -> `Role` /
`RoleAssignment` (scoped, dated, justified). Branding, configuration, notification rules, data
residency and entitlements hang off the organization.

Key decisions: an organization is a **legal and commercial** boundary as well as a data boundary;
one database with `organization_id` on every table plus RLS, not a database per tenant (with a
documented exception path for customers requiring physical isolation); every query is
tenant-scoped by a policy that mentions the organization first; and **no tenant may exist without
a configuration, a role set and a notification baseline** (`60_MULTITENANCY.md`,
`61_ORGANIZATION_MODEL.md`, `79_ORG_CONFIGURATION.md`).

---

## 17. Target People Model

`Person` (a human, no login) is separate from `Identity` (a login), from `PersonProfile`
(sport-specific, minimal, owner-controlled visibility), and from `OrgMembership` (employment or
contract). A person holds **multiple** `RoleAssignment` rows across organizations and can be a
player, a creator and a coach simultaneously - the single most common real career path in the
industry and the one the legacy single-role enum cannot represent.

`PersonSensitiveData` (government IDs, bank details, date of birth) is a separately permissioned
store, encrypted, minimised, and never part of a public projection. Consent is recorded per
purpose (`likeness`, `marketing`, `processing`) and is revocable. Minors require
`GuardianConsent`; under-13 accounts are blocked. Employment, contracts, compensation, leave and
documents are all dated and auditable (`62_PEOPLE_MODEL.md`, `64_FUTURE_HR.md`,
`65_FUTURE_PAYROLL.md`, `73_FUTURE_DOCUMENTS.md`).

---

## 18. Target Competitive Model

`Title` -> `Game` -> `Season` -> `Division` -> `Competition` -> `CompetitionTier`, with `Entry`
(the team's participation, replacing `slots` as a purchase ledger) -> `Result` (an actual match
outcome against a named opponent) -> `Standing`. `Team`, effective-dated `TeamMembership` with
`share_percent`, and `TeamStaff`. `Session` / `SessionType` / `AttendanceRecord` on real
timestamps, driven by the recovered business rules. `PerformanceEntry` with a **single** entry
flow and an explicit `source` (`manual | ocr | import | api`) plus provenance.

The design principle: **a slot is a purchase, an entry is a participation, and a result is an
outcome** - the legacy schema conflates all three, which is why overselling is possible and why
no result can ever be recorded. Multi-title and multi-region are data, not code
(`28_TOURNAMENTS.md`, `25_PERFORMANCE_DOMAIN.md`, `26_ATTENDANCE.md`, `27_TRAINING.md`).

---

## 19. Target Creator Model

`CreatorProfile` (a person with a public projection the person controls) -> `CreatorPlatformAccount`
(one per platform, with handle, URL and audience snapshots) -> `AnalyticsSnapshot` (a time series,
never a live count) -> `ContentPiece` (a piece of content with platform, publish date, metrics and
**a link to the `SponsorshipObligation` it satisfies**).

The enabling change is `RoleAssignment`: a creator who also competes is one `Person` with two
roles, not two records. The commercial change is the obligation link - it turns "I made content"
into "I delivered 4 of 6 contracted posts", which is what a sponsor renews on
(`67_FUTURE_CREATORS.md`, `68_FUTURE_CONTENT.md`).

---

## 20. Target Content Model

`ContentCalendar` (planned) -> `ContentPiece` (published) -> `Campaign` (grouped) -> per-platform
`AnalyticsSnapshot`. Every piece links to a `Person` (author), optionally to a
`SponsorshipObligation` (deliverable), and to `ContentAsset` (private files). Assets are private
by default, referenced by a signed URL, with a retention policy - replacing the public webhook and
the public bucket entirely. Metrics are snapshots with an "as of" date; **no fabricated numbers
appear anywhere** (`68_FUTURE_CONTENT.md`).

---

## 21. Target Commercial Model

`Sponsor` -> `Sponsorship` (the deal) -> `SponsorshipTerm` (dated) -> **`SponsorshipObligation`**
(the unit of delivery: a placement, a post, a logo appearance, a disclosure, each with a quantity,
a due date, an owner and a status) -> `ObligationEvidence` (the proof) -> `Invoice`.

`CommercialInventory` describes what is sellable: jersey placements, venue branding, content
slots, naming rights, ticket allocations - each with a unit, a rate and an availability calendar.
`InventoryBooking` prevents double-selling, which the legacy slot model never could.

Intake (a sponsor enquiry) is a first-class `Partner` lead with consent, not a Discord relay. This
is the second-ranked market gap and a primary reason an owner renews
(`37_SPONSORSHIPS.md`, `38_COMMERCIAL_INVENTORY.md`, `70_FUTURE_SPONSORSHIP.md`,
`69_FUTURE_PARTNERSHIPS.md`).

---

## 22. Target Finance Model

Double-entry `JournalEntry` / `JournalLine` against `LedgerAccount`, with explicit `currency_code`
and an `exchange_rate` snapshot. `PrizePool` on a competition; **`PrizeAllocation`** computed from
effective-dated `TeamMembership.share_percent` at the moment of the result, versioned, immutable
and reproducible. `Expense` with an invoice attachment. `Budget` per department. `Invoice`,
`Payment`, `TaxRule`, `CreditNote`.

Rules: the ledger is the only source of financial truth; allocations are recomputable and
idempotent; a player can see their own allocation; **finance data is restricted to a finance role**
(closing the legacy leak where any team member reads all finance rows); and every monetary figure
carries a currency. Entitlement-based payroll (`PayComponent`, `PayrollRun`) runs from contracts
and compensation plans, not from spreadsheets (`31_FINANCE.md`, `66_FUTURE_FINANCE.md`,
`65_FUTURE_PAYROLL.md`).

---

## 23. Target HR Model

`EmployeeRecord` (worker classification, start/end, department) -> `Contract` ->
`ContractVersion` (immutable, hashed) -> `AgreementAcceptance` (who, what version, when, from where)
- the replacement for an unprovable, world-writable agreement blob.

`Onboarding` / `Offboarding` checklists with owners and due dates. `LeaveRequest` with a balance
derived from entitlement. `Document` with `DocumentExpiry` and reminders - the mechanism that keeps
government IDs, visas and medical documents current. **Minor safeguarding**: `GuardianConsent`
recorded before an under-18 can participate, with training-load limits and enforced rest
requirements. Data-subject requests (`DataExportRequest`, `ErasureRequest`) with a legal-hold
exception. Every action audited (`34_HR.md`, `64_FUTURE_HR.md`, `73_FUTURE_DOCUMENTS.md`).

---

## 24. Target Operations Model

`Task` / `TaskAssignment` (the work primitive, absent today) -> `WorkflowTemplate` ->
`WorkflowDefinition` (versioned, with a migration path) -> `WorkflowRun` -> `WorkflowStepRun` (with
retries, idempotency keys and a durable execution log) -> `Approval`.

Fourteen workflows ship by default: tryout pipeline, contract renewal, sponsor obligation
fulfilment, invoice collection, travel approval, document expiry, attendance dispute, new-hire
onboarding, prize disbursement, incident escalation, data-subject request, quarterly access
review, backup verification, offboarding.

The legacy model (16 hardcoded triggers firing outbound HTTP inside a transaction, with no
execution log and no tenant scoping) is replaced by a durable engine, because a sponsor obligation
or a payroll run cannot depend on a webhook that silently failed
(`43_TASKS.md`, `44_WORKFLOWS.md`, `77_EVENT_ARCHITECTURE.md`).

---

## 25. Target Analytics Model

A **semantic layer** with a documented metric definition for every figure, computed in SQL or the
warehouse - never in the browser. Timeseries tables (`PerformanceEntry`, `AttendanceRecord`,
`AnalyticsSnapshot`) partitioned by month once measured. A read replica for reporting and exports.
A data dictionary that states, for each metric, its definition, its owner and its known gaps.

Legacy debt to clear: client-side aggregation over unbounded downloads; a `total_winnings` metric
that is permanently 0; three fabricated public constants; and "AI insights" that are deterministic
threshold rules. **A metric without a written definition does not ship**
(`45_REPORTING.md`, `46_ANALYTICS.md`).

---

## 26. Target AI Model

Every AI capability is labelled by what it actually is, and a rule is never called AI.

| Now (mislabeled) | V2 |
| --- | --- |
| "AI insights" from thresholds | Deterministic rules, labelled as such |
| Client-side OCR parsing that can fabricate rows | Server-side extraction, **human-confirmed**, never auto-committed |
| No model, no data policy | A documented, tenant-scoped data policy |

Opportunity areas, in order: **document and screenshot extraction** (OCR, always
human-confirmed); **summarisation** (session and tryout notes, with source links); **retrieval over
the tenant's own data** with strict tenant scoping; **forecasting** (attendance, performance
trends) labelled as a statistical estimate; **anomaly detection** on finance and attendance with a
human review step; and **conversational QA** over a tenant's own records. Hard rules: no
autonomous decision with legal or financial effect, no training on customer data, no cross-tenant
leakage, and prompt-injection defence on any agent that can call tools
(`74_FUTURE_AI.md`, `75_AI_SECURITY.md`).

---

## 27. Target Multi-Tenant Architecture

Single database, `organization_id` on **every** tenant-owned table, RLS forced on every table, and
a policy that resolves the tenant first. Row-level scoping in the indexes. Platform-level tables
(tenant, plan, entitlement, feature flag) isolated as an explicitly separate context
(`90_DOMAIN_ARCHITECTURE.md`).

Non-negotiables: no query may omit the tenant predicate; no `SECURITY DEFINER` function without an
explicit `search_path` and grants; no view that bypasses RLS; no service-role key in a user-facing
route; cross-tenant isolation covered by automated tests; and a physical-isolation escape hatch
documented for customers who require it (`60_MULTITENANCY.md`, `91_SECURITY_ARCHITECTURE.md`).

---

## 28. Target Security Architecture

Four independent layers - edge, application, data, assurance - with the full control set, threat
table and the **10 launch acceptance criteria** in `91_SECURITY_ARCHITECTURE.md`. The controls
that matter most for this product: tenant-scoped RLS on every table; provable agreement acceptance;
encrypted, separately permissioned sensitive PII; audited money; guardian consent for minors;
documented retention and erasure; and an audit log covering all 15 sensitive action classes
(`13_RLS_SECURITY.md`, `15_API_SECURITY.md`, `19_SECRETS.md`, `20_STORAGE.md`, `33_CONTRACTS.md`,
`75_AI_SECURITY.md`).

---

## 29. Target Integration Architecture

| Integration | Direction | Model |
| --- | --- | --- |
| **Supabase/Postgres** | Internal | System of record; RLS; per-tenant config |
| **Discord** | Bidirectional | **One bot per tenant**, verified interactions, replay protection, rate limits, durable outbox |
| **Email** | Outbound | Provider-agnostic; templates per tenant; bounce handling; the channel every notification policy needs |
| **Calendar** | Bidirectional | Sessions, events, travel |
| **Storage** | Internal | Private by default; signed URLs; authorised upload endpoint |
| **Payments** | Inbound | Verified, idempotent, replay-safe webhooks as the source of truth for entitlement |
| **Social platforms** | Inbound | Read-only audience snapshots per creator account |
| **Competitive data** | Inbound | Optional, per title, licensing-compliant; never resold |
| **Webhooks out** | Outbound | Signed, versioned, retried, with a customer-visible delivery log |
| **Public site** | Outbound | CDN-rendered from a publishable-only projection |

Pattern for all outbound calls: **durable queue, not request-path HTTP** - the legacy
outbound-HTTP-inside-a-transaction pattern is the reason notifications are unreliable
(`76_INTEGRATIONS.md`, `78_NOTIFICATION_ARCHITECTURE.md`, `77_EVENT_ARCHITECTURE.md`).

---

## 30. Migration Strategy

Per customer, six phases, with a mandatory dry run and a customer sign-off report
(`83_DATA_MIGRATION.md`):

```
Phase 0  Assessment   Read-only analysis -> data quality report -> customer sign-off
Phase 1  Extract      Pinned script -> typed NDJSON + manifest with SHA-256 checksums
Phase 2  Transform    De-duplicate people and membership, normalise times, resolve slot ambiguity,
                     create V2 entities, record provenance, ROTATE webhook credentials
Phase 3  Validate     Referential integrity, no cross-tenant rows, counts vs manifest,
                     side-by-side reconciliation report, 50-100 sampled manual records
Phase 4  Cut over     Rehearsed, timed runbook with rollback + 30-day hypercare
```

Plus: the **import facility** (CSV/XLSX with mapping, a dry-run report, idempotent natural keys) and
a **database-level importer** for large tenants, both built in Phase 1-2 of the rebuild because
without them nothing can be onboarded.

Disclosable gaps: no compensation history exists; historical prize allocations were never recorded;
roster history before migration is unknown; agreement provenance is unprovable; and the customer
cannot export their own data, so an engineer is required. **These belong in the sales conversation
and the contract.**

---

## 31. Major Risks

| # | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| 1 | A customer is breached through the anonymous PII exposure | Medium | **Severe** - regulatory and reputational | Contain now: rotate secrets, make `profiles` private, disable the unauthenticated endpoints, enable RLS |
| 2 | The rebuild takes longer than the runway | **High** | Severe | Sell-first with 3-5 design partners; Phase 0-3 is the revenue path; scope Phase 4 by customer demand |
| 3 | Scope creep - attempting all 5 phases before selling | High | Severe | Phase gates in `94_REBUILD_STRATEGY.md`; sell after Phase 3 |
| 4 | Migration is harder or slower than estimated (no export facility, unmeasured duplicates) | **High** | High | Phase 0 assessment before any commitment; sell migration as a service; mandatory dry runs |
| 5 | Minors' data exposure | Medium | Severe | Guardian consent, data minimisation, restricted sensitive store, age-appropriate design |
| 6 | An incumbent adds prize allocation | Low-Medium | Medium | Go deeper; own the operational system of record, not a bolt-on |
| 7 | Data-provider licensing cost | Medium | Medium | Ingestion optional and per title; never resell raw data |
| 8 | Price sensitivity in small esports orgs | High | Medium | Real free tier with export; paid tier that pays for itself on prize and sponsor admin |
| 9 | Key-person dependency on undocumented business rules | **High** | High | Extract rules into specs and tests **now**, while the original author is available |
| 10 | The audit's unverified assumptions prove wrong in production | Medium | Medium | Phase 0 measures prevalence; every unverified claim is marked (`84_DATA_QUALITY.md` §4) |

---

## 32. Open Questions

**Must be answered by inspecting the live environment (unavailable in this audit):**

1. Is RLS actually enabled in the deployed Supabase project, and do the grants match the scripts?
2. Is the `storage-profiles` bucket still public, and what is actually in it?
3. What are the real row counts, duplicate rates and null rates per table?
4. Which of the 51 SQL scripts have actually been applied, in what order?
5. Are the 27 documented indexes present in the live database?
6. Is there compensating infrastructure outside the repository - a WAF, Supabase advisor, a manual
   review process?
7. What are real usage patterns, traffic peaks and the true role distribution?
8. Is any compensating control protecting minors?

**Must be answered by the business:**

9. Who is the buyer, and what budget exists?
10. Will customers accept a data project (migration) as part of onboarding?
11. Which modules are sold first, and which are enterprise-only?
12. Is the public site hosted by the platform or owned by the customer?
13. What is the pricing model, and is usage metered?
14. Who owns the brand, and does white label apply to all tenants or only Enterprise?

**Must be answered technically:**

15. Which title is first in V2, and how many are supported at launch?
16. Single-region or multi-region data residency at launch?
17. Physical tenant isolation ever required, or is logical isolation acceptable?
18. Is the OCR flow a must-have for launch, or Phase 2?
19. What is the payroll scope - calculation only, or filing and payment?
20. Which legal entities and jurisdictions at launch?

---

## 33. Recommended Next Steps

### Immediate (this week) - containment, no rebuild required

1. **Rotate every exposed secret** - Discord webhook, provider keys, database URL. They are in git
   history (`19_SECRETS.md`).
2. **Make `profiles` and `contact_files` private; disable the three unauthenticated upload/delete
   endpoints.**
3. **Remove `/api/public/stats`** and the fabricated constants.
4. **Enable RLS on all 14 unprotected tables** and revoke `anon` grants on people data, following
   the documented procedure.
5. **Disable `/debug/*`** in production.
6. Add a secret-scanning pre-commit hook and a CI block on `ignoreBuildErrors` /
   `ignoreDuringBuilds`.

### Short term (Phase 0) - the safety net that does not exist

7. Turn on typecheck and lint in CI; establish the migration ledger; stand up staging; replace
   `removeConsole` with structured logging; add error tracking, metrics and health checks; run a
   **backup restore test**; build the test harness.

### Then, in order

8. **Phase 1** - multi-tenancy, person/engagement model, policy engine, audit log. This is what
   makes an enterprise sale possible.
9. **Phase 2** - competitive operations, carrying over the tryout data and attendance rules.
10. **Phase 3** - the ledger and the prize allocation engine. **This is the product.**
11. **Phase 4-5** - contracts, HR, payroll, sponsorships, content, billing, integrations, public
    site. Widen only after the core is proven with real money.
12. **Migrate each customer** with the assessed six-phase process, sold as a service.

### Parallel, non-negotiable

13. **Extract the business rules from the current code into written specifications and test cases
    while the domain knowledge is still available** (Risk 9).
14. Run the **Phase 0 data assessment** on the live database before making any migration or pricing
    commitment.
15. **Do not start the V2 specification** until the customer decisions in §32 are answered - the
    audit's foundation is complete, and per Audit.md §112 the V2 specification is a separate,
    explicitly-authorised deliverable.

---

## Appendix A - Evidence index

| Artifact | Contents |
| --- | --- |
| `02_FILE_INVENTORY.csv` | 326 files, categorised |
| `database/table-inventory.csv` | 49 table declarations with keys, indexes, policies, triggers |
| `database/rls-policy-register.csv` | 118 RLS policy declarations with table, command and predicate |
| `evidence/routes/api-matrix.csv` / `.md` | 58 route files, 94 methods, auth/service-role/validation per entry |
| `evidence/secrets-scan/scan-results.csv` | Redacted secret scan, no values |
| `diagrams/erd.mmd` | Mermaid ERD, renderable at mermaid.live |
| `diagrams/erd.txt` | Plain-text ERD with relationship classification and defect markers |

## Appendix B - Evidence standard and confidence

Every finding in this audit uses: **Finding / Evidence / Impact / Confidence / Recommendation**,
with security findings additionally carrying **Exploitability, Impact, Affected scope, Remediation**.
Severity: CRITICAL / HIGH / MEDIUM / LOW / INFO. Confidence: HIGH / MEDIUM / LOW / UNKNOWN.

**HIGH** confidence: repository, schema, RLS, routes, permissions, data-quality register, feature
matrix. **MEDIUM**: production impact and defect prevalence (no live database queried). **LOW /
UNKNOWN**: deployed RLS state, real grants, bucket configuration, row counts, traffic, and any
control outside this repository. Market claims are desk research; legal statements are
requirements, not advice.

## Appendix C - Classification summary

KEEP 0 · REBUILD 16 · REPLACE 9 · MERGE 0 · MIGRATE 2 · ARCHIVE 3 · REMOVE 5 · BUILD 30 (new
capability) · UNKNOWN 0. Full rationale per capability in `85_FEATURE_MATRIX.md`.

**No legacy implementation is kept as-is. The reusable value is business rules and the tryout data
model, not code.**
