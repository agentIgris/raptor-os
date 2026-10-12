/**
 * Functional smoke tests against the production build.
 *
 * Small, and every one of them covers a path that could be broken by a build
 * succeeding for the wrong reason — which is the defect class ADR-0012 exists to
 * prevent, and the one the legacy project shipped.
 *
 * `/dashboard` is expected to REDIRECT, not to render. That is the session
 * guard doing its job with no database present. A test that made it render
 * would be asserting a security bypass.
 */

import { expect, test } from "@playwright/test";

test.describe("public routes", () => {
  test("/ renders the overview with exactly one h1", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Money and obligations");
  });

  test("renders a labelled form with no application errors in the console", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => {
      errors.push(`uncaught: ${error.message}`);
    });

    await page.goto("/sign-in");

    await expect(page.getByLabel("Email address")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    /*
     * ALLOWED, AND ONLY THIS:
     *
     *   "Failed to load resource: ... 503" for `/api/auth/get-session`
     *
     * There is no database in this environment, so the sign-in page's session
     * probe fails — which is the app behaving correctly (it shows the form
     * rather than an authenticated view). Chromium logs a console error for any
     * non-2xx fetch, and that entry says nothing about the application's
     * correctness.
     *
     * Everything else fails the test: React hydration errors, uncaught
     * exceptions, and any other failed request.
     */
    const unexpected = errors.filter((message) => !/Failed to load resource.*api\/auth/.test(message));
    expect(unexpected, `unexpected console errors on /sign-in:\n${unexpected.join("\n")}`).toEqual([]);
  });

  test("the password visibility toggle reveals and re-hides the password", async ({ page }) => {
    await page.goto("/sign-in");

    const password = page.getByLabel("Password");
    const toggle = page.getByRole("button", { name: "Show password" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(password).toHaveAttribute("type", "password");

    await toggle.click();
    await expect(page.getByRole("button", { name: "Hide password" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(password).toHaveAttribute("type", "text");

    await page.getByRole("button", { name: "Hide password" }).click();
    await expect(page.getByRole("button", { name: "Show password" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(password).toHaveAttribute("type", "password");
  });

  test("the theme toggle cycles system, light, dark and back", async ({ page }) => {
    await page.goto("/");

    const html = page.locator("html");
    await expect(html).not.toHaveClass(/(\s|^)(light|dark)(\s|$)/);

    await page.getByRole("button", { name: "Use light theme" }).click();
    await expect(html).toHaveClass(/(^|\s)light(\s|$)/);

    await page.getByRole("button", { name: "Use dark theme" }).click();
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);

    await page.getByRole("button", { name: "Use system theme" }).click();
    await expect(html).not.toHaveClass(/(\s|^)(light|dark)(\s|$)/);
  });
});

test.describe("session guard fails closed", () => {
  test("/dashboard redirects to sign-in with no session", async ({ request }) => {
    // `maxRedirects: 0` so the 307 itself is observed. Following it and
    // checking the final URL would also pass if the app had rendered the
    // protected page and then client-side replaced itself.
    const response = await request.get("/dashboard", { maxRedirects: 0 });

    expect(response.status()).toBe(307);
    expect(response.headers()["location"]).toContain("/sign-in");
  });

  test("no dashboard content is served at the protected URL", async ({ page }) => {
    await page.goto("/dashboard");
    expect(page.url()).toContain("/sign-in");
    await expect(page.getByRole("heading", { level: 1, name: /money and obligations/i })).toHaveCount(0);
  });
});

test.describe("health endpoints", () => {
  test("GET /api/health is a liveness probe that touches nothing", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);

    const report = (await response.json()) as {
      status: string;
      version: string;
      timestamp: string;
      checks: { name: string; status: string }[];
    };

    expect(report.status).toBe("ok");
    expect(report.version.length).toBeGreaterThan(0);
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Only `process`. If a database check appears here, the two probes have
    // been conflated and a database blip will start restarting the app.
    expect(report.checks.map((check) => check.name)).toEqual(["process"]);
  });

  test("GET /api/ready reports failure honestly and answers 503", async ({ request }) => {
    const response = await request.get("/api/ready");

    // No database is reachable from this environment, so the honest answer is
    // "not ready". Asserting 200 here would require either a live database or
    // a stubbed probe, and a stubbed probe would prove nothing about the wiring.
    expect(response.status()).toBe(503);

    const report = (await response.json()) as {
      status: string;
      checks: { name: string; status: string; detail?: string }[];
    };

    expect(report.status).toBe("fail");

    const byName = new Map(report.checks.map((check) => [check.name, check.status]));
    expect([...byName.keys()].sort()).toEqual(["auth-configuration", "postgres"]);
    // The auth environment IS configured for this suite (a placeholder secret
    // is supplied), so only the database probe can fail.
    expect(byName.get("auth-configuration")).toBe("ok");
    expect(byName.get("postgres")).toBe("fail");
  });

  test("the readiness failure detail leaks no credentials", async ({ request }) => {
    const response = await request.get("/api/ready");
    const body = await response.text();

    expect(body).not.toContain("raptor_app:");
    expect(body).not.toContain("BETTER_AUTH_SECRET=");
  });
});

test.describe("response headers", () => {
  test("every page ships the security headers from next.config", async ({ request }) => {
    const response = await request.get("/");

    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["x-frame-options"]).toBe("DENY");
    expect(response.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  test("the CSP uses a per-request nonce and no unsafe-inline scripts", async ({ request }) => {
    const first = await request.get("/");
    const second = await request.get("/");

    const policyOf = (response: Awaited<ReturnType<typeof request.get>>): string =>
      response.headers()["content-security-policy"] ?? "";

    for (const policy of [policyOf(first), policyOf(second)]) {
      expect(policy).toContain("default-src 'self'");
      expect(policy).toMatch(/script-src 'self' 'nonce-[^']+'/);
      // The whole point of the nonce: an injected script cannot carry it.
      expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(policy).not.toContain("'unsafe-eval'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain("object-src 'none'");
    }

    // Two responses must not share a nonce, or it stops being per-response.
    const nonceOf = (policy: string): string =>
      /'nonce-([^']+)'/.exec(policy)?.[1] ?? "";
    expect(nonceOf(policyOf(first))).not.toBe("");
    expect(nonceOf(policyOf(first))).not.toBe(nonceOf(policyOf(second)));
  });
});