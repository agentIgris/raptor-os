/**
 * Integration-test fixtures.
 *
 * WHY A REAL POSTGRESQL AND NOT A STUB
 * ------------------------------------
 * Every property these tests assert is a property of PostgreSQL itself:
 *
 *   - an expired session must be rejected, which is a comparison of
 *     `expires_at` against `now()` in a `timestamptz` column;
 *   - a revoked session must be rejected, which is the absence of a row after
 *     a `DELETE`;
 *   - rate limiting must engage, which is a counter surviving in the
 *     `"rateLimit"` table across requests;
 *   - `user_mfa_guard_trigger` must reject a privileged row without TOTP, which
 *     is a `RAISE EXCEPTION` inside a `BEFORE` trigger;
 *   - the session RLS policy must hide another tenant's row, which is
 *     `current_org_id()` read out of a session GUC.
 *
 * A PGlite or in-memory stub would let all of these pass while proving nothing
 * about the deployed database, which is exactly the failure mode ADR-0002 and
 * ADR-0014 exist to correct.
 *
 * WHY TWO CONNECTIONS
 * -------------------
 * Fixtures are written as `raptor_migrator` (SUPERUSER) and assertions are made
 * as `raptor_app` (NOSUPERUSER NOBYPASSRLS). A single superuser connection
 * would bypass every policy under test — the "isolation silently absent" output
 * recorded in ADR-0006. Asserting as `raptor_app` is what makes the RLS
 * assertion mean anything.
 *
 * SECRET HYGIENE
 * --------------
 * The test password is a constant defined below and is NOT a secret; it exists
 * only to satisfy Better Auth's minimum length. Nothing in this file logs a
 * password, a session token, or a cookie value, and no failure message contains
 * one.
 */

import { Pool } from "pg";
import { betterAuth, type BetterAuthOptions } from "better-auth";

import { buildAuthOptions } from "./config.js";
import { readAuthEnv, type AuthEnv } from "./env.js";

/**
 * A throwaway credential for local test fixtures only.
 *
 * 48 characters, so Better Auth's >= 32 warning and low-entropy heuristic both
 * stay quiet and the tests exercise the production code path rather than a
 * warning branch. It authenticates against `raptor_os_test` on loopback and
 * protects nothing.
 */
export const TEST_PASSWORD = "local-test-only-password-never-used-elsewhere";

/** Signing secret for the test instance. Same reasoning as above. */
const TEST_SECRET = "local-test-only-signing-secret-0123456789abcdef";

/** Must match `trustedOrigins` in the options, or Better Auth rejects the request. */
export const TEST_BASE_URL = "http://localhost:3000";

/** The application role. NOSUPERUSER NOBYPASSRLS (ADR-0006). */
export const APP_DATABASE_URL =
  "postgresql://raptor_app:raptor_local_dev_only@127.0.0.1:5432/raptor_os_test";

/**
 * The migration role. SUPERUSER — DDL only.
 *
 * NEVER give this to `config.ts` or to any application environment. It is
 * reachable here only because the fixtures must create rows that the MFA trigger
 * would otherwise refuse to create.
 */
export const MIGRATOR_DATABASE_URL =
  "postgresql://raptor_migrator:raptor_local_dev_only@127.0.0.1:5432/raptor_os_test";

/** Environment that `readAuthEnv` accepts, for the test deployment. */
export const TEST_ENV: Readonly<Record<string, string>> = {
  BETTER_AUTH_SECRET: TEST_SECRET,
  BETTER_AUTH_URL: TEST_BASE_URL,
  DATABASE_URL: APP_DATABASE_URL,
  NODE_ENV: "test",
};

/** Validated environment for the test deployment. */
export const TEST_AUTH_ENV: AuthEnv = readAuthEnv(TEST_ENV);

/** Better Auth options for the test deployment, bound to the app-role pool. */
export function testAuthOptions(appPool: Pool): BetterAuthOptions {
  return buildAuthOptions(TEST_AUTH_ENV, appPool);
}

/**
 * A Better Auth instance wired to `raptor_os_test` through the app role.
 *
 * Built per fixture rather than shared, because Better Auth's hooks and
 * rate-limit counters carry state and a single shared instance would let one
 * test's side effects cascade into another's.
 *
 * The pool is passed in rather than created here so that the fixture owns the
 * connection lifecycle and `close()` cannot leave a dangling pool.
 */
export function createTestAuth(appPool: Pool) {
  return betterAuth(testAuthOptions(appPool));
}

/** A fixture that owns two pools and the auth instance built over them. */
export interface AuthTestFixture {
  /** Application-role pool. Used for assertions that must respect RLS. */
  readonly appPool: Pool;
  /** Migration-role pool. Used to write fixtures RLS would otherwise block. */
  readonly migratorPool: Pool;
  /** A fresh auth instance per fixture. */
  readonly auth: ReturnType<typeof createTestAuth>;
  /** Tear down both pools. */
  readonly close: () => Promise<void>;
}

