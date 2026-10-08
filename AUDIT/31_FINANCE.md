# 31 - FINANCE
**Audit.md section:** 38 (SECTION 35 - FINANCE DOMAIN)

## 1. Exhaustive inventory of every money-bearing object
| Object | Table / field | Semantics | Evidence |
| --- | --- | --- | --- |
| Slot purchase | slots.slot_rate integer CHECK (>= 0), number_of_slots integer CHECK (> 0) | price per slot x quantity | scripts/00:145-146 |
| Slot cost | slot_expenses(rate integer NOT NULL, number_of_slots integer DEFAULT 1, total integer NOT NULL) | the COST PAID; auto-created as rate x number_of_slots by trigger | scripts/00:174-185; automation-scripts/04:12-32 |
| Prize pool | prize_pools(total_amount integer NOT NULL, breakdown jsonb) | a pool for one slot | scripts/00:199-207 |
| Prize won | winnings(position integer CHECK (> 0), amount_won integer NOT NULL) | a TEAM-LEVEL prize | scripts/00:187-197 |
| Rate card | tier_defaults(tier text UNIQUE, default_slot_rate integer CHECK (> 0)) | price band to default slot rate | scripts/00:209-216, 544-550 |
| Public aggregate | app/api/public/stats:30, 59 SUM(slot_expenses.total) plus a hardcoded 37800 | published as "cost covered" | - |

**That is the entire financial model: five columns across four tables.** There are no other money fields anywhere in the 43 SQL files.

## 2. Accounting concepts: present vs absent
| Concept | Present | Note |
| --- | --- | --- |
| Double-entry / ledger | NO | no accounts, journal_entries, lines |
| Chart of accounts | NO | |
| Cost centre / department | NO | |
| Budget | NO | tier_defaults is a price list, not a budget |
| Invoice (out) / Bill (in) | NO | |
| Payment / settlement / reconciliation | NO | |
| Expense claim / reimbursement | NO | |
| Tax | NO | no rate, no withholding, no jurisdiction |
| Currency | NO | money is integer; rupee symbol hardcoded in the UI (README.md:168) |
| Accrual / pre-paid | NO | |
| Fixed asset / depreciation | NO | (see 40_ASSETS.md) |
| Approval / spend limits | NO | |
| Audit trail | NO | no actor on any financial row |
| Period / close | NO | |
| Recurring revenue | NO | |
| Prize distribution to persons | NO | winnings is team-level only |

## 3. Findings

### F-FIN-01 - CRITICAL: prize money never reaches a person
**Evidence.** winnings(team_id, slot_id, position, amount_won) - there is no player_id, no split,
no payout record, no payment status, no tax withholding.
**Impact:** in esports, prize money is typically shared between players and staff under a
pre-agreed split, and it is a contractual and tax event. The system records that a team won an
amount and then has no way to distribute, record or evidence that distribution. This is the single
largest financial capability gap in the system.
**Severity:** CRITICAL | **Confidence:** HIGH

### F-FIN-02 - HIGH: the entire financial dataset is readable by players
**Evidence.** six simultaneously active RLS policies grant players / team members SELECT on
financial tables: scripts/04:202-210 (slot_expenses), scripts/04:242-250 (winnings),
scripts/04:281-288 (prize_pools), scripts/13:223-231 (slot_expenses),
scripts/13:233-250 (winnings).
**Impact:** prize money and spend are disclosed to the whole roster. This contradicts
lib/role-system.ts:208-213, lib/dashboard-permissions.ts:75 and API_DOCUMENTATION.md:388, all of
which say players cannot view finances. The UI hides the page; the database does not enforce it.
**Severity:** HIGH | **Confidence:** HIGH

