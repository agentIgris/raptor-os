/**
 * The server-side auth instance.
 *
 * The claim under test is that a misconfigured deployment FAILS CLOSED and that
 * the failure is visible in the log rather than in a stack trace.
 *
 * Two properties matter and neither is obvious from the outside:
 *
 *  1. `tryGetAuth()` returns `null` rather than throwing, so a caller that
 *     renders a page cannot be crashed by a missing environment variable. The
 *     cost is that `null` has to mean "cannot check", not "not signed in" —
 *     which is exactly why `getCurrentSession` collapses every failure into
 *     the same `null` (see `session.test.ts`).
 *
 *  2. The instance is built LAZILY. Building it at module scope would open a
 *     `pg` pool and validate secrets at import time, which would make
 *     `next build` fail on any machine without a database and a secret.
 */

import type * as AuthServer from "../server/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Capture the structured log rather than the console.
 *
 * `@raptor/observability` is the project's ONLY logger (anti-recurrence rule 1
 * forbids `console.*` in application code), so this is the record an operator
 * would actually look at. Asserting on it is what makes "the failure is
 * diagnosable" a checked claim rather than a hopeful one.
 */
const logged: { message: string; context?: Record<string, unknown> }[] = [];

vi.mock("@raptor/observability", () => ({
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message: string, context?: Record<string, unknown>) => {
      logged.push({ message, ...(context === undefined ? {} : { context }) });
    },
    child: () => ({ error: () => undefined }),
  },
}));

const ORIGINAL_ENV = { ...process.env };

/**
 * Re-import the module with a fresh cache.
 *
 * `tryGetAuth` memoises the instance in a module-level variable, so each test
 * needs a clean module or it would inherit the previous test's cached `null`.
 * `vi.resetModules()` clears the registry; the type comes from a static
 * type-only import because the linter forbids an inline `import()` annotation.
 */
async function loadAuthModule(): Promise<typeof AuthServer> {
  vi.resetModules();
  return await import("../server/auth");
}

beforeEach(() => {
  logged.length = 0;
  process.env = { ...ORIGINAL_ENV };
  delete process.env["BETTER_AUTH_SECRET"];
  delete process.env["BETTER_AUTH_URL"];
  delete process.env["DATABASE_MIGRATION_URL"];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("tryGetAuth", () => {
  it("returns null and does not throw when the environment is incomplete", async () => {
    const { tryGetAuth } = await loadAuthModule();

    expect(tryGetAuth()).toBeNull();
  });

  it("returns null — never a weakened instance — when DATABASE_URL is the migrator", async () => {
    // ADR-0006: a superuser connection silently bypasses every RLS policy.
    // `readAuthEnv` rejects it, and this app must not paper over that with a
    // fallback connection string.
    process.env["BETTER_AUTH_SECRET"] = "x".repeat(32);
    process.env["BETTER_AUTH_URL"] = "http://localhost:3000";
    process.env["DATABASE_URL"] = "postgresql://raptor_migrator@127.0.0.1:5432/raptor_os";

    const { tryGetAuth } = await loadAuthModule();
    expect(tryGetAuth()).toBeNull();
  });

  it("returns null — never throws — so a page cannot be crashed by the environment", async () => {
    const { tryGetAuth } = await loadAuthModule();

    // Two calls, because the first one is the one that would have thrown.
    expect(() => tryGetAuth()).not.toThrow();
    expect(() => tryGetAuth()).not.toThrow();
  });
});

describe("requireAuth", () => {
  it("throws when authentication is not configured", async () => {
    const { requireAuth } = await loadAuthModule();

    // There is no sensible fallback for the route handler that mounts
    // `/api/auth/*` — that endpoint has no session to refuse — so it throws and
    // the handler turns it into a 503.
    expect(() => requireAuth()).toThrow(/Authentication is not configured/);
  });

  it("names the missing variables in the log, and no value anywhere", async () => {
    const { requireAuth } = await loadAuthModule();

    let thrown = "";
    try {
      requireAuth();
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }

    // The thrown message is deliberately generic — it can reach an HTTP
    // response, and it says nothing an attacker could use.
    expect(thrown).toBe("Authentication is not configured for this deployment.");

    // The LOG is where the diagnosis lives, and it must name the variables and
    // nothing else. `readAuthEnv` reports variable NAMES only, so an operator
    // learns what to set without a secret ever reaching a log aggregator.
    const failure = logged.find((entry) => entry.message === "auth.instance_unavailable");
    expect(failure, "nothing was logged for the misconfiguration").toBeDefined();

    const reasonValue: unknown = failure?.context?.["reason"];
    const reason = typeof reasonValue === "string" ? reasonValue : "";
    expect(reason).toContain("BETTER_AUTH_SECRET");
    expect(reason).toContain("BETTER_AUTH_URL");

    // No connection string, and no assignment that could carry a value.
    expect(reason).not.toMatch(/postgresql:\/\//);
    expect(reason).not.toMatch(/(secret|token|password)\s*[:=]\s*\S/i);
  });
});