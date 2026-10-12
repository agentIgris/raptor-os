/**
 * TLS verification scope for the auth database pool.
 *
 * WHY THIS TEST EXISTS
 * ---------------------
 * Managed poolers (Supabase Supavisor) present a chain Node's bundled roots do
 * not verify, and node-postgres takes no CA through a connection-string query
 * parameter. So `createPool` skips verification — but ONLY for connection
 * strings carrying `sslmode=require`, and ONLY on that pool. The failure this
 * guards is someone "simplifying" the condition to always-on, or setting
 * NODE_TLS_REJECT_UNAUTHORIZED globally (which would also blind the Google
 * OAuth token exchange — precisely the connection an attacker wants
 * unverified).
 *
 * The `sslmode` strip is asserted too, because it is load-bearing: measured
 * against pg 8.23.1, a `sslmode` query parameter in the URL OVERRIDES the
 * explicit `ssl` object, so `sslmode=require` plus
 * `ssl: { rejectUnauthorized: false }` still fails while the same `ssl` object
 * with no `sslmode` connects. Setting the option without removing the
 * parameter is a fix that does nothing.
 */

import { describe, expect, it } from "vitest";

import { createAuthConfig, tlsOptionsForDatabaseUrl } from "./config.js";
import { TEST_AUTH_ENV } from "./test-helpers.js";

function envWithDatabaseUrl(url: string) {
  return {
    BETTER_AUTH_SECRET: TEST_AUTH_ENV.secret,
    BETTER_AUTH_URL: "http://localhost:4000",
    DATABASE_URL: url,
    NODE_ENV: "test",
  };
}

describe("TLS verification is skipped only by explicit opt-in", () => {
  it("verifies by default on a plain connection string", () => {
    const config = createAuthConfig(
      envWithDatabaseUrl("postgresql://raptor_app@localhost/raptor_os_test"),
    );
    expect(config.pool.options.ssl).toBeUndefined();
    void config.pool.end();
  });

  it("skips verification only when the URL carries sslmode=require", () => {
    const config = createAuthConfig(
      envWithDatabaseUrl(
        "postgresql://raptor_app@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require",
      ),
    );
    expect(config.pool.options.ssl).toMatchObject({ rejectUnauthorized: false });
    void config.pool.end();
  });

  it("strips sslmode from the URL it hands to the driver", () => {
    const resolved = tlsOptionsForDatabaseUrl(
      "postgresql://raptor_app@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require",
    );
    expect(resolved.connectionString).not.toContain("sslmode");
    expect(resolved.ssl).toMatchObject({ rejectUnauthorized: false });
  });

  it("leaves any other sslmode byte-identical: stripping verify-full would downgrade it", () => {
    const url = "postgresql://raptor_app@db.internal:5432/raptor_os?sslmode=verify-full";
    const resolved = tlsOptionsForDatabaseUrl(url);
    expect(resolved.connectionString).toBe(url);
    expect(resolved.ssl).toBeUndefined();
  });
});
