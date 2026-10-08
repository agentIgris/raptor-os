# 90 - BUSINESS GAP ANALYSIS (supplementary)
**Audit.md section:** 93 (SECTION 90). Business-facing companion to `86_MARKET_GAP.md` (SECTION 91).
`86_MARKET_GAP.md` compares against **other vendors**. This document compares against **what an
esports organisation actually has to do**, and finds the gaps inside Raptor itself.

## 1. The organisation's operating year, and what Raptor supports
A real esports organisation must execute these. Coverage is against the current product.

| # | Business activity | Coverage | Blocking gap |
| --- | --- | --- | --- |
| 1 | Recruit players (tryouts) | **PARTIAL** - model strong, plumbing broken | 5 of 6 stages unreachable; applicant cannot see status; no offer/contract/onboarding |
| 2 | Sign players to a contract | **SHELL** | Unprovable acceptance; no template, no version, no expiry, no renewal |
| 3 | Register players with the game publisher | **NONE** | No entity for it |
| 4 | Collect entry fees / buy tournament slots | **SHELL** | A purchase ledger, not participation; oversellable; no invoice |
| 5 | Run practice and training | **PARTIAL** | `session_time text`; 4 trigger definitions; no plan/block; not idempotent |
| 6 | Record attendance | **PARTIAL** | No uniqueness, DELETE broken, no real timestamps |
| 7 | Enter and correct results | **PARTIAL** | 5 entry forms; no `updated_at`; no audit; OCR can fabricate |
| 8 | Publish a roster and standings | **SHELL** | Client-side aggregation; `total_winnings` always 0 |
| 9 | Compete in tournaments | **NONE** | No event, match, opponent, bracket, or result entity |
| 10 | Receive prize money | **SHELL** | Recorded at team level; **never allocated**; no currency |
| 11 | Pay players and staff | **NONE** | No compensation, no payroll, no payment |
| 12 | Manage sponsors | **NONE** | Intake via a Discord relay; no deal, obligation, or evidence |
| 13 | Sell commercial inventory | **NONE** | No placements, no rates, no availability |
| 14 | Produce content | **NONE** | A public webhook; no calendar, no piece, no metric |
| 15 | Run creator careers | **NONE** | Single role per person makes it unrepresentable |
| 16 | Manage HR and contracts | **NONE** | No employment record, no leave, no document |
| 17 | Handle minors | **NONE** | No consent, no guardian, no document expiry, no load limit |
| 18 | Book travel | **NONE** | No event to attach travel to |
| 19 | Manage hardware and facilities | **NONE** | Only self-reported device strings |
| 20 | Assign work and automate it | **NONE** | No task; 16 hardcoded triggers with no execution log |
| 21 | Report to the team and the owner | **PARTIAL** | 3 of 7 categories; no finance, no contracts, no sponsors |
| 22 | Answer a dispute | **NONE** | No audit log |
| 23 | Prove compliance | **NONE** | No export, no erasure, no consent, no retention |
| 24 | Onboard a new paying customer | **NONE** | No tenancy, no provisioning, no billing |
| 25 | Attract players via a public site | **SHELL** | Single org, hardcoded, fabricated stats |

**Coverage: 0 of 25 business activities are fully supported. 11 are partial, 14 are absent.**
Source: this audit's per-domain documents, §§ 26-48.

## 2. The financial chain, end to end
The most important business process in esports, and what exists at each step:

```
FAN pays an entry fee
  -> POST /api/slots                     creates a row; NO invoice, NO payment, NO receipt
  -> team competes                       NO event/match/result entity exists
  -> prize pool is published             teams.prize_pool = integer, no currency
  -> money is received                   winnings row, TEAM level, amount only
  -> money is split between players      *** DOES NOT EXIST ***
  -> money is taxed                      *** DOES NOT EXIST ***
  -> money is paid                       *** DOES NOT EXIST ***
  -> the split is proven in a dispute    *** DOES NOT EXIST ***
```

**7 steps. 1 is partially there, 2-4 are improvised in Discord and spreadsheets, and 3 of them -
the ones that create legal and financial exposure - do not exist at all.** This is the single
biggest business gap in the product, and it is also the market's (`86_MARKET_GAP.md` §3 #1).

