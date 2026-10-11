/**
 * Signing-secret strength tests.
 *
 * WHAT THIS FILE EXISTS BECAUSE OF
 * -------------------------------
 * A red-team reproduction: with `BETTER_AUTH_SECRET=secret`, an attacker forged
 * the email-verification JWT — `HS256` over `{email, iat, exp}`, keyed on that
 * secret — and obtained a session for an unverified account. No password, no
 * user interaction, no contact with the legitimate owner. `readAuthEnv`
 * accepted `"x"`, `"secret"`, and `"changeme"` without complaint, and
 * `.env.example` shipped `dev-only-not-a-real-secret-change-me`, which teaches
 * every operator who copies it that the value is disposable.
 *
 * The secret is the root of trust for the whole package: it signs session
 * cookies, email-verification tokens and password-reset tokens. A weak one is
 * not a weakened control, it is no control.
 *
 * WHY THERE IS NO `any` IN THIS FILE
 * ---------------------------------
 * These tests call `readAuthEnv` and inspect thrown messages. Nothing here ever
 * prints, returns or embeds the candidate secret, and no failure message is
 * allowed to contain one — the message carries the variable NAME and the reason,
 * never the value, which is the same rule `env.ts` follows.
 */

import { describe, expect, it } from "vitest";

import {
  AuthEnvironmentError,
  ENV_EXAMPLE_PLACEHOLDER_SECRETS,
  MIN_AUTH_SECRET_DISTINCT_CHARACTERS,
  MIN_AUTH_SECRET_LENGTH,
  PLACEHOLDER_AUTH_SECRETS,
  countDistinctCharacters,
  isPlaceholderAuthSecret,
  readAuthEnv,
  testAuthSecretAcceptable,
} from "./env.js";
import { TEST_ENV } from "./test-helpers.js";

/** A candidate value that clears every length/character rule, so the only thing under test is the rule itself. */
const STRONG_SECRET = "Zm9yLXRlc3Rpbmctb25seS1hLXJlYWxseS1nZW5lcjIzNA==";

function envWithSecret(secret: string, nodeEnv = "production"): Record<string, string> {
  return {
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: "https://raptor.example",
    DATABASE_URL: "postgresql://raptor_app@raptor_os_test/raptor_os_test",
    NODE_ENV: nodeEnv,
  };
}

