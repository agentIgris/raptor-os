# 08 — ROLES AND PERMISSIONS

**Audit.md section:** 13 (SECTION 10 — USER ROLE AUDIT)

---

## 1. Every role found in the system

| Role | Where defined | DB CHECK allows it? | Level | Reachable in practice |
| --- | --- | --- | --- | --- |
| `admin` | `lib/role-system.ts:8`, `lib/dashboard-permissions.ts:6`, `lib/profile-utils.ts:42`, `API_DOCUMENTATION.md`, RLS policies | ✅ | 100 | yes |
| `manager` | `lib/role-system.ts:51` | ✅ | 80 | yes |
| `coach` | `lib/role-system.ts:94` | ✅ | 70 | yes |
| `analyst` | `lib/role-system.ts:137` | ✅ | 60 | yes |
| `player` | `lib/role-system.ts:180` | ✅ | 50 | yes |
| `pending_player` | `lib/role-system.ts:266`; DB default `scripts/00:43`; `SecureProfileCreation` default | ✅ | 10 | yes — assigned on sign-up |
| `pending` | `lib/role-system.ts:223` | ❌ **not in the DB CHECK constraint** | 10 | **no — dead** |
| `awaiting_approval` | `lib/role-system.ts:298`; `lib/dashboard-permissions.ts:6,287` | ❌ **not in the DB CHECK constraint** | 10 | **no — dead** |
| `tryout` | `lib/role-system.ts:330` | ✅ (`scripts/00:43`) | 8 | never assigned by any code path |

**Finding — three role identifiers exist only in TypeScript.**
*Evidence:* `scripts/00-complete-schema-setup.sql:43`
`role text DEFAULT 'pending_player' CHECK (role = ANY (ARRAY['admin','manager','coach','analyst','player','pending_player','tryout']))`.
`ROLE_CONFIG` additionally defines `pending` (`lib/role-system.ts:223`) and `awaiting_approval`
(`:298`); `lib/dashboard-permissions.ts:6` and `:287` also reference `awaiting_approval`.
*Impact:* (a) `RoleAccess.getAllRoles()` (`lib/role-system.ts:474-476`) returns
`ROLE_CONFIG` keys, so **any role-picker built on it will offer `pending` and
`awaiting_approval`**, and selecting one produces a `23514` check-constraint violation;
(b) `app/api/users/route.ts:129` uses a *different* 6-value allowlist
(`['admin','manager','coach','analyst','player','pending_player']`) that omits `tryout`;
(c) the role dropdown and the API can disagree.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommendation:* one canonical role enum generated from the database, imported everywhere.

---

## 2. FIVE competing permission models

This is the most important structural finding of the audit. The same question — "may this
user do X?" — is answered by five independent mechanisms that do not agree.

| # | Model | Location | Roles | Granularity | Enforced where |
| --- | --- | --- | --- | --- | --- |
| **1** | `ROLE_CONFIG` | `lib/role-system.ts:7-362` | 9 | 24 boolean flags (`viewAllUsers`, `deleteFinances`, `systemConfiguration`, …) | `RoleAccess.hasPermission`, `routeAccess` — used by `app/api/rosters`, and partially elsewhere |
| **2** | `DASHBOARD_MODULES` + `DashboardPermissions` | `lib/dashboard-permissions.ts:28-291` | 7 | per-module `allowedRoles` + a 5-flag `Permission{canView,canCreate,canEdit,canDelete,canExport}` per data type | **UI only** — navigation and `getDataPermissions` |
| **3** | `PROFILE_PERMISSIONS` | `lib/profile-utils.ts:41-98` | 7 | `{canViewAll,canEditAll,canViewTeam,canEditTeam,canViewOwn,canEditOwn}` | `app/api/profile/route.ts` via `canViewProfile`/`canEditProfile` |
| **4** | `module_permissions` **table** | `scripts/00-complete-schema-setup.sql:19-25, 520-541` | seeded for 5 roles × 8 modules | `(role, module) → can_access` | **NOWHERE** — `rg "module_permissions"` matches only the `Database` type at `lib/supabase.ts:499` |
| **5** | RLS policies | 43 SQL files, ~60 policies | via `users.role` | per-table, per-operation row predicates | Postgres, if RLS is enabled |
| (6) | `checkRoleAccess(role, allowedRoles)` inline arrays | ~20 API routes | ad hoc | ad hoc role allowlists | API handlers |

