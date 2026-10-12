/**
 * Google OAuth ("Sign in with Google") configuration.
 *
 * WHY THESE TESTS EXIST
 * ---------------------
 * The provider block is env-gated: both credentials set or the block is absent
 * entirely. The failure this guards is a visible Google button that dies on
 * Google's error page (no credentials), or a flow that starts with half a
 * credential (only one set). Both strand the user outside the app.
 */

import { describe, expect, it } from "vitest";

import { readAuthEnv } from "./env.js";
import { optionsForEnv, TEST_AUTH_ENV } from "./test-helpers.js";

const VALID_SECRET = TEST_AUTH_ENV.secret;

function envWith(overrides: Readonly<Record<string, string | undefined>>) {
  const raw: Record<string, string | undefined> = {
    BETTER_AUTH_SECRET: VALID_SECRET,
    BETTER_AUTH_URL: "http://localhost:4000",
    DATABASE_URL: "postgresql://raptor_app@localhost/raptor_os_test",
    NODE_ENV: "test",
    ...overrides,
  };
  // `optionsForEnv` takes string-only records; drop absent optionals rather
  // than passing `undefined` through, which would read as "set to undefined".
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined as Readonly<Record<string, string>>;
}

describe("Google sign-in is env-gated", () => {
  it("offers no social provider without credentials", () => {
    const env = readAuthEnv(envWith({}));
    expect(env.googleClientId).toBeUndefined();
    expect(env.googleClientSecret).toBeUndefined();
    const options = optionsForEnv(envWith({}));
    expect(options.socialProviders).toBeUndefined();
  });

  it("refuses a client ID without its secret", () => {
    expect(() =>
      readAuthEnv(envWith({ GOOGLE_CLIENT_ID: "some-id.apps.googleusercontent.com" })),
    ).toThrow(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set/);
  });

  it("refuses a secret without its client ID", () => {
    expect(() =>
      readAuthEnv(envWith({ GOOGLE_CLIENT_SECRET: "GOCSPX-fake-secret-value-here" })),
    ).toThrow(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set/);
  });

  it("treats an empty credential the same as an absent one", () => {
    const env = readAuthEnv(envWith({ GOOGLE_CLIENT_ID: "   ", GOOGLE_CLIENT_SECRET: "" }));
    expect(env.googleClientId).toBeUndefined();
    expect(env.googleClientSecret).toBeUndefined();
  });

  it("configures Google with offline access and forced account selection when both are set", () => {
    const options = optionsForEnv(
      envWith({
        GOOGLE_CLIENT_ID: "some-id.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "GOCSPX-fake-secret-value-here",
      }),
    );
    const google = options.socialProviders?.["google"];
    expect(google).toBeDefined();
    expect(google).toMatchObject({
      clientId: "some-id.apps.googleusercontent.com",
      clientSecret: "GOCSPX-fake-secret-value-here",
      accessType: "offline",
      prompt: "select_account consent",
    });
  });
});
