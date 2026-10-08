# 94 - REBUILD STRATEGY
**Audit.md section:** 102 (SECTION 99)

## 1. Strategic decision: rebuild, do not patch
| Option | Assessment |
| --- | --- |
| **Patch the existing system** | Rejected. The blockers are structural: no organization, no engagement, no ledger, no effective dating, RLS documented as disabled, 14 tables without RLS, no audit log, no tests, no CI, no observability, one role per person, and 5 disagreeing authorisation models (`85_FEATURE_MATRIX.md`). Every one of these is a foundational change, and the absence of tests and a migration ledger means there is no safety net for the change. Patching would accumulate new work on a foundation that cannot be verified. |
| **Rebuild on the existing stack** | **Chosen.** Next.js + Postgres + Supabase is a sound, proven stack for this product. The technology was never the problem. |
| **Adopt a third-party platform** | Rejected. No incumbent performs prize allocation or sponsor obligation tracking (`86_MARKET_GAP.md` §3), and the contract, payroll and finance obligations are too specific. |

**What is preserved from the legacy system:** the tryout domain model and its data
(`29_TRYOUTS.md`), the business rules for attendance and cutoffs (`26_ATTENDANCE.md`), the
slot-expense calculation (`31_FINANCE.md`), the tier pricing semantics (`03_TECH_STACK.md`), the
Discord message vocabulary (`22_DISCORD.md`), and the customer relationships. **No legacy
implementation is preserved.**

## 2. Guiding principles
1. **Data before UI.** The model is the product; the dashboard is a view.
2. **Multi-tenant and international from commit one.** Both are retrofits that are effectively
   rewrites.
3. **Security is a launch gate, not a phase** (`91_SECURITY_ARCHITECTURE.md` §7).
4. **Auditable money.** Every financial figure is derived from a ledger and an event trail.
5. **Explicit over implicit.** No `select('*')`, no client-supplied scope, no hidden defaults.
6. **Boring infrastructure.** Postgres, a queue, object storage, a cache. No distributed
   complexity until measured.
7. **Compliance as a feature** - export, erasure and consent are built with the domain, not bolted
   on (`92_COMPLIANCE.md`).

## 3. Phased plan
Audit.md requires 6 phases. Each phase lists scope, exit criteria, and what it unlocks.

### Phase 0 - Foundation (precedes all user-facing work)
| Item | Detail |
| --- | --- |
| **Scope** | Fork-and-clean the repo; kill `removeConsole` in favour of structured logging; enable typecheck and lint in CI; establish the migration tool and a **schema-diff gate**; stand up staging; create the observability stack (logs, errors, metrics, health); secret rotation; dependency and secret scanning; the test harness |
| **Exit criteria** | `npm run typecheck` and `npm run lint` pass in CI; a test runner executes; staging deploys on merge; logs are structured and retained; a restore from backup is demonstrated; every legacy secret is rotated |
| **Why first** | Every later phase depends on being able to verify and roll back. This is the phase the legacy project never had, and it is the reason the `getUserFromRequest` `ReferenceError` shipped to production (`14_API.md` F-API-01) |

### Phase 1 - Core platform (multi-tenancy, identity, audit)
| Item | Detail |
| --- | --- |
| **Scope** | `Organization`, `OrgMembership`, `Department`, `Person`, `Identity`, `PersonProfile`; `Role`, `RoleAssignment`, the policy engine; the **full RLS program on every table**; the 15-class `AuditLog`; session hardening (server-side, MFA-ready); per-tenant configuration; feature flags |
| **Exit criteria** | Zero tables without forced, tenant-scoped RLS; zero `SECURITY DEFINER` functions without `search_path` and explicit grants; cross-tenant isolation tests pass; 100% of the 15 sensitive action classes logged; a person can have two roles |
| **Unlocks** | Any enterprise conversation. This is the procurement gate (`92_COMPLIANCE.md` §6) |

### Phase 2 - Competitive operations
| Item | Detail |
| --- | --- |
| **Scope** | `Title`/`Game`/`Season`/`Division`; `Team`, **effective-dated `TeamMembership`** with `share_percent`, `TeamStaff`; `Session`/`SessionType`/`AttendanceRecord` with the real timestamp and the existing rules; `Competition`/`Entry`/`Result`/`Standing`; `PerformanceEntry` with a single entry flow and provenance |
| **Exit criteria** | The attendance rules from `26_ATTENDANCE.md` are implemented and unit-tested; a performance entry takes one flow; the tryout state machine is complete end-to-end; "who was on the roster on date X" is answerable from data |
| **Reuses** | The tryout data model; the attendance and slot-expense business rules |

### Phase 3 - Finance and the allocation engine
| Item | Detail |
| --- | --- |
| **Scope** | Double-entry `JournalEntry`/`JournalLine` with currency; `PrizePool`; **`PrizeAllocation`** computed from effective-dated roster shares, versioned and auditable; `Expense` with invoices; `Budget`; `Invoice`/`Payment`; `TaxRule`; reporting read models |
| **Exit criteria** | The ledger balances; an allocation recompute is idempotent and reproducible; a player can see their own allocation; finance data is restricted to a finance role (closing F-FIN-04); a historical allocation can be produced for a migrated customer |
| **Why this phase** | It is the differentiator (`86_MARKET_GAP.md` §3) and the reason an owner will pay (`88_JOBS_TO_BE_DONE.md` C1) |

