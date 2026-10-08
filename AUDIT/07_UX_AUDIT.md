# 07 — UX AUDIT

**Audit.md section:** 12 (SECTION 09 — UX AUDIT)
Method: every major workflow was traced end to end (page → component → API route → database
function), per Audit.md Rule 4. Where a workflow is claimed to work but a step is provably
broken, that is stated.

---

## 1. Sign in — `/auth/login`

| Aspect | Finding | Evidence |
| --- | --- | --- |
| User goal | Authenticate and land on the right page | — |
| Steps | Email → password → `authFlowV2.signIn()` → `handleSupabaseSession()` → `loadUserProfileFast()` → `checkAgreementStatus()` → redirect decision | `lib/auth-flow-v2.ts:571-633` |
| Redirect priority | 1) `/agreement-review` if an agreement is required; 2) `/onboarding` if `pending_player && !onboarding_completed`; 3) intended route from `localStorage['raptor-intended-route']`; 4) `/dashboard` | `lib/auth-flow-v2.ts:365-401` |
| Friction | 50 ms debounce on every state change (`setState`, line 80-83) makes the UI feel laggy and can reorder redirects. Two retry layers: `performInitializeWithRetry` (2 retries) *and* `useSafeRedirect`. | `lib/auth-flow-v2.ts:73-84, 140-168` |
| Friction | Session restore path has a **2-second timeout** on `supabase.auth.getUser` and a **2-second timeout** on profile load; on timeout the cached session is **destroyed** (`SessionStorage.clearSession()`), logging the user out on a slow network. | `lib/auth-flow-v2.ts:200-245` |
| Missing feedback | A session-restore timeout and a `getUser` timeout produce the same outcome (signed out) with no user-facing explanation. | `lib/auth-flow-v2.ts:235-245` |
| Error conditions | Supabase error messages are surfaced verbatim (`error.message`) — acceptable, but inconsistent with the root error boundary which shows raw internal messages elsewhere. | `lib/auth-flow-v2.ts:592-598` |
| Dangerous actions | None. | — |
| Security note | `raptor-intended-route` is read from `localStorage` and used as a redirect target. `useSafeRedirect` (`lib/client-utils.ts`) is the open-redirect guard — this is a **good** pattern, and it is the only place in the app where redirect safety is implemented. | `lib/auth-flow-v2.ts:388-391`; `lib/client-utils.ts` |
| Verdict | **Partially implemented.** Works, but the timeout behaviour logs users out on slow connections and the redirect logic is duplicated across three layers. |

---

## 2. Sign up — `/auth/signup`

| Aspect | Finding | Evidence |
| --- | --- | --- |
| Steps | Supabase sign-up → `SIGNED_UP` event → profile auto-creation with role `pending_player` | `lib/secure-profile-creation.ts:45` |
| **Critical fragility** | Profile creation inserts into `public.users` using the **anon/authenticated browser client**. The base schema (`scripts/00-complete-schema-setup.sql:488-497`) defines only **two SELECT policies** on `users` — there is **no INSERT policy**. If that is the deployed state, **every new sign-up fails to create a profile**, and the user lands authenticated but profileless, which `loadUserProfileFast` will retry on every page load. | `lib/secure-profile-creation.ts:65-69`; `scripts/00:488-497` |
| Mitigation present? | `scripts/01-create-tables.sql:62` defines `"Admins can insert users"` — **but that policy grants INSERT only to admins**, so a self-service sign-up still cannot insert. There is **no policy anywhere that allows a user to insert their own `users` row.** | `scripts/01:62-69` |
| **Privilege-escalation-shaped code** | `SecureProfileCreation.createAdminProfile(userId, email, name)` inserts a row with `role: 'admin'`, `role_level: 100` using `upsert`, with the comment *"Skip authentication check … caller is responsible for verification"*. `createBatchProfiles` likewise does not verify that the supplied users are authenticated. | `lib/secure-profile-creation.ts:222-275, 281-334` |
| Impact if reachable | Any code path that can call `createAdminProfile` with an arbitrary `userId` can mint an admin. It is currently not called from any API route (grep-verified), so it is **latent**, not live. | `rg "createAdminProfile"` → definition only |
| Dangerous actions | Public sign-up is open (no invite gate, no email-domain restriction, no CAPTCHA). Combined with the unauthenticated `/api/public/*` endpoints, this is an abuse surface. | `app/auth/signup/page.tsx` |
| Verdict | **Broken or fragile depending on deployed RLS state.** Also carries a latent admin-minting function that must not survive into V2 in any form. |

