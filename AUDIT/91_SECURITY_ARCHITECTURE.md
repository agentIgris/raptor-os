# 91 - SECURITY ARCHITECTURE
**Audit.md section:** 99 (SECTION 96)

## 1. Target posture
Defence in depth, in four layers, each of which fails independently of the others:
1. **Edge** - CDN/WAF, rate limiting, bot protection, TLS, no public mutation endpoints.
2. **Application** - server-side authorisation on every request, validated input, no service-role
   key reachable from a route that a user can influence.
3. **Data** - Postgres RLS on **every** table, `SECURITY DEFINER` functions with an explicit
   `search_path` and revoked default grants, private storage with signed URLs, per-tenant scoping
   on every index.
4. **Assurance** - audit log, alerting, secret scanning, dependency scanning, tests, backups,
   retention, and a documented incident process.

## 2. Edge layer
| Control | Requirement | Legacy status |
| --- | --- | --- |
| Rate limiting | Per IP and per user on auth, upload, public and AI-adjacent endpoints | **Absent** - `15_API_SECURITY.md` F-API-11 |
| Bot protection | Challenge on public forms and auth | Absent |
| WAF / DDoS | Managed protection | Unconfigured |
| Security headers | Strict CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` | Absent - no CSP (`57_ACCESSIBILITY.md`) |
| Public surface minimization | No `/debug`, no `/api/public/stats` | **Present and dangerous** (`06_UI_COMPONENTS.md`) |

## 3. Application layer
### 3.1 Authorisation
* A single `authorize(actor, action, resource, scope)` used by every route. No route may read
  scope from a query parameter, a header, or a client-supplied team id
  (F-API-08, `10_AUTHORIZATION.md`).
* UI hiding is never the control. Every capability is checked server-side, and the denial is an
  explicit 403 with a reason code.
* Platform operators use **time-boxed, audited impersonation** with an explicit reason, never a
  standing super-admin session (`63_ROLE_MODEL.md` §5).

### 3.2 Input and output
* A schema at every boundary: request body, query, path, and every Supabase `.select()`.
  Today the code does `select('*')` on people tables and relies on RLS to filter
  (`20_STORAGE.md` F-STOR-01) - **RLS is not a substitute for an explicit projection.**
* Size, type and range limits on every upload, with server-side MIME verification and a
  malware scan (`16_VALIDATION.md`).
* No user input reflected into HTML without escaping; no `dangerouslySetInnerHTML` on user data.
* Errors returned to clients are generic; detail goes to the log with a correlation id.

### 3.3 Secrets
* No secret in the repository, ever. `NEXT_PUBLIC_*` must never carry a credential.
* Secrets in a managed store, rotated on a schedule and on staff change
  (`19_SECRETS.md`).
* The legacy `discord_webhooks` table and the Vercel env fallbacks must be **rotated before any
  migration** - they are already exposed (`22_DISCORD.md` §7, F-SEC-02).

### 3.4 Service-role containment
The `SUPABASE_SERVICE_ROLE_KEY` is used in `media/upload`, `media/delete`, and
`public/upload/contact-file`. V2:
* removes service-role usage from user-facing routes entirely;
* if a privileged operation is unavoidable, it goes through a single audited internal service with
  a narrow RPC (`15_API_SECURITY.md` F-API-01 remediation).

## 4. Data layer
### 4.1 RLS as the primary control
* **Every** table has RLS enabled and forced, including reference tables and views
  (`13_RLS_SECURITY.md`).
* Every policy is written from the tenant predicate first: `organization_id = current_org_id()`.
  A policy that does not mention the tenant is a defect.
* `auth.uid()` is never the sole scope; the caller's memberships are resolved server-side.
* Recursive policies are banned. The current `users_select_own_team` recursion
  (`automation-scripts/08:127-156`) is the canonical example of what not to do.
* Views that bypass RLS are banned or made `security_invoker` - `tryout_stats` currently is not
  (F-REL-06).
* `FORCE ROW LEVEL SECURITY` so the table owner is also subject to policy.

### 4.2 Functions
* Every `SECURITY DEFINER` function sets `search_path`, and every one has an explicit
  `REVOKE ... FROM anon, authenticated` plus a `GRANT` to the minimum role.
  ~25 functions currently have no revoke (`13_RLS_SECURITY.md`).
* `SECURITY DEFINER` is used only where a table-level policy cannot express the rule.

### 4.3 Storage
* **Private by default.** Public buckets only for deliberately public, non-PII assets
  (logos, published images) and only via a serving path, never via direct public URL listing.
* Uploads go through a server endpoint with authorisation, MIME/size validation, a per-tenant
  prefix, and a stored `AssetItem` row.
* Reads through signed, expiring URLs; writes through an authorised endpoint only.
* Contact-form uploads - currently public and world-readable
  (`app/api/public/upload/contact-file/route.ts`) - become a `Submission` record with a private
  attachment.

### 4.4 Encryption and keys
* TLS everywhere; at-rest encryption from the platform.
* Field-level encryption for the highest-risk PII (identity documents, bank details) with keys in
  a managed KMS, rotated.
* Secrets never in env files committed to the repository; a pre-commit hook and CI scan enforce it.

## 5. Assurance layer
| Control | Requirement | Legacy |
| --- | --- | --- |
| Audit log | Append-only, every sensitive action, actor + tenant + before/after | **0 of 15 classes** (`49_AUDIT_LOGGING.md`) |
| Alerting | Auth spikes, mass export, RLS denials, service-role use, admin changes | Absent |
| Error tracking | Structured errors with correlation ids | Absent; `removeConsole` hides everything (`52_OBSERVABILITY.md`) |
| Metrics | Request rate, error rate, latency, saturation, queue depth, auth failures | Absent |
| Dependency scanning | SCA on every build | No CI at all (`54_CICD.md`) |
| Secret scanning | Repo + history scan, pre-commit | Manual, post-hoc |
| SAST / DAST | In CI, blocking | Absent |
| Penetration test | Before launch and annually | Never |
| Backups | Automated, encrypted, **restore-tested** | Platform default, unverified (`51_BACKUPS.md`) |
| Incident response | Documented, rehearsed | Absent (`20_incident_response` is a README) |
| Access review | Quarterly recertification of privileged roles | Absent |

## 6. Threats and controls
| Threat | Control |
| --- | --- |
| Broken object-level authorisation | Policy engine + server-side scope + tests on every route (`15_API_SECURITY.md`) |
| Credential stuffing | MFA, rate limiting, lockout, alerting (`09_AUTHENTICATION.md`) |
| Mass PII extraction via anon key | RLS on every table, no `anon` grants on `users` |
| Unauthenticated file upload / storage abuse | Private buckets, authorised upload endpoint, MIME/size validation, quotas |
| Service-role misuse | Remove from routes; audited internal service |
| SQL injection via search/filter | Parameterised queries only, no string-built filters |
| XSS | No unescaped user HTML, strict CSP, sanitisation |
| SSRF via Discord/oEmbed/webhook URLs | URL allowlist, egress control, no server-side fetch of user-supplied URLs |
| Cross-tenant data leak | Tenant predicate in every policy, composite indexes, integration tests |
| Financial fraud (allocation tampering) | Effective-dated memberships, immutable ledger, allocation audit trail |
| Insider abuse | Least privilege, separation of duties on payments, immutable audit, access reviews |
| Minors' data exposure | `date_of_birth`-derived guardian consent, restricted document access (`64_FUTURE_HR.md`) |
| Supply-chain compromise | Lockfile integrity, SCA, minimal dependencies, no client-side secrets |
| Ransomware / data loss | Tested restores, soft delete, retention |

## 7. Security acceptance criteria for V2 launch
1. Zero tables without RLS, forced, tenant-scoped.
2. Zero `SECURITY DEFINER` functions without `search_path` and explicit grants.
3. Zero user-facing routes using the service-role key.
4. Zero unauthenticated mutation endpoints.
5. Zero secrets in the repository or history, all rotated.
6. 100% of the 15 sensitive action classes in the audit log.
7. A passing test suite that includes cross-tenant isolation tests.
8. A completed penetration test with no critical or high findings open.
9. A **restore test** from backup, with a recorded RPO/RTO.
10. Documented incident response, rehearsed once.
