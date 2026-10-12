/**
 * Mutation-resistance for the settings a comment describes as load-bearing.
 *
 * WHAT THIS FILE EXISTS BECAUSE OF
 * -------------------------------
 * Seven settings in `config.ts` are each described in a code comment as something
 * the system depends on. A mutation test replaced EVERY ONE of them with its
 * broken value -- both TypeScript MFA gates turned into no-ops, `trustedOrigins`
 * widened to `["*"]`, CSRF disabled, `skipVerificationOnEnable` flipped, the MFA
 * lockout turned off -- and all 171 tests still passed.
 *
 * A test that passes whether or not a control exists is not a weaker test; it is
 * decoration. It reports coverage of the LINE while proving nothing about the
 * BEHAVIOUR, and it does so in a way that reads as evidence during review.
 *
 * So every case below is written to FAIL when its control is broken. That was
 * verified by mutation, not assumed: each one was run against the broken value
 * first and observed failing. The mutation harness and its results are recorded
 * in the change report; re-running it is three edits to `config.ts`.
 *
 * WHY THE MFA GATES NEED TWO SEPARATE TESTS
 * -----------------------------------------
 * Both gates refuse the same request, so the original end-to-end test could not
 * tell which one fired -- deleting either one left the other covering for it.
 * They are therefore separated by an OBSERVABLE DIFFERENCE rather than by
 * response code:
 *
 *   - the `databaseHooks.session.create.before` gate returns `false`, which makes
 *     `createSession` resolve to null BEFORE the INSERT. No session row is ever
 *     written.
 *   - the `hooks.after` gate runs after the session exists, so it can refuse the
 *     RESPONSE while the row it refused stays in the database.
 *
 * "A refused sign-in leaves no session row" is therefore a property only the first
 * gate can provide, and "the refusal is an MFA_REQUIRED 403" is one only the
 * second can. Each test fails when its own gate is removed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MFA_MAX_FAILED_ATTEMPTS } from "./config.js";
import { TEST_PASSWORD, createAuthFixture, truncateAuthTables, type AuthTestFixture } from "./test-helpers.js";

const BASE_URL = "http://localhost:3000";

let fixture: AuthTestFixture;

/**
 * Create a loginable account at a chosen privilege, bypassing the MFA trigger
 * when the row is deliberately non-compliant.
 *
 * `bypassMfaGuard` exists because the two gates below are DEFENCE IN DEPTH: the
 * authoritative rule is the `user_mfa_guard_trigger` in `schema.sql`. To test
 * either gate at all the trigger has to be out of the way, or the database
 * refuses the row before either gate is ever consulted.
 *
 * The trigger is `BEFORE INSERT OR UPDATE`, so it must be disabled across the
 * UPDATE as well as the INSERT. Disabling it only for the sign-up looks right and
 * fails on the UPDATE with SQLSTATE 23514, which is a fixture bug that reads
 * exactly like the control under test misbehaving.
 */
async function createLoginableUser(
  email: string,
  role: string,
  twoFactorEnabled: boolean,
  bypassMfaGuard: boolean,
): Promise<string> {
  if (bypassMfaGuard) await fixture.ownerPool.query('ALTER TABLE "auth_user" DISABLE TRIGGER user_mfa_guard_trigger');
  try {
    const signUp = await fixture.auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ name: "Gate Tester", email, password: TEST_PASSWORD }),
      }),
    );
    expect([200, 422]).toContain(signUp.status);

    await fixture.ownerPool.query(
      'UPDATE "auth_user" SET "emailVerified" = true, "role" = $2, "twoFactorEnabled" = $3 WHERE "email" = $1',
      [email, role, twoFactorEnabled],
    );
  } finally {
    if (bypassMfaGuard) await fixture.ownerPool.query('ALTER TABLE "auth_user" ENABLE TRIGGER user_mfa_guard_trigger');
  }

  const rows = await fixture.ownerPool.query<{ id: string }>('SELECT "id" FROM "auth_user" WHERE "email" = $1', [
    email,
  ]);
  const id = rows.rows[0]?.id;
  if (id === undefined) throw new Error("fixture user row missing");
  return id;
}

