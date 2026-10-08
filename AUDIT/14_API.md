# 14 — API INVENTORY

**Audit.md section:** 20 (SECTION 17 — API INVENTORY)
**Machine-readable:** `AUDIT/evidence/routes/api-matrix.md`, `AUDIT/evidence/routes/api-matrix.csv`
**Totals:** 58 route files · 96 exported HTTP handlers (75 GET-family reads, 21 writes/deletes
counted per method below) · 0 documented in an OpenAPI/Swagger schema · 0 versioned.

---

## 1. Conventions observed (and their inconsistencies)

| Aspect | Convention | Inconsistency |
| --- | --- | --- |
| Auth header | `Authorization: Bearer <supabase access_token>` | Discord endpoints use the same header for a **static API key** — indistinguishable to a reader and to a proxy |
| Success shape | `createSuccessResponse(data)` returns **raw** data for objects/arrays and `{data, message, success}` for primitives (`lib/api-utils.ts:154-169`) | Two response shapes coexist; `discord-portal/*` and `agreements/*` return bespoke shapes again |
| Error shape | `{error, code, details?}` with an HTTP status (`lib/api-utils.ts:142-151`) | `discord-portal/*` returns `{error}` only; `agreements/*` returns `{error}` only; `public/*` returns `{error}` |
| Pagination | `getPaginationParams` caps limit at 100 (`lib/api-utils.ts:227-237`) | **Never used.** Most list endpoints have no pagination; `profile/search` has no cap; `performances` allows 1000 and defaults to unlimited |
| Validation | `validateRequiredFields` + `isValidUuid` + manual numeric checks | `zod` is a declared dependency and is never used |
| CORS | `corsHeaders` with `Access-Control-Allow-Origin: *`, applied via `handleCors` | 12 routes apply it; the other 46 do not; `middleware.ts` has a second, **dead**, copy |
| Idempotency | none | No `Idempotency-Key` on any write |
| Rate limiting | none | `RATE_LIMITS` exists in dead code |
| Request correlation | none | No `x-request-id`; `logBotApiRequest` exists in dead code |
| API versioning | none | Flat `/api/*` |

---

## 2. Complete endpoint inventory

### 2.1 `api/admin/*`

