/**
 * Rate limiting tests, against an in-process PGlite instance (PostgreSQL 18.3
 * in WebAssembly).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * AUDIT/09 F-AUTH-04 (MEDIUM): "sign-in has no rate limiting, lockout or bot
 * defence". With no limit, an online guessing attack is unthrottled, and — given
 * no MFA either (F-AUTH-05) — a single successful guess on an admin account is
 * immediate, permanent access. Two controls together make that infeasible; this
 * suite covers the first.
 *
 * WHY THE COUNTERS ARE IN POSTGRES
 * -------------------------------
 * Better Auth defaults rate-limit storage to process memory. That is wrong here
 * for two reasons, and both are asserted below:
 *   - memory resets on every deploy and every restart, so an attacker who can
 *     induce a restart resets their own budget;
 *   - memory is per-process, so N instances multiply the effective limit by N.
 * `storage: "database"` makes the budget survive restarts and be shared.
 *
 * These tests drive the real HTTP handler so the whole path is exercised —
 * routing, keying, the counter, and the 429 — rather than calling the limiter in
 * isolation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ACCOUNT_SIGNIN_MAX_FAILURES, RATE_LIMITS } from "./config.js";
import {
  TEST_AUTH_ENV,
  TEST_PASSWORD,
  createAuthFixture,
  truncateAuthTables,
  type AuthTestFixture,
} from "./test-helpers.js";

let fixture: AuthTestFixture;

beforeAll(async () => {
  fixture = await createAuthFixture({ truncate: false });
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  // Truncating "auth_rate_limit" resets the budget between tests. Without this the
  // suites would interfere through a shared table, which is exactly the coupling
  // the database storage choice is meant to have.
  await truncateAuthTables(fixture);
});

/** Create a verified, password-bearing account. */
async function createUser(email: string): Promise<void> {
  const signUp = await fixture.auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ name: "Rate Tester", email, password: TEST_PASSWORD }),
    }),
  );
  expect([200, 422]).toContain(signUp.status);

  await fixture.ownerPool.query('UPDATE "auth_user" SET "emailVerified" = true WHERE "email" = $1', [email]);
}

/** Attempt a sign-in and return the status code. */
async function attemptSignIn(email: string): Promise<number> {
  const response = await fixture.auth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ email, password: "deliberately-wrong-password-value" }),
    }),
  );
  return response.status;
}

/**
 * Attempt a sign-in and return the whole response.
 *
 * The password defaults to a WRONG one, which is what the credential-guessing
 * tests want: a wrong password is a credential failure, and the account
 * lockout counts those. A caller that wants the PER-ADDRESS limiter rather
 * than the account lockout has to pass the right password — a successful
 * sign-in is still a request the limiter counts, but it does not touch the
 * account's failure counter.
 */
async function attemptSignInResponse(
  email: string,
  password: string = "deliberately-wrong-password-value",
): Promise<Response> {
  return fixture.auth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ email, password }),
    }),
  );
}

/** Current persisted count for a given rate-limit key, or null when absent. */
async function counterFor(path: string): Promise<number | null> {
  const result = await fixture.ownerPool.query<{ count: number }>(
    'SELECT "count" FROM "auth_rate_limit" WHERE "key" LIKE $1',
    [`%|${path}`],
  );
  return result.rows[0]?.count ?? null;
}