/**
 * Reach the TOTP-enrolled state through the real enrolment endpoint.
 *
 * Two reasons this is not a hand-written row:
 *
 *   - the `twoFactor.secret` column is ENCRYPTED with `BETTER_AUTH_SECRET`, and the
 *     verification route decrypts it before comparing codes. A fixture string
 *     makes `symmetricDecrypt` throw, the route 500s, and `recordTwoFactorFailure`
 *     is never reached -- so a lockout test built on a fake secret measures
 *     nothing and silently passes for the wrong reason.
 *   - enrolment is the only place the secret is produced correctly.
 *
 * The two database writes afterwards stand in for the verification step that would
 * follow, which the `skipVerificationOnEnable` case above covers on its own.
 * Returns the session cookie to use for the challenge that follows.
 */
async function enrolInTotp(
  userId: string,
  email: string,
  cookie: string,
): Promise<void> {
  const enable = await fixture.auth.handler(
    new Request(`${BASE_URL}/api/auth/two-factor/enable`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL, cookie },
      body: JSON.stringify({ password: TEST_PASSWORD, method: "totp" }),
    }),
  );
  expect(enable.status).toBe(200);

  await fixture.ownerPool.query('UPDATE "auth_two_factor" SET "verified" = true WHERE "userId" = $1', [userId]);
  await fixture.ownerPool.query('UPDATE "auth_user" SET "twoFactorEnabled" = true WHERE "id" = $1', [userId]);
  void email;
}

/** Sign in through the real handler and return the response. */
async function signIn(email: string, password: string = TEST_PASSWORD): Promise<Response> {
  return fixture.auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password }),
    }),
  );
}

