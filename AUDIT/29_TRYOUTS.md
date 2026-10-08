# 29 — TRYOUTS
**Audit.md section:** 36 (SECTION 33 — TRYOUT DOMAIN)

## 1. Verdict up front
**The tryout module is the best-engineered domain in the repository and the most valuable
migration asset.** Its schema is well designed; its plumbing is largely broken; its product
design stops short of an offer or a contract.

## 2. The state machine

```
        ┌──────────────┐
        │  (tryout)    │  status: draft → active → closed → completed | archived
        │  purpose:    │  mode: player | team
        │  new_team /  │  type: scrim | tournament | practice | meeting
        │  existing_   │  evaluation_method: manual | automated | mixed
        │  team /      │  open_to_public: bool
        │  role_based  │  application_deadline
        └──────┬───────┘
               │ 1:N
   ┌───────────▼────────────┐   status: applied → screened → shortlisted → rejected | withdrawn
   │  tryout_applications   │   phase:   applied → screened → invited → evaluated → selected | rejected
   │  full_name, ign,       │   intake:  web (/apply/[tryoutId])  |  Discord bot (/api/discord/tryout/apply)
   │  discord_tag, role,    │   also:    ip_address, user_agent, application_source
   │  availability[],       │
   │  highlights_links[],   │
   │  contact_email/phone,  │
   │  screening_notes,      │
   │  screened_by/at        │
   └───────────┬────────────┘
               │ 1:1 (invite)
   ┌───────────▼────────────┐   status: invited → accepted | declined | expired
   │  tryout_invitations    │   temporary_access_granted, access_expires_at, temp_user_id
   └───────────┬────────────┘
               │ 1:N
   ┌───────────▼────────────┐   status: scheduled → in_progress → completed | cancelled | no_show
   │   tryout_sessions      │   session_type CHECK(5), evaluation_goals, attendance_status CHECK(4)
   │   (+ optional link to  │
   │    the `sessions` table│
   └───────────┬────────────┘
               │ 1:N
   ┌───────────▼────────────┐   objective: kills, assists, damage, survival_time, placement
   │  tryout_evaluations    │   subjective: game_sense / utility / rotations / communication  (each CHECK 1..10)
   │  evaluator_id,         │   overall_score (computed in app code), recommendation CHECK(5),
   │  is_final,             │   strengths, areas_for_improvement, evaluation_notes
   │  evaluation_date       │
   └───────────┬────────────┘
               │ (no FK — logical link only)
   ┌───────────▼────────────┐   selection_status CHECK(4): selected | rejected | extended | pending
   │   tryout_selections    │   assigned_team_id, assigned_role, player_type CHECK(3),
   │                        │   rejection_reason, feedback_message,
   │                        │   new_team_name, new_team_tier,
   │                        │   notification_sent, discord_notified  ← NEVER WRITTEN
   └────────────────────────┘
```

## 3. Missing transitions (Audit.md §33 asks explicitly)

| Stage | Present? | Evidence of the gap |
| --- | --- | --- |
| Application | **Yes** | `tryout_applications` + 2 intake channels |
| Screening | **Yes** (state only) | `status='screened'`, `screening_notes`, `screened_by/at`; **no API route** — the `/api/tryouts` route does not expose screening |
| Invitation | **Yes** (state + Discord route) | `tryout_invitations`; the Discord invite route is **broken** (`22_DISCORD.md` §3.1) |
| Session | **Yes** (schema only) | `tryout_sessions`; **no API route creates or manages evaluation sessions** |
| Evaluation | **Yes** (schema + broken Discord route) | no web UI or API route |
| Decision | **Schema only** | `tryout_selections`; `notification_sent`/`discord_notified` are never set, so **a decision never reaches the candidate** |
| **Offer** | **MISSING** | no offer entity, no terms, no expiry, no accept/decline |
| **Contract** | **MISSING** | no link to any contract concept; `tryout_selections` ends the chain |
| **Roster** | **PARTIAL** | `assigned_team_id` is recorded, but **nothing writes `users.team_id` or `rosters`** — so selecting a candidate does not actually put them on a team |
| **Onboarding** | **MISSING** | no account creation for a selected candidate; `temporary_access_granted` / `temp_user_id` exist on the invitation but are never set by any code path |
| **Notification** | **MISSING** | flags exist, nothing writes them |
| **Withdrawal** | **Schema only** | `status='withdrawn'` exists, no route |
| **Rejection feedback** | **Schema only** | `rejection_reason` / `feedback_message` exist, no route |
| **Deferral / waitlist** | **MISSING** | `selection_status='extended'` exists but there is no waitlist or re-queue |
| **Bulk decisions** | **MISSING** | — |
| **GDPR erasure of an applicant** | **MISSING** | an applicant has no identity record; erasure requires free-text search across `contact_email` and `discord_id` |

## 4. Findings

### F-TRY-01 — HIGH: the Discord transitions are all non-functional
Covered in `22_DISCORD.md` §3.1. Root cause: the routes use the module-level anon Supabase
client, so `auth.uid()` is `NULL` and every staff-scoped policy denies. Confirmed against
`database/SUPABASE_TRYOUTS_SETUP_FIXED.sql:217-224, 250-257, 270-278`.

