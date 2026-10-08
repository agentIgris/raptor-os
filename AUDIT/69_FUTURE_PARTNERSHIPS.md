# 69 - FUTURE PARTNERSHIPS CRM (requirements only - NOT implemented)
**Audit.md section:** 76 (SECTION 73)

## 1. Starting position
Absent (`37_SPONSORSHIPS.md`). A brand enquiry is relayed to a Discord webhook by an
unauthenticated endpoint, and the attachment lands in a world-readable bucket.

## 2. Requirements

### 2.1 Contacts and organisations
* `PartnerOrganization` (sponsor, supplier, agency, media, venue, esports org) with industry,
  size, region, and a `PartnerContact` per person (role, email, phone, preferred channel,
  timezone, and `do_not_contact` / consent flags).
* **Consent and lawful basis** recorded for every contact, with a suppression list - a hard
  requirement for B2B outreach in the EU and increasingly elsewhere.

### 2.2 Pipeline
* `Lead` (an unqualified enquiry) with `source` (inbound form, referral, event, outbound,
  partner), `owner`, `status`.
* `Opportunity`: `partner_id`, `title`, `expected_value` + currency, `currency`,
  `probability`, `expected_close_date`, `stage`, `loss_reason`, `competitors`, `next_step`.
* `Activity`: calls, emails, meetings, notes, tasks - the interaction history, with the actor.
* **Stage definitions are tenant-configurable** so the pipeline matches how that organisation
  actually sells.

### 2.3 Proposals and negotiation
* `Proposal` (versioned, with line items referencing `InventoryItem`s from
  `70_FUTURE_SPONSORSHIP.md`), `revision`, `status`, `valid_until`, `total` + currency.
* `NegotiationNote`, and an approval workflow for discount authority (policy threshold).

### 2.4 Deal and contract
* `Deal` converts to a `Contract` (`73_FUTURE_DOCUMENTS.md`) once terms are agreed; the CRM links
  to the contract, and the contract's obligations become the fulfilment plan
  (`70_FUTURE_SPONSORSHIP.md`).
* `Contract` is the single source of truth for value, term, payment schedule and obligations - the
  CRM never duplicates them.

### 2.5 Renewal and churn
* `RenewalOpportunity` with a target date derived from the contract end; a renewal workflow;
  `ChurnReason` capture at loss. **Renewal is a first-class motion in sponsorship** and is entirely
  absent from the legacy system.

### 2.6 Reporting
Pipeline by stage and value; win rate; average deal size; time-to-close; revenue by partner;
top partners; forecast. All from the metrics layer (`46_ANALYTICS.md`).

## 3. Intake (replacing the current Discord relay)
* Public enquiry form -> `Lead` row with consent captured, rate-limited, CAPTCHA-protected.
* Attachments stored as **private** `Asset`s, visible only to the assigned owner
  (`72_FUTURE_ASSETS.md`).
* Auto-acknowledgement **email** (the first email use case in the product -
  `23_EMAIL.md`), and an internal notification to the owner.
* Full audit trail: who submitted, when, what was attached.

## 4. Explicit non-goals
No email sending beyond templated sequences, no proposal-generation AI without human review,
no lead scoring model before sufficient data exists, no marketplace.

## 5. Migration from the legacy system
Nothing to migrate except historical enquiries, which exist only inside a Discord channel. If
those leads matter, they must be **manually re-entered** - a real, disclosable migration gap.

## 6. Priority
High. Sponsorship is typically the largest revenue line after prize money, and the CRM is the
entry point to it.
