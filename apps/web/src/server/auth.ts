/**
 * The server-side authentication instance.
 *
 * Two properties this module exists to guarantee:
 *
 * 1. THE SESSION LIVES IN AN `httpOnly` COOKIE AND NOWHERE ELSE.
 *    `packages/auth` already pins `httpOnly` and `Secure` (in production) on
 *    every cookie it sets. This module's job is to not undo that: it exposes
 *    the server instance, and nothing in this file — or anywhere else in
 *    `apps/web` — reads a token out of `localStorage`, `sessionStorage`, or
 *    `document.cookie`.
 *
 *    That is not a stylistic rule. The legacy app stored the session
 *    *including the refresh token* in `localStorage` (AUDIT/09, F-AUTH-01),
 *    so a single XSS became persistent account takeover for admins too.
 *    `no-client-token-storage.test.ts` scans the whole source tree and fails
 *    the build on any reintroduction.
 *
 * 2. THE INSTANCE IS BUILT LAZILY.
 *    Building it opens a `pg` pool and validates the environment. Doing that
 *    at module scope would make `next build` fail on a machine without a
 *    database — which is not a build failure, it is a test environment. It
 *    would also mean a build-time import validated secrets it has no business
 *    reading. First request builds it; every request after reuses it.
 */

import { createAuth } from "@raptor/auth";
import { logger } from "@raptor/observability";

/** The Better Auth instance type, as installed. */
export type RaptorAuth = ReturnType<typeof createAuth>;

let cached: RaptorAuth | null = null;

/**
 * The process-wide auth instance, or `null` when the environment is not
 * configured.
 *
 * Returns `null` rather than throwing: a misconfigured deployment should
 * refuse to serve an authenticated page and say so in the log, not produce a
 * 500 whose stack trace is the only diagnostic. It NEVER returns an instance
 * with weaker security — the failure mode is closed, not open.
 */
export function tryGetAuth(): RaptorAuth | null {
  if (cached !== null) return cached;

  try {
    cached = createAuth(process.env);
    return cached;
  } catch (error) {
    logger.error("auth.instance_unavailable", {
      reason: error instanceof Error ? error.message : "unknown error",
    });
    return null;
  }
}

/**
 * The auth instance, or throw.
 *
 * For the route handler that mounts `/api/auth/*`, where there is nothing
 * sensible to do but return an error: that endpoint has no session to refuse.
 */
export function requireAuth(): RaptorAuth {
  const auth = tryGetAuth();
  if (auth === null) {
    throw new Error("Authentication is not configured for this deployment.");
  }
  return auth;
}