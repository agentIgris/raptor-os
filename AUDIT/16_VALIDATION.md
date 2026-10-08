# 16 — VALIDATION

**Audit.md section:** 22 (SECTION 19 — VALIDATION AUDIT)

---

## 1. Where validation exists

| Layer | Present? | Mechanism | Evidence |
| --- | --- | --- | --- |
| Frontend (client component) | **Partially, ad hoc** | `required` HTML attributes, `type="email"`/`type="url"`, manual `if (!x) setError(...)`, `type=number` `min`/`max` | e.g. `app/dashboard/discord-portal/webhooks/page.tsx:394` (`type="url" required`); `app/contact/page.tsx`; `app/apply/[tryoutId]/page.tsx` |
| Frontend schema library | **NO** | `zod` declared (`package.json:70`) and **never imported**; `react-hook-form` used only by the unused `components/ui/form.tsx`; `@hookform/resolvers` **never imported** | verified by grep |
| API route | **Yes, manual, per-handler** | `validateRequiredFields`, `isValidUuid`, `isValidDate`, hand-written numeric loops, ad-hoc `validKeys`/`validRoles` arrays | `lib/api-utils.ts:197-224`; ~20 call sites |
| Database | **Partially** | `CHECK` constraints on enums and a few numerics; `NOT NULL`; FKs; `UNIQUE` on 5 columns | `scripts/00:34, 43, 56, 72, 75, 86, 112, 120, 125, 191, 212, 246, 248, 253, 279, 317, 332` |
| Cross-field/business rules | **Scattered** | DB triggers and functions, plus application code | `automation-scripts/01:57-73` (`validate_coach_assignment`), `:76-102` (`validate_performance_entry`), `04:12-32` (`create_slot_expense`) |

**Audit.md §19 asks whether validation exists at each layer and warns never to rely solely on
frontend validation. The answer here is that the *only* meaningful layer is the database's
`CHECK` constraints — and 10 tables have no RLS and were written outside any validation path.**

---

## 2. Helper inventory

`lib/api-utils.ts` provides the entire validation toolkit:

| Helper | Line | Behaviour | Assessment |
| --- | --- | --- | --- |
| `validateRequiredFields(body, fields)` | 197-210 | checks `undefined \| null \| ''` | **Falsy check, not type-aware.** Rejects `0` and `false` as "missing" — a real bug for numeric fields; accepts `{}`, `[]`, `"abc"` |
| `isValidUuid(value)` | 213-217 | regex `^[0-9a-f]{8}-…-[89ab]…$` | Correct; requires a v4-variant nibble, so **rejects valid non-v4 UUIDs** (e.g. v7, or a UUID with a non-`[89ab]` variant such as some `gen_random_bytes`-derived ids). Applied to `teamId`, `playerId`, `id` in ~10 routes → potential false rejections. |
| `isValidDate(value)` | 220-224 | `new Date(value)` and `!isNaN` | **Exported but never used.** Would also accept `"2025-13-45"` (rolls over) |
| `getPaginationParams` | 227-237 | caps limit at 100 | **Exported but never used** |
| `checkRoleAccess(role, allowed)` | 184-186 | `allowed.includes(role)` | Correct but stringly-typed |
| `checkTeamAccess(userTeamId, targetTeamId, role)` | 189-194 | admin/manager bypass; else equality | Correct; **never used** (grep: definition only) |
| `corsHeaders` / `handleCors` | 240-255 | `OPTIONS` short-circuit | See F-API-16 |

---

## 3. Inconsistent schemas — the same field, different rules

