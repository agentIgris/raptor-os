# 74 - FUTURE AI (assessment only - NOT implemented)
**Audit.md section:** 81 (SECTION 78)
> *"Do NOT propose AI where deterministic software is more appropriate."*
This document is deliberately conservative. It also flags that the legacy system already
mislabels deterministic rules as "AI".

## 0. First: undo the existing mislabelling
Commit `7edd1ce` is titled *"Analytics: add AI-style heuristic insights"* and `ff9d767`
*"Analytics: enrich AI insights with detailed, actionable recommendations"*. The logic lives in
`components/analytics/analytics-sections.tsx` and is **deterministic threshold rules**
(`25_PERFORMANCE_DOMAIN.md`, `45_REPORTING.md` F-RPT-04, `46_ANALYTICS.md` F-ANL-04).
**Recommendation:** relabel as "insights" / "rules", or implement it properly as a model. Do not
ship heuristics under an AI label.

## 1. The test applied to every candidate opportunity
An opportunity qualifies for AI only if **all four** are true:
1. The task tolerates error (a human reviews or it is advisory only).
2. A deterministic implementation would be materially worse - i.e. the value is in judgement
   over unstructured or ambiguous input, not in computation.
3. The output can be verified against a source record.
4. Tenant and permission boundaries can be enforced on both the retrieval and the generation.

Anything failing (1) or (2) belongs in deterministic software.

## 2. Recommended opportunities (all advisory, all cited, all permission-scoped)

### A. Organisational search and question answering  ✅ qualifies
*Why it qualifies:* the user asks a question in natural language; the answer is assembled from
records the user may already read; a wrong answer is embarrassing, not dangerous.
*Shape:* permission-scoped retrieval over the tenant's own records -> a cited answer with links to
the source records and the as-of timestamp.
*Never:* answer from outside the tenant; answer a question the user's permissions do not cover;
state a fact without a citation.

### B. Contract and document extraction  ✅ qualifies
*Why:* unstructured PDFs, inconsistent formats, and a high volume of near-identical clauses.
*Shape:* extract parties, dates, values, currencies, obligations, notice periods, auto-renewal
terms, termination rights, and governing law into a **draft** structured record, with the source
page/section cited for every field, and a mandatory human confirmation before the record is
treated as authoritative.
*Never:* treat extracted terms as binding; a `ContractExpiring` detection from extraction must
still be verified against the authoritative `DocumentVersion`.

### C. Contract expiry and obligation risk detection  ✅ qualifies (as a prioritiser)
*Why:* a rules engine cannot read a 40-page MSA; a model can summarise the renewal and notice
deadlines, and the deterministic expiry engine then tracks them.
*Shape:** the deterministic `expiry_at` field is the system of record.** The model only
prioritises and extracts candidates. This is the "AI proposes, software disposes" pattern.

### D. Unstructured feedback summarisation  ✅ qualifies
*Why:* scrim review notes, coach comments, interview notes, sponsor feedback, support tickets.
*Shape:* summarise and tag, cite the source, never auto-file into a record without confirmation.

### E. Anomaly detection  ✅ qualifies
*Why:* patterns across many rows that rules would never enumerate.
*Shape:* attendance anomalies (a sudden absence pattern), duplicate-submission detection,
unusual expense patterns, unusual login patterns.
*Never:* used as the sole basis for an employment, disciplinary or financial decision. Always
"flagged for review" with the contributing records listed.

### F. Sponsor reporting narrative  ✅ qualifies (advisory only)
*Why:* translating obligation status and metrics into a readable summary is judgement over
structured data.
*Shape:** every number in the output is read from the metrics layer and cited.** The model may
only add narrative, never compute. A report pack is generated server-side and stored as an
immutable `Document` (`70_FUTURE_SPONSORSHIP.md` §6).

### G. Drafting assistance  ⚠ qualifies with strict constraints
*Scope:** drafting a first version of a job description, an offer letter, a policy, a sponsor
proposal, a travel checklist, a tryout invitation.
*Never:* auto-send anything. Every output is a draft requiring review by an authorised human, and
the reviewed version becomes the `DocumentVersion` with the author recorded.

### H. Translation  ⚠ partial
*Why:* user-facing help content and internal notes translate well.
*Never:* legal documents, contracts, agreements, or anything requiring a jurisdiction-specific
approved version (`59_INTERNATIONALIZATION.md` §3.5, `73_FUTURE_DOCUMENTS.md` §3.3). Machine
translation of a contract is a liability, not a feature.

### I. Conversational assistant over the org's own data  ⚠ qualifies with a hard boundary
*Scope:* "what is our spend on the BGMI roster this quarter", "which contracts expire in 30 days",
"who is unassigned to a team". Read-only, cited, permission-scoped.
*Never:* allow a write path through the assistant in v1. Writes go through an explicit, confirmed
UI action.

## 3. Explicitly NOT AI (deterministic software is strictly better)
| Need | Why AI is wrong |
| --- | --- |
| Money, prize allocation, payroll | Must be exact, reproducible and auditable. A model cannot do this. `65_FUTURE_PAYROLL.md` |
| Contract expiry tracking | A date field beats a model. Use a model only to *extract* the candidate date |
| Attendance calculations | Deterministic arithmetic on a defined rule. `26_ATTENDANCE.md` |
| Performance statistics and leaderboards | Deterministic aggregation. `46_ANALYTICS.md` |
| Permissions and authorisation decisions | Security-critical and must be deterministic and testable. `63_ROLE_MODEL.md` |
| Tax calculation | Statutory and jurisdiction-specific |
| Notification routing | Deterministic rules. `78_NOTIFICATION_ARCHITECTURE.md` |
| Data export, erasure, retention | Legal obligations require exactness |
| Currency conversion | Use a rate table with a timestamp, not a model |
| Any eligibility or disciplinary decision | Never a model. Human decision, model only as a flag |
| Deduplication | Deterministic keys, plus fuzzy matching as a *candidate* only |
| Report totals | From the metrics layer, always |

## 4. Platform requirements for AI
* A first-class `AI` module (`90_DOMAIN_ARCHITECTURE.md`) with a provider abstraction, per-tenant
  model and key configuration in a secret store, per-tenant token budgets, and a full audit of
  every call (actor, purpose, retrieved record ids, model, tokens, latency, cost).
* **Retrieval is permission-scoped at query time**, using the same policy engine as the rest of the
  product - a vector index is not an access-control boundary.
* **Citations are mandatory** in the output schema; a response without citations is a bug.
* **Determinism and reproducibility:** pin the model version, record it, and allow replay of a past
  answer for audit.
* **Evaluation before launch:** a golden dataset per use case (`74` is complemented by the
  `agent-evals` discipline), with regression gates in CI.
* **Fallbacks:** every AI path degrades to a deterministic path or an honest "not available" -
  never to a fabricated answer.

## 5. Verdict / status
**ASSESSMENT ONLY.** No AI is implemented. The recommended order is A (search), then B/C
(contracts), then D, then E, then F. Everything in §3 must never be AI.
