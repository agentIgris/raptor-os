/**
 * scripts/lib/local-dev-auth.mjs — shared plumbing for the local dev scripts.
 *
 * WHAT THIS IS
 * ------------
 * Two scripts need the same four things: the root `.env.local`, an HTTP
 * client that understands Better Auth's cookies, a client that respects the
 * server's rate limits, and a database connection that can write the tables
 * RLS protects. Duplicating those in both places is how the two copies drift,
 * so they live here once.
 *
 * WHY THE RATE LIMITS ARE REPRODUCED HERE
 * ----------------------------------------
 * packages/auth/src/config.ts sets a budget per path, and Better Auth adds
 * two more on top:
 *
 *   - a built-in rule giving every `/sign-in*` and `/sign-up*` path
 *     3 requests per 10 seconds;
 *   - custom rules overriding it for `/sign-in/email` (5 per 60s) and the
 *     `/two-factor/verify-*` challenge paths (5 per 60s). The challenge paths
 *     are declared on the server and inert in this build — the `twoFactor`
 *     plugin is not installed, so no challenge is ever issued.
 *
 * With no client IP resolvable in local development — `AUTH_TRUSTED_IP_HEADERS`
 * is empty, and the config says so explicitly — there is exactly ONE bucket
 * per path, shared by every account. Seven accounts therefore cannot be
 * created in a burst, and a script that ignores this gets a 429 and mistakes
 * it for a bug. The budgets below are the server's, so a caller can pace
 * itself instead of discovering the limit as a failure.
 *
 * WHY THE DATABASE CONNECTION IS A SUPERUSER
 * ------------------------------------------
 * The domain tables are FORCE ROW LEVEL SECURITY with tenant policies keyed on
 * a session GUC, and `person_credential_link` has no grant to the application
 * role at all — packages/db/migrations/0014_person_credential_link.sql says so
 * in as many words and explains why that is load-bearing. A seed that cannot
 * write those tables cannot do its job, so the administrative connection uses
 * the same local superuser `scripts/setup-local.mjs` uses to apply migrations.
 *
 * The application connection is kept separate and is used only where the
 * application role is the real caller — `auth_set_active_org` is granted to
 * `raptor_app` and to nobody else, and exercising it that way proves the
 * grant is real rather than merely present.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/** The repository root, derived from this file's location. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `pg` is a dependency of @raptor/db; pnpm's layout keeps it there, not at the root. */
const requireFromDb = createRequire(path.join(REPO_ROOT, "packages/db/package.json"));
const { Client } = requireFromDb("pg");

export { Client };

/**
 * Parse a response body into a value a caller can branch on.
 *
 * JSON when the body is JSON, the raw text when it is not, and `null` for an
 * empty body. The raw-text fallback is the point: a 500 from a proxy answers
 * HTML, and a caller that only understood JSON would report "no response"
 * for an error it should have shown.
 */