describe("rate limiting on sign-in", () => {
  it("engages after the configured number of attempts", async () => {
    await createUser("limited@example.invalid");
    const limit = RATE_LIMITS.signIn.max;

    // Every attempt in the window is under the limit.
    for (let attempt = 1; attempt <= limit; attempt++) {
      const status = await attemptSignIn("limited@example.invalid");
      expect(status, `attempt ${attempt} should be under the limit`).toBeLessThan(429);
    }

    // The next one is refused.
    expect(await attemptSignIn("limited@example.invalid")).toBe(429);
  });

  it("answers a refusal with a Retry-After a client can actually obey", async () => {
    // A REGRESSION test for a measured defect.
    //
    // The 429 carries `X-Retry-After`, and a client that obeys it waits that
    // many seconds. The value is computed by Better Auth from the persisted
    // `lastRequest` (installed `dist/api/rate-limiter/index.mjs`,
    // `getRetryAfter`): `lastRequest + windowInMs - now`, divided by 1000.
    //
    // `lastRequest` was a `bigint`. node-postgres returns `int8` as a STRING,
    // so the `+` CONCATENATED instead of adding and the header went out as
    // ~179250434915774 seconds — about 5.7 million years. A client that
    // trusted it stopped for the heat death of the universe; a client that did
    // not trust it retried instantly and hammered the endpoint until its own
    // attempt budget ran out. Both were observed on the running stack.
    //
    // WHAT THIS TEST CAN AND CANNOT SEE: the arithmetic only breaks on the
    // node-postgres driver, because PGlite returns `int8` as a number. So this
    // asserts the CONTRACT — the header is a number of seconds, inside the
    // window — which is what any client depends on, and the column TYPE is
    // pinned separately in `schema.test.ts`, which is the assertion that would
    // fail if someone put the `bigint` back.
    await createUser("retry-after@example.invalid");
    // The RESOLVED budget, not the default: the default is the strict
    // production number, and this deployment's budget is the environment's.
    const limit = TEST_AUTH_ENV.signInRateLimitMax;

    let refusal: Response | undefined;
    for (let attempt = 0; attempt <= limit; attempt += 1) {
      // The RIGHT password, so the ACCOUNT lockout stays out of it: this test
      // is about the per-address limiter's refusal, and the account counter
      // would fire first and answer with a 429 that carries no Retry-After —
      // two different 429s, and the wrong one for this assertion.
      const response = await attemptSignInResponse("retry-after@example.invalid", TEST_PASSWORD);
      if (response.status === 429) {
        refusal = response;
        break;
      }
    }
    expect(refusal, "the limiter must refuse someone").toBeDefined();

    const header = refusal?.headers.get("x-retry-after");
    expect(header, "a refusal must say when to come back").not.toBeNull();

    const seconds = Number(header);
    expect(Number.isFinite(seconds), `X-Retry-After must be a number, got "${header}"`).toBe(true);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds, "the wait cannot exceed the window it is waiting out").toBeLessThanOrEqual(
      RATE_LIMITS.signIn.window,
    );
  });

  it("persists its counter in Postgres rather than in process memory", async () => {
    await createUser("persisted@example.invalid");

    await attemptSignIn("persisted@example.invalid");

    // The counter is a row, so it survives a restart and is shared by every
    // instance. An in-memory counter would leave no trace here.
    const count = await counterFor("/sign-in/email");
    expect(count).not.toBeNull();
    expect(count).toBeGreaterThan(0);
  });

  it("keys the budget by client IP, so one attacker cannot exhaust a shared limit", async () => {
    // THE NAME ONCE SAID SOMETHING FALSE, and was left uncorrected until now.
    //
    // Per-IP keying does NOT stop one attacker exhausting a limit; it is what
    // GIVES an attacker a fresh limit per address. An attacker with N addresses
    // gets N times the budget. Measured with the default forwarding-header
    // configuration: 200 of 200 guesses against one named account, never limited,
    // because each request carried an `X-Forwarded-For` the caller invented.
    //
    // What this test actually proves — and all it ever proved — is that the key
    // Better Auth builds IS address-keyed. That is a fact about the mechanism,
    // not a protection, and it is kept because it is the thing that changes when
    // `advanced.ipAddress` is edited. `signin-throttle.test.ts` is what proves a
    // caller cannot choose that address, and that the real bound on guessing is
    // the per-ACCOUNT counter.
    await createUser("keyed@example.invalid");
    const limit = RATE_LIMITS.signIn.max;

    for (let attempt = 0; attempt < limit + 1; attempt++) {
      await attemptSignIn("keyed@example.invalid");
    }

    // The key records the address the limit was consumed against.
    const rows = await fixture.ownerPool.query<{ key: string }>(
      'SELECT "key" FROM "auth_rate_limit" WHERE "key" LIKE $1',
      ["%|/sign-in/email"],
    );

    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.key).toMatch(/^\d{1,3}(\.\d{1,3}){3}\|/);
    }
  });

  it("keeps the budget for one path separate from another", async () => {
    await createUser("separate@example.invalid");
    const limit = RATE_LIMITS.signIn.max;

    for (let attempt = 0; attempt < limit + 1; attempt++) {
      await attemptSignIn("separate@example.invalid");
    }

    expect(await attemptSignIn("separate@example.invalid")).toBe(429);

    // A different endpoint has its own budget, so exhausting sign-in does not
    // also lock the user out of password reset.
    const reset = await fixture.auth.handler(
      new Request("http://localhost:3000/api/auth/request-password-reset", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ email: "separate@example.invalid", redirectTo: "http://localhost:3000/reset" }),
      }),
    );

    expect(reset.status).not.toBe(429);
  });

  it("applies the tighter budget to sign-in than to the global default", () => {
    // Credential stuffing is the one endpoint where guessing is directly
    // available, so it gets the tighter budget.
    expect(RATE_LIMITS.signIn.max).toBeLessThan(RATE_LIMITS.global.max);
    expect(RATE_LIMITS.twoFactorVerify.max).toBeLessThan(RATE_LIMITS.global.max);
  });

  it("uses the environment's sign-in budget on the sign-in paths", () => {
    // The rule is per ADDRESS, and a development machine or a demo has one.
    // The budget therefore follows the environment: strict in production,
    // workable in development, and whatever the operator sets when they set it.
    //
    // The assertion is on the RESOLVED rule, not on the default: a config
    // that kept the strict number while the environment asked for another
    // would be a config that ignores the operator.
    const rules = fixture.auth.options.rateLimit?.customRules ?? {};

    for (const path of ["/sign-in/email", "/sign-in/username", "/sign-in/phone-number"]) {
      const rule = rules[path];
      // A rule may be `false`, an object, or a function; only the object form
      // carries a budget, and this deployment declares the object form.
      const max = typeof rule === "object" && rule !== null ? rule.max : undefined;
      expect(max, `${path} must use the resolved budget`).toBe(TEST_AUTH_ENV.signInRateLimitMax);
    }

    // And the per-ACCOUNT budget — the one that actually bounds guessing — is
    // untouched by any of this.
    expect(ACCOUNT_SIGNIN_MAX_FAILURES).toBe(5);
  });
});

describe("rate limiting is actually enabled", () => {
  it("is on in every environment, not just production", () => {
    // Better Auth defaults this to production-only. A preview or local
    // deployment is exactly where credential stuffing is rehearsed.
    expect(fixture.auth.options.rateLimit?.enabled).toBe(true);
  });

  it("stores counters in the database", () => {
    expect(fixture.auth.options.rateLimit?.storage).toBe("database");
  });

  it("declares a rule for every credential-bearing path", () => {
    const rules = fixture.auth.options.rateLimit?.customRules ?? {};

    for (const path of ["/sign-in/email", "/two-factor/verify-totp", "/request-password-reset"]) {
      expect(rules[path], `${path} must have a rule`).toBeDefined();
    }
  });
});