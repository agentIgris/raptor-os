# 09 — AUTHENTICATION

**Audit.md section:** 14 (SECTION 11 — AUTHENTICATION AUDIT)

---

## 1. Implemented authentication surface

| Capability | Status | Evidence |
| --- | --- | --- |
| Email + password sign-up | **implemented** | `app/auth/signup/page.tsx` → `supabase.auth.signUp` |
| Email + password sign-in | **implemented** | `app/auth/login/page.tsx` → `authFlowV2.signIn()` `lib/auth-flow-v2.ts:571` |
| Sign-out | **implemented** | `lib/auth-flow-v2.ts:636-681`; `lib/force-logout.ts` for emergencies |
| Session persistence | **implemented, insecure** | `lib/supabase.ts:36-51` (`persistSession:true`, `storage: localStorage`) |
| Session restore | **implemented, fragile** | `lib/auth-flow-v2.ts:184-246` with 2 s / 3 s timeouts |
| Token refresh | **implemented** | Supabase auto-refresh + `components/session/token-refresher.tsx` |
| Idle timeout | **implemented** | `components/session/idle-timer.tsx` + `lib/session-config.ts:7` (60 min default) |
| Password reset request | **implemented** | `app/auth/forgot/page.tsx` |
| **Password reset completion** | **MISSING ROUTE** | `/auth/reset-password` is allowlisted (`components/route-guard-v2.tsx:26`) and referenced in the redirect list (`lib/auth-flow-v2.ts:471`) but `app/auth/reset-password/` does not exist |
| Email verification / OTP confirm | **implemented** | `app/auth/confirm/page.tsx` (13,731 B) |
| Account recovery (beyond reset) | **not implemented** | no recovery-code or support-assisted path |
| OAuth / SSO (Google, Microsoft) | **NOT IMPLEMENTED — hook only** | `hooks/use-oauth-session-detector.tsx` exists; `rg "signInWithOAuth"` → 0 hits; no provider config |
| MFA / TOTP | **NOT IMPLEMENTED** | no `mfa` reference anywhere |
| Session revocation / device management | **NOT IMPLEMENTED** | no session list, no "sign out everywhere" |
| Account deletion / data export (self-service) | **NOT IMPLEMENTED** | absent; relevant to GDPR erasure/portability obligations |
| Invitation flow (org admin invites a user) | **NOT IMPLEMENTED** | sign-up is fully open; there is no invite table, token, or expiry |
| Custom SMTP / email templates | **NOT IMPLEMENTED** | uses Supabase's default SMTP (heavily rate-limited, sender not brandable) |
| CAPTCHA / bot protection on auth | **NOT IMPLEMENTED** | none |
| Credential breach / password-strength checks | **NOT IMPLEMENTED** | no `zod` password policy, no breach-list check |

---

## 2. Findings

### F-AUTH-01 — CRITICAL: the session (including the refresh token) is stored in `localStorage`
*Finding:* the Supabase browser client is configured with
`storage: typeof window !== 'undefined' ? window.localStorage : undefined`,
`storageKey: 'raptor-auth-token'`, `persistSession: true`.
*Evidence:* `lib/supabase.ts:36-51`, specifically lines 41-43.
*Impact:* any XSS execution context in the origin can read `localStorage['raptor-auth-token']`
and extract `access_token` **and `refresh_token`**. The refresh token is long-lived, so
exfiltration yields persistent account takeover until the user changes password or the token is
revoked. This directly defeats the design intent of `lib/session-storage.ts`, whose header
comment is *"Session Storage Utility - Secure token management"* and which deliberately keeps
the access token **in module memory only** (`lib/session-storage.ts:29-30, 111-113`).
The two mechanisms coexist and the insecure one wins, because Supabase's client is the actual
session store — the wrapper only reads from it.
*Exploitability:* requires an XSS or a malicious browser extension in the Raptor origin.
*Impact:* full account compromise for players, coaches and **admins** (an admin token
compromise yields the purge endpoint and service-role-adjacent capabilities).
*Affected scope:* every authenticated user.
*Severity:* **HIGH** · *Confidence:* **HIGH**
*Recommended remediation:* move the Supabase session to an `httpOnly; Secure; SameSite=Lax`
cookie managed server-side; never expose a refresh token to JavaScript; add a strict CSP
(see `04_DEPENDENCY_AUDIT.md` F-DEP-07) so that an XSS is materially harder.

