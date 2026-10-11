/**
 * Liveness.
 *
 * `liveness()` from `@raptor/observability` checks nothing external, and that
 * is the specification rather than an omission: a liveness probe that touches a
 * dependency will restart a perfectly healthy process every time the database
 * blinks, which is how a brief outage becomes an outage loop.
 *
 * The result of `GET /api/health` is therefore "this process is running", full
 * stop. Whether it can serve traffic is `/api/ready`'s answer, and it is a
 * different endpoint for exactly that reason.
 */

import { liveness } from "@raptor/observability";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const report = liveness(process.env["npm_package_version"] ?? "0.1.0-dev");

  return Response.json(report, {
    status: 200,
    // `liveness()` is always `ok` by construction; the 503 branch would be
    // unreachable and asserting so here would be a test of a fiction.
    headers: { "cache-control": "no-store" },
  });
}