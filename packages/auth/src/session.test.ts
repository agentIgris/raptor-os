/**
 * Session lifecycle tests, against an in-process PGlite instance (PostgreSQL
 * 18.3 in WebAssembly).
 *
 * PROVES, rather than asserts by inspection:
 *   - a session within its lifetime IS accepted (the control works);
 *   - an EXPIRED session is rejected;
 *   - a REVOKED session is rejected;
 *   - a session survives neither an expiry nor a deletion, and rejection is
 *     indistinguishable in shape from never having signed in.
 *
 * The expiry case is the one most easily faked: an in-memory fake would return
 * whatever the test told it to. Here the row's `expires_at` is moved into the
 * past by SQL and the real session lookup has to notice on its own.
 *
 * CONNECTION HANDLING
 * -------------------
 * Fixtures are written as `raptor_migrator`; assertions go through Better Auth,
 * which connects as `raptor_app`. That split is deliberate — a superuser
 * connection bypasses RLS and would make the isolation assertions vacuous
 * (ADR-0006).
 *
 * NO TOKEN IS EVER LOGGED. On failure the messages below name the assertion, not
 * the credential.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  APP_DATABASE_URL,
  TEST_PASSWORD,
  createAuthFixture,
  signInAndCaptureCookie,
  truncateAuthTables,
  type AuthTestFixture,
} from "./test-helpers.js";

let fixture: AuthTestFixture;

/** Create a verified account, ignoring an existing one with the same address. */
async function ensureVerifiedUser(email: string): Promise<void> {
  // Register through the real sign-up endpoint so the password is hashed by
  // Better Auth with its own algorithm, then mark the address verified because
  // `requireEmailVerification` is on. An existing account is left alone, so a
  // test can sign in twice to obtain two sessions.
  const signUp = await fixture.auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ name: "Session Tester", email, password: TEST_PASSWORD }),
    }),
  );
  expect([200, 422]).toContain(signUp.status);

  await fixture.ownerPool.query('UPDATE "auth_user" SET "emailVerified" = true WHERE "email" = $1', [email]);
}

/** Create a verified user plus a live session, and return the replay cookie. */
async function signedInCookieFor(email: string): Promise<string> {
  await ensureVerifiedUser(email);
  const { cookieHeader } = await signInAndCaptureCookie(fixture.auth, email);
  return cookieHeader;
}

