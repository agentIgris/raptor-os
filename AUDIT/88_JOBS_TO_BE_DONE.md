# 88 - JOBS TO BE DONE
**Audit.md section:** 96 (SECTION 93)

## 1. Format
Each job is stated as: **When** [situation] **I want to** [motivation] **so I can** [expected
outcome]. Grouped by the persona who holds the job. "Today" is verified behaviour; "V2" is the
requirement.

---

### A. Player jobs
| # | Job | Today | V2 |
| --- | --- | --- | --- |
| A1 | When I log in, I want to see my own performance and attendance, so I can trust the numbers | Numbers exist but are computed client-side and one metric is permanently 0 (`46_ANALYTICS.md`) | Server-computed metrics with a definition |
| A2 | When I am on a roster, I want my contact details private, so I am not targeted | **Not possible** - 100% PII readable, `zero/anon/RLS=true` (`20_STORAGE.md` F-STOR-01) | Self-service visibility, default private |
| A3 | When I leave, I want my data deleted, so I am not exposed | Not possible - no soft delete, no erasure workflow (`50_DATA_RETENTION.md`) | Erasure with a legal-hold exception |
| A4 | When I earn prize money, I want to see my share, so I know what I am owed | Not possible - `winnings` is team-level, never allocated (`31_FINANCE.md` F-FIN-01) | `PrizeAllocation` with an audit trail |
| A5 | When a tryout result is published, I want to see my status, so I know where I stand | Not possible - applicants cannot read their own status (`29_TRYOUTS.md` F-TRY-04) | Applicant portal with notifications |
| A6 | When I sign an agreement, I want a copy I can keep, so I have proof | Content is editable; no hash (`33_CONTRACTS.md` F-CON-01) | Immutable version + hash + download |
| A7 | When I apply, I want one form, so I do not repeat myself | 4 public forms, each a separate entity | One application with a role choice |

### B. Coach / manager jobs
| # | Job | Today | V2 |
| --- | --- | --- | --- |
| B1 | When practice ends, I want to mark attendance in under 10 seconds | Slow, ambiguous, 4 trigger definitions, DELETE broken (`26_ATTENDANCE.md`) | One roster view, one tap, bulk actions |
| B2 | When I make a mistake, I want to undo it, so I do not corrupt the record | No undo, no `updated_at` | Correction events |
| B3 | When a result is disputed, I want to see who changed what, so I can settle it | No audit log at all (`49_AUDIT_LOGGING.md`) | Full audit on every sensitive action |
| B4 | When I add a player, I want them assigned to one team, so scope is unambiguous | Two sources of truth (`users.team_id` and `rosters`) | Effective-dated `TeamMembership` |
| B5 | When I plan a session, I want it to appear on everyone's calendar, so nobody misses | No calendar integration; Discord notify is ad hoc | `Session` + calendar integration |
| B6 | When I run a tryout, I want the stages to work, so recruitment is real | 5 of 6 stages unreachable (`29_TRYOUTS.md` F-TRY-01/02) | Complete state machine |

### C. Founder / owner jobs
| # | Job | Today | V2 |
| --- | --- | --- | --- |
| C1 | When a prize lands, I want to know who gets what, so I can pay people | Not possible | Allocation engine with an auditable calculation |
| C2 | When a contract ends, I want to be warned, so I am not exposed | No expiry tracking | Expiry calendar + notifications |
| C3 | When a sponsor asks for proof, I want to show deliverables, so I can invoice | No sponsorship entity | Obligations with evidence |
| C4 | When I report to a board, I want one financial picture, so I can be honest | No finance module | Ledger + reports |
| C5 | When I consider a new title, I want it without a rebuild, so I can expand | Single-title by construction | Multi-title core + per-title extension |

### D. HR jobs
| # | Job | Today | V2 |
| --- | --- | --- | --- |
| D1 | When I hire, I want a contract generated from a template, so I do not start from scratch | `user_agreements` is a hand-editable blob | Versioned templates, provable acceptance |
| D2 | When a player is a minor, I want guardian consent recorded, so I am compliant | Not possible - no consent, no guardian field (`64_FUTURE_HR.md`) | `GuardianConsent`, blocking for minors |
| D3 | When a document expires, I want a reminder, so I stay compliant | Not possible | Expiry + reminder |
| D4 | When someone leaves, I want an offboarding checklist, so nothing is missed | Not possible | Offboarding workflow |
| D5 | When a subject requests data, I want an export, so I meet the deadline | Not possible | Export + erasure |

