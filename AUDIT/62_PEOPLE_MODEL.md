# 62 - PEOPLE MODEL (conceptual design only - NOT implemented)
**Audit.md section:** 69 (SECTION 66 - PEOPLE MODEL)

## 1. The Audit.md question
*"Evaluate whether the future model should have a universal `Person` entity with relationships
such as employee, player, creator, coach, analyst, contractor, manager."*

**Answer: YES, unambiguously.** The legacy single-role model is the single most damaging
structural assumption in the system.

## 2. Evidence that the current model cannot work
| Evidence | Consequence |
| --- | --- |
| `users.role text CHECK(...)` - exactly ONE value (`scripts/00:43`) | a player who also streams and creates content cannot be represented |
| `users.team_id uuid` - exactly ONE team (`scripts/00:44`) | a coach of two teams, or a manager of several, cannot exist |
| `teams.coach_id` - exactly ONE coach per team (`scripts/00:33`) | assistant coaches, analysts and a head of esports cannot be attached |
| `users.status` conflates membership and availability (`scripts/00:56`) | "Benched" and "On Leave" are different concepts in one column |
| The role enum serves double duty as a **permission** and a **job description** (`08_ROLES_PERMISSIONS.md`) | granting admin rights also makes someone an administrator as a role |
| `rosters` duplicates membership with no role and no dates (`30_TEAMS.md` F-TEAM-02) | two sources of truth for the same fact |
| 726 role-string comparisons across the codebase | a permission refactor would touch essentially every file |

## 3. The conceptual model
```
Person                       (a human being; the only identity that is not org-scoped)
  id, external_ref, created_at
  |
  +-- Identity[]             (verified logins: email, OAuth subject, SSO subject, phone)
  |     method, identifier, verified_at, provider
  |
  +-- PersonProfile          (non-authoritative descriptive data: display name, pronouns,
  |     locale, timezone, avatar, bio, contact preferences)
  |     +-- PersonAddress[]  +-- EmergencyContact[]  +-- IdentityDocument[] (age verification,
  |                              minors' guardian consent - encrypted, access-logged)
  |
  +-- OrgMembership          (a person belongs to an organisation)
  |     org_id, person_id, status(pending|active|suspended|left), invited_by, joined_at, left_at
  |
  +-- Engagement[]           (a person's work for an org; the core of the People model)
  |     id, org_id, person_id, type, scope_type, scope_id, valid_from, valid_to,
  |     status, is_primary, fte, work_location, reporting_line_person_id
  |
  |     type:  employee | player | creator | coach | analyst | manager | contractor |
  |             intern | advisor | ambassador | staff
  |
  |     scope_type: organization | department | division | team | campaign | project
  |
  +-- RoleAssignment[]       (authorisation, not identity)
  |     org_id, person_id, role_id, scope_type, scope_id, valid_from, valid_to
  |
  +-- Contract[]             (one or more per Engagement; see 73_FUTURE_DOCUMENTS.md)
  |     contract_id, engagement_id, template_version_id, status, effective_from, effective_to
  |
  +-- CompensationAgreement[] (entitlement: base, retainer, prize_share_pct, revenue_share_pct,
  |     content_fee, appearance_fee, expense_policy)  -> 65_FUTURE_PAYROLL.md
  |
  +-- TeamMembership[]       (roster: person x team x role_in_team, effective-dated)
  +-- TeamStaff[]            (staffing: person x team x staff_role, effective-dated)
  +-- TrainingSessionParticipation[]
  +-- TryoutApplication[]    (a prospective person, possibly with no account)
  +-- TravelBooking[] / AssetAssignment[] / WorkItemAssignment[]
  +-- CreatorProfile[]       (only when type=creator) -> SocialAccount[], MetricSnapshot[]
  +-- AttendanceRecord[] / LeaveRequest[]
  +-- NotificationPreference[] (per channel, per event class, quiet hours, digest mode)
  +-- AuditActorSnapshot     (denormalised into audit rows so history survives deletion)
```

## 4. Design rules
1. **`Person` is a human, not a role.** Everything else is an `Engagement` or a `RoleAssignment`.
2. **Identity is many, authorisation is many, employment is many.** A person may have three
   verified identities, five roles in one org, and three engagements across two orgs.
3. **`Role` is not `Engagement`.** A Content Producer is an engagement (a job); "can approve
   sponsor deliverables" is a role. Conflating them is the legacy error.
4. **Engagements are effective-dated**, never overwritten. `TeamMembership.valid_to` is what
   makes "who was on the roster in March" answerable.
5. **A Person is never hard-deleted.** Archived, then anonymised after the retention period.
6. **Minors are a first-class case**: `IdentityDocument`, `GuardianConsent` and an
   `age_restricted` flag on the engagement, with additional restrictions on data visibility and
   payout routing (`92_COMPLIANCE.md`).
7. **`PersonProfile` is not authorisation-bearing.** Descriptive data is freely editable by the
   person; only `OrgMembership` and `RoleAssignment` grant access.
8. **No `org_id` on `Person`** - identity is global; access is always derived through a
   membership. This is what allows one human to be a customer of two organisations.

## 5. Migration mapping from the legacy model
| Legacy | Target | Notes |
| --- | --- | --- |
| `users` row | `Person` + `Identity` + `PersonProfile` | de-duplicate `users` vs `profiles`; reconcile `name` / `display_name` / `full_name` |
| `users.role` | one `Engagement.type` (primary) **plus** derived `RoleAssignment` rows | the legacy role becomes a *seed* role, not a schema constraint |
| `users.team_id` | `TeamMembership` (effective-dated from `created_at`) | may conflict with `rosters`; `rosters` wins where present, conflicts logged |
| `rosters` row | `TeamMembership` with `role_in_team = in_game_role` | de-duplicate on `(person, team)` |
| `teams.coach_id` | `TeamStaff(role=coach)` | permits multiple staff |
| `users.status` | split into `Engagement.status` (active/left) and `Availability` (available/on_leave/benched) | requires a manual decision per row |
| `tryout_applications` | `TryoutApplication` on a **provisional `Person`** (no account) | requires creating pseudonymous persons |
| `user_agreements` | `Contract` + `Acceptance` with a `document_version_id` | content hash must be recorded; historic acceptances cannot be re-proven |

## 6. Verdict / status
**DESIGN INPUT ONLY.** Not implemented. The legacy `users` table must be **ARCHIVED**, not
migrated in place, because its single-role, single-team shape is incompatible with the target.
