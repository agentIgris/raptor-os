# 13 — RLS / DATABASE SECURITY

**Audit.md section:** 19 (SECTION 16 — RLS / DATABASE SECURITY)
**Machine-readable:** `AUDIT/database/rls-policy-register.csv` (118 policy declarations).
**Audit.md Rule 6 applied:** *never assume RLS is correct because policies exist — analyse
policy behaviour.* Every policy below is analysed for intended access, actual access and
bypass.

---

## 1. The posture, stated by the repository itself

> `database/README.md:41-46`
> "For development, RLS is disabled. To disable RLS on users table:
> `ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;`
> **Note: Re-enable RLS for production with proper policies.**"
>
> `database/README.md:73-75`
> "### Row Level Security (RLS) — **Currently disabled for development** — Should be enabled
> for production"

> `README.md:202-208` (Security Features)
> "- **Row Level Security (RLS) on all database tables** … - **API route protection with
> middleware**"

These two statements are mutually contradictory. `README.md` is aspirational;
`database/README.md` describes what was actually done. Everything below should be read with
the assumption that **the application was developed and tested with no row-level enforcement**,
which is the root cause of nearly every broken-and-unguarded endpoint catalogued in
`10_AUTHORIZATION.md`.

---

## 2. RLS enablement matrix

| Table | RLS enabled | Enabling script(s) | Policies declared | Effective protection |
| --- | --- | --- | --- | --- |
| `users` | ✅ | `scripts/00:474`, `scripts/01` | 8 | **BROKEN — self-recursive policy** (F-RLS-01) |
| `teams` | ✅ | `scripts/00:475`, `scripts/01` | 7 | conflicting sets; `scripts/15` drops one |
| `performances` | ✅ | `scripts/00:477`, `scripts/01` | 10 | mostly sound, but players can delete own rows |
| `attendances` | ✅ | `scripts/00:479`, `scripts/11` | 7 | sound |
| `sessions` | ✅ | `scripts/00:480`, `session-attendance-schema.sql` | 4 | sound |
| `user_agreements` | ✅ | `scripts/00:481`, `AGREEMENT_ENFORCEMENT_SETUP` | 5 | sound but three competing sets |
| `profiles` | ✅ | `scripts/00:476` | 1 | `FOR ALL USING (auth.uid() = user_id)` — acceptable |
| `rosters` | ✅ | `scripts/04:108-139`, `scripts/13:179-212` | 6 | **CONFLICT — widened to players** (F-RLS-06) |
| `slots` | ✅ | `scripts/00:478`, `scripts/16` | 5 | sound |
| `slot_expenses` | ✅ | `scripts/04:179-210`, `scripts/13:214-231` | 5 | **CONFLICT — players can read** (F-RLS-07) |
| `winnings` | ✅ | `scripts/04:253-288`, `scripts/13:233-250` | 5 | **CONFLICT — players can read** |
| `prize_pools` | ✅ | `scripts/04:212-250` | 3 | **players can read** |
| `tier_defaults` | ✅ | `scripts/06:59-80`, `scripts/10:24-40`, `scripts/13:252-256` | 6 | duplicate policy names ⇒ second `CREATE POLICY` fails |
| `holidays` | ✅ | `session-attendance-schema.sql:77` | 2 | "Everyone can view" — intentional |
| `team_monthly_stats` | ✅ | `scripts/14:38-56` | 2 | sound |
| `discord_webhooks` | ✅ | `complete-discord-portal-setup.sql:87` | 3 | **CRITICAL — global rows readable by `public`** (F-RLS-02) |
| `communication_logs` | ✅ | `complete-discord-portal-setup.sql:88` | 3 | **INSERT is `WITH CHECK (true)` for `public`** (F-RLS-03) |
| `communication_settings` | ✅ | `complete-discord-portal-setup.sql:89` | 3 | no INSERT policy ⇒ coach upsert fails; global rows readable |
| `discord_servers` | ✅ | `scripts/00:630` | 2 | sound |
| `discord_users` | ✅ | `scripts/00:631` | 2 | sound |
| `performance_records` | ✅ | `scripts/00:632` | 2 | sound |
| `bot_attendance` | ✅ | `scripts/00:633` | 2 | sound |
| `tryouts` | ✅ | `SUPABASE_TRYOUTS_SETUP_FIXED:205` | 2 | intentional public read of active tryouts |
| `tryout_applications` | ✅ | `:206` | 2 | **no SELECT policy for the applicant** (F-RLS-08) |
| `tryout_invitations` | ✅ | `:207` | 1 | staff-only — so the Discord invite path cannot work |
| `tryout_sessions` | ✅ | `:208` | 1 | staff-only |
| `tryout_evaluations` | ✅ | `:209` | 1 | evaluator-self or admin/manager — so the Discord evaluate path cannot work |
| `tryout_selections` | ✅ | `:210` | 1 | staff-only |
| **`admin_config`** | ❌ **NONE** | — | 0 | **NO PROTECTION — CRITICAL** (F-RLS-04) |
| **`module_permissions`** | ❌ **NONE** | — | 0 | no protection (dead feature, low impact) |
| **`practice_session_config`** | ❌ **NONE** | — | 0 | **NO PROTECTION** (F-RLS-05) |
| **`attendance_debug_log`** | ❌ **NONE** | — | 0 | debug artefact left in schema |
| `storage.objects` | ✅ (Supabase default) | `automation-scripts/08` | 17 | **CRITICAL — `TO public` SELECT/INSERT/DELETE on `contact_files`** (F-RLS-09) |

