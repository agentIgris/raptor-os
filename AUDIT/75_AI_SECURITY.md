# 75 - AI SECURITY (requirements only - NOT implemented)
**Audit.md section:** 82 (SECTION 79)
Audit.md requires future AI to: respect tenant boundaries, respect permissions, never expose
unauthorised data, cite source records, distinguish facts from recommendations, never invent
financial data, never invent contract terms, log sensitive AI actions, and protect confidential
information. Each is addressed below with a control and a test.

## 1. Controls
| # | Requirement | Control | Test |
| --- | --- | --- | --- |
| 1 | **Respect tenant boundaries** | every retrieval query carries `org_id = current_org_id()`; the vector store is partitioned per tenant; the model never receives a raw row without a tenant filter applied server-side | a retrieval test with two seeded tenants asserting zero cross-tenant rows in the context payload; a prompt-injection test attempting to read tenant B |
| 2 | **Respect permissions** | the same policy engine as the rest of the product filters retrieval **at query time**; results are post-filtered; the model has no tool that can read outside the granted set | a permission-matrix test per use case; a "can the assistant reveal a document the user cannot open" test |
| 3 | **Never expose unauthorised data** | no raw PII in prompts unless the user may see it; field-level redaction before the model; no training on tenant data | a redaction unit test suite over the payload builder |
| 4 | **Cite source records** | the output schema **requires** `citations[]` with record ids; a response with no citation is rejected by the API | a schema-validation test; a golden-dataset check that 100 % of factual claims are cited |
| 5 | **Distinguish facts from recommendations** | the output has separate `facts[]` (each with a citation) and `recommendations[]` (each labelled `advisory`), and the UI renders them differently | a schema test; a UI review checklist |
| 6 | **Never invent financial data** | **hard prohibition**: the model may not emit a number that was not present in the retrieved context. A post-processor rejects any numeric token in the output that does not appear in the cited records | a deterministic numeric-token check; a golden-dataset suite of financial questions with exact expected values |
| 7 | **Never invent contract terms** | extracted terms are a **draft** structured record requiring human confirmation; the model may not write to a `Contract`; every extracted field carries a source page/section citation | a test asserting the model has no write tool for contracts; a citation-completeness test |
| 8 | **Log sensitive AI actions** | an immutable `ai_invocations` record: actor, org, purpose, use case, model + version, prompt hash, retrieved record ids, citations returned, tokens, latency, cost, whether a human confirmed the output, and the resulting action | a test asserting every AI call writes exactly one record |
| 9 | **Protect confidential information** | tenant-scoped encryption; no cross-tenant model fine-tuning; per-tenant key management; a documented data-processing agreement with the model provider; retention limits on prompts; no prompt content in application logs | a config test; a DPA checklist |

## 2. Threat model
| Threat | Mitigation |
| --- | --- |
| **Prompt injection via stored content** (a contract or a sponsor note containing instructions) | treat all retrieved content as **data, never instructions**; a fixed system prompt that declares retrieved content untrusted; no tool access from retrieved text; output schema validation; a canary instruction to detect injection attempts |
| **Indirect leakage across tenants via shared caches or embeddings** | per-tenant vector namespaces; no shared embedding cache keys; cache keys include `org_id` |
| **Excessive agency** | **read-only tools in v1**; any write requires an explicit, separately-confirmed UI action with its own authorisation check; the assistant cannot approve, sign, pay or delete |
| **Over-broad retrieval** | retrieval is a query built by the application, not by the model; the model selects from a pre-filtered candidate set; a hard cap on retrieved records |
| **Model output as a stored XSS vector** | markdown/JSON output rendered with a strict sanitiser; `dangerouslySetInnerHTML` is banned in AI surfaces - note the legacy code has three such uses (`57_ACCESSIBILITY.md` F-A11Y-09) |
| **Prompt leakage of system instructions or other tenants' data** | no system-prompt logging; log a prompt **hash**; redact before logging |
| **Cost abuse** | per-tenant and per-user token budgets, a hard cap per invocation, a circuit breaker, alerting, and a deterministic fallback |
| **Model drift / silent behaviour change** | pin the model version; record it per invocation; golden-dataset regression gates in CI; a documented re-evaluation process before any version bump |
| **Hallucinated competitive or HR conclusions** | hard prohibition on eligibility, disciplinary, payroll and selection decisions; the assistant may only *flag* for human review, with the contributing records listed |
| **Confidentiality of contracts and personal data in the provider's logs** | a DPA with no-training and retention terms; an enterprise option for a self-hosted or private-endpoint model; explicit tenant opt-out |

## 3. Non-negotiable architectural rules
1. **The model is never the system of record.** It never writes a financial figure, a contract
   term, a payroll line, a permission decision, or an eligibility outcome.
2. **Retrieval is application-constructed and policy-filtered.** The model does not build queries
   and does not see the whole tenant.
3. **Every answer is reproducible**: model + version + prompt hash + retrieved record ids are
   stored, and a past answer can be replayed for audit.
4. **Deterministic fallback for every use case.** If the model is unavailable, the product
   degrades to the deterministic path, not to a guess.
5. **The audit log is mandatory and complete** - `75` requirement 8 is a release gate, not a
   follow-up.
6. **No model in a write path in v1.**

## 4. Evaluation and release gates
* A golden dataset per use case, with expected answers, expected citations, and explicit
  "must not answer" cases.
* Regression gates in CI on every prompt, model or retrieval change.
* A standing red-team suite: cross-tenant extraction, permission escalation, prompt injection via
  each document type, numeric fabrication, and citation fabrication.
* Human review sampling with a target hallucination rate and a defined tolerance.
* Every AI feature ships behind a per-tenant feature flag, default **off**, so a customer can
  decline it.

## 5. Verdict / status
**REQUIREMENTS ONLY.** No AI is implemented. These controls are preconditions for any AI feature
and must be designed into the platform's `AI` module from the start
(`90_DOMAIN_ARCHITECTURE.md`), not added when the first model is wired up.
