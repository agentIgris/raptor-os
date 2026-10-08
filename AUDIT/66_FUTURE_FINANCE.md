# 66 - FUTURE FINANCE (requirements only - NOT implemented)
**Audit.md section:** 73 (SECTION 70 - FUTURE FINANCE)

## 1. Starting position
Five money columns across four tables, all `integer`, no currency, no ledger, no budget, no
invoice (`31_FINANCE.md`). One metric (`total_winnings`) is permanently broken.

## 2. Architectural decision: ledger in the platform, statutory accounting in the provider
Two viable options:
| Option | Description | Verdict |
| --- | --- | --- |
| **A. Platform owns a double-entry ledger** | full chart of accounts, journal entries, period close, consolidation-ready output | Only if enterprise customers demand a real ledger in-product. High build and high domain risk. |
| **B. Platform owns operational/commercial facts; an external accounting system owns the ledger** | the platform records what the business *did* (entries purchased, prize income, obligations raised, invoices issued, approvals given) and syncs journal entries to Xero / QuickBooks / NetSuite, which owns the ledger, tax and statutory reporting | **RECOMMENDED** |

**Recommendation: Option B.** It is the standard pattern for vertical SaaS, it keeps the
differentiated domain logic (competitive operations, prize allocation, sponsor fulfilment) in
the platform and the commodity accounting in a best-of-breed system, and it is a hard requirement
for multi-jurisdiction tax.

## 3. Requirements

### 3.1 Money primitives
* `Money` = `numeric(18,4)` + ISO 4217 `currency` on **every** monetary column. No exceptions.
* `FxRate` captured at the accrual date; `Money` values stored in both transaction currency and
  a reporting-currency equivalent with the rate and its source.
* Rounding policy per currency, stored and applied consistently.

### 3.2 Chart of accounts and ledger (Option A, or a read-only mirror under Option B)
* `Account` (org-scoped; code, name, type: asset/liability/equity/revenue/expense, normal
  balance, is_group, parent) with a tenant-mappable default chart.
* `JournalEntry` + `JournalLine` (debit/credit, account, dimensions: department, team, campaign,
  project, cost centre). Balanced by construction (a deferred constraint).
* `FiscalPeriod` with open/close, and a lock after close.

### 3.3 Cost centres and dimensions
* `CostCentre` attached to `Department` and optionally `Team` (`61_ORGANIZATION_MODEL.md`).
* Every transaction carries dimensions so "spend on the BGMI roster" and "spend on the content
  team" are answerable.

### 3.4 Budgets
* `Budget` (period, scope: org/department/team/category) -> `BudgetLine` (account, amount) with
  **period variance** reporting (budget vs actual vs committed vs forecast).
* Approval workflow; budget lock on close.

### 3.5 Procurement and payables
* `Vendor` / `Supplier`.
* `PurchaseRequest` -> `Approval` (threshold-based) -> `PurchaseOrder` -> `GoodsReceipt` ->
  `VendorInvoice` (with a **three-way match**: PO vs receipt vs invoice) -> `Payment`.
* This replaces the legacy slot-purchase ledger with a real commitment chain
  (`28_TOURNAMENTS.md`).

### 3.6 Receivables and sponsor billing
* `Customer` (sponsor) -> `Contract` -> `Invoice` (from delivered `Deliverable`s or a schedule)
  -> `Payment` -> `CreditNote`.
* **Ageing**, dunning, and a revenue-recognition hook on delivery.

### 3.7 Prize income
* Per `65_FUTURE_PAYROLL.md`: `PrizeIncome`, `PrizePool`, `AllocationRule`, `Allocation`,
  `Payout`, `Reconciliation`. This is the esports-specific finance capability and belongs in the
  platform.

### 3.8 Expenses
* `ExpenseClaim` / `ExpenseReport` per `65_FUTURE_PAYROLL.md` §3.4, posting to the ledger on
  approval.

### 3.9 Financial reporting
* P&L by team, department, campaign and game; cash flow; budget variance; prize ledger; sponsor
  revenue by campaign; cost per player; cost per hour of content produced; runway.
* All computed from the metrics layer (`46_ANALYTICS.md`) so every figure has one definition and
  a version.

### 3.10 Controls
* Segregation of duties (preparer != approver), enforced by policy.
* Immutable posted documents; corrections by reversal.
* Full audit trail (`49_AUDIT_LOGGING.md`).
* Period close with a checklist.

## 4. Integration
* **Accounting:** Xero / QuickBooks / NetSuite - two-way sync of accounts, vendors, bills,
  invoices, payments, and journal entries.
* **Banking:** open banking feed for reconciliation; payment initiation via the provider.
* **Tax:** jurisdictional VAT/GST handled by the provider, with the determination recorded in the
  platform.
* **Payroll:** outputs from `65_FUTURE_PAYROLL.md`.

## 5. Migration from the legacy system
`slot_expenses` -> `PurchaseOrder` + `VendorInvoice` (historical, locked);
`winnings` -> `PrizeIncome` with **no allocations** (the split was never recorded - this is a real
historical data gap that must be disclosed to the customer);
`prize_pools.breakdown jsonb` -> `PrizePool` lines where parseable;
`tier_defaults` -> the commercial pricing configuration, not an account.

## 6. Explicit non-goals
No statutory tax calculation, no consolidation, no budgeting methodology, no treasury or cash
management, no multi-entity consolidation.

## 7. Priority
Medium-high. Required before the product can be sold to any organisation that has a finance
function - which is all of them.
