/**
 * Session revocation on a credential change.
 *
 * THE DEFECT THIS FILE EXISTS BECAUSE OF
 * -------------------------------------
 * `revokeSessionsOnPasswordReset` was unset, so Better Auth defaulted it to
 * false, and `/change-password` reads `revokeOtherSessions` from the REQUEST
 * BODY with no server-side default. Reproduced: after a legitimate user changed
 * their password in response to a breach notification, the attacker's session
 * remained valid. Only the old password died.
 *
 * That makes the incident-response action decorative. The whole point of telling
 * a user "change your password" is that doing so evicts whoever else is holding
 * a session. A control that leaves the intruder signed in is worse than no
 * control, because the response is written down in an incident timeline and the
 * responder believes it worked.
 *
 * BOTH ROUTES ARE COVERED
 * ----------------------
 *   - `/change-password` — the in-app change. The flag is forced server-side, so
 *     a client that omits it (or sends `false`) still evicts.
 *   - `/reset-password`  — the emailed-link flow, via
 *     `revokeSessionsOnPasswordReset`.
 *
 * The capability always existed and worked; it simply was not the default, and
 * no test asserted it. A capability nobody asserts is a capability nobody has.
 *
 * NO TOKEN, COOKIE OR PASSWORD VALUE APPEARS IN ANY FAILURE MESSAGE.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  TEST_PASSWORD,
  createAuthFixture,
  signInAndCaptureCookie,
  truncateAuthTables,
  type AuthTestFixture,
} from "./test-helpers.js";

/** A second, valid password. Never logged; only ever sent to Better Auth. */
const NEW_PASSWORD = "a-different-fixture-password-value-9f2c";

let fixture: AuthTestFixture;

function bareToken(cookieHeader: string): string {
  return cookieHeader.replace(/^Cookie:\s*/, "");
}

async function resolveSession(cookieHeader: string) {
  return fixture.auth.api.getSession({ headers: new Headers({ cookie: bareToken(cookieHeader) }) });
}

/** Create a verified, password-bearing account through the real sign-up route. */
async function createVerifiedUser(email: string): Promise<void> {
  const signUp = await fixture.auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ name: "Revocation Tester", email, password: TEST_PASSWORD }),
    }),
  );
  expect([200, 422]).toContain(signUp.status);

  await fixture.ownerPool.query('UPDATE "auth_user" SET "emailVerified" = true WHERE "email" = $1', [email]);
}

/** The user id for an address, for fixtures that need to write verification rows. */
async function userIdFor(email: string): Promise<string> {
  const rows = await fixture.ownerPool.query<{ id: string }>('SELECT "id" FROM "auth_user" WHERE "email" = $1', [
    email,
  ]);
  const id = rows.rows[0]?.id;
  if (id === undefined) throw new Error("no user row for the fixture address");
  return id;
}

/**
 * POST `/change-password` as `cookie` and return the response.
 *
 * `body` is supplied verbatim so a test can prove that omitting
 * `revokeOtherSessions` — and sending `false` — is not a way out.
 */
async function changePassword(
  cookieHeader: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fixture.auth.handler(
    new Request("http://localhost:3000/api/auth/change-password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        cookie: bareToken(cookieHeader),
      },
      body: JSON.stringify(body),
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

describe("changing a password", () => {
  it("evicts the account's OTHER sessions even when the client omits the flag", async () => {
    const email = "omitted-flag@example.invalid";
    await createVerifiedUser(email);

    // Two devices, as a user with a phone and a laptop has.
    const owner = await signInAndCaptureCookie(fixture.auth, email);
    const attacker = await signInAndCaptureCookie(fixture.auth, email);
    expect(await resolveSession(owner.cookieHeader)).not.toBeNull();
    expect(await resolveSession(attacker.cookieHeader)).not.toBeNull();

    // The request the web app makes. Note the absence of `revokeOtherSessions`:
    // it is the server's decision, not the client's.
    const response = await changePassword(owner.cookieHeader, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(response.status).toBe(200);

    expect(
      await resolveSession(attacker.cookieHeader),
      "the other session must not survive a password change",
    ).toBeNull();
  });

  it("cannot be opted out of by sending revokeOtherSessions=false", async () => {
    // A client-supplied security flag is not a security control. If `false`
    // works, the control is a suggestion.
    const email = "explicit-false@example.invalid";
    await createVerifiedUser(email);

    const owner = await signInAndCaptureCookie(fixture.auth, email);
    const attacker = await signInAndCaptureCookie(fixture.auth, email);

    const response = await changePassword(owner.cookieHeader, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: false,
    });
    expect(response.status).toBe(200);

    expect(await resolveSession(attacker.cookieHeader)).toBeNull();
  });

  it("keeps the session that made the change alive, so the user is not logged out", async () => {
    // Evicting everything would also "solve" the problem, by making password
    // change unusable. The current device must survive with a fresh credential.
    const email = "stays-signed-in@example.invalid";
    await createVerifiedUser(email);

    const owner = await signInAndCaptureCookie(fixture.auth, email);
    const response = await changePassword(owner.cookieHeader, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(response.status).toBe(200);

    const setCookies = response.headers.getSetCookie();
    const issued = setCookies.find((header) => header.includes("session_token"));
    if (issued === undefined) throw new Error("change-password set no session cookie");

    const survived = await fixture.auth.api.getSession({
      headers: new Headers({ cookie: issued.split(";")[0] ?? "" }),
    });

    expect(survived).not.toBeNull();
    expect(survived?.user.email).toBe(email);
  });

  it("actually changes the password, so the eviction is not the only effect", async () => {
    const email = "password-really-changed@example.invalid";
    await createVerifiedUser(email);
    const owner = await signInAndCaptureCookie(fixture.auth, email);

    expect(
      (
        await changePassword(owner.cookieHeader, {
          currentPassword: TEST_PASSWORD,
          newPassword: NEW_PASSWORD,
        })
      ).status,
    ).toBe(200);

    const signIn = await fixture.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ email, password: NEW_PASSWORD }),
      }),
    );
    expect(signIn.status).toBe(200);
  });
});

describe("resetting a password from the emailed link", () => {
  it("evicts every session, because a reset is the response to a compromise", async () => {
    const email = "reset-flow@example.invalid";
    await createVerifiedUser(email);
    const userId = await userIdFor(email);

    const first = await signInAndCaptureCookie(fixture.auth, email);
    const second = await signInAndCaptureCookie(fixture.auth, email);
    expect(await resolveSession(first.cookieHeader)).not.toBeNull();
    expect(await resolveSession(second.cookieHeader)).not.toBeNull();

    // The link the user clicked. The fixture writes the row the mailer would
    // have written, because the mailer is `packages/notifications`'s job and the
    // token must never appear in a test's assertion output.
    const token = "fixture-reset-token-value-0001";
    await fixture.ownerPool.query(
      `INSERT INTO "auth_verification" ("identifier", "value", "expiresAt")
       VALUES ($1, $2, now() + interval '30 minutes')`,
      [`reset-password:${token}`, userId],
    );

    const response = await fixture.auth.handler(
      new Request("http://localhost:3000/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ newPassword: NEW_PASSWORD, token }),
      }),
    );
    expect(response.status).toBe(200);

    const remaining = await fixture.ownerPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM "auth_session" WHERE "userId" = $1',
      [userId],
    );
    expect(remaining.rows[0]?.n).toBe(0);

    expect(await resolveSession(first.cookieHeader)).toBeNull();
    expect(await resolveSession(second.cookieHeader)).toBeNull();
  });
});