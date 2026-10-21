/**
 * Environment validation tests.
 *
 * WHY THIS IS A SECURITY SURFACE
 * ------------------------------
 * Two secrets decide whether the tenancy boundary holds:
 *
 *   - `BETTER_AUTH_SECRET` signs session cookies. A leaked or weak secret lets an
 *     attacker mint a session cookie for any account, which is total compromise
 *     with no credential needed.
 *   - `DATABASE_URL` decides which role every query runs as. Pointed at the
 *     superuser migrator, every RLS policy in `schema.sql` is silently bypassed —
 *     the exact outcome ADR-0006 records, where software appeared to work while
 *     no isolation existed.
 *
 * The legacy system read environment variables inline wherever they were needed
 * and compiled `console.*` out of production, so a missing secret surfaced as a
 * runtime failure deep inside a sign-in rather than at boot. `readAuthEnv` moves
 * that failure to startup.
 *
 * NO SECRET IS ASSERTED BY VALUE. Tests check that a secret is required, is
 * rejected when empty, and never appears in a failure message.
 */

import { describe, expect, it } from "vitest";

import {
  AuthEnvironmentError,
  DEFAULT_APP_DATABASE_URL,
  DEVELOPMENT_SIGNIN_RATE_LIMIT_MAX,
  MIGRATION_URL_VARIABLE,
  PRODUCTION_SIGNIN_RATE_LIMIT_MAX,
  SIGNIN_RATE_LIMIT_MAX_VARIABLE,
  mfaRequiredError,
  migrationDatabaseUrl,
  readAuthEnv,
} from "./env.js";

const SECRET = "environment-test-signing-secret-0123456789";

function baseEnv(): Record<string, string> {
  return {
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: "http://localhost:3000",
    DATABASE_URL: "postgresql://raptor_app@127.0.0.1:5432/raptor_os",
  };
}