**Summary: 14 of 32 tables (44 %) have no RLS. 118 policy declarations target 30 tables, with
5 duplicate policy names that will make a second `CREATE POLICY` fail.**

---

## 3. Policy-by-policy analysis

### F-RLS-01 — CRITICAL: the `users` policies are self-referential and will fail with `42P17 infinite recursion detected in policy for relation "users"`

*Policies:*
```sql
-- scripts/00-complete-schema-setup.sql:488
CREATE POLICY "Users can view own profile" ON public.users
  FOR SELECT USING (auth.uid() = id);

-- scripts/00-complete-schema-setup.sql:491
CREATE POLICY "Admins can view all users" ON public.users
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
  );
```
*Intended access:* a user sees their own row; an admin sees all rows.
*Actual access:* **PostgreSQL expands policies on `users` when compiling the second policy, sees
that it references `users`, and raises `infinite recursion detected in policy for relation
"users"` (SQLSTATE 42P17).** In practice:
* `SELECT … FROM users WHERE id = auth.uid()` succeeds — the primary-key qual satisfies the
  first policy and PostgreSQL short-circuits the `OR`, so the recursive branch is never
  evaluated for that single row.
* `SELECT … FROM users` (no `id` filter) — which is exactly what `GET /api/users` does at
  `app/api/users/route.ts:41-44` — must evaluate the second policy and **errors**.
* Every other policy in the schema that authorises by role uses the same pattern
  (`EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = …)`) — 20+ policies
  across `performances`, `teams`, `rosters`, `slot_expenses`, `winnings`, `prize_pools`,
  `tryouts`, `tryout_*`, `discord_*`, `performance_records`, `bot_attendance`,
  `user_agreements`. Each inherits the same fragility.
*Impact:* (a) admin listing of users is broken; (b) a whole class of policies may error at
runtime depending on plan shape; (c) the correct pattern (`(select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'`, or a `SECURITY DEFINER` helper, or a `profiles`-style JWT claim) is never used.
*Exploitability:* fail-closed where it errors, so this is primarily an availability and
correctness defect — **but** it means the security posture was never validated, and any
environment where the planner chooses a different plan (e.g. after a schema change, a
`SECURITY DEFINER` function, or a different Postgres version) can change the outcome.
*Affected scope:* all authenticated reads that are not self-scoped.
*Severity:* **CRITICAL** · *Confidence:* **MEDIUM-HIGH** (this is the documented, extremely
common Supabase failure mode; exact behaviour depends on the deployed Postgres version and
query plan)
*Recommended remediation:* move the role claim into the JWT (`raw_app_meta_data.role` set by a
trigger on `auth.users`) and write policies as
`((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')`, or wrap the lookup in a
`SECURITY DEFINER STABLE` function marked `SET search_path = ''`. Never reference the
protected table inside its own policy.

### F-RLS-02 — CRITICAL: unauthenticated read of Discord webhook credentials

