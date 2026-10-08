# 10 — AUTHORIZATION

**Audit.md section:** 15 (SECTION 12 — AUTHORIZATION AUDIT)
Method: for every protected action, the question *Who? Can do what? To which resource? Under
what conditions?* was answered by reading the handler **and** the RLS policies that would
apply to the query it issues, then classifying the result as
`enforced-in-api`, `enforced-in-db`, `enforced-in-both`, `enforced-neither`, or
`contradictory`.

---

## 1. Authorisation enforcement points that actually exist

| Point | Mechanism | Strength | Coverage |
| --- | --- | --- | --- |
| `middleware.ts` | 6 security headers | **No authorisation at all**; also excluded from `/api/*` by its own matcher (`middleware.ts:36`) | 0 % |
| `components/route-guard-v2.tsx` | Client-side redirect of unauthenticated users | **Zero security value** — client code; performs no role check | UX only |
| `lib/api-utils.ts:184-194` | `checkRoleAccess(role, allowedRoles)` + `checkTeamAccess(userTeamId, targetTeamId, role)` | Weak: allowlist-per-handler, easy to forget | ~20 routes |
| Per-handler `if (user.role === 'admin')` | ad hoc | Weak: string comparisons, no central policy | 12 routes |
| `lib/role-system.ts` `RoleAccess` | 24 boolean flags per role | **Largely unused** — `hasPermission` is called from only a handful of places | partial |
| `lib/dashboard-permissions.ts` | `allowedRoles` per module | **UI only** | navigation |
| `lib/profile-utils.ts` | `canViewProfile` / `canEditProfile` | Reasonable logic, but see F-RBAC below | `app/api/profile` |
| RLS policies (~60 across 43 SQL files) | Postgres row predicates | **The only real boundary** — and it is documented as disabled in development | 18 of 32 tables |
| `SECURITY DEFINER` functions (~25) | Postgres | **Bypass RLS entirely**; identity taken as a *parameter* in two of them | 25 functions |
| Service-role key | Bypasses RLS | 6 routes, 4 with no authentication | — |

**There is no central policy engine.** Authorisation is the emergent sum of ~20 inline role
allowlists, 3 disagreeing TypeScript permission models, and ~60 SQL policies that were written
incrementally over one month and never reconciled.

---

## 2. Protected-action matrix

Legend: **API** = API-layer guard · **DB** = RLS/constraint · **BOTH** consistent ·
**API-ONLY** = no DB backstop · **DB-ONLY** = no API guard · **BROKEN** = neither works ·
**CONFLICT** = the two disagree.

