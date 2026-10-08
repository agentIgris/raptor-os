# 86 - MARKET / COMPETITOR GAP
**Audit.md section:** 94 (SECTION 91)

> Audit.md: *"Research existing esports management and organization software. Do NOT copy
> competitors. Identify gaps and opportunities."*
> **Caveat:** this is desk research from publicly documented product positioning, not a
> hands-on evaluation. Every claim below should be re-verified before a commercial decision.
> Nothing here was taken from a competitor's proprietary material.

## 1. Market segments and the incumbent pattern
| Segment | Representative products (public positioning) | What they do well | Structural limit |
| --- | --- | --- | --- |
| **Team / competitive management** | esports team platforms and CRM tools marketed to esports organisations; several niche SaaS products in this space | roster, results, attendance, match tracking | almost all are **single-title, single-region, team-centric**; weak or absent finance, HR, contracts, creator and commercial modules |
| **Sports team management (general)** | mature sports-management suites (club management, stats, scheduling) | deep, proven domain models; budgets; memberships | built for physical sports: seasons, venues, ticketing, media archives; **no esports-native concepts** (no prize allocation, no sponsor deliverables, no streaming metrics, no tier-based slot economics) |
| **Creator management** | several creator-management and influencer-marketing platforms | audience analytics, campaign tracking, rate benchmarking | organised around the **agency** (managing many creators for many brands), not the **creator's own org**; no connection to a competitive roster, contracts or prize money |
| **Sponsorship / partnership CRM** | general CRM products (HubSpot-class, Salesforce-class) used by partnership teams | pipeline, contacts, forecasting | generic; no esports **inventory** concept, no obligation tracking, no proof of delivery, no performance-vs-contract reporting |
| **HR / payroll / finance** | generalist HRIS, payroll and accounting suites | compliance, payroll, accounting | external to esports; **no prize-income allocation**, no creator revenue share, no sponsor deliverable as a financial obligation |
| **Analytics / esports data** | match-data providers and stat platforms | authoritative competitive data | read-only; **no operational system attached**; teams still run their org on spreadsheets |
| **All-in-one "esports OS" attempts** | a handful of ventures that have tried this | broad ambition | the pattern in this audit is typical of the category: broad surface, shallow depth, single-tenant by construction, security and multi-tenancy treated as later work |

## 2. The pattern this audit reveals
Almost every product in the "esports organisation management" category makes the **same
architectural error** that Raptor made, and the error is structural rather than accidental:
1. **Team-centric, not organisation-centric.** The team is the root object, so there is no place
   to hang HR, contracts, sponsors, creators or multiple legal entities.
2. **Single-title assumption.** The data model hardcodes one game's metrics, one ranking ladder and
   one economy. Adding a title is a migration.
3. **One role per person.** A player who also creates content is unrepresentable, which is the
   single most common real career path in the industry.
4. **Finance treated as a spreadsheet attachment.** Prize money, which is the industry's most
   distinctive financial flow, is either absent or a note field.
5. **Sponsorships treated as relationships rather than obligations.** Nothing tracks *what was
   promised, by when, with proof*, which is what the money is actually contingent on.
6. **Security and multi-tenancy deferred.** Single-tenant by construction; RLS, tenant isolation
   and audit logging absent or inconsistent.

**Raptor exhibits all six.** That is the most important market finding: the category's
architectural defaults are the reason the category is underserved, not a matter of execution.

