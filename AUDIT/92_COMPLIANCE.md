# 92 - COMPLIANCE & REGULATORY
**Audit.md section:** 100 (SECTION 97)

> **Status: REQUIREMENTS ONLY. Not legal advice.** This maps obligations to product
> requirements. A qualified lawyer in each operating jurisdiction must confirm the final
> obligations. Nothing here is a compliance certification.

## 1. Applicability map
Raptor as built is a consumer-facing esports app. If it becomes a multi-tenant SaaS handling
employment, payroll, contracts and minors' data, the following apply:

| Regime | Trigger | Applies to V2? |
| --- | --- | --- |
| **GDPR** (EU/EEA) | Personal data of identified individuals | **Yes** - player names, emails, IPs, Discord ids, device telemetry, contract data |
| **UK GDPR / DPA 2018** | UK data subjects | **Yes** if serving the UK/EEA |
| **CCPA/CPRA** (California) | Personal information of CA residents, incl. sensitive PI and minors' data | **Yes** - the majority of a gaming audience |
| **PIPEDA / provincial** (Canada) | Commercial organisations | Likely |
| **India DPDP Act 2023** (in effect) | Digital personal data of individuals in India | Likely - the stated user base is India-centred |
| **COPPA** (US, <13) | Children under 13 | Only if under-13 users are accepted - the product should not accept them |
| **GDPR Art. 8 / child consent** | Minors 13-16 | **Yes** - minors are core to the audience |
| **Discriminatory-adverse-impact** rules | employment/contract decisions based on data | **Yes** once contracts and payroll exist |
| **Industry association rules** (e.g. tournament operator terms, publisher licences) | competitive data use, game-IP use, name/image likeness | **Yes** - often the strictest practical constraint |
| **Anti-money-laundering / prize rules** | prize payouts over a threshold | Only for the platform; typically the organisation's obligation |
| **Tax** (VAT/GST/sales tax, withholding on prize payments) | cross-border money movement | **Yes** for the platform's own billing (`82_SAAS_BILLING.md`) |

## 2. Data inventory and lawful basis
The single most important compliance finding: **Raptor cannot produce a record of processing
activities**, because it does not know what personal data it holds.
`profiles` alone contains **100% of the columns identified as PII** in this audit
(`20_STORAGE.md` F-STOR-01): full name, email, phone, Discord handle, `bgmi_id`, real address,
emergency contact, date of birth, government id numbers, bank details, device model, OS, IP, and
more - on a table that is **readable by `anon`**.

| Data category | Example fields | Lawful basis (typical) | Retention | Deletion mechanism |
| --- | --- | --- | --- | --- |
| **Identity** | name, email, phone, `bgmi_id`, Discord id | Contract | Life of engagement + 6y (tax/contract) | `ErasureRequest` workflow |
| **Government identifiers** | `aadhaar_number`, `pan_number`, `dl_number`, `passport_number` | Legal obligation / explicit consent | As required by law | Restricted store, crypto-shred |
| **Financial** | bank details, winnings, compensation | Contract / legal obligation | 6-8y (tax) | Restricted, ledger-immutable but PII erasable |
| **Employment/contract** | contracts, agreements, role history | Contract | Life of contract + limitation period | `Document` retention policy |
| **Sensitive/age** | `date_of_birth` (minors) | Explicit consent + guardian | Until age threshold + buffer | Auto-delete on majority + grace |
| **Device/telemetry** | device model, OS, IP, user agent | Legitimate interest (security) | Short - 90-180 days | Auto-purge |
| **Behavioural** | attendance, performance, messages, Discord | Contract / legitimate interest | Duration of engagement | Per-entity retention |
| **Communications** | `communication_logs`, Discord messages | Legitimate interest | 90 days - 1y | Auto-purge; unverified provenance flagged |
| **Special category risk** | political/religious inference, health | **Do not collect** | n/a | Prohibited fields |