/**
 * Build a fixture.
 *
 * @param options.truncate - When true (the default) every auth table is emptied
 *   before the fixture is returned, so tests cannot leak state into each other.
 */
export async function createAuthFixture(options: { truncate?: boolean } = {}): Promise<AuthTestFixture> {
  const appPool = new Pool({ connectionString: APP_DATABASE_URL, max: 4 });
  const migratorPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL, max: 2 });

  if (options.truncate !== false) await truncateAuthTables(migratorPool);

  return {
    appPool,
    migratorPool,
    auth: createTestAuth(appPool),
    close: async () => {
      await appPool.end();
      await migratorPool.end();
    },
  };
}

/**
 * Empty every auth table.
 *
 * TRUNCATE ... CASCADE in one statement so the foreign keys between them are
 * satisfied and no row survives in a child table.
 */
export async function truncateAuthTables(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE TABLE "user", "session", "account", "verification", "twoFactor", "rateLimit" RESTART IDENTITY CASCADE',
  );
}

/** Shape of a user row the fixtures create directly. */
export interface SeededUser {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly twoFactorEnabled: boolean;
}

/**
 * Create a user directly through the migrator pool.
 *
 * The MFA trigger refuses to create a privileged row without TOTP, so a fixture
 * for a privileged user MUST pass `twoFactorEnabled: true`. That friction is the
 * trigger working as designed, and it is exercised deliberately in
 * `mfa-enforcement.test.ts`.
 */
export async function seedUser(
  pool: Pool,
  input: { email: string; role: string; twoFactorEnabled: boolean; name?: string },
): Promise<SeededUser> {
  const result = await pool.query<SeededUser>(
    `INSERT INTO "user" ("name", "email", "emailVerified", "role", "twoFactorEnabled")
     VALUES ($1, $2, true, $3, $4)
     RETURNING "id", "email", "role", "twoFactorEnabled"`,
    [input.name ?? "Test User", input.email, input.role, input.twoFactorEnabled],
  );

  const row = result.rows[0];
  if (row === undefined) throw new Error("seedUser returned no row");
  return row;
}

/**
 * Sign in through the real HTTP handler and return the session cookie header.
 *
 * The handler is used rather than `auth.api.*` because the cookie is only ever
 * set on an actual response, and the tests assert on what a browser would
 * receive — including the attributes that the whole F-AUTH-01 fix rests on.
 *
 * @returns The `Cookie` request header to replay, plus the raw `Set-Cookie`
 *   values for attribute assertions.
 */
export async function signInAndCaptureCookie(
  auth: ReturnType<typeof createTestAuth>,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<{ cookieHeader: string; setCookieHeaders: readonly string[] }> {
  const response = await auth.handler(
    new Request(`${TEST_BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: TEST_BASE_URL,
      },
      body: JSON.stringify({ email, password }),
    }),
  );

  if (response.status !== 200) {
    throw new Error(`Sign-in fixture failed with status ${response.status}.`);
  }

  const setCookieHeaders = response.headers.getSetCookie();
  const sessionCookie = setCookieHeaders.find((header) => header.includes("session_token"));
  if (sessionCookie === undefined) throw new Error("Sign-in set no session_token cookie.");

  const value = sessionCookie.split(";")[0];
  if (value === undefined) throw new Error("Could not read the session cookie value.");

  return { cookieHeader: `Cookie: ${value}`, setCookieHeaders };
}

/** Every cookie the sign-in response set, keyed by the part before `=`. */
export function parseSetCookieHeaders(headers: readonly string[]): Map<string, Map<string, string>> {
  const parsed = new Map<string, Map<string, string>>();

  for (const header of headers) {
    const [pair, ...attributes] = header.split(";");
    if (pair === undefined) continue;

    const separator = pair.indexOf("=");
    if (separator === -1) continue;

    const name = pair.slice(0, separator).trim();
    const attributesMap = new Map<string, string>();

    for (const attribute of attributes) {
      const [key, value = ""] = attribute.split("=");
      if (key !== undefined) attributesMap.set(key.trim().toLowerCase(), value.trim());
    }

    parsed.set(name, attributesMap);
  }

  return parsed;
}

/**
 * Build Better Auth options for an arbitrary environment.
 *
 * Lets the configuration-shape tests exercise `buildAuthOptions` against a
 * throwaway pool without opening a connection: `buildAuthOptions` only stores
 * the pool, it does not connect during construction.
 */
export function optionsForEnv(env: Readonly<Record<string, string>>): BetterAuthOptions {
  return buildAuthOptions(readAuthEnv(env), new Pool({ connectionString: APP_DATABASE_URL, max: 1 }));
}