*Policy:*
```sql
-- database/complete-discord-portal-setup.sql:93
CREATE POLICY "Team members can view team webhooks" ON public.discord_webhooks
  FOR SELECT USING (
    team_id IS NULL OR EXISTS (
      SELECT 1 FROM public.users WHERE id = auth.uid()
      AND (role IN ('admin','manager') OR team_id = discord_webhooks.team_id)
    )
  );
```
*Intended access:* team members see their own team's webhooks; admins/managers see all.
*Actual access:*
1. `team_id IS NULL` is an **unconditional** branch. Rows with `team_id IS NULL` are exactly
   the `type IN ('admin','global')` webhooks (`scripts/00:296-309`; `type` is independent of
   `team_id`).
2. The policy has **no `TO` clause**, so it applies to `PUBLIC` — including the `anon` role.
3. `SELECT` includes `hook_url` (the API returns `.select('*, teams:team_id(name)')` at
   `app/api/discord-portal/webhooks/route.ts:78, 86, 104, 114`).
*Exploitability:* trivial. The Supabase **anon key is public by design** — it is compiled into
the client bundle via `NEXT_PUBLIC_SUPABASE_ANON_KEY` and is visible in any page's JavaScript.
An anonymous caller performs
`GET {SUPABASE_URL}/rest/v1/discord_webhooks?team_id=is.null` with the `apikey` header and
receives every org-wide webhook URL.
*Impact:* a Discord webhook URL is a **write credential** for that channel. Disclosure allows
an unauthenticated attacker to post arbitrary messages, including with a spoofed
`username`/`avatar_url`, into the organisation's operational Discord channels — enabling
phishing of players and staff, injection of fake attendance/performance announcements, and
 reputational damage. `app/dashboard/discord-portal/webhooks/page.tsx:490` even opens the URL
in a browser tab, confirming the value is treated as user-visible.
*Affected scope:* every `admin`/`global` Discord webhook; by extension the integrity of all
Discord-based organisational communication.
*Severity:* **CRITICAL** · *Confidence:* **HIGH** for the policy semantics; **MEDIUM** for
end-to-end exploitability pending verification of the deployed grants (if `anon` lacks table
`SELECT` on `discord_webhooks`, PostgREST returns a permission error — but the policy
explicitly grants it, and `complete-discord-portal-setup.sql:377` additionally issues
`GRANT SELECT, INSERT, UPDATE, DELETE ON public.discord_webhooks TO authenticated`, so the
grant side is present).
*Recommended remediation:* (1) never store a webhook URL in a client-readable table — store an
opaque reference and resolve the URL server-side only; (2) encrypt at rest with a KMS-managed
key; (3) rewrite the policy with an explicit `TO authenticated` and no `team_id IS NULL`
short-circuit; (4) `REVOKE SELECT (hook_url) ON public.discord_webhooks FROM authenticated, anon`;
(5) rotate every webhook URL currently stored, because they must be assumed compromised.

### F-RLS-03 — HIGH: anyone can forge the Discord communication log

*Policy:*
```sql
-- database/complete-discord-portal-setup.sql:147
CREATE POLICY "System can insert logs" ON public.communication_logs
  FOR INSERT WITH CHECK (true); -- Allow system inserts from API
```
*Intended access:* only the application may log outbound Discord deliveries.
*Actual access:* `WITH CHECK (true)` with no `TO` role ⇒ **any role, including `anon`, may
insert arbitrary rows** with any `message_type`, `status`, `payload`, `response_code`,
`triggered_by` and `timestamp`.
*Impact:* (a) the only record of outbound organisational communications is untrustworthy — it
has zero evidentiary value in a dispute with a sponsor, a player or a regulator; (b) log
injection: forged rows can be crafted to look like successful deliveries of messages that were
never sent, or to attribute a message to another user (`triggered_by`); (c) storage exhaustion
/ log flooding. This directly undermines the "proof of delivery" requirement that any
sponsor-deliverables or compliance reporting feature would need.
*Severity:* **HIGH** · *Confidence:* **HIGH**
*Recommended remediation:* revoke `INSERT` from `anon` and `authenticated`; insert only from a
`SECURITY DEFINER` function owned by the service role with a server-generated
`occurred_at`, `actor` and `correlation_id`; make the log append-only for the application role.

### F-RLS-04 — CRITICAL: `admin_config` has no RLS — anyone can rewrite the organisation's legal agreements and configuration

