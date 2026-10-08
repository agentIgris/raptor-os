# 70 - FUTURE SPONSORSHIP DELIVERABLES (requirements only - NOT implemented)
**Audit.md section:** 77 (SECTION 74)

## 1. Starting position
Absent (`38_COMMERCIAL_INVENTORY.md`). The system cannot model a single sellable placement.

## 2. The central insight
A sponsor does not buy a relationship; they buy **N units of a named placement, within a window,
at a standard, with evidence**. Therefore the primitive is not a "sponsor record" but a
**quantified inventory item** attached to a **contractual obligation** with an **owner**, a
**deadline**, an **approval** and a **proof of publication**. Build that and most of the
commercial domain follows.

## 3. Inventory
* `InventoryItem`: `org_id`, `key`, `name`, `type`, `scope_type` (organization | team | creator |
  event | game), `scope_id`, `unit_definition` (e.g. "1 Instagram post", "logo in broadcast
  overlay per match", "4h creator content"), `rate`, `currency`, `period`, `quantity_total`,
  `quantity_sold`, `available_from`, `available_to`, `restrictions` (JSON: category exclusivity,
  territory, platform, competitor exclusions), `evidence_requirements[]`.
* **Tenant-configurable**: the catalogue is defined by the organisation, not by us. Seeded with
  esports-relevant defaults (jersey placements, overlay logos, social posts, stream
  integrations, content integrations, appearances, naming rights, community activations, data
  and insight deliverables, hospitality, ticket allocations).
* `InventoryHold` for periods already committed, so double-selling is prevented.

## 4. Obligations and fulfilment
* `ContractObligation`: `contract_id`, `inventory_item_id`, `quantity`, `due_at`,
  `owner_engagement_id`, `status` (`not_started` | `in_progress` | `submitted` | `in_review` |
  `approved` | `published` | `rejected` | `waived`), `waiver_reason` + approver.
* `Deliverable` - the unit of work fulfilling an obligation: `content_item_id` (optional),
  `publication_id` (optional), `description`, `submitted_at`, `reviewer_engagement_id`,
  `review_decision`, `reviewed_at`, `rejection_reason`.
* `Proof`: the evidence artefact - an asset (screenshot, video, link, analytics export) with
  `captured_at`, `captured_by`, and a `verification_state` (unverified / verified / disputed).
* `Performance`: the measured outcome - impressions, views, reach, engagement, conversions,
  attributed by campaign and by inventory item, with the measurement source and a timestamp.

## 5. Invoicing and recognition
* `InvoiceLine` sourced from a `ContractObligation` or a `Contract` schedule, so a sponsor is
  never invoiced for something not tracked.
* **Revenue recognition hook**: an obligation reaching `approved` or `published` is the event that
  permits a line to be invoiced.
* `Dispute` with a resolution and an audit trail.

## 6. Reporting (what the sponsor actually receives)
* Obligations by status; delivered vs contracted; on-time rate; time-to-approval; performance
  against the contracted metric; a period-over-period comparison; and a **signed-off report pack**
  that the sponsor can accept as the contractual deliverable.
* Reports are **generated server-side, versioned, and stored as a `Document`** so the historical
  record of what was reported is immutable.

## 7. What must NOT be fudged
* Metrics must record their **source and capture time**. A screenshot of a dashboard is evidence; a
  number copied into a spreadsheet is not.
* Any AI summarisation of performance must be labelled as AI and must cite the underlying records
  (`74_FUTURE_AI.md`, `75_AI_SECURITY.md`).
* Waivers must require an approver and a reason. Silent non-delivery is the failure mode that ends
  sponsor relationships and triggers legal disputes.

## 8. Migration from the legacy system
Nothing exists. The only sponsor-adjacent data is brand enquiries inside a Discord channel
(`37_SPONSORSHIPS.md`). Historical sponsorship performance is a **manual data-entry project** for
each customer, and this must be scoped commercially before sale.

## 9. Priority
High. This is the module that converts the commercial CRM into revenue that can be invoiced and
defended.
