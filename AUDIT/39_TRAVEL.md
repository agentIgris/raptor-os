# 39 - TRAVEL
**Audit.md section:** 46 (SECTION 43 - TRAVEL)

## 1. Status: ABSENT as a domain. Only a faint trace exists.
| Travel capability | Present | Trace in the legacy system |
| --- | --- | --- |
| Trip / event | NO | sessions.session_type = tournament is a training-schedule row, not a trip |
| Traveller | NO | - |
| Flight | NO | - |
| Hotel | NO | - |
| Visa / travel document | NO | - |
| Ground transport | NO | - |
| Per diem / allowance | NO | - |
| Travel budget | NO | - |
| Travel expense | NO | - |
| Booking | NO | - |
| Itinerary sharing | NO | - |
| Duty of care / check-in | NO | - |
| Reimbursement | NO | - |

**The only trace:** `slots` represent a purchased entry to an offline event on a given `date`
(`scripts/00:137-150`), and `slot_expenses` records what it cost. So the system knows "we sent a
team to an event on date X and it cost Y" - but nothing about who travelled, how, at what cost
breakdown, or with what documents.

This is a striking gap for an organisation whose players compete offline: **international
travel with minors is one of the highest-risk operational activities in esports**, requiring
flights, accommodation, visas, minors' travel consent, duty of care, per diems and reconciliation
- and none of it is modelled.

## 2. Findings

### F-TRV-01 - HIGH: offline events are not modelled, so travel cannot attach to anything
**Evidence.** no event/competition entity (28_TOURNAMENTS.md). slots is a purchase record with a
date and free-text organiser.
**Impact:** travel would have to hang off a slot with no event context (no venue, no country, no
dates range, no attendees), so it cannot be planned, budgeted, or reconciled.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** build `events` (or reuse the competition model) first; travel attaches to an
event participation.

### F-TRV-02 - HIGH: minors' travel is unaddressed
**Evidence.** users.date_of_birth exists and is collected at onboarding
(`lib/profile-utils.ts:180`) with no age logic; there is no guardian entity, no consent document,
no travel-consent artefact, no minor flag.
**Impact:** taking a minor abroad requires parental consent, sometimes notarised, plus possible
ETA/Schengen/UK ETA processes and unaccompanied-minor airline rules. None of this is
represented, so the organisation has no way to demonstrate compliance.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** 92_COMPLIANCE.md and 64_FUTURE_HR.md.

### F-TRV-03 - MEDIUM: no per diem or allowance concept
**Evidence.** absence; money is only slot_expenses and winnings (31_FINANCE.md).
**Impact:** the daily allowance for a player's travel day is unmanaged, so it is either unpaid
(an employment-law problem) or paid outside the system (no reconciliation).
**Severity:** MEDIUM | **Confidence:** HIGH

### F-TRV-04 - MEDIUM: no expense or reimbursement mechanism at all
**Evidence.** absence.
**Impact:** a player who fronts a flight has no way to be reimbursed, and the organisation has no
receipt-capture or approval workflow. This is a common and expensive failure mode for small
esports organisations.
**Severity:** MEDIUM | **Confidence:** HIGH

## 3. Verdict
**BUILD NEW** (71_FUTURE_TRAVEL.md). The domain is a good candidate for partial outsourcing:
booking and duty-of-care workflows can be supported by a travel-management integration, while
the platform remains the system of record for who is travelling where and when, the budget, the
per diem policy, the documents (including minors' consent), and the reconciliation.
