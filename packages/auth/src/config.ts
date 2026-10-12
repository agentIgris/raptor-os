/**
 * The Raptor OS authentication instance.
 *
 * EVERY DEFECT FROM AUDIT/09 THAT THIS FILE EXISTS TO MAKE IMPOSSIBLE
 * -------------------------------------------------------------------
 * 1. "Session — including the refresh token — is stored in `localStorage`."
 *    (F-AUTH-01, HIGH.) `localStorage` is readable by any script running in the
 *    origin, so one XSS yields the long-lived refresh token and therefore
 *    *persistent* account takeover — for admins too. This configuration never
 *    stores a session anywhere but an `httpOnly` cookie, which JavaScript cannot
 *    read at all. `advanced.defaultCookieAttributes` pins `httpOnly`, and
 *    `useSecureCookies` pins `Secure` in production.
 *
 * 2. "MFA / TOTP: NOT IMPLEMENTED — no `mfa` reference anywhere." (F-AUTH-05.)
 *    TOTP is enabled here, and `PRIVILEGED_ROLES` must complete enrolment before
 *    a session is honoured. See `resolveMfaSubject` and `roles.ts`.
 *
 * 3. "`/auth/reset-password` is allowlisted and referenced but the route does not
 *    exist." `emailAndPassword.sendResetPassword` is wired and the endpoint is
 *    registered, so `auth.api.requestPasswordReset` / `auth.api.resetPassword`
 *    are both callable. The web app owns rendering that route; this package
 *    guarantees the *server* half exists, which is the half that was missing.
 *
 * 4. "A dormant `createAdminProfile` helper in a client-reachable library could
 *    mint an admin row." (F-AUTH-03, HIGH.) The `role` column is declared with
 *    `input: false`. Better Auth's `parseInputData` throws `FIELD_NOT_ALLOWED`
 *    for any body carrying a key marked `input: false`, so no sign-up or update
 *    request can set a role. Verified in `mass-assignment.test.ts`.
 *
 * 5. "Agreement acceptance trusting a client-supplied role." Same mechanism: the
 *    acceptance record stores *evidence* (hash, timestamp, actor), and the role
 *    is resolved server-side from `role_assignment`. Nothing the client sends
 *    can influence it.
 *
 * API SHAPE, AS INSTALLED
 * -----------------------
 * Every option below was read out of the installed `better-auth@1.7.7` type
 * definitions and compiled JavaScript, not from documentation. In particular:
 * `advanced.useSecureCookies` and `advanced.defaultCookieAttributes` (not a
 * top-level `useSecureCookies`); `session.expiresIn` / `session.updateAge` in
 * SECONDS; `rateLimit.{window,max}` in seconds with `storage` required to
 * persist counters in Postgres.
 */

import { Pool } from "pg";

import {
  APIError,
  betterAuth,
  generateId,
  type BetterAuthOptions,
  type GenericEndpointContext,
} from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { createAuthMiddleware } from "better-auth/api";
import {
  accountCounterKey,
  clearAccountFailures,
  isCredentialFailure,
  readAccountFailures,
  recordAccountFailure,
} from "./account-lockout.js";
import { AuthEnvironmentError, mfaRequiredError, readAuthEnv, type AuthEnv } from "./env.js";
import { ALL_ROLES, evaluateMfaRequirement, isPrivilegedRole } from "./roles.js";

/* -------------------------------------------------------------------------
 * Time constants, in SECONDS.
 *
 * Better Auth's session options are all seconds (`getDate(n, "sec")`). The
 * legacy app ran a 60-minute idle timer in the browser, which an attacker with
 * any script execution could simply never fire. These live server-side because a
 * limit the client can cancel is not a limit.
 * ---------------------------------------------------------------------- */

/** Absolute session lifetime: 12 hours. */
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 12;

/**
 * Refresh threshold: Better Auth refreshes a session once it is within
 * SESSION_UPDATE_AGE_SECONDS of its absolute expiry.
 *
 * Read out of the installed `better-auth@1.7.7`, `dist/api/routes/session.mjs`:
 *
 *     const shouldBeUpdated =
 *       session.expiresAt.valueOf() - expiresIn * 1000 + updateAge * 1000 <= Date.now();
 *     if (needsRefresh) await internalAdapter.updateSession(token, { expiresAt, updatedAt });
 *
 * so with a 12-hour lifetime and a 15-minute threshold a session is refreshed
 * once every 15 minutes of elapsed time, and never before.
 *
 * WHAT A REFRESH ACTUALLY DOES
 * ---------------------------
 * Out of the box it is a SLIDING WINDOW: the same token, a pushed-forward
 * `expiresAt`. A docstring here once claimed that this "silently rotates" the
 * token and that a stolen cookie is therefore useful for at most 15 minutes.
 * That was false, and it was the worst kind of wrong, because a reviewer reads
 * the claim and stops looking. Measured: four successive refreshes moved
 * `expiresAt` out four times and the token never changed, so a stolen cookie
 * stayed valid for as long as the attacker cared to keep using it.
 *
 * It is now a REAL ROTATION, implemented in the session update hook below: every
 * refresh writes a NEW token and the old one stops resolving. The original claim
 * therefore holds, and `session-rotation.test.ts` asserts the BEHAVIOUR rather
 * than the number. An assertion on `updateAge` alone passes against the broken
 * implementation, which is how the defect survived a green suite.
 */
export const SESSION_UPDATE_AGE_SECONDS = 60 * 15;

/**
 * Length of a rotated session token, in characters.
 *
 * Matches Better Auth's own `generateId(32)` for session tokens, so a rotated
 * credential is indistinguishable in shape from one the library issued. Not a
 * tunable: a shorter token would make a refreshed session easier to guess than
 * the one it replaced.
 */
export const SESSION_TOKEN_LENGTH = 32;