### F-FIN-03 - HIGH: real spend is published publicly, mixed with a fabricated number
**Evidence.** app/api/public/stats:30 selects every slot_expenses row with no limit; :59 computes
costCovered = 37800 + expensesSum; returned unauthenticated at :63-70.
**Impact:** (a) if any RLS gap exists, aggregate organisational spend is public; (b) a hardcoded
37800 is presented as if it were measured; (c) the number will be wrong for any future tenant.
**Severity:** HIGH (integrity) / MEDIUM (confidentiality) | **Confidence:** HIGH

### F-FIN-04 - HIGH: money is integer with no currency and incomplete non-negative checks
**Evidence.** slot_expenses.rate/total, winnings.amount_won, prize_pools.total_amount and
tier_defaults.default_slot_rate are all integer. Only tier_defaults has CHECK (> 0) and only
slots.slot_rate has CHECK (>= 0). slot_expenses.rate, slot_expenses.total,
winnings.amount_won and prize_pools.total_amount have NO non-negative check.
**Impact:** no minor units (fractional amounts impossible), no currency (multi-currency
impossible), and negative expenses or winnings are storable on four of six columns.
**Severity:** HIGH for a commercial SaaS | **Confidence:** HIGH
**Recommendation:** numeric(18,4) money plus an ISO 4217 currency column; explicit
CHECK (amount >= 0) where appropriate.

### F-FIN-05 - HIGH: get_team_performance_summary always reports zero winnings
**Evidence.** automation-scripts/01:119-123
  LEFT JOIN public.winnings w ON w.slot_id = p.slot AND w.team_id = p.team_id
performances.slot is the legacy column (no FK); winnings.slot_id is a UUID. The join can never
match, so total_winnings is always 0.
**Impact:** a financial metric is silently and permanently wrong, with no error to indicate it.
**Severity:** HIGH | **Confidence:** HIGH

### F-FIN-06 - MEDIUM: no actor, no approval, no audit on any financial mutation
**Evidence.** slot_expenses has no created_by; winnings has no actor; tier_defaults has no
updated_by; admin_config has no actor.
**Impact:** "who approved this spend?" is unanswerable. A blocker for board reporting and for any
external audit.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-FIN-07 - MEDIUM: no budget anywhere
**Evidence.** absence. tier_defaults is a rate card; team_monthly_stats (scripts/14) is a
performance rollup, not spend-vs-budget.
**Impact:** a CFO cannot answer "are we over budget for the BGMI roster this quarter?" - the
question that matters most in esports, where slot costs are lumpy and prize income episodic.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-FIN-08 - MEDIUM: no transaction boundaries
**Evidence.** POST /api/slots creates a slot and relies on a SECURITY DEFINER trigger to create
the expense - two separate operations with no shared transaction. app/api/admin/settings:116-119
deletes seven tables sequentially with no transaction and no per-statement error check.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-FIN-09 - LOW: expenses and winnings APIs are unbounded read-only projections
**Evidence.** app/api/expenses/route.ts (2,671 B) and app/api/winnings/route.ts (2,666 B) are
GET-only, unbounded, with no date range and no team filter in the query.
**Severity:** LOW | **Confidence:** HIGH

## 4. What a commercial esports organisation needs (gap list)
Chart of accounts; cost centres tied to teams and departments; budget envelopes with period
variance; purchase invoices with approval workflow; expense claims and reimbursements; supplier
invoices; prize income with per-recipient splits and tax withholding; payroll and contractor
payouts; sponsor receivables and ageing; bank feeds and reconciliation; multi-currency with FX at
transaction date; tax jurisdictions; accruals and pre-payments; fixed assets; P&L by team, cash
flow, budget variance, prize ledger; audit trail; immutable period close.

## 5. Verdict
**REPLACE.** The slot-cost ledger is worth migrating as historical data. The finance domain must
be designed properly. The pragmatic architecture for a SaaS is integration-first: the platform is
the system of record for operational and commercial FACTS (entries, prize income, obligations) and
syncs to an external accounting system (Xero / QuickBooks / Netsuite) which owns the ledger, tax
and statutory reporting. See 66_FUTURE_FINANCE.md.
