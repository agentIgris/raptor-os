# 64 - FUTURE HR (requirements only - NOT implemented)
**Audit.md section:** 71 (SECTION 68 - FUTURE HRIS)

## 1. Starting position
HR is effectively absent (`34_HR.md`). The only HR-adjacent artefacts are a self-service
onboarding form, a 4-value `users.status` enum, an emergency-contact pair, and a legal-acceptance
record.

## 2. Requirements

### 2.1 Core employment
* `Employment` per the People model (`62_PEOPLE_MODEL.md`): type (employee / contractor /
  player-contract / creator / intern / advisor), effective dates, FTE, work location, reporting
  line, cost centre, department.
* **Multiple concurrent employments** must be first-class (compete + stream + coach a junior team).
* `Position` / `JobTitle` as tenant-configurable reference data with a hierarchy, distinct from
  permission roles.

### 2.2 Hiring and onboarding
* **Requisition** -> **Applicant** (a provisional `Person`) -> **Application** -> **Interview
  stages** -> **Offer** -> **Contract** -> **Onboarding checklist** -> active employment.
  The tryout module (`29_TRYOUTS.md`) is a specialised recruitment funnel and should share the
  applicant identity.
* Onboarding checklist templates per role and jurisdiction, with tasks, owners, due dates and
  evidence (signed contract, right-to-work check, bank details, guardian consent for a minor,
  device issued, accounts provisioned).
* **Offboarding**: resignation/termination, final-pay calculation input, asset recovery checklist
  (`72_FUTURE_ASSETS.md`), access revocation, knowledge transfer, exit interview, and a
  retention/retention-period marker.

### 2.3 Leave and absence
* `LeavePolicy` (annual, sick, parental, bereavement, unpaid, sabbatical) with per-jurisdiction
  minimums, accrual rules and carry-over.
* `LeaveRequest` with an approval workflow, a delegated approver, and a balance ledger.
* **Distinguish leave from training attendance.** The legacy `attendances` model conflates
  "was at practice" with "was at work" (`26_ATTENDANCE.md`).
* Public holidays per jurisdiction, with a `WorkCalendar` per location.

### 2.4 Performance management
* `ReviewCycle` (probation, annual, ad hoc) -> `Review` (self, manager, peer, upfeed) ->
  `Goal` / `DevelopmentPlan`.
* Probation reviews with an explicit pass/fail decision and an audit record.
* **Separation of duty:** a reviewer may not review their own report; enforced by a policy
  condition (`63_ROLE_MODEL.md` §4).

### 2.5 Documents and compliance
* Every contract, addendum, policy acknowledgement and mandatory training record as a
  `Document` + `DocumentVersion` with a content hash (`73_FUTURE_DOCUMENTS.md`).
* Right-to-work / eligibility verification with expiry alerts.
* Mandatory-training tracking with expiry (health and safety, data protection, safeguarding -
  the last is essential for an organisation working with minors).
* Disciplinary and grievance cases with a confidential access model.

### 2.6 Safeguarding and minors (non-negotiable for esports)
* `age_restricted` on the employment; guardian linkage and `GuardianConsent` documents.
* Safeguarding policy, training records, and a designated safeguarding lead role.
* Restricted visibility of minors' data (DOB, address, guardian details) to a named subset of
  roles, enforced in RLS and in the API, not in the UI.
* Age re-verification cadence.

## 3. What must NOT be built
* Payroll execution (see `65_FUTURE_PAYROLL.md`).
* Statutory reporting and country-specific labour-law calculations.
* Performance review workflows more complex than the organisation's own process - the platform
  provides the mechanism, the tenant owns the policy.

## 4. Integration boundary
The platform is the **system of record for the employment relationship and its lifecycle**. For
statutory payroll, country-specific tax and social security, and payslip production, integrate
with an external HRIS/payroll provider. Bidirectional sync of employee master data, with the
platform authoritative for competitive-operations attributes (team, role, contract dates) and the
provider authoritative for statutory attributes.

## 5. Migration from the legacy system
`users` -> `Person` + `Employment` (`users.role` seeds `Employment.type` and the initial
`RoleAssignment`); `users.status` is split (requires a manual decision per row);
`rosters`/`users.team_id` -> `TeamMembership`; `user_agreements` -> `Contract` + `Acceptance`
(historic acceptances are archived as evidence, not re-proven); tryout applications ->
`Applicant`. **No HR history exists to migrate beyond the `created_at` of each user.**

## 6. Priority
High. HR is a prerequisite for contracts, payroll, compliance and sponsor due diligence. But it
can be delivered **after** the People, Organization and Role models, and **before** payroll.