describe("readAuthEnv", () => {
  it("returns a validated configuration for a complete environment", () => {
    const env = readAuthEnv(baseEnv());

    expect(env.secret).toBe(SECRET);
    expect(env.baseUrl).toBe("http://localhost:3000");
    expect(env.nodeEnv).toBe("development");
  });

  it("fails at startup when the signing secret is missing", () => {
    const env = baseEnv();
    delete env["BETTER_AUTH_SECRET"];

    // Named, so the operator knows what to set; the message never contains a value.
    expect(() => readAuthEnv(env)).toThrow(AuthEnvironmentError);
    expect(() => readAuthEnv(env)).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("treats an empty secret as missing, because an empty secret is worse than none", () => {
    const env = { ...baseEnv(), BETTER_AUTH_SECRET: "" };

    expect(() => readAuthEnv(env)).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("treats a whitespace-only secret as missing", () => {
    expect(() => readAuthEnv({ ...baseEnv(), BETTER_AUTH_SECRET: "   " })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("fails when the base URL is missing", () => {
    const env = baseEnv();
    delete env["BETTER_AUTH_URL"];

    expect(() => readAuthEnv(env)).toThrow(/BETTER_AUTH_URL/);
  });

  it("lists every missing variable at once, not one per restart", () => {
    // Reporting them one at a time turns a startup fix into three restarts.
    expect(() => readAuthEnv({})).toThrow(/BETTER_AUTH_SECRET.*BETTER_AUTH_URL/s);
  });

  it("keeps the sign-in budget strict in production and workable in development", () => {
    // The budget is per ADDRESS, and a developer or a demo has exactly one.
    // Signing in as owner, then admin, then coach to show a colleague is three
    // sign-ins in a row from 127.0.0.1 — and the fourth was refused with a
    // 429, which read as "sign-in does not work".
    const production = readAuthEnv({ ...baseEnv(), NODE_ENV: "production" });
    expect(production.signInRateLimitMax).toBe(PRODUCTION_SIGNIN_RATE_LIMIT_MAX);

    const development = readAuthEnv({ ...baseEnv() });
    expect(development.signInRateLimitMax).toBe(DEVELOPMENT_SIGNIN_RATE_LIMIT_MAX);
  });

  it("takes an explicit sign-in budget over the environment default", () => {
    const env = readAuthEnv({ ...baseEnv(), [SIGNIN_RATE_LIMIT_MAX_VARIABLE]: "12" });
    expect(env.signInRateLimitMax).toBe(12);
  });

  it("refuses a sign-in budget that is not a positive whole number", () => {
    // A typo must not silently leave the default in place, and `0` must not
    // mean "unlimited" — it would mean the opposite.
    for (const value of ["0", "-1", "3.5", "many"]) {
      expect(() => readAuthEnv({ ...baseEnv(), [SIGNIN_RATE_LIMIT_MAX_VARIABLE]: value })).toThrow(
        /AUTH_RATE_LIMIT_SIGNIN_MAX/,
      );
    }
  });

  it("falls back to the local app-role connection string", () => {
    const env = baseEnv();
    delete env["DATABASE_URL"];

    const resolved = readAuthEnv(env);
    expect(resolved.databaseUrl).toBe(DEFAULT_APP_DATABASE_URL);
  });

  it("defaults nodeEnv to development", () => {
    expect(readAuthEnv(baseEnv()).nodeEnv).toBe("development");
  });

  it.each(["production", "test", "staging"])("passes NODE_ENV=%s through", (nodeEnv) => {
    expect(readAuthEnv({ ...baseEnv(), NODE_ENV: nodeEnv }).nodeEnv).toBe(
      nodeEnv === "production" || nodeEnv === "test" ? nodeEnv : "development",
    );
  });

  it("refuses a connection string naming the migration superuser", () => {
    // The runtime backstop for ADR-0006. Copying the migrator URL into
    // DATABASE_URL "just to test the migration" is a common and catastrophic
    // shortcut: it silently disables every RLS policy in the product.
    expect(() =>
      readAuthEnv({
        ...baseEnv(),
        DATABASE_URL: "postgresql://raptor_migrator:raptor_local_dev_only@127.0.0.1:5432/raptor_os",
      }),
    ).toThrow(AuthEnvironmentError);
  });

  it("refuses a connection string naming the stock postgres superuser", () => {
    expect(() =>
      readAuthEnv({
        ...baseEnv(),
        DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/raptor_os",
      }),
    ).toThrow(AuthEnvironmentError);
  });

  it("refuses a superuser URL with a password, without leaking the password", () => {
    let thrown: unknown;
    try {
      readAuthEnv({
        ...baseEnv(),
        DATABASE_URL: "postgresql://raptor_migrator:hunter2@127.0.0.1:5432/raptor_os",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthEnvironmentError);
    expect((thrown as Error).message).not.toContain("hunter2");
  });

  it("allows the application role", () => {
    expect(() => readAuthEnv(baseEnv())).not.toThrow();
  });

  it("allows an app-role URL whose PASSWORD happens to contain the migrator name", () => {
    // Guards against a naive substring check, which would lock a working
    // deployment. Only the username is examined.
    expect(() =>
      readAuthEnv({
        ...baseEnv(),
        DATABASE_URL: "postgresql://raptor_app:raptor_migrator_is_not_a_role@127.0.0.1:5432/raptor_os",
      }),
    ).not.toThrow();
  });

  it("rejects an unparsable connection string", () => {
    expect(() => readAuthEnv({ ...baseEnv(), DATABASE_URL: "not a url at all" })).toThrow(
      AuthEnvironmentError,
    );
  });
});

describe("migrationDatabaseUrl", () => {
  it("is reachable only when the migration credential is explicitly present", () => {
    // An application process must not be able to acquire migration credentials
    // by default — the absence is the control.
    expect(() => migrationDatabaseUrl({})).toThrow(AuthEnvironmentError);
  });

  it("returns the value when supplied", () => {
    const url = "postgresql://raptor_migrator:pw@127.0.0.1:5432/raptor_os";
    expect(migrationDatabaseUrl({ [MIGRATION_URL_VARIABLE]: url })).toBe(url);
  });

  it("names the variable in the failure, so the migration runner knows what to set", () => {
    expect(() => migrationDatabaseUrl({})).toThrow(new RegExp(MIGRATION_URL_VARIABLE));
  });
});

describe("mfaRequiredError", () => {
  it("is a 403 so the client can route to the enrolment screen", () => {
    expect(mfaRequiredError().statusCode).toBe(403);
  });

  it("carries a stable code to branch on, never a message match", () => {
    // Web code should test `code === "MFA_REQUIRED"`. Matching on prose is how
    // a copy change becomes an outage.
    expect(mfaRequiredError().body?.code).toBe("MFA_REQUIRED");
  });

  it("tells the user what to do, because a locked-out admin with no explanation is a support incident", () => {
    expect(mfaRequiredError().message).toMatch(/authenticator/i);
  });

  it("contains no account identifier, token, or cookie value", () => {
    const message = mfaRequiredError().message;
    expect(message).not.toMatch(/@/);
    expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});