### F-TRY-02 — HIGH: selection does not change anything
**Evidence.** No code writes `users.team_id` or `rosters` from `tryout_selections`. `app/api/tryouts`
is the only web-facing route and exposes GET and POST only (`app/api/tryouts/route.ts`).
**Impact:** the pipeline terminates at a status flag. A "selected" candidate is not on a roster,
has no account, and has been told nothing.
**Severity:** HIGH · **Confidence:** HIGH

### F-TRY-03 — HIGH: no web workflow for the post-application stages
**Evidence.** `/dashboard/tryouts`, `/dashboard/tryouts/create`, `/dashboard/tryouts/[id]`
exist, but there are no API routes for screening, inviting, scheduling an evaluation session,
submitting an evaluation, or recording a selection. The only write path is the bot.
**Impact:** the entire middle of the funnel is only reachable through Discord, and that path is
broken. In practice the tryout module cannot be operated from the product.
**Severity:** HIGH · **Confidence:** HIGH

### F-TRY-04 — HIGH: an applicant cannot see their own status
**Evidence.** `tryout_applications` has no SELECT policy for the applicant
(`database/SUPABASE_TRYOUTS_SETUP_FIXED.sql:230-247`); `GET /api/discord/tryout/status` uses the
anon client and therefore returns nothing.
**Impact:** candidates are blind. Combined with no notification on decision, a candidate can
apply and never learn the outcome.
**Severity:** HIGH · **Confidence:** HIGH

### F-TRY-05 — MEDIUM: the `sync_tryout_to_profile` trigger is a no-op
**Evidence.** `automation-scripts/04:39-53`
```sql
CREATE OR REPLACE FUNCTION public.sync_tryout_to_profile() RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.users SET full_name = COALESCE(NEW.full_name, full_name), …
  WHERE id = NEW.id;      -- NEW.id is the APPLICATION id, not a user id
  RETURN NEW;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;
```
**Impact:** `users.auto_sync_tryout_data` (default `true`, `scripts/00:87`) is advertised as a
feature and silently does nothing. There is no link from an application to a user, so there is
nothing to sync *from*.
**Severity:** MEDIUM (functional) / **HIGH** as a documented-vs-actual gap · **Confidence:** HIGH

### F-TRY-06 — MEDIUM: no applicant identity, so no de-duplication and no erasure
**Evidence.** applications are keyed on `tryout_id` + free-text `discord_id`/`contact_email`
(`SUPABASE_TRYOUTS_SETUP_FIXED.sql:35-60`); the de-dup check in
`app/api/discord/tryout/apply:82-87` relies on the **caller-asserted** `discord_id`.
**Impact:** one human, many applications. GDPR erasure is a free-text search problem.
**Severity:** MEDIUM · **Confidence:** HIGH

### F-TRY-07 — MEDIUM: no consent, no data minimisation, minors
**Evidence.** the form collects `full_name`, `ign`, `discord_tag`, `game_id`,
`contact_email`, `contact_phone`, `availability`, `highlights_links`, `ip_address`,
`user_agent` — with no consent checkbox, no privacy notice, no age gate, and no retention
policy.
**Impact:** recruiting minors' personal data without a lawful basis or notice is the highest-risk
compliance exposure in the entire system (`92_COMPLIANCE.md`).
**Severity:** HIGH (compliance) · **Confidence:** HIGH

### F-TRY-08 — MEDIUM: schema-quality issues
* `tryouts.team_ids uuid[]` — array, no FK (`SUPABASE_TRYOUTS_SETUP_FIXED.sql:16`).
* `tryout_evaluations` has no `UNIQUE(invitation_id, evaluator_id)` — duplicate evaluations are
  possible despite the API's check-then-insert.
* `overall_score` is computed in application code (`:88-91`) rather than generated, so it can
  disagree with its four components.
* `tryout_sessions` duplicates the `sessions` scheduling columns and can disagree with them
  (`12_DATABASE_RELATIONSHIPS.md` F-REL-04).
* `tryout_stats` view double-counts via a 6-way join and bypasses RLS
  (`13_RLS_SECURITY.md` F-RLS-11).

## 5. Verdict
| Asset | Verdict |
| --- | --- |
| The **six-table model and the phase/status machine** | **MIGRATE** — genuinely well designed; keep the state machine, add the missing stages |
| RLS intent (public can apply, staff manage, public can see active tryouts) | **MIGRATE the intent**, rewrite the policies |
| The evaluation scorecard (objective + 4 subjective + recommendation) | **MIGRATE** — a good, esports-specific artifact |
| All API/UI plumbing | **REBUILD** |
| `sync_tryout_to_profile` | **REMOVE** |
| Missing stages (offer, contract, onboarding, notification, withdrawal, waitlist) | **BUILD NEW** (`69_FUTURE_PARTNERSHIPS.md` patterns apply; see `29_TRYOUTS.md` §3) |