### 2.1 Where they contradict each other
| Question | Model 1 (`role-system`) | Model 2 (`dashboard-permissions`) | Model 3 (`profile-utils`) | Model 6 (inline route) | DB / RLS |
| --- | --- | --- | --- | --- | --- |
| Can a **manager** see all users? | `viewAllUsers: false` (`:55`) | `users.canView: true` for manager (`:221`) | `canViewAll: true` (`:53`) | `GET /api/users` allows manager and **returns all** (`:32,47`) | `users` has no SELECT policy for manager ⇒ RLS denies (if enabled) |
| Can an **analyst** list users? | `viewAllUsers: false` (`:145`) | `users.canView: false` (`:221`) | `canViewAll: false` (`:68`) | `GET /api/users` **allows analyst and returns all** (`:32,47`) | denied by RLS |
| Can a **coach** list users? | `viewAllUsers: false` (`:104`) | `users.canView: false` | `canViewAll: false` | **allowed**, team-scoped (`:50-52`) | only own row |
| Can a **player** list users? | `viewAllUsers: false`; `getAvailableModules` excludes `user-management` (`:404-406`) | `users.canView: false` | `canViewAll: false` | **allowed**, team-scoped, `select('*')` (`:53-62`) | only own row |
| Can a **player** read team finances? | `viewAllFinances: false` (`:208`) | `finance` module not in `allowedRoles` for player (`:75`) | n/a | `GET /api/expenses` — see `app/api/expenses/route.ts` role list | **YES** — `scripts/04:202-210, 242-250, 281-288` and `scripts/13:223-250` grant players/team-members read on `slot_expenses`, `winnings`, `prize_pools` |
| Can a **player** create a performance? | `createPerformance: true` (`:200`) | `performance.canCreate: true` for player (`:240`) | n/a | allowed, self-only (`:164, 241-256`) | `scripts/15:21-23` allows own only |
| Can an **analyst** create a performance? | `createPerformance: false` (`:155`) | `performance.canCreate: false` (`:240`) | n/a | `POST /api/performances:164` **excludes analyst** ✅ | `scripts/15:13-18` staff-only INSERT excludes analyst ✅ |
| Can a **manager** delete a team? | `deleteTeams: false` (`:66`) | `teams.canDelete: true` for manager (`:233`) | n/a | `POST/PUT/DELETE /api/teams/manage` — role list must be checked per verb | `scripts/04:75-88` `"Admins and Managers can manage teams"` ✅ grants DELETE to manager |

**Concrete contradictions (evidence-backed):**
1. **Analyst and coach can list all users via the API** (`app/api/users/route.ts:32,47`)
   while the permission model and the navigation both say they cannot
   (`lib/role-system.ts:104,145`; `lib/dashboard-permissions.ts:221`).
2. **A player can list their whole team's user records including PII** via
   `GET /api/users` (`app/api/users/route.ts:53-62`, `select('*')`), contradicting
   `README.md:196-200` and every permission model.
3. **A manager can delete a team** per `lib/dashboard-permissions.ts:233` and
   `scripts/04:75-88`, but `lib/role-system.ts:66` says `deleteTeams: false`.
4. **Players can read team financial data** at the database layer
   (`scripts/04:202-210` etc.) while every application model says they cannot.
5. **The `module_permissions` table is dead** — the only module-permission data structure in
   the database is never read, so any configuration an administrator performs there has no
   effect.

### 2.2 The two "hidden" permission models inside the database
* **`can_view_profile(viewer_user_id, target_user_id)` and `can_edit_profile(editor_user_id, target_user_id)`**
  (`automation-scripts/04:60-140`) are `SECURITY DEFINER` and take **the viewer's identity as a
  parameter** instead of using `auth.uid()`. They are therefore (a) an authorization *oracle*
  callable with any claimed identity, and (b) unusable as a real guard unless every caller is
  trusted. The TypeScript mirror `lib/profile-utils.ts` does the opposite — it receives the
  authenticated user's role and id from the route and checks in application code. The two
  implementations of the same rule will diverge.
* **A `tryout_stats` VIEW created without `security_invoker`**
  (`database/SUPABASE_TRYOUTS_SETUP_FIXED.sql:561-579`). In PostgreSQL/Supabase, a view without
  `security_invoker = true` executes with the **view owner's** privileges and therefore
  **bypasses RLS on the underlying tables**. Anyone who can `SELECT` the view sees aggregate
  application, invitation, evaluation and selection counts for **every tryout, including
  non-public and draft ones.**

---

## 3. Per-role capability matrix (as actually enforced by the API layer)

Legend: ✅ allowed · ⚠ allowed but over-broad · ❌ denied · ❓ unclear/depends on RLS state

