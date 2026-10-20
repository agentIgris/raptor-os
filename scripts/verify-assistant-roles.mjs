#!/usr/bin/env node
/**
 * scripts/verify-assistant-roles.mjs — end-to-end proof of the assistant's
 * role scoping against the running local stack.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A PLAYWRIGHT TEST
 * ---------------------------------------------------
 * The Playwright suite (apps/web/e2e) runs against a production build with NO
 * database, on purpose: `next dev` injects a dev overlay and a Fast-Refresh
 * runtime that change computed styles, and the accessibility gate must measure
 * the artefact that ships. A session-gated route is unreachable without a
 * database, so those routes are covered by the jsdom suite in
 * apps/web/src/__tests__ and not by pretending here.
 *
 * The assistant is session-gated, tenant-gated and role-gated. Proving it
 * needs all three of those to be REAL, which means a real database, real
 * credentials and a real session. That is what this script does, against the
 * same dev stack the seed created.
 *
 * WHAT IS PROVED
 * --------------
 *   1. No session                 → 401 "Sign in to use the assistant."
 *   2. A session with no org      → 403 "No active organisation for this session."
 *   3. An empty question          → 400 "Ask one question of 1 to 2000 characters."
 *   4. A question over 2000 chars → 400, same message.
 *   5. `pending`                  → 403 "Your account's role cannot use the assistant."
 *   6. Every other role          → 200, and the tool set is EXACTLY the one
 *                                   packages/assistant/src/matrix.ts grants it:
 *
 *        player   → listTeams, listCompetitions
 *        coach    → + getInsights, getRoster
 *        analyst  → + getInsights, getRoster
 *        manager  → + listMembers
 *        admin    → + getOrgOverview
 *        owner    → + getOrgOverview
 *
 *   7. `player` is refused the insights a coach gets — the matrix denies
 *      `getInsights` to a player, and the refusal is visible in the answer
 *      because the tool never appears in it.
 *
 * The tool set is compared against the MATRIX ITSELF, read from the built
 * package, not against a hand-copied table in this file. A matrix change that
 * nobody updates here fails the run instead of passing it silently.
 *
 * PREREQUISITES
 * -------------
 *   1. The dev stack is running (scripts/dev-env.mjs).
 *   2. scripts/create-role-accounts.mjs has run; its gitignored output file
 *      holds the passwords this script needs to sign in.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CookieJar,
  REPO_ROOT,
  adminClient,
  appClient,
  applyEnvFile,
  appPost,
  authCall,
  baseUrl,
} from "./lib/local-dev-auth.mjs";
import { ASSISTANT_TOOLS, TOOL_SCOPES } from "../packages/assistant/src/matrix.ts";

const CREDENTIALS_FILE = path.join(REPO_ROOT, ".data", "seed-role-accounts.json");
const ORG_ID = "0c295a27-1295-4dcf-9a0e-2f77a772f14d";

const step = (message) => console.log(`==> ${message}`);
const detail = (message) => console.log(`    ${message}`);

let failures = 0;

function check(label, condition, detailText) {
  if (condition) {
    detail(`PASS  ${label}`);
    return true;
  }
  failures += 1;
  console.log(`    FAIL  ${label}${detailText === undefined ? "" : ` — ${detailText}`}`);
  return false;
}

/**
 * Sign in as one seeded account.
 *
 * One stage: the password. The `twoFactor` plugin is not installed in this
 * build, so no challenge is issued and there is no code to answer — see "THE
 * DEMO BUILD" in packages/auth/src/config.ts.
 */
async function signIn(account, origin) {
  const jar = new CookieJar();

  const signInResult = await authCall(
    "/sign-in/email",
    { body: { email: account.email, password: account.password }, jar, baseUrl: origin },
  );
  if (signInResult.status !== 200) {
    throw new Error(`sign-in for ${account.email} failed with ${signInResult.status}: ${signInResult.text}`);
  }

  if (jar.sessionToken() === undefined) {
    throw new Error(`sign-in for ${account.email} produced no session cookie`);
  }
  return { jar };
}

