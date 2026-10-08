/**
 * Health and readiness.
 *
 * The legacy application had no health endpoint and no dependency checks, so an outage
 * could only be discovered by users. These are the two probes a deployment platform
 * needs, and they are deliberately distinct:
 *
 *  - `liveness`  — is this process alive? No dependencies checked. A failing liveness
 *                  probe should restart the process.
 *  - `readiness` — can this process serve traffic? Dependencies checked. A failing
 *                  readiness probe should remove it from the load balancer but must
 *                  NOT restart it, or a brief database blip becomes a restart loop.
 */

export type HealthStatus = "ok" | "degraded" | "fail";

export interface HealthCheck {
  readonly name: string;
  readonly status: HealthStatus;
  readonly durationMs?: number;
  readonly detail?: string;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly checks: readonly HealthCheck[];
  readonly timestamp: string;
  readonly version: string;
}

export interface DependencyProbe {
  readonly name: string;
  /** Resolve when the dependency is usable; reject or throw to report failure. */
  check(): Promise<void> | void;
}

const RANK: Record<HealthStatus, number> = { ok: 0, degraded: 1, fail: 2 };

/** Liveness: the process is running. Deliberately checks nothing external. */
export function liveness(version = "0.0.0"): HealthReport {
  return {
    status: "ok",
    checks: [{ name: "process", status: "ok" }],
    timestamp: new Date().toISOString(),
    version,
  };
}

/**
 * Readiness: run every dependency probe and report the worst outcome.
 *
 * A failing dependency is `fail`, which makes the whole report `fail` and tells the
 * platform to stop routing traffic. Probes run concurrently so one slow dependency
 * does not delay the others.
 */
export async function readiness(probes: readonly DependencyProbe[], version = "0.0.0"): Promise<HealthReport> {
  const checks = await Promise.all(
    probes.map(async (probe): Promise<HealthCheck> => {
      const startedAt = Date.now();
      try {
        await probe.check();
        return { name: probe.name, status: "ok", durationMs: Date.now() - startedAt };
      } catch (error) {
        return {
          name: probe.name,
          status: "fail",
          durationMs: Date.now() - startedAt,
          // Never leak internal detail or credentials to an unauthenticated probe.
          detail: error instanceof Error ? error.message : "unknown error",
        };
      }
    }),
  );

  const status = checks.reduce<HealthStatus>(
    (worst, check) => (RANK[check.status] > RANK[worst] ? check.status : worst),
    "ok",
  );

  return { status, checks, timestamp: new Date().toISOString(), version };
}