### F-AUTH-02 — HIGH: new-user profile creation has no RLS policy, so sign-up is likely broken
*Finding:* `SecureProfileCreation.createProfile` inserts into `public.users` with the
user-bound client. The base schema defines only two **SELECT** policies on `users`; the only
INSERT policies defined anywhere are `"Admins can insert users"` (`scripts/01:62`).
*Evidence:* `lib/secure-profile-creation.ts:65-69`; `scripts/00-complete-schema-setup.sql:488-497`;
`scripts/01-create-tables.sql:62-69`.
*Impact:* under the repo's own schema, a self-service sign-up cannot create its profile row.
The user is authenticated in GoTrue but has no `users` row, so `authenticateRequest` returns
`404 USER_NOT_FOUND` for every API call (`lib/api-utils.ts:110-119`) and
`loadUserProfileFast` re-attempts creation on every page load
(`lib/auth-flow-v2.ts:288-344`). The visible symptom is a user who can log in but cannot do
anything.
*Exploitability:* n/a — availability defect.
*Severity:* **HIGH** · *Confidence:* **MEDIUM** (depends on which scripts were actually applied to the deployed project; `database/README.md` states RLS was *disabled* in development, in which case sign-up worked and this is a latent production-only failure)
*Recommended remediation:* a single, explicit `"Users can insert own profile"` policy with
`WITH CHECK (id = auth.uid())`, created in the migration ledger and covered by an integration
test.

### F-AUTH-03 — HIGH: a latent admin-minting function exists in the client-reachable library
*Finding:* `SecureProfileCreation.createAdminProfile(userId, email, name)` performs
`supabase.from('users').upsert({ id: userId, role: 'admin', role_level: 100 })` with the
comment *"Emergency admin creation - skipping auth verification"* and *"caller is responsible
for verification"*. `createBatchProfiles` similarly *"doesn't verify each user is authenticated"*.
*Evidence:* `lib/secure-profile-creation.ts:218-275` and `:277-334`.
*Impact:* not currently reachable from any API route (grep-verified: only the definition
matches), so it is **latent**. But it is a documented-in-code invitation to reintroduce
privilege escalation, and it runs on the **user-bound client**, meaning if a permissive INSERT
policy is ever added to `users` (which F-AUTH-02 says is required), this function becomes a
one-call admin escalation for any authenticated user who can reach it.
*Severity:* **HIGH** (latent) · *Confidence:* **HIGH** for the code; **LOW** for current exploitability
*Recommended remediation:* **delete** `createAdminProfile` and `createBatchProfiles`. Admin
provisioning must be a server-side, audited, invitation-based operation.

### F-AUTH-04 — MEDIUM: sign-in has no rate limiting, lockout or bot defence
*Finding:* `signInWithPassword` is called directly from the browser with no client-side
throttle, no CAPTCHA, and no application-level lockout.
*Evidence:* `lib/auth-flow-v2.ts:586-589`; no rate-limit code anywhere (see F-DEP §4.2 in
`04_DEPENDENCY_AUDIT.md`).
*Impact:* credential stuffing and password spraying against a platform whose users are
publicly identifiable (staff are named on a public website, and Discord IDs are stored in
`users.discord_id`). Supabase's own rate limits apply per IP/project but are not a substitute
for account-level controls.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommended remediation:* edge rate limiting keyed on IP **and** on account, MFA for
privileged roles, and credential-stuffing detection.

### F-AUTH-05 — MEDIUM: the password-reset completion route does not exist
*Finding:* `/auth/reset-password` is treated as a public route in two places but has no page.
*Evidence:* `components/route-guard-v2.tsx:26`;
`lib/auth-flow-v2.ts:471` `const redirectFrom = ['/', '/auth/login', …, '/auth/reset-password']`;
`app/auth/` contains only `login/`, `signup/`, `confirm/`, `forgot/`.
*Impact:* Supabase's default recovery email links to this path; users who request a reset reach
a 404 and cannot complete account recovery. Combined with F-AUTH-04 this is a
self-service account-takeover-prevention gap.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommended remediation:* implement the route with PKCE `exchangeCodeForSession`, or move to
Supabase's hosted recovery page and remove the dead allowlist entry.

