# 85 - FEATURE MATRIX
**Audit.md section:** 92 (SECTION 89)

Legend
* **Exists** - `FULL` implemented and coherent · `PARTIAL` implemented with material gaps ·
  `SHELL` UI exists, backend cannot work · `DOC-ONLY` claimed/documented, not implemented ·
  `NONE` absent
* **Complete** - would a paying customer accept it as finished? (`Y` / `N`)
* **Secure** - is it safe to expose to a customer? (`Y` / `N` / `PARTIAL`)
* **Valuable** - does it matter to an esports organisation? (`H` high / `M` medium / `L` low)
* **V2 verdict** - `MIGRATE` (data/rules) · `REBUILD` (same capability, new build) ·
  `REPLACE` (different, better model) · `MERGE` (fold into another) · `ARCHIVE` (keep as
  record, do not carry forward) · `REMOVE` (delete) · `UNKNOWN`

| Feature | Exists | Complete | Secure | Valuable | Evidence for the verdict | V2 verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **Authentication** | PARTIAL | N | **N** | H | session in `localStorage` (`lib/supabase.ts:41-43`); no MFA; sign-up profile creation likely broken (no INSERT policy); reset route missing; `removeConsole` hides all failures | **REPLACE** - server session, MFA, SSO |
| **Sessions / session mgmt** | PARTIAL | N | PARTIAL | H | 2 s client timeouts sign users out (`auth-flow-v2:200-245`); refresh + idle timer exist | **REPLACE** |
| **Authorization (RBAC)** | PARTIAL | N | **N** | H | 5 disagreeing models; policy conflicts; team-scope client-supplied | **REPLACE** - policy engine |
| **Multi-tenancy** | **NONE** | N | N | **H** | no organization anywhere (`60_MULTITENANCY.md`) | **BUILD** (prerequisite) |
| **Organizations / legal entities** | **NONE** | N | N | **H** | absent | **BUILD** |
| **Departments / cost centres** | **NONE** | N | N | H | absent | **BUILD** |
| **People / employees** | NONE | N | N | **H** | `users` is an auth profile, not employment | **BUILD** (`62_PEOPLE_MODEL.md`) |
| **Teams** | FULL | **N** | PARTIAL | H | `teams` CRUD works; hard delete cascades away all history; `tier` is a price band; one coach | **REBUILD** |
| **Divisions / competitive tiers** | SHELL | N | PARTIAL | M | `teams.tier` free text + `tier_defaults` rate card | **REPLACE** |
| **Rosters** | PARTIAL | N | **N** | H | duplicated in `users.team_id`; no dates; players can read all PII | **REBUILD** (effective-dated) |
| **Coaches / staff** | SHELL | N | PARTIAL | H | one `coach_id` per team | **REBUILD** (`TeamStaff`) |
| **Player profiles** | FULL | **N** | **N** | M | 62 columns of PII + device telemetry; no consent; over-exposed via `select('*')` | **REBUILD** (minimal PII) |
| **Performance tracking** | PARTIAL | N | **N** | **H** | 5 competing forms; OCR can fabricate; `slot`/`slot_id` ambiguity; players read the whole team | **REBUILD** |
| **Matches / competitions** | **NONE** | N | N | **H** | no match, event, bracket, result, or opponent entity | **BUILD** |
| **Tournaments / entries** | SHELL | N | PARTIAL | H | `slots` is a purchase ledger; slots oversellable | **REPLACE** |
| **Prize money** | SHELL | **N** | **N** | **H** | `winnings` is team-level; never allocated; players can read it; `total_winnings` always 0 | **BUILD** (allocation engine) |
| **Attendance** | PARTIAL | **N** | PARTIAL | **H** | `session_time text`; no uniqueness; 4 trigger definitions; DELETE is a `ReferenceError`; config table has no RLS | **REBUILD** (keep the rules) |
| **Training / sessions** | PARTIAL | N | PARTIAL | M | one flat entity; no plan/block; no scrim; generation not idempotent | **REBUILD** |
| **Scrims** | **NONE** | N | N | M | enum value only | **BUILD** |
| **Tryouts / recruitment** | **PARTIAL** (schema strong, plumbing broken) | **N** | PARTIAL | **H** | best model in the system; 5 of 6 stages unreachable; applicant cannot see status; no offer/contract/onboarding | **MIGRATE the model, REBUILD the plumbing** |
| **Finance** | SHELL | **N** | **N** | **H** | 5 money columns, `integer`, no currency; no ledger/budget/invoice/payment; players can read | **REPLACE** |
| **Compensation** | **NONE** | N | N | **H** | entirely absent | **BUILD** |
| **Payroll** | **NONE** | N | N | **H** | entirely absent | **BUILD** (entitlements only) |
| **Contracts** | SHELL | **N** | **N** | **H** | `user_agreements` has no content hash; content world-writable; editor permanently 403; enforcement fails open | **REBUILD** |
| **HR** | **NONE** | N | N | **H** | absent; minors handled with no safeguards | **BUILD** |
| **Creators** | **NONE** | N | N | **H** | absent; single-role model cannot represent a dual career | **BUILD** |
| **Content** | **NONE** | N | N | H | absent; a public unprotected file bucket | **BUILD** |
| **Sponsorships** | **NONE** | N | N | **H** | absent; intake via an unauthenticated Discord relay | **BUILD** |
| **Commercial inventory** | **NONE** | N | N | **H** | no sellable placement can be modelled | **BUILD** |
| **Travel** | **NONE** | N | N | M | absent; no event to attach to | **BUILD** |
| **Assets / equipment** | **NONE** | N | N | M | absent; only self-reported device data | **BUILD** |
| **Facilities** | **NONE** | N | N | L-M | absent | **BUILD (lightweight, later)** |
| **Tasks / work items** | **NONE** | N | N | **H** | absent; no assignment, deadline or approval anywhere | **BUILD** |
| **Workflow automation** | SHELL | N | **N** | H | 16 hardcoded triggers; outbound HTTP in a transaction; no execution log; not tenant-scoped | **REPLACE** (workflow engine) |
| **Notifications** | SHELL | **N** | **N** | **H** | one channel, per-team opt-in, forgeable log, no read state, no email | **REPLACE** |
| **Email** | **NONE** | N | N | **H** | entirely absent; `SMTP_*` documented and unused | **BUILD** |
| **Discord** | PARTIAL | **N** | **N** | M | outbound works (mojibake embeds); inbound 5 of 13 broken; one replayable key | **REPLACE** (bot per tenant) |
| **Slack / Calendar / WhatsApp** | **NONE** | N | N | M | absent | **BUILD** |
| **Social platform analytics** | **NONE** | N | N | **H** | absent | **BUILD** |
| **Competitive data ingestion** | **NONE** | N | N | **H** | `performance_records` designed, never used | **BUILD** |
| **Reporting** | PARTIAL | **N** | **N** | **H** | 3 of 7 Audit.md categories exist; one metric broken; public report fabricated; client-side aggregation | **REBUILD** |
| **Analytics** | PARTIAL | **N** | **N** | H | client-side over unbounded rows; no semantic layer; "AI insights" are threshold rules | **REPLACE** |
| **Search** | **NONE** (the one endpoint is broken) | N | **N** | H | absent; no global search; no full-text index | **BUILD** |
| **Import / export** | **NONE** (one PDF) | N | **N** | **H** | no CSV/XLSX, no API keys, no tenant export, no data-subject access | **BUILD** (blocks migration) |
| **Audit logging** | **NONE** | N | N | **H** | 0 of 15 sensitive action classes logged | **BUILD** |
| **Notifications of sensitive events** | **NONE** | N | N | **H** | contract/roster/pay changes notify nobody | **BUILD** |
| **Data retention** | **NONE** | N | **N** | **H** | no soft delete in use; no TTL; no legal hold; erasure impossible | **BUILD** |
| **Backups / DR** | DOC-ONLY | N | **N** | **H** | platform-managed, unconfigured, untested; no RPO/RTO | **DOCUMENT + VERIFY** |
| **Observability** | **NONE** | N | N | **H** | `removeConsole` deletes all production logs; no tracking, metrics, health or alerts | **BUILD** |
| **Testing** | **NONE** | N | N | **H** | 0 tests; both gates disabled; a live `ReferenceError` shipped | **BUILD** |
| **CI/CD** | **NONE** | N | N | **H** | no pipeline; manual SQL; no scanning | **BUILD** |
| **Deployment** | PARTIAL | N | N | H | Vercel + Supabase inferred; no staging, no health checks, placeholder URL fallbacks | **REBUILD the process** |
| **Performance** | SHELL | N | N | M | unbounded reads; client aggregation; critical indexes exist only as README text; 6.1 MB video | **REBUILD** |
| **Accessibility** | SHELL | N | N | H | Radix used well, but no testing, dark-only by workaround, no CSP, no motion preference | **REBUILD** |
| **Mobile** | SHELL | N | N | **H** | desktop-first; 60 KB and 50 KB monoliths; dense tables; 6.1 MB video | **REBUILD** |
| **Internationalisation** | **NONE** | N | N | **H** | no framework; no currency; INR hardcoded; naive times; two dead locale columns | **BUILD (pre-condition)** |
| **White label** | **NONE** | N | N | H | architecturally impossible; tokens are global | **BUILD (pre-condition)** |
| **Public website** | SHELL (single org) | **N** | **N** | H | hardcoded brand; fabricated public metrics; no publish control | **REBUILD** |
| **SaaS billing** | **NONE** | N | N | **H** | absent | **BUILD (blocking)** |
| **AI** | **NONE** (mislabeled heuristics) | N | N | M | deterministic rules presented as AI | **REPLACE the labelling; BUILD properly later** |
| **OCR** | PARTIAL | **N** | PARTIAL | M | client-side, fragile parser that can fabricate rows | **REPLACE** (server-side, human-confirmed) |
| **Storage / media** | SHELL | N | **N** | M | 3 unauthenticated endpoints; world-readable bucket; no index, no retention | **REPLACE** |
| **Public stats API** | SHELL | **N** | **N** | L | returns hardcoded fabrications | **REMOVE** |

## Summary counts
| Verdict | Count of the 62 rows above |
| --- | --- |
| BUILD (new capability) | 30 |
| REBUILD (same capability, new build) | 16 |
| REPLACE (different model) | 9 |
| MIGRATE (data/rules into the new build) | 2 (tryouts, attendance rules) |
| REMOVE / ARCHIVE | 5 (media endpoints, public stats, dead tables, debug pages) |
| KEEP as-is | **0** |

**No existing capability is production-ready. The reusable value is concentrated in the business
rules and the tryout data model, not in any implementation.**