| # | Action | Who (intended) | Resource scope | Condition | Enforcement | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Read user list | admin, manager; coach = own team; player = own team | `users` rows | role + `team_id` | API (`app/api/users:32-62`) + DB (`users` own-row policy) | **CONFLICT** — API returns `select('*')` for whole team incl. PII; DB allows only own row. Docs say coach/analyst/player are denied. |
| 2 | Read one profile | self; admin; manager; team members per visibility | `users` row + `rosters` | `canViewProfile` | API (`app/api/profile:71-86`) + DB | **API-ONLY** — `select('*')` returns DOB, address, emergency contact even to a team member |
| 3 | Edit own profile | any authenticated | allowlisted 27 fields | field allowlist | API (`app/api/profile:172-187`) + DB | **BOTH** — but the allowlist disagrees with the UI's field set (see `07_UX_AUDIT.md` §3) |
| 4 | Edit another profile | admin, manager, team coach | allowlisted fields | `canEditProfile` | API + DB | **API-ONLY** |
| 5 | **Change a user's role** | admin | `users.role`, `role_level` | `role === 'admin'` | API (`app/api/users:110`) + RPC | **BROKEN** — `bulletproof_user_update` is undefined; there is **no RLS UPDATE policy on `users` in `scripts/00`** |
| 6 | Delete a user | admin | `users` row | — | **absent** | **MISSING** — no route, no policy, no `ON DELETE` handling for dependents |
| 7 | Create / update / delete team | admin, manager (create+update); delete contested | `teams` row | role | API (`app/api/teams/manage`) + DB (`scripts/04:75-88` grants DELETE to manager) | **CONFLICT** — `role-system` says manager cannot delete; `dashboard-permissions` and RLS say they can |
| 8 | Manage roster | admin, manager, team coach | `rosters` rows | role + `team_id` | API + DB (`scripts/04:108-136`, `scripts/13:185-212`) | **BOTH but duplicated** — two policy sets coexist; `scripts/13:203` `"Players can view team rosters"` **widens** `scripts/04:136` `"Players can view their own roster entry"`, exposing teammates' `contact_number` and `device_info` to players |
| 9 | Book / manage slots | admin, manager, team coach | `slots` rows | role + `team_id` | API + DB (`scripts/16:107-152`) | **BOTH** |
| 10 | Read slot expenses | admin, manager | `slot_expenses` | role | API (`app/api/expenses`) + DB (`scripts/04:179-197`, `scripts/13:214-231`) | **CONFLICT** — DB also grants players and all team members read |
| 11 | Read winnings | admin, manager | `winnings` | role | API + DB (`scripts/04:253-288`, `scripts/13:233-250`) | **CONFLICT** — same widening |
| 12 | Read prize pools | admin, manager | `prize_pools` | role | DB (`scripts/04:212-250`) | **DB-ONLY widening** — players can read; no API route |
| 13 | Manage tier rates | admin, manager | `tier_defaults` | role | API + DB (`scripts/06:59-80`, `scripts/13:252-256`) | **BOTH**; duplicate policy names across files |
| 14 | Create performance | admin, manager, coach (team), player (self) | `performances` row | role + `team_id` + `player_id` | API (`app/api/performances:164, 240-265`) + DB (`scripts/15:10-24`) | **BOTH** — the best-aligned pair in the codebase |
| 15 | Read performances | admin/manager = all; coach/analyst = own team; player = own team (**code**) vs own row (**RLS**) | `performances` rows | role | API (`:100-111`) + DB (`scripts/00:508-509`) | **CONFLICT** — API grants players team-wide read; RLS grants own row only; `README.md:196-200` says "own data" |
| 16 | Delete performance | staff, or player for own row (**RLS**) | `performances` | — | **RLS only** (`scripts/15:48-60`) | **DB-ONLY** — no API route; a live latent grant |
| 17 | Read attendance | admin/manager = all; coach/analyst = own team; player = own | `attendances` | role | API (`:56-71`) + DB (`scripts/11:35-98`) | **BOTH** |
| 18 | Mark attendance | admin/manager any; coach own team; player self | `attendances` | role + `team_id` + `player_id` | API (`:143-166`) + DB (`scripts/11:62-98`) | **BOTH** |
| 19 | **Delete attendance** | admin/manager/coach/player per ownership | `attendances` | — | API — **`ReferenceError`** | **BROKEN** — always 500 |
| 20 | Update attendance | admin/manager any; coach own team; player self | `attendances` | ownership | API (`:257-280`) + DB | **BOTH**; API writes a non-existent `notes` column |
| 21 | Create / update / delete session | admin, manager, team coach | `sessions` | role + `team_id` | API (`app/api/sessions:127-176, 246-285, 348-391`) + DB (`database/session-attendance-schema.sql:104-124`) | **BOTH** |
| 22 | Manage holidays | admin | `holidays` | role | DB (`session-attendance-schema.sql:128-134`) | **DB-ONLY** — no API route; `Everyone can view holidays` |
| 23 | Manage practice-session config | admin, manager, coach | `practice_session_config` | role | API | **API-ONLY** — **RLS is never enabled on this table** |
| 24 | Manage tryouts | admin, manager, coach | `tryouts` | role | API + DB (`SUPABASE_TRYOUTS_SETUP_FIXED:217-224`) | **BOTH** |
| 25 | Create a tryout application | **anyone** | `tryout_applications` | tryout active + deadline | DB (`WITH CHECK` on the parent tryout, `:230-238`) | **BOTH** (intentional) — no rate limit, no CAPTCHA, no consent |
| 26 | Screen / shortlist applications | admin, manager, coach, **analyst** | `tryout_applications` | role | DB (`:240-247` includes `'analyst'`) | **DB-ONLY** — no API route; analyst can screen candidates though `DASHBOARD_MODULES` gives analysts no tryouts module |
| 27 | Invite a candidate | admin, manager, coach | `tryout_invitations` | role | DB (`:250-257`) | **DB-ONLY** — the API path (Discord) is **BROKEN** (anon client) |
| 28 | Evaluate a candidate | evaluator self, or admin/manager | `tryout_evaluations` | `evaluator_id = auth.uid()` OR staff | DB (`:270-278`) | **DB-ONLY** for the web app; Discord path **BROKEN** |
| 29 | Select / reject | admin, manager, coach | `tryout_selections` | role | DB (`:281-288`) | **DB-ONLY** |
| 30 | Read `tryout_stats` view | **anyone** | aggregate over all tryouts | none | **View without `security_invoker` ⇒ RLS bypassed** | **MISSING** — see F-RBAC §`08_ROLES_PERMISSIONS.md` |
| 31 | Read team webhooks | admin, manager, team member | `discord_webhooks` | `team_id IS NULL` **OR** role/team match | DB (`complete-discord-portal-setup.sql:92-100`) | **CONFLICT** — `team_id IS NULL` branch is unconditional and applies to `public` ⇒ **unauthenticated read of webhook credentials** |
| 32 | Create webhook | admin, manager (own team), **coach (own team or global)** | `discord_webhooks` | role + team | API (`:161-187`) + DB (`:102-123`) | **CONFLICT** — API blocks a coach; DB's `OR team_id IS NULL` **permits a coach to create a global webhook** |
| 33 | Update webhook | admin, manager (own team) | `discord_webhooks` | role + existing `team_id` | API (`:265-273`) | **API-ONLY + MASS ASSIGNMENT** — `{ id, ...updates }` spread into `.update()` with no field allowlist, so `team_id` and `type` can be changed ⇒ a manager can move their webhook to another team or promote it to `global` |
| 34 | Delete webhook | admin, manager (own team) | `discord_webhooks` | role + `team_id` | API (`:344-352`) | **API-ONLY** |
| 35 | **Validate a webhook URL** | **anyone** | outbound HTTP | URL regex | **NONE** | **MISSING** — unauthenticated server-side fetch |
| 36 | Read / update automation settings | admin, manager (all); coach (own team, UPDATE only); team member (SELECT) | `communication_settings` | role + team | API (`:73-85, 167-201`) + DB (`:151-180`) | **CONFLICT** — DB has **no INSERT policy**, so a coach's `upsert` fails on the insert branch; DB SELECT's `team_id IS NULL` branch lets anyone read global settings |
| 37 | **Insert a communication log** | **anyone** | `communication_logs` | none | DB `WITH CHECK (true)` (`:146-148`) | **MISSING** — the outbound-communication audit trail is publicly forgeable |
| 38 | Read Discord logs | admin, manager, team member | `communication_logs` | `team_id IS NULL` OR role/team | DB (`:126-144`) | **CONFLICT** — global logs readable by anyone |
| 39 | Send a Discord message | admin, manager | Discord | role | API | **API-ONLY**; `communication_logs` insert is open anyway |
| 40 | Use Discord bot endpoints | holder of `RAPTOR_BOT_API_KEY` | performances, attendance, tryouts, summaries | shared secret | static key only | **BROKEN/WEAK** — no per-identity auth, no signing, no replay protection, no rate limit |
| 41 | Upload avatar | self; admin/manager for others | `storage.objects` in `avatars` | role + `targetUserId` | API (`app/api/profile/avatar:87`) + service-role storage write | **API-ONLY** — service role bypasses the storage policies entirely; also writes `users.avatar_url` with the anon client (fails under RLS) |
| 42 | **Upload to `media`** | **anyone** | `storage.objects` in `media` | **none** | service role | **MISSING — CRITICAL** |
| 43 | **Delete from `media`** | **anyone** | `storage.objects` in `media` | **none** | service role | **MISSING — CRITICAL** |
| 44 | Upload a contact attachment | **anyone** | `contact_files` | **none** | service role + `TO public` storage policy | **MISSING — CRITICAL**; returned URL is also non-functional |
| 45 | Read/delete contact attachments | **anyone** | `contact_files` | **none** | `FOR SELECT TO public` / `FOR DELETE TO public` (`08-storage-bucket-setup.sql:129-139`) | **MISSING — CRITICAL** |
| 46 | Submit a public enquiry | **anyone** | Discord webhook | **none** | none | **BY DESIGN, but unrate-limited and credential-leaking** |
| 47 | Read admin config | admin | `admin_config` | role | API (service role) | **API-ONLY** — but the table has **no RLS**, so anyone with the anon key can read it directly |
| 48 | **Write admin config** | admin | `admin_config` | role | API (service role) | **MISSING — the table is writable by anyone with the anon key** |
| 49 | **Purge all non-admin data** | admin | 7 tables + `users` | role | API (service role) | **API-ONLY, no confirmation, no audit, no transaction, no per-table error check** |
| 50 | Set default public webhook | admin | `admin_config` | role | API (service role) | **API-ONLY** |
| 51 | Call ~25 `SECURITY DEFINER` functions | **anyone** (`anon` retains default EXECUTE) | all tables | function-internal only | Postgres | **MISSING — CRITICAL** (see `13_RLS_SECURITY.md`) |
| 52 | Read `/api/public/stats` | **anyone** | `teams`, `users`, `performances`, `slot_expenses` | none | RLS (denies) | **BY DESIGN**, but returns hardcoded fabrications and, if RLS is off, real spend totals |

