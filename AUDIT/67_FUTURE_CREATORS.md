# 67 - FUTURE CREATOR MANAGEMENT (requirements only - NOT implemented)
**Audit.md section:** 74 (SECTION 71)

## 1. Starting position
Absent (`35_CREATORS.md`). The user model has a single `role` and a single `team_id`, so a
dual-career player-creator is unrepresentable, and social data is a single unvalidated `jsonb`
column.

## 2. Why this is a priority
Creator management is the fastest-growing and highest-margin part of the esports economy, and it
is the part of the market least well served by existing team-management tools. Combined with
`69_FUTURE_PARTNERSHIPS.md` and `70_FUTURE_SPONSORSHIP.md`, it turns the product from an
"esports team tool" into an "esports business OS".

## 3. Requirements
### 3.1 Identity
* `CreatorProfile` on a `Person` with an `Engagement(type=creator)`: stage, category
  (variety / competitive / IRL / educational), language, location, reach, audience demographics,
  brand safety notes.
* `SocialAccount`: `platform` (Twitch, YouTube, TikTok, Instagram, X, Kick, Facebook, Trovo,
  Douyin, Bilibili), `handle`, `url`, `verified`, `primary`, `connected_at`, `last_synced_at`.
  **One row per platform account** - not a JSON blob.
* `MetricSnapshot`: `platform`, `account_id`, `captured_at`, followers, live average concurrent
  viewers, average view duration, stream hours, video views, engagement rate, plus a
  `source` (API or manual) and a confidence. **Snapshots are immutable**; trends are computed from
  them.

### 3.2 Commercial
* `RateCard`: platform, format (short-form video, long-form, live integration, appearance,
  stream sponsorship, usage rights), rate, currency, unit, validity window, exclusivity notes.
* `MediaKit`: a versioned, generated document (audience, reach, past campaigns, rates,
  availability calendar) that can be published to a public URL with an expiry.
* `CreatorCampaign` links a creator to a `Deal` and to `Deliverable`s
  (`70_FUTURE_SPONSORSHIP.md`).
* **Revenue share** is a `CompensationAgreement` component (`65_FUTURE_PAYROLL.md`), not a
  spreadsheet.
* `Exclusivity` and `CategoryExclusivity` as first-class, checkable constraints on a campaign
  booking (the classic source of contractual disputes).

### 3.3 Content and performance
* `ContentItem` authored by / featuring the creator, with per-platform `Publication` records and
  `ContentMetric` snapshots (`68_FUTURE_CONTENT.md`).
* Sponsor disclosure / #ad compliance tracking per publication.

### 3.4 Operations
* `CreatorAvailability` (a calendar the campaign planner books against).
* Briefs, approvals, and content review with a named approver.
* `Payment` to the creator, via the payout provider (`65_FUTURE_PAYROLL.md`).
* `TaxProfile` per creator, with a W-8BEN/W-9 equivalent collected and stored (a legal
  requirement before any cross-border payment).

### 3.5 Safeguarding (essential here)
* Minors in the creator population are common; the same guardian-consent, restricted-visibility and
  payout-routing requirements as HR apply (`64_FUTURE_HR.md` §2.6).
* Brand-safety screening of sponsored content must leave an auditable record.

## 4. Integrations (see `76_INTEGRATIONS.md`)
* **YouTube Data API** - channels, videos, stats.
* **Twitch Helix** - users, channels, streams, clips.
* **TikTok** - display/research APIs (business approval required for many endpoints).
* **Instagram Graph** - business accounts only.
* **X** - read-only is sufficient.
* **Kick** - limited/unofficial; treat as manual entry.
* All integrations are **tenant-configurable credentials in a secret store**, per-tenant rate
  budgets, and a documented degradation path when a platform API changes or a token expires.

## 5. Migration from the legacy system
`users.instagram_handle` -> one `SocialAccount`; `users.discord_id` -> an `Identity`, not a
social account; `users.social_links jsonb` -> parsed into `SocialAccount` rows where
recognisable. **No creator data exists**, so this domain starts empty for every customer.

## 6. Explicit non-goals
No video editing, no live-stream hosting, no algorithmic recommendation, no ad-serving, no
creator marketplace, no payment collection from viewers.

## 7. Priority
High. Second only to the core competitive and people domains, because it is the clearest
differentiator in the market (`86_MARKET_GAP.md`).