## 3. Compliance requirement matrix
| Requirement | What it demands | V2 mechanism | Audit evidence of the gap |
| --- | --- | --- | --- |
| **Lawful basis & consent** | Record the basis; consent where required; withdrawable | `ConsentRecord` per purpose, revocable, versioned | No consent record anywhere (`64_FUTURE_HR.md`) |
| **Transparency / privacy notice** | A clear notice at collection, per purpose | Layered notice in-app + per-tenant branded notice | `app/legal/privacy/page.tsx` is a static page, not a real notice |
| **Data minimisation** | Collect only what is needed | PII in a separate, restricted `PersonSensitiveData` store | Everything in `profiles`, readable by `anon` (F-STOR-01) |
| **Purpose limitation** | Data used only for the stated purpose | Per-purpose consent + no secondary use | No enforcement; AI "insights" reuse performance data (`46_ANALYTICS.md`) |
| **Rights of access** | Subject access request within 30 days | `DataExportRequest` (machine-readable export) | **No export facility at all** (`48_IMPORT_EXPORT.md` F-IMP-03) |
| **Right to erasure** | Delete on request, subject to legal holds | `ErasureRequest` + soft delete + ledger exception | No soft delete in use; hard delete cascades (`50_DATA_RETENTION.md`) |
| **Right to rectification** | Correct inaccurate data | Self-service profile edit + audit of change | No audit; `updated_at` missing on most tables |
| **Right to portability** | Export in a portable format | CSV/JSON export per subject | Absent |
| **Right to object** | Object to processing, esp. marketing | Preference centre | Notification preferences are per-team, not per-person (`24_NOTIFICATIONS.md`) |
| **Automated decision-making** | Explain logic, allow human review, no solely automated decisions with legal effect | No consequential automated decisions; the "AI" is threshold rules, documented as such | Disclosed as AI in the UI (`46_ANALYTICS.md`) |
| **Minors' consent** | Verifiable parental consent where required; age-appropriate design | `GuardianConsent`; block under-13 accounts; restricted PII | **Absent** - no DOB validation, no guardian field |
| **Data localisation** | Store in the customer's region if required | Region-aware deployment + per-tenant residency config | Not considered |
| **Sub-processor transparency** | List processors; flow down DPA | Sub-processor register (Supabase, Vercel, Discord, Stripe, OpenAI) | Not maintained |
| **Breach notification** | Notify regulator/data subject within 72h (GDPR) | Incident runbook + `AuditLog` as the detection source | `20_incident_response/README.md` is an unowned template; `removeConsole` destroys evidence (`52_OBSERVABILITY.md`) |
| **Records of processing (RoPA)** | Maintain an inventory of processing | The audit's own data inventory, kept live | Impossible today |
| **Security of processing** | Appropriate technical measures | `91_SECURITY_ARCHITECTURE.md` §7 | 14 tables without RLS; 3 unauth endpoints |
| **Data transfers** | SCCs / adequacy for cross-border | Region pinning + SCCs | Not considered |
| **Deletion in backups** | Backups expire on a schedule | `RetentionPolicy` with a documented backup window | No retention at all (`50_DATA_RETENTION.md`) |

## 4. Employment, contracts and minors
| Obligation | Requirement | V2 mechanism |
| --- | --- | --- |
| **Written terms** | Every engagement has written terms | `Contract` + `AgreementAcceptance` with a content hash and an immutable version |
| **Provable acceptance** | Evidence of what was accepted, when, and by whom | Hash + IP + timestamp + audit; the legacy design is unprovable (`33_CONTRACTS.md` F-CON-02) |
| **Minimum age / guardian consent** | Under-18 handled with consent; under-13 excluded | `GuardianConsent`, blocking |
| **Working time / rest** | Training load limits for minors | `AttendanceRule` + a `max_weekly_minutes` policy |
| **Right to disconnect / rest days** | Enforced rest between sessions | `SessionType` + a `rest_days` rule |
| **Anti-discrimination** | No adverse decisions from protected attributes | Protected attributes excluded from scoring; documented |
| **Right to pay** | Transparent, itemised remuneration | `CompensationPlan` + `PayComponent` + published statements |
| **Worker classification** | Contractor vs employee determination | `OrgMembership.worker_class`, reviewed by counsel |
| **Tax withholding** | Withhold at the correct rate per jurisdiction | `TaxRule` per legal entity |

## 5. IP, likeness and gaming-specific
| Obligation | Requirement | Note |
| --- | --- | --- |
| **Name/image/likeness** | Consent for commercial use of a player's image | `ConsentRecord` with a `likeness` purpose; per-sponsor-purpose consent |
| **Game IP** | Tournament rules and publisher terms govern data use | A per-title `TermsProfile`; ingest only permitted data |
| **Anti-cheat / fair play** | Detection and sanction process | `PolicyViolation` + `Sanction`; never auto-ban on a single signal |
| **Broadcast rights** | Streaming a match may need consent | `EventRegistration` + `BroadcastConsent` |
| **Sponsorship disclosure** | Advertising disclosure obligations | `SponsorshipObligation` includes a disclosure deliverable |
| **Under-13 platform rules** | Most publishers and platforms prohibit | Block under-13 accounts outright |

## 6. Compliance as a sales asset
Compliance is a **procurement gate**, not a feature. A target customer - an esports organisation
handling employment contracts, prize money, and minors - will ask:
1. Where is my data stored, and can I choose the region?
2. Can you show me a DPA and a sub-processor list?
3. Can my employee export and delete their data?
4. Who at your company can see my contracts, and can I see the log?
5. Can you pass a penetration test and share the summary?
6. What is your breach notification process?
7. Can I get my data out, in a usable format, on demand?
Today Raptor can answer **none** of these. These are the exact questions that will lose the deal,
and each has a concrete V2 answer in §3.

## 7. Compliance acceptance criteria
1. A live record of processing activities and a sub-processor register.
2. A real, layered privacy notice per tenant, versioned.
3. Consent records for likeness, marketing, and data processing, revocable.
4. Export and erasure workflows that work end-to-end and are tested.
5. Guardian consent enforced for under-18s; under-13s blocked.
6. Documented retention per data category, with automated enforcement.
7. Incident response rehearsed, with a 72-hour notification capability.
8. Region-aware storage and a documented transfer mechanism.
9. A completed penetration test and a shared summary.
10. Written confirmation from counsel for each operating jurisdiction.

## 8. Verdict
Raptor as built would fail a basic data-protection review on multiple independent grounds
(anonymous read access to 100% PII, no consent, no retention, no export, no breach capability).
In V2 these are **product features with a compliance justification**, which makes them the easiest
features in the roadmap to fund.