/** POST with an arbitrary cookie and origin, for the CSRF and origin checks. */
async function postWithCookie(path: string, cookie: string, origin?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", cookie };
  if (origin !== undefined) headers["origin"] = origin;
  return fixture.auth.handler(
    new Request(`${BASE_URL}/api/auth/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "csrf@example.invalid", password: TEST_PASSWORD }),
    }),
  );
}

function bareCookie(setCookieHeader: string): string {
  return setCookieHeader.split(";")[0] ?? "";
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

describe("the databaseHook MFA gate, with the response hook removed", () => {
  // Removing `hooks.after` alone leaves the databaseHook as the only thing
  // refusing the sign-in. If this test passes without it, the gate is decorative.
  it("refuses a privileged unenrolled sign-in by leaving NO session row behind", async () => {
    await createLoginableUser("hook-only@example.invalid", "admin", false, true);

    const response = await signIn("hook-only@example.invalid");
    expect(response.status).toBeGreaterThanOrEqual(400);

    // THE DISCRIMINATOR. The `hooks.after` gate also answers with an error, but
    // it answers AFTER the session row exists, so a response-only assertion
    // cannot tell the two apart. A gate that refuses before the INSERT leaves
    // nothing behind; a gate that refuses after it does not.
    const rows = await fixture.ownerPool.query<{ n: number }>('SELECT count(*)::int AS n FROM "auth_session"');
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("still issues a session to an ordinary account, so the gate is not just refusing everything", async () => {
    // A control that no-ops is indistinguishable from a control that refuses
    // always, and both look identical to a status-code assertion.
    await createLoginableUser("hook-ordinary@example.invalid", "player", false, false);

    expect((await signIn("hook-ordinary@example.invalid")).status).toBe(200);
  });
});

describe("the after-hook MFA gate", () => {
  // WHY THIS IS NOT AN END-TO-END TEST, STATED PLAINLY
  // --------------------------------------------------
  // With both gates present, `databaseHooks.session.create.before` ALWAYS refuses
  // first: it returns `false`, `createSession` resolves to null, the route throws
  // 401, and `ctx.context.newSession` is never set -- so `mfaGateAfterSignIn` sees
  // `null` and returns without acting. The after-hook is therefore unreachable
  // through the public API TODAY. That is a true finding, not a gap in the test,
  // and it is why the first test below asserts the interaction itself.
  it("is shadowed by the database gate end to end, which is what defence in depth means", async () => {
    await createLoginableUser("shadowed@example.invalid", "admin", false, true);

    const response = await signIn("shadowed@example.invalid");
    // 401, not 403: the refusal came from the hook that runs before the session
    // exists. If this ever becomes 403, the after-hook has become the first line
    // and something upstream stopped firing.
    expect(response.status).toBe(401);

    const rows = await fixture.ownerPool.query<{ n: number }>('SELECT count(*)::int AS n FROM "auth_session"');
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("refuses a privileged unenrolled session on its own, with the 403 a client routes on", async () => {
    // The gate is exercised DIRECTLY, because no request reaches it while the
    // database gate is doing its job. Calling the CONFIGURED hook -- not a copy of
    // it -- is what makes this fail when the hook is deleted or turned into a
    // no-op, which an end-to-end test cannot do for a gate that is shadowed.
    //
    // `/two-factor/verify-totp` is used as the path because it is on both
    // SESSION_CREATION_PATHS and NOT a password sign-in path, so the composed
    // after-gate's lockout recorder returns immediately and this assertion is
    // about the MFA gate alone.
    const after = fixture.auth.options.hooks?.after;
    expect(typeof after).toBe("function");

    const invoke = after as unknown as (ctx: unknown) => Promise<unknown>;
    const refuse = invoke({
      path: "/two-factor/verify-totp",
      context: { newSession: { user: { role: "admin", twoFactorEnabled: false } } },
    });

    await expect(refuse).rejects.toMatchObject({ statusCode: 403 });
  });

  it("permits an ordinary account, so the gate is not a blanket refusal", async () => {
    // Without this, a hook that threw unconditionally would satisfy the test
    // above. A gate that refuses everyone is not the gate under test.
    const after = fixture.auth.options.hooks?.after;
    const invoke = after as unknown as (ctx: unknown) => Promise<unknown>;

    await expect(
      invoke({
        path: "/two-factor/verify-totp",
        context: { newSession: { user: { role: "player", twoFactorEnabled: false } } },
      }),
    ).resolves.toBeUndefined();
  });

  it("permits a privileged account that HAS enrolled", async () => {
    const after = fixture.auth.options.hooks?.after;
    const invoke = after as unknown as (ctx: unknown) => Promise<unknown>;

    await expect(
      invoke({
        path: "/two-factor/verify-totp",
        context: { newSession: { user: { role: "owner", twoFactorEnabled: true } } },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("trustedOrigins", () => {
  it("is not a wildcard: a cross-origin request carrying cookies is refused", async () => {
    // With `trustedOrigins: ["*"]` this request would pass the origin check and
    // reach the endpoint, answering 401 instead of 403. Widening the list to `*`
    // is what turns a callback/redirect validation into an open redirect that
    // hands a live auth flow to an attacker's page.
    const response = await postWithCookie("sign-in/email", "raptor.session_token=anything", "https://evil.example");

    expect(response.status).toBe(403);
  });

  it("names only this deployment's own origin", () => {
    const origins = fixture.auth.options.trustedOrigins;
    expect(origins).toEqual([BASE_URL]);
    expect(origins).not.toContain("*");
  });
});

describe("disableCSRFCheck", () => {
  it("keeps CSRF protection on: a cookie-bearing request with no Origin is refused", async () => {
    // The discriminator against `disableCSRFCheck: true`. That flag short-circuits
    // `validateOrigin` entirely, so the request would reach the endpoint and
    // answer 401. Here there is no Origin at all, which is what a forged
    // cross-site request looks like to the server, and it must be refused.
    const response = await postWithCookie("sign-in/email", "raptor.session_token=anything");

    expect(response.status).toBe(403);
  });
});

describe("skipVerificationOnEnable", () => {
  it("does not mark MFA enabled until the user has proved they hold the secret", async () => {
    // With `skipVerificationOnEnable: true`, `/two-factor/enable` flips
    // `twoFactorEnabled` immediately. That would make "MFA enabled" a value a
    // user can set without ever owning a device, which defeats the whole control
    // -- including the one this package's MFA enforcement rests on.
    await createLoginableUser("totp-unverified@example.invalid", "player", false, false);

    const signInResponse = await signIn("totp-unverified@example.invalid");
    const cookie = signInResponse.headers
      .getSetCookie()
      .find((header) => header.includes("session_token"));
    if (cookie === undefined) throw new Error("sign-in set no session cookie");

    const enable = await fixture.auth.handler(
      new Request(`${BASE_URL}/api/auth/two-factor/enable`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          cookie: bareCookie(cookie),
        },
        body: JSON.stringify({ password: TEST_PASSWORD, method: "totp" }),
      }),
    );
    expect(enable.status).toBe(200);

    const rows = await fixture.ownerPool.query<{ enabled: boolean | null; verified: boolean | null }>(
      `SELECT u."twoFactorEnabled" AS enabled, t."verified" AS verified
         FROM "auth_user" u JOIN "auth_two_factor" t ON t."userId" = u."id"
        WHERE u."email" = $1`,
      ["totp-unverified@example.invalid"],
    );

    expect(rows.rows[0]?.enabled, "enrolment must not be complete until the code is proved").toBe(false);
    expect(rows.rows[0]?.verified).toBe(false);
  });
});

describe("the MFA accountLockout", () => {
  it("locks the account after the configured number of failed TOTP codes", async () => {
    // `accountLockout: { enabled: false }` removes the write entirely, so
    // `lockedUntil` stays NULL and this fails. With it on, the fifth failure
    // crosses `maxFailedAttempts` and the account is locked.
    //
    // Scope note, stated because it is the boundary that bites: this lockout
    // covers the 6-digit TOTP code ONLY. A wrong password never reaches
    // `recordTwoFactorFailure` -- see `signin-throttle.test.ts`, which asserts
    // the twoFactor counter stays at zero through a full password lockout and
    // where the password budget actually lives.
    const email = "totp-lockout@example.invalid";
    const userId = await createLoginableUser(email, "player", false, false);

    const firstSignIn = await signIn(email);
    const firstCookie = firstSignIn.headers
      .getSetCookie()
      .find((header) => header.includes("session_token"));
    if (firstCookie === undefined) throw new Error("sign-in set no session cookie");
    await enrolInTotp(userId, email, bareCookie(firstCookie));

    // Now enrolled, so the next sign-in must be CHALLENGED rather than completed.
    const challenge = await signIn(email);
    const challengeCookie = challenge.headers
      .getSetCookie()
      .find((header) => header.includes("two_factor"));
    if (challengeCookie === undefined) throw new Error("enrolled sign-in issued no two-factor challenge");

    for (let attempt = 0; attempt < MFA_MAX_FAILED_ATTEMPTS; attempt++) {
      await fixture.auth.handler(
        new Request(`${BASE_URL}/api/auth/two-factor/verify-totp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: BASE_URL,
            cookie: bareCookie(challengeCookie),
          },
          body: JSON.stringify({ code: "000000" }),
        }),
      );
    }

    const rows = await fixture.ownerPool.query<{ failed: number | null; locked: Date | null }>(
      `SELECT t."failedVerificationCount" AS failed, t."lockedUntil" AS locked
         FROM "auth_two_factor" t JOIN "auth_user" u ON u."id" = t."userId"
        WHERE u."email" = $1`,
      [email],
    );

    expect(rows.rows[0]?.failed ?? 0).toBeGreaterThanOrEqual(MFA_MAX_FAILED_ATTEMPTS);
    expect(rows.rows[0]?.locked, "the account must be locked, not merely counted").not.toBeNull();
  });
});