| Capability | admin | manager | coach | analyst | player | pending_player | tryout | Enforcement site |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sign in / sign up | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Supabase Auth |
| Complete onboarding | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `app/api/profile` (no role gate) |
| Read own profile | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | RLS `auth.uid()=id` |
| Edit own profile (allowlisted fields) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `app/api/profile:172-187` |
| Edit **another** profile | ✅ | ✅ | ⚠ team | ❌ | ❌ | ❌ | ❌ | `canEditProfile` |
| List users | ✅ | ⚠ all, `select('*')` | ⚠ own team, `select('*')` | ⚠ **all**, `select('*')` | ⚠ own team, `select('*')` | ❌ | ❌ | `app/api/users:32-62` |
| Search profiles | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | `app/api/profile/search:15` |
| Change a user's role/team | ⚠ **broken** (undefined RPC) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | `app/api/users:110,140` |
| Create/update/delete team | ✅ | ✅ create/update; ⚠ delete | ❌ | ❌ | ❌ | ❌ | ❌ | `app/api/teams/manage`; `scripts/04:75-88` |
| Manage roster | ✅ | ✅ | ⚠ own team | ❌ | ❌ | ❌ | ❌ | `app/api/rosters`; `scripts/04:108-136` |
| Book/manage slots | ✅ | ✅ | ⚠ own team | ❌ | ❌ | ❌ | ❌ | `app/api/slots`; `scripts/16:107-152` |
| Create a performance | ✅ | ✅ | ⚠ own team | ❌ | ✅ own only | ❌ | ❌ | `app/api/performances:164,240-265` |
| Read performances | ✅ | ✅ | ⚠ own team | ⚠ own team | ⚠ **whole team** | ❌ | ❌ | `app/api/performances:100-111` |
| Delete a performance | ✅ | ⚠ | ❌ | ❌ | ❌ (API) / ✅ (RLS `scripts/15:48-60`) | ❌ | ❌ | **API and RLS disagree** |
| Read attendance | ✅ | ✅ | ⚠ own team | ⚠ own team | ✅ own only | ❌ | ❌ | `app/api/attendances:56-71` |
| Mark attendance | ✅ | ✅ | ⚠ own team | ❌ | ✅ own only | ❌ | ❌ | `app/api/attendances:143-166` |
| **Delete attendance** | ❌ 500 | ❌ 500 | ❌ 500 | ❌ 500 | ❌ 500 | ❌ | ❌ | **broken — `ReferenceError`** |
| Create/manage sessions | ✅ | ✅ | ⚠ own team | ❌ | ❌ | ❌ | ❌ | `app/api/sessions:127-134, 246-253` |
| Read finance (expenses/winnings) | ✅ | ✅ | ❌ | ❌ | ⚠ **readable at DB level** | ❌ | ❌ | UI hides page; RLS allows read |
| Manage tier rates | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | `app/api/tier-defaults` |
| Manage tryouts | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | `app/api/tryouts`; `SUPABASE_TRYOUTS_SETUP_FIXED:217-224` |
| Evaluate tryout candidates | ✅ | ✅ | ✅ | ⚠ RLS allows (`:245`) | ❌ | ❌ | ❌ | API excludes analyst; **RLS allows analyst** ⚠ |
| Discord portal (view) | ✅ | ✅ | ⚠ nav says ✅ | ⚠ nav says ✅ | ❌ | ❌ | ❌ | `getPermissions` allows coach+analyst; `DASHBOARD_MODULES:115` allows only admin/manager ⚠ |
| Discord portal (manage) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | `lib/dashboard-permissions:206` |
| Manage Discord webhooks | ✅ | ⚠ own team | ❌ (route) / ✅ (RLS insert, incl. `team_id IS NULL`) ⚠ | ❌ | ❌ | ❌ | ❌ | `app/api/discord-portal/webhooks:161-187`; `complete-discord-portal-setup.sql:112-123` |
| Send Discord messages | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | `app/api/discord-portal/send` |
| Read Discord delivery logs | ✅ | ✅ | ⚠ | ⚠ | ❌ | ❌ | ❌ | `complete-discord-portal-setup.sql:127-144` allows team members |
| Admin settings / config | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | `app/api/admin/settings:33,92` |
| **Purge all non-admin data** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | `app/api/admin/settings:103` ⚠ CRITICAL |
| Edit legal agreements | ❌ 403 always | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | `app/api/admin/agreements` broken |
| Accept an agreement | ✅ self | ✅ self | ✅ self | ✅ self | ✅ self | ❌ (not required) | ❌ | `app/api/agreements:72-130` |
| Upload avatar | ✅ any user | ✅ any user | ✅ self | ✅ self | ✅ self | ✅ self | ✅ self | `app/api/profile/avatar:87` |
| **Upload arbitrary file (media)** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **no auth at all** ⚠ |
| **Delete arbitrary file (media)** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **no auth at all** ⚠ |
| Submit public application | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | public |
| Use Discord bot endpoints | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | static shared secret |

---

## 4. Structural security findings in the permission model