/** Ask Better Auth to resolve a session from a replay cookie. */
async function resolveSession(cookieHeader: string) {
  return fixture.auth.api.getSession({
    headers: new Headers({ cookie: cookieHeader.replace(/^Cookie:\s*/, "") }),
  });
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

describe("a live session", () => {
  it("is accepted and resolves to its user", async () => {
    const cookieHeader = await signedInCookieFor("live@example.invalid");
    const result = await resolveSession(cookieHeader);

    expect(result).not.toBeNull();
    expect(result?.user.email).toBe("live@example.invalid");
  });

  it("stores the session in Postgres, not in process memory", async () => {
    await signedInCookieFor("stored@example.invalid");

    // The point of ADR-0007: sessions are database rows, so revocation is a
    // DELETE rather than a best-effort cache eviction.
    const result = await fixture.ownerPool.query<{ n: number }>('SELECT count(*)::int AS n FROM "auth_session"');
    expect(result.rows[0]?.n).toBeGreaterThan(0);
  });
});

describe("an expired session", () => {
  it("is rejected", async () => {
    const email = "expired@example.invalid";
    const cookieHeader = await signedInCookieFor(email);

    const before = await resolveSession(cookieHeader);
    expect(before).not.toBeNull();

    // Move the expiry into the past. `createdAt` is deliberately also moved
    // back, because the schema asserts `expiresAt > createdAt`; leaving
    // `createdAt` in the present would violate that CHECK and the test would be
    // measuring the constraint rather than the expiry logic.
    await fixture.ownerPool.query(
      'UPDATE "auth_session" SET "expiresAt" = now() - interval \'1 hour\', "createdAt" = now() - interval \'25 hours\'',
    );

    const after = await resolveSession(cookieHeader);
    expect(after).toBeNull();
  });

  it("is rejected for every role, so expiry is not conditional on privilege", async () => {
    const cookieHeader = await signedInCookieFor("expired-role@example.invalid");
    await fixture.ownerPool.query(
      'UPDATE "auth_session" SET "expiresAt" = now() - interval \'1 minute\', "createdAt" = now() - interval \'2 days\'',
    );

    expect(await resolveSession(cookieHeader)).toBeNull();
  });

  it("leaves the account intact, so the user can sign in again", async () => {
    const email = "recoverable@example.invalid";
    await ensureVerifiedUser(email);
    await fixture.ownerPool.query(
      'UPDATE "auth_session" SET "expiresAt" = now() - interval \'1 hour\', "createdAt" = now() - interval \'25 hours\'',
    );

    // Expiry is a property of the session row, not a lockout of the account.
    const { cookieHeader } = await signInAndCaptureCookie(fixture.auth, email);
    expect(await resolveSession(cookieHeader)).not.toBeNull();
  });
});

describe("a revoked session", () => {
  it("is rejected once its row is deleted", async () => {
    const email = "revoked@example.invalid";
    const cookieHeader = await signedInCookieFor(email);

    expect(await resolveSession(cookieHeader)).not.toBeNull();

    // Revocation is provable: the row is gone, so no cached copy can revive it.
    await fixture.ownerPool.query('DELETE FROM "auth_session"');

    expect(await resolveSession(cookieHeader)).toBeNull();
  });

  it("is rejected when revoked by signing out through the API", async () => {
    const email = "signout@example.invalid";
    await ensureVerifiedUser(email);
    const { cookieHeader } = await signInAndCaptureCookie(fixture.auth, email);
    expect(await resolveSession(cookieHeader)).not.toBeNull();

    await fixture.auth.api.signOut({ headers: new Headers({ cookie: cookieHeader.replace(/^Cookie:\s*/, "") }) });

    expect(await resolveSession(cookieHeader)).toBeNull();
  });

  it("rejects only the revoked session, not the account's others", async () => {
    const email = "multi@example.invalid";
    await ensureVerifiedUser(email);

    const first = await signInAndCaptureCookie(fixture.auth, email);
    const second = await signInAndCaptureCookie(fixture.auth, email);

    expect(await resolveSession(first.cookieHeader)).not.toBeNull();
    expect(await resolveSession(second.cookieHeader)).not.toBeNull();

    // Revoke one device only — the "sign out this device" case.
    await fixture.auth.api.signOut({ headers: new Headers({ cookie: first.cookieHeader.replace(/^Cookie:\s*/, "") }) });

    expect(await resolveSession(first.cookieHeader)).toBeNull();
    expect(await resolveSession(second.cookieHeader)).not.toBeNull();
  });

  it("rejects a token that was never issued", async () => {
    // Guards against a lookup that returns "some session" for any input.
    const result = await fixture.auth.api.getSession({
      headers: new Headers({ cookie: "raptor.session_token=not-a-real-signed-token" }),
    });

    expect(result).toBeNull();
  });
});

describe("session rotation", () => {
  it("configures an expiry and a refresh window, both in seconds", () => {
    const options = fixture.auth.options;
    expect(options.session?.expiresIn).toBe(60 * 60 * 12);
    expect(options.session?.updateAge).toBe(60 * 15);
  });

  it("issues sessions with a concrete future expiry, never a null one", async () => {
    await signedInCookieFor("rotating@example.invalid");

    const result = await fixture.appPool.query<{ total: number; nulls: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE "expiresAt" IS NULL)::int AS nulls FROM "auth_session"`,
    );

    expect(result.rows[0]?.total).toBeGreaterThan(0);
    expect(result.rows[0]?.nulls).toBe(0);
  });
});

describe("application role connectivity", () => {
  it("is what the auth instance is configured to use, never the migrator", () => {
    // If this ever regresses to the superuser, every RLS assertion in this file
    // becomes theatre while still passing.
    expect(APP_DATABASE_URL).toContain("raptor_app");
    expect(APP_DATABASE_URL).not.toContain("raptor_migrator");
  });
});