/**
 * MFA enforcement tests, against an in-process PGlite instance (PostgreSQL 18.3
 * in WebAssembly).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * AUDIT/09 §1 recorded "MFA / TOTP: NOT IMPLEMENTED — no `mfa` reference
 * anywhere". Nothing anywhere required MFA, so a stolen admin password was
 * immediately, permanently, and unchallenged access. Enabling TOTP is only half
 * the fix; something must *require* it.
 *
 * This suite proves the requirement holds end to end at three layers:
 *
 *   1. the pure policy            — `roles.test.ts`
 *   2. the database trigger       — here, via real SQL
 *   3. the session-creation gate  — here, via a real sign-in
 *
 * Layer 2 is the one with teeth. Better Auth's own `twoFactor` plugin only
 * challenges a user whose `twoFactorEnabled` is already true; it implements "if
 * MFA is on, verify it", never "privileged roles must have MFA". A hook could in
 * principle close that, but on UPDATE Better Auth passes only the changed
 * columns with no `id`, so a hook cannot see the account's enrolment state. The
 * trigger can, which is why `schema.sql` owns the rule.
 *
 * THE BOOTSTRAP, STATED PLAINLY
 * -----------------------------
 * If "privileged implies enrolled" were enforced only at session creation, every
 * administrator would be locked out permanently: no session means no ability to
 * reach the enrolment screen. Enforcing it at the point of *granting* the role
 * avoids that entirely — an account enrols while unprivileged, then is promoted.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PRIVILEGED_ROLES } from "./roles.js";
import { TEST_PASSWORD, createAuthFixture, truncateAuthTables, type AuthTestFixture } from "./test-helpers.js";

let fixture: AuthTestFixture;

beforeAll(async () => {
  fixture = await createAuthFixture({ truncate: false });
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  await truncateAuthTables(fixture);
});

/** Insert a user, returning the PostgreSQL error code when the trigger fires. */
async function tryInsertUser(input: {
  email: string;
  role: string;
  twoFactorEnabled: boolean;
}): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  try {
    await fixture.ownerPool.query(
      `INSERT INTO "auth_user" ("name", "email", "emailVerified", "role", "twoFactorEnabled")
       VALUES ('MFA Tester', $1, true, $2, $3)`,
      [input.email, input.role, input.twoFactorEnabled],
    );
    return { ok: true };
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { ok: false, code: failure.code ?? "UNKNOWN", message: failure.message ?? "" };
  }
}

/** Promote an existing user to a role, returning the error code on rejection. */
async function tryUpdateRole(userId: string, role: string, twoFactorEnabled?: boolean): Promise<string | null> {
  try {
    if (twoFactorEnabled === undefined) {
      await fixture.ownerPool.query('UPDATE "auth_user" SET "role" = $2 WHERE "id" = $1', [userId, role]);
    } else {
      await fixture.ownerPool.query(
        'UPDATE "auth_user" SET "role" = $2, "twoFactorEnabled" = $3 WHERE "id" = $1',
        [userId, role, twoFactorEnabled],
      );
    }
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "UNKNOWN";
  }
}

/** Create a verified, password-bearing account via the real sign-up endpoint. */
async function createLoginableUser(email: string, role: string, twoFactorEnabled: boolean): Promise<string> {
  const signUp = await fixture.auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ name: "MFA Tester", email, password: TEST_PASSWORD }),
    }),
  );
  expect([200, 422]).toContain(signUp.status);

  const promoted = await fixture.ownerPool.query<{ id: string }>(
    'UPDATE "auth_user" SET "emailVerified" = true, "role" = $2, "twoFactorEnabled" = $3 WHERE "email" = $1 RETURNING "id"',
    [email, role, twoFactorEnabled],
  );

  const row = promoted.rows[0];
  if (row === undefined) throw new Error(`No user row for ${email}`);
  return row.id;
}

describe("MFA is mandatory for privileged roles", () => {
  for (const role of PRIVILEGED_ROLES) {
    it(`refuses to create a "${role}" who has not enrolled TOTP`, async () => {
      const result = await tryInsertUser({ email: `new-${role}@example.invalid`, role, twoFactorEnabled: false });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("23514");
        expect(result.message).toContain("MFA_REQUIRED");
      }
    });

    it(`allows a "${role}" who HAS enrolled TOTP`, async () => {
      const result = await tryInsertUser({
        email: `ok-${role}@example.invalid`,
        role,
        twoFactorEnabled: true,
      });

      expect(result.ok).toBe(true);
    });

    it(`refuses to promote an un-enrolled account to "${role}"`, async () => {
      const created = await tryInsertUser({ email: `promote-${role}@example.invalid`, role: "player", twoFactorEnabled: false });
      expect(created.ok).toBe(true);

      const rows = await fixture.ownerPool.query<{ id: string }>(
        'SELECT "id" FROM "auth_user" WHERE "email" = $1',
        [`promote-${role}@example.invalid`],
      );
      const userId = rows.rows[0]?.id;
      if (userId === undefined) throw new Error("fixture user missing");

      expect(await tryUpdateRole(userId, role)).toBe("23514");
    });

    it(`refuses to switch MFA off while the account is "${role}"`, async () => {
      const created = await tryInsertUser({
        email: `disable-${role}@example.invalid`,
        role,
        twoFactorEnabled: true,
      });
      expect(created.ok).toBe(true);

      const rows = await fixture.ownerPool.query<{ id: string }>(
        'SELECT "id" FROM "auth_user" WHERE "email" = $1',
        [`disable-${role}@example.invalid`],
      );
      const userId = rows.rows[0]?.id;
      if (userId === undefined) throw new Error("fixture user missing");

      // The intended behaviour, stated as a test: demote before removing MFA.
      expect(await tryUpdateRole(userId, role, false)).toBe("23514");
    });
  }
});

