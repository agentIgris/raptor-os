/**
 * Session resolution.
 *
 * The session guard is the tenancy spine of this application: spec §2
 * constraint 5 requires the tenant to come from a signed session claim and
 * NEVER from a request parameter. `getCurrentSession()` is the only thing that
 * reads it, so its failure behaviour is the thing worth testing.
 *
 * The rule under test: **it fails closed, and it fails closed the same way.**
 * No cookie, an expired cookie, a forged cookie, an unreadable session row and
 * a completely unconfigured environment all produce `null`. There is no branch
 * that returns a session-shaped object when the check could not be performed,
 * because "the system could not check" and "the check passed" must not be
 * distinguishable to a caller.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn<(input: { headers: Headers }) => Promise<unknown>>();
const headersMock = vi.fn<() => Promise<Headers>>();

vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

vi.mock("../server/auth", () => ({
  tryGetAuth: () => ({ api: { getSession } }),
}));

const { getCurrentSession } = await import("../server/session");

function sessionRow(overrides: {
  user?: Record<string, unknown>;
  session?: Record<string, unknown>;
}): unknown {
  return {
    user: { id: "u1", email: "coach@example.com", role: "coach", twoFactorEnabled: true, ...overrides.user },
    session: { id: "s1", userId: "u1", orgId: "org-1", ...overrides.session },
  };
}

beforeEach(() => {
  getSession.mockReset();
  headersMock.mockReset();
  headersMock.mockResolvedValue(new Headers());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getCurrentSession", () => {
  it("resolves the tenant from the signed session claim", async () => {
    getSession.mockResolvedValue(sessionRow({}));

    const session = await getCurrentSession();

    expect(session).toEqual({
      userId: "u1",
      email: "coach@example.com",
      role: "coach",
      orgId: "org-1",
      twoFactorEnabled: true,
    });
  });

  it("returns null when there is no session at all", async () => {
    getSession.mockResolvedValue(null);
    expect(await getCurrentSession()).toBeNull();
  });

  it("returns null — never a partial session — when the lookup throws", async () => {
    // A thrown error here is the "cannot check" case. Returning the user
    // without the session, or the session without the user, would let a caller
    // render an authenticated view from half a credential.
    getSession.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));

    expect(await getCurrentSession()).toBeNull();
  });

  it("returns null when the session row has no user id", async () => {
    getSession.mockResolvedValue(sessionRow({ user: { id: "" } }));
    expect(await getCurrentSession()).toBeNull();
  });

  it("returns null when the shapes are not objects", async () => {
    getSession.mockResolvedValue({ user: "not-an-object", session: null });
    expect(await getCurrentSession()).toBeNull();
  });

  it("defaults the role to the least-privileged value when it is missing", async () => {
    // `pending` is the default Better Auth writes when no role was assigned.
    // Anything that fell through to a higher role here would be an escalation.
    getSession.mockResolvedValue(sessionRow({ user: { role: undefined } }));

    const session = await getCurrentSession();
    expect(session?.role).toBe("pending");
  });

  it("treats an absent orgId as no tenant rather than guessing one", async () => {
    getSession.mockResolvedValue(sessionRow({ session: { orgId: undefined } }));

    const session = await getCurrentSession();
    expect(session?.orgId).toBeNull();
  });

  it("reads twoFactorEnabled from whatever shape the adapter returned", async () => {
    // The session type Better Auth infers here does not carry the additional
    // fields this app configures, so these arrive as `unknown`. Coercing them
    // through a boolean test rather than an `any` cast is what keeps
    // "no `any` in domain code" (anti-recurrence rule 3) true at this boundary.
    getSession.mockResolvedValue(sessionRow({ user: { twoFactorEnabled: "true" } }));
    expect((await getCurrentSession())?.twoFactorEnabled).toBe(true);

    getSession.mockResolvedValue(sessionRow({ user: { twoFactorEnabled: undefined } }));
    expect((await getCurrentSession())?.twoFactorEnabled).toBe(false);
  });

  it("never reads a tenant from anywhere but the session", async () => {
    // The call must pass ONLY the request headers. There is no parameter
    // through which a caller could assert an organisation, and a URL query
    // parameter is not consulted.
    getSession.mockResolvedValue(sessionRow({ session: { orgId: "org-from-session" } }));

    await getCurrentSession();

    expect(getSession).toHaveBeenCalledTimes(1);
    const [argument] = getSession.mock.calls[0] ?? [];
    expect(Object.keys(argument ?? {})).toEqual(["headers"]);
    expect(argument?.headers).toBeInstanceOf(Headers);
  });
});