describe("a signing secret that is too short", () => {
  // These are the exact values the red-team reproduction used. Each one is also
  // accepted by Better Auth itself, which only warns.
  it.each(["x", "secret", "changeme", "password", "hunter2"])(
    "is rejected in production: %j",
    (secret) => {
      expect(() => readAuthEnv(envWithSecret(secret, "production"))).toThrow(AuthEnvironmentError);
    },
  );

  it("names the variable, so the operator knows what to replace", () => {
    expect(() => readAuthEnv(envWithSecret("secret", "production"))).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("never echoes the rejected value back", () => {
    let thrown: unknown;
    try {
      readAuthEnv(envWithSecret("secret-that-must-not-be-logged", "production"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthEnvironmentError);
    expect((thrown as Error).message).not.toContain("secret-that-must-not-be-logged");
  });

  it("rejects everything shorter than the documented minimum", () => {
    // The boundary is a contract, so it is asserted as one rather than sampled.
    for (let length = 1; length < MIN_AUTH_SECRET_LENGTH; length++) {
      const candidate = "a1b2c3d4e5f6g7h8".slice(0, length);
      expect(() => readAuthEnv(envWithSecret(candidate, "production")), `length ${length}`).toThrow(
        AuthEnvironmentError,
      );
    }
  });

  it("accepts a value exactly at the documented minimum", () => {
    const candidate = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"; // 32 chars, 32 distinct
    expect(candidate).toHaveLength(MIN_AUTH_SECRET_LENGTH);
    expect(() => readAuthEnv(envWithSecret(candidate, "production"))).not.toThrow();
  });
});

describe("a signing secret with degenerate character structure", () => {
  // Length alone is not a strength measure. These are 32+ characters and would
  // satisfy a naive length check, and each is guessable in one or two guesses.
  it.each([
    ["a".repeat(48), "one repeated character"],
    ["0123456789".repeat(5), "a ten-character block repeated"],
    ["ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12", "a four-character block repeated"],
  ])("is rejected: %s (%s)", (candidate) => {
    expect(candidate.length).toBeGreaterThanOrEqual(MIN_AUTH_SECRET_LENGTH);
    expect(() => readAuthEnv(envWithSecret(candidate, "production"))).toThrow(AuthEnvironmentError);
  });

  it("states the minimum distinct characters the rule enforces", () => {
    expect(MIN_AUTH_SECRET_DISTINCT_CHARACTERS).toBeGreaterThan(1);
    expect(countDistinctCharacters("a".repeat(48))).toBe(1);
  });
});

describe("a placeholder signing secret", () => {
  // The realistic failure is not a weak generator, it is an operator who copied
  // `.env.example` and never came back. Each shipped value is rejected by name.
  it.each(PLACEHOLDER_AUTH_SECRETS)("is rejected by exact value: %j", (placeholder) => {
    expect(() => readAuthEnv(envWithSecret(placeholder, "production"))).toThrow(AuthEnvironmentError);
  });

  it("rejects a placeholder padded to the minimum length, so padding is not a bypass", () => {
    // `changemechangemechangemechangem` is 29 chars of the same dictionary words;
    // a length rule alone would wave it through at 32.
    expect(() => readAuthEnv(envWithSecret(`${"changeme".repeat(5)}`, "production"))).toThrow(
      AuthEnvironmentError,
    );
  });

  it("rejects a placeholder regardless of surrounding case or whitespace", () => {
    expect(() => readAuthEnv(envWithSecret("  ChangeMe  ", "production"))).toThrow(AuthEnvironmentError);
    expect(() => readAuthEnv(envWithSecret("SECRET", "production"))).toThrow(AuthEnvironmentError);
  });

  it("classifies placeholders without leaking whether a real secret was checked", () => {
    expect(isPlaceholderAuthSecret("changeme")).toBe(true);
    expect(isPlaceholderAuthSecret("CHANGE-ME")).toBe(true);
    expect(isPlaceholderAuthSecret(STRONG_SECRET)).toBe(false);
  });
});

describe("the placeholders shipped in .env.example", () => {
  // The example file is how an operator learns what a value should look like. A
  // placeholder in it is an instruction, so it is treated as a security defect
  // with the same force as a placeholder accepted by the validator.
  it("is a non-empty list", () => {
    expect(ENV_EXAMPLE_PLACEHOLDER_SECRETS.length).toBeGreaterThan(0);
  });

  it("includes every value the shipped example file used to assign", () => {
    // `dev-only-not-a-real-secret-change-me` was `BETTER_AUTH_SECRET` in
    // `.env.example`; the storage one is included because the same reasoning
    // applies and a copy-paste of the file moves both.
    expect(ENV_EXAMPLE_PLACEHOLDER_SECRETS).toContain("dev-only-not-a-real-secret-change-me");
    expect(ENV_EXAMPLE_PLACEHOLDER_SECRETS).toContain("dev-only-signing-secret-change-me");
  });

  it("is rejected by readAuthEnv", () => {
    for (const shipped of ENV_EXAMPLE_PLACEHOLDER_SECRETS) {
      expect(() => readAuthEnv(envWithSecret(shipped, "production")), shipped).toThrow(
        AuthEnvironmentError,
      );
    }
  });
});

describe("the test fixture's own secret", () => {
  // The rule is not allowed to be met by weakening the suite. If the policy ever
  // tightens, this fails and the FIXTURE is updated — the policy is not.
  it("satisfies the production policy unchanged", () => {
    expect(() => readAuthEnv({ ...TEST_ENV, NODE_ENV: "production" })).not.toThrow();
  });

  it("is reported as acceptable by the same predicate the validator uses", () => {
    expect(testAuthSecretAcceptable(TEST_ENV["BETTER_AUTH_SECRET"] ?? "")).toBe(true);
  });
});

describe("environment-dependent strictness", () => {
  // DECISION, stated so a reviewer can disagree with it explicitly: there is NO
  // relaxed development rule.
  //
  // A development secret is the secret that gets promoted. The usual sequence —
  // copy `.env.local` to staging, copy staging's to production — carries whatever
  // weakness development allowed, and the environment name is not carried with
  // it. A rule that is strict in production and lenient in development therefore
  // has a real chance of never being applied to a live system at all.
  //
  // The cost of the strict-always rule is one command for a developer to run
  // (`openssl rand -base64 32`). The benefit is that there is exactly ONE
  // definition of an acceptable secret, so "is this deployment safe?" has one
  // answer rather than two.
  it.each(["development", "test", "production"])("applies the same rule when NODE_ENV=%s", (nodeEnv) => {
    expect(() => readAuthEnv(envWithSecret("secret", nodeEnv)), nodeEnv).toThrow(AuthEnvironmentError);
    expect(() => readAuthEnv(envWithSecret("changeme", nodeEnv)), nodeEnv).toThrow(AuthEnvironmentError);
    expect(() => readAuthEnv(envWithSecret(STRONG_SECRET, nodeEnv)), nodeEnv).not.toThrow();
  });
});