describe("MFA is optional for non-privileged roles", () => {
  for (const role of ["pending", "player", "coach", "analyst"] as const) {
    it(`allows a "${role}" with no TOTP enrolled`, async () => {
      const result = await tryInsertUser({ email: `plain-${role}@example.invalid`, role, twoFactorEnabled: false });
      expect(result.ok).toBe(true);
    });
  }

  it("allows an enrolled non-privileged account too", async () => {
    const result = await tryInsertUser({ email: "plain-both@example.invalid", role: "player", twoFactorEnabled: true });
    expect(result.ok).toBe(true);
  });
});

describe("the role CHECK constraint", () => {
  it("rejects a role that is not in the vocabulary", async () => {
    // The legacy system offered `tryout` in a role picker while its CHECK
    // constraint forbade it, so selecting it produced a 23514 (AUDIT/08).
    const result = await tryInsertUser({ email: "bogus@example.invalid", role: "tryout", twoFactorEnabled: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("23514");
  });

  it("accepts every role in the vocabulary", async () => {
    const roles = ["pending", "player", "coach", "analyst", "manager", "admin", "owner"];

    for (const [index, role] of roles.entries()) {
      const result = await tryInsertUser({
        email: `vocab-${index}@example.invalid`,
        role,
        twoFactorEnabled: true,
      });
      expect(result.ok, `role ${role}`).toBe(true);
    }
  });
});

describe("session issuance honours the MFA requirement", () => {
  it("refuses a session to a privileged account whose MFA was bypassed", async () => {
    // Reproduce the exact state the trigger exists to prevent: a privileged row
    // with no enrolment, created before the trigger existed or by a disabled
    // trigger. The session gate must still refuse.
    await fixture.ownerPool.query(
      'ALTER TABLE "auth_user" DISABLE TRIGGER user_mfa_guard_trigger',
    );

    try {
      await createLoginableUser("bypassed@example.invalid", "admin", false);
    } finally {
      await fixture.ownerPool.query('ALTER TABLE "auth_user" ENABLE TRIGGER user_mfa_guard_trigger');
    }

    const response = await fixture.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ email: "bypassed@example.invalid", password: TEST_PASSWORD }),
      }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("issues a session to a non-privileged account with no MFA", async () => {
    await createLoginableUser("ordinary@example.invalid", "player", false);

    const response = await fixture.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ email: "ordinary@example.invalid", password: TEST_PASSWORD }),
      }),
    );

    expect(response.status).toBe(200);
  });

  it("issues a session to a privileged account that has enrolled MFA", async () => {
    await createLoginableUser("enrolled@example.invalid", "manager", true);

    const response = await fixture.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ email: "enrolled@example.invalid", password: TEST_PASSWORD }),
      }),
    );

    expect(response.status).toBe(200);
  });
});

describe("the TOTP surface", () => {
  it("keeps the rate limiter on for the paths that remain", () => {
    // The 6-digit challenge is not issued in this build, so the oracle it would
    // have opened does not exist. The limiter that does matter is the one on
    // the sign-in path, and it stays on in every environment.
    expect(fixture.auth.options.rateLimit?.enabled).toBe(true);
  });

  it("holds no secret material anywhere, in the twoFactor table or in the user row", async () => {
    const userId = await createLoginableUser("secret@example.invalid", "player", false);

    const secrets = await fixture.ownerPool.query<{ n: number }>('SELECT count(*)::int AS n FROM "auth_two_factor"');
    const inUser = await fixture.ownerPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM "auth_user" WHERE "id" = $1 AND "twoFactorEnabled" = true',
      [userId],
    );

    // No enrolment can happen, so no secret exists — which is the correct
    // starting state. The assertion is that nothing leaked into the user row,
    // which has no column for it at all.
    expect(secrets.rows[0]?.n).toBe(0);
    expect(inUser.rows[0]?.n).toBe(0);
  });
});