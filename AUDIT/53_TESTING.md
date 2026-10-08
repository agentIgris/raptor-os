# 53 - TESTING
**Audit.md section:** 60 (SECTION 57 - TESTING)

## 1. Inventory
| Test type | Count | Evidence |
| --- | --- | --- |
| Unit tests | **0** | no `*.test.*`, `*.spec.*`, `__tests__/` anywhere |
| Integration tests | **0** | — |
| API tests | **0** | — |
| E2E tests | **0** | no Playwright, Cypress, or Puppeteer config or dependency |
| Database tests | **0** | `test_attendance_function.sql` (6,502 B) is a **manual DO-block script**, not an automated test; it even creates and deletes real rows (`scripts/18`, `scripts/20`, `scripts/21` all do the same) |
| Security tests | **0** | — |
| Accessibility tests | **0** | — |
| Visual regression | **0** | — |
| Load / performance tests | **0** | — |
| Lint gate | **DISABLED** | `next.config.mjs:16-18` `eslint.ignoreDuringBuilds: true` |
| Type-check gate | **DISABLED** | `next.config.mjs:19-21` `typescript.ignoreBuildErrors: true` |
| `test` script | **ABSENT** | `package.json:5-10` defines only `build`, `dev`, `lint`, `start` |
| Test framework dependency | **ABSENT** | no vitest / jest / playwright / testing-library in `package.json` |
| CI | **ABSENT** | no `.github/` directory |

**Total automated tests: 0. Total quality gates: 0 (both existing gates are explicitly
disabled).**

## 2. Findings

### F-TST-01 - CRITICAL: no tests and both quality gates disabled
**Evidence.**
* `package.json:5-10` — no `test` script.
* No test framework in `dependencies` or `devDependencies`.
* `next.config.mjs:15-21` with the comment *"Relax build-time checks to prevent non-critical
  warnings failing CI builds"*: `eslint: { ignoreDuringBuilds: true }` and
  `typescript: { ignoreBuildErrors: true }`.
* 0 test files in 326.
**Impact.** This single configuration decision explains the survival of every defect in this
audit. A type checker would have caught:
* `getUserFromRequest is not defined` in `app/api/attendances/route.ts:310` — a **`ReferenceError`
  in a live production route** (`17_ERROR_HANDLING.md` F-ERR-02).
The compiler would also have caught the `Database` type's divergence from the schema
(e.g. `performances.player_id` declared NOT NULL in TS but nullable in SQL) and the 18 tables
missing from the type entirely.
**Severity:** CRITICAL | **Confidence:** HIGH
**Recommended remediation:** enable `typescript.ignoreBuildErrors: false` and
`eslint.ignoreDuringBuilds: false` immediately, fix the resulting errors, and add `test`,
`typecheck` and `lint` as required CI gates.

### F-TST-02 - HIGH: a defect-dense domain shipped with no test
**Evidence.** the attendance domain alone has: 6 competing auto-attendance trigger definitions,
a `ReferenceError` in its DELETE handler, a `session_time text` representation, a non-existent
`notes` column, a table with no RLS, 12 overlapping UI components, and 3 markdown bug reports
plus 4 root-level debug SQL files in the repository.
**Impact:** each of those was found by manual observation and ad hoc SQL, i.e. by a human
debugging production. The cost is visible in the commit history: 63 commits, ~89 % AI-authored,
all within a single month, with a chain of `scripts/14-…21-fix-*.sql` patches.
**Severity:** HIGH | **Confidence:** HIGH

### F-TST-03 - HIGH: the RLS policies were never exercised
**Evidence.** `database/README.md:41-46, 73-75` states RLS was **disabled during development**;
no policy is covered by any test; there is no test harness.
**Impact:** the ~118 policy declarations were written without ever being executed against
application queries. That is why nine endpoints using a session-less anon client are broken, why
players can read finances, and why `admin_config` is world-writable.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** a **policy conformance test suite** that, for each (role, resource, action)
triple in the permission matrix, asserts both the API response and the underlying SQL result.
This is the single highest-value test investment for V2.