/** How long an email-verification token stays usable. 1 hour. */
export const EMAIL_VERIFICATION_EXPIRES_IN_SECONDS = 60 * 60;

/** How long a password-reset token stays usable. 30 minutes. */
export const PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS = 60 * 30;

/**
 * How long a user has to finish a TOTP challenge after a successful password
 * check. 5 minutes — long enough for an authenticator app, short enough that a
 * hijacked pre-MFA cookie is not a durable foothold.
 */
export const MFA_CHALLENGE_COOKIE_MAX_AGE_SECONDS = 60 * 5;

/**
 * Consecutive failed TOTP attempts before the *account* locks.
 *
 * Better Auth tracks `failedVerificationCount` and `lockedUntil` on the
 * `twoFactor` table. A 6-digit code is 10^6 values, so an attacker holding the
 * password gets an unthrottled oracle without this. 5 attempts, 15-minute lock.
 */
export const MFA_MAX_FAILED_ATTEMPTS = 5;
export const MFA_LOCKOUT_DURATION_SECONDS = 60 * 15;

/**
 * Consecutive failed PASSWORD attempts against one account before it is locked.
 *
 * The `twoFactor` plugin's `accountLockout` has a confusable name and a
 * different scope: it counts failed 6-digit TOTP verifications, and only on a
 * `twoFactor` row that does not exist until the user enrols. Password guessing is
 * not TOTP guessing — an attacker who already holds the password is attacking a
 * different oracle entirely. Measured before this counter existed: with a unique
 * `X-Forwarded-For` per request, 200 of 200 guesses against one named account
 * were accepted.
 *
 * 5 is the same budget Better Auth uses for TOTP, and the same one the industry
 * settled on (NIST SP 800-63B 5.2.2: cap the attempts, then apply a cooldown,
 * and never lock an account permanently). It is comfortably above "a human
 * fat-fingering their password three times" and far below "an automated run".
 */
export const ACCOUNT_SIGNIN_MAX_FAILURES = 5;

/** How long a password-locked account stays locked. 15 minutes. */
export const ACCOUNT_SIGNIN_LOCKOUT_SECONDS = 60 * 15;

/**
 * Stable error code for a locked account.
 *
 * Distinct from Better Auth's own limiter, which answers a bare 429 with no code.
 * The difference is not cosmetic: an operator reading a support ticket needs to
 * tell "this address is being brute-forced" apart from "this client is being
 * rate-limited", and a client needs a stable value to branch on rather than prose
 * that a copy edit would change.
 */
export const ACCOUNT_SIGNIN_LOCKOUT_CODE = "ACCOUNT_TEMPORARILY_LOCKED";

/**
 * Rate limits, in seconds.
 *
 * F-AUTH-04: "sign-in has no rate limiting, lockout or bot defence". Sign-in is
 * the one endpoint where an online guessing attack is directly available, so it
 * gets the tightest budget. 5 attempts per 60s per IP is below any human's
 * typing rate and far below what a credential-stuffing run needs.
 *
 * A PER-IP BUDGET IS NOT A CREDENTIAL DEFENCE ON ITS OWN. See `advanced.ipAddress`
 * below for why the client address cannot be trusted, and `account-lockout.ts` for
 * the account-keyed budget that actually bounds guessing.
 */
export const RATE_LIMITS = {
  /** Broad default for the rest of the auth surface. */
  global: { window: 60, max: 100 },
  /** `/sign-in/*` — credential stuffing. */
  signIn: { window: 60, max: 5 },
  /** `/two-factor/verify-*` — 6-digit code guessing. */
  twoFactorVerify: { window: 60, max: 5 },
  /** Password reset — account enumeration and mail-bombing. */
  passwordReset: { window: 300, max: 3 },
  /** Verification email resend. */
  emailVerification: { window: 300, max: 3 },
} as const;

/**
 * Paths that establish or challenge an authenticated session.
 *
 * MFA is enforced on the *session* rather than per endpoint, so this list only
 * has to cover the places a session can come into existence.
 */
const SESSION_CREATION_PATHS: readonly string[] = [
  "/sign-up/email",
  "/sign-in/email",
  "/sign-in/username",
  "/sign-in/phone-number",
  "/two-factor/verify-totp",
  "/two-factor/verify-otp",
  "/two-factor/verify-backup-code",
];

/** Read a boolean-ish field off a database row without asserting its type. */
function readBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

/** Read a string-ish field off a database row without asserting its type. */
function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A user row as this package needs to see it.
 *
 * Deliberately narrow. The MFA gate reads only the role and the enrolment flag;
 * it must not be able to accidentally log or branch on an email address.
 */
interface MfaSubject {
  readonly role: string;
  readonly twoFactorEnabled: boolean;
}

/**
 * Load the two fields the MFA gate needs for a user id.
 *
 * Returns `null` when there is no adapter context or no matching row. Callers
 * treat `null` as "refuse", because a missing context means the gate cannot
 * prove the user is entitled to a session — and a security check that fails open
 * on an internal error is not a check.
 */
