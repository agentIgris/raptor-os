# 65 - FUTURE PAYROLL (requirements only - NOT implemented)
**Audit.md section:** 72 (SECTION 69 - FUTURE PAYROLL)

## 1. Starting position
Compensation and payroll are **entirely absent** (`32_COMPENSATION.md`). There is no salary, no
bonus, no prize share, no reimbursement, no payroll period and no payment record anywhere in the
system.

## 2. The central design decision: what the platform owns vs what it delegates
| The platform OWNS (system of record) | An external provider OWNS |
| --- | --- |
| **Entitlements** - what a person is *contractually owed*, and the rule that produces it | **Execution** - actually moving money |
| Compensation agreements (base, retainer, prize share %, revenue share %, content fee, expense policy) | Payslip generation and delivery |
| Prize-income allocation rules and their per-event calculation | Statutory calculations: income tax, withholding, social security, National Insurance, PF/ESI |
| Expense policies, limits and per-diem rates | Bank/payment rails, KYC/AML screening of payees |
| Payroll **periods** and the approved, locked payroll run | Country-specific payroll filing and reporting |
| Approval workflow and the audit trail | Expense card feeds and accounting |
| Reconciliation: entitlements vs what the provider paid | - |
| Tax-withholding **determination** and the record of it | - |

**Rationale:** country-specific payroll is a large, fast-changing, legally-definitional
regulatory surface. Reimplementing it is neither responsible nor commercially sensible. The
differentiated, defensible value of the platform is the **entitlement engine** - especially the
**prize-money split calculation**, which is esports-specific and which no generic payroll system
models.

## 3. Requirements

### 3.1 Compensation structures
* `CompensationAgreement` attached to an `Employment`, effective-dated, with components:
  * **Base** - monthly/annual salary or stipend, amount + currency + pay schedule.
  * **Retainer** - a fixed guaranteed amount for a term.
  * **Prize share** - a percentage of prize income, or a per-head split rule, with scope
    (which events, which teams, effective dates). **The highest-value structure in esports.**
  * **Revenue share** - a percentage of creator/streaming revenue attributable to the org.
  * **Content / appearance fees** - per campaign or per deliverable, linked to
    `ContractObligation` (`70_FUTURE_SPONSORSHIP.md`).
  * **Sponsor-linked bonuses** - payable on campaign completion or on a performance threshold.
  * **Expense policy + per diem** - daily allowance by location and duration.
* Every component is effective-dated and versioned, so a mid-contract change never rewrites
  history.

### 3.2 Prize-money allocation (the esports-specific engine)
This must be a first-class, auditable calculation, not a spreadsheet.
```
PrizeIncome            (event, placement, gross amount, currency, source, received_at)
PrizePool              (per event: gross, deductions, net, tax withheld)
AllocationRule         (from the CompensationAgreement, resolved as at the event date)
  basis: percentage | per_head | fixed_plus_percentage | weighted_by_participation
  participants: roster at event date (from effective-dated TeamMembership) + staff assigned
Allocation             (one row per participant: basis amount, computed amount, currency,
                         rule_version, computed_at, computed_by)
Adjustment             (post-allocation corrections, always as new rows)
Payout                 (link to the provider; status, provider_reference, paid_at, fees)
Reconciliation         (sum(allocations) == net pool, with variance and an explanation)
```
Non-negotiable properties: **deterministic** (the same inputs always produce the same result),
**reproducible** (the exact rule version is stored on every allocation), **explainable** (a
human-readable derivation is rendered for disputes), and **immutable** (corrections are new rows).

### 3.3 Payroll runs
* `PayrollPeriod` (monthly/fortnightly/irregular), with a **lock** after approval.
* `PayrollLine` per person per period, generated from entitlements, with adjustments.
* Two-person approval (preparer + approver), enforced by a policy condition.
* Export to the provider; import back the provider's payment status and payslip reference.
* Reconciliation report: entitlements vs provider payments vs general-ledger postings.

### 3.4 Expenses and reimbursements
* `ExpenseClaim` with line items, `Receipt` asset, `ExpenseReport` (a batch), category, project
  or cost centre, approval chain by amount, and a `Paid` state from the provider.
* Policy engine: limits by category, role, and location; receipt required above a threshold;
  duplicate detection (hash + amount + date + merchant).

### 3.5 Tax and compliance
* `TaxTreatment` per legal entity and jurisdiction; withholding determination recorded per payout
  with a reason code; year-end reporting data handed to the provider.
* **Minors:** a restricted payout path (guardian account, blocked in some jurisdictions), and
  juvenile-employment rules per jurisdiction.
* Currency: amounts are `numeric(18,4)` + ISO currency; FX rate captured at the accrual date.

## 4. Recommended providers to evaluate (not a decision)
* **Contractor / global payouts:** Deel, Remote.com, Trolley, Airwallex, Wise Business.
* **Payroll by country:** Deel, Remote.com, Papaya, SD Worx, Gusto/ADP/Paylocity (US),
  Sage/Exact (UK), Zoho/Keka/greytiger (India).
* **Accounting sync:** Xero, QuickBooks, NetSuite.
* *Evaluation criteria:* minor/guardian payout support, multi-currency, presence in the
  organisation's target markets, API quality, and data-residency options.

## 5. Explicit non-goals
Do not build: tax calculation engines, statutory filing, banking, KYC/AML, pension/social-security
calculations, or payslip rendering.

## 6. Migration from the legacy system
There is nothing to migrate. `winnings` rows become `PrizeIncome` records (team-level, no
allocation); `slot_expenses` becomes an operational cost, not a payroll item. **All compensation
history must be re-established from contracts, because none was ever recorded.**

## 7. Priority
High, and **sequenced after** People, Organization, Roles and Contracts. The prize-allocation
engine is the piece worth building in-house.
