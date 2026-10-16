import { Pool, type PoolClient } from "pg";

import { tlsOptionsForDatabaseUrl } from "@raptor/auth";

/**
 * Workspace tenant reads: the ACTIVE organisation behind the session.
 *
 * Same contract as `server/public.ts` — scoped reads, never throws — except
 * the scope here is the session's own org claim rather than the public slug.
 * Returns `null` when there is no org, no database, or any failure.
 */

export interface ActiveOrg {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
}

let pool: Pool | null = null;

function workspacePool(): Pool {
  if (pool === null) {
    const raw = process.env["DATABASE_URL"] ?? "postgresql://raptor_app@127.0.0.1:5432/raptor_os";
    const resolved = tlsOptionsForDatabaseUrl(raw);
    pool = new Pool({
      connectionString: resolved.connectionString,
      max: 2,
      min: 1,
      connectionTimeoutMillis: 2_000,
      application_name: "raptor_workspace",
      ...(resolved.ssl === undefined ? {} : { ssl: resolved.ssl }),
    });
    pool.on("error", () => {
      // See server/public.ts: an idle-client death must not crash the process.
    });
  }
  return pool;
}

/** Run `work` with one org in context. `null` on any failure. */
export async function withOrg<T>(orgId: string, work: (client: PoolClient) => Promise<T>): Promise<T | null> {
  if (orgId.trim() === "") return null;
  // One retry for dead-idle pooled connections (see server/public.ts).
  // Callers treat `null` as unknown, so a genuinely missing row simply costs
  // one extra lookup.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await withOrgOnce(work, orgId);
    if (result !== null) return result;
  }
  return null;
}

async function withOrgOnce<T>(work: (client: PoolClient) => Promise<T>, orgId: string): Promise<T | null> {
  let client: PoolClient | null = null;
  try {
    client = await workspacePool().connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    try {
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch {
      await client.query("ROLLBACK");
      return null;
    }
  } catch {
    return null;
  } finally {
    client?.release();
  }
}

/** The session's active organisation, or `null`. */
export async function getActiveOrg(orgId: string | null): Promise<ActiveOrg | null> {
  if (orgId === null || orgId.trim() === "") return null;
  return withOrg(orgId, async (client) => {
    const result = await client.query<{ id: string; slug: string; display_name: string }>(
      "SELECT id, slug, display_name FROM organization WHERE id = $1 AND archived_at IS NULL LIMIT 1",
      [orgId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { id: row.id, slug: row.slug, displayName: row.display_name };
  }).then((org) => org ?? null);
}