## 3. The people chain, end to end
```
Recruit (tryout)                  PARTIAL - 5 of 6 stages broken
Register the identity             auth row only; no person record
Record the relationship           users.team_id AND rosters (two sources of truth)
Sign a contract                   world-writable blob, no hash, editor 403, fails open
Record compensation               *** DOES NOT EXIST ***
Record the roster share           *** DOES NOT EXIST *** - so the prize split is impossible
Handle a minor                    *** DOES NOT EXIST ***
Track a document expiry           *** DOES NOT EXIST ***
Offboard                          hard delete, cascading away history
```
**9 steps. 2 are partial, 1 works, 6 do not exist.** A person is a login, not an employee.

## 4. The commercial chain, end to end
```
A sponsor enquires                 unauthenticated Discord relay
Qualify the lead                  *** DOES NOT EXIST ***
Sign a deal                       *** DOES NOT EXIST ***
Define the deliverables           *** DOES NOT EXIST *** - no inventory concept
Schedule the deliverables         *** DOES NOT EXIST ***
Deliver                           *** DOES NOT EXIST ***
Prove delivery                     *** DOES NOT EXIST ***
Invoice                           *** DOES NOT EXIST ***
Reconcile against actual reach    *** DOES NOT EXIST ***
```
**9 steps. 1 is an unauthenticated relay. 8 do not exist.** Sponsorship revenue is entirely
unmanaged, which is why an owner cannot answer "what do we owe a sponsor?".

## 5. Gap priority by business impact
| Rank | Gap | Business impact | Effort | Blocking? |
| --- | --- | --- | --- | --- |
| 1 | Prize allocation | The org cannot pay its players correctly or prove it | Medium | **Yes - blocks every payment** |
| 2 | Roster share at a point in time | Allocation is impossible without it | Low | **Yes - prerequisite for #1** |
| 3 | Provable contracts | Legal exposure on every engagement | Medium | **Yes - blocks enterprise** |
| 4 | Multi-tenancy | Cannot sell to more than one org | High | **Yes - blocks the SaaS thesis** |
| 5 | Complete the tryout pipeline | The best-performing feature does not work | Low-Medium | No - but it is the current value prop |
| 6 | Sponsor obligations | Sponsorship renewals and revenue | Medium-High | No - but it is a differentiator |
| 7 | Export + erasure | Cannot onboard a customer or answer a request | Low | **Yes - blocks migration** |
| 8 | Audit log | No dispute, no accountability, no compliance | Medium | **Yes - blocks enterprise** |
| 9 | Compaction of compensation/payroll | Retention of players and staff | High | No |
| 10 | Content and creator | The dual-career path | Medium | No |
| 11 | HR and minors | Legal and safeguarding | Medium-High | **Yes - blocks minors** |
| 12 | Events, travel, assets, facilities | Operational completeness | Medium | No |
| 13 | Tasks and workflows | Manual operations remain manual | Medium | No |
| 14 | Observability and tests | Every change is unverifiable | Low | **Yes - blocks safe delivery** |

## 6. The commercial conclusion
* The product currently supports **coordination** and is paid for as coordination.
* The business is asking it to support **money, obligations and people** - and it supports none of
  the three.
* The gap is therefore not "more features". It is **a different product category**: from a
  team-coordination tool to an organisation system of record (`95_FINAL_RECOMMENDATION.md` §6).
* Two of the top three gaps (allocation, roster share) are **deterministic and cheap**. They are
  worth more to a customer than the entire current feature set, and they are the reason to
  rebuild rather than extend.

## 7. What must be asked before building
1. Which of these 25 activities does the customer's **first** paying user perform weekly? That
   determines the Phase 2-3 scope.
2. Is prize allocation done by the organisation today, and how? If it is done in a spreadsheet,
   the spreadsheet is the product to beat - and it should be interviewed.
3. Does the customer want the platform to **pay** players, or only to **calculate and record** the
   split? This changes the regulatory scope substantially (`92_COMPLIANCE.md`).
4. Are minors in the paying tenant's roster? If yes, HR and safeguarding move from Phase 4 to
   Phase 1.
5. What does the customer currently pay an agency or a bookkeeper to do that this system would
   replace? That number is the price ceiling.
