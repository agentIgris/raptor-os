/**
 * Reading the current session.
 *
 * WHAT THIS FUNCTION WILL NOT DO
 * ------------------------------
 * It reads the session from the request **cookie only**. It never consults
 * `localStorage`, never reads `document.cookie`, and never accepts a session
 * token from a query string, a header the client can forge, or a URL
 * parameter. The tenant is resolved from the signed session claim, never from
 * a request parameter (spec §2, constraint 5).
 */

import { logger } from "@raptor/observability";
import { headers } from "next/headers";

import { tryGetAuth } from "./auth";

/** The subset of the session this app renders. Deliberately narrow. */
export interface CurrentSession {
  readonly userId: string;
  readonly email: string;
  readonly role: string;
  /** The ACTIVE ORGANISATION, from the signed session claim. Never a parameter. */
  readonly orgId: string | null;
  readonly twoFactorEnabled: boolean;
}

/**
 * Narrow an untrusted value to a string.
 *
 * Better Auth's inferred session type does not carry the additional fields this
 * package configures (`role`, `orgId`, `twoFactorEnabled`), because the options
 * are handed to `betterAuth()` as a widened `BetterAuthOptions` rather than as
 * a literal. Reading them through a helper instead of an `any` cast keeps the
 * rule from the anti-recurrence list — "no `any` in domain code" — and makes a
 * shape change fail loudly at the type boundary rather than at runtime.
 */
function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

/**
 * Resolve the session for the current request, or `null`.
 *
 * `null` covers three cases that all mean the same thing to the caller: no
 * cookie, an expired or forged cookie, and an environment that cannot validate
 * one at all. Collapsing them is deliberate — a caller cannot accidentally
 * treat "the system could not check" as "the check passed".
 */
export async function getCurrentSession(): Promise<CurrentSession | null> {
  const auth = tryGetAuth();
  if (auth === null) return null;

  try {
    const requestHeaders = new Headers(await headers());
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (session === null) return null;

    const user: unknown = session.user;
    const sessionRow: unknown = session.session;

    if (user === null || typeof user !== "object") return null;
    if (sessionRow === null || typeof sessionRow !== "object") return null;

    const userRecord = user as Record<string, unknown>;
    const sessionRecord = sessionRow as Record<string, unknown>;

    const userId = readString(userRecord["id"]);
    if (userId === null) return null;

    return {
      userId,
      email: readString(userRecord["email"]) ?? "",
      // `pending` is the default Better Auth writes when no role was assigned,
      // so it is the least-privileged value this can return.
      role: readString(userRecord["role"]) ?? "pending",
      orgId: readString(sessionRecord["orgId"]),
      twoFactorEnabled: readBoolean(userRecord["twoFactorEnabled"]),
    };
  } catch (error) {
    logger.error("session.resolve_failed", {
      reason: error instanceof Error ? error.message : "unknown error",
    });
    return null;
  }
}