*Evidence:* `scripts/00-complete-schema-setup.sql:474-481` enables RLS on `users`, `teams`,
`profiles`, `performances`, `slots`, `attendances`, `sessions`, `user_agreements` — **not on
`admin_config`** (created at `:12-16`). No other script enables it either.
*Contents of `admin_config` (seeded at `scripts/00:552-559`, extended at
`database/AGREEMENT_ENFORCEMENT_SETUP.sql`): `app_version`, `maintenance_mode`,
`agreement_version_player|coach|manager|analyst`, `agreement_content_player|coach|manager|analyst`
(the **full legal text shown to and accepted by every player, coach, manager and analyst**),
`agreement_enforcement_enabled`, `agreement_dev_override`, `default_public_webhook_id`.
*Intended access:* admin only, via `app/api/admin/settings` (which correctly checks
`user.role === 'admin'` and then uses the service role).
*Actual access:* because RLS is off, the table is subject only to table-level `GRANT`s.
Supabase grants `anon` and `authenticated` `SELECT, INSERT, UPDATE, DELETE` on tables in
`public` by default via `ALTER DEFAULT PRIVILEGES`. An anonymous caller with the public anon
key can therefore:
* **READ** all agreement text and every configuration value;
* **UPSERT** `agreement_content_player` with arbitrary text, which
  `app/api/agreements/content/route.ts` and `app/agreement-review/page.tsx` then present to
  users as the terms they must accept;
* **SET** `agreement_enforcement_enabled` to anything, which
  `automation-scripts/04:157-172` reads to decide whether to bypass the agreement gate
  entirely (`IF NOT COALESCE(enforcement_enabled,false) … RETURN requires_agreement:false`);
* **SET** `maintenance_mode`;
* **REPOINT** `default_public_webhook_id`, which `app/api/public/submit/contact:48-62` then
  resolves (with the service role) into a webhook URL and posts attacker-supplied content to.
*Exploitability:* trivial, same as F-RLS-02.
*Impact:* falsification of the terms presented to players and staff; defeat of the legal
compliance gate; repointing of the public intake channel; defacement of application
configuration. In a SaaS context this is a **cross-tenant** risk the moment more than one
organisation shares the database.
*Severity:* **CRITICAL** · *Confidence:* **HIGH**
*Recommended remediation:* enable RLS with admin-only policies; move all legal documents out of
a key/value table into versioned, immutable, hashed `documents` rows; make the enforcement flag
a deploy-time constant, not a mutable row; rotate the Discord webhook referenced by
`default_public_webhook_id`.

### F-RLS-05 — HIGH: `practice_session_config` has no RLS
*Evidence:* created at `scripts/00:276-290`; never in any `ENABLE ROW LEVEL SECURITY` list.
*Impact:* the table holds each team's recurring practice windows and **cutoff times**, which
are the operational rules used to auto-mark absences. Anonymous read/write means an attacker
can (a) read every team's internal schedule, and (b) **change the cutoff time**, which directly
alters who is auto-marked absent — i.e. it is a write path into the attendance record.
*Severity:* **HIGH** · *Confidence:* **HIGH**
*Recommended remediation:* enable RLS with team-scoped staff policies; treat schedule changes as
audited events.

### F-RLS-06 — MEDIUM: two competing `rosters` policy sets widen player visibility
*Evidence:*
* `scripts/04-create-team-management-tables.sql:136` — `"Players can view their own roster entry" FOR SELECT USING (user_id = auth.uid())`
* `scripts/13-comprehensive-database-fixes.sql:203` — `"Players can view team rosters" FOR SELECT USING (…)` (team-scoped)
Policies are OR-combined per operation, so **both are active** and a player can read every
roster row for their team, including `contact_number` and `device_info`
(`scripts/00:351, 353`).
*Also:* `scripts/04:108` `"Admins and Managers can manage rosters"` and
`scripts/13:185` `"Admins and managers can manage all rosters"` are two `FOR ALL` grants for the
same scope, doubling the surface.
*Impact:* phone numbers and device details of all teammates are exposed to every player;
`README.md` characterises player access as "view only their own data".
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommended remediation:* one policy per operation; players get no roster SELECT at all
(roster data belongs to staff); move `contact_number`/`device_info` off the roster row.

