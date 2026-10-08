# 32 - COMPENSATION
**Audit.md section:** 39 (SECTION 36 - COMPENSATION)

## 1. Direct answer to the Audit.md question
| Compensation type | Supported | Evidence |
| --- | --- | --- |
| Salaries | NO | no salary, wage, rate or pay field in any of the 43 SQL files |
| Bonuses | NO | no bonus entity |
| Prize shares | NO | winnings is team-level with no player_id and no split |
| Commissions | NO | - |
| Revenue shares (creator / streamer) | NO | - |
| Reimbursements | NO | - |
| Allowances / per diem | NO | - |
| Stipends for players | NO | - |
| Sponsorship revenue share with players | NO | no sponsorship domain at all |
| Contract values | NO | no contract entity |
| Payment records | NO | - |
| Payroll period / payslip | NO | - |
| Currency | NO | money is integer; rupee symbol hardcoded |

**Verdict: compensation is entirely absent.** The only money that flows anywhere near a person is
a team-level winnings.amount_won, and it is never distributed.

## 2. Adjacent capabilities that are NOT compensation
| Capability | Why it is not compensation |
| --- | --- |
| user_agreements | A legal ACCEPTANCE record (role, version, IP, UA, timestamp) - a compliance artefact, not a pay instrument |
| tryout_selections | Records the outcome of recruitment. No terms, no money |
| slot_expenses | An organisational cost, not a person-level payment |
| tier_defaults | A price list |

## 3. Why this matters more here than in most industries
1. **Prize-money splits** - usually a percentage between players, coaches and staff, sometimes
   per-head, often renegotiated retroactively. Requires a split agreement attached to a person or
   squad, a per-event calculation, an approval, and a payout record.
2. **Player stipends / salaries** - monthly, often in a weak currency, frequently paid to a
   personal account or in kind (device, internet, food).
3. **Streamer / creator revenue share** - a percentage of platform or sponsorship revenue.
4. **Sponsorship-linked bonuses** - payable on campaign delivery.
5. **Content and appearance fees** - per campaign, per deliverable.
6. **Multiple simultaneous relationships** - a player can be on a roster, stream for the org,
   create content and coach a junior team at the same time. The current users.role enum (one
   value) and users.team_id (one value) cannot represent this at all.
7. **Minors** - a large share of the player base, with a wholly different legal and payroll
   treatment (guardian consent, blocked accounts, jurisdiction-specific rules).
8. **Cross-border payment** - paying a player in Germany or Brazil runs into FX, withholding and
   banking-access constraints.

## 4. Findings

### F-COMP-01 - CRITICAL: no compensation model at all
**Evidence.** exhaustive absence. A search for salary / wage / pay / bonus / commission /
stipend / reimburse / allowance / payslip / payroll across all SQL and TS returns nothing
relevant.
**Impact:** the platform cannot record what it owes a person, cannot calculate what it owes, and
cannot evidence what it paid. In an esports organisation this is simultaneously a legal, tax,
contractual and trust failure. It is the single largest functional gap between Raptor and the
target product.
**Severity:** CRITICAL | **Confidence:** HIGH

### F-COMP-02 - HIGH: the data model cannot represent multiple simultaneous roles
**Evidence.** users.role is a single enum; users.team_id is a single FK; rosters allows many rows
but is never joined to a role.
**Impact:** a player who is also a streamer and a creator must be modelled as three users rows or
as one row with an arbitrary role - both wrong. Compensation, contracts, attendance and
permissions all key off this single field, so the error propagates everywhere.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** see 62_PEOPLE_MODEL.md (a universal Person with many Engagements) and
65_FUTURE_PAYROLL.md.

### F-COMP-03 - HIGH: the absence of a contract entity makes compensation unenforceable
**Evidence.** no contract table. The only legal artefact is user_agreements (scripts/00:117-130),
which stores a version number and an acceptance timestamp but NOT the content, NOT a hash, NOT
the document and NOT the author - and the content itself lives in admin_config, which has no RLS
(13_RLS_SECURITY.md F-RLS-04).
**Impact:** there is no enforceable record of what terms were accepted. Compensatory terms (what
a player is paid, what share of prize money they receive) are not recorded at all, let alone
signed.
**Severity:** HIGH | **Confidence:** HIGH

## 5. Verdict
**BUILD NEW - this is a greenfield domain, not a migration.** The critical design decision is the
OUTSOURCING BOUNDARY: the platform should be the system of record for ENTITLEMENTS (what a person
is contractually owed, and why), while an external payroll / contractor-payment provider executes
PAYMENTS and issues PAYSLIPS. Country-specific payroll, tax withholding, social-security
contributions and minor-specific rules cannot be responsibly implemented from scratch, and the
regulatory surface is large and jurisdiction-dependent. See 65_FUTURE_PAYROLL.md.
