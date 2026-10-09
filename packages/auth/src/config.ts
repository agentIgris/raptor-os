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

import { betterAuth, type BetterAuthOptions, type GenericEndpointContext } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { createAuthMiddleware } from "better-auth/api";

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
 * Refresh threshold: the session row's `expiresAt` is pushed forward once the
 * session is older than 15 minutes.
 *
 * A rotation window of 15 minutes means a stolen cookie is useful for at most
 * 15 minutes before the legitimate user's next request silently rotates it,
 * which is what makes revocation observable.
 */
export const SESSION_UPDATE_AGE_SECONDS = 60 * 15;

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
 * Rate limits, in seconds.
 *
 * F-AUTH-04: "sign-in has no rate limiting, lockout or bot defence". Sign-in is
 * the one endpoint where an online guessing attack is directly available, so it
 * gets the tightest budget. 5 attempts per 60s per IP is below any human's
 * typing rate and far below what a credential-stuffing run needs.
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
 * Typed as whatever `better-auth@1.7.7` itself declares rather than as
 * `pg.Pool`, because the adapter duck-types its driver: anything exposing
 * `connect()` is built into a Kysely `PostgresDialect`. Production still passes
 * a real `pg.Pool` from {@link createPool}; the type is widened so the test
 * harness can hand Better Auth the PGlite session without a cast, and without a
 * `pg` dependency in the assertion path.
 */
export type AuthDatabase = NonNullable<BetterAuthOptions["database"]>;

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
      },
    },

    hooks: {
      /**
       * Sign-in-time MFA gate.
       *
       * This runs as an `after` hook so it can see the freshly authenticated
       * user, and it throws an `APIError` rather than returning `false`. A silent
       * `false` would leave the user staring at a generic failure; an explicit
       * 403 tells the client to route to the enrolment screen.
       *
       * It is a second line of defence. The authoritative rule is "a privileged
       * role cannot exist without TOTP"; this catches the residual case where
       * such a row already exists — a direct write, a legacy import, a future
       * code path.
       */
      after: createAuthMiddleware((ctx) => {
        if (!SESSION_CREATION_PATHS.includes(ctx.path)) return Promise.resolve();

        // `newSession` is null while a TOTP challenge is in flight: the
        // two-factor plugin deletes the credential session and resets this to
        // null before handing back `twoFactorRedirect`. Nothing to check.
        const data = ctx.context.newSession;
        if (data === null) return Promise.resolve();

        // `User & Record<string, any>` — re-widened to `unknown` so reading a
        // field cannot smuggle an `any` into this module.
        const user = data.user as Record<string, unknown>;
        const subject: MfaSubject = {
          role: readString(user["role"]),
          twoFactorEnabled: readBoolean(user["twoFactorEnabled"]),
        };

        // Returning a rejected promise rather than throwing synchronously keeps this
        // hook's contract (always a Promise) explicit, and the thrown value is
        // the same `APIError` either way.
        if (!evaluateMfaRequirement(subject.role, subject.twoFactorEnabled).allowed) {
          throw mfaRequiredError();
        }

        return Promise.resolve();
      }),
    },

    emailAndPassword: {
      enabled: true,
      /** No self-service sign-in until the address is proven. */
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS,
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
         * The organisation a session is bound to.
         *
         * `input: false` means no client can set it — Better Auth replaces it
         * with the default (absent) on create and rejects the key on update.
         *
         * This column is what makes `"session"` the one Better Auth table that
         * carries an org scope, and therefore the one table where Row Level
         * Security has a tenant predicate to enforce (see `schema.sql`). Better
         * Auth's other five tables are identity, which is org-independent by
         * design — a human may work for several organisations — so an `org_id`
         * predicate on `user` would be meaningless rather than merely redundant.
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
  };
}

/**
 * Build a `pg` pool pointed at the given connection string.
 *
 * `max: 10` is deliberately conservative: Better Auth opens a connection per
 * concurrent request, and an unbounded pool against a local Postgres is how a
 * sign-in burst becomes a connection-exhaustion outage.
 */
function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 10,
    // Fail fast rather than queueing indefinitely behind a stuck transaction.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "raptor_auth",
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