---

## 3. Onboarding — `/onboarding`

| Aspect | Finding | Evidence |
| --- | --- | --- |
| Goal | New `pending_player` supplies gaming identity, device specs, sensitivity settings, social handles, emergency contact, DOB, address | `app/onboarding/page.tsx` (15,613 B); `components/profile/profile-sections.tsx` (32,502 B) |
| Steps | Multi-section form → `PUT /api/profile` with a **field allowlist** | `app/api/profile/route.ts:172-187` |
| Good practice | The allowlist correctly blocks privilege fields (`role`, `role_level`, `team_id`, `status`, `email`, `id`). `canEditProfile` is checked first. | `app/api/profile/route.ts:146-160, 172-187` |
| **Field-allowlist inconsistency** | The API allowlist (27 fields) and `lib/profile-utils.ts:180-184` `getEditableFields()` (5 categories, ~40 fields) **do not match**. Fields the UI offers as self-editable (e.g. `emergency_contact_name`, `emergency_contact_number`, `address`, `date_of_birth`, `social_links`, `preferred_language`, `timezone`, `profile_visibility`) are **rejected by the API** with `NO_VALID_UPDATES`. Users will fill in fields that silently do not save. | `app/api/profile/route.ts:172-187` vs `lib/profile-utils.ts:180-215` |
| Friction | `getEditableFields()` is exported but **never called** — the UI does not use the permission model to decide which fields to show, so it shows the wrong set. | `rg "getEditableFields"` → definition only |
| Missing feedback | Rejected fields produce a 400 with `No valid fields to update`; the UI does not surface which field was rejected. | `app/api/profile/route.ts:189-195` |
| Data minimisation | Onboarding collects **date of birth, home address, emergency contact name and number, and precise device telemetry** (`ram`, `fps`, `storage`, `device_model`, `hud_layout_code`, `sensitivity_settings`) for a 16-year-old-skewed audience. There is no consent step, no purpose statement, and no retention policy. | `scripts/00:80-85`; `lib/profile-utils.ts:180-184` |
| Verdict | **Partially implemented; UX and API contract are out of sync.** This is a GDPR/child-safety-relevant design flaw — see `92_COMPLIANCE.md`. |

---

## 4. Dashboard — `/dashboard` (60.6 KB single file)

| Aspect | Finding | Evidence |
| --- | --- | --- |
| Goal | Role-specific overview of teams, players, matches, spend | `app/dashboard/page.tsx` |
| Data sources | `/api/dashboard/overview`, `/api/performances`, `/api/slots`, `/api/teams`, `/api/sessions` — **5+ separate client fetches**, each independently authorised and RLS-filtered | `app/api/dashboard/overview/route.ts` + 4 more |
| **Trust problem** | The five endpoints can disagree. `app/api/dashboard/overview/route.ts` computes org-wide aggregates for admin/manager and team-scoped for others, while `app/api/performances` applies a *different* role filter. A coach can see a dashboard total that does not match the drill-down list. | `app/api/dashboard/overview/route.ts`; `app/api/performances/route.ts:100-111` |
| Player visibility | For a `player`, `/api/performances` uses `.or('player_id.eq.<me>,team_id.eq.<myTeam>')` — so a player sees **every teammate's** performance, contradicting `README.md:196-200` ("Player — Personal performance tracking, view only their own data"). With RLS off (per `database/README.md`) nothing filters this back. | `app/api/performances/route.ts:101-106` vs `README.md:196-200` |
| Empty state | No empty state on the overview; zero-value metric cards render as `0` with no explanation, so a broken RLS policy is **indistinguishable from an empty organisation**. | `app/dashboard/page.tsx` |
| Dangerous actions | None directly. | — |
| Maintainability | 60,575 bytes in one file, mixing overview metrics, team lists, match lists and quick actions. | file size |
| Verdict | **Implemented but untrustworthy.** The indistinguishable-zero problem is the most serious UX defect: it hides backend failures. |

---

## 5. Team management — `/dashboard/team-management/*`

