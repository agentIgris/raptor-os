# 35 - CREATORS
**Audit.md section:** 42 (SECTION 39 - CREATOR DOMAIN)

## 1. Status: ABSENT
| Creator capability | Present | Nearest legacy artefact |
| --- | --- | --- |
| Creator / streamer entity | NO | - |
| Content creator vs competitive player distinction | NO | users.role has no creator value |
| Social account links | Partially | users.instagram_handle (single), users.discord_id (single), users.social_links jsonb (unvalidated) |
| Platform (Twitch / YouTube / TikTok / Kick / X) | NO | - |
| Handle per platform | NO | - |
| Follower / subscriber / view metrics | NO | - |
| Audience demographics | NO | - |
| Rate card / pricing | NO | - |
| Media kit | NO | - |
| Campaigns | NO | - |
| Deliverables | NO | - |
| Sponsorship / brand deals | NO | - |
| Revenue share | NO | - |
| Content attribution | NO | - |
| Contract | NO | (33_CONTRACTS.md) |
| Analytics / reporting | NO | - |

The only creator-adjacent code is the hardcoded Discord-invite constant on three public pages
(app/contact/page.tsx:24, app/join-us/page.tsx:21, app/apply/[tryoutId]/page.tsx:24) and the
generic content-oriented components in components/content-adjacent public pages.

## 2. Why this is strategically the largest opportunity
The competitive side of esports (teams, matches, results) is a shrinking market: a handful of
titles, a few thousand professional players worldwide, and strong incumbents. The creator economy
is the growth side: every player who ever streamed is a potential creator, creators monetise
across many brands, and the operational complexity (multi-platform analytics, campaign
fulfilment, deliverables, invoicing, revenue share) is exactly what an OS should absorb.
Raptor has none of it, while the target product is explicitly required to cover creators,
streamers, social platforms, content production and creator analytics.

## 3. Findings

### F-CRE-01 - CRITICAL: the entire creator economy is absent
**Evidence.** exhaustive absence across all SQL, API and components. There is no creator
concept in any of the 5 permission models either - a creator could not even be granted access to
anything, because there is no creator role.
**Impact:** the fastest-growing, highest-value segment of the esports audience has no
representation. Any organisation whose revenue depends on creators (sponsorship, streaming
revenue share, merchandise) cannot use the platform.
**Severity:** CRITICAL (for the target product) | **Confidence:** HIGH

### F-CRE-02 - HIGH: the single-role user model cannot hold a dual career
**Evidence.** users.role is one enum value; users.team_id is one FK.
**Impact:** the most common real-world esports career path - compete AND stream AND create - is
unrepresentable. A player who also streams must be either mis-classified or duplicated.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** 62_PEOPLE_MODEL.md (a Person with many Engagements, each with its own
scope, dates, compensation and permissions).

### F-CRE-03 - MEDIUM: social data is a single unvalidated jsonb column
**Evidence.** users.instagram_handle text; users.discord_id text (no UNIQUE);
users.social_links jsonb DEFAULT {} (scripts/00:60, 61, 79) with no CHECK on jsonb_typeof and no
schema.
**Impact:** no per-platform handle, no follower count, no verification, no history. A creator's
entire audience footprint is one opaque blob that cannot be queried, reported or shown.
**Severity:** MEDIUM | **Confidence:** HIGH

## 4. Verdict
**BUILD NEW.** Requirements are specified in 67_FUTURE_CREATORS.md. Key design points: a Creator
is a Person with a CreatorProfile; SocialAccount is a first-class entity with platform, handle,
verified flag, follower metrics with history and a fetch timestamp; Campaign and Deliverable
connect creators to Commercial deals; a RateCard and MediaKit are versioned documents; revenue
share is modelled as an entitlement, not a spreadsheet; and creator analytics are aggregated
server-side rather than pasted in.
