# ADR-0001 — Rebuild from scratch; legacy is reference only

**Status:** Accepted
**Date:** 2026-10-09

## Context

The legacy `RaptorLaunchPage/Beta` repository is a single-tenant, single-game esports
team-operations app. The forensic audit assessed 63 capabilities and found:

- **0 of 63 complete. 0 of 63 secure. 0 kept as-is.**
- No `organization_id` anywhere — tenancy is not retrofittable.
- Prize money recorded at team level, never allocated to a person.
- 14 of 32 tables without RLS; ~25 `SECURITY DEFINER` functions never revoked from
  `anon`; 3 unauthenticated service-role write endpoints.
- 0 tests, 0 CI, `ignoreBuildErrors` and `ignoreDuringBuilds` both enabled. A live
  `ReferenceError` shipped to production.
- 97 known dependency advisories (4 critical, 40 high) — and the Next.js 14 line is
  permanently unpatchable against two unauthenticated RCEs.

## Decision

Build V2 from scratch. The legacy repository is **domain-knowledge reference only**:
it is read to extract business rules, never to extract code.

Nothing is inherited — no code, no schema, no configuration, and **no credentials**.
Prior webhook URLs, API keys and tokens are treated as compromised and are never used.

## What is preserved, and what is not

**Preserved as specification** (extracted from the audit, then reimplemented):

| Asset | Why it is worth carrying |
| --- | --- |
| Tryout state machine (6 stages) | Best design work in the legacy codebase |
| Attendance cutoff / auto-absent rules | Real operational knowledge, tested here instead of embedded in SQL triggers |
| Slot-expense arithmetic | Deterministic and testable |
| Tier pricing ladder (OCK / SSF / WWF) | A coherent commercial rate card |
| Discord message vocabulary | Users already recognise it |
| Role hierarchy | A starting point, replaced by a real policy engine |

**Discarded entirely:** all 98 UI components, all 58 API route files, the 43 ad-hoc
SQL scripts, the hand-written `Database` type, all module-level singletons, the
client-side OCR path, `removeConsole`, and every `select('*')` over PII.

## Consequences

The value is in the rules, not the implementation. Everything must be rebuilt, which is
the entire justification for not patching — the audit rejected patching because the
debt is foundational (tenancy, identity, authorisation, audit, observability, tests)
rather than superficial.

The cost is real: no code is reusable, so the rebuild is a genuine multi-phase program
rather than a refactor. Accepted deliberately.