| Aspect | Finding | Evidence |
| --- | --- | --- |
| Teams | CRUD via `/api/teams/manage`; coach assignment via `teams.coach_id` with a DB trigger `validate_coach_assignment()` that raises *"Assigned coach must have coach role"* | `app/api/teams/manage/route.ts`; `automation-scripts/01:57-73` |
| Roster | `/api/rosters` + `/api/teams/[id]/players`; `rosters` duplicates `users.team_id` and adds `in_game_role`, `contact_number`, `device_info` | `scripts/00:347-358` |
| **Data-model smell** | A person's team membership is stored **twice** (`users.team_id` and `rosters.team_id`) with no constraint keeping them consistent, and no unique constraint on `(team_id, user_id)` in `rosters`. | `scripts/00:44, 347-358` |
| Slots | Slot booking with `organizer`, `time_range`, `number_of_slots`, `slot_rate`, `match_count`, `date`. Auto-creates a `slot_expenses` row via trigger. | `app/api/slots/route.ts`; `automation-scripts/04:12-32` |
| Tiers | `tier_defaults` (God, T1–T4 seeded with 1000/800/600/400/200) drives default slot rates. | `scripts/00:544-550`; `app/api/tier-defaults/route.ts` |
| **Hardcoded game assumption** | The tier ladder and the ₹-denominated rates are PUBG-Mobile/BGMI-specific. `teams.tier` is free `text` with **no CHECK constraint**, so arbitrary tiers can be created while `tier_defaults.tier` is the only validated set. | `scripts/00:32, 209-216` |
| Friction | Tier rates are global, not per-organisation and not per-game. | `scripts/00:209-216` |
| Verdict | **Implemented.** This is one of the more coherent areas, but it is a slot-purchase ledger for a battle-royale, not a team-management system. |

---

## 6. Player management — `/dashboard/user-management`

| Aspect | Finding | Evidence |
| --- | --- | --- |
| Goal | List users, change role/team | `app/dashboard/user-management/page.tsx` (22,949 B) |
| **BROKEN** | Listing calls `supabase.rpc('get_all_users_admin')`; role/team changes call `POST/PUT /api/users` → `supabase.rpc('bulletproof_user_update', …)`. **Neither function is defined in any of the 43 SQL files.** | `app/dashboard/user-management/page.tsx:131`; `app/api/users/route.ts:140`; `rg "bulletproof_user_update"` → only the call site and a README mention |
| Over-exposure | `GET /api/users` uses `.select('*')`, so a `player` sees every teammate's `emergency_contact_number`, `date_of_birth`, `address`, `device_info`, `discord_id`, `instagram_handle`, `sensitivity_settings`, `game_stats`, `achievements`. | `app/api/users/route.ts:41-44, 53-62` |
| Doc conflict | `API_DOCUMENTATION.md:384` says `GET /api/users` → Coach ❌, Analyst ❌, Player ❌. The code allows **all three** (line 32 `allowedRoles`). | `API_DOCUMENTATION.md:382-389` vs `app/api/users/route.ts:32` |
| Dangerous actions | Role changes have no confirmation, no audit trail, and no notification to the affected user. | `app/api/users/route.ts:142-165` |
| Verdict | **Broken.** The single most important administrative workflow in the product does not function. |

---

## 7. Performance — `/dashboard/performance`

| Aspect | Finding | Evidence |
| --- | --- | --- |
| Goal | Submit a player's match result | `app/dashboard/performance/page.tsx` |
| **Fragmented entry** | Five submit components coexist: `add-performance`, `player-performance-submit`, `streamlined-performance-submit`, `enhanced-player-performance-submit`, plus `smart-slot-selector`. | `components/performance/` |
| Contract churn | `POST /api/performances` explicitly supports "both legacy and new format" (`match_type` vs `match_number`; `slot_id` vs `slot`) — a direct symptom of the duplication. | `app/api/performances/route.ts:175-206` |
| **Player cannot see own data reliably** | A `player` submits with `team_id` defaulting to `user.team_id`; the API blocks a different team and a different `player_id` — correct. But the GET path lets the same player read the whole team. Asymmetric. | `app/api/performances/route.ts:101-106` vs `240-256` |
| Validation | Numeric fields validated as "non-negative number"; `placement` has no upper bound; `map` is free text; `match_number` is derived with a tournament/practice heuristic. | `app/api/performances/route.ts:206-238` |
| OCR path | `components/performance/ocr-extract.tsx` (19,547 B) + `lib/ocr-service.ts`. Parsed values are shown in an editable form before submit — correct human-in-the-loop design. But the parser can fabricate rows. | `lib/ocr-service.ts:115-146` |
| Empty state | Present. | — |
| Verdict | **Partially implemented; the write path is defensible, the read path over-shares, and the entry surface is fragmented five ways.** |

