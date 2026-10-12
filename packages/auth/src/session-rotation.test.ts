/**
 * Session token rotation, as BEHAVIOUR rather than as a configuration integer.
 *
 * THE DEFECT THIS FILE EXISTS BECAUSE OF
 * -------------------------------------
 * `config.ts` documented: "A rotation window of 15 minutes means a stolen cookie
 * is useful for at most 15 minutes before the legitimate user's next request
 * silently rotates it, which is what makes revocation observable."
 *
 * That was false. Better Auth's session route calls
 * `internalAdapter.updateSession(token, { expiresAt: now + expiresIn })` —
 * the SAME token, with a pushed-forward expiry. Reproduced: four successive
 * requests each moved `expiresAt` further out and `tokenRotated` stayed `false`.
 * A stolen cookie therefore stayed useful indefinitely, for as long as the
 * attacker kept using it, which is the F-AUTH-01 outcome this package claims to
 * have closed.
 *
 * A docstring that states the opposite of the truth is worse than no docstring,
 * because a reviewer reads it and stops looking. So this file asserts the
 * BEHAVIOUR, which is the only thing that can be true and the only thing that
 * can fail when it regresses.
 *
 * WHAT "ROTATION" MUST MEAN HERE
 * ------------------------------
 * Not merely "the expiry moved". Rotation means the old token stops resolving:
 * the value the legitimate browser holds after a refresh is different from the
 * one it held before, and the one it no longer holds is dead in the database.
 * A test that only watched `expiresAt` would pass against the broken
 * implementation, which is exactly how this defect survived a green suite.
 *
 * NO TOKEN IS EVER LOGGED OR ASSERTED BY VALUE. Failure messages name the
 * property, never the credential.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from "./config.js";
import {
  TEST_PASSWORD,
  createAuthFixture,
  signInAndCaptureCookie,
  truncateAuthTables,
  type AuthTestFixture,
} from "./test-helpers.js";

let fixture: AuthTestFixture;

/** Create a verified account through the real sign-up endpoint. */
async function ensureVerifiedUser(email: string): Promise<void> {
  const signUp = await fixture.auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ name: "Rotation Tester", email, password: TEST_PASSWORD }),
    }),
  );
  expect([200, 422]).toContain(signUp.status);

  await fixture.ownerPool.query('UPDATE "auth_user" SET "emailVerified" = true WHERE "email" = $1', [email]);
}

/** The raw session-token cookie value held by a browser, without the `Cookie: ` prefix. */
function bareToken(cookieHeader: string): string {
  return cookieHeader.replace(/^Cookie:\s*/, "");
}

/** Ask Better Auth to resolve a session from a replay cookie. */
async function resolveSession(cookieHeader: string) {
  return fixture.auth.api.getSession({ headers: new Headers({ cookie: bareToken(cookieHeader) }) });
}

/** Call `/get-session` through the real handler and return its response. */
async function getSessionViaHandler(cookieHeader: string): Promise<Response> {
  return fixture.auth.handler(
    new Request("http://localhost:3000/api/auth/get-session", {
      method: "GET",
      headers: { cookie: bareToken(cookieHeader), origin: "http://localhost:3000" },
    }),
  );
}

/**
 * The session-token cookie a `Set-Cookie` list handed the browser, as a request
 * `Cookie` header value, or null when none was set.
 *
 * The value is passed through VERBATIM. `Set-Cookie` percent-encodes the
 * signature separator, and decoding it here would produce a header the server's
 * own cookie parser rejects — so a test that "fixed" it would be testing the
 * wrong thing and would report a broken rotation that is not broken.
 */
function sessionCookieFromSetCookie(headers: readonly string[]): string | null {
  for (const header of headers) {
    if (!header.includes("session_token")) continue;
    const pair = header.split(";")[0];
    if (pair === undefined) continue;
    return `${pair.slice(0, pair.indexOf("=") + 1)}${pair.slice(pair.indexOf("=") + 1)}`;
  }
  return null;
}

/**
 * Move a session to the instant at which Better Auth decides it needs a refresh.
 *
 * The route refreshes when `expiresAt - expiresIn + updateAge <= now`, i.e. once
 * the session is within `updateAge` of its absolute expiry. Ageing `expiresAt`
 * to that boundary is the honest way to trigger the real code path rather than
 * reaching past it and asserting on a value the server chose on its own.
 */
