/**
 * Rate limiting tests, against the real local PostgreSQL 18.6.
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

import { RATE_LIMITS } from "./config.js";
import { TEST_PASSWORD, createAuthFixture, truncateAuthTables, type AuthTestFixture } from "./test-helpers.js";

let fixture: AuthTestFixture;

beforeAll(async () => {
  fixture = await createAuthFixture({ truncate: false });
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  // Truncating "rateLimit" resets the budget between tests. Without this the
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

  await fixture.ownerPool.query('UPDATE "user" SET "emailVerified" = true WHERE "email" = $1', [email]);
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

/** Current persisted count for a given rate-limit key, or null when absent. */
async function counterFor(path: string): Promise<number | null> {
  const result = await fixture.ownerPool.query<{ count: number }>(
    'SELECT "count" FROM "rateLimit" WHERE "key" LIKE $1',
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
    await createUser("keyed@example.invalid");
    const limit = RATE_LIMITS.signIn.max;

    for (let attempt = 0; attempt < limit + 1; attempt++) {
      await attemptSignIn("keyed@example.invalid");
    }

    // The key records the address the limit was consumed against.
    const rows = await fixture.ownerPool.query<{ key: string }>(
      'SELECT "key" FROM "rateLimit" WHERE "key" LIKE $1',
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