### F-TST-04 - HIGH: the undefined RPCs would have been caught by one smoke test
**Evidence.** `bulletproof_user_update` (`app/api/users:140`) and `get_all_users_admin`
(`app/dashboard/user-management/page.tsx:131`) are referenced but **defined in no SQL file**. The
only role-assignment path in the product is therefore non-functional.
**Severity:** HIGH | **Confidence:** HIGH

### F-TST-05 - MEDIUM: SQL "tests" mutate real data
**Evidence.** `test_attendance_function.sql`, `scripts/18-debug-database-issues.sql`,
`scripts/20-fix-attendance-team-id-constraint.sql`, `scripts/21-fix-attendance-session-time-constraint.sql`
all `INSERT` test rows and `DELETE` them inside `DO` blocks against the live database.
**Impact:** running them against production creates and destroys real rows; they are not
idempotent and are not isolated. Their existence in the repository also means production data has
been used as a test bed.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-TST-06 - MEDIUM: accessibility and performance are untested
**Evidence.** absence of any axe, Lighthouse, bundle-budget or load test.
**Impact:** the accessibility findings in `57_ACCESSIBILITY.md` and the performance findings in
`56_PERFORMANCE.md` are unmeasured; regressions will be invisible.
**Severity:** MEDIUM | **Confidence:** HIGH

## 3. Critical untested workflows (V2 must test all of these)
| # | Workflow | Why it is critical |
| --- | --- | --- |
| 1 | Sign up → profile created → onboarding → agreement → dashboard | The entry funnel; currently likely broken (F-AUTH-02) |
| 2 | Sign in → session restore on a slow network | Currently logs the user out (F-AUTH-07) |
| 3 | Role change, and the target user's session invalidation | Currently broken, unaudited, un-notified |
| 4 | Team-scoped data isolation between two teams in the same tenant | The core multi-tenant invariant |
| 5 | Cross-tenant isolation | The core SaaS invariant |
| 6 | Player cannot read team finances | Currently violated by RLS |
| 7 | Attendance mark → auto-absent at cutoff → manager verification → correction | The most defect-dense domain |
| 8 | Performance submit → duplicate rejected → analytics reflects it | Uniqueness is unenforced |
| 9 | Tryout: apply → screen → invite → evaluate → select → roster | The best model, the broken plumbing |
| 10 | Contract: publish version → user accepts → content hash recorded → re-consent on change | Acceptance is currently unprovable |
| 11 | Prize income → split calculation → payout record → reconciliation | The largest financial gap |
| 12 | Expense/invoice approval workflow | Entirely absent |
| 13 | Sponsor deliverable: create obligation → due → owner completes → proof attached → invoice | Entirely absent |
| 14 | Notification: event → rule → channel → delivery → retry → DLQ | Discord only, forgeable log |
| 15 | Data export and erasure for a data subject | Legally required, entirely absent |
| 16 | File upload: type sniffing, private storage, signed-URL read, authorised delete | Currently unauthenticated |
| 17 | API key authentication and replay protection | Currently one static shared secret |
| 18 | Audit log completeness: every mutation writes exactly one record | Prerequisite for enterprise sales |

## 4. V2 testing strategy
1. **Unit tests** for the permission engine, the validation schemas, the metrics definitions and
   all business-rule functions (the attendance rules, the slot-expense rule, the prize-split
   calculation).
2. **Integration tests** against a real Postgres (Supabase local or testcontainers) for every
   repository query, including tenant scoping.
3. **A policy conformance suite** generated from the permission matrix (§3 items 4-7).
4. **API contract tests** generated from the OpenAPI/zod schemas, including negative authz cases.
5. **E2E tests** (Playwright) for the 18 critical workflows above, against a seeded tenant.
6. **Security tests**: an IDOR/authorisation sweep, tenant-isolation fuzzing, upload validation,
   rate-limit verification, and a dependency scan.
7. **Accessibility** (axe) and **visual regression** on the design-system components.
8. **Performance**: a bundle budget, a k6 load test on the top endpoints, and a query-cost
   regression check.
9. **Coverage and mutation targets** on the permission and finance logic specifically.
10. **CI gates that actually fail the build**: `typecheck`, `lint`, `test`, `e2e`, `security
    scan`, `migration replay`.

## 5. Verdict
**BUILD NEW from zero.** There is nothing to preserve. Testing is the control that would have
prevented most of this audit's findings, and it is a release gate, not a nice-to-have.
