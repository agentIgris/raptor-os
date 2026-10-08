# 87 - PERSONAS
**Audit.md section:** 95 (SECTION 92)

Derived from the route inventory (`05_ROUTES.md`, 219 files), the DB roles (`08_ROLES_PERMISSIONS.md`),
and the product's actual behaviour. Personas are stated as **jobs with pain**, not as demographics.
Percentages are the audit's own analysis of the 38% player / 43% team-staff / 11% dual-role split
in `08_ROLES_PERMISSIONS.md` §8.

---

## P1 - The Player ("Device ID 1st Percentile")
~38% of users today. Wants to: log in, see their own numbers, attend, keep their private
profile private.
**Currently gets**: a 60 KB monolith dashboard, a public-facing "public profile" with 100% of
their PII, no ability to be deactivated (`57_ACCESSIBILITY.md` F-UX-04), and session sign-outs
after 2 seconds of backend slowness.
**Pains**: their identity is fully readable; a top player is worth 100x a bench player to a
scammer and the system makes that lookup free; prize money is visible but the split is invisible.
**Needs**: an honest, self-service private profile; their own performance history; to be told
what is public; a simple way to withdraw.
**In V2**: `Person` + `Identity` + `PlayerProfile`, a **separate public projection**, and
visibility settings they control.

---

## P2 - The Coach / Team Manager ("Device ID 2nd Percentile")
The real daily user of Raptor today. Wants to: run practice, track attendance, and enter results
fast.
**Currently gets**: attendance that depends on `session_time text`, a DELETE that throws a
`ReferenceError` (`app/api/attendances/route.ts:298`), 5 different entry forms for the same
result, and no roster history.
**Pains**: entering a result takes 8+ decisions; correcting a mistake is indistinguishable from
entering a new one; there is no audit trail when a score is disputed.
**Needs**: one screen that does the common thing in under 10 seconds, with an obvious undo, and a
history that shows who changed what.
**In V2**: `TeamMembership` effective-dated, `Session` + `AttendanceRecord` on a real timestamp,
one performance entry flow, and an audit log.

---

## P3 - The Founder / Owner ("Device ID 3rd Percentile")
Wants to: run the business, not the software. Cares about money, contracts, sponsors, and risk.
**Currently gets**: no finance module, no contracts, no sponsorships, no HR, no payroll. Five
spreadsheets and a Discord bot.
**Pains**: cannot answer "what did we earn and who is owed what?"; cannot prove a player agreed
to a contract; has no idea what the brand owes a sponsor.
**Needs**: one financial picture, one obligation register, one expiry calendar.
**In V2**: the prize/compensation engine, `Contract` + `Agreement`, and
`Sponsorship` + `SponsorshipObligation` (`94_REBUILD_STRATEGY.md` Phase 1).

---

## P4 - The Organisation Admin / Operations Manager
Exists as `admin` / `super_admin` today (`08_ROLES_PERMISSIONS.md` §1). Wants to: manage people,
permissions, config, and integrations.
**Currently gets**: the `admin` role can edit the user list **without holding a view role** (F-RBAC-01),
RLS that is documented as off (F-RLS-01), and no staging.
**Pains**: cannot answer "who can see this player's data?" or "who changed this contract?".
**Needs**: role assignment with an explanation, an audit trail, and configuration that is per
tenant.
**In V2**: `RoleAssignment` + a policy engine (`63_ROLE_MODEL.md`), the audit log
(`49_AUDIT_LOGGING.md`), and `OrganizationConfiguration` (`79_ORG_CONFIGURATION.md`).

---

## P5 - HR / People Ops
Does not exist as a persona in Raptor at all. Wants to: onboard, contract, track, and offboard a
person compliantly.
**Pains today**: no HR entity; minors are handled with no consent, no guardian record, and no
document expiry (`64_FUTURE_HR.md`).
**Needs**: `Person` lifecycle, `Contract`/`Agreement` with provable acceptance, document
expiry, and a data-subject request workflow (`50_DATA_RETENTION.md`).
**In V2**: `64_MULTITENANCY` + `68_FUTURE_HR` + `66_FUTURE_PAYROLL`; **this persona is a
procurement gate, not a nice-to-have**.

---

## P6 - Finance / Operations
Wants: budgets, invoices, prize income allocation, expenses, payroll run.
**Currently gets**: `integer` money with no currency, `slot_expenses` with no invoice
(`31_FINANCE.md` F-FIN-02), prize money never allocated (F-FIN-01), and `GET /api/finance` that
leaks all finance rows to any team member (F-FIN-04).
**Needs**: a double-entry ledger, allocation, and multi-currency (`66_FUTURE_FINANCE.md`).
**In V2**: the finance workstream. Until then, **finance data must be restricted to a finance role.**

---

## P7 - Sponsorship / Partnerships Manager
Exists only as a Discord intake relay (`app/api/public/discord/relay/route.ts`, unauthenticated).
Wants: to track what sponsors are owed and prove delivery.
**Needs**: `Sponsorship`, `SponsorshipObligation` with units and evidence
(`70_FUTURE_SPONSORSHIP.md`), `CommercialInventory` (`38_COMMERCIAL_INVENTORY.md`).
**In V2**: Phase 2 of `94_REBUILD_STRATEGY.md`.