---

## 3. Specific vulnerability classes

### 3.1 IDOR
| Finding | Evidence | Exploitability | Impact | Scope | Severity |
| --- | --- | --- | --- | --- | --- |
| **Team-scope parameter trusted from the client** | `app/api/performances/route.ts:74-83` accepts `?teamId=` and applies `.eq('team_id', teamId)` **before** the role filter at lines 100-111. For `coach`/`analyst` the role filter then overwrites it with `user.team_id` (good); but for **`admin`/`manager`** any `teamId` is accepted (by design) and for **any role not matched by lines 101-111** — i.e. `pending_player`, `tryout`, and **any future role** — **no scope filter is applied at all**, so `?teamId=` (or no parameter) returns every team's performances that RLS permits. | Low (RLS is the backstop) | Cross-team data disclosure | Any authenticated non-standard role | MEDIUM |
| **`PUT /api/attendances` uses `id` + fetched ownership, correct** | `app/api/attendances/route.ts:243-280` fetches the record then checks `player_id`/`team_id` | — | — | — | OK (good pattern) |
| **`PUT /api/profile` targets arbitrary `userId` with `canEditProfile`** | `app/api/profile/route.ts:122-160` | Low | A coach can edit any user on their team including `contact_number`, `emergency_contact_*`, `device_info` | Team | LOW (by design, but over-broad field set for a coach) |
| **`POST/DELETE /api/profile/avatar` targets arbitrary `userId`** for `admin`/`manager` | `app/api/profile/avatar:87, 212` | — | A manager can overwrite any user's avatar | Org | LOW |
| **`GET/POST/PUT/DELETE /api/teams/[id]/players`** trusts the path `id` | `app/api/teams/[id]/players/route.ts` | Needs per-file confirmation | — | — | **UNKNOWN** — flagged for the V2 security test plan |