### Phase 4 - Commercial, content and people
| Item | Detail |
| --- | --- |
| **Scope** | `Contract`/`ContractVersion`/`AgreementAcceptance` with a content hash; `EmployeeRecord`, `CompensationPlan`, `PayComponent`, `PayrollRun` (entitlements only), leave; `Document` with expiry; `GuardianConsent`; `Sponsor`, `Sponsorship`, `SponsorshipTerm`, **`SponsorshipObligation`** with evidence; `CommercialInventory`/`Placement`; `CreatorProfile`, `CreatorPlatformAccount`, `ContentPiece`; `Event`, `TravelPlan`, `TravelBooking`, `TravelDocument`; `AssetItem`/`AssetAssignment` |
| **Exit criteria** | Agreement acceptance is provable; contract expiry alerts fire; a minor cannot be onboarded without guardian consent; a sponsorship obligation can be tracked to delivery with evidence; a data-subject export and erasure run end-to-end |
| **Note** | This phase is large. It can be split, and modules should be **licensed and sold separately** (`82_SAAS_BILLING.md` §2.1) |

### Phase 5 - Platform, integrations and self-serve
| Item | Detail |
| --- | --- |
| **Scope** | `Plan`/`Subscription`/`Invoice`/`UsageRecord` with a verified, idempotent webhook path; entitlement service; `ApiKey`; `WebhookEndpoint`; per-tenant Discord bot, email, calendar, storage; public read API + embeddable widgets; the hosted public site; `DataExportRequest`; white label; `Task`/`WorkflowTemplate`/`WorkflowRun` with a durable engine |
| **Exit criteria** | A customer can sign up, be provisioned, pay, and cancel **without human intervention**; a customer's own developer can consume a documented API; a workflow run survives a process restart; white label changes branding with no code change |

## 4. Cross-cutting work (every phase)
* i18n from phase 1 (`59_INTERNATIONALIZATION.md`); multi-currency from phase 3.
* Accessibility to WCAG 2.1 AA from phase 1 (`57_ACCESSIBILITY.md`).
* Mobile-first from phase 1 (`58_MOBILE.md`).
* Observability, audit and retention from phase 1.
* Test pyramid from phase 0, with cross-tenant isolation tests from phase 1.
* Security review before each phase ships (`91_SECURITY_ARCHITECTURE.md` §7).

## 5. Data migration placement
Migration runs **per customer in phase 2-4**, using the process in `83_DATA_MIGRATION.md`:
assessment -> extract -> transform -> validate -> cut over, with a mandatory dry run and a
sign-off report. The migration tooling itself (CSV/XLSX plus a database importer) is a phase 1-2
deliverable, because without it nothing else can be onboarded (`48_IMPORT_EXPORT.md`).

## 6. What is explicitly not rebuilt
* The 6.1 MB hero video, `/debug/*`, `/api/public/stats`, the hardcoded Discord invite, the
  placeholder `raptor-esports.example` fallbacks, the 27 dead UI components, the 8 unused tables
  (`performance_records`, `bot_attendance`, `discord_servers`, `attendance_debug_log`,
  `profiles`, `communication_logs`, `admin_config`, `user_agreements`).
* The `isSupabaseConnected` pattern and the client-side service-role calls.
* Hardcoded role logic in middleware.

## 7. Resourcing and sequencing reality
This is a multi-quarter programme for a small team, and the honest critical path is:
**Phase 0 -> Phase 1 -> Phase 2 -> Phase 3**, because money cannot be paid correctly without the
person, membership and ledger model. Phases 4 and 5 widen the product but do not block the first
revenue, except that **Phase 1 blocks the first sale** (no enterprise will pass a data-protection
questionnaire).

Sequencing options:
* **Sell-first** (recommended): build Phases 0-3, sell to 3-5 design partners with migration done
  as a service, and use their feedback to scope Phase 4.
* **Broad-first**: attempt all five phases before selling. Higher risk, longer time to revenue,
  and no validation of the allocation engine with real money.
* **Feature-first**: continue extending the legacy system to find product-market fit. Rejected -
  the security and data foundations make this indefensible with customer data.

## 8. Decision gates
| Gate | Question | Stop condition |
| --- | --- | --- |
| After Phase 0 | Can we detect, diagnose and roll back a bad deploy? | If not, do not proceed |
| After Phase 1 | Would an organisation's procurement team pass us? | If not, no enterprise revenue |
| After Phase 2 | Is the daily coaching workflow measurably faster than the legacy tool? | If not, the migration value is wrong |
| After Phase 3 | Can we produce a defensible, reproducible allocation for a real customer? | If not, the differentiator does not exist |
| After Phase 4 | Will an owner renew because of contracts and sponsor obligations? | If not, reconsider the commercial model |
