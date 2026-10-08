import { describe, expect, it } from "vitest";

import { liveness, readiness, type DependencyProbe } from "./health.js";

const ok: DependencyProbe = { name: "database", check: () => undefined };

describe("liveness", () => {
  it("reports ok without touching any dependency", () => {
    const report = liveness("1.2.3");
    expect(report.status).toBe("ok");
    expect(report.checks).toEqual([{ name: "process", status: "ok" }]);
    expect(report.version).toBe("1.2.3");
  });

  it("stays ok even when every dependency is down, so a blip does not restart the process", async () => {
    const broken: DependencyProbe = {
      name: "database",
      check: () => {
        throw new Error("connection refused");
      },
    };
    await readiness([broken]);
    expect(liveness().status).toBe("ok");
  });
});

describe("readiness", () => {
  it("reports ok when every dependency is healthy", async () => {
    const report = await readiness([ok, { name: "storage", check: () => undefined }]);
    expect(report.status).toBe("ok");
    expect(report.checks.map((c) => c.name)).toEqual(["database", "storage"]);
  });

  it("fails when a dependency throws, and names it", async () => {
    const report = await readiness([
      ok,
      {
        name: "storage",
        check: () => {
          throw new Error("disk unavailable");
        },
      },
    ]);

    expect(report.status).toBe("fail");
    const failed = report.checks.find((c) => c.name === "storage")!;
    expect(failed.status).toBe("fail");
    expect(failed.detail).toBe("disk unavailable");
  });

  it("fails when a dependency rejects asynchronously", async () => {
    const report = await readiness([
      {
        name: "database",
        check: () => Promise.reject(new Error("timeout")),
      },
    ]);
    expect(report.status).toBe("fail");
  });

  it("reports the worst status across many dependencies", async () => {
    const report = await readiness([
      ok,
      ok,
      {
        name: "queue",
        check: () => {
          throw new Error("down");
        },
      },
    ]);
    expect(report.status).toBe("fail");
    expect(report.checks.filter((c) => c.status === "ok")).toHaveLength(2);
  });

  it("handles a non-Error rejection without leaking internals", async () => {
    const report = await readiness([
      {
        name: "database",
        check: () => Promise.reject("a bare string"),
      },
    ]);
    expect(report.status).toBe("fail");
    expect(report.checks[0]!.detail).toBe("unknown error");
  });

  it("records a duration for each probe", async () => {
    const report = await readiness([
      {
        name: "slow",
        check: async () => {
          await new Promise((resolve) => setTimeout(resolve, 15));
        },
      },
    ]);
    expect(report.checks[0]!.durationMs).toBeGreaterThanOrEqual(10);
  });

  it("is ok with no probes configured", async () => {
    const report = await readiness([]);
    expect(report.status).toBe("ok");
  });

  it("carries a timestamp and version", async () => {
    const report = await readiness([ok], "9.9.9");
    expect(typeof report.timestamp).toBe("string");
    expect(report.version).toBe("9.9.9");
  });
});