# 90 - DOMAIN ARCHITECTURE
**Audit.md section:** 98 (SECTION 95)

## 1. The core structural finding
**The legacy schema has no organisation, no engagement, and no ledger.** It stores *auth users*,
*teams*, and *activity rows*. Every business question Audit.md asks - who is employed, who is owed
what, who is bound by what, who plays for whom and when - is unanswerable because the entities do
not exist. This is not a normalisation problem; it is a missing model
(`60_MULTITENANCY.md`, `62_PEOPLE_MODEL.md`).

## 2. Bounded contexts
```
IDENTITY        Person, Identity (login), PersonProfile, ConsentRecord
ORGANISATION    Organization, OrgMembership, Department, OrgUnit, Role, RoleAssignment,
                OrganizationConfiguration
COMPETITIVE     Title, Game, Season, Division, Competition, CompetitionTier, Team,
                TeamMembership (effective-dated), TeamStaff, Entry, Result, Standing
TRAINING        Session, SessionType, AttendanceRecord, AttendanceRule, TrainingPlan
PERFORMANCE     PerformanceEntry, MetricDefinition, MetricValue, OCRExtraction, ImportSource
FINANCE         LedgerAccount, JournalEntry, JournalLine, PrizePool, PrizeAllocation,
                Expense, Budget, Invoice, Payment, TaxRule
PEOPLE          Contract, ContractVersion, AgreementTemplate, AgreementAcceptance,
                EmployeeRecord, CompensationPlan, PayComponent, PayComponentAmount,
                PayrollRun, PayrollRunItem, LeaveRequest, Document, DocumentExpiry, Onboarding
COMMERCIAL      Sponsor, Sponsorship, SponsorshipTerm, SponsorshipObligation, ObligationEvidence,
                CommercialInventory, Placement, InventoryBooking, Partner
CONTENT         CreatorProfile, CreatorPlatformAccount, ContentPiece, ContentCalendar,
                Campaign, AnalyticsSnapshot
EVENTS          Event, EventRegistration, Venue, TravelPlan, TravelBooking, TravelDocument
ASSETS          AssetCategory, AssetItem, AssetAssignment, AssetMaintenance, Facility, Room
WORK            Task, TaskAssignment, WorkflowTemplate, WorkflowDefinition, WorkflowRun,
                WorkflowStepRun, Approval
PLATFORM        Tenant, Subscription, Plan, FeatureFlag, AuditLog, Notification, ApiKey,
                WebhookEndpoint, DataExportRequest
```
`Platform` is the only context that is **not** tenant-scoped by data (it is scoped by operator
role instead) - Audit.md §4 requires this split explicitly.

## 3. The five load-bearing decisions
### 3.1 Person != Identity != Membership
`users` conflates an auth login, a human being, an employment record and a team assignment
(`62_PEOPLE_MODEL.md`). V2 separates them:
* `Person` - the human, no login, no auth attributes.
* `Identity` - one login (email, provider, GoTrue id).
* `PersonProfile` - sport-specific data, minimal PII, owner-controlled visibility.
* `OrgMembership` - employment/contracted status in one organisation, with dates and status.
* `TeamMembership` - competitive participation, effective-dated, with a share.

### 3.2 Effective dating everywhere it matters
`TeamMembership` (`valid_from`, `valid_to`, `share_percent`), `Contract` (`start_date`,
`end_date`), `OrgMembership`, `AssetAssignment`, `SponsorshipTerm`. This is what makes
"who was on the roster when the prize was won" answerable, which is the whole basis of the
allocation engine (`66_FUTURE_FINANCE.md` §3.2, `31_FINANCE.md` F-FIN-01).

### 3.3 Money is a ledger, never a column
`slot_expenses`, `winnings`, `teams.prize_pool`, `tier_defaults.prize_pool` are all
`integer` with no currency (`31_FINANCE.md`). V2 uses double-entry `JournalEntry`/`JournalLine`
with an explicit `currency_code` + `exchange_rate` + snapshot, and `PrizeAllocation` referencing
the roster state at the moment of the event.

### 3.4 Multi-role, multi-title by construction
`users.role` is a single enum (`08_ROLES_PERMISSIONS.md` §1). V2 uses `RoleAssignment` +
`PersonRole` competencies, with `Title`/`Game` as data and per-title metric definitions
(`74_FUTURE_AI.md`, `63_ROLE_MODEL.md` §6). A person can compete, create and coach in the same
week.

### 3.5 Configuration is per-tenant, typed and audited
`admin_config` is an untyped, world-writable key/value table used for branding, tiers, features
and even app-wide toggles (`79_ORG_CONFIGURATION.md`). V2 uses typed configuration schemas per
context, namespaced by `organization_id`, versioned and audited.

## 4. Context map
```
IDENTITY  --(Person id)-->  ORGANISATION  --(OrgMembership)-->  PEOPLE
ORGANISATION --(config, branding)--> PLATFORM (white label, entitlements)
COMPETITIVE --(TeamMembership)--> PEOPLE        COMPETITIVE --(Entry/Result)--> FINANCE
TRAINING  --(AttendanceRecord)--> PERFORMANCE    TRAINING --(Session)--> COMPETITIVE
PEOPLE    --(PayComponent)--> FINANCE            PEOPLE --(Contract)--> PLATFORM (audit)
COMMERCIAL --(Obligation)--> CONTENT            COMMERCIAL --(Inventory)--> COMPETITIVE
EVENTS    --(TravelPlan)--> PEOPLE               ASSETS   --(Assignment)--> PEOPLE
WORK      --(Task/Workflow)--> any context       PLATFORM --(AuditLog)--> every write
```
Rules: `FINANCE` reads from `COMPETITIVE` and `PEOPLE` but nothing writes back; `PLATFORM` never
reads domain data except through audited support tooling; `CONTENT` may satisfy
`COMMERCIAL` obligations but may not create financial records directly.

## 5. Anti-corruption of the legacy model
The legacy tables are imported, not wrapped. The migration (`83_DATA_MIGRATION.md`) creates the
V2 entities directly and records provenance. Wrapping `users` as a `Person` would import three
name columns, a duplicated profile table, and a single-role enum into the new model - and would
make the allocation engine unanswerable forever.

## 6. Verdict
The target model is a **person-centric, effective-dated, ledger-backed, multi-tenant** model. It
is deliberately larger than the legacy schema because the legacy schema cannot answer the
business questions the product exists to answer. The cost is migration complexity
(`83_DATA_MIGRATION.md`); the alternative is a product that cannot pay anyone correctly.