| Field | Rule A | Rule B | Rule C |
| --- | --- | --- | --- |
| `role` | DB `CHECK` 7 values: `admin, manager, coach, analyst, player, pending_player, tryout` (`scripts/00:43`) | `ROLE_CONFIG` 9 keys incl. `pending`, `awaiting_approval` (`lib/role-system.ts:7-362`) | `PUT /api/users` allowlist 6 values, **omits `tryout`** (`app/api/users/route.ts:129`); `lib/dashboard-permissions` 7 values incl. `awaiting_approval` |
| `placement` | no DB `CHECK`; API requires it and rejects negatives (`app/api/performances:209-238`) | Type `number \| null` (`lib/supabase.ts:242`) | Analytics treat it as rank; OCR parses it as a bare integer |
| `kills`/`assists` | DB `DEFAULT 0`, **no `CHECK >= 0`** | API rejects negatives | OCR Pattern 3 can produce `"0"` or a non-numeric slice |
| `damage` | DB `double precision DEFAULT 0` | API `number >= 0` | `performance_records.damage` is **`integer`** — inconsistent types for the same concept |
| `survival_time` | `performances.survival_time double precision` | `performance_records.survival_time interval` | `bot_attendance.duration interval` | `attendances.session_time text` — **four representations of a duration/time** |
| `match_type` | not in the DB | API derives `match_number` from `match_type ∈ {tournament, practice}` (`:196, 206`) | UI sends either `match_type` or `match_number` (legacy support) |
| `slot` / `slot_id` | API accepts both (`:204, 278-279`) | DB has `slot` (no FK) **and** `slot_id` (FK) | Four scripts disagree — see `12_DATABASE_RELATIONSHIPS.md` F-REL-03 |
| `settingKey` | hardcoded 9-value allowlist (`app/api/discord-portal/settings:147-164`) | `AutomationKey` TS union (`modules/discord-portal/types.ts`) | DB `setting_key text` — **no CHECK constraint**, so a direct write bypasses the allowlist entirely |
| `agreement_version` | TS constant (`lib/agreement-versions.ts:6-13`) | `admin_config.agreement_version_*` rows | `user_agreements.agreement_version integer NOT NULL` — **three sources of truth, no FK** |
| `map` | `text NOT NULL`, no CHECK | API requires presence only | OCR produces whatever the screenshot contains |
| `timeframe` | `parseInt(searchParams.get('timeframe') \|\| '0')` — **no bound, no NaN check** | used in a `gte`/`lte` date range | a NaN produces an invalid query |
| `limit` | `parseInt(...)` with no cap in `profile/search` | cap 1000 in `performances` | no limit at all in `attendances`/`sessions`/`rosters` |

**Finding — `validateRequiredFields` treats `0` and `false` as missing.**
*Evidence:* `lib/api-utils.ts:201`
`if (body[field] === undefined || body[field] === null || body[field] === '')`.
*Impact:* any endpoint that requires a numeric field where `0` is legitimate will reject it.
Concretely, `POST /api/performances` requires `['map','kills','assists','damage','survival_time','placement']`
(`:209`) — but it maps missing numerics to `0` first (`:198-201`), so the check passes for
`0`; the *pattern* is nonetheless wrong and is applied directly to `attendances` POST, which
requires `['player_id','team_id','date','status']` (`:117`) — there `status` of `0` would be
rejected, which is correct, but the same helper applied to a future `bonus_amount` would be wrong.
*Severity:* **LOW** · *Confidence:* **HIGH**
*Recommendation:* replace with zod schemas; the "missing" concept should be `undefined`/`null`
only, and required-ness should be declared per field.

---

## 4. Missing validation — concrete gaps

| Gap | Evidence | Severity |
| --- | --- | --- |
| **No upper bound on `placement`** | `app/api/performances:209-238` | LOW |
| **No length limits on any text field** — `map`, `notes`, `additional_notes`, `highlights_links[]`, `sensitivity_settings`, `social_links`, `bio`, `address` | no `maxLength` in any route; `text` columns with no `CHECK (length(...))` | **MEDIUM** — unbounded user input stored in `text`/jsonb enables storage abuse and layout-breaking content |
| **No array-size limits** — `highlights_links text[]`, `availability text[]`, `target_roles text[]`, `team_ids uuid[]` | no limit in `app/api/discord/tryout/apply:120-141` or `SUPABASE_TRYOUTS_SETUP_FIXED.sql` | MEDIUM |
| **`ip_address inet` from a spoofable header** | `app/api/agreements:96-99` | LOW (integrity) |
| **File content never validated, only the declared MIME** | `app/api/media/upload:48`; `app/api/public/upload/contact-file:45`; `app/api/profile/avatar:70` | **HIGH** — see F-API-01 |
| **File extension taken from the user-supplied filename with no allowlist** | `app/api/profile/avatar:97` `file.name.split('.').pop()`; `app/api/media/upload:66` | MEDIUM |
| **`folder` (storage path prefix) unsanitised** | `app/api/media/upload:20, 68` | MEDIUM |
| **No validation that `slot_id`/`session_id` belong to the same team as `team_id`** | `app/api/performances:268-281`; `app/api/attendances:168-180` | **MEDIUM** — cross-team reference is possible at the application layer (FKs only check existence) |
| **No validation that a `player_id` belongs to `team_id`** | `app/api/attendances:168-180`; `app/api/performances:268-281` | **MEDIUM** — a coach can record a performance for a player on another team by supplying that player's id, because the API only checks `team_id === user.team_id`, never that `player_id` is on that team |
| **No validation that `date`/`start_time` are coherent** (end before start, cutoff inside the session) | `app/api/sessions:136-191`; the DB trigger `validate_performance_entry` checks slot existence but not time coherence | MEDIUM |
| **No validation of `hud_layout_code`, `bgmi_id`, `control_layout` semantics** beyond the two CHECK columns | `scripts/00:75, 73` | LOW |
| **Webhook `type` not validated on `PUT`** | `app/api/discord-portal/webhooks:241, 285` | **HIGH** (F-API-08) |
| **`action` string in `POST /api/admin/settings` is not allowlisted** — any unrecognised value falls through to the settings-upsert branch | `app/api/admin/settings:101, 132` | MEDIUM — an admin typo silently takes the other branch |