### F-AUTH-06 — MEDIUM: no MFA anywhere, including for `admin`
*Finding:* `role: 'admin'` is the most privileged role in the system and can trigger the
destructive purge endpoint. There is no MFA enrolment, challenge or enforcement.
*Evidence:* `rg -n "mfa|totp|otp_secret|aal2"` → no auth-related hits; `lib/agreement-versions.ts`
exempts `admin` from agreement enforcement entirely.
*Severity:* **MEDIUM** (HIGH for a commercial SaaS) · *Confidence:* **HIGH**
*Recommended remediation:* mandatory MFA for admin/owner roles; step-up auth for destructive
and export operations.

### F-AUTH-07 — MEDIUM: session restore signs users out on a slow network
*Finding:* `performInitialize` wraps `supabase.auth.getUser(accessToken)` and
`loadUserProfileFast` in `withTimeout(..., 2000)`. On timeout the cached session is
**destroyed** (`SessionStorage.clearSession()`), and step 2 then asks `supabase.auth.getSession()`
with a 3 s timeout.
*Evidence:* `lib/auth-flow-v2.ts:177-182, 200-245, 248-261`.
*Impact:* on a slow connection or a cold Supabase response, an authenticated user is silently
logged out and loses unsaved form state. This is the single most-reported-class UX defect in
session handling and is entirely self-inflicted.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommended remediation:* distinguish *network failure* from *invalid session*; never destroy
a session on timeout; retry with backoff; show a "reconnecting" state.

### F-AUTH-08 — MEDIUM: `removeConsole` in production destroys all authentication logging
*Finding:* `compiler: { removeConsole: process.env.NODE_ENV === 'production' }`.
*Evidence:* `next.config.mjs:8-10`.
*Impact:* every `console.log('🔐 Processing Supabase session for user:', user.email)` and
`console.error('❌ Sign in error:', error)` in `lib/auth-flow-v2.ts`, `lib/secure-profile-creation.ts`
and `lib/supabase.ts` is **removed from the production bundle**. There is no replacement
logger and no error tracker. Failed sign-ins, profile-creation failures and agreement-check
failures become completely invisible in production. Note this also means a would-be
`SUPABASE_ANON_DEBUG` disclosure is not logged, but the diagnostic loss is severe.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommended remediation:* remove `removeConsole`; adopt a structured logger with
redaction plus an error-tracking service.

### F-AUTH-09 — MEDIUM: authentication state is a module-level singleton with cross-request state
*Finding:* `AuthFlowV2Manager` is a singleton with a `listeners` set, `profileCache` Map,
`sessionValidationCache` Map and a 30-second validity cache, exported as a module instance.
*Evidence:* `lib/auth-flow-v2.ts:45-57, 805-806`.
*Impact:* safe today because the manager is only used from client components
(`hooks/use-auth-v2.tsx`, `components/route-guard-v2.tsx`). If any of this were ever imported
into a server component or route handler, per-user state would leak across requests — a
cross-tenant session-leak class bug. The `profileCache` also holds full user rows
(including PII) in memory indefinitely with no eviction.
*Severity:* **MEDIUM** (architectural landmine) · *Confidence:* **HIGH**
*Recommended remediation:* forbid module-level mutable state in server-reachable code; add an
architecture test/lint rule.

### F-AUTH-10 — LOW/MEDIUM: client IP and user agent are trusted from headers
*Finding:* `app/api/agreements/route.ts:96-99` records
`request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'`
into `user_agreements.ip_address` (`inet`).
*Evidence:* `app/api/agreements/route.ts:96-99, 110-113`.
*Impact:* if the deployment does not strip client-supplied `X-Forwarded-For`, the recorded IP
is attacker-controlled and therefore worthless as evidence — and this record is exactly the
kind of artefact an employment or legal dispute would rely on.
*Severity:* **LOW** for security, **MEDIUM** for evidentiary integrity · *Confidence:* **HIGH**
*Recommended remediation:* derive the client IP from the platform's trusted header only
(Vercel: `x-vercel-forwarded-for` / `x-real-ip` after platform stripping), and document the
trust boundary.

