# 72 - FUTURE ASSETS (requirements only - NOT implemented)
**Audit.md section:** 79 (SECTION 76)
Covers equipment, media assets, documents-as-assets and (lightly) facilities.

## 1. Starting position
Absent (`40_ASSETS.md`, `41_FACILITIES.md`). The only related artefacts are self-reported device
telemetry and a public, unprotected `media` bucket.

## 2. Requirements
### 2.1 Asset register (equipment and media)
* `Asset`: `org_id`, `kind` (equipment | media | document | uniform | venue_asset), `asset_tag`
  (unique), `category`, `make`, `model`, `serial_number` / `imei`, `purchase_date`,
  `purchase_cost` + currency, `vendor`, `warranty_expires_at`, `condition`, `status`
  (in_stock | assigned | in_repair | retired | lost | disposed), `location_id`, `parent_asset_id`
  (for kits of components), `metadata` (typed JSON per category).
* `AssetAssignment`: `asset_id`, `assignee_type` (person | team | location), `assignee_id`,
  `assigned_at`, `returned_at`, `condition_out`, `condition_in`, `issued_by`. **Effective-dated,
  so a chain of custody is reconstructible.**
* `AssetIncident`: loss, damage, or theft, with a report, an assessment, and a resolution.
* `AssetMaintenance`: service events, with a cost that can post to the ledger.
* `AssetAudit`: a periodic physical inventory with a counted-vs-expected variance report and an
  audit trail of the count.
* `AssetDisposal`: with an approval and a ledger posting.
* `AssetCheckoutRequest` / `ReturnRequest` as `WorkItem`s for the workflow.

### 2.2 Uniforms and kits (esports-specific)
* `Product` / `Kit` with per-size inventory, a `Supplier`, a unit cost, and a lead time.
* `KitAssignment` per player, with a condition and a return on offboarding.
* Because kits are sponsor-branded (`70_FUTURE_SPONSORSHIP.md`), a kit is **both** an asset and a
  branded item: brand changes must be versioned so "which sponsor owned this jersey" is
  answerable.

### 2.3 Media assets
* `Asset(kind=media)` replaces the `media` bucket entirely: private bucket, `{org_id}`-prefixed
  keys, server-side content sniffing, checksums, scan status, a visibility flag
  (`private | org | public_link` with an expiry), and a per-class TTL
  (`50_DATA_RETENTION.md` §3).
* Every media asset should reference a `ContentItem` (`68_FUTURE_CONTENT.md`) so the library is
  meaningful rather than a file dump.
* Short-lived signed URLs for reads after an authorisation check. **No public buckets.**

### 2.4 Documents as assets
* Documents are `Asset(kind=document)` referenced by `DocumentVersion`
  (`73_FUTURE_DOCUMENTS.md`), so there is **one** storage, retention and access-control mechanism
  rather than three.

### 2.5 Facilities (deliberately lightweight)
* `Location` (office, gaming house, bootcamp, studio, remote), `Space` (room, desk, bed),
  `SpaceBooking`, an occupancy limit, and a cost allocation to a `CostCentre`.
* `SpaceEquipment` linking a space to assets.
* **Explicit non-goals:** no HVAC, no maintenance ticketing for the building, no access control
  integration, no desk booking, no room-utilisation analytics beyond occupancy counts.

### 2.6 Offboarding integration
* An offboarding checklist that lists every assigned asset, requires a return or a written
  waiver with an approver, and produces the evidence needed for any lawful deduction
  (`64_FUTURE_HR.md` §2.2).

## 3. Depreciation
Optional, and only if the customer wants asset accounting in the platform. Under the recommended
architecture (`66_FUTURE_FINANCE.md`) the ledger is external, so depreciation posts there. The
platform holds the cost and the useful life and pushes the schedule.

## 4. Migration
* The `media` bucket -> `Asset` rows via a reconciliation report; **the public bucket must be
  emptied and objects re-uploaded as private assets.**
* `users.device_model` / `ram` / `fps` / `storage` -> **not** migrated as assets. They are
  self-reported personal data with no ownership implication. Recommended handling is a
  recommended-settings profile with explicit consent, and the hardware fields dropped or confined
  to a consented, access-logged store (`40_ASSETS.md` F-AST-03).
* Player-reported rigs are a candidate for a **consented, optional** asset declaration, which is
  materially different from the current implicit collection.

## 5. Priority
Medium. The **document/media asset unification** and the offboarding checklist are the
high-value parts; a full equipment register is valuable mainly to organisations that issue
hardware.