async function ageSessionIntoTheRefreshWindow(): Promise<void> {
  const secondsRemaining = SESSION_EXPIRES_IN_SECONDS - SESSION_UPDATE_AGE_SECONDS - 60;
  await fixture.ownerPool.query('UPDATE "auth_session" SET "expiresAt" = now() + ($1::text || \' seconds\')::interval', [
    String(secondsRemaining),
  ]);
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

describe("a session inside the refresh window", () => {
  it("rotates to a NEW token rather than extending the old one", async () => {
    const email = "rotate@example.invalid";
    await ensureVerifiedUser(email);
    const original = await signInAndCaptureCookie(fixture.auth, email);

    const before = await fixture.ownerPool.query<{ token: string }>('SELECT "token" FROM "auth_session"');
    const tokenBefore = before.rows[0]?.token;
    if (tokenBefore === undefined) throw new Error("no session row after sign-in");

    await ageSessionIntoTheRefreshWindow();

    const response = await getSessionViaHandler(original.cookieHeader);
    expect(response.status).toBe(200);
    expect(sessionCookieFromSetCookie(response.headers.getSetCookie())).not.toBeNull();

    // The STORED token, not the cookie string. The cookie is re-signed on every
    // refresh, so its value changes whether or not the token underneath it does;
    // asserting on the cookie would pass against the broken implementation,
    // which is how this defect stayed invisible behind a green suite.
    const after = await fixture.ownerPool.query<{ token: string }>('SELECT "token" FROM "auth_session"');
    expect(after.rows[0]?.token).not.toBe(tokenBefore);
  });

  it("makes the pre-rotation token dead, so a stolen copy stops working", async () => {
    // This is the property the old docstring claimed and the old code did not
    // have. Without it, "rotation" is just a synonym for "the expiry moved".
    const email = "revoked-by-rotation@example.invalid";
    await ensureVerifiedUser(email);
    const original = await signInAndCaptureCookie(fixture.auth, email);

    expect(await resolveSession(original.cookieHeader)).not.toBeNull();

    await ageSessionIntoTheRefreshWindow();
    const response = await getSessionViaHandler(original.cookieHeader);
    expect(response.status).toBe(200);

    expect(
      await resolveSession(original.cookieHeader),
      "the cookie the attacker holds must stop resolving once the owner refreshes",
    ).toBeNull();
  });

  it("leaves the new token working, so rotation does not log the owner out", async () => {
    const email = "keeps-working@example.invalid";
    await ensureVerifiedUser(email);
    const original = await signInAndCaptureCookie(fixture.auth, email);

    await ageSessionIntoTheRefreshWindow();
    const response = await getSessionViaHandler(original.cookieHeader);
    const rotatedCookie = sessionCookieFromSetCookie(response.headers.getSetCookie());
    if (rotatedCookie === null) throw new Error("refresh set no session cookie");

    const afterRotation = await fixture.auth.api.getSession({
      headers: new Headers({ cookie: rotatedCookie }),
    });

    expect(afterRotation).not.toBeNull();
    expect(afterRotation?.user.email).toBe(email);
  });

  it("keeps exactly one session row, rather than accumulating one per refresh", async () => {
    // A rotation that INSERTED rather than REPLACED would leave the old rows
    // behind, and those rows are still valid bearer credentials in every other
    // code path that reads the table directly.
    const email = "no-leftovers@example.invalid";
    await ensureVerifiedUser(email);
    const original = await signInAndCaptureCookie(fixture.auth, email);

    await ageSessionIntoTheRefreshWindow();
    await getSessionViaHandler(original.cookieHeader);

    const rows = await fixture.ownerPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM "auth_session"',
    );
    expect(rows.rows[0]?.n).toBe(1);
  });
});

describe("a session that is not yet due for a refresh", () => {
  it("keeps the same token, because rotating on every request breaks concurrency", async () => {
    // The rotation window is 15 minutes. Rotating per request would invalidate
    // the second of two in-flight tabs, which is a self-inflicted outage rather
    // than a security control.
    const email = "stable@example.invalid";
    await ensureVerifiedUser(email);
    const original = await signInAndCaptureCookie(fixture.auth, email);
    const originalToken = bareToken(original.cookieHeader);

    // No ageing: a fresh session is 12 hours from expiry, so `needsRefresh` is
    // false and the route takes the no-write path.
    const response = await getSessionViaHandler(original.cookieHeader);
    expect(response.status).toBe(200);

    const issuedCookie = sessionCookieFromSetCookie(response.headers.getSetCookie());
    if (issuedCookie === null) {
      // No Set-Cookie at all is equally correct: the credential did not change.
      expect(await resolveSession(original.cookieHeader)).not.toBeNull();
    } else {
      expect(issuedCookie).toBe(originalToken);
    }
  });

  it("still honours a revoked session, so rotation is not a bypass of revocation", async () => {
    const email = "still-revocable@example.invalid";
    await ensureVerifiedUser(email);
    const original = await signInAndCaptureCookie(fixture.auth, email);

    await fixture.ownerPool.query('DELETE FROM "auth_session"');

    const response = await getSessionViaHandler(original.cookieHeader);
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });
});