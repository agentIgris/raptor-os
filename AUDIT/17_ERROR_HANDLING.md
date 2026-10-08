# 17 — ERROR HANDLING
**Audit.md section:** 23 (SECTION 20 — ERROR HANDLING)

## 1. Mechanisms present

| Mechanism | Where | Assessment |
| --- | --- | --- |
| Standardised API error shape | `lib/api-utils.ts:14-19, 142-151` `{error, code, status, details?}` | good shape; `details` leaks internals (F-API-13) |
| Standardised success shape | `lib/api-utils.ts:154-181` | **inconsistent** — raw for objects/arrays, wrapped for primitives; 3 more bespoke shapes elsewhere |
| Per-handler `try/catch` | ~50 handlers | present but frequently swallows the cause |
| React error boundary | `components/error-boundary.tsx` (8,374 B) | active |
| Loading + error boundary | `components/loading-error-boundary.tsx` (5,650 B) | active |
| Next.js route error boundary | `app/error.tsx` (5,032 B) | active; renders raw `error.message` |
| Next.js global error boundary | `app/global-error.tsx` (5,503 B) | active |
| Not-found boundary | `app/not-found.tsx` (1,707 B) | active |
| `AbortController` / request cancellation | — | **absent**; no fetch is ever aborted, so navigation during a slow request causes state updates on unmounted components |
| Retry logic | `lib/auth-flow-v2.ts:140-168` (auth only) | 2 retries with 1 s/2 s backoff |
| Circuit breaker / backoff for outbound calls | `modules/discord-portal/sendToDiscord.ts:105` uses `Promise.allSettled`; `retryFailedMessage` (`:266-333`) is manual | no backoff, no jitter, no dead-letter |
| Error tracking service | — | **absent** (see `52_OBSERVABILITY.md`) |
| Transactional rollback | — | **absent** |

## 2. Findings

### F-ERR-01 — CRITICAL: silent failure in the destructive purge endpoint
**Finding.** `POST /api/admin/settings` `purge_non_admin_data` cannot detect a failed delete, and reports success regardless.
**Evidence.** `app/api/admin/settings/route.ts:115-130`
```ts
try {
  for (const table of tables) { await supabaseAdmin.from(table).delete().neq('id', null) }
  await supabaseAdmin.from('users').delete().neq('role', 'admin')
  return createSuccessResponse({ success: true }, 'Data purged successfully')
} catch (purgeError) { … }
```
The Supabase JS client **returns** `{ error }`; it does not throw. The `await` resolves on
failure, the loop continues, the `catch` never runs, and `{success:true}` is returned.
**Impact.** A partial or total failure of the purge is reported to the administrator as a
success, with no log (production logs are stripped) and no audit record. The database may be
left in a partially purged state that nobody knows about.
**Severity:** CRITICAL · **Confidence:** HIGH
**Recommendation:** check the returned `error` on every statement; wrap in a single
`SECURITY DEFINER` transaction with an `EXCEPTION` block; write an audit record; require a
checksummed pre-export and step-up auth.

### F-ERR-02 — HIGH: a `ReferenceError` is silently converted into a 500
**Finding.** `DELETE /api/attendances` calls a function that does not exist in the file.
**Evidence.** `app/api/attendances/route.ts:308-338`
```ts
export async function DELETE(request: NextRequest) {
  try {
    const { userData, userSupabase, error, status } = await getUserFromRequest(request)  // :310 — UNDEFINED
    …
  } catch (e) { console.error('Attendances DELETE error:', e); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }) }
}
```
The file imports only `authenticateRequest, createErrorResponse, createSuccessResponse,
checkRoleAccess, validateRequiredFields, isValidUuid, handleCors` from `@/lib/api-utils` —
`getUserFromRequest` is not among them and is not defined locally.
**Impact.** Every delete attempt returns a generic 500. The error boundary shows
"Internal server error". The real cause (`getUserFromRequest is not defined`) is logged — but
`removeConsole` strips it in production. This defect survived because
`typescript.ignoreBuildErrors: true` and `eslint.ignoreDuringBuilds: true` are set in
`next.config.mjs:15-21`, so the compiler never flagged it and there are no tests.
**Severity:** HIGH (availability) · **Confidence:** HIGH
**Recommendation:** fix the handler; **turn on the type checker and the linter**; add a test for
every route handler; add error tracking so this class of defect is visible in production.

### F-ERR-03 — HIGH: error paths leak internals and defeat error diagnosis
**Evidence.** `app/api/performances/route.ts:46` (`` error: `Database error: ${testError.message}` ``),
`:127`, `:295`; `app/api/sessions/route.ts:90, 209`; `app/api/admin/settings/route.ts:51, 93, 156, 166`;
`app/api/profile/avatar/route.ts:120, 166, 181, 237, 273`;
`app/api/public/submit/contact/route.ts:79` (returns upstream Discord response text);
`app/error.tsx:58` renders `error.message` in the UI.
**Impact.** (a) Users and attackers see table/column/constraint names. (b) Support cannot
diagnose because the client sees a message that does not map to a logged error. (c) The
information leak materially assists exploitation of the other findings.
**Severity:** HIGH · **Confidence:** HIGH
**Recommendation:** generic message + stable error code + correlation id; full detail only in
server logs; a user-visible "report this" affordance that carries the correlation id.