async function main() {
  applyEnvFile();
  const origin = baseUrl();

  let credentials;
  try {
    credentials = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8"));
  } catch {
    console.error(
      `\nverify-assistant-roles: ${path.relative(REPO_ROOT, CREDENTIALS_FILE)} is missing.\n` +
        "Run scripts/create-role-accounts.mjs first.",
    );
    process.exit(1);
  }

  console.log("Raptor OS — assistant role verification");
  console.log(`app:  ${origin}`);

  const admin = adminClient();
  const app = appClient();
  try {
    await admin.connect();
    await app.connect();
  } catch (error) {
    console.error(`\nverify-assistant-roles: could not connect to Postgres: ${error.message}`);
    process.exit(1);
  }

  try {
    // -- 1. No session at all. --------------------------------------------
    step("no session");
    {
      const response = await appPost("/api/assistant", { question: "Who is on the roster?" }, { baseUrl: origin });
      check("401 without a session", response.status === 401, `got ${response.status}`);
      check(
        "the error says so",
        response.payload?.error === "Sign in to use the assistant.",
        JSON.stringify(response.payload),
      );
    }

    // -- 2. A session with no active organisation. ------------------------
    // A fresh session carries `orgId = NULL` until `auth_set_active_org`
    // writes it, so signing in and asking immediately exercises this.
    step("session without an active organisation");
    {
      const account = credentials.accounts.find((entry) => entry.role === "coach");
      const { jar } = await signIn(account, origin);
      const response = await appPost("/api/assistant", { question: "Who is on the roster?" }, { jar, baseUrl: origin });
      check("403 without an active organisation", response.status === 403, `got ${response.status}`);
      check(
        "the error says so",
        response.payload?.error === "No active organisation for this session.",
        JSON.stringify(response.payload),
      );
    }

    // -- 3 and 4. Question validation. ------------------------------------
    step("question validation");
    {
      const account = credentials.accounts.find((entry) => entry.role === "owner");
      const { jar } = await signIn(account, origin);
      const sessionToken = jar.sessionToken();
      const bound = await app.query(`SELECT auth_set_active_org($1, $2) AS ok`, [sessionToken, ORG_ID]);
      check("the session was bound to the organisation", bound.rows[0]?.ok === true);

      const empty = await appPost("/api/assistant", { question: "   " }, { jar, baseUrl: origin });
      check("400 for an empty question", empty.status === 400, `got ${empty.status}`);
      check(
        "the error says so",
        empty.payload?.error === "Ask one question of 1 to 2000 characters.",
        JSON.stringify(empty.payload),
      );

      const tooLong = await appPost(
        "/api/assistant",
        { question: "x".repeat(2001) },
        { jar, baseUrl: origin },
      );
      check("400 for a question over 2000 characters", tooLong.status === 400, `got ${tooLong.status}`);
      check(
        "the error says so",
        tooLong.payload?.error === "Ask one question of 1 to 2000 characters.",
        JSON.stringify(tooLong.payload),
      );

      const exactly = await appPost(
        "/api/assistant",
        { question: "x".repeat(2000) },
        { jar, baseUrl: origin },
      );
      check("2000 characters is accepted", exactly.status === 200, `got ${exactly.status}`);
    }

    // -- 5, 6 and 7. Per-role tool scoping. --------------------------------
    step("per-role tool scoping");
    for (const account of credentials.accounts) {
      const { jar } = await signIn(account, origin);
      const sessionToken = jar.sessionToken();
      await app.query(`SELECT auth_set_active_org($1, $2)`, [sessionToken, ORG_ID]);

      const response = await appPost(
        "/api/assistant",
        { question: "Give me the roster and the insights." },
        { jar, baseUrl: origin },
      );

      if (account.role === "pending") {
        check(
          "pending is refused",
          response.status === 403 && response.payload?.error === "Your account's role cannot use the assistant.",
          `${response.status} ${JSON.stringify(response.payload)}`,
        );
        continue;
      }

      if (!check(`${account.role} is answered`, response.status === 200, `got ${response.status}: ${response.text}`)) {
        continue;
      }

      const expected = ASSISTANT_TOOLS.filter((tool) => TOOL_SCOPES[tool].includes(account.role));
      const actual = (response.payload?.sections ?? []).map((section) => section.tool);

      check(
        `${account.role} gets exactly [${expected.join(", ")}]`,
        actual.length === expected.length && expected.every((tool) => actual.includes(tool)),
        `expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
      );
      check(
        `${account.role} answer is offline and attributed`,
        response.payload?.mode === "offline" && response.payload?.role === account.role,
        JSON.stringify({ mode: response.payload?.mode, role: response.payload?.role }),
      );

      if (account.role === "player") {
        check(
          "a player is refused the insights a coach gets",
          expected.includes("getInsights") === false && !actual.includes("getInsights"),
          `expected [${expected.join(", ")}], actual [${actual.join(", ")}]`,
        );
        check(
          "a player is refused the roster a coach gets",
          expected.includes("getRoster") === false && !actual.includes("getRoster"),
          `expected [${expected.join(", ")}], actual [${actual.join(", ")}]`,
        );
      }
      if (account.role === "coach") {
        check("a coach is given the insights", actual.includes("getInsights"), `actual [${actual.join(", ")}]`);
        check("a coach is given the roster", actual.includes("getRoster"), `actual [${actual.join(", ")}]`);
        check(
          "a coach is refused the member list",
          !actual.includes("listMembers"),
          `actual [${actual.join(", ")}]`,
        );
      }
      if (account.role === "owner" || account.role === "admin") {
        check("the org overview is available", actual.includes("getOrgOverview"), `actual [${actual.join(", ")}]`);
      }
    }

    // -- The tenant boundary is real. --------------------------------------
    step("tenant boundary");
    {
      const sessionRows = await admin.query(
        `SELECT count(*)::int AS n FROM auth_session WHERE "orgId" IS NOT NULL AND "orgId" <> $1`,
        [ORG_ID],
      );
      check(
        "no session points at another organisation",
        sessionRows.rows[0]?.n === 0,
        `${sessionRows.rows[0]?.n} sessions carry a foreign orgId`,
      );
    }
  } finally {
    await admin.end().catch(() => undefined);
    await app.end().catch(() => undefined);
  }

  console.log("");
  if (failures === 0) {
    console.log("All checks passed.");
  } else {
    console.log(`${failures} check(s) FAILED.`);
    process.exitCode = 1;
  }
}

await main();