### F-AUTH-11 — LOW: agreement acceptance trusts a client-supplied `role`
*Finding:* `POST /api/agreements` accepts `role` and `version` from the request body and
upserts `user_agreements` for **that** role, having validated only that
`version === getRequiredAgreementVersion(role)`.
*Evidence:* `app/api/agreements/route.ts:79-118`; `lib/agreement-versions.ts:47-49`
(`getRequiredAgreementVersion` returns `1` for any unknown role).
*Impact:* a user can record an "accepted" agreement for a role they do not hold, and — because
`check_user_agreement_status(p_user_id, p_role, …)` is parameterised and the record is keyed on
`(user_id, role)` — that forged record can later satisfy the gate for a role they are
*promoted into*. The RLS policy `user_agreements FOR ALL USING (user_id = auth.uid())` permits
the insert, so nothing stops it.
*Severity:* **LOW** (compliance integrity, not access control) · *Confidence:* **HIGH**
*Recommended remediation:** derive the role from the authenticated profile server-side; store
the agreement body hash that was actually displayed; require re-acceptance on role change.

---

## 3. Authentication flow, reconstructed

```
Browser
 └─ hooks/use-auth-v2.tsx (AuthProviderV2, mounted in app/layout.tsx)
     ├─ useSafeRedirect()  ← the ONLY open-redirect guard in the codebase
     ├─ onAuthStateChange → SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED
     └─ lib/auth-flow-v2.ts (AuthFlowV2Manager singleton)
         ├─ initialize(isInitialLoad)
         │   ├─ 30 s sessionValidationCache short-circuit
         │   ├─ SessionStorage.getSession() + getAccessToken()  (memory token)
         │   │   ├─ cached profile? → setAuthenticatedState, no redirect
         │   │   ├─ else supabase.auth.getUser(token)  [2 s timeout]
         │   │   │   ├─ ok  → loadUserProfileFast [2 s timeout] → setAuthenticatedState
         │   │   │   └─ err/timeout → SessionStorage.clearSession()   ← logs the user out
         │   ├─ supabase.auth.getSession() [3 s timeout] → handleSupabaseSession
         │   └─ else: unauthenticated state
         ├─ performInitializeWithRetry (2 retries, 1 s/2 s backoff)
         ├─ loadUserProfileFast(user)
         │   ├─ SELECT * FROM users WHERE id = auth.uid()
         │   ├─ fallback: SELECT * FROM profiles WHERE user_id = auth.uid()   (legacy)
         │   └─ else SecureProfileCreation.createProfile(...)  → INSERT INTO users
         ├─ checkAgreementStatus(profile)
         │   ├─ isAgreementRole(role)?  (player/coach/manager/analyst only)
         │   ├─ RPC check_user_agreement_status(user_id, role, required_version)  [SECURITY DEFINER]
         │   └─ any error → requiresAgreement:false, status:'bypassed'   ← FAIL-OPEN
         └─ setAuthenticatedState → redirect decision (agreement → onboarding → intended → /dashboard)
```

**Fail-open observation (F-AUTH-12, MEDIUM):** every error path in
`checkAgreementStatus` returns `requiresAgreement: false`
(`lib/auth-flow-v2.ts:514-521, 560-567`), and `check_user_agreement_status` itself returns
`requires_agreement:false` when `admin_config.agreement_enforcement_enabled` is not the string
`'true'` (`automation-scripts/04:157-172`). Combined with the fact that `admin_config` has **no
RLS**, an unauthenticated attacker can set that key to anything and disable legal-agreement
enforcement org-wide.
*Severity:* **MEDIUM** (legal/compliance) · *Confidence:* **HIGH* for the code path, **MEDIUM** for exploitability (depends on `admin_config` RLS/grants in the deployed project)
*Recommended remediation:* fail **closed** on enforcement errors; make the enforcement flag a
deploy-time constant, not a database row; remove RLS-less tables.

---

## 4. What to carry into V2

| Legacy asset | Verdict |
| --- | --- |
| Supabase Auth as the identity provider | **KEEP** |
| PKCE flow (`flowType: 'pkce'`) | **KEEP** |
| The agreement-version gating *concept* (versioned legal documents, re-acceptance on change) | **KEEP the concept, REBUILD the mechanism** — fail closed, server-derived role, body hashing, real e-signature flow |
| `useSafeRedirect` open-redirect guard | **KEEP** — promote to a shared security utility |
| The `pending_player` self-registration → onboarding funnel | **REBUILD** — split into *applicant* (public tryout) and *invited member* (org-issued invite) |
| `AuthFlowV2Manager`, `SessionStorage`, `session-config`, `idle-timer`, `token-refresher` | **ARCHIVE** — replace with a server session + a thin client session context |
| `createAdminProfile`, `createBatchProfiles` | **REMOVE** |
| `removeConsole` production stripping | **REMOVE** |
