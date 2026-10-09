/**
 * Mass-assignment tests.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * AUDIT F-AUTH-03 (HIGH): `SecureProfileCreation.createAdminProfile(userId,
 * email, name)` performed `upsert({ id: userId, role: 'admin', role_level: 100
 * })` on the **user-bound Supabase client**, commented *"Emergency admin
 * creation — skipping auth verification"* and *"caller is responsible for
 * verification"*. It was dormant, but the moment a permissive INSERT policy was
 * added (which F-AUTH-02 says was required for sign-up to work at all), it
 * became a one-call escalation for any authenticated user.
 *
 * The lesson was not merely "delete that function". It was that a role must not
 * be a value a client can supply. The structural fix is Better Auth's
 * `input: false` on the `role` field: `parseInputData` throws `FIELD_NOT_ALLOWED`
 * for any request body carrying that key, on both sign-up and update.
 *
 * These tests drive the real HTTP endpoints with a hostile body rather than
 * calling the parser directly, so they prove the property survives routing,
 * body parsing, and the adapter — not just that a helper works.
 *
 * The same mechanism is what makes "agreement acceptance trusting a
 * client-supplied role" impossible: the acceptance record can carry evidence,
 * but the role it would have granted cannot be written by the caller.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TEST_PASSWORD, createAuthFixture, truncateAuthTables, type AuthTestFixture } from "./test-helpers.js";

let fixture: AuthTestFixture;

const BASE_URL = "http://localhost:3000";

beforeAll(async () => {
  fixture = await createAuthFixture({ truncate: false });
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  await truncateAuthTables(fixture.migratorPool);
});

/** POST a JSON body to an auth endpoint and return status and parsed body. */
async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fixture.auth.handler(
    new Request(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify(body),
    }),
  );

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }

  return { status: response.status, body: parsed };
}

/** Read the stored role for an account. */
async function storedRole(email: string): Promise<string | null> {
  const result = await fixture.migratorPool.query<{ role: string }>(
    'SELECT "role" FROM "user" WHERE "email" = $1',
    [email],
  );
  return result.rows[0]?.role ?? null;
}

describe("a client cannot supply a role at sign-up", () => {
  it("assigns the least-privileged role when the body asks for admin", async () => {
    const { body } = await post("/api/auth/sign-up/email", {
      name: "Aspiring Admin",
      email: "escalate@example.invalid",
      password: TEST_PASSWORD,
      role: "admin",
    });

    // The account is created, but not as an admin.
    expect(await storedRole("escalate@example.invalid")).toBe("pending");
    // And the response reflects what was stored, not what was requested.
    expect((body as { user?: { role?: string } }).user?.role).toBe("pending");
  });

  it("refuses to create an owner, even asked for politely", async () => {
    await post("/api/auth/sign-up/email", {
      name: "Aspiring Owner",
      email: "escalate-owner@example.invalid",
      password: TEST_PASSWORD,
      role: "owner",
    });

    expect(await storedRole("escalate-owner@example.invalid")).toBe("pending");
  });

  it.each(["admin", "owner", "manager", "root", "superuser"])(
    "never grants %s from a sign-up body",
    async (requested) => {
      const email = `try-${requested}@example.invalid`;
      await post("/api/auth/sign-up/email", {
        name: "Escalator",
        email,
        password: TEST_PASSWORD,
        role: requested,
      });

      expect(await storedRole(email)).not.toBe(requested);
      expect(await storedRole(email)).toBe("pending");
    },
  );

  it("ignores a nested privilege claim, not just a top-level role", async () => {
    const email = "nested@example.invalid";
    await post("/api/auth/sign-up/email", {
      name: "Nested",
      email,
      password: TEST_PASSWORD,
      role: "admin",
      additionalFields: { role: "owner" },
      metadata: { role: "admin", role_level: 100 },
    });

    expect(await storedRole(email)).toBe("pending");
  });

  it("strips fields Better Auth does not declare, so nothing smuggles through", async () => {
    const email = "smuggle@example.invalid";
    await post("/api/auth/sign-up/email", {
      name: "Smuggler",
      email,
      password: TEST_PASSWORD,
      role_level: 100,
      isAdmin: true,
      twoFactorEnabled: true,
    });

    // `twoFactorEnabled` is declared `input: false` by the two-factor plugin and
    // lands on its own default. Crucially it is NOT something the client can set
    // to skip enrolment.
    const row = await fixture.migratorPool.query<{ role: string; twoFactorEnabled: boolean }>(
      'SELECT "role", "twoFactorEnabled" FROM "user" WHERE "email" = $1',
      [email],
    );

    expect(row.rows[0]?.role).toBe("pending");
    expect(row.rows[0]?.twoFactorEnabled).toBe(false);
  });
});