### 3.2 Vertical privilege escalation
| Finding | Evidence | Severity |
| --- | --- | --- |
| Coach → global Discord webhook via RLS | `database/complete-discord-portal-setup.sql:112-123` (`OR discord_webhooks.team_id IS NULL`) | **HIGH** |
| Manager → move/promote a webhook via mass assignment | `app/api/discord-portal/webhooks/route.ts:241, 283-285` | **HIGH** |
| Any authenticated user → forge an agreement for another role | `app/api/agreements/route.ts:79-118` + `user_agreements FOR ALL USING (user_id = auth.uid())` | LOW |
| Anyone → disable legal-agreement enforcement | `admin_config` has no RLS; `automation-scripts/04:157-172` | **MEDIUM** |
| Anyone → rewrite legal agreement text shown to all users | `admin_config` has no RLS; `app/api/admin/agreements:118-124` writes via anon client | **HIGH** (integrity) |
| Latent: any authenticated user → `createAdminProfile` | `lib/secure-profile-creation.ts:222-275` (not currently reachable) | **HIGH** (latent) |

### 3.3 Horizontal privilege escalation
| Finding | Evidence | Severity |
| --- | --- | --- |
| Player reads whole-team PII via `GET /api/users` | `app/api/users/route.ts:53-62` + `select('*')` at `:43` | **HIGH** |
| Player reads whole-team performances via `GET /api/performances` | `app/api/performances/route.ts:101-106` | **MEDIUM** |
| Player reads whole-team rosters incl. contact/device | `scripts/13:203-212` OR `scripts/04:136-139` | **MEDIUM** |
| Player/team member reads team finances | `scripts/04:202-250, 281-288`; `scripts/13:223-250` | **HIGH** |
| Any authenticated user impersonates any identity inside `can_view_profile` / `can_edit_profile` | `automation-scripts/04:60-140` (identity is a parameter) | **MEDIUM** |
| Unauthenticated user reads admin/global webhook credentials | `database/complete-discord-portal-setup.sql:92-100` | **CRITICAL** |
| Unauthenticated user reads/deletes contact attachments | `automation-scripts/08:129-139` | **CRITICAL** |