### F-RLS-07 — HIGH: players and all team members can read team finances
*Evidence (all simultaneously active):*
* `scripts/04:202` `"Players can view their team's slot expenses" FOR SELECT`
* `scripts/04:242` `"Players can view their team's winnings" FOR SELECT`
* `scripts/04:281` `"Players can view their team's prize pools" FOR SELECT`
* `scripts/13:223` `"Team members can view team expenses" FOR SELECT`
* `scripts/13:242` `"Team members can view team winnings" FOR SELECT`
*Intended access:* `lib/role-system.ts:208-213` gives every non-admin/manager role
`viewAllFinances: false`; `lib/dashboard-permissions.ts:75` restricts the finance module to
`['admin','manager']`; `API_DOCUMENTATION.md:388` says `GET /api/expenses` → coach ❌,
analyst ❌, player ❌.
*Actual access:* **every authenticated team member can `SELECT` from `slot_expenses`,
`winnings` and `prize_pools`** for their team, with the public anon key. The UI hides the page;
the database does not.
*Impact:* budget and prize-money disclosure to the player roster — a genuine commercial
sensitivity in esports, and a likely source of internal disputes. It also means the documented
permission model and the enforced model disagree, which is a compliance problem in itself.
*Severity:* **HIGH** · *Confidence:* **HIGH**
*Recommended remediation:* delete the player/team-member financial policies; enforce
"financial data is org-scoped, never team-scoped" as a platform invariant.

### F-RLS-08 — MEDIUM: an applicant cannot read their own application
*Evidence:* `tryout_applications` has exactly two policies —
`"Anyone can create applications" FOR INSERT WITH CHECK (…)`
(`database/SUPABASE_TRYOUTS_SETUP_FIXED.sql:230-238`) and
`"Staff can manage applications" FOR ALL USING (EXISTS(… role IN ('admin','manager','coach','analyst')))`
(`:240-247`). There is **no SELECT policy for the applicant**.
*Impact:* `GET /api/discord/tryout/status` (`app/api/discord/tryout/status/route.ts:34-45`) and
any applicant-facing status page can never return the applicant's own data. Candidates cannot
see where they are in the pipeline; support load increases; and the Discord bot's `/tryout
status` command is permanently empty.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommended remediation:* add a self-scoped SELECT policy keyed on a hashed application
reference token, not on `discord_id` (which the applicant controls and which is trivially
spoofable by anyone who learns another applicant's Discord ID).

### F-RLS-09 — CRITICAL: `contact_files` is world-readable and world-deletable
*Policies:*
```sql
-- automation-scripts/08-storage-bucket-setup.sql:125
CREATE POLICY "Public can upload contact files" ON storage.objects
  FOR INSERT TO public WITH CHECK (bucket_id = 'contact_files');
-- :131
CREATE POLICY "Public can view contact files" ON storage.objects
  FOR SELECT TO public USING (bucket_id = 'contact_files');
-- :137
CREATE POLICY "Public can delete contact files" ON storage.objects
  FOR DELETE TO public USING (bucket_id = 'contact_files');
