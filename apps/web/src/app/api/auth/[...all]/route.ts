/**
 * The Better Auth handler.
 *
 * Mounted at `/api/auth/*` and delegated to in full. Nothing here inspects,
 * filters, rewrites or re-signs a request or a response: the security
 * properties (httpOnly + SameSite=Lax cookies, CSRF and origin checks, rate
 * limits, PKCE, the MFA gate on privileged roles) all live in
 * `packages/auth`, and a wrapper that touched them would be a second place for
 * them to be wrong.
 *
 * The one decision here is what happens when the environment is incomplete.
 * It returns 503 rather than throwing a 500, because "this instance is
 * misconfigured" and "this instance crashed" are different operational
 * problems, and 503 is the one that takes the instance out of rotation without
 * restarting it.
 */

import { logger } from "@raptor/observability";

import { requireAuth } from "../../../../server/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

async function handle(request: Request): Promise<Response> {
  let auth: ReturnType<typeof requireAuth>;
  try {
    auth = requireAuth();
  } catch {
    return Response.json(
      { error: "Authentication is not configured for this deployment." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    return await auth.handler(request);
  } catch (error) {
    logger.error("auth.handler_failed", {
      path: new URL(request.url).pathname,
      reason: error instanceof Error ? error.message : "unknown error",
    });
    // A 500 here is deliberate. Returning 200 to an unhandled auth failure
    // would let a client believe it had signed in.
    return Response.json({ error: "Authentication request failed." }, { status: 500 });
  }
}