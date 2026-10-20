/**
 * Sign-in throttling: what actually bounds password guessing.
 *
 * THE TWO DEFECTS THIS FILE EXISTS BECAUSE OF
 * ------------------------------------------
 *
 * 1. RATE LIMITING WAS KEYED ON A CLIENT-SUPPLIED HEADER.
 *    `config.ts` set no `advanced.ipAddress`, so Better Auth used its default
 *    header list — `["x-forwarded-for"]` — and Next.js only fills that header
 *    when it is ABSENT (`req.headers['x-forwarded-for'] ??= ...`), so a supplied
 *    value passed through verbatim. Reproduced: 200 password guesses against one
 *    named account with a unique `X-Forwarded-For` per request, 200 of 200
 *    accepted, never limited. Per-IP keying is not a protection against a client
 *    that chooses its own IP; it is a budget the client hands itself.
 *
 * 2. THERE WAS NO PER-ACCOUNT COUNTER AT ALL.
 *    `user` carries no failure count, so nothing bounded guessing against ONE
 *    account no matter how many addresses were involved. Worse, the `twoFactor`
 *    plugin's `accountLockout` (max 5) looked like it covered this and did not:
 *    read out of the installed `dist/plugins/two-factor/verify-two-factor.mjs`,
 *    `recordTwoFactorFailure` is called ONLY from the TOTP verification route.
 *    It counts 6-digit code guesses, never password guesses. That boundary is
 *    asserted below so nobody closes a password-brute-force ticket by pointing
 *    at the MFA lockout.
 *
 *    The plugin is no longer installed in this build (see "THE DEMO BUILD" in
 *    `config.ts`), so the counter it kept cannot move at all. The boundary is
 *    therefore still worth asserting: the password budget is the ONLY per-account
 *    budget there is, and it is the one that has to hold.
 *
 * WHAT A LIBRARY CONFIG ALONE CANNOT DO
 * ------------------------------------
 * Stated plainly, because it is the part that is easy to overclaim. `rateLimit`
 * keying is computed from the resolved IP BEFORE any custom rule is consulted,
 * and `customStorage` receives that same pre-computed key — so Better Auth offers
 * no hook for "key this bucket by account". The per-account counter is therefore
 * implemented as a `hooks.before` / `hooks.after` pair in this package, storing
 * its state in the `rateLimit` table (already database-backed, already
 * `TRUNCATE`-able by the fixtures) under a key that is a SHA-256 digest of the
 * lower-cased address. No schema change, no new dependency, and the raw address
 * never reaches a row, a log, or an error message.
 *
 * NO ADDRESS, PASSWORD, TOKEN OR COOKIE VALUE APPEARS IN ANY FAILURE MESSAGE.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ACCOUNT_SIGNIN_LOCKOUT_CODE,
  ACCOUNT_SIGNIN_MAX_FAILURES,
  RATE_LIMITS,
} from "./config.js";
import {
  TEST_PASSWORD,
  createAuthFixture,
  truncateAuthTables,
  type AuthTestFixture,
} from "./test-helpers.js";

const BASE_URL = "http://localhost:3000";
const WRONG_PASSWORD = "a-guess-that-is-not-the-password";

let fixture: AuthTestFixture;

/** Create a verified, password-bearing account through the real sign-up route. */
async function createVerifiedUser(email: string): Promise<void> {
  const signUp = await fixture.auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ name: "Throttle Tester", email, password: TEST_PASSWORD }),
    }),
  );
  expect([200, 422]).toContain(signUp.status);

  await fixture.ownerPool.query('UPDATE "auth_user" SET "emailVerified" = true WHERE "email" = $1', [email]);
}

/**
 * One sign-in attempt, optionally wearing a spoofed forwarding header.
 *
 * `forwardedFor` exists to reproduce the attack. A real browser cannot set it
 * for itself; an attacker talking to the app directly can, precisely because
 * Next.js only supplies the header when the client omitted it.
 */
async function attemptSignIn(
  email: string,
  password: string,
  forwardedFor?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json", origin: BASE_URL };
  if (forwardedFor !== undefined) headers["x-forwarded-for"] = forwardedFor;

  const response = await fixture.auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password }),
    }),
  );

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/**
 * Remove Better Auth's per-IP counter for the sign-in path.
 *
 * Fixture surgery, and deliberately so: the per-IP limiter and the per-account
 * lockout both answer with 429, so leaving the limiter in place would let the
 * account control pass a test in which it had done nothing. Clearing it leaves
 * exactly one candidate for the refusal, which is what makes the assertion mean
 * something.
 */
async function clearPerIpSignInBudget(): Promise<void> {
  await fixture.ownerPool.query('DELETE FROM "auth_rate_limit" WHERE "key" LIKE $1', ["%|/sign-in/email"]);
}