---

## 8. Attendance — `/dashboard/attendance`

| Aspect | Finding | Evidence |
| --- | --- | --- |
| Goal | Schedule sessions, mark attendance, verify, analyse, auto-mark absences | `app/dashboard/attendance/page.tsx`; 12 components |
| Session model | `sessions` (type, subtype, date, start/end/cutoff time, mandatory, created_by) + `practice_session_config` (recurring Morning/Evening/Night windows) + `holidays` | `scripts/00:222-290` |
| Automation | `generate_daily_practice_sessions(date)`, `auto_mark_absent_after_cutoff()`, `create_auto_attendance_fixed()`, `is_holiday(date, team)`, `create_match_attendance_from_performance()` | `automation-scripts/02` |
| **Defect density** | Four competing definitions of the auto-attendance trigger (`create_auto_attendance`, `_v2`, `_fixed` ×3) across 6 files; `slot` vs `slot_id` resolved 5 different ways; a null-date bug fix; a team-id constraint fix; a session-time constraint fix. Repository-root debug SQL and 3 markdown bug reports. | `scripts/11,14,15,16,17,18,20,21`; `comprehensive_attendance_debug.sql`; `DEBUG_ATTENDANCE_ISSUE.md`; `APPLY_ATTENDANCE_FIX.md` |
| **DELETE is broken** | `DELETE /api/attendances` calls `getUserFromRequest(request)` at `app/api/attendances/route.ts:310`, which is **not defined or imported in that file**. Every call throws a `ReferenceError`, is swallowed by the `try/catch`, and returns `500 Internal server error`. | `app/api/attendances/route.ts:308-338` |
| `notes` column | `PUT /api/attendances` writes `notes`; **no SQL file adds a `notes` column to `attendances`** (only `manager_notes` in `database-schema-updates.sql:46`). | `app/api/attendances/route.ts:284`; `database-schema-updates.sql:45-46` |
| Friction | Six overlapping attendance UIs for players/coaches/managers with different field sets and different notions of "session". | `components/attendance/` |
| Dangerous actions | Attendance deletion is effectively unavailable (good, accidentally). Bulk correction paths are not defined. | — |
| Verdict | **The most defect-dense domain in the repository.** Business rules are valuable; implementation is not salvageable as-is. |

---

## 9. Tryouts — `/dashboard/tryouts`, `/apply/[tryoutId]`

| Aspect | Finding | Evidence |
| --- | --- | --- |
| Goal | End-to-end recruitment: application → screening → invitation → evaluation session → evaluation → selection → team creation | `database/SUPABASE_TRYOUTS_SETUP_FIXED.sql` |
| **Best-modelled domain in the repository** | Six well-designed tables with correct FKs, `ON DELETE CASCADE`, enums, and a `tryout_stats` view. Two independent intake channels: public web (`/apply/[tryoutId]`) and Discord bot (`/api/discord/tryout/apply`). | `database/SUPABASE_TRYOUTS_SETUP_FIXED.sql:11-185` |
| Broken transition | The **Discord** announce → invite → evaluate chain is non-functional: those three routes use the session-less anon client while the policies require `auth.uid()` to be a staff member. | `app/api/discord/tryout/announce|invite|evaluate/route.ts` vs `database/SUPABASE_TRYOUTS_SETUP_FIXED.sql:217-224, 250-257, 270-278` |
| Broken link | `announce` builds `…/tryout/{id}/apply`; the real route is `/apply/[tryoutId]`. | `app/api/discord/tryout/announce/route.ts:98` |
| Broken trigger | `sync_tryout_to_profile()` does `UPDATE public.users … WHERE id = NEW.id` where `NEW.id` is the **application** id, not a user id — the trigger always matches zero rows, so `users.auto_sync_tryout_data` does nothing. | `automation-scripts/04:39-53` |
| Public status | `GET /api/discord/tryout/status` reads `tryout_applications` with the anon client; there is **no SELECT policy for `anon`** on that table, so an applicant's status always comes back empty. | `app/api/discord/tryout/status/route.ts:34-45`; policies at `SUPABASE_TRYOUTS_SETUP_FIXED.sql:230-247` |
| Missing | No offer/contract step, no consent capture for applicant PII, no notification on rejection, no duplicate-application guard across `discord_id` **and** email. | table set |
| Verdict | **Excellent domain model, partially broken plumbing.** This is the single most valuable legacy artefact to carry into V2 (see `29_TRYOUTS.md`). |