```
*Intended access:* anonymous visitors may attach a file to a contact/enquiry form; staff read
them.
*Actual access:* the bucket is created `public: false` (private) at `:40-47`, but in Supabase
Storage a private bucket still serves reads through the Storage API **governed by
`storage.objects` RLS**. A policy `FOR SELECT TO public USING (bucket_id='contact_files')`
therefore makes **every object in that bucket listable and downloadable by anyone
unauthenticated**, and `FOR DELETE TO public` makes every object **deletable by anyone**.
*Impact:* contact/enquiry attachments — which for a brand-collaboration enquiry may include
rate cards, signed NDAs, company registration documents, or identity documents — become
publicly downloadable and publicly destroyable by guessing or enumerating object keys
(Supabase object keys for this route are `contact-<timestamp>-<uuid>.<ext>`, and the
`list` endpoint is enabled by the SELECT policy, so **enumeration is trivial**). This is both a
confidentiality breach and an integrity/availability problem.
*Exploitability:* trivial — `GET {SUPABASE_URL}/storage/v1/object/list/contact_files` with the
anon key returns the full object list.
*Severity:* **CRITICAL** · *Confidence:* **HIGH**
*Recommended remediation:* delete the `TO public` SELECT and DELETE policies; serve
enquiry attachments only through short-lived signed URLs issued to an authenticated staff
member; store them under per-organisation prefixes; add rate limiting and a malware scan on
upload; assume anything already uploaded has been exposed and rotate/notify as required.

### F-RLS-10 — MEDIUM: `storage.objects` avatar/media policies trust the first path segment
*Policies:*
```sql
-- automation-scripts/08-storage-bucket-setup.sql:83
CREATE POLICY "Users can update their own avatars" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id='avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
```
*Actual access:* the ownership check is `first_path_segment == auth.uid()`. For avatars the
application writes `avatars/{targetUserId}-{timestamp}.{ext}`
(`app/api/profile/avatar:98-99`), so the **first path segment is `{targetUserId}-{timestamp}`,
not the uid** — the equality never matches, so the policy is inert. Meanwhile the application
performs the upload with the **service-role key**, which bypasses `storage.objects` RLS
entirely, so the policy is bypassed anyway. Net effect: the storage policies for `avatars`
provide **no protection at all**; the only real control is the API's own check
(`app/api/profile/avatar:87`), which allows `admin`/`manager` to write any user's avatar.
For `media`, `app/api/media/upload` writes `${folder}/${uuid}.${ext}` with `folder`
attacker-controlled and the service role, and `app/api/media/delete` deletes **any** path with
the service role and **no authentication**.
*Severity:* **MEDIUM** for avatars (inert but bypassed), **CRITICAL** for media (see
`15_API_SECURITY.md`)
*Recommended remediation:* align object keys with the policy (`{uid}/avatar.{ext}`); never use
the service role for user-initiated uploads; delete the unauthenticated media endpoints.

### F-RLS-11 — MEDIUM: the `tryout_stats` view bypasses RLS and double-counts
*Evidence:* `database/SUPABASE_TRYOUTS_SETUP_FIXED.sql:561-579`.
*Issue 1 — RLS bypass:* the view is created without `security_invoker = true`, so it runs with
the view owner's privileges and ignores RLS on all six underlying tables. Anyone who can
`SELECT` it sees aggregate counts for **every** tryout, including `draft` and
`open_to_public = false` campaigns.
*Issue 2 — correctness:* the query is a six-way `LEFT JOIN` on the same `tryouts.id` followed by
`GROUP BY t.id`. With *a* applications and *i* invitations, *s* sessions, *e* evaluations and
*k* selections, each application row is repeated `i × s × e × k` times, so every `COUNT` is
multiplied. `total_applications` is wrong whenever more than one child table has rows.
*Issue 3 — no index support:* the view aggregates on every read.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommended remediation:* `CREATE VIEW … WITH (security_invoker = true)`; pre-aggregate each
child in a CTE before joining; or replace with a maintained summary table updated by trigger.

### F-RLS-12 — MEDIUM: `communication_settings` cannot be inserted by a coach, and global rows are world-readable
*Evidence:*
* `complete-discord-portal-setup.sql:152-159` `"Team members can view team settings" FOR SELECT USING (team_id IS NULL OR EXISTS(…))` — the `team_id IS NULL` branch plus no `TO` clause ⇒ anyone can read global automation settings.
* `:162-169` `"Admins can manage all settings" FOR ALL USING (role IN ('admin','manager'))` — `FOR ALL` with only `USING`; PostgreSQL reuses `USING` as `WITH CHECK`, so an admin/manager upsert works.
* `:172-180` `"Coaches can manage team settings" FOR UPDATE USING (…)` — **UPDATE only.**
*Impact:* `PUT /api/discord-portal/settings` performs `upsert(..., { onConflict: 'team_id,setting_key' })`
(`app/api/discord-portal/settings/route.ts:203-211`). For a coach inserting a **new** key for
their team, the INSERT branch matches no policy ⇒ the request fails with an RLS error. Coaches
can toggle existing settings but cannot create new ones. Additionally, `UNIQUE (team_id, setting_key)`
does not constrain `NULL` team_id in Postgres, so duplicate global rows are possible, and the
`onConflict` upsert cannot match a `NULL` key.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommended remediation:* use a sentinel organisation id instead of `NULL` for global scope, or
partial unique indexes (`UNIQUE (setting_key) WHERE team_id IS NULL`); add the missing INSERT
policy or route all writes through a `SECURITY DEFINER` function.

### F-RLS-13 — MEDIUM: duplicate policy names make a second `CREATE POLICY` fail
*Evidence (from `rls-policy-register.csv`):*
* `"Admins and Managers can manage tier defaults"` and `"All authenticated users can view tier defaults"` each appear in **both** `scripts/06-update-slot-expense-logic.sql` and `scripts/10-add-missing-tier-defaults.sql`.
* `"Users can view own profile"` and `"Admins can view all users"` on `users` appear in **both** `scripts/00-complete-schema-setup.sql` and `scripts/01-create-tables.sql`.
* `"Authenticated users can upload OCR files"`, `"Users can view their own OCR uploads"`, `"Users can delete their own OCR uploads"` on `storage.objects` appear in **both** `automation-scripts/08-storage-bucket-setup.sql` and `scripts/13-comprehensive-database-fixes.sql`.
*Impact:* `CREATE POLICY` (without `OR REPLACE`) raises `42710 duplicate_object` on the second
run. Since the scripts are run manually in the Supabase SQL editor, an operator will hit an
error mid-script and may stop, leaving the schema in a **partially applied, order-dependent
state** — which is very likely how the current inconsistencies arose.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommended remediation:* one migration ledger, `CREATE OR REPLACE POLICY` (PG 9.5+) or
`DROP POLICY IF EXISTS` before every `CREATE POLICY`, and a CI test that replays migrations
against a scratch database.

### F-RLS-14 — MEDIUM: tables are created without a schema qualifier in half the scripts
*Evidence:* `scripts/01-create-tables.sql` uses `CREATE TABLE users`, `CREATE POLICY … ON users`;
`automation-scripts/01` and others use `public.`-qualified names; `scripts/01` even writes
`DROP POLICY IF EXISTS "Staff can insert performances" ON public.performances` while creating
`ON performances`.
*Impact:* objects land in whatever `search_path` resolves to. Supabase's default is
`public, extensions`, so this usually works — but a project with a different `search_path`
silently creates a second, unprotected copy of the table. Policies then attach to the wrong
object.
*Severity:* **MEDIUM** · *Confidence:* **MEDIUM**
*Recommended remediation:* always schema-qualify; set `search_path` explicitly in
`SECURITY DEFINER` functions (`SET search_path = ''` plus fully-qualified references).

### F-RLS-15 — HIGH: ~25 `SECURITY DEFINER` functions are never revoked from `anon`
*Evidence:* 40 `SECURITY DEFINER` declarations; 30 `GRANT EXECUTE … TO authenticated`
statements; **0 `REVOKE` statements in the repository** (verified: `rg "REVOKE" -g "*.sql"`).
*Actual access:* Supabase's default privileges grant `EXECUTE` on functions in the `public`
schema to `anon`, `authenticated` and `service_role`. Because the repository only ever
*grants to `authenticated`* and never *revokes from `anon`*, every one of these functions is
reachable by an **unauthenticated** caller through PostgREST `/rest/v1/rpc/<function>`, and each
executes with the **owner's** privileges, i.e. **RLS is bypassed**.
*Concrete unauthenticated capabilities:*
| Function | What an anonymous caller gets |
| --- | --- |
| `get_team_webhook(team_id)` | **The Discord webhook URL** for any team (`complete-discord-portal-setup.sql:187-213`) — the same credential disclosure as F-RLS-02, via a different path |
| `get_player_stats(player_uuid)` | Any player's aggregated kills/damage/survival/placement (`automation-scripts/01:130-149`) — horizontal data disclosure across the whole user table |
| `get_team_performance_summary(team_uuid)` | Any team's totals **including `total_winnings`** (`:109-127`) — financial + competitive disclosure |
| `can_view_profile(viewer, target)` / `can_edit_profile(editor, target)` | An authorization oracle; because identity is a **parameter**, a caller can enumerate every user's `role` and `team_id` by probing the boolean result (`automation-scripts/04:60-140`) |
| `check_user_agreement_status(user_id, role, version)` | Any user's agreement status (`:147-241`) |
| `create_slot_expense()` / `create_auto_attendance*()` / `generate_daily_practice_sessions(date)` / `auto_mark_absent_after_cutoff()` / `log_discord_message(...)` | **Write** access: manufacture expenses, manufacture or flip attendance records, create sessions, forge logs |
| `cleanup_old_discord_logs(days)` | **Delete** the entire Discord log |
| `sync_tryout_to_profile()` | Trigger-only, but `SECURITY DEFINER` and it writes to `users` |
*Impact:* this is a complete bypass of the application's entire authorisation model, reachable
without any credential, contingent only on Supabase's default function privileges not having
been revoked out-of-band.
*Severity:* **CRITICAL** · *Confidence:* **MEDIUM-HIGH** (the *code* is unambiguous and the
absence of `REVOKE` is verified; whether the deployed project has default privileges intact
cannot be confirmed without database access — Supabase's documented default **is** to grant
`EXECUTE` to `anon`)
*Recommended remediation:* for every function, `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon;`
then `GRANT EXECUTE … TO authenticated` (or to `service_role` only, for internal functions);
add `SET search_path = ''` to every `SECURITY DEFINER` function; move role checks inside the
functions using `auth.uid()` (never a parameter); add a CI test that asserts no `anon`-executable
function exists.

---

## 4. Service-role bypass surface

`SUPABASE_SERVICE_ROLE_KEY` bypasses RLS entirely. It is used in **6 routes**:

| Route | Service-role use | Authentication | Justified? |
| --- | --- | --- | --- |
| `app/api/admin/settings/route.ts` | `admin_config` read/write; **bulk purge of 7 tables + users** | admin via `authenticateRequest` | Read/write: yes. **Bulk purge: no — see F-API-06** |
| `app/api/discord-portal/settings/default-webhook/route.ts` | `admin_config` | admin via user-bound client | Acceptable |
| `app/api/profile/avatar/route.ts` | Storage upload/delete (bypasses `storage.objects` policies) | self or admin/manager | **No** — should use a user-bound storage client so the storage policies apply |
| `app/api/media/upload/route.ts` | Storage upload **+ `createBucket`** | **NONE** | **NO — CRITICAL** |
| `app/api/media/delete/route.ts` | Storage delete, arbitrary path | **NONE** | **NO — CRITICAL** |
| `app/api/public/upload/contact-file/route.ts` | Storage upload **+ `createBucket`** | **NONE** | **NO — CRITICAL** |
| `app/api/public/submit/contact/route.ts` | Fallback: resolve `default_public_webhook_id` → `hook_url` | **NONE** | **NO** — an unauthenticated request can therefore reach a webhook URL through the service role |

`.env.example:5` documents `SUPABASE_SERVICE_ROLE_KEY`; `next.config.mjs` does not prevent it
from being bundled, but it is correctly referenced only via non-`NEXT_PUBLIC_` names — **except**
that `app/api/media/upload/route.ts:5` and `app/api/public/upload/contact-file/route.ts:5` fall
back to `NEXT_PUBLIC_SUPABASE_ANON_KEY` when the service key is absent, which converts a
fail-closed configuration into a silently degraded one.

---

## 5. Overall RLS verdict

| Question (Audit.md §19) | Answer |
| --- | --- |
| Are tenants isolated? | **There are no tenants.** No `organization_id` exists on any table. Every organisation's data would share one namespace. |
| Are the policies correct? | **No.** 118 declarations, 5 duplicate names, 6 mutually inconsistent policy sets, at least 6 concrete defects (F-RLS-01 … F-RLS-14) and 1 systemic one (F-RLS-15). |
| Are there missing policies? | **Yes** — on `tryout_applications` (applicant self-read), `communication_settings` (INSERT), `users` (self-INSERT, self-UPDATE), and on **14 tables entirely**. |
| Are there overly broad policies? | **Yes** — `team_id IS NULL` branches in `discord_webhooks`, `communication_logs` and `communication_settings`; player/team-member financial read policies; `WITH CHECK (true)` on `communication_logs`. |
| Are there policy conflicts? | **Yes** — `rosters`, `slot_expenses`, `winnings`, `teams`, `performances`, `tier_defaults`, `user_agreements` all have overlapping, contradictory definitions across files, OR-combined by Postgres. |
| Is there a service-role bypass? | **Yes** — 6 routes, 4 unauthenticated. |
| Is tenant isolation possible today? | **No.** It requires `organization_id` on every table plus a non-spoofable claim in the JWT/session. See `60_MULTITENANCY.md`. |

**Single most important RLS conclusion:** the policies in this repository are a *record of
intent*, not an enforced boundary. They were written incrementally by an AI agent over one
month, were never reconciled, were never integration-tested, and — per the repository's own
documentation — were **not even enabled** during development. They must be treated as
requirements documentation for V2, not as a security control to be preserved.
