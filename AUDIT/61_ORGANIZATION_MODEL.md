# 61 - ORGANIZATION MODEL (conceptual design only - NOT implemented)
**Audit.md section:** 68 (SECTION 65 - ORGANIZATION MODEL)

> Audit.md: *"Design a conceptual future organization model. Do not implement it."*
> Nothing in this document has been built. It is a design input to the V2 specification.

## 1. Why this is the foundational model
The legacy system has no organization (`30_TEAMS.md` F-TEAM-01). Everything the target product
needs - departments, employment, contracts, budgets, sponsors, facilities, billing, branding,
notifications, permissions - hangs off a legal entity. `Organization` must therefore be the tenant
root, and every other tenant-owned entity must reference it.

## 2. The conceptual model
```
Organization  (the tenant; a legal or commercial entity)
  |
  +-- LegalEntity[]           (the contracting / employing / invoicing entity; an org may
  |                            operate several, e.g. an EU subsidiary; drives tax, payroll
  |                            jurisdiction, invoicing and data residency)
  |     +-- Address, RegistrationNumber, TaxIdentifier, BankAccount (encrypted)
  |
  +-- OrgSettings             (currency, timezone, locale, fiscal year, week start,
  |                            numbering series, approval thresholds, retention policy)
  |
  +-- Department[]            (stable organisational unit: Esports, Content, Commercial,
  |                            Operations, Finance, HR, Legal)
  |     +-- CostCentre         (finance linkage)
  |     +-- DepartmentHead -> Person (effective-dated)
  |
  +-- Division[]              (commercial/competitive grouping: "Raptor Competitive",
  |                            "Raptor Academy", "Creator Division")
  |     +-- Team[]
  |           +-- TeamMembership[]  (effective-dated: Person x Team x RoleInTeam x valid_from/to)
  |           +-- TeamStaff[]       (coach, manager, analyst, assistant - many, effective-dated)
  |           +-- Game[]           (the titles this team competes in)
  |           +-- Competition[]    (an event the org or team enters)
  |           +-- Match[] -> MatchMap[] -> PlayerMatchStat[]
  |           +-- Slot[] / Entry[] / EntryCost[]   (the migrated legacy ledger)
  |
  +-- Person[]                (via OrgMembership; a Person may belong to several orgs)
  |     +-- Employment[]       (Org x Person: employee / contractor / player-contract /
  |                            creator / intern; dates, FTE, work location, manager)
  |     +-- RoleAssignment[]   (RBAC + ABAC scopes)
  |     +-- Contract[]         (see 73_FUTURE_DOCUMENTS.md)
  |     +-- CompensationPlan[] / PayrollLine[]
  |
  +-- Commercial
  |     +-- Partner[] (sponsor, supplier, agency, media)
  |     +-- Deal[] -> Campaign[] -> Deliverable[] -> Proof -> Performance
  |     +-- InventoryItem[] -> ContractObligation[]
  |     +-- Invoice[] / InvoiceLine[] / Payment[] / Receivable[]
  |
  +-- Creators
  |     +-- CreatorProfile[] -> SocialAccount[] -> MetricSnapshot[]
  |     +-- RateCard[] / MediaKit[]
  |
  +-- Content
  |     +-- ContentItem[] -> Asset[] -> Approval[] -> Publication[] -> ContentMetric[]
  |
  +-- Operations
  |     +-- Location[] -> Space[] -> SpaceBooking[]
  |     +-- Asset[] -> AssetAssignment[] -> MaintenanceTicket[]
  |     +-- TravelPlan[] -> Traveller[] -> Booking[] -> TravelExpense[]
  |     +-- WorkItem[] -> Assignment[] -> Approval[]
  |     +-- Session[] (training) / Holiday[] / Availability[]
  |
  +-- Documents  (Document[] -> DocumentVersion[] -> AccessGrant[] -> SignatureRequest[])
  |     +-- Agreement[] -> Acceptance[]
  |
  +-- Finance
        +-- Account[] (chart of accounts) -> JournalEntry[] -> JournalLine[]
        +-- Budget[] -> BudgetLine[] (period variance)
        +-- PayrollPeriod[] -> Payslip[] (executed by an external provider)
        +-- Integration[] (accounting / payroll / banking sync status)
```

## 3. Key modelling decisions and their rationale
| Decision | Rationale | Legacy lesson |
| --- | --- | --- |
| `Organization` is the **tenant root** and every tenant table carries `org_id` | the only way to make isolation structural rather than procedural | `60_MULTITENANCY.md` |
| `LegalEntity` is **separate from `Organization`** | an org may invoice and employ through different entities in different jurisdictions; tax, payroll and data residency follow the entity, not the brand | the legacy system conflates the two (nothing exists) |
| `Department` is **stable**; `Team` is **competitive** | a Content Manager belongs to a department but may support several teams; departments survive reorgs, teams do not | legacy has only `team_id` (`30_TEAMS.md` F-TEAM-02) |
| `Division` is an **optional grouping layer** between org and team | not every org has divisions; modelling it explicitly avoids overloading "team" | legacy has only a free-text `tier` |
| `TeamMembership` is **effective-dated** | "who was on the roster on 12 March" must be answerable for eligibility, prize allocation and disputes | legacy `rosters` has `created_at` only (`F-TEAM-04`) |
| `TeamStaff` is **separate from membership** | a coach manages a team but is not on its roster; one person may hold several staff roles | legacy has a single `coach_id` (`F-TEAM-06`) |
| `Person` is **global**; `Employment` is per-org | the same human may be a player for one org and a contractor for another; identity must not be duplicated | legacy has one `users` row per human with one role |
| `JobTitle`/`Position` is a **reference table**, not an enum | organisations need their own job architecture | legacy `role` is a permission enum |
| `CostCentre` attaches to `Department` and optionally `Team` | makes the finance domain (`66_FUTURE_FINANCE.md`) possible | legacy has no cost centre |
| Every monetary amount carries a **currency** | multi-currency is a hard requirement (`59_INTERNATIONALIZATION.md`) | legacy is `integer` with no currency |
| Every timestamp is `timestamptz` UTC | time zones (`59_INTERNATIONALIZATION.md`) | legacy uses naive `date` / `time without time zone` |

## 4. Cross-cutting conventions
* **Effective dating** on every relationship that has a legal, financial or competitive meaning
  (`valid_from`, `valid_to`, `ended_reason`, never a destructive update).
* **No hard delete** of a `Person`, `Employment`, `Contract`, `Match` or financial record
  (`50_DATA_RETENTION.md`).
* **Compositional FKs include `org_id`**, so a cross-tenant reference is impossible by
  construction.
* **`OrgSettings`** is a typed, versioned configuration entity - not a key/value bag - replacing
  `admin_config` (`79_ORG_CONFIGURATION.md`).
* **Everything is auditable**: every mutation writes an `audit_log` row with a denormalised actor
  (`49_AUDIT_LOGGING.md`).
* **Every domain emits events** into the transactional outbox (`77_EVENT_ARCHITECTURE.md`).

## 5. Explicitly out of scope for the organization model
Group structures with multiple parents; M&A / consolidation; legal-entity hierarchies deeper than
two levels; multi-currency group reporting (handled in finance); statutory consolidation.

## 6. Verdict / status
**DESIGN INPUT ONLY.** This document is a proposal for the V2 specification. It has not been
implemented, and nothing in the legacy repository implements any part of it.
