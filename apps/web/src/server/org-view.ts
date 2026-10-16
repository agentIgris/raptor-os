import type { RecentOrg } from "./org-actions";

/**
 * Pure organisation-switch helpers. Unit-tested; the database half lives in
 * `org-actions.ts` (IO, e2e/live-covered like `public.ts`).
 */

/** Strict UUID shape check — the switch form never sends anything else. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Session token from a cookie value. Better Auth signs cookies as
 * `token.signature`; the switch function matches the token half.
 */
export function splitSessionToken(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  const token = raw.split(".")[0];
  return token === undefined || token === "" ? null : token;
}

/** Parse the recent-orgs cookie. Garbage in, empty list out — never throws. */
export function parseRecentOrgs(raw: string | undefined): RecentOrg[] {
  if (raw === undefined || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is RecentOrg =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>)["id"] === "string" &&
          typeof (entry as Record<string, unknown>)["name"] === "string",
      )
      .slice(0, 5);
  } catch {
    return [];
  }
}
