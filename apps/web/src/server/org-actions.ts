"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Pool } from "pg";

import { tlsOptionsForDatabaseUrl } from "@raptor/auth";

import { isUuid, parseRecentOrgs, splitSessionToken } from "./org-view";
import { withOrg } from "./orgs";

/**
 * Organisation switching, via the one legitimate door.
 *
 * `auth_set_active_org(token, org_id)` verifies an ACTIVE membership inside
 * the database and returns false otherwise — the server never decides
 * membership itself, so there is nothing here to get wrong. A `false` (or any
 * failure) surfaces as a form error, never a redirect into an org the caller
 * does not belong to.
 *
 * Recent organisations ride in a plain cookie (`raptor_recent_orgs`, max 5).
 * It is convenience, not authority: every switch re-verifies.
 */

export interface RecentOrg {
  readonly id: string;
  readonly name: string;
}

const RECENT_COOKIE = "raptor_recent_orgs";
const SESSION_COOKIES = ["raptor.session_token", "raptor-session_token"] as const;

/** Session token from the httpOnly cookies (server-side only, never logged). */
async function sessionToken(): Promise<string | null> {
  const jar = await cookies();
  for (const name of SESSION_COOKIES) {
    const token = splitSessionToken(jar.get(name)?.value);
    if (token !== null) return token;
  }
  return null;
}

/** Read by the layout to render the switcher. Never throws. */
export async function getRecentOrgs(): Promise<readonly RecentOrg[]> {
  try {
    const jar = await cookies();
    return parseRecentOrgs(jar.get(RECENT_COOKIE)?.value);
  } catch {
    return [];
  }
}

function switchPool(): Pool {
  const raw = process.env["DATABASE_URL"] ?? "postgresql://raptor_app@127.0.0.1:5432/raptor_os";
  const resolved = tlsOptionsForDatabaseUrl(raw);
  const pool = new Pool({
    connectionString: resolved.connectionString,
    max: 1,
    connectionTimeoutMillis: 2_000,
    application_name: "raptor_org_switch",
    ...(resolved.ssl === undefined ? {} : { ssl: resolved.ssl }),
  });
  pool.on("error", () => undefined);
  return pool;
}

/**
 * Bind the session's single organisation, if there is exactly one.
 *
 * Discovery uses `auth_active_orgs_for_token(token)` — the same definer that
 * guards `auth_set_active_org` answers "which orgs can this session enter?",
 * because `org_membership` is forced-RLS and a fresh session has no org context
 * of its own to read it with. The one-row case then still goes through
 * `auth_set_active_org`, which re-verifies membership before writing `orgId`:
 * discovery is a convenience, never authority.
 *
 * One organisation is bound; zero is a person who has no membership yet (their
 * dashboard says so); MORE than one is a real choice, not a guess — the caller
 * is expected to send them to the switcher. Best-effort by contract: it returns
 * a boolean, never throws into the caller's render, and a failure always leaves
 * the pre-existing behaviour (manual switcher) fully intact.
 *
 * @returns whether an organisation was bound to the session.
 */
export async function bindDefaultOrg(): Promise<boolean> {
  const token = await sessionToken();
  if (token === null) return false;

  const pool = switchPool();
  try {
    const found = await pool.query<{ org_id: string; display_name: string; slug: string }>(
      "SELECT org_id, display_name, slug FROM auth_active_orgs_for_token($1)",
      [token],
    );
    if (found.rows.length !== 1) return false;
    const org = found.rows[0];
    if (org === undefined) return false;

    const bound = await pool.query<{ auth_set_active_org: boolean }>("SELECT auth_set_active_org($1, $2)", [
      token,
      org.org_id,
    ]);
    if (bound.rows[0]?.auth_set_active_org !== true) return false;

    const jar = await cookies();
    const recents = parseRecentOrgs(jar.get(RECENT_COOKIE)?.value).filter((entry) => entry.id !== org.org_id);
    jar.set(RECENT_COOKIE, JSON.stringify([{ id: org.org_id, name: org.display_name }, ...recents].slice(0, 5)), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

/**
 * Switch the session's active organisation.
 *
 * @returns an error message for the form, or redirects on success (which
 * throws, so a returned value always means failure).
 */
export async function switchActiveOrg(_previous: string | null, formData: FormData): Promise<string | null> {
  const rawOrgId: unknown = formData.get("orgId");
  const orgId = typeof rawOrgId === "string" ? rawOrgId.trim() : "";
  if (!isUuid(orgId)) return "That is not a valid organisation id.";
  const token = await sessionToken();
  if (token === null) return "No session. Sign in again.";

  const pool = switchPool();
  try {
    const result = await pool.query<{ auth_set_active_org: boolean }>("SELECT auth_set_active_org($1, $2)", [
      token,
      orgId,
    ]);
    if (result.rows[0]?.auth_set_active_org !== true) {
      return "That organisation is not available to this account.";
    }
  } catch {
    return "Could not switch organisation right now. Try again later.";
  } finally {
    await pool.end();
  }

  const org = await withOrg(orgId, async (client) => {
    const found = await client.query<{ display_name: string }>(
      "SELECT display_name FROM organization WHERE id = $1 LIMIT 1",
      [orgId],
    );
    return found.rows[0]?.display_name ?? null;
  });
  const name = org ?? orgId;

  const jar = await cookies();
  const recents = parseRecentOrgs(jar.get(RECENT_COOKIE)?.value).filter((entry) => entry.id !== orgId);
  jar.set(RECENT_COOKIE, JSON.stringify([{ id: orgId, name }, ...recents].slice(0, 5)), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  redirect("/dashboard");
}