---

## 10. Finance — `/dashboard/finance` (50.4 KB)

| Aspect | Finding | Evidence |
| --- | --- | --- |
| Goal | Track slot spend, prize money won, monthly team cost | `app/dashboard/finance/page.tsx` |
| What exists | `slots` (purchase), `slot_expenses` (auto-created cost), `winnings` (position + amount), `prize_pools` (total + JSON breakdown), `tier_defaults` (rate card) | `scripts/00:137-216`; `automation-scripts/04:12-32` |
| **Not a finance system** | No chart of accounts, no invoices, no bills, no approvals, no payment records, no reconciliation, no accruals, no multi-currency, no tax. | absence across all SQL |
| **Players can see team money** | RLS policies grant read access to *players* on financial tables: `scripts/04:202-210` `"Players can view their team's slot expenses"`, `scripts/04:242-250` on winnings, `scripts/04:281-288` on prize pools, and `scripts/13:223-231` `"Team members can view team expenses"`, `scripts/13:242-250` on winnings. Both sets are active simultaneously (OR semantics). | policy inventory |
| UI gate only | `DASHBOARD_MODULES` restricts `/dashboard/finance` to `['admin','manager']`, so the *page* is hidden from players — but the *data* is readable. | `lib/dashboard-permissions.ts:70-78` |
| Fabricated public numbers | `/api/public/stats` returns `costCovered = 37800 + SUM(slot_expenses.total)` publicly, mixing a hardcoded figure with real spend. | `app/api/public/stats/route.ts:30, 55-61` |
| Verdict | **Partially implemented as a slot-purchase ledger.** Not usable as an organisation finance module. See `31_FINANCE.md`. |

---

## 11. Tournaments — `/dashboard/team-management/slots`

*Covered in detail in `28_TOURNAMENTS.md`.* UX summary: slot booking is coherent; there is no
tournament, match, bracket, opponent, result or schedule entity anywhere. "Tournament" exists
only as a free-text `organizer` string on `slots` and as a `session_type` enum value.

---

## 12. Administration — `/dashboard/admin/settings`, `/dashboard/admin/agreements`

| Aspect | Finding | Evidence |
| --- | --- | --- |
| Settings | Reads/writes `admin_config` key/value via the service role. Keys include `app_version`, `maintenance_mode`, `agreement_version_*`, `agreement_content_*`, `default_public_webhook_id`. | `app/api/admin/settings/route.ts`; `scripts/00:553-559` |
| **CRITICAL — purge endpoint** | `POST /api/admin/settings` with `{action:'purge_non_admin_data'}` deletes **every row** from `attendances`, `performances`, `rosters`, `slots`, `sessions`, `slot_expenses`, `winnings`, then **every non-admin user**, using the service-role key. No confirmation token, no dry-run, no audit log, no transaction, and **no per-table error check** (Supabase returns errors rather than throwing, so the `try/catch` cannot fire). It then returns `{success:true}`. | `app/api/admin/settings/route.ts:103-130` |
| **`admin_config` has no RLS** | Not in the RLS-enabled list of `scripts/00:474-481`, nor in any other script. With the public anon key, an unauthenticated caller can read **and write** `admin_config` directly via PostgREST — including `agreement_content_*` (the legal text shown to every player and coach) and `maintenance_mode`. | `scripts/00:474-481`; `automation-scripts/04:157-166` reads `agreement_enforcement_enabled` from it |
| **Agreement enforcement is attacker-disableable** | `check_user_agreement_status()` returns `requires_agreement:false, status:'bypassed'` when `admin_config.agreement_enforcement_enabled` is not `'true'`. Since that key is writable by anyone (above), the entire legal-agreement gate can be switched off by an anonymous attacker. | `automation-scripts/04:157-172`; `app/api/agreements/route.ts:47-52` |
| Agreements admin | `GET/POST /api/admin/agreements` authenticate with `getUser` but then read the caller's role and read/write `admin_config` with the **anon** client. `auth.uid()` is NULL ⇒ the role query returns nothing ⇒ `userData?.role !== 'admin'` ⇒ **403 for every caller, including real admins.** | `app/api/admin/agreements/route.ts:12-26, 86-94` |
| Verdict | **Partially implemented, with one critical destructive endpoint and one critical unauthenticated write path to legal content.** |

