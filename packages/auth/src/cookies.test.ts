/**
 * Session cookie flag tests.
 *
 * THE DEFECT BEING PREVENTED
 * --------------------------
 * AUDIT F-AUTH-01 (HIGH): "the session (including the refresh token) is stored in
 * `localStorage`". `lib/supabase.ts:36-51` set
 * `storage: window.localStorage`, so any script executing in the origin could
 * read the access token *and* the long-lived refresh token — persistent account
 * takeover, for administrators included.
 *
 * These assertions are the regression test for that. `httpOnly` is the property
 * that makes the cookie unreadable from JavaScript, so it is asserted first and
 * asserted on every cookie, not just the session one: a cookie that carries the
 * `two_factor` challenge or the trusted-device marker and is NOT httpOnly would
 * reintroduce the same leak through a side door.
 *
 * `getCookies` is Better Auth's own exported helper (from `better-auth/cookies`),
 * so this asserts on the resolved attributes the runtime will actually apply
 * rather than on a re-implementation of the rules.
 */

import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getCookies } from "better-auth/cookies";

import { buildAuthOptions } from "./config.js";
import { readAuthEnv } from "./env.js";

const SECRET = "cookie-test-signing-secret-0123456789abcdef";
const BASE_URL = "http://localhost:3000";

/**
 * Build options against a pool that is never connected.
 *
 * `buildAuthOptions` stores the pool and reads nothing from it, so these tests
 * assert real configuration shape without opening a socket. The pool is created
 * once and shared because constructing one is free and connecting is not.
 */
const unconnectedPool = new Pool({
  connectionString: "postgresql://raptor_app@127.0.0.1:5432/raptor_os_test",
  max: 1,
});

function optionsFor(nodeEnv: string) {
  return buildAuthOptions(
    readAuthEnv({
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: nodeEnv === "production" ? "https://raptor.example" : BASE_URL,
      DATABASE_URL: "postgresql://raptor_app@127.0.0.1:5432/raptor_os_test",
      NODE_ENV: nodeEnv,
    }),
    unconnectedPool,
  );
}

const COOKIE_NAMES = ["sessionToken", "sessionData", "dontRememberToken", "accountData"] as const;

describe("session cookie flags", () => {
  it("marks every auth cookie httpOnly, so no script in the origin can read it", () => {
    const cookies = getCookies(optionsFor("development"));

    for (const name of COOKIE_NAMES) {
      expect(cookies[name].attributes.httpOnly, `${name} must be httpOnly`).toBe(true);
    }
  });

  it("sets SameSite=Lax on every cookie", () => {
    const cookies = getCookies(optionsFor("development"));

    for (const name of COOKIE_NAMES) {
      expect(cookies[name].attributes.sameSite, `${name} SameSite`).toBe("lax");
    }
  });

  it("scopes every cookie to the whole origin with path=/", () => {
    const cookies = getCookies(optionsFor("development"));

    for (const name of COOKIE_NAMES) {
      expect(cookies[name].attributes.path, `${name} path`).toBe("/");
    }
  });

  it("marks the session cookie Secure in production", () => {
    const cookies = getCookies(optionsFor("production"));

    for (const name of COOKIE_NAMES) {
      expect(cookies[name].attributes.secure, `${name} must be Secure in production`).toBe(true);
    }
  });

  it("names cookies with the __Secure- prefix in production only", () => {
    const production = getCookies(optionsFor("production"));
    expect(production.sessionToken.name.startsWith("__Secure-")).toBe(true);

    // Over plain http in development the Secure attribute would make the browser
    // drop the cookie outright, so it is absent there — and so is the prefix,
    // which is what Better Auth uses to name the two variants distinctly.
    const development = getCookies(optionsFor("development"));
    expect(development.sessionToken.name.startsWith("__Secure-")).toBe(false);
    expect(development.sessionToken.attributes.secure).toBe(false);
  });

  it("uses the raptor cookie prefix, so it cannot collide with another auth library", () => {
    const cookies = getCookies(optionsFor("development"));

    for (const name of COOKIE_NAMES) {
      expect(cookies[name].name, `${name} must carry the raptor prefix`).toContain("raptor");
    }
  });

  it("bounds the session cookie lifetime to the configured expiry", () => {
    const cookies = getCookies(optionsFor("development"));

    // 12 hours, in seconds. `maxAge` is what tells the browser when to stop
    // sending it; an absent or unbounded value would outlive the server-side
    // session and be replayed pointlessly.
    expect(cookies.sessionToken.attributes.maxAge).toBe(60 * 60 * 12);
  });

  it("never configures a cookie the browser would accept cross-site without SameSite", () => {
    const cookies = getCookies(optionsFor("production"));

    // `SameSite=None` is only honoured alongside `Secure`, and it would remove
    // the CSRF boundary the legacy app already had to re-learn.
    for (const name of COOKIE_NAMES) {
      expect(cookies[name].attributes.sameSite).not.toBe("none");
    }
  });
});

describe("cookie cache", () => {
  it("is disabled, so revocation is immediate rather than observable at cache expiry", () => {
    // A cookie-cached session is readable for `maxAge` after a revoke. ADR-0007
    // requires provable revocation, so the cache stays off.
    expect(optionsFor("production").session?.cookieCache?.enabled).toBe(false);
  });
});