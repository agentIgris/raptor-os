/**
 * Liveness and readiness routes.
 *
 * These do not invent a health model. `liveness()` and `readiness()` come from
 * `@raptor/observability` — the same functions the rest of the platform's
 * processes use — and this module supplies the dependency probes that package
 * expects.
 *
 * The two are deliberately different and the difference matters operationally:
 *
 *  - `/api/health` checks NOTHING. It reports that the process is running.
 *    A failing liveness probe restarts the process.
 *  - `/api/ready` runs the probes. A failing readiness probe takes the
 *    instance out of the load balancer and must NOT restart it, or a two-second
 *    database blip becomes a crash loop.
 *
 * The status code contract: 200 for `ok` and `degraded`, 503 for `fail`. A
 * platform that only looks at the status code still gets the right answer,
 * while the body carries the per-dependency detail.
 */

import { logger, readiness, type DependencyProbe } from "@raptor/observability";
import { tlsOptionsForDatabaseUrl } from "@raptor/auth";
import { Pool } from "pg";

import { tryGetAuth } from "../../../server/auth";

/**
 * The version reported by both probes.
 *
 * Read from the app's own package manifest rather than a hand-maintained
 * constant, so a release that forgets to bump it cannot report the previous
 * version to an operator staring at a failing deployment.
 */
const VERSION: string = process.env["npm_package_version"] ?? "0.1.0-dev";

export const dynamic = "force-dynamic";

/**
 * A readiness probe over Postgres.
 *
 * `SELECT 1` is the cheapest statement that still proves the server accepted a
 * connection and executed a plan. It does not touch application tables,
 * because a readiness probe that queries business data turns every slow
 * migration into an outage.
 *
 * The pool is created once and reused: a probe that opened a connection per
 * scrape is how a health endpoint becomes the thing that exhausts the pool it
 * is checking.
 */
let pool: Pool | null = null;

function databaseProbe(): DependencyProbe {
  return {
    name: "postgres",
    check: async () => {
      pool ??= (() => {
        const raw =
          process.env["DATABASE_URL"] ?? "postgresql://raptor_app@127.0.0.1:5432/raptor_os";
        const resolved = tlsOptionsForDatabaseUrl(raw);
        return new Pool({
          connectionString: resolved.connectionString,
          max: 2,
          connectionTimeoutMillis: 2_000,
          application_name: "raptor_readiness",
          // Same TLS rule as the auth pool, from the same function: two pools
          // with two TLS behaviors is how one of them silently stops verifying.
          // `tlsOptionsForDatabaseUrl` returns no `ssl` key for ordinary URLs,
          // so local development against plain Postgres is unaffected.
          ...(resolved.ssl === undefined ? {} : { ssl: resolved.ssl }),
        });
      })();

      // A pool with no `error` listener throws an unhandled `'error'` event the
      // moment an idle backend dies, which crashes the process — turning a
      // transient database blip into an application outage. The listener below
      // records it through the structured logger instead.
      pool.on("error", (error: Error) => {
        logger.error("postgres.pool_error", { reason: error.message });
      });

      await pool.query("SELECT 1");
    },
  };
}

/**
 * A readiness probe over the auth configuration.
 *
 * `tryGetAuth()` returning `null` means the environment is incomplete — a
 * missing `BETTER_AUTH_SECRET` or `BETTER_AUTH_URL`. The process can run, but
 * it cannot establish a session, so it must not receive traffic. This is a
 * genuine readiness failure, not a warning.
 */
function authConfigurationProbe(): DependencyProbe {
  return {
    name: "auth-configuration",
    check: () => {
      if (tryGetAuth() === null) {
        throw new Error("Authentication environment is incomplete; this instance cannot serve sign-in.");
      }
    },
  };
}

export async function GET(): Promise<Response> {
  const report = await readiness([authConfigurationProbe(), databaseProbe()], VERSION);

  return Response.json(report, {
    status: report.status === "fail" ? 503 : 200,
    // Never cached: a cached readiness answer is worse than none.
    headers: { "cache-control": "no-store" },
  });
}