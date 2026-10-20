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
 * THE DEMO BUILD CHANGED THE INVENTORY, NOT THE METHOD
 * ------------------------------------------------------
 * Two of the mutated settings above -- `skipVerificationOnEnable` and the plugin's
 * account lockout -- belonged to the `twoFactor` plugin, which is not installed
 * in this build (see "THE DEMO BUILD" in `config.ts`). Their cases are gone
 * because the settings are gone, and they are replaced below by a case that
 * pins the replacement behaviour: a privileged account signs in with the
 * password ALONE, and the challenge routes do not exist.
 *
 * That replacement is not a weaker test. It fails if the plugin comes back
 * (an enrolled account is then CHALLENGED instead of signed in) and it fails if
 * the enrolment flag stops reaching the after-hook gate (the gate then reads
 * `false` and refuses an owner who is enrolled). Both are the two ways this
 * change can go wrong, and the old cases detected neither.
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

describe("the demo sign-in path, with the TOTP challenge gone", () => {
  it("signs an ENROLLED privileged account in with the password alone", async () => {
    // The account is enrolled — the flag is true, which is what a privileged
    // account must carry — and the sign-in still completes. That is the demo
    // decision, asserted as behaviour rather than described in a comment.
    //
    // THE DISCRIMINATOR. With the `twoFactor` plugin installed, this exact
    // account is CHALLENGED: the sign-in answers 200 with
    // `{ twoFactorRedirect: true }`, the credential session is deleted, and NO
    // session row is written. So "the response was 200" proves nothing — the
    // plugin answers 200 too. What proves the challenge is gone is the SESSION
    // ROW, and the absence of a challenge cookie.
    //
    // The second way this can fail is the flag not reaching the gate. The
    // after-hook gate reads `twoFactorEnabled` off the session payload, and the
    // installed adapter drops any column the user model does not declare
    // (`@better-auth/core`, `db/adapter/factory.mjs`, `transformSingleOutput`).
    // An undeclared flag reads as `false`, the gate refuses, and the owner is
    // locked out of their own account with no error message that says why. This
    // test is the one that catches it: a refusal would answer 401, not 200.
    await createLoginableUser("demo-owner@example.invalid", "owner", true, false);

    const response = await signIn("demo-owner@example.invalid");
    expect(response.status).toBe(200);

    const cookies = response.headers.getSetCookie();
    expect(
      cookies.find((header) => header.includes("two_factor")),
      "no challenge cookie may be issued when there is no challenge",
    ).toBeUndefined();

    const rows = await fixture.ownerPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM "auth_session" WHERE "userId" IN (SELECT "id" FROM "auth_user" WHERE "email" = $1)',
      ["demo-owner@example.invalid"],
    );
    expect(rows.rows[0]?.n, "the owner must hold a real session, not a challenge").toBe(1);
  });

  it("has no two-factor route at all", async () => {
    // The enrolment route is gone with the plugin. 404 is the answer, and it is
    // asserted rather than assumed: a route that answered 200 here would mean
    // something still serves the challenge, and the client would then be
    // waiting for a code that this build never asks for.
    const response = await fixture.auth.handler(
      new Request(`${BASE_URL}/api/auth/two-factor/enable`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ password: TEST_PASSWORD, method: "totp" }),
      }),
    );

    expect(response.status).toBe(404);
  });

  it("still refuses a privileged account that was never enrolled", async () => {
    // The policy is NOT part of what the demo switched off. A privileged row
    // whose flag is not true is refused a session, exactly as before, and the
    // refusal happens BEFORE the session row is written.
    await createLoginableUser("demo-unenrolled@example.invalid", "admin", false, true);

    const response = await signIn("demo-unenrolled@example.invalid");
    expect(response.status).toBeGreaterThanOrEqual(400);

    const rows = await fixture.ownerPool.query<{ n: number }>('SELECT count(*)::int AS n FROM "auth_session"');
    expect(rows.rows[0]?.n).toBe(0);
  });
});