### E. Finance jobs
| # | Job | Today | V2 |
| --- | --- | --- | --- |
| E1 | When I record an expense, I want an invoice attached, so I can justify it | `slot_expenses` has no invoice (`31_FINANCE.md` F-FIN-02) | Expense + attachment |
| E2 | When I run payroll, I want it computed from entitlements, so it is correct | Not possible | Entitlement-based payroll |
| E3 | When I report in another currency, I want correct conversion, so totals are meaningful | No currency column at all | Currency + rate snapshot |
| E4 | When money is paid, I want a ledger entry, so the books balance | No ledger | Double-entry ledger |

### F. Sponsorship jobs
| # | Job | Today | V2 |
| --- | --- | --- | --- |
| F1 | When a deal is signed, I want the obligations extracted, so nothing is missed | Intake via a Discord relay | Contract-to-obligation extraction |
| F2 | When an obligation is due, I want a reminder, so I deliver | Not possible | Obligation due dates + notifications |
| F3 | When I invoice a sponsor, I want proof of delivery, so I get paid | Not possible | Evidence per obligation |

### G. Creator jobs
| # | Job | Today | V2 |
| --- | --- | --- | --- |
| G1 | When I create and compete, I want one profile with both, so my career is coherent | Impossible - one `users.role` | Person + multiple roles |
| G2 | When I post, I want it tied to a sponsor obligation, so I can prove it | Not possible | `ContentPiece` linked to an obligation |
| G3 | When I check my reach, I want real metrics, so I can price myself | Not possible | Platform account snapshots |

### H. Admin / platform jobs
| # | Job | Today | V2 |
| --- | --- | --- | --- |
| H1 | When I onboard a customer, I want their tenant provisioned automatically, so it is instant | Not possible | Idempotent provisioning (`82_SAAS_BILLING.md`) |
| H2 | When something breaks, I want logs and alerts, so I can fix it fast | `removeConsole` deletes all production logs (`52_OBSERVABILITY.md`) | Structured logging, metrics, alerting |
| H3 | When a bug is reported, I want to reproduce it, so I can verify a fix | No test suite, no staging | Test pyramid + staging |
| H4 | When I support a user, I want scoped impersonation, so I can help without reading their data | Not possible | Time-boxed, audited impersonation |

---
## 2. Jobs nobody in the market serves (from `86_MARKET_GAP.md` §3)
| # | Job | Why it is unserved |
| --- | --- | --- |
| J1 | When a prize is won, I want the split computed and evidenced, so I can pay and defend it | Requires roster-effective-dating + a rules engine; generic payroll cannot |
| J2 | When a sponsor deal is signed, I want the deliverables turned into tracked obligations, so I deliver and invoice | Needs commercial inventory + contract parsing |
| J3 | When I operate in two currencies, I want correct totals, so I can report honestly | Everyone hardcodes one currency |
| J4 | When a player is a minor, I want the whole workflow to enforce consent and documents, so I am safe | Nobody models it; it is a real operational risk |
| J5 | When I am audited, I want to prove who did what, so I can answer | No competitor product documents an audit trail either - it is a differentiator |
| J6 | When I add a game, I want it without a rebuild, so I can expand | Single-title assumption is universal |

---
## 3. Prioritisation
| Priority | Jobs | Reason |
| --- | --- | --- |
| **P0 (blocking sale)** | C1, C2, D1, D2, D5, H1, plus J1, J2 | Money, legality, and provisioning; without these nothing can be sold to an organisation |
| **P1 (blocking daily use)** | A1, A2, A4, A5, B1, B2, B3, B4, B6 | The current product's users are here; these are cheap once the model is right |
| **P2 (differentiating)** | G1, G2, G3, C3, F1, F2, F3, J5 | The market gap |
| **P3 (scale)** | C4, C5, E1-E4, J3, J4 | Enterprise readiness |
| **Never** | Any job that requires fabricating a metric or weakening privacy | `app/api/public/stats` (`31_FINANCE.md` F-FIN-03) |

**Note the ordering:** the current Raptor feature set is almost entirely P3/P4 work (a
leaderboard, a PDF, a public page) while the P0 jobs are entirely absent. That mismatch is the
core finding of this audit.