| Method | Path | Purpose | Auth | Authz | Validation | Request | Response | Errors | Rate limit | DB ops | External | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/admin/settings` | read all `admin_config` | `authenticateRequest` | `role==='admin'` | — | — | `{settings:{k:v}}` | 401/403/500 | **none** | `admin_config` (service role) | — | active |
| POST | `/api/admin/settings` | save settings **or purge all data** | `authenticateRequest` | `role==='admin'` | `settings` object present | `{action?,settings?}` | `{success:true}` | 400/401/403/500 | **none** | `admin_config` upsert; **7-table purge + users delete** | — | **CRITICAL** — see `15_API_SECURITY.md` F-API-06 |

### 2.2 `api/agreements/*`

| Method | Path | Purpose | Auth | Authz | Validation | Response | Errors | DB ops | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/agreements` | caller's agreement status | `getUser` | self | `role` from DB, not body | `{user_id, role, agreement_status}` | 401/404/500/503 | `users` (RLS), RPC `check_user_agreement_status` | active; **fails open** on error |
| POST | `/api/agreements` | record acceptance | `getUser` | self | `role`,`version` present and `version===required(role)` | `{message, agreement}` | 400/401/500/503 | `user_agreements` upsert on `user_id,role` | active; **role is client-supplied**; upsert depends on an undefined UNIQUE |
| GET | `/api/agreements/content` | agreement document text | **none** | none | — | agreement content | — | `admin_config` | active (public) |

### 2.3 `api/analytics/*`

| Method | Path | Purpose | Auth | Authz | Validation | Response | DB ops | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/analytics/performance` | player / team-comparison / trend analytics | `authenticateRequest` | role-scoped | `type` enum, timeframe | `{data}` wrapped per `type` | `performances`, `users`, `teams`, `winnings` (multiple queries) | active; 19.6 KB single handler, 3 response shapes |

### 2.4 `api/attendances/*`

| Method | Path | Purpose | Auth | Authz | Validation | Errors | DB ops | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/attendances` | list, timeframe + team filter | `authenticateRequest` | admin/manager = optional team; coach/analyst = own team; player = self | `isValidUuid(teamId)` | 400/401/403/500 | `attendances` | active |
| POST | `/api/attendances` | mark attendance | `authenticateRequest` | player=self; coach=own team; admin/manager=any | required fields + 2 UUIDs | 400/401/403/500 | `attendances` insert | active; no uniqueness ⇒ duplicates |
| PUT | `/api/attendances` | change status | `authenticateRequest` | ownership via fetched row | `isValidUuid(id)` | 400/401/404/500 | `attendances` update | active; **writes a non-existent `notes` column** |
| DELETE | `/api/attendances` | delete a record | **calls an undefined function** | — | — | **always 500** | — | **BROKEN** |
| GET | `/api/attendances/summary` | aggregates | `authenticateRequest` | role | none | 401/500 | `attendances` | active |
| GET | `/api/attendances/verification` | rows awaiting verification | `authenticateRequest` | role | none | 401/500 | `attendances` | active |
| PUT | `/api/attendances/verification` | manager verification | `authenticateRequest` | role | none | 400/500 | `attendances` update | active |

### 2.5 `api/auth/*`, `api/dashboard/*`

| Method | Path | Purpose | Auth | Authz | Validation | Response | DB ops | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/auth/session` | echo session | none | none | none | `{session}` or `{access_token: <caller token>}` | — | active; **low value, echoes the token** |
| GET | `/api/dashboard/overview` | org/team dashboard metrics | `authenticateRequest` | admin/manager = org-wide; others team-scoped | none | metric object | 5 aggregate queries | active |

### 2.6 `api/discord/*` — 12 files, 13 handlers (all share the static bot key)

| Method | Path | Purpose | Authz | Validation | DB ops (client used) | Status |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/discord/attendance/mark` | bot marks attendance | **none** (shared key only) | manual | `attendances` via **anon client** | active; writes attendance with no human actor |
| GET | `/api/discord/attendance-summary` | team attendance digest | **none** | none | `attendances`, `users` via anon | active |
| GET | `/api/discord/digest` | periodic digest | **none** | none | multiple via anon | active |
| POST | `/api/discord/performance/upload` | bot submits a performance | **none** | manual | `performances` via anon | active |
| GET | `/api/discord/sessions` | list sessions | **none** | none | `sessions` via anon | active |
| GET | `/api/discord/team-attendance-summary` | team attendance | **none** | none | via anon | active |
| GET | `/api/discord/team-performance` | team performance | **none** | none | via anon | active |
| POST | `/api/discord/tryout/apply` | candidate applies | **none** | required `tryout_id`,`discord_id`,`guild_id`; mode-specific fields; deadline check | `tryouts`, `tryout_applications` via anon | active; the **only working** tryout write (INSERT policy is public) |
| POST | `/api/discord/tryout/announce` | create a tryout from Discord | **none** | required `guild_id`,`name`,`created_by_discord_id` | `discord_users`, `tryouts` insert via anon | **BROKEN** — `tryouts` INSERT requires staff; also emits a wrong apply URL |
| POST | `/api/discord/tryout/evaluate` | submit an evaluation | **none** | required `tryout_id`,`evaluator_discord_id`,`guild_id` | `discord_users`, `tryout_invitations`, `tryout_evaluations` via anon | **BROKEN** — INSERT requires `evaluator_id = auth.uid()` or staff |
| POST | `/api/discord/tryout/invite` | invite a shortlisted candidate | **none** | `application_id` OR (`tryout_id`+`discord_id`) | `tryout_applications`, `tryout_invitations` insert + `tryout_applications` update via anon | **BROKEN** — INSERT requires staff |
| GET | `/api/discord/tryout/list` | list tryouts + stats | **none** | `guild_id` required | `tryouts` (+ child selects) via anon | **partial** — only `status='active' AND open_to_public=true` rows are visible; all stats are empty |
| GET | `/api/discord/tryout/status` | applicant's pipeline status | **none** | `discord_id`,`guild_id` required | `tryout_applications` select via anon | **BROKEN** — no anon SELECT policy |
| GET/POST | `/api/discord/webhooks` | list / register webhooks | **none** | none | `discord_webhooks` via anon | active; registers arbitrary URLs |

All 13 handlers also **return fully-formed Discord `embed_data` objects** for the bot to post,
which is a reasonable contract — but every one of those embeds is corrupted by mojibake
(`dY"'`, `dYZ%`, `�o.`), so the bot renders garbage.

### 2.7 `api/discord-portal/*` — best-implemented group

| Method | Path | Purpose | Auth | Authz | Validation | DB ops | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/discord-portal/logs` | delivery log + filters | user-bound client | role/team | pagination | `communication_logs` (user client) | active |
| POST | `/api/discord-portal/logs` | retry a failed message | user-bound client | role/team | — | `communication_logs` update | active |
| GET | `/api/discord-portal/send` | preview an embed | user-bound client | role/team | — | none | active |
| POST | `/api/discord-portal/send` | send a message | user-bound client | role/team | message type enum | `discord_webhooks`, `communication_logs` | active |
| GET | `/api/discord-portal/settings` | read automation toggles | user-bound client | admin for global; team match otherwise | `teamId`,`global` | `communication_settings` | active |
| PUT | `/api/discord-portal/settings` | toggle automation | user-bound client | admin for global/admin keys; team match otherwise | **`validKeys` allowlist (9 keys)** + boolean | `communication_settings` upsert | active; coach INSERT will fail (F-RLS-12) |
| GET/PUT | `/api/discord-portal/settings/default-webhook` | get/set the public intake webhook id | user-bound client | **admin** | `value` present | `admin_config` (service role) | active |
| GET | `/api/discord-portal/webhooks` | list webhooks | user-bound client | admin=all; manager=own team (**or all if `team_id` is null**) | `teamId` | `discord_webhooks` `.select('*')` | active; **returns `hook_url`** |
| POST | `/api/discord-portal/webhooks` | create webhook | user-bound client | admin; manager=own team; admin-only for `type∈{admin,global}` | `hook_url`,`type` present; **`hook_url` NOT validated here** | `discord_webhooks` insert | active |
| PUT | `/api/discord-portal/webhooks` | update webhook | user-bound client | admin; manager=existing team | URL regex **only if `hook_url` present** | `discord_webhooks` update | active; **mass assignment** |
| DELETE | `/api/discord-portal/webhooks` | delete webhook | user-bound client | admin; manager=existing team | `id` | `discord_webhooks` delete | active |
| POST | `/api/discord-portal/webhooks/validate` | test a webhook URL | **NONE** | **none** | URL regex | none; **outbound fetch** | **unauthenticated SSRF-capable** |

### 2.8 `api/expenses`, `api/winnings`, `api/rosters`, `api/slots`, `api/tier-defaults`, `api/tryouts`

| Method | Path | Purpose | Auth | Authz | Validation | DB ops | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/expenses` | slot expenses | `authenticateRequest` | role | none | `slot_expenses`, `slots` | active; **players can read via RLS** |
| GET | `/api/winnings` | prize winnings | `authenticateRequest` | role | none | `winnings` | active; same |
| GET/POST/PUT/DELETE | `/api/rosters` | roster CRUD | `authenticateRequest` | role + team | none | `rosters`, `users` | active; **no field allowlist on writes** |
| GET/POST/DELETE | `/api/slots` | slot booking | `authenticateRequest` | role + team | manual | `slots` (+ trigger → `slot_expenses`) | active |
| GET/PUT | `/api/tier-defaults` | rate card | `authenticateRequest` | role | none | `tier_defaults` | active |
| GET/POST | `/api/tryouts` | tryout list / create | `authenticateRequest` | role | manual | `tryouts` (+ `user_agreements` on create?) | active |

### 2.9 `api/media/*` — the two worst endpoints in the repository

| Method | Path | Auth | Authz | Validation | Credential | Bucket | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/media/upload` | **NONE** | **NONE** | MIME allowlist (9 types) + 20 MB, **client-supplied `file.type` only, no magic-byte check**; `folder` unsanitised | `SUPABASE_SERVICE_ROLE_KEY` (falls back to anon) | `media`, **created `public: true`** | **CRITICAL** |
| DELETE | `/api/media/delete?path=` | **NONE** | **NONE** | `path` presence only | `SUPABASE_SERVICE_ROLE_KEY` | `media`, **arbitrary path** | **CRITICAL** |

### 2.10 `api/performances/*`

| Method | Path | Purpose | Auth | Authz | Validation | Response | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/performances` | list with timeframe/team/player/map filters | `authenticateRequest` | player=**own team**; coach/analyst=own team; admin/manager=all | `isValidUuid` on team & player; `limit` ≤ 1000 or unlimited | raw array | active; over-sharing for players |
| POST | `/api/performances` | submit a result | `authenticateRequest` | player=self+own team; coach=own team | 6 required fields + 5 non-negative numerics | created row | active; accepts legacy + new field shapes |

### 2.11 `api/profile/*`

| Method | Path | Purpose | Auth | Authz | Validation | Credential | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/profile?userId=` | one profile | `getUser` | `canViewProfile` | `isValidUuid` | user client | active; returns `*` incl. PII |
| PUT | `/api/profile` | update profile | `getUser` | `canEditProfile` | **27-field allowlist** (good) | user client | active |
| GET | `/api/profile/search?q=` | search users | `getUser` for the role check | admin/manager | none; **`.or()` interpolation**; `limit` uncapped | **anon client** | **broken + injectable** |
| POST | `/api/profile/avatar` | upload avatar | `getUser` | self, or admin/manager for others | MIME allowlist + 5 MB; **extension from `file.name`, unvalidated** | **service role (storage)**, anon client (DB write) | partially broken |
| DELETE | `/api/profile/avatar?userId=` | remove avatar | `getUser` | self, or admin/manager | — | service role + anon client | active |

### 2.12 `api/public/*`

| Method | Path | Purpose | Auth | Validation | External | Status |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/public/stats` | public counters | **NONE** | none | — | active; **returns hardcoded fabrications** + (RLS-gated) real spend |
| POST | `/api/public/submit/application` | relay an application to Discord | **NONE** | field presence only | **Discord webhook** | active; unauthenticated relay, no rate limit |
| POST | `/api/public/submit/contact` | relay an enquiry to Discord | **NONE** | field presence only | **Discord webhook** + **service-role fallback lookup** | active; same |
| POST | `/api/public/upload/contact-file` | attach a file to an enquiry | **NONE** | MIME allowlist + 10 MB | Supabase Storage (service role) | **CRITICAL** — unauthenticated write into a world-readable bucket; returned `downloadUrl` is generated with `getPublicUrl()` on a **private** bucket and is therefore non-functional |

### 2.13 `api/sessions/*`

| Method | Path | Purpose | Auth | Authz | Validation | Status |
| --- | --- | --- | --- | --- | --- | --- |
| GET/POST/PUT/DELETE | `/api/sessions` | session CRUD; default window 14 days for admin/manager, today for others | `authenticateRequest` | create/update/delete = admin/manager/coach, coach limited to own team | required fields + `isValidUuid(team_id)` | active |
| GET | `/api/sessions/attendance-heatmap` | heatmap aggregates | `authenticateRequest` | role | none | active |
| GET | `/api/sessions/daily-practice` | today's practice state | `authenticateRequest` | role | none | active |
| GET/POST | `/api/sessions/generate-daily` | generate today's practice sessions | `authenticateRequest` | role | none | active; calls RPC `generate_daily_practice_sessions(date)`; **not idempotent** |
| POST | `/api/sessions/mark-attendance` | mark attendance for a session | `authenticateRequest` | role + team | manual | active |
| GET/POST/PUT/DELETE | `/api/sessions/practice-config` | recurring practice windows | `authenticateRequest` | role + team | manual | active; **table has no RLS** |
| POST | `/api/sessions/practice-config/reset` | reset to defaults | `authenticateRequest` | role | none | active |

### 2.14 `api/teams/*`

| Method | Path | Purpose | Auth | Authz | Validation | Status |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/teams` | list teams | `authenticateRequest` | role-scoped | none | active |
| POST/PUT/DELETE | `/api/teams/manage` | team CRUD incl. **hard delete** | `authenticateRequest` | role | manual | active; delete cascades away all history |
| GET/POST | `/api/teams/monthly` | monthly rollups | `authenticateRequest` | role | none | active |
| GET/POST/DELETE | `/api/teams/[id]/players` | roster ops scoped by path id | `authenticateRequest` | role + team | manual | active |

### 2.15 `api/users/*`

| Method | Path | Purpose | Auth | Authz | Validation | DB ops | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/users` | list users | `authenticateRequest` | admin/manager/analyst = **all**; coach = own team; player = own team | none | `users` `.select('*')` | active; **over-exposure + doc conflict** |
| PUT | `/api/users` | change role/team | `authenticateRequest` | **admin only** | `userId`,`role` present; role allowlist (6 values) | **RPC `bulletproof_user_update` — undefined in the repo** | **BROKEN** |

---

## 3. API statistics

| Metric | Value |
| --- | --- |
| Route files | 58 |
| Exported handlers | 96 |
| Endpoints with **no authentication** | 7 (`media/upload`, `media/delete`, `public/upload/contact-file`, `discord-portal/webhooks/validate`, `public/stats`, `public/submit/contact`, `public/submit/application`) |
| Endpoints authenticating with a **static shared secret** | 13 (all `api/discord/*`) |
| Endpoints using the **service-role key** | 6 (4 of them unauthenticated) |
| Endpoints provably **broken** against the repo's own schema/RLS | 5 (`users` PUT, `profile/search` GET, `attendances` DELETE, `discord/tryout/{announce,invite,evaluate,status}`) |
| Endpoints with **mass assignment** on update | 1 confirmed (`discord-portal/webhooks` PUT), 2 unverified (`rosters` PUT, `teams/manage` PUT) |
| Endpoints with **rate limiting** | **0** |
| Endpoints with **pagination** | **0** using the shared helper; 1 with an uncapped `limit` |
| Endpoints with a **request schema** | **0** (no zod, no OpenAPI) |
| Endpoints with **idempotency protection** | **0** |
| Endpoints with **audit logging** | **0** |
| Endpoints issuing **raw DB error text** to clients | ≥ 10 |

---

## 4. API verdict for V2

| Verdict | Detail |
| --- | --- |
| **KEEP (contract shape)** | The resource naming (`/api/teams`, `/api/performances`, `/api/tryouts`) and the "role-scoped list" idea are sound starting points. |
| **REBUILD** | The entire API surface: a versioned, schema-validated, policy-guarded, tenant-scoped API with pagination everywhere, idempotency on writes, a uniform error contract, structured logging, and centralised rate limiting. |
| **REPLACE** | `authenticateRequest` with a request-scoped actor context; `corsHeaders` with an explicit origin allowlist; the Discord bot contract with signed, per-integration, identity-bearing requests; `checkRoleAccess` with a policy engine. |
| **REMOVE** | `/api/media/upload`, `/api/media/delete`, `/api/public/upload/contact-file` (as designed), `/api/auth/session` (redundant), the two debug pages' endpoints. |
| **MIGRATE (data)** | The `tryouts` family contract (a genuinely good state machine) and the slot-expense automation rule. |