## 3. The gaps, ranked by willingness to pay
| # | Gap | Why incumbents do not serve it | Willingness to pay | Build difficulty |
| --- | --- | --- | --- | --- |
| 1 | **Prize-money allocation as a first-class, auditable engine** | Generic payroll cannot model a per-event percentage split computed against an effective-dated roster; finance teams do it in spreadsheets | **Very high** - it is real money moving and a trust problem | Medium - the logic is tractable and deterministic |
| 2 | **Sponsor deliverable obligations with proof** | CRM products model deals; nothing models the *units of placement* and their fulfilment | **Very high** - it is what sponsors renew on | Medium-high |
| 3 | **Contracts, agreements and expiry with provable acceptance** | HR tools stop at employment; legal tools are not operational software | High - and a compliance requirement | Medium |
| 4 | **The dual-career person model (compete + create + coach)** | Every incumbent assumes one role per person | High - it is the industry's actual shape | Low once designed |
| 5 | **Attendance and training operations with real automation** | Sports suites have it, esports tools do not | High | Medium (the rules are already known - see `26_ATTENDANCE.md`) |
| 6 | **Creator management tied to the org, not the agency** | Creator tools are agency-centric | High | Medium |
| 7 | **Competitive data ingestion matched to operations** | Data providers are read-only; nobody joins results to attendance, contracts and pay | Medium-high | Medium, but licensing-dependent |
| 8 | **Travel with minors' documents and consent** | Nobody models it; it is a real operational and legal risk | Medium - concentrated in orgs that travel | Medium |
| 9 | **Multi-title, multi-region, multi-currency from day one** | Everyone hardcodes one title and one currency | Medium - it is table stakes for enterprise, not a wedge | Medium |
| 10 | **A real audit trail and data-subject rights** | Nobody has it; it is an enterprise procurement gate | Medium - it unblocks sales rather than creating them | Low-medium |
| 11 | **White label / multi-tenant by construction** | Deferred everywhere | Medium | Medium, but it is a pre-condition |
| 12 | **Content production tied to sponsor obligations** | Content tools are separate; the link to the contract is manual | Medium | Medium |

## 4. Strategic conclusions
1. **The wedge is the prize/compensation engine, not the dashboard.** Every incumbent can show a
   leaderboard. None can compute and evidence who is owed what from an event. That is
   deterministic, defensible, and directly tied to money and trust.
2. **The moat is the data model, not the UI.** A correct organisation + person + engagement +
   obligation model is expensive to retrofit into an incumbent's product; a prettier dashboard is
   not a moat.
3. **Sell to the operator, not the player.** The buyer has a budget, a board and a compliance
   obligation; the player is the user. Raptor is currently a player-facing tool.
4. **Security and multi-tenancy are a sales gate, not a feature.** No organisation handling
   contracts, payroll and minors' data will pass a procurement questionnaire without tenant
   isolation, an audit log, retention policy and data-subject rights. Almost nobody in this
   category has them.
5. **Do not compete on breadth.** Breadth is why this category's products are shallow. Win
   competitive operations + money + obligations, then expand.
6. **Openness as a differentiator.** Publish the entitlement/allocation model and the data model.
   Organisations are wary of lock-in with a vendor that holds their contracts and payroll.

## 5. Risks implied by the market
| Risk | Detail |
| --- | --- |
| **Incumbents add these modules** | Generalist HR and accounting vendors could bolt on esports concepts. Mitigated by depth and by being the operational system of record rather than a bolt-on |
| **Consolidation around agencies** | If creator management consolidates into agencies rather than orgs, the org-centric model is less valuable. Mitigation: support agency-as-a-tenant and org-as-a-tenant equally |
| **Game publishers run the ops** | A publisher offering team management would be a threat to the competitive side, not the commercial side. Mitigation: publisher-agnostic, multi-title |
| **Data licensing cost** | Competitive data providers charge per seat and restrict redistribution. Mitigation: treat ingestion as optional and per-title; never resell the raw data |
| **Price sensitivity** | Small esports organisations are price-sensitive and low-margin. Mitigation: a real free/self-serve tier with export, and a paid tier that pays for itself on prize and sponsor administration |
| **Trust** | Holding contracts, pay and minors' data is a high-consequence custody. Mitigation: security posture as a marketed differentiator (`91_SECURITY_ARCHITECTURE.md`) |

## 6. What to verify before acting
* Whether any incumbent genuinely performs prize allocation (this audit found none documented).
* Whether sports-management suites have been extended to esports and how far.
* Current state of esports data-provider licensing terms and pricing.
* Whether "esports organisation OS" attempts have raised capital and who their customers are -
  a strong demand signal if they have paying enterprise customers.
* Pricing benchmarks: what organisations currently pay for team-management tooling versus
  agency retainers.