### F-RBAC-01 — A coach can create a **global** Discord webhook (vertical privilege escalation)
*Finding:* the RLS policy `"Coaches can manage team webhooks"` on `public.discord_webhooks`
is `FOR INSERT WITH CHECK ( … OR discord_webhooks.team_id IS NULL )`.
*Evidence:* `database/complete-discord-portal-setup.sql:112-123`.
*Impact:* a coach — whose intended scope is one team — can insert a webhook row with
`team_id = NULL`, which is precisely the shape of an org-wide (`type:'global'`) webhook. Every
subsequent automated notification for any team will be delivered to a channel the coach chose.
This is a genuine vertical escalation from team-scoped to organisation-wide communication
control.
*Severity:* **HIGH** · *Confidence:* **HIGH**
*Recommendation:* never permit a team-scoped role to create rows whose scope is broader than
its own; scope must be assigned by the server, not by the client.

### F-RBAC-02 — `discord_webhooks` global rows are readable without any role check
*Finding:* `"Team members can view team webhooks"` is
`FOR SELECT USING ( team_id IS NULL OR EXISTS (…role IN ('admin','manager') OR team_id = …) )`.
*Evidence:* `database/complete-discord-portal-setup.sql:92-100`.
*Impact:* the `team_id IS NULL` branch is true for every caller, and the policy has **no
`TO authenticated` restriction**, so it applies to `public`. With the public anon key, an
**unauthenticated** caller can read `hook_url` for every admin/global webhook — a Discord
webhook URL is a **write credential** for that channel.
*Severity:* **CRITICAL** · *Confidence:* **HIGH** for the policy; **MEDIUM** for exploitability pending deployed-grant verification
*Recommendation:* webhook URLs are secrets — store them encrypted, never return them to
clients, scope every read to an authenticated admin/manager, and `REVOKE` appropriately.

### F-RBAC-03 — Anyone can forge Discord delivery logs
*Finding:* `"System can insert logs"` is `FOR INSERT WITH CHECK (true)` on
`public.communication_logs`, with no `TO` role restriction.
*Evidence:* `database/complete-discord-portal-setup.sql:146-148`.
*Impact:* the only record of outbound organisational communications is publicly forgeable —
an unauthenticated caller can insert rows with arbitrary `payload`, `status` and
`triggered_by`. This destroys the evidentiary value of the log and permits log-flooding.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommendation:* logging must happen only from a `SECURITY DEFINER` function owned by the
service role; revoke `INSERT` from `anon`/`authenticated`.

### F-RBAC-04 — API and RLS disagree on who may delete a performance
*Finding:* `POST /api/performances` does not expose DELETE at all, and `DELETE` is absent from
the route. But `scripts/15-fix-rls-policies.sql:48-60` grants
`"Users can delete performances"` to **players for their own rows** and to staff for their
team.
*Evidence:* `app/api/performances/route.ts` exports only GET and POST; `scripts/15:48-60`.
*Impact:* the two layers encode different policies. Today the API is the stricter one, so the
looser RLS grant is latent — but it is exactly the kind of latent grant that becomes live the
moment someone adds a DELETE handler.
*Severity:* **MEDIUM** · *Confidence:* **HIGH*
*Recommendation:* define the policy once; generate both the API guard and the RLS policy from
it, and test them against the same matrix.

### F-RBAC-05 — Role assignment has no audit trail and no notification
*Finding:* the only role-change path is `PUT /api/users` → `bulletproof_user_update` (undefined).
No audit record, no notification to the affected user, no re-authentication, no session
invalidation.
*Evidence:* `app/api/users/route.ts:88-168`.
*Impact:* privilege changes are invisible and unauditable; a demoted user keeps their existing
session and cached profile until the 12-hour token expiry (`lib/session-config.ts:4`).
*Severity:* **HIGH** · *Confidence:* **HIGH*
*Recommendation:* audit every permission change; invalidate the target's sessions; notify them.

---

## 5. Verdict for V2

**ARCHIVE** the entire role/permission implementation (5 models, 43 SQL files, ~60 policies).
It cannot be repaired incrementally because the models are mutually contradictory and the
enforcement points are scattered.

**REBUILD** as data, not code — see `63_ROLE_MODEL.md` for the target
`Role + Permission + Resource + Action + Scope` design and `63_ROLE_MODEL.md` for the
migration path. Immediate requirements:

1. One canonical role list generated from the database, imported by UI and API.
2. `module_permissions` either wired in or deleted — today it is a silent no-op.
3. Every policy expressed once and compiled into (a) navigation, (b) API guards, (c) RLS, and
   (d) an automated test that asserts the three agree.
4. Team-scoped and org-scoped authority must be structurally distinct, not distinguished by a
   nullable `team_id` that the client can set.
5. Financial data must be invisible to players at the database layer, not merely hidden in
   navigation.
