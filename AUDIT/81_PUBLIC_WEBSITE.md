# 81 - PUBLIC WEBSITE (requirements only - NOT implemented)
**Audit.md section:** 88 (SECTION 85)

## 1. Starting position
There is a public marketing site for **one** organisation, hardcoded:
`app/page.tsx` -> `app/public/page.tsx`, plus `about/`, `faq/`, `gallery/`, `highlight/`,
`incentives/`, `join-us/`, `contact/`, `tier-structure/`. It is a Next.js app in the same
codebase as the dashboard, with no tenant scoping, no CMS, and no publish control.
Notable: `/api/public/stats` publishes **fabricated** figures (`31_FINANCE.md` F-FIN-03), and
`/highlight` and `/gallery` are inconsistent with the rest of the route guard
(`05_ROUTES.md` §1).

## 2. Product decision
Two options:
| Option | Description | Assessment |
| --- | --- | --- |
| **A. Hosted public site** | the platform renders and hosts each tenant's public site | Higher value, higher cost; needs a CMS-like publishing model, SEO at scale, and a rendering tier |
| **B. Headless / data only** | the tenant keeps its own website and consumes a public read API | Cheaper; the tenant owns design and SEO; far less differentiation |

**Recommendation: A, but as a later phase, and only for tenants who want it.** Phase 1 should be
**B plus a small set of embeddable components** (a roster widget, a schedule widget, a results
widget) so a tenant gets value immediately without the platform taking over its web presence.
Phase 2 adds the hosted site for tenants that ask.

## 3. Requirements (hosted site)
### 3.1 Tenant-scoped publishing
* Every page is a `PublicPage` owned by a tenant, with `slug`, `status`
  (draft | published | archived), `published_at`, `seo` metadata, and a `sections[]`
  composition.
* **Nothing is published by default.** Every page and every section is opt-in, because the
  alternative is a privacy incident.
* A `PublicVisibilityRule` per entity: `never | public | unlisted | teaser`, so a player can be
  listed on a roster page while their contact details, device telemetry and compensation are not.
* **A published projection, not a live query.** Public reads go through a dedicated, cacheable,
  read-only projection that can only contain fields marked publishable. A public endpoint must
  never be a thin wrapper over the internal API.

### 3.2 Content the Audit.md asks for
| Section | Data | Notes |
| --- | --- | --- |
| **Teams** | name, logo, game(s), region, description, roster | `81` team list |
| **Players** | display name, handle, photo, role, country, social links - **only if published** | never DOB, address, device data, pay |
| **Creators** | display name, platforms, links, follower counts (snapshot) | per `67_FUTURE_CREATORS.md` |
| **News / announcements** | `Post` with a publish date, author, and optional expiry | a real editorial need |
| **Sponsors** | logo, tier, and a link - **only for partners who have consented to being listed** | consent is mandatory; a sponsor may pay to be removed |
| **Achievements** | trophies and honours, derived from competitive results | not free text |
| **Schedule** | upcoming sessions, matches and events, with times in the **visitor's** timezone or the tenant's, clearly labelled | a conversion driver |
| **Results** | recent competitive results, from ingested data | |
| **Recruitment** | open tryouts and an application CTA, linking to the tenant's application flow | the primary conversion goal |
| **Press** | press releases, logos, contact | |
| **Join us** | open roles, an application form | distinct from tryouts |

### 3.3 Technical requirements
* **Tenant resolution:** hostname (`org.platform.com`) or path (`/{org-slug}`), resolved
  **server-side**; never a client parameter.
* **Rendering:** statically generated per page with on-demand revalidation on publish, served
  from a CDN. Public pages must not query the transactional database on each request.
* **SEO:** per-tenant sitemap, `hreflang` where multi-locale (`59_INTERNATIONALIZATION.md`),
  canonical URLs, OpenGraph with the tenant's logo, JSON-LD built from published data only, and
  `robots.txt` per tenant.
* **Caching:** long-lived CDN caching with explicit purge on publish.
* **Rate limiting and abuse protection** on all public endpoints - the legacy public endpoints
  have neither (`15_API_SECURITY.md` F-API-11, F-API-12).
* **Privacy:** no PII, no internal ids that permit enumeration, and **no fabricated statistics**
  (`31_FINANCE.md` F-FIN-03) - any published number is measured and carries an "as of" date.

### 3.4 Application forms
* `PublicApplicationForm` (tryout, creator, general, partnership enquiry) writing to the correct
  domain entity with **explicit consent capture** and a privacy notice
  (`69_FUTURE_PARTNERSHIPS.md` §3).
* **Spam and abuse controls:** rate limiting, a challenge, an origin check, and a moderation
  queue. The legacy site has none and relays directly to Discord.
* Attachments are private assets, visible only to the assigned staff member.

## 4. What to remove from the legacy public site
* The hardcoded "Underdog practice cost covered / matches played / WWCD" figures
  (`app/api/public/stats:55-57`) - **delete**.
* The Discord-invite constant hardcoded in three public pages
  (`app/contact:24`, `app/join-us:21`, `app/apply/[tryoutId]:24`) - per-tenant configuration.
* `/highlight` (811-byte orphan) and `/gallery` (removed from navigation in commit `fa34734` but
  still present).
* The 6.1 MB hero video, or at least replace it with a tenant-selectable, optimised asset.
* The hardcoded `https://raptor-esports.example` fallbacks in four files
  (`57_ACCESSIBILITY.md` / `55_DEPLOYMENT.md` F-DEP-01).

## 5. Phase 1 recommendation
Ship, per tenant, on their own site:
1. A **read-only public API** with a tenant key, rate-limited, returning only published fields.
2. Three **embeddable widgets** (roster, schedule, results) as a self-contained script plus a
   documented API.
3. An **application form endpoint** with consent, rate limiting and a moderation queue.
This delivers most of the value at a fraction of the cost and defers the rendering tier.

## 6. Verdict / status
**REQUIREMENTS ONLY.** Note the strategic point: the public site is the acquisition channel for
recruitment, which is the funnel the legacy system actually has (`29_TRYOUTS.md`). In a SaaS it
becomes a per-tenant channel, and its absence is a growth blocker.