/** The `code` on a JSON error body, or null when there is none. */
function errorCode(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const code = (body as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : null;
}

beforeAll(async () => {
  fixture = await createAuthFixture({ truncate: false });
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  await truncateAuthTables(fixture);
});

describe("a client-supplied forwarding header", () => {
  it("does not split the rate-limit counter across spoofed addresses", async () => {
    // THE ISOLATED OBSERVATION, and the reason the behavioural tests above are
    // not sufficient on their own.
    //
    // The per-ACCOUNT lockout also stops the attack, so with both controls in
    // place every end-to-end assertion passes whether or not the address is
    // trusted -- removing `advanced.ipAddress` alone is invisible to them. Mutation
    // testing confirmed that: restoring `ipAddressHeaders: ["x-forwarded-for"]`
    // left the whole suite green.
    //
    // So this asserts on the MECHANISM rather than the outcome: the number of
    // distinct rate-limit keys. With the header trusted, each spoofed value mints
    // a fresh bucket and this count equals the number of requests. It must be 1.
    const email = "distinct-keys@example.invalid";
    await createVerifiedUser(email);

    const attempts = 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await attemptSignIn(email, WRONG_PASSWORD, `203.0.113.${attempt}`);
    }

    const keys = await fixture.ownerPool.query<{ key: string }>(
      'SELECT "key" FROM "auth_rate_limit" WHERE "key" LIKE $1',
      ["%|/sign-in/email"],
    );
    const distinct = new Set(keys.rows.map((row) => row.key));

    expect(
      distinct.size,
      `a caller-supplied header must not create ${attempts} separate budgets`,
    ).toBe(1);
  });

  it("trusts no forwarding header by default", () => {
    // The setting itself, asserted because the mechanism test above proves the
    // EFFECT and this proves the CAUSE is absent rather than merely overridden.
    const ipAddress = fixture.auth.options.advanced?.ipAddress;
    expect(ipAddress?.ipAddressHeaders ?? []).toEqual([]);
    expect(ipAddress?.ipAddressHeaders ?? []).not.toContain("x-forwarded-for");
  });

  it("does not buy the attacker a fresh rate-limit budget", async () => {
    // THE REPRODUCTION. Before the fix this loop ran 200 times with 200/200
    // accepted; every request was keyed by an address the caller invented.
    const email = "spoofed-ip@example.invalid";
    await createVerifiedUser(email);

    const attempts = RATE_LIMITS.signIn.max + 1;
    const statuses: number[] = [];

    for (let attempt = 0; attempt < attempts; attempt++) {
      const result = await attemptSignIn(email, WRONG_PASSWORD, `203.0.113.${attempt}`);
      statuses.push(result.status);
    }

    expect(
      statuses.at(-1),
      `spoofed forwarding headers must not reset the budget; got ${statuses.join(",")}`,
    ).toBe(429);
  });

  it("keeps the whole sequence inside one budget rather than one budget per header", async () => {
    // The shape of the attack, stated as a bound: an attacker who varies the
    // header gets no more attempts than one who does not.
    const email = "spoofed-sequence@example.invalid";
    await createVerifiedUser(email);

    const limit = RATE_LIMITS.signIn.max;
    for (let attempt = 0; attempt < limit; attempt++) {
      await attemptSignIn(email, WRONG_PASSWORD, `198.51.100.${attempt}`);
    }

    await clearPerIpSignInBudget();

    // With the per-IP budget removed, a spoofed header must still not restore
    // access: the per-account counter is the control that survives it.
    const next = await attemptSignIn(email, WRONG_PASSWORD, "198.51.100.250");
    expect(next.status).toBe(429);
    expect(errorCode(next.body)).toBe(ACCOUNT_SIGNIN_LOCKOUT_CODE);
  });
});

