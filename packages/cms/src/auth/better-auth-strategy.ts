import { sql, type SQL } from "drizzle-orm";
import { evaluateMfaRequirement } from "@raptor/auth/roles";
import type { AuthStrategy, Payload } from "payload";

/**
 * Better Auth session strategy for Payload.
 *
 * ONE IDENTITY: a request carrying a valid Better Auth session cookie is
 * whoever `cms_operator_session()` resolves — no CMS password involved. The
 * function (not this file) enforces liveness, email verification and the
 * email match; this file enforces the MFA gate and nothing else.
 *
 * `disableLocalStrategy` stays FALSE until the live proof below passes, then
 * flips (cutover is a config line + rebuild, verified both directions in
 * Task 9 rather than asserted).
 */

export const BETTER_AUTH_STRATEGY_NAME = "better-auth";

const SESSION_COOKIES = ["raptor.session_token", "raptor-session_token"] as const;

export interface OperatorSessionRow {
  readonly operator_id: number;
  readonly email: string;
  readonly cms_role: string;
  readonly product_role: string;
  readonly product_mfa: boolean;
}

/** Minimal drizzle surface this file needs. The adapter satisfies it. */
export interface SessionQueryDb {
  execute<T>(query: SQL): Promise<{ readonly rows: readonly T[] }>;
}

/**
 * Session token from a Cookie header. First recognised cookie wins; garbage
 * (missing, empty, unsigned-looking) yields `null`, never a throw — this runs
 * on every anonymous request.
 */
export function sessionTokenFromCookieHeader(header: string | null): string | null {
  if (header === null || header === "") return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (!SESSION_COOKIES.includes(part.slice(0, eq).trim() as (typeof SESSION_COOKIES)[number])) continue;
    // Cookie value is `token.signature`; the function matches the token half.
    const token = part.slice(eq + 1).trim().split(".")[0];
    if (token !== undefined && token !== "") return token;
  }
  return null;
}

function isOperatorSessionRow(value: unknown): value is OperatorSessionRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row["operator_id"] === "number" &&
    typeof row["email"] === "string" &&
    typeof row["product_role"] === "string" &&
    typeof row["product_mfa"] === "boolean"
  );
}

/**
 * Resolve a cookie header to an operator session row, or `null`.
 * Total: every failure mode (no cookie, db down, no match) is `null`.
 */
export async function resolveOperatorSession(
  db: SessionQueryDb | null,
  cookieHeader: string | null,
): Promise<OperatorSessionRow | null> {
  const token = sessionTokenFromCookieHeader(cookieHeader);
  if (token === null || db === null) return null;
  try {
    const result = await db.execute(
      sql`SELECT operator_id, email, cms_role, product_role, product_mfa FROM cms_operator_session(${token})`,
    );
    const row = result.rows[0];
    return row !== undefined && isOperatorSessionRow(row) ? row : null;
  } catch {
    return null;
  }
}

/**
 * MFA gate for CMS access. Same rule as product sign-in
 * (`evaluateMfaRequirement` — one expression, two call sites): a privileged
 * product role without TOTP enrolment gets no CMS session either.
 */
export function gateOperatorMfa(row: OperatorSessionRow): boolean {
  return evaluateMfaRequirement(row.product_role, row.product_mfa).allowed;
}

function drizzleOf(payload: Payload): SessionQueryDb | null {
  const db = payload.db as unknown as { drizzle?: SessionQueryDb };
  return db.drizzle ?? null;
}

export const betterAuthStrategy: AuthStrategy = {
  name: BETTER_AUTH_STRATEGY_NAME,
  authenticate: async ({ headers, payload }) => {
    const resolved = await resolveOperatorSession(drizzleOf(payload), headers.get("cookie"));
    if (resolved === null || !gateOperatorMfa(resolved)) return { user: null };
    try {
      const doc = await payload.findByID({
        collection: "cms_operators",
        id: resolved.operator_id,
        overrideAccess: true,
        depth: 0,
      });
      return { user: { ...doc, collection: "cms_operators" } };
    } catch {
      return { user: null };
    }
  },
};