---

## P8 - Content / Creator Manager
Does not exist. Wants: to manage creators, their platforms, their deliverables, and their stats.
**Needs**: `CreatorProfile` + `CreatorPlatformAccount` + `Content` + analytics
(`67_FUTURE_CREATORS`, `68_FUTURE_CONTENT`).
**Blocker today**: the single-role `users.role` model cannot represent
compete + create (`08_ROLES_PERMISSIONS.md` §8), and the player-facing "public profile" means a
creator's audience cannot be discovered.

---

## P9 - The Creator / Content Producer
May or may not compete. Wants: a public presence, sponsorship deliverables, and payment.
**Currently gets**: a `content-ideas` page that posts to a **public, unauthenticated Discord
webhook** (`20_STORAGE.md` F-STOR-01) and no way to track or prove anything.
**Needs**: `CreatorProfile` with public projection, `ContentPiece`, and a link to a contract.
**In V2**: the person-roles model makes this the same `Person` as P1, with an additional role.

---

## P10 - Tournament / Competition Manager
Wants: to enter a team, track slots, and know the rules.
**Currently gets**: slots as a purchase ledger with no match/result entity
(`12_DATABASE_RELATIONSHIPS.md` F-REL-01), no opponent, no bracket, oversellable slots
(`28_TOURNAMENTS.md` F-TOUR-02), and a `tryout_stats` view that bypasses RLS (F-REL-06).
**Needs**: `Competition` + `Entry` + `Result`, plus a check that a slot exists.
**In V2**: `Competition`, `Event`, `Entry`, `Result`, `PrizePool`, `PrizeAllocation`.

---

## P11 - Event / Travel Coordinator
Does not exist. Wants: to book travel for a roster, with documents and consent.
**Needs**: `Event` + `TravelPlan` + `TravelBooking` + `TravelDocument`, with minor-consent rules
(`71_FUTURE_TRAVEL.md`).
**In V2**: Phase 2. Note the current gap: there is no event entity for travel to attach to.

---

## P12 - Facilities / Asset Manager
Does not exist. Wants: to know what hardware the org owns and where it is.
**Currently gets**: only self-reported device data in `profiles` (100% PII, no owner).
**Needs**: `AssetItem` + `AssetCategory` + `AssetAssignment` (`72_FUTURE_ASSETS.md`).
**In V2**: later; lightweight.

---

## P13 - Compliance / Data Protection Officer
Does not exist, and that is the finding. Wants: to answer "can we delete this person's data?"
and "prove we did".
**Currently gets**: no retention, no audit log, no legal hold, world-readable storage.
**Needs**: `AuditLog`, `RetentionPolicy`, erasure workflow, and the security posture in
`91_SECURITY_ARCHITECTURE.md`.
**In V2**: a procurement gate for any enterprise customer.

---

## P14 - The Platform Super-Admin
`super_admin` in Raptor; in V2 a separate internal role, never a tenant role
(`63_ROLE_MODEL.md` §5).
**Needs**: tenant provisioning, feature flags, impersonation with an audit trail, and the ability
to answer "what is this tenant's configuration and who set it".
**In V2**: `82_SAAS_BILLING` provisioning + `79_ORG_CONFIGURATION`.

---

## P15 - Support Engineer
Wants: to reproduce a customer's bug without being able to read their data.
**Currently gets**: no audit log, no impersonation, no tenant diagnostics.
**Needs**: scoped support access with an expiry and an audit entry.

---

## P16 - The Data / Analytics Consumer
Wants: trustworthy numbers, exportable, with a definition.
**Currently gets**: client-side aggregation over unbounded rows, a broken
`total_winnings` metric, fabricated public stats, and a PDF that runs in the browser
(`46_ANALYTICS.md`).
**Needs**: a semantic layer, a data dictionary, and export (`48_IMPORT_EXPORT.md`).

---

## Persona-to-capability map
| Persona | Blocking capabilities in V2 |
| --- | --- |
| P1 Player | private profile, self-service visibility, honest metrics |
| P2 Coach | one fast entry flow, attendance on real timestamps, undo, audit |
| P3 Founder | prize allocation, contracts, sponsor obligations |
| P4 Admin | roles, policy engine, audit, per-tenant config |
| P5 HR | person lifecycle, agreements, documents, data-subject rights |
| P6 Finance | ledger, allocation, multi-currency, restricted access |
| P7 Partnerships | sponsorship obligations and evidence |
| P8/P9 Creator | person-roles, creator profile, content, public projection |
| P10 Competition | competition/event/entry/result/slot-check |
| P11 Travel | event, travel plan, documents, consent |
| P12 Assets | asset register |
| P13 Compliance | audit log, retention, erasure, security posture |
| P14 Platform | provisioning, flags, impersonation |
| P15 Support | scoped impersonation |
| P16 Data | semantic layer, export |

**Every persona except P2 (coach) and P4 (admin) is entirely unserved today. The two that are
partially served are the two that touch the least sensitive data.**