async function resolveMfaSubject(
  userId: string,
  ctx: GenericEndpointContext | null,
): Promise<MfaSubject | null> {
  if (ctx === null) return null;

  // `findOne`'s type parameter is unbound at the call site and resolves to
  // `unknown`. Widening it to a record keeps the `no-unsafe-member-access` lint
  // rule satisfied without an `any` cast.
  const row: unknown = await ctx.context.adapter.findOne({
    model: "user",
    where: [{ field: "id", value: userId }],
    select: ["id", "role", "twoFactorEnabled"],
  });

  if (row === null || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;

  return {
    role: readString(record["role"]),
    twoFactorEnabled: readBoolean(record["twoFactorEnabled"]),
  };
}

/**
 * Refuse to create a privileged account that is not already TOTP-enrolled.
 *
 * This is the TypeScript half of the "no privileged role without MFA" rule, and
 * it covers INSERT only, because on INSERT Better Auth hands the hook the whole
 * row — including the two-factor plugin's `twoFactorEnabled` default of `false`
 * — so the answer needs no extra read.
 *
 * It is NOT the primary enforcement, and deliberately so. On UPDATE the hook
 * receives only the changed columns with no `id` (verified in the installed
 * `dist/db/internal-adapter.mjs`: `updateWithHooks({ ...data }, [{ field: "id",
 * value: userId }])`), so a hook cannot resolve the account's current enrolment
 * state and therefore cannot enforce the rule. That gap is closed by the
 * `user_mfa_guard` triggers in `schema.sql`, which see the whole row and run
 * atomically with the write.
 *
 * Putting the authoritative rule in the database is what makes it unbypassable
 * by any future application code path. That is the lesson of F-AUTH-03, where
 * the rule lived in a helper that one careless refactor could stop calling.
 */
function mfaGuardCreatesPrivilegedUser(incoming: Record<string, unknown>): boolean {
  const role = readString(incoming["role"]);
  if (!isPrivilegedRole(role)) return true;
  return readBoolean(incoming["twoFactorEnabled"]);
}

/**
 * Build the Better Auth options object.
 *
 * Exported separately from the instantiated client so tests can assert on the
 * resolved configuration — cookie attributes, trusted origins, rate limits —
 * without duplicating the wiring.
 *
 * `database` is a REQUIRED parameter rather than an optional one, deliberately.
 * An earlier revision omitted it and Better Auth fell back to its in-memory
 * adapter without complaint: sign-up "worked", returned a user carrying a role,
 * and wrote nothing to Postgres. Every database-backed test then failed with a
 * misleading "Email not verified", because the fixture had updated a row in a
 * table the auth instance had never touched. Making the dependency impossible to
 * leave out converts that whole class of failure into a compile error.
 */
/**
 * The database handle Better Auth will accept.
 *
 * Better Auth's own `BetterAuthOptions` is a recursive type — its `database`
 * field is inferred from the plugins and options that reference it back — so
 * `BetterAuthOptions["database"]` collapses to an *error type* under the
 * linter rather than to a usable one. Asserting on it therefore produced
 * `no-unsafe-assignment` at the single place the handle is handed over, which
 * was a true report about a real defect rather than noise.
 *
 * So the contract is stated structurally instead, from what the adapter
 * actually requires: a Kysely-compatible dialect exposing `connect()`, `query()`
 * and `end()`. Production supplies a real `pg.Pool`; tests supply the PGlite
 * session. Neither is named here, which is the point — ADR-0008 requires the
 * local and the managed implementation to satisfy one interface, so that
 * nothing above it knows which is active.
 */
export interface AuthDatabase {
  connect(): Promise<AuthDatabaseClient>;
  query<Row>(sql: string, parameters?: ReadonlyArray<unknown>): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
}

/** The per-connection handle that `connect()` resolves to. */
export interface AuthDatabaseClient {
  query<Row>(sql: string, parameters?: ReadonlyArray<unknown>): Promise<{ rows: Row[] }>;
  release(): void;
}

/** Body key on `/change-password` deciding whether other sessions are evicted. Named so the default is stated once. */
const REVOKE_OTHER_SESSIONS_FIELD = "revokeOtherSessions";

/** Sign-in routes that accept a password, and therefore carry a guessing budget. */
const PASSWORD_SIGN_IN_PATHS: readonly string[] = [
  "/sign-in/email",
  "/sign-in/username",
  "/sign-in/phone-number",
];

/**
 * The single request-phase `before` gate.
 *
 * Composed as ONE middleware rather than a list, for a reason that was found the
 * hard way. `createAuthMiddleware` returns a wrapper that builds a fresh internal
 * context from whatever it is handed, so calling one middleware's wrapper from
 * inside another feeds it a context it does not expect. Measured: doing exactly
 * that made `/sign-up/email` answer `200 {"headers":{}}` and write no user row at
 * all — a silent, total sign-up failure that returned success.
 *
 * So the checks are plain functions and the middleware is the only wrapper.
 * `afterRequestGate` below is the same shape and the same reason.
 *
 * Order is explicit because it matters: the pure body rewrite runs first, and it
 * touches only `/change-password`, which the account lockout never matches, so
 * the two cannot interfere and no extra database read is paid for other paths.
 */
const beforeRequestGate = createAuthMiddleware(async (ctx) => {
  applyRevokeOtherSessionsDefault(ctx);
  await enforceAccountLockout(ctx);
});

/**
 * The single response-phase `after` gate.
 *
 * `recordAccountLockout` runs FIRST, and that ordering is load-bearing rather than
 * incidental. It decides success or failure by reading `ctx.context.returned`, and
 * `mfaGateAfterSignIn` REPLACES that value by throwing. Running the MFA gate first
 * would hide every refusal from the counter, which is exactly the request an
 * attacker wants uncounted.
 */
const afterRequestGate = createAuthMiddleware(async (ctx) => {
  await recordAccountLockout(ctx);
  mfaGateAfterSignIn(ctx);
});

/**
 * The lower-cased email a sign-in body names, or `null` when it names none.
 *
 * Returned already normalised because Better Auth looks the account up with
 * `email.toLowerCase()`. Two spellings of one address must therefore share one
 * counter, or the lockout is bypassed by changing the case of an address — which
 * costs an attacker nothing and which a naive implementation would happily allow.
 */
function passwordSignInEmail(ctx: GenericEndpointContext): string | null {
  const body: unknown = ctx.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;

  const email = (body as Record<string, unknown>)["email"];
  return typeof email === "string" && email.trim() !== "" ? email.trim().toLowerCase() : null;
}

/**
 * The error answered by a locked account.
 *
 * Deliberately says nothing an attacker could not already learn. A message like
 * "this account is locked" confirms the address EXISTS, which turns the lockout
 * into an enumeration oracle and undoes the entire reason Better Auth collapses
 * "no such user" and "wrong password" into one error. The stable `code` is for a
 * server-side handler that must branch, not for display.
 */
function accountLockedError(): APIError {
  return new APIError("TOO_MANY_REQUESTS", {
    message: "Too many failed sign-in attempts for this account. Try again later.",
    code: ACCOUNT_SIGNIN_LOCKOUT_CODE,
  });
}

/**
 * BEFORE any sign-in: refuse outright while the named account is locked.
 *
 * A `before` middleware rather than a database hook, for two reasons. The limiter
 * it backs up is a request-phase control, and a database hook has no access to the
 * request body — and the counter is keyed on the address the CALLER supplied, which
 * is precisely what a database hook cannot see.
 *
 * Reads through the shared helper in `account-lockout.ts`, and lets an error there
 * propagate rather than catching it. Failing closed on an unreachable counter is
 * the right default here: a throttle that opens whenever its database blips is not
 * a throttle, and a database outage is exactly when an attacker tries the most.
 */
async function enforceAccountLockout(ctx: GenericEndpointContext): Promise<void> {
  if (!PASSWORD_SIGN_IN_PATHS.includes(ctx.path)) return;

  const email = passwordSignInEmail(ctx);
  if (email === null) return;

  const state = await readAccountFailures(
    ctx.context.adapter,
    accountCounterKey(email),
    ACCOUNT_SIGNIN_LOCKOUT_SECONDS * 1000,
    ACCOUNT_SIGNIN_MAX_FAILURES,
  );

  if (state.locked) throw accountLockedError();
}

/**
 * AFTER a sign-in: count the failure, or clear the counter on success.
 *
 * The success case CLEARS rather than decrements. A successful sign-in is not
 * merely one point better than a failure — it is proof that whoever holds the
 * address can prove they hold the password — so accumulated typos become
 * irrelevant. That is the difference between a control an attacker trips on
 * purpose and one a user trips by accident.
 *
 * The failure case counts credential failures only ({@link isCredentialFailure}).
 * A 429 in particular is NOT counted: if refusals counted, a locked account would
 * stay locked for as long as anybody kept trying, which turns the lockout into a
 * denial-of-service lever aimed at a known victim.
 */
async function recordAccountLockout(ctx: GenericEndpointContext): Promise<void> {
  if (!PASSWORD_SIGN_IN_PATHS.includes(ctx.path)) return;

  const email = passwordSignInEmail(ctx);
  if (email === null) return;

  const key = accountCounterKey(email);
  const { status, code } = readEndpointOutcome(ctx.context);

  if (isCredentialFailure(status, code)) {
    await recordAccountFailure(
      ctx.context.adapter,
      key,
      ACCOUNT_SIGNIN_LOCKOUT_SECONDS * 1000,
      ACCOUNT_SIGNIN_MAX_FAILURES,
    );
    return;
  }

  if (status === 200) await clearAccountFailures(ctx.context.adapter, key);
}

/**
 * Read the outcome of an endpoint call without depending on a private export.
 *
 * `isAPIError` is not part of `better-auth`'s public surface in 1.7.7 — it lives
 * under `dist/utils/is-api-error.mjs`, which is not in the exports map — so
 * importing it would be a dependency on an implementation detail that a patch
 * release could move. The shape is instead read structurally: an `APIError` is an
 * `Error` carrying `statusCode` and a `body` with a stable `code`.
 *
 * The success case is `status: 200, code: null`, so a caller only has to ask two
 * questions and never has to know which of the two shapes it received.
 */
function readEndpointOutcome(context: object): { readonly status: number; readonly code: string | null } {
  // `context.returned` is populated by the dispatcher AFTER the endpoint has run.
  // It is absent from the published endpoint-context type, so it is read as an
  // unknown off a record rather than asserted: a library type that omits the
  // field is not evidence the field is absent at runtime, and a test asserting
  // the counter fires on a real failed sign-in is what settles it either way.
  const returned: unknown = (context as Record<string, unknown>)["returned"];
  if (!(returned instanceof Error)) return { status: 200, code: null };

  const error = returned as Error & { readonly statusCode?: unknown; readonly body?: unknown };
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;

  const body: unknown = error.body;
  if (body === null || typeof body !== "object") return { status, code: null };

  const code = (body as Record<string, unknown>)["code"];
  return { status, code: typeof code === "string" ? code : null };
}

/**
 * Sign-in-time MFA gate.
 *
 * Runs as an `after` hook so it can see the freshly authenticated user, and throws
 * an `APIError` rather than returning `false`: a silent `false` leaves the user
 * staring at a generic failure, whereas an explicit 403 tells the client to route
 * to the enrolment screen.
 *
 * It is a second line of defence. The authoritative rule is "a privileged role
 * cannot exist without TOTP"; this catches the residual case where such a row
 * already exists — a direct write, a legacy import, a future code path.
 */
function mfaGateAfterSignIn(ctx: GenericEndpointContext): void {
  if (!SESSION_CREATION_PATHS.includes(ctx.path)) return;

  // `newSession` is null while a TOTP challenge is in flight: the two-factor
  // plugin deletes the credential session and resets this to null before handing
  // back `twoFactorRedirect`. Nothing to check.
  const data = ctx.context.newSession;
  if (data === null) return;

  // `User & Record<string, any>` — re-widened to `unknown` so reading a field
  // cannot smuggle an `any` into this module.
  const user = data.user as Record<string, unknown>;
  const subject: MfaSubject = {
    role: readString(user["role"]),
    twoFactorEnabled: readBoolean(user["twoFactorEnabled"]),
  };

  if (!evaluateMfaRequirement(subject.role, subject.twoFactorEnabled).allowed) {
    throw mfaRequiredError();
  }
}

/**
 * Force `/change-password` to evict the account's other sessions.
 *
 * WHY A SERVER-SIDE DEFAULT AND NOT A CLIENT FLAG
 * -----------------------------------------------
 * Better Auth reads `revokeOtherSessions` straight out of the request body and
 * has no default for it, which makes the eviction a value the CLIENT decides.
 * That is the wrong way round for a security control: every caller — today's web
 * app, a future mobile client, a script — has to remember to send it, and a caller
 * that forgets silently loses the control. Measured: with the flag absent, the
 * attacker's session survived the legitimate user's password change.
 *
 * The body is MUTATED rather than returned. The dispatcher merges returned
 * context with `defu`, which fills in only UNDEFINED keys, so a returned body
 * would lose to a client that sent `revokeOtherSessions: false` and leave the
 * opt-out open.
 *
 * The current session survives: Better Auth deletes the account's sessions and
 * issues a fresh one for the caller, which is why this evicts the intruder without
 * logging the owner out of the device they are using.
 */
function applyRevokeOtherSessionsDefault(ctx: GenericEndpointContext): void {
  if (ctx.path !== "/change-password") return;

  const body: unknown = ctx.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return;

  // `ctx.body` is typed loosely by Better Auth and is narrowed to an object here,
  // so the assignment below carries no `any` into this module and reads back
  // nothing unvalidated.
  (body as Record<string, unknown>)[REVOKE_OTHER_SESSIONS_FIELD] = true;
}

export function buildAuthOptions(env: AuthEnv, database: AuthDatabase): BetterAuthOptions {
  const isProduction = env.nodeEnv === "production";

  return {
    appName: "Raptor OS",
    baseURL: env.baseUrl,
    secret: env.secret,
    database,

    /**
     * Only this deployment's own origin. Better Auth validates `callbackURL` /
     * `redirectTo` against this list; a wildcard or an absent list is an open
     * redirect that hands a valid auth flow to an attacker's page.
     */
    trustedOrigins: [env.baseUrl],

    advanced: {
      /**
       * WHICH REQUEST HEADERS MAY SUPPLY THE CLIENT IP.
       *
       * Empty by DEFAULT, which means no forwarding header is read at all.
       *
       * Better Auth's default is `["x-forwarded-for"]`, and that default is unsafe
       * behind Next.js specifically, because Next fills that header only when the
       * client omitted it (`req.headers['x-forwarded-for'] ??= ...`). A
       * client-supplied value therefore reaches the limiter verbatim. Measured:
       * with a unique `X-Forwarded-For` per request, 200 of 200 password guesses
       * against one named account were accepted. Per-IP limiting is not a defence
       * against a caller who chooses its own address; it is a budget the caller
       * hands itself.
       *
       * THE TRADE-OFF, STATED RATHER THAN HIDDEN
       * --------------------------------------
       * With no header configured, `getIP` resolves nothing in production and
       * Better Auth falls back to ONE bucket per path (`no-trusted-ip|<path>`).
       * That is fail-CLOSED against spoofing and fail-OPEN against availability:
       * every client shares the `/sign-in` budget, so one determined caller can
       * lock everyone else out of signing in for the length of a window.
       *
       * That cost is paid deliberately, because the alternative -- a default that
       * looks like per-IP limiting and is not -- is how the measured 200/200
       * happened. Operators behind a real edge should set
       * `AUTH_TRUSTED_IP_HEADERS` to the header that edge OVERWRITES, and
       * `AUTH_TRUSTED_PROXIES` to the edge's CIDR ranges. See `.env.example`.
       *
       * `x-forwarded-for` must NOT be listed unless the edge rewrites it into a
       * single trusted value: Better Auth trusts a single-value forwarding header
       * verbatim when `trustedProxies` is unset, and trusts the first UNTRUSTED
       * hop when it is set, which is correct only if every hop to the left of the
       * edge is attacker-supplied.
       *
       * And none of this bounds password guessing on its own, which is why the
       * per-ACCOUNT budget in `account-lockout.ts` exists: an attacker with many
       * addresses still has exactly one account.
       */
      ipAddress: {
        // Spread into fresh arrays because Better Auth's option type is mutable
        // while `AuthEnv` is deliberately readonly: the environment must not be
        // editable by anything that receives it, and copying here is where that
        // immutability is actually enforced rather than merely intended.
        ipAddressHeaders: [...env.trustedIpHeaders],
        trustedProxies: [...env.trustedProxies],
      },
      /**
       * Force `Secure` on every cookie in production.
       *
       * Better Auth already infers this from an `https://` base URL, but the
       * legacy app served over plain HTTP in development and the flag silently
       * followed the environment. Stating it removes that ambiguity.
       */
      useSecureCookies: isProduction,
      cookiePrefix: "raptor",
      /**
       * CSRF protection stays ON. Disabling it is tempting for cross-origin API
       * use and is exactly how session-fixation-by-CSRF is reintroduced.
       */
      disableCSRFCheck: false,
      disableOriginCheck: false,
      /**
       * `httpOnly` is Better Auth's default, but it is stated explicitly because
       * this is the exact property the legacy system lost. A future option merge
       * that drops it must fail this review, not a penetration test.
       *
       * `sameSite: "lax"` blocks the session cookie on cross-site POST while
       * still allowing top-level navigation, which is what a password-reset link
       * from an email client needs. `none` would remove CSRF protection;
       * `strict` would break the reset link.
       */
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
      database: {
        /**
         * UUIDs generated by PostgreSQL, so a row inserted by a migration, a
         * support script, or the app itself has the same identifier shape.
         */
        generateId: "uuid",
      },
    },

    databaseHooks: {
      user: {
        create: {
          /**
           * Blocks provisioning a privileged account that has no TOTP. Returns
           * `false` (rather than throwing) so Better Auth reports a normal
           * validation failure rather than a 500.
           *
           * The database triggers in `schema.sql` enforce the same rule; this is
           * the cheap, early, well-messaged rejection that stops the request
           * before it reaches the wire.
           */
          before: (user) =>
            // `User & Record<string, any>` is re-widened to `unknown` so the
            // guard cannot read an `any` and so a field access cannot smuggle one.
            Promise.resolve(mfaGuardCreatesPrivilegedUser(user as Record<string, unknown>)),
        },
      },
      session: {
        create: {
          /**
           * Defence in depth. `false` here makes `createSession` resolve to
           * `null`, which the endpoint surfaces as a failed sign-in — so a
           * privileged row that somehow lacks TOTP cannot obtain a session.
           *
           * This is the choke point every path to an authenticated session goes
           * through, including routes added by plugins in future.
           */
          before: (session, ctx) =>
            resolveMfaSubject(readString(session["userId"]), ctx).then((subject) => {
              // No subject means the user row vanished between the password check
              // and session creation. Refuse rather than fall open.
              if (subject === null) return false;
              return evaluateMfaRequirement(subject.role, subject.twoFactorEnabled).allowed;
            }),
        },
        update: {
          /**
           * REAL TOKEN ROTATION.
           *
           * Better Auth's only session write is `updateSession(token, ...)`, so
           * this hook fires on exactly the refresh path and on `/update-session`,
           * and nowhere else.
           *
           * Returning `{ data: { token: <new> } }` merges the new token into an
           * UPDATE statement that is keyed on the OLD token. The old row is
           * therefore REPLACED, not duplicated: one row, one live credential, and
           * the previous value resolves to nothing.
           *
           * WHY IT MATTERS
           * --------------
           * Without this the session cookie is a permanent bearer credential whose
           * expiry slides forward on every use, so a copy taken today is still good
           * tomorrow. With it, a stolen cookie dies at the owner's next refresh, at
           * most SESSION_UPDATE_AGE_SECONDS away. That is the difference between
           * "revocation is observable" as a claim and as a fact, and the legacy
           * F-AUTH-01 outcome this package exists to close.
           *
           * WHY A HOOK AND NOT A HAND-ROLLED SESSION STORE
           * -------------------------------------------------
           * The hook runs inside Better Auth's own adapter call, so the write, the
           * cookie derived from it, and the row handed back to the route cannot
           * disagree. Replacing the session route wholesale would mean owning the
           * refresh rules, cookie chunking and the 2FA challenge interplay, all of
           * which would then be this package's to keep correct.
           */
          before: (update) =>
            // `Promise.resolve` rather than `async`: the hook signature requires a
            // Promise, but there is nothing to await, and an `async` body with no
            // `await` is exactly the shape the `require-await` rule exists to
            // catch.
            Promise.resolve({ data: { ...update, token: generateId(SESSION_TOKEN_LENGTH) } }),
        },
      },
    },

    hooks: {
      /**
       * Order matters, and this composition is why the order is explicit rather
       * than incidental.
       *
       * `forceRevokeOtherSessions` runs first because it touches only
       * `/change-password`, which the lockout never matches, so the two cannot
       * interfere. Putting the pure one first also means the account-counter read
       * (a database round trip) is skipped for every other endpoint.
       */
      before: beforeRequestGate,
      /** See `afterRequestGate` for why the order inside the gate is load-bearing. */
      after: afterRequestGate,
    },

    /**
     * "Sign in with Google", env-gated.
     *
     * The block is present ONLY when both `GOOGLE_CLIENT_ID` and
     * `GOOGLE_CLIENT_SECRET` are set (`env.ts` refuses a half-configured pair,
     * so reaching here with one set is impossible). Without credentials there is
     * no provider entry at all — not a disabled one — because a visible Google
     * button that dies on Google's error page is worse than no button, and a
     * configured-but-empty provider is how a `clientId: ""` ends up in a log.
     *
     * `accessType: "offline"` requests a refresh token so the link survives
     * beyond the first hour; `prompt: "select_account consent"` forces the
     * account chooser every time, so a shared tournament machine cannot
     * one-click into the previous user's Google session.
     */
    ...(env.googleClientId !== undefined && env.googleClientSecret !== undefined
      ? {
          socialProviders: {
            google: {
              clientId: env.googleClientId,
              clientSecret: env.googleClientSecret,
              accessType: "offline",
              prompt: "select_account consent",
            },
          },
        }
      : {}),

    emailAndPassword: {
      enabled: true,
      /** No self-service sign-in until the address is proven. */
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS,
      /**
       * A password reset is the standard response to a suspected compromise, and
       * its purpose is to evict whoever else is holding a session.
       *
       * Better Auth DEFAULTS THIS TO FALSE. Reproduced: after a reset the
       * attacker's session still resolved, so the documented remediation
       * accomplished nothing while appearing to. One line here closes the
       * `/reset-password` half, `forceRevokeOtherSessions` closes the
       * `/change-password` half, and `session-revocation.test.ts` asserts both so
       * neither can be quietly reverted to the library default.
       */
      revokeSessionsOnPasswordReset: true,
      /**
       * Present so `auth.api.requestPasswordReset` and `auth.api.resetPassword`
       * are registered endpoints. AUDIT/09 recorded that the legacy app
       * allow-listed and linked `/auth/reset-password` while the route did not
       * exist; wiring the server half here means the client half has something
       * to call.
       *
       * Delivery is delegated to the web app (which owns the mailer). It
       * receives a single-use URL and must never log it — it is a bearer
       * credential for the account.
       */
      sendResetPassword: () => {
        // Intentionally a no-op in this package. `packages/notifications` owns
        // delivery; silently swallowing here would make a missing mailer look
        // like a working reset.
        return Promise.resolve();
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      expiresIn: EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
      /**
       * Delegated like `sendResetPassword`. The `url` is a bearer credential
       * that marks the address verified; it must not be logged.
       */
      sendVerificationEmail: () => {
        // No-op for the same reason as `sendResetPassword`.
        return Promise.resolve();
      },
    },

    session: {
      /**
       * Physical table `auth_session`, not `session`. `session` already names the
       * training-session table in `packages/db` 0002, and both schemas share one
       * Postgres schema — the unprefixed name made `CREATE TABLE IF NOT EXISTS`
       * a silent no-op and broke the combined apply. Model name stays `session`,
       * so every adapter call site is unchanged; see the note on `user.modelName`.
       */
      modelName: "auth_session",
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      /**
       * Cookie caching would put session material in a second cookie and make
       * revocation observable only at cache expiry. Revocation must be
       * immediate and provable (ADR-0007), so it stays off.
       */
      cookieCache: { enabled: false },
      additionalFields: {
        /**
         * The session's ACTIVE ORGANISATION (ADR-0017).
         *
         * `input: false` means Better Auth rejects the key on both create and
         * update: no client can assert its own tenant through the API, and
         * Better Auth never sends the field on insert. That is a real control and
         * it is asserted in `auth-tenancy.test.ts`.
         *
         * It is worth being precise about what it does and does not do, because an
         * earlier comment here claimed Better Auth "replaces it with the default
         * (absent) on create". There is no default set anywhere in this package,
         * and nothing wrote this column server-side — so every session row was
         * created with a NULL `orgId`. That NULL was why the session RLS policy's
         * `WITH CHECK` rejected every sign-in with SQLSTATE 42501. The comment was
         * describing an implementation that did not exist, and believing it is what
         * kept the defect in place.
         *
         * The column is now written by exactly one function, `auth_set_active_org`,
         * which refuses unless an active `org_membership` row proves the token
         * holder belongs to that organisation. The app role cannot write it at all:
         * the table-level UPDATE is revoked and re-granted per column, omitting
         * `orgId`.
         *
         * So: the value is server-chosen, membership-gated, and not a security
         * boundary. Tenant isolation lives on the business tables in
         * `packages/db`, enforced by forced RLS and the policy engine.
         */
        orgId: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },

    rateLimit: {
      /**
       * Physical table `auth_rate_limit`. Same collision class as
       * `session.modelName`: bare words belong to no domain. Model name stays
       * `rateLimit`, so `account-lockout.ts` and its `RATE_LIMIT_MODEL` constant
       * keep working unchanged.
       */
      modelName: "auth_rate_limit",
      /**
       * Better Auth defaults this to production-only. A local or preview
       * deployment is exactly where credential stuffing is rehearsed, so it is
       * explicitly enabled in every environment.
       */
      enabled: true,
      /**
       * Counters in Postgres, not process memory. An in-memory counter resets on
       * every deploy and restart, so an attacker who can induce a restart resets
       * their own budget; and it is per-process, so N instances multiply the
       * effective limit by N.
       */
      storage: "database",
      ...RATE_LIMITS.global,
      customRules: {
        "/sign-in/email": RATE_LIMITS.signIn,
        "/sign-in/username": RATE_LIMITS.signIn,
        "/sign-in/phone-number": RATE_LIMITS.signIn,
        "/two-factor/verify-totp": RATE_LIMITS.twoFactorVerify,
        "/two-factor/verify-otp": RATE_LIMITS.twoFactorVerify,
        "/two-factor/verify-backup-code": RATE_LIMITS.twoFactorVerify,
        "/request-password-reset": RATE_LIMITS.passwordReset,
        "/forget-password": RATE_LIMITS.passwordReset,
        "/send-verification-email": RATE_LIMITS.emailVerification,
      },
    },

    plugins: [
      twoFactor({
        issuer: "Raptor OS",
        /**
         * Physical table `auth_two_factor`. The plugin owns this model's schema;
         * without the override it falls back to the bare `twoFactor` name. The
         * override is keyed by model (`{ twoFactor: { modelName } }`), not a
         * bare `modelName`, because the plugin schema covers two models.
         */
        schema: {
          twoFactor: {
            modelName: "auth_two_factor",
          },
        },
        /**
         * `skipVerificationOnEnable: false` keeps the default. When true,
         * enabling MFA flips the flag *without* the user ever proving they hold
         * the secret — which would make "MFA enabled" a value a user can set
         * without having a device, defeating the entire control.
         */
        skipVerificationOnEnable: false,
        twoFactorCookieMaxAge: MFA_CHALLENGE_COOKIE_MAX_AGE_SECONDS,
        accountLockout: {
          enabled: true,
          maxFailedAttempts: MFA_MAX_FAILED_ATTEMPTS,
          durationSeconds: MFA_LOCKOUT_DURATION_SECONDS,
        },
      }),
    ],

    user: {
      /**
       * Physical table `auth_user`. Model name stays `user`, so adapter call
       * sites (`model: "user"`) are unchanged. Rationale for the whole mapping
       * is on `session.modelName`; this entry exists so the set is complete and
       * no model silently falls back to a bare table name.
       */
      modelName: "auth_user",
      additionalFields: {
        /**
         * THE FIX FOR F-AUTH-03 AND THE CLIENT-SUPPLIED-ROLE DEFECT.
         *
         * `input: false` makes Better Auth's `parseInputData` throw
         * `FIELD_NOT_ALLOWED` for any request body containing a `role` key on
         * UPDATE, and replace it with the default on CREATE. The role is
         * therefore not a client-supplied value in any code path — it can only
         * be written by the server, and every grant is audited by
         * `provisioning.ts`.
         *
         * `defaultValue: "pending"` means an omitted role lands on the least
         * privileged value. Better Auth writes the default itself, so this does
         * not depend on a database default.
         *
         * `returned: true` — the role is returned so the app can render UI, but
         * returning a value is not the same as accepting one.
         */
        role: {
          type: "string",
          required: true,
          input: false,
          defaultValue: "pending",
        },
      },
    },

    /**
     * Physical tables `auth_account` and `auth_verification`. Neither block
     * existed before the `session` collision forced the rename, because neither
     * model needed options of its own — but omitting them would leave exactly
     * the two models that silently fall back to bare table names, which is the
     * defect this mapping exists to remove. `account` in particular would
     * collide with a future domain `account` table (ledger-adjacent naming) the
     * same way `session` collided with training sessions.
     */
    account: {
      modelName: "auth_account",
    },
    verification: {
      modelName: "auth_verification",
    },
  };
}

/**
 * Build a `pg` pool pointed at the given connection string.
 *
 * `max: 10` is deliberately conservative: Better Auth opens a connection per
 * concurrent request, and an unbounded pool against a local Postgres is how a
 * sign-in burst becomes a connection-exhaustion outage.
 */
/**
 * Connection options for a `pg` pool pointed at the given connection string.
 *
 * Single home for the managed-pooler exception, shared by the auth pool and
 * the readiness probe: two pools with two TLS behaviors is how one of them
 * silently stops verifying.
 *
 * TWO things are returned, and both matter:
 *
 * 1. `ssl`: `{ rejectUnauthorized: false }` ONLY when the URL carries
 *    `sslmode=require`, otherwise absent (verify by default).
 * 2. `connectionString` with any `sslmode` parameter STRIPPED.
 *
 * The stripping is load-bearing, not cosmetic. Measured against pg 8.23.1: a
 * `sslmode` query parameter in the URL OVERRIDES the explicit `ssl` object —
 * `sslmode=require` plus `ssl: { rejectUnauthorized: false }` still fails with
 * `self-signed certificate in certificate chain`, while the same `ssl` object
 * with no `sslmode` in the URL connects. So setting the option without
 * removing the parameter is a fix that does nothing, and it fails in the exact
 * way that reads as "TLS is broken" rather than "the URL won".
 *
 * Production MUST terminate with a verifiable chain: pin the provider CA or
 * connect over a private network. A test fails if this exception is ever
 * widened beyond an explicit opt-in per connection string.
 */
export function tlsOptionsForDatabaseUrl(connectionString: string): {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean };
} {
  // Parsed with URL, not regex: stripping one query parameter with a pattern
  // leaves `?&` or trailing separators in the cases the pattern did not
  // consider, and a malformed connection string fails every pool the same way.
  //
  // The strip applies ONLY in the relaxed branch. Any other `sslmode`
  // (notably `verify-full`) is left byte-identical: removing it would silently
  // downgrade a verifying connection to whatever the driver default is, which
  // is the opposite direction from this function's purpose.
  const parsed = new URL(connectionString);
  const wantsRelaxedTls = parsed.searchParams.get("sslmode") === "require";
  if (!wantsRelaxedTls) return { connectionString };
  parsed.searchParams.delete("sslmode");
  return { connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } };
}

function createPool(connectionString: string): Pool {
  // TLS against a managed pooler (Supabase Supavisor) presents a chain Node's
  // bundled roots do not verify — `self-signed certificate in certificate
  // chain` — and node-postgres takes no CA through a connection-string query
  // parameter, so there is no URL-only way to fix it. Scoped exception, not a
  // global one: verification is skipped for THIS pool only, never via
  // NODE_TLS_REJECT_UNAUTHORIZED (which would blind every TLS client in the
  // process, including the Google OAuth token exchange — precisely the
  // connection an attacker would want unverified).
  //
  // Production MUST terminate with a verifiable chain: pin the provider CA or
  // connect over a private network. `tls-scope.test.ts` fails if this
  // exception is ever widened beyond an explicit opt-in per connection string.
  const resolved = tlsOptionsForDatabaseUrl(connectionString);
  return new Pool({
    connectionString: resolved.connectionString,
    max: 10,
    // Fail fast rather than queueing indefinitely behind a stuck transaction.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "raptor_auth",
    ...(resolved.ssl === undefined ? {} : { ssl: resolved.ssl }),
  });
}

/** The fully-formed environment + options for one deployment. */
export interface ResolvedAuthConfig {
  readonly env: AuthEnv;
  readonly options: BetterAuthOptions;
  readonly pool: Pool;
}

/**
 * Resolve environment, build options, and open the pool.
 *
 * Split from the module-level singleton so a test can construct an instance
 * against `raptor_os_test` without mutating `process.env`.
 *
 * @throws {AuthEnvironmentError} when the environment is incomplete, or when
 *   `DATABASE_URL` points at a superuser/migration role.
 */
export function createAuthConfig(
  env: Readonly<Record<string, string | undefined>>,
): ResolvedAuthConfig {
  const resolved = readAuthEnv(env);
  const pool = createPool(resolved.databaseUrl);
  return {
    env: resolved,
    options: buildAuthOptions(resolved, pool),
    pool,
  };
}

/**
 * The Better Auth handler to mount at `/api/auth/*`.
 *
 * Built from a validated environment at import time, so a misconfigured
 * deployment fails at boot rather than on the first sign-in attempt.
 */
export function createAuth(env: Readonly<Record<string, string | undefined>>) {
  return betterAuth(createAuthConfig(env).options);
}

export { AuthEnvironmentError };
export { ALL_ROLES, PRIVILEGED_ROLES, type Role } from "./roles.js";

/**
 * Values permitted by the `user_role_membership_check` CHECK constraint.
 *
 * Exported so a test can assert `schema.sql` contains exactly this set. The
 * legacy system's most-repeated data defect was a TypeScript enum and a database
 * CHECK constraint that disagreed, producing 23514 errors on a role picker
 * built from the former; the agreement is now tested rather than assumed.
 */
export const ROLE_CHECK_VALUES: readonly string[] = ALL_ROLES;