describe("a client cannot supply a role at update", () => {
  it("rejects a profile update that carries a role", async () => {
    const email = "update-escalate@example.invalid";
    await post("/api/auth/sign-up/email", { name: "Updater", email, password: TEST_PASSWORD });
    await fixture.migratorPool.query('UPDATE "user" SET "emailVerified" = true WHERE "email" = $1', [email]);

    // Sign in to obtain the session the update requires.
    const signIn = await fixture.auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email, password: TEST_PASSWORD }),
      }),
    );
    expect(signIn.status).toBe(200);

    const cookie = signIn.headers.getSetCookie().find((h) => h.includes("session_token"));
    expect(cookie).toBeDefined();
    const cookieHeader = new Headers({ cookie: (cookie ?? "").split(";")[0] ?? "" });

    // Better Auth's `parseInputData` throws `FIELD_NOT_ALLOWED` for a key marked
    // `input: false`. The whole point is that this is a REJECTION, not a silent
    // drop: a caller attempting escalation should learn it failed.
    await expect(
      fixture.auth.api.updateUser({
        headers: cookieHeader,
        body: { name: "Renamed", role: "admin" } as never,
      }),
    ).rejects.toThrow(/role is not allowed to be set/);

    expect(await storedRole(email)).toBe("pending");
  });

  it("allows the same update once the role key is absent", async () => {
    const email = "update-clean@example.invalid";
    await post("/api/auth/sign-up/email", { name: "Clean", email, password: TEST_PASSWORD });
    await fixture.migratorPool.query('UPDATE "user" SET "emailVerified" = true WHERE "email" = $1', [email]);

    const signIn = await fixture.auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email, password: TEST_PASSWORD }),
      }),
    );
    const cookie = signIn.headers.getSetCookie().find((h) => h.includes("session_token"));
    const cookieHeader = new Headers({ cookie: (cookie ?? "").split(";")[0] ?? "" });

    await fixture.auth.api.updateUser({
      headers: cookieHeader,
      body: { name: "Legitimately Renamed" },
    });

    // Assert against the stored row rather than the response shape: the point is
    // that the write landed and the role did not move. This proves the rejection
    // above was about the role key specifically, not about updates being broken.
    const stored = await fixture.migratorPool.query<{ name: string; role: string }>(
      'SELECT "name", "role" FROM "user" WHERE "email" = $1',
      [email],
    );

    expect(stored.rows[0]?.name).toBe("Legitimately Renamed");
    expect(stored.rows[0]?.role).toBe("pending");
  });

  it("rejects the same escalation over the HTTP route a browser would use", async () => {
    const email = "http-escalate@example.invalid";
    await post("/api/auth/sign-up/email", { name: "Http", email, password: TEST_PASSWORD });
    await fixture.migratorPool.query('UPDATE "user" SET "emailVerified" = true WHERE "email" = $1', [email]);

    const signIn = await fixture.auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email, password: TEST_PASSWORD }),
      }),
    );
    const cookie = signIn.headers.getSetCookie().find((h) => h.includes("session_token"));
    expect(cookie).toBeDefined();

    const response = await fixture.auth.handler(
      new Request(`${BASE_URL}/api/auth/update-user`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          cookie: (cookie ?? "").split(";")[0] ?? "",
        },
        body: JSON.stringify({ name: "Renamed", role: "owner" }),
      }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await storedRole(email)).toBe("pending");
  });
});

describe("the database is the backstop", () => {
  it("rejects a privileged role with no MFA even from a direct privileged write", async () => {
    // The role column is writable by the app role, and `role` is not something a
    // client can set — but a bug in server code still could. The MFA trigger
    // rejects the escalation regardless of who issues it.
    await post("/api/auth/sign-up/email", {
      name: "Direct",
      email: "direct-escalate@example.invalid",
      password: TEST_PASSWORD,
    });

    await expect(
      fixture.migratorPool.query(
        'UPDATE "user" SET "role" = $2 WHERE "email" = $1',
        ["direct-escalate@example.invalid", "admin"],
      ),
    ).rejects.toThrow(/MFA_REQUIRED/);

    expect(await storedRole("direct-escalate@example.invalid")).toBe("pending");
  });

  it("allows the promotion once MFA is enrolled", async () => {
    const email = "promote-ok@example.invalid";
    await post("/api/auth/sign-up/email", { name: "Promote", email, password: TEST_PASSWORD });

    await fixture.migratorPool.query('UPDATE "user" SET "twoFactorEnabled" = true WHERE "email" = $1', [email]);
    await fixture.migratorPool.query('UPDATE "user" SET "role" = $2 WHERE "email" = $1', [email, "manager"]);

    expect(await storedRole(email)).toBe("manager");
  });
});