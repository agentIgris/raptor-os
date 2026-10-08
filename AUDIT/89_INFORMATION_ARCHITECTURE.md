# 89 - INFORMATION ARCHITECTURE
**Audit.md section:** 97 (SECTION 94)

## 1. The IA problem in the legacy system
Navigation is built from **who the user is**, not from **what the organisation does**
(`05_ROUTES.md` §5). Consequences already visible:
* A coach's "Reports" shows a leaderboard built from a client-side download; a player's "Team"
  page and a coach's "Team" page are the same component with different data scopes
  (`app/team/TeamView.tsx`, `app/team/team-view-client.tsx`).
* The sidebar shows 9-12 items depending on role, with no grouping, and the audit
  documentation has to reconstruct the meaning (`08_ROLES_PERMISSIONS.md`).
* `/` redirects players to `/dashboard` and non-players to `/` (`app/page.tsx`) - the home page
  is role-conditional, which is a routing smell, not an IA decision.
* `/api/finance`, `/api/teams`, `/api/rosters` are all reachable by any team member
  (F-FIN-04, F-API-08) - the IA implies separation the authorisation layer does not enforce.
* 32 visible page components exist; 7 are dark-only placeholders and 5 are unreferenced
  (`06_UI_COMPONENTS.md`).

## 2. Target IA: organised by domain, filtered by role
Top level becomes **the organisation's work**, not the person's identity. Role determines what is
*visible*, never what *exists*.

```
Home  (role-aware dashboard, one per role)
Competitive
  Teams            Team detail (roster, staff, competitions, sessions)
  Competitions     Competition detail (entries, results, prize allocation)
  Standings        (per competition, per title, per region)
Performance
  My performance   (player)      |  Team performance (coach/manager)
  Sessions         Session calendar + attendance sheet
  Attendance       Attendance register (team-scoped)
  Rankings
People
  People           Directory, effective-dated history, multi-role
  Contracts        Contracts + agreements + expiry calendar
  HR               (if enabled) Onboarding, offboarding, documents, minors/consent
  Payroll          (if enabled) Payroll runs, entitlements
Finance
  Income           Prize income + allocations
  Expenses         Expenses with invoices
  Budgets
  Invoices / Payments
Commercial
  Sponsorships     Sponsors + obligations + evidence
  Inventory        Commercial inventory (placements, jerseys, slots, content)
  Partners
Content
  Creators         Creator profiles + platform accounts
  Content          Content calendar + pieces
  Campaigns
Events
  Events           Events + registrations
  Travel           Travel plans, bookings, documents
Assets
  Asset register
Facilities
  Venues / rooms (lightweight)
Work
  Tasks            My tasks / team tasks
  Workflows        Templates + runs
Reporting
  Reports          (the 7 Audit.md categories)
  Analytics
  Exports
Configuration (admin)
  Organisation, People & roles, Attendance rules, Tiers & pricing,
  Integrations (Discord, email, calendar, storage), Branding, White label,
  Notifications, Data & retention, Audit log, Billing
Platform (internal, never tenant-visible)
  Tenants, Provisioning, Feature flags, Impersonation, Support, Health
```

## 3. Navigation rules
1. **Stable spine, filtered edges.** The top-level set is identical for everyone; items a role
   cannot use are hidden, and the URL is still rejected by the API (`10_AUTHORIZATION.md`).
2. **No role-conditional home page.** `/` is a dashboard that adapts; the redirect at
   `app/page.tsx` goes away.
3. **Every list is server-rendered, filterable, paginated and exportable** - the current pattern of
   downloading everything and aggregating in the browser is what makes `/team` 60 KB
   (`56_PERFORMANCE.md`).
4. **Every entity has a canonical detail URL** with a stable id, so links are shareable within a
   tenant and auditable.
5. **Configuration is one place.** Today config is spread across `admin_config`, `tier_defaults`,
   `practice_session_config`, `discord_webhooks`, `communication_settings`
   (`79_ORG_CONFIGURATION.md`).
6. **Settings are per tenant**, and the whole tree is namespaced by `organization_id`.

## 4. IA-to-permission mapping
| Section | Who can see | Enforcement today |
| --- | --- | --- |
| People, Contracts, HR, Payroll | HR/owner/finance roles | **No HR roles exist** (`08_ROLES_PERMISSIONS.md`) |
| Finance | owner/finance | Any team member can read all finance rows (F-FIN-04) |
| Commercial | partnerships/sponsor roles | **No such roles**; unauthenticated intake relay |
| Content / Creators | content/creator roles | No roles; public webhook |
| Competitive / Performance | coach, manager, player (own) | Team scope is client-supplied (F-API-08) |
| Configuration | tenant admin | `admin_config` is world-writable (`19_SECRETS.md` F-SEC-01) |
| Audit log | tenant admin, compliance | Does not exist |

## 5. Migration of the existing IA
| Legacy route | Target |
| --- | --- |
| `/dashboard` | `/` (role-aware) |
| `/team`, `/teams` | `/competitive/teams` |
| `/performance` | `/performance/team` or `/performance/me` |
| `/roster` | `/competitive/teams/{id}` (roster tab) |
| `/reports`, `/report` | `/reporting/reports` |
| `/upload`, `/ocr` | `/performance/sessions/{id}/entry` |
| `/discord` | `/configuration/integrations/discord` |
| `/admin/*` | `/configuration/*` + `/platform/*` |
| `/debug/*` | removed |
| public marketing routes | per-tenant public site (`81_PUBLIC_WEBSITE.md`) |
| 7 dark-only placeholders | either built or deleted (`06_UI_COMPONENTS.md`) |

## 6. Verdict
The current IA optimises for a single-organisation, single-role tool and hides the fact that the
product needs at least 16 personas (`87_PERSONAS.md`). The target IA is domain-first, with role
filtering and hard API enforcement.
