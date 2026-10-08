# 54 - CI/CD
**Audit.md section:** 61 (SECTION 58 - CI/CD)

## 1. Inventory
| Item | Present? | Evidence |
| --- | --- | --- |
| GitHub Actions | **NO** | no `.github/` directory in 326 files |
| Any CI configuration | **NO** | no `.gitlab-ci.yml`, `Jenkinsfile`, `circle.yml`, `azure-pipelines.yml` |
| Vercel integration | **Partial (inferred)** | `.gitignore:25-26` ignores `.vercel`; a `vercel/react-server-components-cve-*` branch exists; one commit authored by `Vercel` |
| Build script | Yes | `package.json:6` `next build` |
| Lint script | Yes | `package.json:8` `next lint` |
| Type-check | **DISABLED** | `next.config.mjs:19-21` `typescript.ignoreBuildErrors: true` |
| Lint gate at build | **DISABLED** | `next.config.mjs:16-18` `eslint.ignoreDuringBuilds: true` |
| Test gate | **NO** | no test script, no test framework |
| Migration step | **NO** | no migration tool, no migration in any pipeline |
| Migration replay test | **NO** | — |
| Dependency scanning | **NO** | no Dependabot, no `npm audit`, no OSV scanner, no Snyk |
| Secret scanning | **NO** | no gitleaks, no trufflehog, no push protection |
| SAST / code scanning | **NO** | — |
| Container build | **NO** | no Dockerfile |
| Infrastructure as code | **NO** | — |
| Preview environments | **NO** | — |
| Release process | **NO** | `CHANGELOG.md` has one manually-written entry dated `[2024-01-20]` (all commits are 2025-08) |
| Branch protection | **UNKNOWN** | 20 remote branches, 16 of them stale `cursor/*` branches |
| Deployment rollback | **NO** | documented nowhere |

## 2. Findings

### F-CI-01 - CRITICAL: there is no CI at all
**Evidence.** no `.github/` directory; no CI configuration of any kind; 326 files enumerated.
**Impact:** nothing is verified before deployment. A commit can and did introduce a live
`ReferenceError`, a broken RPC dependency, an unauthenticated destructive endpoint, and a
world-writable table — and reach production unchallenged. Every finding in this audit that is
"mechanically detectable" was shipped.
**Severity:** CRITICAL | **Confidence:** HIGH

### F-CI-02 - CRITICAL: both available gates are explicitly disabled, by design
**Evidence.** `next.config.mjs:15-21` with the comment *"Relax build-time checks to prevent
non-critical warnings from failing CI builds"*.
**Impact:** this is worse than having no gate, because it creates the appearance of a gate. The
type checker is the one tool that would have caught
`getUserFromRequest is not defined` in `app/api/attendances/route.ts:310`.
**Severity:** CRITICAL | **Confidence:** HIGH

### F-CI-03 - HIGH: no dependency or secret scanning, and a known unpatched framework advisory branch
**Evidence.** `next: ^14.2.30` (`package.json:55`); a remote branch
`vercel/react-server-components-cve-vu-nkppb8` exists and is unmerged; no scanner in the repository.
*Impact:* a framework advisory was identified and not closed, with nothing to detect the next one.
*Severity:* HIGH | *Confidence:* MEDIUM
*Recommendation:* pin Next.js exactly, enable OSV/Dependabot, and treat a security advisory as a
release blocker.

### F-CI-04 - HIGH: no migration automation, so environment state is unreproducible
**Evidence.** 51 loose SQL files; no migration tool; `database/README.md` and
`automation-scripts/README.md` instruct an operator to paste scripts into the Supabase SQL editor
"in this exact order"; conflicting duplicate `CREATE POLICY` names; four `create_auto_attendance`
definitions.
**Impact:* a new environment cannot be built deterministically. A staging environment that differs
from production by one script is a normal outcome, which invalidates every "works in staging"
claim — and is very likely the root cause of the attendance bug backlog.
*Severity:* HIGH | *Confidence:* HIGH

### F-CI-05 - MEDIUM: no release discipline
**Evidence.** `CHANGELOG.md` has a single entry dated `[2024-01-20]` describing work whose commits
are all dated 2025-08; no version tags; `package.json` version is `0.1.0`; 16 stale `cursor/*`
branches and an `Original-deployed-site` branch.
**Impact:** no way to know what is deployed, what changed, or what to roll back to. 63 commits
landed in a single month with no release train.
*Severity:* MEDIUM | *Confidence:* HIGH

### F-CI-06 - MEDIUM: no preview environments and no environment parity
**Evidence.** `.env.example` documents 12 variables; 14 actually-used variables are undocumented
(`19_SECRETS.md` F-SEC-07); `build.out` shows a build that stalled on an interactive Corepack
prompt, suggesting the toolchain is not self-bootstrapping.
**Impact:* environments drift silently. The three `NEXT_PUBLIC_*WEBHOOK_URL` variables
demonstrate the failure mode: a build can differ from the last one purely because of
build-time inlining, and nothing records what was inlined.
*Severity:* MEDIUM | *Confidence:* HIGH

## 3. V2 CI/CD requirements
1. **Trunk-based development** on `main`, with short-lived branches and mandatory review.
2. **Required gates, all of which must be able to fail the build:**
   `typecheck` (typescript strict, no ignore) · `lint` (flat config, no ignore) ·
   `unit + integration` · `e2e` on the 18 critical workflows · `policy conformance` ·
   `security scan` (SAST + dependency + secret) · `migration replay` (build a scratch DB from
   migrations and diff against the committed schema types) · `a11y` · `bundle budget`.
3. **Preview deployments** per pull request, with per-preview Supabase branches and seeded data.
4. **Migrations as code** (`supabase/migrations`), applied by the pipeline, never by hand; a
   production apply is a reviewed, forward-only, reversible-by-rollback-forward step.
5. **Secret scanning** (gitleaks) on every commit and in CI history; a build-time assertion that
   fails if any `NEXT_PUBLIC_*` name matches a secret pattern.
6. **Dependency policy:** exact pins, one lockfile, Dependabot/OSV with SLA-based triage, and
   automatic security updates.
7. **Signed, immutable releases** with an auto-generated changelog from conventional commits.
8. **Deployment gates:** health checks, migration success, smoke tests, and automatic rollback.
9. **Budgets:** error rate, p95 latency, and cost per tenant, enforced in the pipeline.

## 4. Verdict
**BUILD NEW from zero.** The pipeline is the control that makes every other recommendation in
this audit enforceable rather than aspirational.
