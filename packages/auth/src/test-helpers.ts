/**
 * Integration-test fixtures.
 *
 * WHAT THESE FIXTURES RUN AGAINST
 * ------------------------------
 * An in-process PGlite session (PostgreSQL 18.3 compiled to WebAssembly), not a
 * server. Native PostgreSQL is unusable on this machine — every backend process
 * dies at creation with `0xC0000142`, 0/30 connections succeeded — and the
 * reasoning is recorded in
 * `docs/adr/0015-pglite-restored-after-native-postgres-retest.md`.
 *
 * Every property this package asserts is a property of PostgreSQL itself, and
 * PGlite enforces all of them (proved in `packages/db/scripts/pglite-capability.ts`):
 *
 *   - an expired session must be rejected, which is a comparison of
 *     `expiresAt` against `now()` in a `timestamptz` column;
 *   - a revoked session must be rejected, which is the absence of a row after a
 *     `DELETE`;
 *   - rate limiting must engage, which is a counter surviving in the
 *     `"rateLimit"` table across requests;
 *   - `user_mfa_guard_trigger` must reject a privileged row without TOTP, which
 *     is a `RAISE EXCEPTION` inside a `BEFORE` trigger, surfacing as SQLSTATE
 *     `23514`;
 *   - the session RLS policy must hide another tenant's row, and must return
 *     ZERO rows when no tenant is set, which is `current_org_id()` read out of a
 *     session GUC by a policy on a table whose RLS is ENABLED *and* FORCED.
 *
 * Two connections are no longer available — PGlite has one session — so the
 * split is by ROLE rather than by pool. The session runs as `raptor_app`
 * (NOSUPERUSER NOBYPASSRLS) and fixtures temporarily assume `raptor_migrator`
 * (SUPERUSER) through {@link AuthTestDatabase.asOwnerRole}. See
 * `test-database.ts` for why the switch happens once, at setup, and why
 * `SET ROLE` on its own would have made every identity-table assertion vacuous.
 *
 * SECRET HYGIENE
 * --------------
 * The test password is a constant defined below and is NOT a secret; it exists
 * only to satisfy Better Auth's minimum length. Nothing in this file logs a
 * password, a session token, or a cookie value, and no failure message contains
 * one.
 */

import { betterAuth, type BetterAuthOptions } from "better-auth";

import { buildAuthOptions } from "./config.js";
import { readAuthEnv, type AuthEnv } from "./env.js";
import { createTestDatabase, type AuthTestDatabase } from "./test-database.js";
import type { PGlitePool } from "./pglite-pool.js";

/**
 * A throwaway credential for local test fixtures only.
 *
 * 48 characters, so Better Auth's >= 32 warning and low-entropy heuristic both
 * stay quiet and the tests exercise the production code path rather than a
 * warning branch. It authenticates against an in-memory database that lives
 * for one test process and protects nothing.
 */
export const TEST_PASSWORD = "local-test-only-password-never-used-elsewhere";

/** Signing secret for the test instance. Same reasoning as above. */
const TEST_SECRET = "local-test-only-signing-secret-0123456789abcdef";

/** Must match `trustedOrigins` in the options, or Better Auth rejects the request. */
export const TEST_BASE_URL = "http://localhost:3000";

/**
 * The connection string `config.ts` is given for the test deployment.
 *
 * The harness never opens a socket, so this string exists only to prove what
 * `env.ts` is validating — that the *application* role is named here and the
 * migration role is not. `assertNotMigrationCredential` parses it, so it has to
 * be a parsable URL; what it points at is irrelevant.
 */
export const APP_DATABASE_URL = "postgresql://raptor_app@raptor_os_test/raptor_os_test";

/** Environment that `readAuthEnv` accepts, for the test deployment. */
export const TEST_ENV: Readonly<Record<string, string>> = {
  BETTER_AUTH_SECRET: TEST_SECRET,
  BETTER_AUTH_URL: TEST_BASE_URL,
  DATABASE_URL: APP_DATABASE_URL,
  NODE_ENV: "test",
};

/** Validated environment for the test deployment. */
export const TEST_AUTH_ENV: AuthEnv = readAuthEnv(TEST_ENV);

/** Better Auth options for the test deployment, bound to the PGlite pool. */
export function testAuthOptions(appPool: PGlitePool): BetterAuthOptions {
  return buildAuthOptions(TEST_AUTH_ENV, appPool);
}

/**
 * A Better Auth instance wired to the in-process database as `raptor_app`.
 *
 * Built per fixture rather than shared, because Better Auth's hooks and
 * rate-limit counters carry state and a single shared instance would let one
 * test's side effects cascade into another's.
 *
 * The pool is passed in rather than created here so that the fixture owns the
 * connection lifecycle and `close()` cannot leave a dangling handle.
 */
export function createTestAuth(appPool: PGlitePool) {
  return betterAuth(testAuthOptions(appPool));
}

/** A fixture that owns the PGlite session, its role doors, and the auth instance. */
export interface AuthTestFixture extends AuthTestDatabase {
  /** A fresh auth instance per fixture, bound to the application-role pool. */
  readonly auth: ReturnType<typeof createTestAuth>;
}

/**
 * Build a fixture.
 *
 * @param options.truncate - When true (the default) every auth table is emptied
 *   before the fixture is returned, so tests cannot leak state into each other.
 */
export async function createAuthFixture(options: { truncate?: boolean } = {}): Promise<AuthTestFixture> {
  const database = await createTestDatabase();

  if (options.truncate !== false) await truncateAuthTables(database);

  return { ...database, auth: createTestAuth(database.appPool) };
}

/**
 * Empty every auth table.
 *
 * TRUNCATE ... CASCADE in one statement so the foreign keys between them are
 * satisfied and no row survives in a child table. Runs as the owner because the
 * application role is granted DML only — it has no business truncating.
 */
export async function truncateAuthTables(database: AuthTestDatabase): Promise<void> {
  await database.ownerPool.query(
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
 * Create a user directly through the owner pool.
 *
 * The MFA trigger refuses to create a privileged row without TOTP, so a fixture
 * for a privileged user MUST pass `twoFactorEnabled: true`. That friction is the
 * trigger working as designed, and it is exercised deliberately in
 * `mfa-enforcement.test.ts`.
 */
export async function seedUser(
  pool: PGlitePool,
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
 * Lets the configuration-shape tests exercise `buildAuthOptions` without a
 * database: `buildAuthOptions` only stores the handle, it does not connect
 * during construction, so an unconnected pool is enough to assert on the
 * resolved shape.
 */
export function optionsForEnv(env: Readonly<Record<string, string>>): BetterAuthOptions {
  return buildAuthOptions(readAuthEnv(env), createUnconnectedPool());
}

/**
 * A pool-shaped object that satisfies Better Auth's `database` option and is
 * never asked to connect.
 *
 * Used only by `cookies.test.ts`, which asserts on configuration rather than on
 * behaviour. The `query` here is deliberately unreachable — if a future test
 * tried to run SQL through it, the failure would be immediate and obvious
 * instead of a silent pass.
 */
function createUnconnectedPool(): PGlitePool {
  const message = "This pool is configuration-only and never connects to a database.";

  return {
    connect: () => Promise.reject(new Error(message)),
    query: () => Promise.reject(new Error(message)),
    end: async (): Promise<void> => undefined,
  };
}