### 3.4 Mass assignment
| Endpoint | Evidence | Severity |
| --- | --- | --- |
| `PUT /api/discord-portal/webhooks` | `app/api/discord-portal/webhooks/route.ts:241` `const { id, ...updates } = await request.json()`; `:285` `.update({ ...updates, updated_at })` — **no field allowlist**; the POST handler's `type`-elevation check at `:180-187` is **not repeated in PUT** | **HIGH** |
| `PUT /api/sessions` | `app/api/sessions/route.ts:255-301` destructures 11 named fields — **safe by omission**, but `team_id` is client-supplied and a coach is only blocked if they *supply* a foreign `team_id` (`:279`); omitting `team_id` sends `undefined`, which PostgREST treats as "no change" — acceptable but fragile | LOW |
| `PUT /api/profile` | allowlist present (`:172-187`) — **good** | — |
| `POST /api/performances` | explicit field list (`:268-281`) — **good** | — |
| `POST /api/admin/settings` | arbitrary keys into `admin_config` `upsert` (`:142-147`) — admin-only, but an admin can therefore write `agreement_content_*` and `maintenance_mode` through a route not intended for it | MEDIUM |
| `PUT /api/rosters`, `PUT /api/teams/manage`, `PUT /api/slots` | need per-file confirmation | **UNKNOWN** |

### 3.5 Injection
| Class | Finding | Evidence | Severity |
| --- | --- | --- | --- |
| **PostgREST filter injection** | `GET /api/profile/search?q=` is interpolated straight into `.or(...)`: `` `full_name.ilike.%${query}%,display_name.ilike.%${query}%,email.ilike.%${query}%,bgmi_id.ilike.%${query}%` `` | `app/api/profile/search/route.ts:52-57` | **MEDIUM** — a `q` containing `,` or `)` injects additional PostgREST predicates; the endpoint is admin/manager-gated, so exploitation requires an admin account (or a compromised one) |
| PostgREST `.or()` with interpolated `auth.uid()` | `query.or(\`player_id.eq.${user.id},team_id.eq.${user.team_id}\`)` | `app/api/performances/route.ts:103` | LOW — `user.id` is a server-derived UUID, not user input |
| SQL injection | **No raw SQL anywhere in the application.** All access is via the PostgREST query builder or parameterised RPC. | `rg "sql\`\|execute_sql\|query("` → no raw SQL construction | **NONE FOUND** |
| Command injection | None — no shell execution, no `child_process`. | — | **NONE FOUND** |
| XSS via `dangerouslySetInnerHTML` | 3 uses: `components/ui/chart.tsx:96` (**dead code**), `app/faq/page.tsx:520` and `components/seo/OrganizationJsonLd.tsx:18`, both `JSON.stringify` of internal data | `rg dangerouslySetInnerHTML` | **LOW** — `JSON.stringify` output is not escaped for `</script>`, so a tenant-controlled organisation name containing `</script>` would break out. In the current single-tenant system the data is hardcoded. **Becomes exploitable the moment organisation names become user input.** |
| HTML injection sink | `lib/force-logout.ts:49-63` `toast.innerHTML = \`…${reason}…\`` | `:62` | **LOW** — `reason` is currently only a literal default string |
| SSRF | `POST /api/discord-portal/webhooks/validate` performs a server-side `fetch(url)`; `modules/discord-portal/webhookService.ts:233` restricts the host with a regex to `discord.com`/`discordapp.com`; `sendWebhookMessage` posts to whatever `hook_url` is stored | `app/api/discord-portal/webhooks/validate/route.ts:15`; `webhookService.ts:242-248` | **LOW** for validate (regex-constrained, unauthenticated); **MEDIUM** for stored webhooks — a webhook URL inserted via `POST /api/discord-portal/webhooks` is **not validated** (the regex is only applied in `PUT`, `route.ts:276-281`), so an admin/manager can store an arbitrary URL and then trigger a server-side POST to it via "send" |
| Unsafe deserialization | `JSON.parse` used on `admin_config` values in `app/api/admin/agreements:43` inside a `try/catch`; no `eval`, no `new Function`, no node-serialize | `rg "eval\(|new Function\("` → 0 | **NONE FOUND** |

