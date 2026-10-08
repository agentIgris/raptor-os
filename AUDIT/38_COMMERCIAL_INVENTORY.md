# 38 - COMMERCIAL INVENTORY
**Audit.md section:** 45 (SECTION 42 - COMMERCIAL INVENTORY)

## 1. Direct answer: can the system model any of the listed inventory types?
| Inventory type the Audit.md asks about | Modelled? | Nearest legacy artefact |
| --- | --- | --- |
| Jersey placements | NO | - |
| Social posts | NO | - |
| Livestream placements | NO | - |
| YouTube integrations | NO | - |
| Events / appearances | NO | sessions exist but are internal training, not commercial appearances |
| Creator appearances | NO | - |
| Branded content | NO | - |
| Media assets | **Partially** | the public `media` bucket (a file store with no metadata) |
| Product placement in video | NO | - |
| Naming rights | NO | - |
| Category exclusivity | NO | - |
| Ambassador / retainer | NO | - |
| Content licensing | NO | - |
| Broadcast / stream integration | NO | - |
| Data / insight deliverables | NO | - |
| Jersey / kit ownership and inventory | NO | - |

**Verdict: the system cannot model commercial inventory at all.** The `media` bucket is a file
store, not an inventory: it has no concept of a placement, a unit, a period, an owner, a
contract, or a quantity.

## 2. Why inventory is the centre of the sponsorship domain
A sponsor does not buy "a relationship". A sponsor buys **N units of a named placement, within a
window, at a standard, with evidence**. Therefore the primitive that matters is:

```
InventoryItem          - a sellable unit: "jersey front logo", "2 Instagram posts / month",
                         "logo in every broadcast overlay", "4 hours of creator content"
  id, org_id, name, type, unit_definition, rate, currency, period,
  available_from, available_to, quantity_total, quantity_sold,
  restrictions (category exclusivity, territory, platform)

ContractObligation     - a contractual commitment to deliver a quantity of an InventoryItem
  id, contract_id, inventory_item_id, quantity, due_date, owner_person_id,
  status, approval, proof_asset_id, published_at, performance

Deal                   - the commercial agreement
  sponsor_id, value, currency, term, status, payment_schedule

Invoice                - the receivable
```

Raptor has **none** of these five.

## 3. Findings

### F-INV-01 - CRITICAL: no inventory primitive exists
**Evidence.** absence of any table, type or concept representing a sellable placement.
**Impact:** sponsor value cannot be quantified, sold, tracked, or proven. The commercial domain
cannot be built on the current foundation.
**Severity:** CRITICAL | **Confidence:** HIGH

### F-INV-02 - HIGH: the only asset store has no ownership or metadata
**Evidence.** the `media` bucket; app/dashboard/media/page.tsx (6,110 B) lists objects and
opens them; objects are created by an unauthenticated endpoint with an attacker-chosen path
(20_STORAGE.md F-STO-01).
**Impact:** there is no asset register, so sponsor proof, content assets and internal documents
are indistinguishable and ungoverned.
**Severity:** HIGH | **Confidence:** HIGH

### F-INV-03 - MEDIUM: the media bucket is public
**Evidence.** automation-scripts/08:26-33 (public: true) and the app re-creates it as public
(app/api/media/upload:59).
**Impact:** anything a sponsor would consider confidential (campaign plans, unreleased
creative, pricing) stored there is world-readable. This is a direct commercial-confidentiality
risk.
**Severity:** MEDIUM | **Confidence:** HIGH

## 4. Verdict
**BUILD NEW** as the foundation of the commercial domain, specified in
70_FUTURE_SPONSORSHIP.md. The inventory model must be **tenant-configurable** (an organisation
defines its own placement catalogue) and **tiered by team/creator/event** so that a deal can
cover "all rosters" or "one creator" without duplicating obligations.
