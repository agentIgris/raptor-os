/**
 * The health endpoints, exercised against the real `@raptor/observability`
 * functions.
 *
 * This is the test that proves the routes are wired to the shared probes rather
 * than to a private health implementation that reports whatever it likes. It
 * imports the route handlers, runs them, and asserts against the shape
 * `HealthReport` guarantees.
 *
 * No database is available in this environment (the project targets a local
 * Postgres that is not running here), so the readiness route is expected to
 * report `fail` with a `postgres` check. That is the CORRECT answer and this
 * test asserts it as such — asserting `ok` would require either a live database
 * or a mocked probe, and a mocked probe would prove nothing about the wiring.
 */

import { afterEach, describe, expect, it } from "vitest";

import { GET as healthGet } from "../app/api/health/route";
import { GET as readyGet } from "../app/api/ready/route";

interface HealthCheckShape {
  readonly name: string;
  readonly status: "ok" | "degraded" | "fail";
}

interface HealthReportShape {
  readonly status: "ok" | "degraded" | "fail";
  readonly checks: readonly HealthCheckShape[];
  readonly timestamp: string;
  readonly version: string;
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/health (liveness)", () => {
  it("returns 200 and an ok report", async () => {
    const response = healthGet();
    expect(response.status).toBe(200);

    const report = (await response.json()) as HealthReportShape;
    expect(report.status).toBe("ok");
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.version.length).toBeGreaterThan(0);
  });

  it("checks nothing external — that is what separates it from readiness", async () => {
    // A liveness probe that touches the database restarts a healthy process
    // every time the database blinks. This is the assertion that keeps the
    // two endpoints distinct.
    const report = (await healthGet().json()) as HealthReportShape;
    expect(report.checks.map((check) => check.name)).toEqual(["process"]);
  });

  it("is not cached", () => {
    expect(healthGet().headers.get("cache-control")).toBe("no-store");
  });

  it("stays ok even with the database unreachable", async () => {
    // The whole point of separating the two probes: a database outage must not
    // cause the platform to restart a healthy process.
    process.env["DATABASE_URL"] = "postgresql://nobody@127.0.0.1:1/nothing";
    const response = healthGet();
    expect(response.status).toBe(200);
    expect(((await response.json()) as HealthReportShape).status).toBe("ok");
  });
});

describe("GET /api/ready (readiness)", () => {
  it("runs the configured dependency probes", async () => {
    const response = await readyGet();
    const report = (await response.json()) as HealthReportShape;

    const names = report.checks.map((check) => check.name).sort();
    expect(names).toEqual(["auth-configuration", "postgres"]);
  });

  it("reports fail, and answers 503, when a dependency is unusable", async () => {
    // No Postgres is reachable here and the auth environment is unset, so the
    // honest report is a failure. A platform that only reads the status code
    // still gets the right answer, and the body explains why.
    delete process.env["BETTER_AUTH_SECRET"];
    delete process.env["BETTER_AUTH_URL"];

    const response = await readyGet();
    const report = (await response.json()) as HealthReportShape;

    expect(report.status).toBe("fail");
    expect(response.status).toBe(503);

    const failed = report.checks.filter((check) => check.status === "fail").map((check) => check.name);
    expect(failed).toContain("auth-configuration");
  });

  it("never leaks a connection string or a secret in the failure detail", async () => {
    process.env["DATABASE_URL"] = "postgresql://raptor_app:hunter2@127.0.0.1:1/raptor_os";
    delete process.env["BETTER_AUTH_SECRET"];
    delete process.env["BETTER_AUTH_URL"];

    const response = await readyGet();
    const body = await response.text();

    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("raptor_app:");
  });

  it("is not cached", async () => {
    const response = await readyGet();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});