### 3.6 Excessive data exposure
| Finding | Evidence | Severity |
| --- | --- | --- |
| `select('*')` on `users` for player-visible endpoints | `app/api/users/route.ts:43`; `app/api/profile/route.ts:55` (`select('*, team:…, roster:…')`) | **HIGH** — returns `emergency_contact_number`, `date_of_birth`, `address`, `device_info`, `discord_id`, `instagram_handle`, `sensitivity_settings`, `game_stats`, `achievements` |
| Nested selects return other users' emails | `app/api/performances/route.ts:55` `users:player_id(id, name, email)`; `app/api/sessions/route.ts:52` `created_by_user:created_by(id, name, email)` | MEDIUM |
| `select('*')` on `discord_webhooks` returns `hook_url` | `app/api/discord-portal/webhooks/route.ts:78, 86, 104, 114`; `webhookService.ts:40, 62, 79, 102` | **HIGH** — credential disclosure to any manager |
| `communication_logs.payload` holds full Discord embeds | `lib/supabase.ts:612-652`; `sendToDiscord.ts:122-146` | LOW |
| Raw database error text returned to clients | `app/api/performances:46, 295`; `app/api/sessions:90, 209`; `app/api/teams/manage`; `app/api/admin/settings:51, 93, 156` (`details: <pg error>`); `app/error.tsx:58` (`error.message` rendered) | **MEDIUM** — leaks schema/constraint names and internals |
| `supabase.storage.createBucket()` called on every upload | `app/api/media/upload:58`; `app/api/public/upload/contact-file:55` | LOW — wasteful; also a service-role DDL attempt on each request |

### 3.7 Rate limiting / replay / abuse
| Finding | Evidence | Severity |
| --- | --- | --- |
| **No rate limiting anywhere** | `lib/discord-bot-auth.ts` defines `RATE_LIMITS` (performance 60/min, attendance 30/min, queries 100/min, tryouts 10/min) and is **never imported** | **HIGH** |
| **Replayable static bot secret** | 12 routes compare `request.headers.get('authorization') !== \`Bearer ${process.env.RAPTOR_BOT_API_KEY}\`` with `!==` (not constant-time) and no nonce/timestamp/signature | **HIGH** |
| Public form relay with no throttle | `app/api/public/submit/contact`, `app/api/public/submit/application` forward attacker-controlled content to the org's Discord channel | **HIGH** |
| Unbounded `limit` | `app/api/profile/search:24` `parseInt(… \|\| '20')` with **no cap** (contrast `lib/api-utils.ts:227-237` `getPaginationParams`, which caps at 100 and is **never used**) | MEDIUM |
| Unbounded result sets | `GET /api/attendances`, `/api/sessions`, `/api/rosters`, `/api/slots` | MEDIUM |
| `GET /api/public/stats` unauthenticated, 5 aggregate queries per call | `app/api/public/stats:20-31` | MEDIUM — cheap DoS/amplification against PostgREST |

---

## 4. Authorisation verdict

**The authorisation model is not repairable in place.** Reasons, all evidence-backed:
1. Five disagreeing policy models (`08_ROLES_PERMISSIONS.md` §2).
2. The only real boundary (RLS) is documented as disabled in development
   (`database/README.md:41-46, 73-75`) and was therefore never exercised against the
   application logic, so ~9 endpoints that use a session-less anon client are simultaneously
   *broken* and *unguarded*.
3. Four endpoints have no authorisation at all, two of them with the service-role key.
4. 10 of 32 tables have no RLS, including `admin_config` (legal text) and the 25
   `SECURITY DEFINER` functions are not revoked from `anon`.
5. There is no policy engine, so every new endpoint must re-implement authorisation by hand —
   which is precisely how the existing inconsistencies were introduced.

**Target state:** see `10_AUTHORIZATION.md` §5 and `63_ROLE_MODEL.md` — authorisation becomes
a versioned policy dataset compiled into (a) navigation, (b) API guards, (c) RLS, and (d) an
automated conformance test that fails the build when the three diverge.
