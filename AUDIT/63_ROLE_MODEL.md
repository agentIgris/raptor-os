# 63 - ROLE MODEL (conceptual design only - NOT implemented)
**Audit.md section:** 70 (SECTION 67 - ROLE MODEL)

## 1. The Audit.md question
*"Analyze whether V2 needs `Role + Permission + Resource + Action + Scope` rather than simple
role-based access."*

**Answer: YES.** The legacy system proves why: five disagreeing permission models
(`08_ROLES_PERMISSIONS.md` §2), a dead `module_permissions` table, and policies that widen by
accident because a nullable `team_id` doubles as a scope marker.

## 2. Why the legacy model fails
| Failure | Evidence |
| --- | --- |
| Roles are hardcoded in TypeScript **and** in a DB CHECK, and they disagree | `lib/role-system.ts:7-362` (9 roles) vs `scripts/00:43` (7 values); `pending` and `awaiting_approval` exist only in code |
| The role set is not configurable per tenant | no organisation concept at all |
| Scope is a nullable FK, so scope is set by the client | `discord_webhooks.team_id IS NULL` is the org-wide marker; `POST` lets the client choose it (`10_AUTHORIZATION.md` F-RBAC-01) |
| Permissions are 24 booleans, which is not composable | `ROLE_CONFIG` cannot express "can approve expenses up to 10,000" |
| Policy is in five places and is never reconciled | 118 policy declarations, 5 duplicate names, 6 conflicting sets |
| Navigation, API and RLS each answer independently and disagree | analyst and coach can list all users via the API but not per the model |

## 3. The conceptual model
```
Role                     (org-scoped; system roles are seeded, custom roles are creatable)
  id, org_id, key, name, description, is_system, rank
RolePermission           (many-to-many with Permission)
  role_id, permission_id
Permission               (org-scoped catalogue; seeded from a versioned registry)
  id, org_id (nullable = system), key, resource, action, description, risk_level
RoleScopeRule            (what scope a role may be granted at)
  role_id, scope_type (organization | department | division | team | campaign | self), max_scope_rank
MemberRole               (a grant, effective-dated, scope-bound)
  org_id, person_id, role_id, scope_type, scope_id, valid_from, valid_to, granted_by, granted_at

PolicyRule               (ABAC overlay for conditions the RBAC layer cannot express)
  org_id, subject_role_id, resource, action, condition (JSONLogic), effect(allow|deny), priority

AttributeGrant           (per-record grants, e.g. a scout may read one candidate)
  org_id, person_id, resource_type, resource_id, permissions[], valid_from, valid_to
```

**Definitions**
* **Resource** - the noun: `person`, `team`, `contract`, `invoice`, `deliverable`, `travel_plan`.
* **Action** - the verb: `read`, `create`, `update`, `delete`, `approve`, `export`, `send`,
  `manage`.
* **Scope** - the boundary an action applies within: the whole org, a department, a division, a
  team, a campaign, a campaign they created, or only themselves.
* **Role** - a named, reusable bundle of (permission, allowed scopes).
* **PolicyRule** - the escape hatch for conditions: "approve only if `amount <= role.limit` and
  `requestor != approver`".

## 4. Why this is better than the legacy model
| Property | Legacy | Target |
| --- | --- | --- |
| Configurable per tenant | no (hardcoded) | yes |
| Composable | no (24 booleans) | yes (permission + scope + condition) |
| Scope is server-determined | no (client sets `team_id`) | yes (`MemberRole.scope_id` chosen from `RoleScopeRule`) |
| Auditable | no | yes (`granted_by`, `granted_at`, effective dates) |
| Testable | no (5 places, unreconciled) | one dataset, compiled into navigation + API + RLS + tests |
| Least privilege expressible | no | yes (`scope`, `condition`, `risk_level`) |
| Separation of duties | no | yes (policy conditions can require `requestor != approver`) |

## 5. Enforcement: one dataset, four consumers
This is the mechanism that prevents a recurrence of the legacy failure. The same policy dataset
must generate:
1. **Navigation and UI affordances** - hide what the user cannot do (convenience only, never
   security).
2. **API guards** - a single `authorize(ctx, 'invoice', 'approve', { scope })` call in a service
   layer, not per-handler string comparisons.
3. **RLS policies** - generated or hand-written to mirror the same matrix, with a **conformance
   test** asserting that for every (role, resource, action) triple the API result and the SQL
   result agree (`53_TESTING.md` §3 items 4-7).
4. **Audit records** - the decision and its basis are recorded.

## 6. System roles to seed per tenant (a starting set, not a limit)
`Owner` (billing + full access) · `Admin` · `HeadOfEsports` · `TeamManager` · `Coach` ·
`Analyst` · `Player` · `Creator` · `ContentManager` · `Editor` · `PartnershipsManager` ·
`FinanceManager` · `Accountant` · `HRManager` · `LegalCounsel` · `TravelCoordinator` ·
`AssetManager` · `Scout` (attribute-granted) · `Viewer` (read-only, scoped).
Each is a **starting point**; every tenant can create its own.

## 7. Explicit non-goals
No field-level column security inside a record (use separate projections or attribute grants);
no ABAC engine that reimutes a policy language; no cross-tenant role sharing (roles are
org-scoped by design).

## 8. Verdict / status
**DESIGN INPUT ONLY.** The five legacy models must be **ARCHIVED**, not merged. `module_permissions`
is deleted; its intent is realised once, properly.