---

## 5. Database-level validation quality

**Good:**
* Enum-like columns use explicit `CHECK (col = ANY(ARRAY[…]))` rather than free text:
  `users.role`, `users.status`, `users.bgmi_tier`, `users.control_layout`, `users.profile_visibility`,
  `teams.status`, `performances` (none), `sessions.session_type`, `attendances.status`,
  `attendances.source`, `practice_session_config.session_subtype`,
  `slot_expenses.number_of_slots CHECK (> 0)`, `slot_expenses.slot_rate CHECK (>= 0)`,
  `tier_defaults.default_slot_rate CHECK (> 0)`, `winnings.position CHECK (> 0)`,
  `holidays.recurring_day CHECK (0..6)`, `discord_webhooks.type`,
  `communication_logs.status`, `user_agreements.role`, `user_agreements.status`,
  and every `tryout_*` enum. This is genuinely better than most projects at this scale.
* `slots.number_of_slots CHECK (> 0)`, `winnings.position CHECK (> 0)`.
* FKs are declared for 34 relationships.

**Bad / missing:**
* `teams.tier text DEFAULT 'T4'` — **no CHECK**, despite `tier_defaults.tier` being a 5-value
  `UNIQUE` set. A team can hold a tier with no rate card.
* `performances.kills/assists/damage/survival_time/placement` — **no CHECKs**.
* `performances.map text NOT NULL` — no reference table, no CHECK.
* `users.email text NOT NULL UNIQUE` — case-sensitive uniqueness (Postgres), so `A@x.com` and
  `a@x.com` can coexist while GoTrue treats them as the same account.
* `users.discord_id`, `users.bgmi_id` — no uniqueness.
* All money columns are `integer` with **no `CHECK (>= 0)`** on `slot_expenses.rate/total` and
  `winnings.amount_won`.
* Every `jsonb` column has **no `CHECK (jsonb_typeof(col) = 'object'|'array')`**:
  `users.sensitivity_settings`, `game_stats`, `achievements`, `social_links`,
  `prize_pools.breakdown`, `tryouts.additional_links`, `discord_servers.features`,
  `performance_records.metadata`, `bot_attendance.metadata`.
* `communication_settings.setting_key text NOT NULL` — no CHECK, no FK to a settings registry.
* `discord_webhooks.hook_url text NOT NULL` — no format CHECK (see F-API-05).
* **No domain-level invariants at all**: nothing prevents two `attendances` rows for the same
  player/session, two `tryout_evaluations` from the same evaluator, two `rosters` rows for the
  same member, or overselling a slot.

---

## 6. Verdict

| Question | Answer |
| --- | --- |
| Is there a validation layer? | **Ad hoc, per-handler, no shared schema.** |
| Is `zod` used? | **No** — declared and unused. This is the single highest-value, lowest-effort fix. |
| Is frontend validation relied upon for security? | **No** — every write goes through an API route that re-checks. *(This is a genuine strength.)* |
| Is the database a backstop? | **Only for enums.** Numeric ranges, formats, uniqueness and cross-field rules are absent, and 10 tables have no RLS so a direct PostgREST write bypasses the API entirely. |
| Are schemas consistent? | **No** — at least 11 fields have two or three conflicting definitions across DB, API and UI. |

**Recommendation for V2.**
1. One zod schema per resource, in a shared module, imported by both the route handler and the
   form; derive TypeScript types from it; generate an OpenAPI document from it.
2. `zod` schemas must be the **only** place field rules live; the API must not re-implement them.
3. Generate database types from the migration ledger and add a CI check that the committed types
   match, so schema drift becomes a build failure.
4. Add the missing `CHECK` constraints (money `>= 0`, `teams.tier` against `tier_defaults`,
   `jsonb_typeof`, `hook_url` format, `lower(email)` uniqueness) and the missing unique
   constraints listed in `15_DATABASE_QUALITY.md` §4.
5. Add cross-entity validation: a `player_id` must be a member of `team_id`; a `slot_id` must
   belong to `team_id`; `end_time > start_time`; `cutoff_time` within the session.
6. Add field length and array-size limits at both the schema and the column level.