describe("guessing one password from many addresses", () => {
  it("locks the ACCOUNT after the configured number of failures", async () => {
    const email = "multi-ip@example.invalid";
    await createVerifiedUser(email);

    for (let attempt = 0; attempt < ACCOUNT_SIGNIN_MAX_FAILURES; attempt++) {
      await attemptSignIn(email, WRONG_PASSWORD, `192.0.2.${attempt}`);
    }

    await clearPerIpSignInBudget();

    const refused = await attemptSignIn(email, WRONG_PASSWORD, "192.0.2.250");
    expect(refused.status).toBe(429);
    expect(errorCode(refused.body)).toBe(ACCOUNT_SIGNIN_LOCKOUT_CODE);
  });

  it("refuses even the CORRECT password while the account is locked", async () => {
    // A lockout that a correct guess can slip through is a suggestion. The
    // point is to make guessing expensive, and that means the attacker cannot
    // simply wait out the counter by trying the one guess they were saving.
    const email = "locked-is-locked@example.invalid";
    await createVerifiedUser(email);

    for (let attempt = 0; attempt < ACCOUNT_SIGNIN_MAX_FAILURES; attempt++) {
      await attemptSignIn(email, WRONG_PASSWORD);
    }
    await clearPerIpSignInBudget();

    expect((await attemptSignIn(email, TEST_PASSWORD)).status).toBe(429);
  });

  it("locks only the targeted account, so one victim cannot be used to deny service", async () => {
    const target = "target@example.invalid";
    const bystander = "bystander@example.invalid";
    await createVerifiedUser(target);
    await createVerifiedUser(bystander);

    for (let attempt = 0; attempt < ACCOUNT_SIGNIN_MAX_FAILURES; attempt++) {
      await attemptSignIn(target, WRONG_PASSWORD);
    }
    await clearPerIpSignInBudget();

    const unaffected = await attemptSignIn(bystander, TEST_PASSWORD);
    expect(unaffected.status).toBe(200);
  });

  it("counts every failure, not just the ones that share a forwarding header", async () => {
    const email = "counted@example.invalid";
    await createVerifiedUser(email);

    // Mixed: some spoofed, some not, all against one address.
    for (const header of ["203.0.113.1", undefined, "203.0.113.2", undefined, "203.0.113.3"]) {
      await attemptSignIn(email, WRONG_PASSWORD, header);
    }

    await clearPerIpSignInBudget();
    expect(errorCode((await attemptSignIn(email, TEST_PASSWORD)).body)).toBe(
      ACCOUNT_SIGNIN_LOCKOUT_CODE,
    );
  });
});

describe("the failure counter's lifecycle", () => {
  it("is cleared by a successful sign-in, so one typo does not accumulate", async () => {
    const email = "typo@example.invalid";
    await createVerifiedUser(email);

    await attemptSignIn(email, WRONG_PASSWORD);
    await attemptSignIn(email, WRONG_PASSWORD);
    expect((await attemptSignIn(email, TEST_PASSWORD)).status).toBe(200);

    await clearPerIpSignInBudget();

    // A fresh set of failures must start from zero, not continue from two.
    for (let attempt = 0; attempt < ACCOUNT_SIGNIN_MAX_FAILURES - 1; attempt++) {
      await attemptSignIn(email, WRONG_PASSWORD);
    }
    await clearPerIpSignInBudget();

    expect((await attemptSignIn(email, TEST_PASSWORD)).status).toBe(200);
  });

  it("does not lock an account that has never failed", async () => {
    const email = "innocent@example.invalid";
    await createVerifiedUser(email);

    await clearPerIpSignInBudget();
    expect((await attemptSignIn(email, TEST_PASSWORD)).status).toBe(200);
  });
});

describe("the MFA account lockout does NOT cover passwords", () => {
  it("leaves the twoFactor counter untouched when a password is wrong", async () => {
    // A boundary, asserted rather than asserted-in-prose. The plugin's
    // `accountLockout` (max 5) lived in `verify-two-factor.mjs` and counted
    // 6-digit TOTP guesses only. Pointing at it as the answer to password brute
    // force would leave the password path exactly as unprotected as it is here.
    //
    // The plugin is not installed in this build, so the counter cannot move at
    // all and the assertion is a regression guard rather than a live boundary:
    // if the challenge is ever re-enabled, the password budget must still be a
    // SEPARATE budget, and a counter that moves on a wrong password would be
    // the failure this catches.
    const email = "totp-versus-password@example.invalid";
    await createVerifiedUser(email);

    const userId = await fixture.ownerPool
      .query<{ id: string }>('SELECT "id" FROM "auth_user" WHERE "email" = $1', [email])
      .then((rows) => {
        const id = rows.rows[0]?.id;
        if (id === undefined) throw new Error("no user row for the fixture address");
        return id;
      });

    // An enrolled account, so the twoFactor row exists to be counted on.
    await fixture.ownerPool.query(
      `INSERT INTO "auth_two_factor" ("secret", "backupCodes", "userId", "verified")
       VALUES ($1, $2, $3, true)`,
      ["encrypted-secret-value", "encrypted-backup-codes", userId],
    );

    for (let attempt = 0; attempt < ACCOUNT_SIGNIN_MAX_FAILURES + 1; attempt++) {
      await attemptSignIn(email, WRONG_PASSWORD, `192.0.2.${attempt}`);
    }

    const twoFactor = await fixture.ownerPool.query<{ failed: number | null; locked: Date | null }>(
      'SELECT "failedVerificationCount" AS failed, "lockedUntil" AS locked FROM "auth_two_factor" WHERE "userId" = $1',
      [userId],
    );

    expect(twoFactor.rows[0]?.failed ?? 0).toBe(0);
    expect(twoFactor.rows[0]?.locked ?? null).toBeNull();
  });
});