---

## 13. Cross-workflow UX findings

| # | Finding | Evidence | Severity | Confidence |
| --- | --- | --- | --- | --- |
| UX-01 | **Zero and "no data" are indistinguishable.** No empty state on `/dashboard` and `/dashboard/finance`; an RLS denial renders as `0`, so a broken policy looks like an empty organisation. | `app/dashboard/page.tsx`, `app/dashboard/finance/page.tsx` | HIGH | HIGH |
| UX-02 | **No error-reporting affordance anywhere.** Users cannot report a problem, and there is no feedback channel except Discord. | absence | MEDIUM | HIGH |
| UX-03 | **No pagination, filtering or sorting on most list pages.** `GET /api/attendances`, `/api/sessions`, `/api/rosters` return unbounded sets; the UI has no server-side paging. | `app/api/attendances/route.ts:50-81` | MEDIUM | HIGH |
| UX-04 | **No global search.** Only `profile-search` (admin/manager, and broken). No search for teams, matches, contracts, sponsors, content, documents. | `app/api/profile/search/route.ts` | MEDIUM | HIGH |
| UX-05 | **Notifications are Discord-only and opt-in per team.** There is no in-app notification centre, no email, no push. A player who is not on Discord learns nothing. | `24_NOTIFICATIONS.md` | HIGH | HIGH |
| UX-06 | **No bulk operations anywhere.** Bulk role change, bulk attendance correction, bulk invite — all absent. Players are managed one at a time. | absence | MEDIUM | HIGH |
| UX-07 | **Dangerous actions lack confirmation.** `alert-dialog.tsx` exists but is unused; the purge control has no typed confirmation. | `06_UI_COMPONENTS.md` F-UI-05 | HIGH | HIGH |
| UX-08 | **Onboarding collects extensive PII from a potentially minor audience with no consent step.** | `92_COMPLIANCE.md` | HIGH | HIGH |
| UX-09 | **Public forms have no bot/abuse protection** and relay straight to Discord. | `app/api/public/submit/*` | MEDIUM | HIGH |
| UX-10 | **Corrupted copy throughout** — emoji and em-dashes render as `dY"'` / `�?` in Discord embeds, page metadata and console warnings. | `app/layout.tsx:22`; `modules/discord-portal/embeds.ts`; all `api/discord/tryout/*` | MEDIUM | HIGH |
| UX-11 | **Session restore is fragile** — a 2 s timeout signs the user out. | `lib/auth-flow-v2.ts:200-245` | MEDIUM | HIGH |
| UX-12 | **Two debug pages reachable by any authenticated role, with write capability.** | `app/debug/page.tsx:153` | HIGH | HIGH |

---

## 14. UX verdict per workflow

| Workflow | Status | V2 verdict |
| --- | --- | --- |
| Sign in | Partially implemented | **REBUILD** (server session, no client timeout sign-out) |
| Sign up | Fragile / likely broken under RLS | **REBUILD** (invite-or-apply flows, explicit `Person` creation) |
| Onboarding | Partially implemented; UI/API field mismatch | **REBUILD** (schema-driven, consent-aware, minimal PII) |
| Dashboard | Implemented but untrustworthy | **REBUILD** (server-computed, explicit empty vs error states) |
| Team management | Implemented | **MIGRATE semantics, REBUILD implementation** |
| Player management | **Broken** (undefined RPCs) | **REBUILD** |
| Performance | Partially implemented | **REBUILD** (one form, one schema) |
| Attendance | Defect-dense | **REBUILD** (keep the rules, discard the code) |
| Tryouts | Best-modelled domain, partially broken | **MIGRATE the model, REBUILD the plumbing** |
| Finance | Slot ledger only | **REPLACE** with a real finance domain |
| Tournaments | Slot purchase only | **REPLACE** with a real competitive-operations domain |
| Administration | Critical destructive endpoint | **REBUILD** (no bulk purge without a governed, audited workflow) |
