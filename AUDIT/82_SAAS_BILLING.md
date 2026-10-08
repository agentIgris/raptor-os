# 82 - SAAS BILLING (requirements only - NOT implemented)
**Audit.md section:** 89 (SECTION 86)

## 1. Starting position
**Nothing exists.** No subscription, no plan, no seat count, no invoice, no payment, no usage
record, no `Stripe` integration, no customer entity. `DATABASE_URL` and `ANALYTICS_API_KEY` are
documented and unused.

## 2. Product and pricing model
Billing is a **product decision**, not just an implementation. Recommended structure:

### 2.1 Plans
| Plan | Intended customer | Includes |
| --- | --- | --- |
| **Starter** | a single team, < 25 people, no creators | competitive operations, attendance, tryouts, basic reports |
| **Growth** | a multi-team org with creators | + HR, contracts, creator management, content, sponsorships, travel, assets |
| **Enterprise** | multiple legal entities, international | + SSO/SCIM, audit export, data residency, custom retention, SLA, dedicated support, custom integrations |
| **Platform fee (usage)** | any | metered: API calls, AI tokens, storage GB, outbound messages, social-sync calls |

### 2.2 Pricing dimensions
* **Base platform fee** per organisation, per month, by plan.
* **Seats** - priced on **active people**, not registered accounts, and **excluding** applicants
  (so a tryout funnel is not penalised). Clearly defined so customers can forecast.
* **Modules** - optionally licensed individually (creator management, travel, facilities) so a
  customer is not forced to buy what they do not use.
* **Usage** - only for genuinely variable costs (AI tokens, messages, storage, API calls), always
  with a visible forecast and a hard spend cap per organisation.
* **Annual discount** with a real saving, and a monthly option for small organisations.
* **Free tier** - a time-limited trial of Growth, **with export**, so the trial is credible.

### 2.3 Explicitly not priced
Trial/recruitment applications (growth is the point), read-only public API within a fair-use
allowance, and data export (a legal right, never a paid feature).

## 3. Requirements
### 3.1 Entities
```
Plan                      (seeded, versioned; features[], limits[], included_quotas[])
Subscription              (org_id, plan_id, status: trialing|active|past_due|canceled|
                           paused, seats, current_period_start/end, cancel_at_period_end,
                           trial_ends_at, provider, provider_subscription_id)
SubscriptionItem          (a metered component with a quantity and a unit price)
UsageRecord               (org_id, metric, period, quantity, aggregated from events)
Invoice                   (org_id, number, period, subtotal, tax, total, currency,
                           status: draft|open|paid|void|uncollectible, issued_at, due_at)
InvoiceLine               (description, quantity, unit_price, amount, plan_ref)
Payment                   (provider, provider_payment_id, amount, currency, status, paid_at,
                           failure_code)
CreditNote                (with a reason; refunds and goodwill)
TaxRate / TaxRule         (per legal entity and jurisdiction, applied at invoice time)
DunningSchedule           (the retry/escalation sequence for past_due)
UsageAlert                (threshold and hard-cap rules per org)
```

### 3.2 Rules
* **The provider is the source of truth for money.** The platform records the entitlement; the
  provider records the payment. A webhook from the provider - **signature-verified, idempotent,
  replay-safe** - is what changes a subscription's status. Never derive entitlement from a
  client-side success page.
* **The subscription gates access, not individual features scattered in code.** A single
  entitlement service answers "may this org use this module, and is it within quota", and it is
  consulted by the API and the navigation.
* **Seat changes are effective prospectively**, with a scheduled quantity change at the period
  boundary, so a mid-period hire is not back-billed.
* **Every state change is audited and produces a `billing.*` event**
  (`77_EVENT_ARCHITECTURE.md`).
* **Grace, not a hard cut-off:** a lapsed subscription moves to `past_due` with a grace window and
  **read-only** access, never to data loss or an immediate lockout. Data is never deleted for
  non-payment without an explicit, long, communicated process.
* **Usage is aggregated from the event stream**, not counted in request handlers, so it is
  accurate, reconcilable and cheap.
* **Self-serve**: plan change, seat change, invoice download, payment-method update, cancellation,
  and **full data export**. A customer must be able to leave.

### 3.3 Tax
* Calculated per legal entity and jurisdiction by the provider (Stripe Tax or equivalent), with
  the determination recorded; the platform does not implement tax rules
  (`66_FUTURE_FINANCE.md` §3.4).
* Tax IDs, exemptions and reverse-charge cases captured per entity.

### 3.4 Dunning
A defined sequence (card retry at 3/5/7 days, then email at 1/3/7/14, then a final notice, then
read-only) with every step an event and every step tenant-visible in the UI.

## 4. Implementation
* **Provider:** Stripe Billing (or equivalent) - subscriptions, metered billing, invoicing, tax,
  customer portal.
* **Webhook handling:** signature verification, an idempotency key, a bounded body, ordered
  processing with a dead-letter queue, and reconciliation against the provider's API on a schedule
  to catch missed webhooks.
* **Provisioning:** on `subscription.activated`, provision the tenant's defaults
  (`79_ORG_CONFIGURATION.md` §2), seed the roles (`63_ROLE_MODEL.md` §6), create the default
  notification rules (`78_NOTIFICATION_ARCHITECTURE.md` §7) and the default inventory catalogue
  (`70_FUTURE_SPONSORSHIP.md` §3). **Provisioning must be idempotent and replayable.**

## 5. What must never be true
* No feature is enforced only in the UI.
* No entitlement is decided from client-supplied state.
* No customer can lose data because of a payment failure.
* No usage figure is computed by counting in a request handler.
* No tax rule is implemented in the platform.

## 6. Migration from the legacy system
Nothing. Billing is entirely new, and it is a **precondition for charging anyone**.

## 7. Priority
**Blocking.** The product cannot be sold without it, and the entitlement service it introduces is
also the natural home for feature flags and per-tenant configuration gating.