### F-ERR-04 — HIGH: fail-open agreement enforcement
**Evidence.** `lib/auth-flow-v2.ts:514-521` — any error from the agreement RPC returns
`{ requiresAgreement: false, status: 'bypassed' }`; `:560-567` the same for exceptions.
`automation-scripts/04:166-172` — if `admin_config.agreement_enforcement_enabled` is not the
string `'true'`, return `requires_agreement:false`. `admin_config` has **no RLS**
(`13_RLS_SECURITY.md` F-RLS-04).
**Impact.** The legal-agreement gate can be disabled by (a) any transient database error, or
(b) an unauthenticated write to a world-writable table. Both are silent.
**Severity:** HIGH (compliance) · **Confidence:** HIGH
**Recommendation:** fail **closed** — if the check cannot be performed, block access and page
someone. Make the enforcement flag a deploy-time constant, not a mutable row.

### F-ERR-05 — MEDIUM: auth state machine has four independent failure branches that all end in "signed out"
**Evidence.** `lib/auth-flow-v2.ts`
* `:200-245` cached-session path — a 2 s `getUser` timeout **destroys the session** (`SessionStorage.clearSession()` at `:243`).
* `:248-261` `getSession()` path with a 3 s timeout; a timeout is caught and ignored (`:259-261`).
* `:140-168` `performInitializeWithRetry` — after 2 retries, sets a generic error.
* `:328-338` the anonymous branch.
* `:478-489` the catch-all in `handleSupabaseSession`.
**Impact:** a slow network, a cold Supabase response, or a transient 5xx all present to the user
as "you have been logged out", with no distinction and no recovery path. Unsaved form state is
lost. The 50 ms state debounce (`:80-83`) can additionally reorder a redirect behind a
pending state update.
**Severity:** MEDIUM · **Confidence:** HIGH
**Recommendation:** distinguish *network* from *unauthenticated*; never destroy a session on
timeout; retry with jittered backoff; surface a reconnecting state; remove the debounce from
the auth path.

### F-ERR-06 — MEDIUM: no retry, backoff or dead-lettering for outbound Discord delivery
**Evidence.** `modules/discord-portal/sendToDiscord.ts:105-147` sends to all webhooks with
`Promise.allSettled` and logs failures; the only recovery is the manual
`retryFailedMessage(logId)` (`:266-333`), reachable only from `/dashboard/discord-portal/logs`.
`retryFailedMessage`'s failure branch (`:313-326`) has a **precedence bug**:
`(log.retry_count || 0) + 1` is written as `… || 0 + 1`, so `+ 1` binds to `0` — the counter
becomes `retry_count || 1` rather than `retry_count + 1`, and it never increments when
`retry_count` is 0.
**Impact:** failed notifications are silently lost; the retry counter is wrong; there is no
exponential backoff, no jitter, no dead-letter queue and no alert.
**Severity:** MEDIUM · **Confidence:** HIGH
**Recommendation:** transactional outbox → worker with exponential backoff and jitter → DLQ;
fix the increment; alert on DLQ depth.

### F-ERR-07 — MEDIUM: unhandled promise rejections from client fetches
**Evidence.** no `AbortController` anywhere (`rg "AbortController|signal:"` → 0); ~40 `fetch`
calls in client components inside `useEffect` with no cancellation and no `.catch` on many
(e.g. `app/dashboard/media/page.tsx`, `app/dashboard/discord-portal/*`).
**Impact:** navigating away mid-request produces state updates on unmounted components and
unhandled rejections; in development these surface as React warnings that mask real errors.
**Severity:** MEDIUM · **Confidence:** HIGH
**Recommendation:** a single typed fetch wrapper with `AbortSignal`, timeout, retry policy and
uniform error mapping; one `try/catch` per effect.

### F-ERR-08 — MEDIUM: HTTP 200 responses containing failure payloads
**Evidence.** `lib/api-utils.ts:154-169` `createSuccessResponse` returns `200` for arrays and
objects; several callers pass a `{ success: false }`-shaped object as data — e.g.
`app/api/attendances/route.ts:190` returns `{ success: true, attendance }` inside a 200, while
the failure branches return 4xx/5xx. Mixed conventions across ~50 handlers mean a client cannot
reliably branch on status alone.
**Impact:** client error handling is inconsistent; monitoring based on HTTP status under-counts
failures.
**Severity:** MEDIUM · **Confidence:** HIGH
**Recommendation:** one response envelope (`{data, error, meta}`) with correct status codes and
RFC 7807-style problem details for errors; generate the client from the schema.

### F-ERR-09 — LOW: error boundaries are wired at the app root only
**Evidence.** `app/error.tsx` and `app/global-error.tsx` are the only boundaries; there is no
`error.tsx` inside `app/dashboard/**`, and `app/error.tsx:28, 116` render `PublicNavigation` and
`PublicFooter`.
**Impact:** any error in a dashboard widget collapses the entire authenticated shell into a
public-looking page, losing navigation and context.
**Severity:** LOW · **Confidence:** HIGH
**Recommendation:** an `error.tsx` per route group; boundaries must inherit the route's layout.

## 3. Verdict
The error-handling *machinery* is present and reasonable in shape (standardised helpers, four
boundary layers). What is missing is **correctness under failure**: no type checking catches a
`ReferenceError`, no test exercises a handler, no error tracker observes production, production
logs are compiled out, the most destructive endpoint cannot detect its own failure, and the
agreement gate fails open. The result is a system that reports success while failing and hides
all evidence.
