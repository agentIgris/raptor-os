# 68 - FUTURE CONTENT MANAGEMENT (requirements only - NOT implemented)
**Audit.md section:** 75 (SECTION 72)

## 1. Starting position
Absent as a domain (`36_CONTENT.md`). The only related artefact is a listing screen over a public,
unprotected storage bucket.

## 2. Requirements
### 2.1 Content item
`ContentItem`: `org_id`, `type` (long-form video, short, stream, VOD, clip, image, article, podcast,
social post, newsletter), `title`, `brief`, `concept`, `status`, `campaign_id` (optional),
`owner_engagement_id`, `due_at`, `priority`, `tags`.
Status pipeline: `idea -> briefed -> producing -> internal_review -> client_review (if sponsored)
-> approved -> scheduled -> published -> archived`, plus `rejected` and `cancelled`, with a
required reason on rejection.

### 2.2 Assets
`Asset` bound to a `ContentItem`: the file, its purpose (master, proxy, thumbnail, caption file,
subtitle, raw footage), technical metadata (codec, resolution, duration, checksum), language,
and rights (`AssetRights`: owner, licence, expiry, permitted uses, territory, exclusivity). This
replaces the unprotected `media` bucket (`72_FUTURE_ASSETS.md`).

### 2.3 Assignments and review
`WorkItem` per `43_TASKS.md` for the production tasks; `Approval` per step with a named approver,
a decision, a comment, and an audit record. Reviewer rejection returns the item to `producing`
with the comments attached.

### 2.4 Calendar and publishing
`ContentCalendar`: entries with a planned publish time in the tenant's zone, the target platform(s),
and the owner. `Publication` records what was actually published where and when, with the
canonical URL, and **detects the gap between planned and actual** - which is the metric sponsors
actually pay for.

### 2.5 Analytics
`ContentMetric` snapshots per publication: views, watch time, completion rate, engagement, CTR,
revenue where attributable. Aggregated per campaign for sponsor reporting
(`70_FUTURE_SPONSORSHIP.md`), and joined to `Deal` value to produce an ROI figure the platform can
defend.

### 2.6 Sponsor integration
* `Deliverable` references a `ContentItem`; publication of that item is the fulfilment event.
* Sponsor approval is a distinct state from internal approval, with a separate actor and a
  separate SLA.
* **Disclosure compliance:** per-publication `DisclosureRecord` (who disclosed, when, where),
  because non-disclosure is a contractual and regulatory breach.

### 2.7 Reuse and templates
`ContentTemplate` (a recurring format) and `Series` (a linked set) so an organisation can express
"a weekly Showmatch recap, 8 minutes, published every Monday" once.

## 3. Integrations
* Platform publish APIs (YouTube, TikTok, Instagram, Twitch) for scheduling where available.
* `76_INTEGRATIONS.md` for the general pattern: per-tenant credentials, rate budgets, degradation.
* Cloud rendering/transcoding is an explicit **non-goal** - the platform tracks and verifies
  deliverables, it does not become a media pipeline.

## 4. Migration from the legacy system
`media` bucket objects -> `Asset` rows with a reconciliation report listing what could not be
attributed. No content metadata exists, so attribution starts empty. **The public bucket must be
emptied and the objects re-uploaded as private assets** during migration.

## 5. Explicit non-goals
No video editing, no stock-footage marketplace, no AI generation of final content, no
rights-management beyond recording licences, no publishing to a platform the org does not own.

## 6. Priority
Medium-high. It is the operational substrate for both the content team and sponsor fulfilment, so
it should be built before the commercial reporting layer.