function parsePayload(text) {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Parse `.env.local` into a map. Values stay in this process; none are
 * printed. Mirrors scripts/dev-env.mjs so every tool reads the same file the
 * same way.
 */
export function loadEnvFile() {
  const values = new Map();
  const envFile = path.join(REPO_ROOT, ".env.local");
  let text;
  try {
    text = readFileSync(envFile, "utf8");
  } catch {
    throw new Error(`.env.local not found at ${envFile}; run scripts/setup-local.mjs first.`);
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    let value = trimmed.slice(separator + 1);
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(trimmed.slice(0, separator), value);
  }
  return values;
}

/** Load `.env.local` into `process.env` without overriding what is already set. */
export function applyEnvFile() {
  for (const [name, value] of loadEnvFile()) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The application origin, from the same variable the app itself uses. */
export function baseUrl() {
  return (process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * The rate-limit budgets the server enforces, mirrored so a caller can pace itself.
 *
 * The challenge paths are inert in this build — the `twoFactor` plugin is not
 * installed, so no code is ever sent to them — but the server still declares
 * their budgets, and a mirror that disagreed with the server would be worse than
 * one that is slightly wider than it needs to be.
 *
 * The sign-in budget is read from the SAME variable the server reads
 * (`AUTH_RATE_LIMIT_SIGNIN_MAX`), because the two have to agree: a script that
 * paced itself to 5 while the server allowed 30 would sit waiting for a window
 * that would never open, and one that paced itself to 30 while the server
 * allowed 5 would be refused. The default here is the development default,
 * 30 per minute, matching `packages/auth`'s own default outside production.
 */
const signInBudget = () => {
  const raw = process.env["AUTH_RATE_LIMIT_SIGNIN_MAX"];
  const parsed = raw === undefined || raw.trim() === "" ? 30 : Number(raw.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 30;
};

/**
 * The budgets, read at call time so that `applyEnvFile()` has already run.
 */
export const RATE_RULES = {
  "/sign-up/email": { window: 10, max: 3 },
  "/two-factor/verify-totp": { window: 60, max: 5 },
  "/two-factor/verify-otp": { window: 60, max: 5 },
  "/two-factor/verify-backup-code": { window: 60, max: 5 },
};
const DEFAULT_RULE = { window: 60, max: 100 };

/** The budget for one path, resolved now. */
function ruleFor(routePath) {
  if (routePath === "/sign-in/email" || routePath === "/sign-in/username") {
    return { window: 60, max: signInBudget() };
  }
  return RATE_RULES[routePath] ?? DEFAULT_RULE;
}

/** Per-path bookkeeping so a script obeys the same budgets the server does. */
const budgets = new Map();

/**
 * Wait until the server would accept another request on `routePath`.
 *
 * The server's window is measured from the LAST request it allowed, not from
 * the first, so that is what this waits for. A quarter-second of slack is
 * added so a request that lands on the boundary is not the one that gets the
 * 429 — the 429 handler in `call` is the backstop, not the plan.
 */
export async function pace(routePath) {
  const rule = ruleFor(routePath);
  const state = budgets.get(routePath) ?? { count: 0, lastRequest: 0 };
  const now = Date.now();

  if (now - state.lastRequest >= rule.window * 1000) state.count = 0;

  if (state.count >= rule.max) {
    const waitMs = state.lastRequest + rule.window * 1000 - now;
    if (waitMs > 0) {
      console.log(`    rate limit: waiting ${Math.ceil(waitMs / 1000)}s for ${routePath}`);
      await sleep(waitMs + 250);
    }
  }

  state.count += 1;
  state.lastRequest = Date.now();
  budgets.set(routePath, state);
}

/** A cookie jar: name -> value, refreshed from every response. */
export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  absorb(response) {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0];
      if (pair === undefined) continue;
      const separator = pair.indexOf("=");
      if (separator === -1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /**
   * The raw session token.
   *
   * The cookie carries `token.signature`; the database stores only `token`,
   * and `auth_set_active_org` matches on the stored value.
   */
  sessionToken() {
    for (const [name, value] of this.cookies) {
      if (!name.endsWith("session_token")) continue;
      return value.split(".")[0];
    }
    return undefined;
  }
}

/**
 * One HTTP call to the auth API, paced and retried.
 *
 * A 429 is expected here — see the rate-limit notes above. The server answers
 * with `X-Retry-After` in seconds, and the call is repeated after that pause.
 */
export async function authCall(routePath, { method = "POST", body, jar, baseUrl: origin } = {}) {
  const target = origin ?? baseUrl();
  const headers = { "content-type": "application/json", origin: target };
  if (jar !== undefined) {
    const cookie = jar.header();
    if (cookie !== "") headers["cookie"] = cookie;
  }

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await pace(routePath);
    const response = await fetch(`${target}/api/auth${routePath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    if (jar !== undefined) jar.absorb(response);

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("x-retry-after") ?? "5");
      const waitMs = (Number.isFinite(retryAfter) ? retryAfter : 5) * 1000 + 500;
      console.log(`    429 on ${routePath}; retrying in ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
      continue;
    }

    const text = await response.text();
    const payload = parsePayload(text);
    return { status: response.status, payload, text };
  }

  throw new Error(`gave up after repeated 429s on ${routePath}`);
}

/** One POST to the application API (not the auth API), with the same pacing. */
export async function appPost(routePath, body, { jar, baseUrl: origin } = {}) {
  const target = origin ?? baseUrl();
  const headers = { "content-type": "application/json", origin: target };
  if (jar !== undefined) {
    const cookie = jar.header();
    if (cookie !== "") headers["cookie"] = cookie;
  }

  await pace(routePath);
  const response = await fetch(`${target}${routePath}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  if (jar !== undefined) jar.absorb(response);

  const text = await response.text();
  const payload = parsePayload(text);
  return { status: response.status, payload, text, headers: response.headers };
}

// -----------------------------------------------------------------------------
// Database
// -----------------------------------------------------------------------------

function databaseCoordinates() {
  const url = new URL(process.env["DATABASE_URL"] ?? "postgresql://raptor_app@127.0.0.1:5432/raptor_os");
  return {
    host: url.hostname || "127.0.0.1",
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//, "") || "raptor_os",
  };
}

/** The administrative connection: the local superuser, as the migrations use. */
export function adminClient() {
  const { host, port, database } = databaseCoordinates();
  return new Client({
    host,
    port,
    user: process.env["PGUSER"] ?? "postgres",
    password: process.env["PGPASSWORD"] ?? "postgres",
    database,
    connectionTimeoutMillis: 5000,
  });
}

/** The application-role connection, for the calls only `raptor_app` may make. */
export function appClient() {
  return new Client({
    connectionString: process.env["DATABASE_URL"],
    connectionTimeoutMillis: 5000,
  });
}
